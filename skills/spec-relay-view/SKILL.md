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
  `openspec/changes/archive/`. A change with a `review.md` (survey,
  target-design, extract, amend) gets the review layout: how many items are
  still open, one row per review item grouped by the headings of `review.md`,
  and the other Markdown files after them as an appendix.
  - A requirement (`R`) shows its scenarios beside its trace entry, the original
    source lines (Shift_JIS and other legacy encodings are shown as text; at most
    80 lines per reference) and its crosscheck verdict. In an amend change it
    shows the old wording from `openspec/specs/` against the new.
  - A screen (`S`) shows its entry in `screens.md` and its screenshot.
  - A question (`Q`) shows its text from `questions.md` and its decision.
  - A context (`K`) shows its entry in `context-map.md`.
  - Every other item is one line.
  - What has no review item (a requirement, screen, context or question missing
    from `review.md`) is shown as open with a caution, and so is a review item
    that names nothing. Tell the person about these cautions; do not hide them.
  Any other change (a port) gets each of its Markdown files in order, without
  progress.
- Screenshots are not copied into the page. The page links the image file named
  in `screens.md` (inside the repository, `png`, `jpg`, `gif`, `webp` or `bmp`)
  by a relative path, so the image must stay where it is, and a page sent to
  someone else needs the image files sent with it in the same folders.
- The page goes to `openspec/spec-relay/views/<name>.html` (a `.gitignore` there
  keeps generated pages out of git). `--out FILE` writes somewhere else.
- Labels follow `Artifact language` in `openspec/config.yaml`; `--lang ja|en`
  overrides it.
- The script prints `{ "ok": true, "out": "<path>" }`. Tell the person the path
  so they can open it in their browser (on Windows: `Invoke-Item "<path>"` in
  PowerShell, or double-click the file). The page works offline and runs no
  code from the artifacts.
- On the page, vermilion marks what `review.md` records (a tick, a decision, the
  reviewer's name); it does not prove who made the tick. The reader can show
  only the open items, and move with `j`/`k` (next, previous item) and `n`/`p`
  (next, previous open item); a checkbox on the page turns these keys off.
