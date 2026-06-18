#!/usr/bin/env node
/*
 * inject-memory.mjs
 *
 * Mementol — Claude Code `UserPromptSubmit` hook; a universal memory loader.
 *
 * Claude Code loads your CLAUDE.md and the auto-memory INDEX (MEMORY.md), but
 * it does NOT reliably act on instructions inside them like "read MEMORY.md and
 * the relevant topic files" — it decides per turn whether to go read them, and
 * often skips it. This hook closes that gap: on every prompt it discovers your
 * memory index files, follows their links to topic `.md` files (recursively,
 * bounded), and injects those files' contents straight into the prompt context.
 *
 * It scans several known locations so it works on any project without config:
 *   - $MEMORY_LOADER_DIR ............... explicit override (a memory dir)
 *   - <auto-memory>/ ................... ~/.claude/projects/<slug>/memory/ (via transcript_path)
 *   - <project>/memory, <project>/.claude/memory
 *   - CLAUDE.md ....................... project, project/.claude, and ~/.claude (user)
 *   - MEMORY.md ....................... project, project/.claude
 *
 * Index/link styles followed: markdown links `[t](file.md)` and `@import` refs
 * (`@./file.md`). Only files that actually exist are injected. CLAUDE.md files
 * are parsed for links but never re-injected (Claude Code already loads them).
 *
 * It fails silent (exit 0, no output) when there is nothing to load, so it is
 * safe to run globally across every project.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_BYTES = Number(process.env.MEMORY_LOADER_MAX_BYTES || 200_000);
const MAX_DEPTH = Number(process.env.MEMORY_LOADER_MAX_DEPTH || 4);

// `--list` / `--dry-run`: print what would be injected (human-readable) and
// exit, instead of emitting the hook JSON. Run it from a project root to see
// what this hook will load there: `node inject-memory.mjs --list`
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

// Build the list of seed entry points to start discovery from.
function collectSeeds(input) {
  const home = os.homedir();
  const cwd = input.cwd || process.cwd();

  // Memory directories. `trusted` dirs are unambiguously CC memory, so if they
  // have no MEMORY.md index we inject every .md inside them. Untrusted dirs
  // (a bare <project>/memory) are only used when they contain a MEMORY.md.
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

async function main() {
  let input = {};
  const raw = await readStdin();
  if (raw) { try { input = JSON.parse(raw); } catch { /* {} */ } }

  const { memDirs, indexFiles, cwd } = collectSeeds(input);

  const visited = new Set();        // abs paths already queued/processed
  const queue = [];                 // BFS: { abs, depth }
  const injected = new Map();       // abs -> { label, body }
  let total = 0;
  let truncated = false;

  const enqueue = (abs, depth) => {
    if (depth > MAX_DEPTH || visited.has(abs) || !isFile(abs)) return;
    visited.add(abs);
    queue.push({ abs, depth });
  };

  // Seed from memory directories.
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
  // Seed from index files.
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

    // CLAUDE.md is already loaded by Claude Code — parse it for links but don't
    // re-inject its content. Everything else gets injected.
    const isClaudeMd = path.basename(abs).toUpperCase() === 'CLAUDE.MD';
    if (!isClaudeMd && !injected.has(abs)) {
      if (total + body.length > MAX_BYTES) { truncated = true; break; }
      total += body.length;
      injected.set(abs, { label: labelFor(abs), body: body.trim() });
    }

    if (depth < MAX_DEPTH) {
      const dir = path.dirname(abs);
      for (const ref of extractRefs(body)) enqueue(path.resolve(dir, ref), depth + 1);
    }
  }

  if (injected.size === 0) {
    if (LIST_MODE) process.stdout.write(`mementol: no memory files found for ${cwd}\n`);
    return;
  }

  if (LIST_MODE) {
    const lines = [...injected.values()].map((f) => `  ${f.label}  (${f.body.length} bytes)`);
    process.stdout.write(
      `mementol would inject ${injected.size} file(s), ${total} bytes total:\n` +
      lines.join('\n') + '\n' +
      (truncated ? `  ... (truncated at the ${MAX_BYTES}-byte cap)\n` : '')
    );
    return;
  }

  const sections = [...injected.values()].map((f) => `----- ${f.label} -----\n${f.body}`);
  let ctx =
    "The following are this project's memory files, gathered from its " +
    'CLAUDE.md / MEMORY.md index and the topic files it links to. Treat them ' +
    'as authoritative project context and follow them.\n\n' +
    sections.join('\n\n');
  if (truncated) {
    ctx += `\n\n(Some memory files were omitted: hit the ${MAX_BYTES}-byte ` +
      'injection cap. Raise it with the MEMORY_LOADER_MAX_BYTES env var.)';
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ctx,
    },
  }));
}

// A hook must never break the user's prompt — swallow everything.
main().catch(() => { /* no-op */ });
