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
[scripts/status.mjs](../../scripts/status.mjs), `openspec-schemas/` and
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

## 0. Setup (once per repository)

1. Run `openspec --version`. If the command is missing, ask the person before
   installing it with `npm install -g @fission-ai/openspec@1.17.0` (Node.js
   22.12 or later; 1.17.0 is the version the kit is tested with). If `node`
   itself is missing, tell the person how to install it (Windows: `winget
   install OpenJS.NodeJS.LTS`) and stop.
2. If `openspec/config.yaml` already contains `# spec-relay: managed`, setup is
   done; read its context and go to the first unfinished step.
3. Otherwise ask, one question at a time: the source language (propose what you
   detect from the files), the target language, the source root, the target root
   and the language for artifacts (default: the person's language).
4. Run `node "<kit>/scripts/setup.mjs" --target . --source-language "..."
   --target-language "..." --source-root "..." --target-root "..." --language ...`
   without `--apply`, show the plan, and run it again with `--apply` after the
   person agrees. On a conflict, show it and ask how to resolve it; never
   overwrite, move or delete the person's files to get past it.
   Setup replaces OpenSpec's generic apply, archive and sync workflows with
   stubs that point here, because they skip the review gate. `openspec update`
   may restore them; run setup again
   after it.
5. Commit nothing on your own. Suggest a commit when setup is done.

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
2. Write inventory, context-map, glossary and capabilities in order, each from
   `openspec instructions <artifact> --change survey --json`. Every source file
   must be in the inventory: split the reading by folder across
   `spec-relay-analyst` subagents (give each a folder list and the
   instructions) and merge what they return. Legacy code rarely has clean
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
   missing from the inventory.
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
3. Write review.md, validate, and run the review (above).

## 3. Analyze: extract specs from the source code

Capabilities go in plan order, `platform` first.

1. **Create the change.** `openspec new change extract-<capability> --schema
   spec-relay-extract`. Use the capability path with `/` replaced by `-` as the
   change name.
2. **Write the artifacts in order**: source-map, specs, screens, trace,
   crosscheck, questions, review. For each, run `openspec instructions
   <artifact> --change extract-<capability> --json` and follow its
   instruction, template, context and rules. For a large capability, give the
   reading to the `spec-relay-analyst` subagent with the file list and the
   instructions, then write the files it returns yourself. Use the terms of
   the context's glossary.
3. **Crosscheck.** Give specs, screens.md, trace.md and the cited source files
   to the `spec-relay-checker` subagent, and nothing else: no notes, no earlier
   drafts. Write its verdicts to crosscheck.md. Fix every `mismatch` and
   `unclear` row and have the checker check that row again, or move it to
   questions.md (`question Q<n>`).
4. **Validate.** `openspec validate extract-<capability> --strict`. Fix every
   error and warning, then check that every requirement has a trace entry.
5. **Report** to the person: the number of requirements and screens, what the
   crosscheck found and fixed, the questions they must decide, the path of the
   review page, and that step 4 is theirs. Then stop and wait.

## 4. Review: the person decides

Run the review (above) on `extract-<capability>`. Archiving makes the spec the
baseline under `openspec/specs/`. A suspected bug the person chose to fix is
not fixed during the migration: note it in the plan as follow-up work after the
port.

## 5. Implement: port the baseline spec

1. Port only capabilities whose extract change is archived, in plan order.
   `node "<kit>/scripts/gate.mjs" port-ready --capability <capability>` must
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
   through tasks.md. Give a group of tasks to the `spec-relay-implementer`
   subagent when it helps; check its report and its verification results before
   accepting the work.
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
2. Write reason, specs, trace, crosscheck, impact and review from their
   instructions. A MODIFIED requirement replaces the whole block, and OpenSpec
   refuses to archive one that drops a scenario the baseline has: keep every
   existing scenario name and correct its steps.
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
   target-design steps until both are archived, and after that the analyze,
   review and implement steps of the current capability, with titles in the
   artifact language, computed from the files under `openspec/` alone. The JSON
   is ASCII with `\uXXXX` escapes; read it as JSON.
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
- On resume, read the plan and these commands, refresh the TODO list, tell the
  person where things stand, and continue the first unfinished step.
