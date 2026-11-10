---
name: spec-relay-view
description: Turn spec-relay's Markdown artifacts (an OpenSpec change or one Markdown file) into a fixed-design HTML page for a person to review. Use before asking a person to review spec-relay artifacts, and whenever they ask to see them as HTML.
user-invocable: true
---

# spec-relay-view

People are the bottleneck of a migration: they review every spec. This skill
gives them a page that is easier to read than raw Markdown, with the same
design whatever model or host made it.

The Markdown files are the source of truth. The HTML page is only a view of
them.

## Rules

- **Never write or edit HTML yourself.** Always run the kit's renderer below. Its
  design is fixed in the script so that every model produces the same page. Do
  not restyle, summarize or rearrange the output, and do not hand-write a page
  when the script fails: report the error.
- **Never record a decision in the HTML.** Ticks, decisions and the reviewer's
  name go into the Markdown (`review.md`), then render again.
- Render again after every change to the artifacts. A page older than its
  Markdown misleads the reviewer.

## How

The kit's files are two directories above this skill; `<kit>` below is the
absolute path of that directory. Run from the repository being migrated, on
one line, with the path quoted (see the spec-relay skill on running commands
under PowerShell):

```text
node "<kit>/scripts/render.mjs" --change <change-name>
node "<kit>/scripts/render.mjs" --file <path/to/file.md>
```

- `--change` finds the change under `openspec/changes/`, or its newest copy under
  `openspec/changes/archive/`. An extract change gets the review layout:
  progress, one card per requirement with its scenarios, its trace entry and the
  original source lines (Shift_JIS and other legacy encodings are shown as
  text), the questions with their decisions, and the coverage items. Any other
  change gets each of its Markdown files in order.
- The page goes to `openspec/spec-relay/views/<name>.html` (a `.gitignore` there
  keeps generated pages out of git). `--out FILE` writes somewhere else.
- Labels follow `Artifact language` in `openspec/config.yaml`; `--lang ja|en`
  overrides it.
- The script prints `{ "ok": true, "out": "<path>" }`. Tell the person the path
  so they can open it in their browser (on Windows: `Invoke-Item "<path>"` in
  PowerShell, or double-click the file). The page works offline and runs no
  code from the artifacts.
