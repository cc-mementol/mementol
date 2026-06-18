---
description: Enrich this project's memory files with a keywords list (synonyms, abbreviations, alternate phrasings) so mementol's "relevant" mode finds them even when the prompt uses a different word.
---

mementol's **`relevant`** mode decides which memory topic files to load by
matching the user's prompt against each file's text. A file is missed when the
prompt uses a word that simply isn't written in it — e.g. the prompt says
"automobile" but the file only says "car". The fix is to write those alternate
words into the files themselves. Do that now:

1. **Find the memory topic files.** These are the `.md` files linked from this
   project's `MEMORY.md` (or the memory section of `CLAUDE.md`) — usually under
   the project's `memory/` folder or the auto-memory directory. List them and
   skip the `MEMORY.md` / `CLAUDE.md` index files themselves.

2. **For each topic file**, read it and identify the key concepts it actually
   covers.

3. **Add or update a `keywords:` field in the file's YAML frontmatter** (create
   the frontmatter block if there isn't one). For each main concept include:
   - **synonyms** and alternate phrasings — e.g. car / automobile / vehicle;
   - **abbreviations and their expansions** — e.g. db / database, auth /
     authentication, k8s / kubernetes, PR / pull request;
   - **domain or non-English terms** the team actually uses;
   - a couple of common word-forms only if the root isn't obvious.

   Format it as a YAML list:

   ```yaml
   ---
   name: Product pricing
   description: ...
   keywords: [pricing, price, cost, margin, markup, supplier, vendor, SKU]
   ---
   ```

4. **Keep it tight and honest.** 8–20 well-chosen terms per file beats a giant
   dump. Only add terms that genuinely describe what's already in the file —
   don't invent facts, and don't change any other content.

When you're done, briefly list which files you updated and the keywords you
added to each, so the user can sanity-check them.
