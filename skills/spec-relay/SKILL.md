---
name: spec-relay
description: Procedure of the spec-relay orchestrator agent for migrating a code base to another language with OpenSpec - map the code into bounded contexts, design the target, extract language-neutral specs from the source code, gate them on a human review, then implement them in the target language. Use for whole-codebase language ports driven by specs. Not for ordinary feature work.
user-invocable: false
---

# spec-relay

This skill is the procedure of the `spec-relay-orchestrator` agent. If you are
not running as that agent, do not start, review or archive spec-relay changes:
tell the person to select `spec-relay-orchestrator` in the agent picker (Copilot
CLI: `/agent`) and stop. A subagent the orchestrator starts does its assigned
task and returns to it.

The kit's own files are two directories above this skill:
[scripts/setup.mjs](../../scripts/setup.mjs),
[scripts/gate.mjs](../../scripts/gate.mjs),
[scripts/status.mjs](../../scripts/status.mjs),
[scripts/metrics.mjs](../../scripts/metrics.mjs),
[scripts/merge.mjs](../../scripts/merge.mjs),
[scripts/verify.mjs](../../scripts/verify.mjs),
[scripts/compare.mjs](../../scripts/compare.mjs) and
[scripts/http.mjs](../../scripts/http.mjs) ([docs/COMPARE.md](../../docs/COMPARE.md)),
[scripts/e2e.mjs](../../scripts/e2e.mjs) ([docs/E2E.md](../../docs/E2E.md)),
[scripts/finish.mjs](../../scripts/finish.mjs),
[scripts/guide.mjs](../../scripts/guide.mjs) ([docs/GUIDE.md](../../docs/GUIDE.md)),
[scripts/doctor.mjs](../../scripts/doctor.mjs), `openspec-schemas/` and
`docs/WORKFLOW.md`. `<kit>` below stands for the absolute path of that
directory; resolve it from this file's own location (installed as a plugin it is
under `.copilot/installed-plugins/` in the person's home folder).

## Running commands

Most people use this kit on Windows, where your shell is PowerShell.
- Run every command with the repository being migrated as the working
  directory, and write commands on one line. Do not use bash line
  continuations, `&&`, pipes or redirection (`>` writes UTF-16 in Windows
  PowerShell 5.1, which OpenSpec and the gate cannot read). Write files with
  your edit tool, in UTF-8.
- Quote every path, because home folders often contain spaces:
  `node "<kit>/scripts/gate.mjs" ...`. Forward slashes work on every platform.
- Run OpenSpec only as `node "<kit>/scripts/openspec.mjs" <args>`. It runs the
  OpenSpec pinned in this repository (`openspec/spec-relay/tools`, installed by
  setup). Never type a bare `openspec`, `openspec.cmd` or `npx openspec`: that
  is whatever version is on PATH, or none. If it says OpenSpec is not installed in
  this repository, run setup again (step 4).
- If PowerShell answers `npm` with "running scripts is disabled on this
  system", the command exists: call `npm.cmd` instead. Never change the
  execution policy unless the person asks.
- After installing a tool, PATH is stale in the open terminal; open a new one.
- When a command fails in a way the environment can cause (a command not
  found, access denied, `EPERM` or `EBUSY`, a model or subagent error), run
  the environment check (step 0) and give the person its fixes.
- Write repository paths in artifacts with forward slashes (`src/billing/Invoice.cs`). Read `docs/WORKFLOW.md` once when you
need the reasoning behind a step.

## Words

- **Source root**: the existing code. Read-only for every agent, always. When
  the source root is the repository root (`.`), the only paths you may change
  are `openspec/` and the target root.
- **Target root**: where the new implementation goes.
- **Context**: a bounded context (Domain-Driven Design) of the system, such as
  `billing`. `platform` holds the technical parts everything shares.
- **Capability**: one cohesive behavior inside a context, named
  `<context>/<name>` (for example `billing/invoice`). Every extract change
  covers exactly one capability, so it has exactly one spec file.
- **Survey change**: `openspec/changes/survey` (schema `spec-relay-survey`).
  Maps every source file to a context and lists the capabilities (step 1).
- **Target-design change**: `openspec/changes/target-design` (schema
  `spec-relay-target`). Module structure, conventions, screens (ui.md) and
  verification levels of the new system (step 2).
- **Extract change**: `openspec/changes/extract-<capability>` (schema
  `spec-relay-extract`). Produces the baseline spec (steps 3-4).
- **Port change**: `openspec/changes/port-<capability>` (schema
  `spec-relay-port`). Implements the baseline spec (step 5).
- **Amend change**: `openspec/changes/amend-<capability>` (schema
  `spec-relay-amend`). Corrects a baseline spec that misread or left out what
  the source code does.
- **Finish change**: `openspec/changes/finish` (schema `spec-relay-finish`).
  Once every capability is ported: the whole-system checks, the leftovers and
  the hand-over report (step 6). Archiving it completes the migration.
- **Follow-up**: work moved to after the migration (a suspected bug the
  person wants fixed, an improvement). One top-level item per piece of work
  under the plan's `## Follow-up` heading, starting with the backticked
  capability when it belongs to one; the finish step collects them.
- **Baseline spec**: `openspec/specs/<capability>/spec.md`, created when a
  reviewed extract change is archived.
- **Database definitions**: `openspec/spec-relay/db/<database>/`, the
  definitions (tables, views, procedures, triggers, jobs) the person exported
  from a database whose definitions are not in the repository. Source code
  like the source root: read-only for every agent, in the inventory, cited by
  trace.md. See the kit's `docs/DATABASE.md`.
- **Plan**: `openspec/spec-relay/plan.md`, the capability list and order.
- **Lessons**: `openspec/spec-relay/lessons.md`, what the person's corrections
  taught that later analyses and ports must follow (see Lessons).
- **Rerun**: OpenSpec cannot archive two changes of the same name on one day,
  so a second survey, port or amendment of the same thing gets a `-v<n>`
  suffix (`port-billing-invoice-v2`). The scripts treat it as the same change.
- **Review page**: the HTML view of a change's Markdown, made by the
  `spec-relay-view` skill. The Markdown stays the source of truth. The same
  skill shows the approved specs for reading (`render.mjs --spec all`) when the
  person asks to see a spec.
- **Canvas question**: a message that starts with `[canvas]` was typed by the
  person in the spec-relay canvas about the page or item it names. Answer it
  here. It is a question, never an approval or a decision: do not tick
  `review.md`, write a `decision:`, or archive because of it. Ask in the chat
  when it sounds like one.
- **Canvas edit**: a tick, an untick, a `decision:` or the `Reviewer:` line the
  person wrote in `review.md` with the canvas buttons. It is their own edit of
  the file, the same as typing it there; the canvas records each one in
  `openspec/spec-relay/local/canvas-log.jsonl` (never write that file). It is not an
  approval to archive.
- **Work folder**: `openspec/spec-relay/work/<change>/`, scratch files that
  subagents write in parallel (table parts, survey evidence) before
  `merge.mjs` puts them into an artifact.
- **Wave**: a set of subagent tasks you start together (see Working in
  parallel).

## 0. Environment check and setup

Check the environment before anything else, so that the migration does not
stop halfway on something the machine or the host lacks.

1. **Environment check** (at the start of every session, also on resume; it
   is quick and changes nothing). Run `node "<kit>/scripts/doctor.mjs"
   --target . --client <client> --json`, where `<client>` is `cli` in Copilot
   CLI, `vscode` in VS Code and `app` in the Copilot app. If the shell does not
   know `node`, tell the person to install Node.js 22.12 or later (Windows:
   `winget install OpenJS.NodeJS.LTS`) and to open a new terminal or restart
   the app, and stop. Otherwise report every `fail` and `warn` in `checks`
   with its `fix`, in the person's language and in one message (the JSON is
   ASCII with `\uXXXX` escapes; read it as JSON).
   - A `fail` blocks: stop, and run the check again after the person fixed it.
   - A `warn` may cause trouble later. Before setup, ask whether to fix it
     first or go on. Once set up, the person has already decided on the
     warnings that stay (a synchronised folder, for example): list their
     ids in one line and go on, unless one is new or changed. A `trial`
     warning needs no question: run the trial (step 6).
   - An `info` needs no answer; mention it in a line before setup, and not
     again later (for `telemetry`: the person's own OPENSPEC_TELEMETRY lets
     OpenSpec send usage statistics, overriding the kit's default of 0).
   - Never install, update or change settings to fix a check on your own:
     ask first for installs (Node.js and npm, which setup uses to install OpenSpec),
     and leave the execution policy, git's global config and OpenSpec's
     settings to the person.
2. If `openspec/config.yaml` already contains `# spec-relay: managed`, setup is
   done: read its context, run the trial (step 6) if the check reported `trial`
   as `warn`, and go to the first unfinished step. When the check reports
   `openspec` or `workflows` as `fail` with "run setup again" (common right
   after a clone, or after an OpenSpec update), run
   `node "<kit>/scripts/setup.mjs" --target .` (the values come from the
   config), show the plan, run it again with `--apply` after the person agrees,
   then run the check again.
3. Otherwise ask, one question at a time: the source language (propose what you
   detect from the files), the target language, the source root, the target root,
   the language for artifacts (default: the person's language), how many
   subagents may run at once (default 4; the Copilot CLI reference gives 2 on
   Free, 4 on Pro, 8 on Max, 16 on Business and 32 on Enterprise or
   usage-based billing, for the whole session), and which model the subagents
   run on (default `session`, the model of this session; the checker may get
   another model for a second opinion).
4. Run `node "<kit>/scripts/setup.mjs" --target . --source-language "..."
   --target-language "..." --source-root "..." --target-root "..." --language ...
   --parallel <n> --subagent-model "<model>"` (add `--checker-model "<model>"`
   for a different checker model)
   without `--apply`, show the plan, and run it again with `--apply` after the
   person agrees. On a conflict, show it and ask how to resolve it; never
   overwrite, move or delete the person's files to get past it.
   Setup replaces every generic OpenSpec skill with a stub that points here:
   apply, archive and sync skip the review gate, and the others call a bare
   `openspec` instead of the pinned one. Every
   `node "<kit>/scripts/openspec.mjs" update` restores them (the check reports `workflows` then); run
   setup again after each update.
5. Run the environment check again: now it also compares the schemas, the
   source root and the target language's toolchain.
6. **Subagent trial** (once; again when the check reports `trial` as `warn`).
   It proves that the three subagents start on their models and may write
   files, before real work depends on it. First tell the person that three
   subagents will each write one small file, and that allowing file edits for
   `openspec/` and the target root for this session now keeps every later
   wave from stopping at a permission prompt. Run `node
   "<kit>/scripts/doctor.mjs" --trial` and start every task in `tasks` in one
   wave (at most `subagents` at once): give its `task` text as it is to its
   `agent`, with its `model` unless that is `session`. The implementer also
   runs `node --version`, so a prompt to allow a command may appear too. When all have returned,
   run `node "<kit>/scripts/doctor.mjs" --trial-check --client <client>
   --json`. On a `fail`, tell the person what that subagent replied and the
   `fix`, and run the trial again after they fixed it. If this host cannot
   start subagents at all, tell the person that the kit needs them (Copilot
   CLI: `/subagents`; VS Code: the Copilot harness) and stop.
7. Commit nothing on your own. Suggest a commit when setup and the trial are
   done.
8. The kit's hook (see When something stops) is off unless `openspec/config.yaml`
   says `Hook enforcement ...: on`. Tell the person once that they can turn it
   on there themselves (docs/TROUBLESHOOTING.md, "フック"); never change that line yourself.

## Working in parallel

The person's review is the one step that never runs in parallel. Run the work
around it in parallel, so that the next review is ready when the person
finishes one, and keep your own context small, so that a long migration does
not wash out these instructions.

1. **Limits.** `node "<kit>/scripts/status.mjs" --format todo` prints
   `parallel`: `subagents` (how many subagents may run at once in this
   session, their own subagents included), `ahead` (how many capabilities may
   be in analysis or waiting for review at once), `models` (the model of each
   role) and `nextToAnalyze` (the capabilities you may start analyzing now).
   The person sets them in `openspec/config.yaml`.
2. **Waves.** Start all independent tasks of a wave in one step (as
   background subagents where the host offers that), at most `subagents` at
   once, and wait for the whole wave before you start the next one. If the host
   refuses to start a subagent because too many are running, wait for one to
   finish and start it again; never count a refused task as done. If the host
   runs subagents one after another, the result is the same, only slower.
   Write "give this to the `spec-relay-analyst` agent", never a tool name.
   When `models` names a model for the role (not `session`), ask for that
   model when you delegate, through the delegation's model option where the
   host has one. If the host has no such option, or this session's model is
   Auto, the subagent runs on the session model: tell the person once.
   Before the first wave, tell the person that subagents edit files: unless
   they allow file edits for this repository for the session, every subagent
   waits at a permission prompt, and in Copilot CLI declining one call cancels
   the others started with it.
3. **Subagents read and write; you route.** Each task names what to read
   (folders or files), the exact files to write, the schema file and artifact
   id to follow (`openspec/schemas/<schema>/schema.yaml`), and anything the
   person decided that the task needs: subagents see neither this conversation
   nor the repository instructions. Every analyst and implementer task also
   names `openspec/spec-relay/lessons.md` as a file to read, once it exists;
   a checker task never does, and neither does the environment trial. Never paste instructions, templates, source
   code or artifacts into a task, and never ask for artifacts back: subagents
   return a short report. Check their work with `node "<kit>/scripts/openspec.mjs" validate`,
   `node "<kit>/scripts/openspec.mjs" status --change`, `gate.mjs` and `merge.mjs`, and read an
   artifact yourself only for what you must tell or ask the person (questions,
   crosscheck rows that are not `confirmed`, the counts in your report). To
   list requirement and screen names, search for lines starting with
   `### Requirement:` and `### Screen:` instead of reading the files.
4. **One writer per file.** No two subagents of a wave write the same file.
   Analysts and checkers write only the paths you give them, the implementer
   only its capability's module. Only you write `review.md`, `plan.md`,
   `lessons.md` and `questions.md`, merge `crosscheck.md`, run `openspec`
   commands and `verify.mjs`, render review pages and archive.
   Never give a subagent a path to write under the source root (when the
   source root is `.`, give only paths under `openspec/` and the target root),
   under `openspec/specs/`, `openspec/config.yaml` or the lessons.
   Before every wave, run `node "<kit>/scripts/gate.mjs" guard --save
   wave-<n>`: it saves the hashes of the files no subagent may write (every
   active change's `review.md`, `questions.md`, `crosscheck.md` and
   `verify.json` and `e2e-old.json`, every active port's `proposal.md` and `design.md`,
   `plan.md`, `lessons.md`,
   `openspec/specs/`, `openspec/config.yaml` and the source files). After the
   wave, run `gate.mjs guard --compare wave-<n>`, which lists only the paths
   that changed (exit code 1 then: read the lists). If the wave is still
   running when you must write a guarded file yourself (a tick, a question, a
   lesson, an archive), run `--compare` first: if that path already changed, a subagent
   changed it; otherwise write, then `--save wave-<n>` again. For any change
   you did not make, stop, tell the person what changed, and do not use that
   wave's results until they decide. A `canvas` list in the result names the
   `review.md` files the person changed in the canvas during the wave: those
   are theirs, not a subagent's; read them again before you use them. If
   `--save` prints `warnings`, tell the person which files are not guarded.
   In a git repository, also compare `git status --porcelain
   --untracked-files=all` before and after, for files outside those (such as
   kit or host folders).
5. **Tables split across subagents** (inventory, crosscheck): each subagent
   writes its rows as a Markdown table to its own part file in the work folder
   (a `|` inside a cell written as `\|`),
   and `node "<kit>/scripts/merge.mjs" --into <artifact> --parts <folder>
   --clean` merges them into the artifact: a later part replaces the row with
   the same key, and rows you edited yourself stay. If merge reports one
   `R<n>` with two names because a requirement was renamed on purpose, delete
   the old row from the artifact and merge again.
6. **Mixed waves** are fine when no file is written twice: the implementer of
   one port, analysts of the next capabilities and a checker of another can
   run together.
7. **Ahead of the review, not further.** Start an extract change only for a
   capability in `nextToAnalyze`. A longer queue only waits, and what the
   person finds in one review (a misread pattern, a glossary term, a wish about
   wording) should reach the next analyses before they are written: write it
   to the lessons first (see Lessons).
8. **Pilot first.** Analyze the first capability (`platform`) on its own
   (`nextToAnalyze` holds one capability until the first is reviewed), and
   write what its review taught to the lessons before later analysts start.
9. Hand the person reviews of the same context one after another where the
   order allows, because they share words and data.

## Reviews: what every human review shares

Steps 1, 2 and 4 and every amendment end in a human review. The person decides;
you assist. This gate is the point of the kit.

1. Render the review page (`node "<kit>/scripts/render.mjs" --change <change>`,
   see the `spec-relay-view` skill) and give the person its path. Render again
   after every change to the artifacts.
   When the `spec-relay` canvas is available (a Copilot canvas extension of
   this kit, see docs/CANVAS.md), also offer to show the page there:
   `open_canvas` with canvasId `spec-relay`, instanceId `spec-relay` and input
   `{ "view": "review", "name": "<change>" }`, or move an open canvas with
   `invoke_canvas_action` (instanceId `spec-relay`, actionName `open_review`,
   input `{ "name": "<change>" }`). Other views are `progress`, `specs` and
   `spec` (name: the capability); `list_canvas_capabilities` lists the actions.
   The canvas follows the files by itself. On an active change's page the
   person can tick items, write decisions and their name there: the canvas
   writes them to `review.md` as the person's own edit. You cannot write
   through it. `invoke_canvas_action` `get_review_edits` lists what they
   changed there.
2. Ask how they want to review: here in the conversation, one item at a time,
   or in the files or a pull request on their own (they tell you when done,
   and you check what they ticked). Both are fine; never pick for them.
3. Follow the change's apply instruction (`node "<kit>/scripts/openspec.mjs" instructions apply --change
   <change> --json`). Tick a box only when the person accepts that item in this
   conversation, or when they ticked it in the file or the canvas themselves.
   Read `review.md` again before you edit it, since the person may have changed
   it in the canvas meanwhile. Write their
   decision after `decision:` and their name after `Reviewer:`. When they ask
   for a change, edit the artifacts, untick every item you changed, validate,
   render again and ask again.
4. When every box is ticked, run `node "<kit>/scripts/gate.mjs" review --change
   <change>`. `node "<kit>/scripts/openspec.mjs" archive --yes` checks none of what the gate checks, so
   never archive while the gate fails; report the failure as When something
   stops says. Then ask whether to archive, and archive only on an explicit
   yes in this conversation (boxes ticked in the file or the canvas are not
   that yes): `node "<kit>/scripts/openspec.mjs" archive <change> --yes`. Extract and amend changes also need
   the archived survey with the capability in its list or in the plan.
5. When the person corrects something that could recur, propose the lesson
   (below) right then, not after the review.

## Lessons

A migration runs over many sessions, and neither you nor the subagents remember
the last one. When the person corrects work in a way that could happen again in
another capability, write it down once in `openspec/spec-relay/lessons.md`, so
the same correction is never needed twice.

1. **What goes in.** Corrections from any review, the port design talk or a
   port: a pattern the analysts misread (`a NULL end date means open-ended`), a
   word or wording the person wants, how screens or questions should be
   written, an implementation habit to keep or avoid. Not a decision that
   belongs to one capability only: that stays in its questions.md or design.md.
2. **Only the person's word.** A lesson comes only from what the person said,
   never from your own guess. Show the exact line you want to add and write it
   when they agree (or reword it as they say). Do this right when the
   correction is made, and before you start any analyst or implementer task
   it should reach: a compaction can lose a correction that is not written
   down. Delete or change a line whenever the person asks.
3. **Never a rule change.** A lesson never contradicts a baseline spec, a
   schema, the archived survey's glossary, the archived target design, the
   context and rules of `openspec/config.yaml` or the agents' rules, and never
   changes behavior. A wish to fix a bug is follow-up work in the plan, not a
   lesson. If a lesson shows that an archived baseline spec misread the source
   code, propose an amendment for it.
4. **Shape.** The headings `## Reading the source code`, `## Specs and
   screens`, `## Questions` and `## Implementation`, always in English exactly
   like this (the implementer looks for the last one), then one line per lesson
   in the artifact language: the rule as an instruction, then where it came
   from in parentheses (`(review of extract-billing-invoice)`). Keep the file
   short: merge a lesson into an existing line rather than adding a
   near-duplicate.
5. **Who reads it.** Name it in every analyst and implementer task (Working in
   parallel). Read it yourself on resume, after every compaction, and before
   you write questions.md, review.md or a port's design and tasks. Never give
   it to a checker: the crosscheck stays independent of what the analysts were
   told.
6. **Changes already drafted.** When a new lesson applies to an extract or
   amend change that the person has not started reviewing yet, start an
   analyst task for that change that names lessons.md and the new line, and a
   checker task for the items it changed, before you hand the change over. For
   a change already in review, ask the person whether to apply it there too.
7. **A checker disagrees.** When a `mismatch` or `unclear` row concerns
   something an analyst wrote because of a lesson, do not loop: put the row and
   the lesson side by side in questions.md, so the person decides once
   (and corrects the lesson if it was too broad).

## 1. Survey: map the bounded contexts

Read the WHOLE source code base before splitting it, so that the split follows
the domain, not the folders.

1. `node "<kit>/scripts/openspec.mjs" new change survey --schema spec-relay-survey`.
   **Databases first**: ask the person which databases the system uses
   (product and version) and whether their definitions are in the
   repository. For each one that is not, ask them to export its definitions
   into `openspec/spec-relay/db/<database>/` as `docs/DATABASE.md` shows
   (from a copy or a development database, not production) and to tell you
   when it is done. Never connect to a database yourself and never ask for a
   password or connection string; run an export command only when the person
   asks you to, against the database they name, with the sign-in they set
   up. Then run `node "<kit>/scripts/gate.mjs" db-hash`: it prints the hash
   for database.md and lists files saved as UTF-16, which the person converts
   (docs/DATABASE.md). If the definitions cannot be had, go on and record that
   under Missing definitions.
2. Write inventory, context-map, glossary, capabilities and database (schema
   `spec-relay-survey`) in waves (see Working in parallel). Every source file
   must be in the inventory, and so must every file under
   `openspec/spec-relay/db/`: give those folders to analysts like the source
   folders.
   - **Inventory**: split the source folders across `spec-relay-analyst`
     subagents. Each writes its rows to
     `openspec/spec-relay/work/<change>/inventory/<n>.md` and its evidence to
     `openspec/spec-relay/work/<change>/evidence/<n>.md`, where `<change>` is
     this survey change's name (`survey`, or `survey-v2` for a rerun, so an
     earlier run's evidence is never read again). Then run `merge.mjs --into
     openspec/changes/<change>/inventory.md --parts
     openspec/spec-relay/work/<change>/inventory --clean`.
   - **Context map**: one analyst reads every evidence file and the merged
     inventory, writes context-map.md and corrects the Context column of
     inventory.md to the context ids it chose. You read context-map.md: the
     review needs you to know it.
   - **Glossary, capabilities and database**: one wave of three analysts,
     one file each. The database analyst reads the evidence, the merged
     inventory and the definitions, and gets the person's answers about the
     databases and the hash from `gate.mjs db-hash`.
   - **Carry**: the Handling column says `carry` for files the new system
     uses unchanged (stylesheets, images, fonts, script libraries, report
     templates) and `port` for everything else. Ask the analysts to propose
     carry; the person confirms it in the review (M5).
   Legacy code rarely has clean
   boundaries: propose owners for shared tables, split god classes by method,
   put technical shared parts in `platform`, and give the evidence for each
   boundary. Name capabilities so that OpenSpec and Windows both accept them:
   each path segment is lowercase ASCII kebab-case (`billing/invoice`, not
   `Billing_Invoice` or `請求`; put the Japanese name beside it), never a
   Windows device name (`con`, `prn`, `aux`, `nul`, `com1`...), not ending in
   `-v<digits>`, and short, because the path repeats inside
   `openspec/changes/archive/` and Windows limits paths to 260 characters.
3. Write review.md, validate (`node "<kit>/scripts/openspec.mjs" validate survey --strict`), then run
   the review (above). `gate.mjs review` also fails while a source file is
   missing from the inventory, or a file that is not `excluded` belongs to no
   capability (the indented paths under each capability in capabilities.md).
   Tell the person which files are excluded and why: an excluded file is
   never specified or ported, so that box (C1) is theirs, and the gate fails
   on an excluded row with no reason in Notes. Keep the template's M1-M5
   and C1 items in review.md even when one has nothing to decide (say so in
   the item): the gate fails when one is missing. While the person reviews, ask the questions the
   target design needs (step 2) so that it can start right after the archive.
4. After archiving, write the plan: copy capabilities.md's lists under a
   `## Capabilities` heading in `openspec/spec-relay/plan.md`, keeping the
   `### <context>` headings and the indented source paths under each
   capability. `status.mjs` counts only the top-level items that start with a
   backticked capability path; put follow-up work under a `## Follow-up`
   heading (see Words) and other notes under another `##` heading. From now on the plan is where files belong (once it
   lists any source path, the gates read only the plan's paths): when an
   analyst reports that a file belongs to another capability, move its path
   there (a file path under the other capability wins over a folder), tell
   the person in one line, and run `node "<kit>/scripts/gate.mjs" coverage`.
   If that capability's extract is already archived, its behavior reaches the
   spec through an amendment of that capability whose change also holds a
   source-map.md with the moved file (same table as the extract's).
   It fails while a kept source file belongs to no capability, a listed path
   has no file, or an analyzed capability's source map lacks one of its files,
   and it lists the capabilities not analyzed yet. Run it also after the last
   extract is archived.
5. **When the database definitions change later.** A gate that reports
   "database definitions changed after the survey" stops extract and amend
   reviews, port-ready and port-done. Ask the person whether they exported
   again on purpose. If not, they restore `openspec/spec-relay/db/` from git.
   If so, run the survey again as `survey-v2` (its inventory, capabilities and
   database.md cover the new definitions, and the person reviews what
   changed); after it is archived, copy the capability paths of the new or
   moved definition files into `openspec/spec-relay/plan.md` and run
   `gate.mjs coverage`. Files under `openspec/spec-relay/db/` are placed only
   during a survey: one added after the archive is drift too.

## 2. Target design: decide how the new system is built

1. `node "<kit>/scripts/openspec.mjs" new change target-design --schema spec-relay-target`.
2. Write architecture, conventions, ui, verification and data from their instructions.
   The default architecture is a modular monolith in the manner of Spring
   Modulith: one module per context, public API and events only, one owner per
   table, an automated boundary check. Ask the person about anything the code
   cannot tell you: frameworks they prefer, whether the source program can
   still be run, and which verification levels each context needs (A scenario
   tests always; B1 logic comparison, B2 screen tests, C screenshots by
   choice). Suggest B2 for every context with web screens whose old system
   can run here as a test copy: each screen scenario becomes a Playwright
   test that passes on the old system first and then judges the new one
   (docs/E2E.md); C adds screenshots to the same tests. Desktop screens
   (WinForms, WPF) cannot have B2: their scenarios get unit tests. Ask how
   both test databases are put back to the starting state, best as one
   command. Suggest B1 for contexts with calculations or business rules
   whenever the source code can be built and run here or records of its real
   runs exist (batch input and output, report data): it is the level that
   compares with what the old system did (docs/COMPARE.md). When the logic
   cannot be called by itself (code at the top of a PHP page, WebForms event
   handlers), B1 still works over HTTP if the person can run a test copy of
   the old system: ask for its address, its encoding and how its test
   database is reset, and write them in verification.md. Only the person
   names a system on another machine, and never production. For the screens (ui.md), ask who uses them, whether manuals,
   training or printed forms show them, and the target UI technology, then
   propose a policy per context (`same`, `layout`, `new`, `none`; the
   instruction says which fits which source); the person decides, and you
   never pick `new` yourself. Tell the person plainly that a context with A only is
   reported as "inferred" at every port: the source program never runs, so
   the new code is checked against specs and code that AIs read, not against
   what the old system does. Never write a password, token or connection
   string into a file; sign-in for B2 and C comes from environment variables
   the person sets. For data.md, ask how old and new will run during the
   switch (all at once, or side by side on the same database), whether the
   database product stays, and whether the defaults for the logic in the
   database (keep triggers, constraints, views, procedures and functions in
   the database) fit; never ask for a connection string. Write
   architecture.md first (yourself or one analyst), then give conventions.md,
   ui.md and data.md to three analysts in one wave, then
   verification.md (it suggests level C from ui.md's policies), with the
   person's answers in each task.
3. Write review.md, validate, and run the review (above). While the person
   reviews the target design, start analyzing (step 3) the capabilities in
   `nextToAnalyze`: an extract change needs the archived survey, not the target
   design.

## 3. Analyze: extract specs from the source code

Capabilities go in plan order, `platform` first, only those in
`nextToAnalyze` (see Working in parallel). Several capabilities run in the same
waves.

1. **Create the change.** `node "<kit>/scripts/openspec.mjs" new change extract-<capability> --schema
   spec-relay-extract`. Use the capability path with `/` replaced by `-` as the
   change name.
2. **Draft**: give each capability to one `spec-relay-analyst`, with the
   source paths the plan lists under it: it writes
   source-map.md, then `specs/<capability>/spec.md`, screens.md and trace.md
   in the change folder, following the artifacts of schema
   `spec-relay-extract` and the glossary of the archived survey
   (`openspec/changes/archive/*-survey*/glossary.md`). For a large capability
   with many screens, let one analyst write source-map.md first, then give
   specs and screens to two analysts in one wave and trace.md to one after
   them.
3. **Crosscheck.** Give the change's specs, screens.md and trace.md paths to
   `spec-relay-checker` subagents, and nothing else: no notes, no earlier
   drafts. Give each checker its items as numbered names (`R1 <name>`,
   `S1 <name>`, numbered in spec and screens.md order, from your search), so
   the numbers match review.md. For a large capability, split the items into
   groups (R1-R15, R16-R30, S1-S8) in one wave. Each checker writes
   `openspec/spec-relay/work/extract-<capability>/crosscheck-<nn>.md`; merge
   them with `merge.mjs --into
   openspec/changes/extract-<capability>/crosscheck.md --parts
   openspec/spec-relay/work/extract-<capability> --clean`. For every
   `mismatch` and `unclear` row, have an analyst fix the spec, screens or trace
   and a new checker check that row again (a part file with a higher number,
   such as `crosscheck-02.md`, merged the same way), or move it to questions.md and write `question Q<n>` as its verdict
   yourself.
4. **Omission check.** In the same wave as the crosscheck (both need only
   trace.md), run `node "<kit>/scripts/sites.mjs" --change
   extract-<capability>`. It lists the sites of the source map's files in
   groups of 40 under `openspec/spec-relay/work/extract-<capability>/sites/`
   (`--per N` changes the size). Give each group to its own
   `spec-relay-checker` with the change's specs and screens.md paths, the
   numbered requirement and screen names, the capabilities that own parts of
   shared files (from the plan), and the path
   `openspec/spec-relay/work/extract-<capability>/coverage/<nn>.md` to write.
   Never give it the analysts' notes. The sites file's Untraced column and
   the `untraced` count sites.mjs prints are the effect lines (a write, a
   mail, a file, a call to another system, an error, an exit, a redirect)
   that no requirement's trace reaches: tell the person the count in your
   report. Merge with `merge.mjs --into
   openspec/changes/extract-<capability>/coverage.md --parts
   openspec/spec-relay/work/extract-<capability>/coverage --clean`. For every
   `gap`, have an analyst add the requirement it needs (and its trace) at
   the END of the spec, so the R numbers the ledger already uses stay the
   same; have a checker crosscheck the new requirement and judge that site
   again (give it the site ids from the sites file, and have it write a part
   file with a higher number, merged the same way); or move it to
   questions.md and write `question Q<n>` as its verdict yourself. The gate
   also fails a `covered` row while a named requirement's trace reaches not
   every effect line of the site. Then decide per line with the checker's
   evidence: when a requirement's scenarios state what the line does, have
   an analyst add the line to that requirement's trace row and a checker
   crosscheck the requirement again; when the line holds no effect at all
   (text of the page, script that runs in the browser, a word in a string),
   the checker writes it into the verdict (`covered R1; no effect 6, 9`)
   and the person confirms it with C1; when neither, it is a gap as above.
   Write several lines of one file as `path:3-6, 9`.
   Never widen a trace row, and never have an analyst do it, to make the
   gate pass: that hides the omission the check exists to find. A changed
   source map or source file means running sites.mjs again and judging the
   sites of the changed files again (a verdict is tied to a site id, not to
   its content; an added overload renumbers `#2`): `gate.mjs review` scans the files itself, fails on a site
   without a row, and names the rows of sites it no longer finds, which you
   delete from coverage.md. When sites.mjs writes no group (the files hold no
   code), coverage.md keeps its empty table.
5. **Questions and review.** Write questions.md from the analysts' reported
   doubts and the rows moved to questions, then review.md (names by search,
   not by reading the spec). When `gate.mjs review` says that sites with
   marker lines are judged `no behavior` or `no effect`, add `## 4.
   Coverage` with the item `- [ ] C1 ...` in the words it gives (they end
   with a code that names the list); the review page lists those sites
   under the omission check with the same code, and the person decides
   whether they may be left out. When the list changes later, the gate
   gives new words: write them and leave the item unticked.
6. **Validate.** `node "<kit>/scripts/openspec.mjs" validate extract-<capability> --strict`. Have the
   analyst fix every error and warning. `gate.mjs review` also checks the
   coverage, so the person does not: source-map.md holds every file the plan
   assigns to the capability, and every requirement has a trace row whose
   paths exist.
7. **Report** to the person: the number of requirements and screens, what the
   crosscheck found and fixed, how many sites the omission check judged and
   the gaps it found and how they were resolved, the questions they must
   decide, the path of the review page, and that step 4 is theirs. Then stop
   and wait.

## 4. Review: the person decides

Run the review (above) on `extract-<capability>`. Archiving makes the spec the
baseline under `openspec/specs/`. A suspected bug the person chose to fix is
not fixed during the migration: add it to the plan's `## Follow-up` list (see
Words); the finish step (step 6) lists it in the hand-over.

## 5. Implement: port the baseline spec

1. Port only capabilities whose extract change is archived, in plan order.
   Before the first port, run the environment check (step 0) again: a
   `toolchain` warning (the target language's build tools) must be fixed
   first. `node "<kit>/scripts/gate.mjs" port-ready --capability <capability>` must
   pass before you create the port change (it also needs the archived survey
   and target design, no open amendment, and database definitions that still
   match the survey's hash).
2. `node "<kit>/scripts/openspec.mjs" new change port-<capability> --schema spec-relay-port`, then write
   proposal, design and tasks with `node "<kit>/scripts/openspec.mjs" instructions <artifact> --change
   port-<capability> --json`. Record the baseline hash in the proposal from
   `node "<kit>/scripts/gate.mjs" baseline --capability <capability>`. Follow
   the target design; copy the source references for each requirement from the
   archived extract change's `trace.md` (and any later amendment's) into
   design.md. In design.md's Screens section, give each screen its policy from
   ui.md, and list under Carried files the carry files this port copies;
   `gate.mjs port-done` compares each copy with its source. With a B1 or B2
   command, fill design.md's Scenario checks: one row per baseline scenario,
   `e2e` for what a user does on a web screen (B2), `compare` for what a
   recorded case covers (B1), `unit` for the rest. If the archived
   target design has no ui.md (it was made before kit 0.8.0), ask the person
   for each screen's policy and record the answers under Decisions; never
   choose one yourself.
3. Show the person the design's structure, any additions to the conventions,
   the verification plan (each level and its command, and how many
   scenarios each check covers) and open risks, and
   start implementing after they agree. Propose lessons from their corrections
   (see Lessons).
4. Run `node "<kit>/scripts/openspec.mjs" instructions apply --change port-<capability> --json` and work
   through tasks.md. Give groups of tasks to the `spec-relay-implementer`
   subagent, one at a time; check its report and its verification results
   before accepting the work. Keep one port active at a time: ports share the
   target root's build files, and two implementers in one working folder
   collide. Its waves may also hold analysts and checkers of other
   capabilities (see Working in parallel).
5. When the code and the baseline spec disagree, stop and ask the person. Never
   change the spec or the code's behavior to make the two agree on your own. If
   the spec misread the source code, propose an amendment (below).
   The implementer also reports unspecified behavior: something the original
   code does that the spec does not mention. Nothing ports it, so it would
   vanish from the new system. Record each one at once as an unticked task
   under `## Unspecified behavior` in the port's tasks.md (`- [ ] U<n>
   <path:line>: <what it does>`), so `gate.mjs port-done` stops until it is
   settled. Show each one to the person with its source line, and propose an
   amendment that adds it (`## ADDED Requirements`) when the person agrees the
   spec missed it. Tick the task when the person decides it is not behavior to
   keep, or when the amendment is archived and the behavior is ported. Port
   the tasks that do not depend on it meanwhile. When the behavior is in a file
   the plan assigns to another capability, it belongs to that capability's
   spec instead.
6. **Verify.** When every task is done, run `node "<kit>/scripts/verify.mjs"
   --change port-<capability>`. It runs level A (the tests from the
   scenarios), the boundary check and the command design.md gives for each
   level verification.md chose (B1, B2, C), in the target root, and records
   the result in the change's `verify.json`; never write that file yourself.
   Before it runs, tell the person which commands it runs (the host's prompt
   to allow it shows only `node verify.mjs`) and that it may take a while. It
   stops at the first failure: give the printed `tail` to the implementer as
   one task and run it again. A command that chains (`a; b`, a pipe) is
   refused; ask for a design.md command, or tell the person when the
   conventions' command needs a new target design. A B1 command
   `spec-relay-compare --cases <dir> --driver "<command>"` compares the cases
   recorded from the source program with the new code's output: when cases
   differ, the new code is fixed, never the expected values or `rules.json`.
   With the driver `spec-relay-http --base <address> --start '<command>'` the
   cases are HTTP requests recorded from the running old system, and the run
   starts the new system itself, asks it the same and stops it. Recording
   (`http.mjs record`, a B1 task) sends real requests to the old system and
   can change its data: before that task, ask the person to confirm that the
   test copy runs at the address in verification.md, that its database is at
   the starting state, and that the sign-in variables are set in this
   terminal. Only the person may name a host other than this machine
   (`--allow-host`, for recording only; a port command never takes it);
   never add it yourself, and never record from production. Sign-in values
   are written `{{env:NAME}}` in the requests; the recording puts the
   placeholder back where an answer repeats a value, and leaves out values
   under names like token or session id.
   A B2 (or C) command `spec-relay-e2e --base <address> --start '<command>'`
   runs the screen tests in `tests/e2e/<capability with - for />/` against
   the new system it starts, and only when exactly those tests passed on the
   old system first, unchanged since (`e2e-old.json`). The old run is a task
   before verify that you run yourself, never a subagent (docs/E2E.md):
   before it, ask the person to confirm that the test copy of the old system
   runs at the address in verification.md and that its database is at the
   starting state, then run `node "<kit>/scripts/e2e.mjs" old --change
   port-<capability> --base <address>` (with `--reset '<command>'` when
   verification.md names one; the address must be the one verification.md
   names); never write `e2e-old.json` yourself. Then ask the person to stop
   the old system before verify: the new run refuses while the old one still
   answers, so a test cannot reach it. A test that fails on the old system is wrong:
   the implementer fixes the test. A test that fails on the new system is a
   difference: the implementer fixes the new code, never the test or its
   screenshots. Changing a test or a screenshot after the old run means
   running the old run again. Failure details and screenshot differences are
   under `openspec/spec-relay/local/e2e/` (git ignores it); give the path to
   the person when a screenshot differs.
7. **Port crosscheck.** Number the baseline spec's requirements (`R1 <name>`)
   and the archived extract change's screens (`S1 <name>`) by search, as in
   step 3, and give them to `spec-relay-checker` subagents as a **port
   check**: the paths of the baseline spec, the archived extract change's
   screens.md and trace.md (and any later amendment's trace.md), this change's
   design.md, the archived target design's conventions.md, the target module's
   folder, the items and the verdict file
   `openspec/spec-relay/work/port-<capability>/crosscheck-<nn>.md`. Never give
   a checker the implementer's reports, tasks.md or the lessons. Split a large
   capability into groups in one wave, then merge with `merge.mjs --into
   openspec/changes/port-<capability>/crosscheck.md --parts
   openspec/spec-relay/work/port-<capability> --clean`; the merge stamps the
   file with the hash of the code it was checked on, and port-done fails once
   the code changes after it. Never run an implementer and a checker of the
   same port in one wave. For every `mismatch`
   and `unclear` row, give the row to the implementer to fix, run `verify.mjs`
   again, then have a new checker check that row again (a part file with a
   higher number) and merge it, so the stamp is the fixed code's. When the row
   shows that the source code and the baseline spec disagree, stop and ask the
   person (step 5).
8. **Done check.** Run `node "<kit>/scripts/gate.mjs" port-done --change
   port-<capability>`. Besides the tasks and the baseline hash, it fails when
   the last verify run failed or the target code changed after it, when a
   baseline scenario has no test tagged `spec-relay: <capability> |
   <requirement> | <scenario>`, when a scenario's row in design.md's Scenario
   checks lacks its evidence (a unit test, a recorded case, or a screen test
   that passed on the old system and then on the new one), when the screen
   tests changed after the old run, when a `TODO(port)` is left in the target
   root, and when a crosscheck row is missing or not `confirmed`. Give a
   `TODO(port)` to the implementer to finish. Only when it cannot be finished
   in this port, ask the person whether to leave it for later; on a yes, list
   the file under `## Follow-up` in the proposal as `` - `<path>` - what is
   left (agreed by <name>) ``. Never weaken a test, a tag or a crosscheck row
   to pass.
9. When it passes, report the results with every `next.person` sentence: whether
   the source program was compared (B1, B2, C, and how the scenarios are
   checked) or the equivalence is only
   inferred from the code, the commands that ran and where they came from
   (a design.md command that replaced the conventions' one is named apart),
   and the `TODO(port)` left for later; the finish step collects them from
   the code. Archive the port change after the person agrees: `node
   "<kit>/scripts/openspec.mjs" archive port-<capability> --yes`.
10. When this was the last capability of the plan, go on to step 6 (Finish).

## Amend: correct a baseline spec

Only when a baseline spec does not describe what the source code does, or
leaves out something it does (found by a port test, a crosscheck, an
implementer's report of unspecified behavior or a person). Changing the behavior itself, such as
fixing a bug, is never an amendment: it is follow-up work after the migration.

1. `node "<kit>/scripts/openspec.mjs" new change amend-<capability> --schema spec-relay-amend` (add
   `-v<n>` for a second amendment of the same capability).
2. Give reason, specs and trace to one `spec-relay-analyst` (schema
   `spec-relay-amend`), then the crosscheck to checkers as in step 3 (part
   files merged by `merge.mjs`). Write impact.md and review.md yourself. A MODIFIED requirement replaces the whole block, and OpenSpec
   refuses to archive one that drops a scenario the baseline has, also when the
   requirement is removed and added again: keep every existing scenario name
   and correct its steps.
3. Run the review (above). Archiving merges the delta into the baseline.
4. Then do what impact.md says: an active port adds the tasks, updates its
   implementation and records the new baseline hash (`gate.mjs port-done`
   fails until it does); an archived port gets a new port change
   (`port-<capability>-v<n>`).

## 6. Finish: check the whole system and hand it over

Once for the project, after the last port. Each port was checked alone; this
step checks the new system as a whole, lists what the migration leaves open,
and writes the report someone takes it over with. It writes no code and
changes no behavior.

1. Run `node "<kit>/scripts/finish.mjs" ready`. It passes when every
   capability of the plan has an archived port against its current baseline
   and no other change is open; otherwise do what `problems` says first.
   Run `node "<kit>/scripts/gate.mjs" coverage` too: a source file that no
   capability covers was never ported, and the hand-over must not hide it.
2. `node "<kit>/scripts/openspec.mjs" new change finish --schema
   spec-relay-finish` (a second hand-over, after more ports: `finish-v2`),
   then `node "<kit>/scripts/finish.mjs" draft --change finish`. The draft
   writes checks.md and leftovers.md from the files: every `TODO(port)` under
   the target root, every `## Follow-up` item of the plan, every risk of the
   archived ports, the commands of conventions.md, the levels of
   verification.md and the relationships of the context map. Never retype
   these lists; run `finish.mjs collect` to see them again.
3. **Checks.** Run every command of checks.md over the whole target root, and
   every chosen verification level for every context, and write the results
   as the schema says (`pass`, `fail`, `not-run: <reason>`). For each
   cross-context flow, name the test that covers it, or `none`. A
   failure is fixed, never accepted: show it to the person and fix it through
   a new port change (`port-<capability>-v<n>`; `finish.mjs ready` then
   waits for it), then run every check again. After the last run, write the
   hash `node "<kit>/scripts/finish.mjs" hash` prints into checks.md.
4. **Leftovers.** Add a `verification` row for each `not-run` level and a
   `flow` row for each flow without a test. Propose a class and a reason for
   every row: `before-release`, `after-release` or `wont-fix`. Fix nothing
   here: a `TODO(port)` the person wants fixed now goes through a port change,
   then the draft is made again (delete leftovers.md first).
5. **Handover and review.** Write handover.md and review.md from their
   instructions, validate (`node "<kit>/scripts/openspec.mjs" validate finish
   --strict`) and run the review (above). Show the leftovers grouped by
   class, so that the person can accept a whole class at once, and put the
   `before-release` items first. `gate.mjs review --change finish` also fails
   when the code changed after the checks, when a `TODO(port)` in the code has
   no row or a row lists one that is gone, and when a plan follow-up is
   missing.
6. Archive after the person agrees. Archiving the finish change completes the
   migration: report the verdict, the `before-release` items and the
   "Before the switch" list of handover.md. Deployment, moving the data and
   the switch from the old system to the new one are not part of the kit.
   If code changes after that, `status.mjs` shows the finish step as open
   again: run it again as `finish-v<n>`.

## 7. Code guide (optional)

Only when the person asks for it, usually after the finish step or after the
first ports: a guide that helps someone understand the new code. It has three
ways in (by feature, by page or URL, by file), diagrams of the modules and
their data drawn from the target design, an explanation of every code file,
and the questions and answers the person found helpful. It explains; no gate
reads it and it approves nothing. See docs/GUIDE.md.

1. Ask what to cover: every module, or the ones they name. The guide needs
   the archived target design (its `## Modules` table) and the target root.
2. Run `node "<kit>/scripts/guide.mjs" init`. It makes
   `openspec/spec-relay/guide/` with `stack.md` (from conventions.md and the
   build files), a `routes.md` to fill, and prints each module's code files
   and the guide file to write (`code/<module>.md`). It never overwrites a
   file that is there. Tell the person about `unassigned` code files (under
   no module path of architecture.md): the guide does not cover them.
3. Run a wave of writers (Working in parallel): give each module to the
   `spec-relay-guide-writer` agent with its guide file, its module path and
   its list of code files as init printed them, and give `routes.md` to one
   more writer (the routes task). One writer per guide file: for a module
   too large for one writer, give the rest of its files to a writer in the
   next wave, to add to the same file. Save and compare the guard around the
   wave as usual (it does not cover `guide/`; the hook, when on, refuses a
   subagent's write to `guide/qa/`).
4. Run `node "<kit>/scripts/guide.mjs" stamp` (it writes the file's hash under
   each heading that has none), then `node "<kit>/scripts/guide.mjs" check`.
   Give the `problems` back to the writer of that file (a name not in the
   file, a line that does not exist, a handler that is gone), and a module
   with `unexplained` files too (`noCode` marks a module not ported yet: no
   writer for it), then stamp and
   check again. A hash that is there changes only with `--file <path>` (one
   per file written again) or `--file all`: never pass them for a file whose
   explanation was not rewritten, or its out-of-date warning disappears.
5. Show it: `node "<kit>/scripts/render.mjs" --guide all` writes
   `openspec/spec-relay/views/guide.html` and a page per module; in the
   canvas, `open_canvas` with input `{ "view": "guide" }` or the action
   `open_guide` (name: a module, a file of the target code or a URL of
   routes.md, which opens the page at that file).
6. **Questions from the canvas.** A question the person types on a guide page
   arrives as `[canvas] ...` with an id such as `q3-1a2b`. Answer it in the chat
   from the code, then send the same answer to the canvas:
   `invoke_canvas_action` (instanceId `spec-relay`, actionName `post_answer`,
   input `{ "id": "q3-1a2b", "answer": "<Markdown>" }`). It shows under the
   item, and on a module's page the person can press "Helpful (save to the
   Q&A)" to save it to `qa/<module>.md` with the file's hash. The ids last
   while the canvas is open; after it was closed, answer in the chat only. Never save an answer yourself unless
   the person asks in the chat; then append an entry to `qa/<module>.md` in
   the same form (`### Q: <question>`, `- File: <path>`, `- Hash:` left empty,
   `- Saved: <date>`, a blank line, the answer) and run `guide.mjs stamp`,
   which fills the empty hash. Subagents never write `qa/`.
7. After later changes to the code, `guide.mjs check` and the guide's pages
   show which explanations and saved answers are older than the code (the
   canvas does not watch the code: run the action `refresh`): give those files
   to a writer again, then `guide.mjs stamp --file <path>` for each. `status.mjs` shows one optional
   TODO line for the guide once `guide/` exists; it is never where the work is.

## Progress in the TODO list

Show where the migration stands in the host's TODO list (Copilot CLI:
`update_todo`; VS Code: `todo`), so the person sees it without asking. Only you
keep this list; the analyst, checker and implementer subagents have no TODO tool.

1. Run `node "<kit>/scripts/status.mjs" --format todo` (add `--capability
   <capability>` when you work on a capability other than the one it picks).
   It prints `todoList`: one line for the whole migration, then the survey and
   target-design steps until both are archived, the analyze, review and
   implement steps of the current capability, and one line for each other
   capability with an active change (the current step of work running in
   parallel), with titles in the artifact language, computed from the files
   under `openspec/` alone. Several lines may be in progress at once when
   subagents work in parallel. The JSON is ASCII with `\uXXXX` escapes; read it
   as JSON.
2. Pass it to the TODO tool in the shape that tool takes: VS Code's `todo`
   takes `todoList` as it is (`id`, `title`, `description`, `status`); Copilot
   CLI's `update_todo` takes one Markdown checklist, the `checklist` string.
   Pass the items, titles and statuses exactly as printed. Never set a status
   yourself, not even for the step you are doing, and never add the
   spec-relay items twice. If the person keeps items of their own in the list,
   keep those after the printed ones, numbered after the printed ids.
3. Do it at the start, on resume, when a step starts or ends, and right before
   you report and wait for the person (analysis report, review, port design,
   archive questions). Run the command again each time instead of editing the
   list by hand, so it always matches the files.
4. If `problems` is not empty, tell the person what it says and fix what is
   yours to fix (for example a plan without a `## Capabilities` list). A
   step that waits for the person shows as not started with the reason in its
   title (`【レビュー待ち 3/8】`); that is expected.
5. The TODO list is only a view. A ticked item never approves anything: review
   approval is still the person's word in this conversation plus a passing
   `gate.mjs`.
6. A successful tool call does not prove the list is on screen. Put the
   `checklist` string from the same JSON at the top of every phase report, and
   if the TODO tool is missing or fails, that checklist in chat is the progress
   display. Read the checklist from the JSON rather than from `--format
   checklist`, whose plain UTF-8 a Windows console code page can garble.
   Never install anything or change settings to get the TODO list working.
7. `--format markdown` adds a table of every capability; show it when the
   person asks for the whole picture.

## Time spent

Each run of `status.mjs` records the steps whose state changed, and the plugin
hook records when each kit subagent (analyst, checker, implementer) starts and
stops, in `openspec/spec-relay/local/metrics.jsonl` (git-ignored, one
machine's record). This is a record only: it approves and blocks nothing, and
progress still comes from the `openspec/` files. Running `status.mjs` at every
step start and end (above) is what makes the times right.

1. When the person asks how long things took, and in the report after each
   port archive, run `node "<kit>/scripts/metrics.mjs" report --format json`
   and show its `markdown` field as it is. Its step table separates time in
   progress from time waiting for the person, and its subagent table gives the
   subagents' own working time per capability. Times are wall clock between
   recorded changes, so nights and a session left open count too; the table
   says so, and you need not add more.
2. Tokens are not recorded: hooks get no token counts. Never estimate them.
   If the person pastes Copilot CLI's `/usage` output, write it unchanged to
   `openspec/spec-relay/local/usage.txt` with your edit tool and run
   `node "<kit>/scripts/metrics.mjs" note --file openspec/spec-relay/local/usage.txt
   [--capability <capability>]` (a file, because a shell would change `$`,
   backticks and quotes in the text). Never read the person's session files.
3. "Record metrics: off" in `openspec/config.yaml` stops all recording. Do not
   change that line; the person does. The record is not part of any review or
   gate, and you never edit or delete `metrics.jsonl`.

## When something stops

A gate, a script or the hook that stops you is the kit doing its job. Never work
around it: do not archive while a gate fails, tick boxes the person did not
accept, or edit the kit, the schemas, `openspec/config.yaml` or a gate's output
to get past a stop.

1. `gate.mjs` prints `next` beside `problems`. `next.person` holds sentences in
   the person's language for what only the person can do (approve items, name
   the reviewer, decide questions, finish another review, decide about a file
   that changed); pass them on as they are. `next.agent` holds the problems
   that are yours: fix them (or give them to a subagent) and run the gate again
   before you report. A gate that passes still lists in `next.person` the
   question you must ask before an archive.
2. Report every stop in this shape, in the person's language, before anything
   else in the reply:
   - **What stopped**: the check or command, and why in one line.
   - **What I need from you**: the `next.person` sentences, or "nothing, I am
     fixing it". When the person must decide, ask one question at a time.
   - **What I do next**: the fixes from `next.agent`, then the same check again.
   Put the TODO `checklist` (Progress in the TODO list) after it.
3. A tool call denied with a reason starting `spec-relay:` came from the kit's
   hook. Do what the reason says. When the person wants a denied change (an
   edit under the source root, a setting), they make it themselves; never look
   for another tool or command that does the same.
4. For a failure the environment may cause (a command not found, access denied,
   a file in use, a model or subagent error), follow Running commands first.
5. When a check still fails after two rounds of fixes, stop: show the person
   the remaining problems and ask how to go on.

## When the person asks to skip a step

The order survey, target design, analysis, review, implementation exists so
that every line of new code traces back to a spec the person approved (the
target design and the first analyses may overlap; that is not a skip). When the
person asks to skip a step, a review or a check:

1. Say in two sentences what the step protects and what it still needs, and
   offer the quickest way that keeps it: review in the files or a pull request,
   review the open questions first, split a large capability, or move a
   suspected bug to follow-up work.
2. Never archive, port or implement past a failing gate, even when asked. The
   order is checked by `gate.mjs` (review, port-ready, port-done) and, when
   Hook enforcement is on, by the hook.
3. If the person still wants to leave the flow, say that the kit cannot do that
   part, and that what is done outside it (with OpenSpec directly) is not
   checked or tracked by the kit.

## Status and resuming

- `node "<kit>/scripts/openspec.mjs" list --json` shows active changes; `node "<kit>/scripts/openspec.mjs" list --specs` shows
  baseline specs; `node "<kit>/scripts/openspec.mjs" status --change <name>` shows artifact progress.
- The project's step follows from OpenSpec: no archived survey - step 1;
  no archived target design - step 2. A capability's step: no extract change -
  not started; active extract change - step 3 or 4 (check review.md); archived
  extract - baseline exists; active port - step 5; archived port - ported; an
  active amendment holds the capability in review. When every capability is
  ported: no finish change - step 6; active finish change - step 6 (check
  review.md); archived finish change - the migration is complete.
- `node "<kit>/scripts/status.mjs" --format markdown` shows every capability's
  phase in one table.
- A project started on kit 0.1.0 has baselines but no survey or target design.
  Run the survey and the target design first (existing baselines and archived
  changes stay as they are; put their capabilities into the survey's list
  unchanged), because `gate.mjs port-ready` needs both. Until then,
  `status.mjs --capability <capability>` still shows that capability's steps.
- On resume, run the environment check (step 0), read the plan, the lessons
  and these commands, refresh the TODO list, tell the person where things stand, and
  continue the first unfinished step.
