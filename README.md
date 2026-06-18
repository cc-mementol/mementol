# mementol

*Memory medication for Claude Code — a daily dose so Claude doesn't forget.*

A Claude Code plugin that **automatically injects your linked memory files into every prompt** — on any project, no per-project config. (Think Cavinton for your context window.)

## The problem

Claude Code encourages a lean "index" memory file (`MEMORY.md`, or a `## Memory`
section in `CLAUDE.md`) that links out to deeper topic files:

```markdown
## Memory — read these before working
- [Product Lists](memory/product-lists.md) — sync system, fuzzy matching, pricing
- [Deployment](memory/deployment.md) — build steps, server layout, rollback
```

Claude Code loads the **index file's own text** into context — but it does **not**
reliably act on an instruction like *"read MEMORY.md and the relevant topic files."*
That instruction is just text; the model decides per-turn whether to go open those
files, and often skips it. So on a large codebase your carefully-written deep-dive
memory is quietly ignored unless you explicitly say *"read the memory files."*

(Note: `@import` lines in `CLAUDE.md` — e.g. `@memory/product-lists.md` — *do* get
pulled in automatically. A prose "please read these" does not. This plugin handles
both, and works for `MEMORY.md` indexes that aren't `CLAUDE.md` at all.)

## What this does

On **every prompt**, a `UserPromptSubmit` hook:

1. Discovers your memory **index** files (see *Where it looks* below).
2. Follows every markdown link `[t](file.md)` and `@import` reference to a `.md` file —
   **recursively** (bounded), so a `CLAUDE.md → MEMORY.md → topic.md` chain is fully resolved.
3. Injects the contents of every linked file **that actually exists** into the prompt context.

So your deep-dive memory is **always loaded**, automatically, without you asking.
In projects with no memory it outputs nothing — safe to install globally.

## Requirements

- Claude Code (recent version — uses the plugin `args` hook form).
- Node.js — already present, since Claude Code itself runs on it. No extra install.

## Install

**Try it locally first** (from this repo's folder):

```
/plugin marketplace add /absolute/path/to/mementol
/plugin install mementol@mementol
```

**Or from GitHub** once you've pushed it:

```
/plugin marketplace add cc-mementol/mementol
/plugin install mementol@mementol
```

After installing, open `/hooks` once (or restart Claude Code) so the hook registers.
Run `/plugin` anytime to enable/disable it.

## Where it looks

It scans these locations (all that exist are used, de-duplicated):

**Memory directories** — if the dir has a `MEMORY.md` it's used as the index; a
*trusted* dir with no index has all its `.md` files injected:

| Location | Trusted (inject all `.md` if no index) |
|---|---|
| `$MEMORY_LOADER_DIR` | yes |
| `~/.claude/projects/<slug>/memory/` (auto-memory, via `transcript_path`) | yes |
| `<project>/.claude/memory/` | yes |
| `<project>/memory/` | no — only used if it contains `MEMORY.md` |

**Index files** — parsed for links to follow:

- `<project>/CLAUDE.md`, `<project>/.claude/CLAUDE.md`, `~/.claude/CLAUDE.md`
- `<project>/MEMORY.md`, `<project>/.claude/MEMORY.md`

This covers Claude Code's default auto-memory location **and** project-committed
memory, with no configuration. If your memory lives somewhere else, point
`MEMORY_LOADER_DIR` at the folder that contains your `MEMORY.md`.

## What gets injected

- All `.md` files reachable from an index via markdown links or `@import`, that exist on disk.
- Relative paths resolve against the **index file's own directory**.
- External links (`https://…`) are ignored.
- `CLAUDE.md` files are parsed for links but **never re-injected** — Claude Code
  already loads them. `MEMORY.md` and topic files *are* injected. (If your `MEMORY.md`
  is in Claude Code's auto-memory, it's already in context, so it may appear once
  more here. Harmless.)
- Recursion is bounded (default depth 4) and de-duplicated, so cycles are safe.

## Dry run — see what it would load

Run it from a project root with `--list`:

```bash
node /path/to/mementol/scripts/inject-memory.mjs --list
```

It prints the files it would inject and their sizes (or "no memory files found").
Great for verifying a project before trusting the hook. (Without a piped hook
payload it uses the current working directory.)

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MEMORY_LOADER_DIR` | *(auto-detected)* | Explicit path to the folder containing your `MEMORY.md`. |
| `MEMORY_LOADER_MAX_BYTES` | `200000` | Cap on total injected bytes. On overflow, remaining files are skipped with a note. |
| `MEMORY_LOADER_MAX_DEPTH` | `4` | How many link-hops to follow from an index file. |

Set these in your Claude Code `settings.json` under `"env"`, or in your shell environment.

## A note on token cost

This injects your linked memory on **every** prompt, including trivial ones. That's the
point — but it adds tokens per turn. Keep topic files focused, and lean on
`MEMORY_LOADER_MAX_BYTES` as a guardrail. Use `--list` to see your real footprint.

## How to disable

Run `/plugin`, select `mementol`, and disable it — or `/plugin uninstall`.

## Why "mementol"?

Half *Memento* (the film about a man who can't form new memories, so he tattoos
notes to himself), half over-the-counter brain pill. That's the whole job:
external notes so Claude doesn't forget.

## License

MIT
