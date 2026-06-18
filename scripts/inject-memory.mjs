#!/usr/bin/env node
/*
 * inject-memory.mjs
 *
 * Mementol — Claude Code memory loader (UserPromptSubmit + SessionStart hook).
 *
 * Claude Code loads your CLAUDE.md and the auto-memory INDEX (MEMORY.md), but it
 * does NOT reliably act on instructions inside them like "read MEMORY.md and the
 * relevant topic files" — it decides per turn whether to go read them, and often
 * skips it. Mementol closes that gap: it discovers your memory index files,
 * follows their links to topic `.md` files (recursively, bounded), and injects
 * those files' contents straight into context.
 *
 * Locations scanned (no config needed):
 *   - $MEMORY_LOADER_DIR ............... explicit override (a memory dir)
 *   - <auto-memory>/ ................... ~/.claude/projects/<slug>/memory/ (via transcript_path)
 *   - <project>/memory, <project>/.claude/memory
 *   - CLAUDE.md ....................... project, project/.claude, and ~/.claude (user)
 *   - MEMORY.md ....................... project, project/.claude
 *
 * Link styles followed: markdown `[t](file.md)` and `@import` (`@./file.md`).
 * Only files that exist are injected. CLAUDE.md is parsed for links but never
 * re-injected (Claude Code already loads it).
 *
 * The injection mode — the plugin's "Injection mode" setting (userConfig) or
 * the MEMORY_LOADER_MODE env var — controls the cost/reliability tradeoff:
 *   - always  (default) inject everything on every prompt. Survives context
 *                       compaction; highest token cost.
 *   - session           inject everything once per session (SessionStart).
 *                       Cheapest; can be lost to compaction in long sessions.
 *   - relevant          every prompt, inject only topic files whose keywords
 *                       match the prompt (the MEMORY.md index is always kept).
 *
 * Fails silent (exit 0, no output) when there's nothing to do, so it is safe to
 * run globally across every project.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_BYTES = Number(process.env.MEMORY_LOADER_MAX_BYTES || 200_000);
const MAX_DEPTH = Number(process.env.MEMORY_LOADER_MAX_DEPTH || 4);

const VALID_MODES = new Set(['always', 'session', 'relevant']);

// Resolve the injection mode from (highest priority first): the --mode=<v> arg
// (populated by the plugin's userConfig via ${user_config.memory_loader_mode}),
// the CLAUDE_PLUGIN_OPTION_* env var Claude Code exports for that same setting,
// or MEMORY_LOADER_MODE for manual/shell use. Invalid values are ignored, so an
// unsubstituted placeholder safely falls through to the default.
function pickMode() {
  const argMode = (process.argv.slice(2).find((a) => a.startsWith('--mode=')) || '').slice(7);
  for (const c of [
    argMode,
    process.env.CLAUDE_PLUGIN_OPTION_MEMORY_LOADER_MODE,
    process.env.CLAUDE_PLUGIN_OPTION_memory_loader_mode,
    process.env.MEMORY_LOADER_MODE,
  ]) {
    const v = (c || '').toLowerCase();
    if (VALID_MODES.has(v)) return v;
  }
  return 'always';
}
const MODE = pickMode();

// `--list` / `--dry-run`: print what would be discovered (human-readable) and
// exit, instead of emitting hook JSON. Shows the full set regardless of MODE.
const LIST_MODE = process.argv.slice(2).some((a) => a === '--list' || a === '--dry-run');

async function readStdin() {
  // Stream-read the hook input JSON. Reliable across platforms;
  // fs.readFileSync(0) throws EAGAIN on a non-blocking pipe under ESM on
  // Windows. isTTY guards against hanging if run interactively with no pipe.
  if (process.stdin.isTTY) return '';
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return '';
  }
  let text = Buffer.concat(chunks).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  return text;
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// Mirror Claude Code's project-dir slug: every non-alphanumeric char -> '-'.
function slugFromCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }

// Pull referenced .md paths out of an index file: markdown links + @imports.
function extractRefs(text) {
  const refs = new Set();
  const mdLink = /\[[^\]]*\]\(\s*([^)#\s]+\.md)(?:#[^)]*)?\s*\)/g;
  const atImport = /(?:^|\s)@([^\s)]+\.md)\b/g;
  let m;
  while ((m = mdLink.exec(text)) !== null) refs.add(m[1]);
  while ((m = atImport.exec(text)) !== null) refs.add(m[1]);
  return [...refs]
    .map((r) => r.replace(/^\.\//, ''))
    .filter((r) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(r)); // drop external URLs
}

function collectSeeds(input) {
  const home = os.homedir();
  const cwd = input.cwd || process.cwd();

  // `trusted` dirs are unambiguously CC memory, so if they have no MEMORY.md
  // index we inject every .md inside. A bare <project>/memory is only used when
  // it contains a MEMORY.md (avoids slurping an unrelated "memory" folder).
  const memDirs = [];
  if (process.env.MEMORY_LOADER_DIR) memDirs.push({ dir: process.env.MEMORY_LOADER_DIR, trusted: true });
  if (input.transcript_path) memDirs.push({ dir: path.join(path.dirname(input.transcript_path), 'memory'), trusted: true });
  memDirs.push({ dir: path.join(cwd, '.claude', 'memory'), trusted: true });
  memDirs.push({ dir: path.join(cwd, 'memory'), trusted: false });

  const indexFiles = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '.claude', 'CLAUDE.md'),
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(cwd, 'MEMORY.md'),
    path.join(cwd, '.claude', 'MEMORY.md'),
  ];

  return { memDirs, indexFiles, cwd };
}

// Discover candidate memory files via BFS over index links. Returns an ordered
// array of { abs, label, body, isIndex }. CLAUDE.md is traversed for links but
// excluded from the result (Claude Code already loads it).
function discover(input) {
  const { memDirs, indexFiles, cwd } = collectSeeds(input);
  const visited = new Set();
  const queue = [];
  const out = [];

  const enqueue = (abs, depth) => {
    if (depth > MAX_DEPTH || visited.has(abs) || !isFile(abs)) return;
    visited.add(abs);
    queue.push({ abs, depth });
  };

  for (const { dir, trusted } of memDirs) {
    if (!isDir(dir)) continue;
    const idx = path.join(dir, 'MEMORY.md');
    if (isFile(idx)) {
      enqueue(idx, 0);
    } else if (trusted) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { entries = []; }
      for (const f of entries) {
        if (f.toLowerCase().endsWith('.md')) enqueue(path.join(dir, f), MAX_DEPTH);
      }
    }
  }
  for (const f of indexFiles) enqueue(f, 0);

  const labelFor = (abs) => {
    const rel = path.relative(cwd, abs);
    return (rel && !rel.startsWith('..') && !path.isAbsolute(rel))
      ? rel.split(path.sep).join('/')
      : path.basename(abs);
  };

  while (queue.length > 0) {
    const { abs, depth } = queue.shift();
    let body;
    try { body = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    const base = path.basename(abs).toUpperCase();
    if (base !== 'CLAUDE.MD') {
      out.push({ abs, label: labelFor(abs), body: body.trim(), isIndex: base === 'MEMORY.MD' });
    }
    if (depth < MAX_DEPTH) {
      const dir = path.dirname(abs);
      for (const ref of extractRefs(body)) enqueue(path.resolve(dir, ref), depth + 1);
    }
  }
  return out;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'what',
  'how', 'why', 'can', 'could', 'should', 'would', 'from', 'into', 'about', 'have',
  'has', 'had', 'will', 'not', 'but', 'any', 'all', 'get', 'got', 'use', 'using',
  'make', 'made', 'please', 'need', 'want', 'help', 'file', 'files', 'code', 'let',
  'its', 'our', 'their', 'them', 'there', 'here', 'where', 'when', 'then', 'than',
  'some', 'more', 'most', 'very', 'just', 'like', 'also', 'only', 'over', 'such',
]);

function keywordsOf(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)));
}

// Choose which discovered files to inject, per MODE and the prompt text.
function selectFiles(files, promptText) {
  if (MODE !== 'relevant') return files;          // always / session: take all
  const kws = keywordsOf(promptText || '');
  return files.filter((f) => {
    if (f.isIndex) return true;                   // always keep the lean index
    if (kws.size === 0) return false;             // trivial prompt: index only
    const hay = (f.label + '\n' + f.body).toLowerCase();
    for (const k of kws) if (hay.includes(k)) return true;
    return false;
  });
}

// Assemble the injected context block, applying the byte cap.
function buildContext(files) {
  let total = 0;
  let truncated = false;
  const chosen = [];
  for (const f of files) {
    if (total + f.body.length > MAX_BYTES) { truncated = true; break; }
    total += f.body.length;
    chosen.push(f);
  }
  if (chosen.length === 0) return null;

  const sections = chosen.map((f) => `----- ${f.label} -----\n${f.body}`);
  let ctx =
    "The following are this project's memory files, gathered from its " +
    'CLAUDE.md / MEMORY.md index and the topic files it links to. Treat them ' +
    'as authoritative project context and follow them.\n\n' +
    sections.join('\n\n');
  if (truncated) {
    ctx += `\n\n(Some memory files were omitted: hit the ${MAX_BYTES}-byte ` +
      'injection cap. Raise it with the MEMORY_LOADER_MAX_BYTES env var.)';
  }
  return { ctx, total, count: chosen.length };
}

async function main() {
  let input = {};
  const raw = await readStdin();
  if (raw) { try { input = JSON.parse(raw); } catch { /* {} */ } }

  // --list: show everything discoverable, regardless of MODE/event.
  if (LIST_MODE) {
    const files = discover(input);
    const cwd = input.cwd || process.cwd();
    if (files.length === 0) { process.stdout.write(`mementol: no memory files found for ${cwd}\n`); return; }
    const total = files.reduce((n, f) => n + f.body.length, 0);
    const lines = files.map((f) => `  ${f.label}  (${f.body.length} bytes)${f.isIndex ? '  [index]' : ''}`);
    process.stdout.write(
      `mementol (mode=${MODE}) discovered ${files.length} file(s), ${total} bytes total:\n` +
      lines.join('\n') + '\n'
    );
    return;
  }

  // Each mode acts on exactly one hook event; the other is a no-op.
  const event = input.hook_event_name || 'UserPromptSubmit';
  if (MODE === 'session' && event !== 'SessionStart') return;
  if (MODE !== 'session' && event !== 'UserPromptSubmit') return;

  const files = discover(input);
  if (files.length === 0) return;

  const built = buildContext(selectFiles(files, input.prompt));
  if (!built) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: built.ctx,
    },
  }));
}

// A hook must never break the user's prompt — swallow everything.
main().catch(() => { /* no-op */ });
