# mementol

*Auto-loads your linked Claude Code memory into every prompt — so it's actually used, not just indexed.*

## The problem

Claude Code loads your index file (`MEMORY.md`, or a `## Memory` section in `CLAUDE.md`) but doesn't reliably act on an instruction like *"read MEMORY.md and the relevant topic files."* It decides per turn whether to open them, and often skips it — so your deep-dive memory is ignored unless you explicitly say "read the memory files."

## What it does

On every prompt, a `UserPromptSubmit` hook finds your memory index, follows its links to topic `.md` files — markdown `[t](file.md)` **and** `@import`, recursively — and injects those files' contents into context. It only *reads* files; nothing on disk changes. In projects with no memory it does nothing, so it's safe to install globally.

**Requirements:** Claude Code and Node.js (already present — Claude Code runs on it).

## Install

```
/plugin marketplace add cc-mementol/mementol
/plugin install mementol@mementol
```

Open `/hooks` once (or restart) to activate. Disable anytime via `/plugin`.

<details><summary>Install from a local clone (development)</summary>

```
/plugin marketplace add /absolute/path/to/mementol
/plugin install mementol@mementol
```
</details>

## Where it looks

No config needed — it scans these and uses whatever exists:

- `$MEMORY_LOADER_DIR` (explicit override)
- the auto-memory dir `~/.claude/projects/<slug>/memory/` (via `transcript_path`)
- `<project>/.claude/memory/` and `<project>/memory/`
- index files: `CLAUDE.md` (project, `.claude/`, user) and `MEMORY.md` (project, `.claude/`)

A directory with a `MEMORY.md` uses it as the index; a trusted memory dir without one injects all its `.md`. Links resolve against the index file's own folder, recursion is depth-bounded and de-duplicated, external `https://` links are ignored, and `CLAUDE.md` is read for links but never re-injected (Claude Code already loads it).

Preview what a project would load, before trusting the hook:

```
node /path/to/mementol/scripts/inject-memory.mjs --list
```

## Configuration — from the UI

When you enable the plugin, Claude Code prompts you for two options (each with a default you can accept), editable later via `/plugin` → **mementol**:

- **Injection mode** — `always` or `relevant` (see below)
- **Max injected bytes** — default `200000` (~50k tokens); anything past the cap is skipped with a note

Prefer config files? They're also env vars in `settings.json` → `env`: `MEMORY_LOADER_MODE`, `MEMORY_LOADER_MAX_BYTES`, `MEMORY_LOADER_DIR`, `MEMORY_LOADER_MAX_DEPTH` (default 4).

### Modes

| Mode | Injects | Pro / con |
|---|---|---|
| `always` *(default)* | all memory, every prompt | Pro: never misses; survives context compaction. Con: most tokens; compounds over a long chat. |
| `relevant` | only files matching the prompt | Pro: much cheaper; the lean index always goes in. Con: keyword match can miss a file whose wording differs. |

### Helping `relevant` match (synonyms)

`relevant` matches your prompt against each file's text, so it misses a file when your prompt uses a word the file doesn't contain ("automobile" vs "car"). Fix it locally — no external service:

- Add a `keywords:` line to a file's frontmatter with synonyms and abbreviations:
  ```yaml
  ---
  name: Product pricing
  keywords: [pricing, price, cost, margin, markup, supplier, vendor, SKU]
  ---
  ```
- Or run **`/mementol-keywords`** and Claude fills them in for you. To do it automatically for new memory, add one line to your `CLAUDE.md`:
  > When writing a memory file, include a `keywords:` frontmatter array of synonyms and alternate terms for the topic.

(It also does light word-form matching — `pricing` finds `price` — so mainly true synonyms need writing down.)

## Cost

`always` injects everything every prompt: bulletproof, but tokens add up over a long chat. If that matters, use `relevant` and/or lower `MEMORY_LOADER_MAX_BYTES`.

## Why "mementol"?

*Memento* (the film where a man who can't form new memories leaves himself notes) + a brain-pill suffix. The whole job: external notes so Claude doesn't forget.

## License

MIT
