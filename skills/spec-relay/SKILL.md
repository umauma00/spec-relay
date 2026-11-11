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
[scripts/merge.mjs](../../scripts/merge.mjs),
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
- If PowerShell answers `openspec` or `npm` with "running scripts is disabled
  on this system", the command exists: call `openspec.cmd` or `npm.cmd`
  instead. Never change the execution policy unless the person asks.
- After installing a tool, PATH is stale in the open terminal. The kit's
  scripts look in npm's global folder themselves; for your own `openspec`
  calls open a new terminal.
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
  `spec-relay-target`). Module structure, conventions and verification levels
  of the new system (step 2).
- **Extract change**: `openspec/changes/extract-<capability>` (schema
  `spec-relay-extract`). Produces the baseline spec (steps 3-4).
- **Port change**: `openspec/changes/port-<capability>` (schema
  `spec-relay-port`). Implements the baseline spec (step 5).
- **Amend change**: `openspec/changes/amend-<capability>` (schema
  `spec-relay-amend`). Corrects a baseline spec that misread the source code.
- **Baseline spec**: `openspec/specs/<capability>/spec.md`, created when a
  reviewed extract change is archived.
- **Plan**: `openspec/spec-relay/plan.md`, the capability list and order.
- **Rerun**: OpenSpec cannot archive two changes of the same name on one day,
  so a second survey, port or amendment of the same thing gets a `-v<n>`
  suffix (`port-billing-invoice-v2`). The scripts treat it as the same change.
- **Review page**: the HTML view of a change's Markdown, made by the
  `spec-relay-view` skill. The Markdown stays the source of truth.
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
     warnings that stay (a newer OpenSpec, a synchronised folder): list their
     ids in one line and go on, unless one is new or changed. A `trial`
     warning needs no question: run the trial (step 6).
   - An `info` needs no answer; mention it in a line (for `telemetry`, how to
     turn it off) before setup, and not again later.
   - Never install, update or change settings to fix a check on your own:
     ask first for installs (`npm install -g @fission-ai/openspec@1.17.0`),
     and leave the execution policy, git's global config and OpenSpec's
     settings to the person.
2. If `openspec/config.yaml` already contains `# spec-relay: managed`, setup is
   done: read its context, run the trial (step 6) if the check reported `trial`
   as `warn`, and go to the first unfinished step.
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
   Setup replaces OpenSpec's generic apply, archive and sync workflows with
   stubs that point here, because they skip the review gate. `openspec update`
   may restore them (the check reports `workflows` then); run setup again
   after it.
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
   nor the repository instructions. Never paste instructions, templates, source
   code or artifacts into a task, and never ask for artifacts back: subagents
   return a short report. Check their work with `openspec validate`,
   `openspec status --change`, `gate.mjs` and `merge.mjs`, and read an
   artifact yourself only for what you must tell or ask the person (questions,
   crosscheck rows that are not `confirmed`, the counts in your report). To
   list requirement and screen names, search for lines starting with
   `### Requirement:` and `### Screen:` instead of reading the files.
4. **One writer per file.** No two subagents of a wave write the same file.
   Analysts and checkers write only the paths you give them, the implementer
   only its capability's module. Only you write `review.md`, `plan.md` and
   `questions.md`, run `openspec` commands, render review pages and archive.
   Never give a subagent a path under the source root (when the source root is
   `.`, give only paths under `openspec/` and the target root), under
   `openspec/specs/`, or `openspec/config.yaml`.
   Before every wave, run `node "<kit>/scripts/gate.mjs" guard --save
   wave-<n>`: it saves the hashes of the files no subagent may write (every
   active change's `review.md` and `questions.md`, `plan.md`,
   `openspec/specs/`, `openspec/config.yaml` and the source files). After the
   wave, run `gate.mjs guard --compare wave-<n>`, which lists only the paths
   that changed (exit code 1 then: read the lists). If the wave is still
   running when you must write a guarded file yourself (a tick, a question, an
   archive), run `--compare` first: if that path already changed, a subagent
   changed it; otherwise write, then `--save wave-<n>` again. For any change
   you did not make, stop, tell the person what changed, and do not use that
   wave's results until they decide. If `--save` prints `warnings`, tell the
   person which files are not guarded.
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
   wording) should reach the next analyses before they are written.
8. **Pilot first.** Analyze the first capability (`platform`) on its own
   (`nextToAnalyze` holds one capability until the first is reviewed) and
   bring what its review taught into the tasks of later analysts.
9. Hand the person reviews of the same context one after another where the
   order allows, because they share words and data.

## Reviews: what every human review shares

Steps 1, 2 and 4 and every amendment end in a human review. The person decides;
you assist. This gate is the point of the kit.

1. Render the review page (`node "<kit>/scripts/render.mjs" --change <change>`,
   see the `spec-relay-view` skill) and give the person its path. Render again
   after every change to the artifacts.
2. Ask how they want to review: here in the conversation, one item at a time,
   or in the files or a pull request on their own (they tell you when done,
   and you check what they ticked). Both are fine; never pick for them.
3. Follow the change's apply instruction (`openspec instructions apply --change
   <change> --json`). Tick a box only when the person accepts that item in this
   conversation, or when they ticked it in the file themselves. Write their
   decision after `decision:` and their name after `Reviewer:`. When they ask
   for a change, edit the artifacts, untick every item you changed, validate,
   render again and ask again.
4. When every box is ticked, run `node "<kit>/scripts/gate.mjs" review --change
   <change>`. `openspec archive --yes` checks none of what the gate checks, so
   never archive while the gate fails. Then ask whether to archive, and archive
   only on an explicit yes: `openspec archive <change> --yes`.

## 1. Survey: map the bounded contexts

Read the WHOLE source code base before splitting it, so that the split follows
the domain, not the folders.

1. `openspec new change survey --schema spec-relay-survey`.
2. Write inventory, context-map, glossary and capabilities (schema
   `spec-relay-survey`) in waves (see Working in parallel). Every source file
   must be in the inventory.
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
   - **Glossary and capabilities**: one wave of two analysts, one file each.
   Legacy code rarely has clean
   boundaries: propose owners for shared tables, split god classes by method,
   put technical shared parts in `platform`, and give the evidence for each
   boundary. Name capabilities so that OpenSpec and Windows both accept them:
   each path segment is lowercase ASCII kebab-case (`billing/invoice`, not
   `Billing_Invoice` or `請求`; put the Japanese name beside it), never a
   Windows device name (`con`, `prn`, `aux`, `nul`, `com1`...), not ending in
   `-v<digits>`, and short, because the path repeats inside
   `openspec/changes/archive/` and Windows limits paths to 260 characters.
3. Write review.md, validate (`openspec validate survey --strict`), then run
   the review (above). `gate.mjs review` also fails while a source file is
   missing from the inventory. While the person reviews, ask the questions the
   target design needs (step 2) so that it can start right after the archive.
4. After archiving, write the plan: copy capabilities.md's lists under a
   `## Capabilities` heading in `openspec/spec-relay/plan.md`, keeping the
   `### <context>` headings. `status.mjs` counts only the top-level items that
   start with a backticked capability path; put other notes, such as follow-up
   work, under another `##` heading.

## 2. Target design: decide how the new system is built

1. `openspec new change target-design --schema spec-relay-target`.
2. Write architecture, conventions and verification from their instructions.
   The default architecture is a modular monolith in the manner of Spring
   Modulith: one module per context, public API and events only, one owner per
   table, an automated boundary check. Ask the person about anything the code
   cannot tell you: frameworks they prefer, whether the source program can
   still be run, and which verification levels each context needs (A scenario
   tests always; B1 logic comparison, B2 screen replay, C screenshots by
   choice). Never write a password, token or connection string into a file;
   sign-in for B2 and C comes from environment variables the person sets.
   Write architecture.md first (yourself or one analyst), then give
   conventions.md and verification.md to two analysts in one wave, with the
   person's answers in each task.
3. Write review.md, validate, and run the review (above). While the person
   reviews the target design, start analyzing (step 3) the capabilities in
   `nextToAnalyze`: an extract change needs the archived survey, not the target
   design.

## 3. Analyze: extract specs from the source code

Capabilities go in plan order, `platform` first, only those in
`nextToAnalyze` (see Working in parallel). Several capabilities run in the same
waves.

1. **Create the change.** `openspec new change extract-<capability> --schema
   spec-relay-extract`. Use the capability path with `/` replaced by `-` as the
   change name.
2. **Draft**: give each capability to one `spec-relay-analyst`: it writes
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
4. **Questions and review.** Write questions.md from the analysts' reported
   doubts and the rows moved to questions, then review.md (names by search,
   not by reading the spec).
5. **Validate.** `openspec validate extract-<capability> --strict`. Have the
   analyst fix every error and warning, then check that every requirement has
   a trace entry.
6. **Report** to the person: the number of requirements and screens, what the
   crosscheck found and fixed, the questions they must decide, the path of the
   review page, and that step 4 is theirs. Then stop and wait.

## 4. Review: the person decides

Run the review (above) on `extract-<capability>`. Archiving makes the spec the
baseline under `openspec/specs/`. A suspected bug the person chose to fix is
not fixed during the migration: note it in the plan as follow-up work after the
port.

## 5. Implement: port the baseline spec

1. Port only capabilities whose extract change is archived, in plan order.
   Before the first port, run the environment check (step 0) again: a
   `toolchain` warning (the target language's build tools) must be fixed
   first. `node "<kit>/scripts/gate.mjs" port-ready --capability <capability>` must
   pass before you create the port change (it also needs the archived survey
   and target design, and no open amendment).
2. `openspec new change port-<capability> --schema spec-relay-port`, then write
   proposal, design and tasks with `openspec instructions <artifact> --change
   port-<capability> --json`. Record the baseline hash in the proposal from
   `node "<kit>/scripts/gate.mjs" baseline --capability <capability>`. Follow
   the target design; copy the source references for each requirement from the
   archived extract change's `trace.md` (and any later amendment's) into
   design.md.
3. Show the person the design's structure, any additions to the conventions,
   the verification plan and open risks, and start implementing after they
   agree.
4. Run `openspec instructions apply --change port-<capability> --json` and work
   through tasks.md. Give groups of tasks to the `spec-relay-implementer`
   subagent, one at a time; check its report and its verification results
   before accepting the work. Keep one port active at a time: ports share the
   target root's build files, and two implementers in one working folder
   collide. Its waves may also hold analysts and checkers of other
   capabilities (see Working in parallel).
5. When the code and the baseline spec disagree, stop and ask the person. Never
   change the spec or the code's behavior to make the two agree on your own. If
   the spec misread the source code, propose an amendment (below).
6. When every task is done and verified, run `node "<kit>/scripts/gate.mjs"
   port-done --change port-<capability>`, report the results, and archive the
   port change after the person agrees: `openspec archive port-<capability>
   --yes`.

## Amend: correct a baseline spec

Only when a baseline spec does not describe what the source code does (found
by a port test, a crosscheck or a person). Changing the behavior itself, such as
fixing a bug, is never an amendment: it is follow-up work after the migration.

1. `openspec new change amend-<capability> --schema spec-relay-amend` (add
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

## Status and resuming

- `openspec list --json` shows active changes; `openspec list --specs` shows
  baseline specs; `openspec status --change <name>` shows artifact progress.
- The project's step follows from OpenSpec: no archived survey - step 1;
  no archived target design - step 2. A capability's step: no extract change -
  not started; active extract change - step 3 or 4 (check review.md); archived
  extract - baseline exists; active port - step 5; archived port - ported; an
  active amendment holds the capability in review.
- `node "<kit>/scripts/status.mjs" --format markdown` shows every capability's
  phase in one table.
- A project started on kit 0.1.0 has baselines but no survey or target design.
  Run the survey and the target design first (existing baselines and archived
  changes stay as they are; put their capabilities into the survey's list
  unchanged), because `gate.mjs port-ready` needs both. Until then,
  `status.mjs --capability <capability>` still shows that capability's steps.
- On resume, run the environment check (step 0), read the plan and these
  commands, refresh the TODO list, tell the person where things stand, and
  continue the first unfinished step.
