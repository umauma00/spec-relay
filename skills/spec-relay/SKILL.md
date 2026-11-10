---
name: spec-relay
description: Procedure of the spec-relay orchestrator agent for migrating a code base to another language with OpenSpec - extract language-neutral specs from the source code, gate them on a human review, then implement them in the target language. Use for whole-codebase language ports driven by specs. Not for ordinary feature work.
user-invocable: false
---

# spec-relay

This skill is the procedure of the `spec-relay-orchestrator` agent. If you are
not running as that agent, do not start, review or archive spec-relay changes:
tell the person to select `spec-relay-orchestrator` in the agent picker (Copilot
CLI: `/agent`) and stop. A subagent the orchestrator starts does its assigned
task and returns to it.

The kit's own files are two directories above this skill (`<kit>` below):
`scripts/setup.mjs`, `scripts/gate.mjs`, `openspec-schemas/` and
`docs/WORKFLOW.md`. Read `docs/WORKFLOW.md` once when you
need the reasoning behind a step.

## Words

- **Source root**: the existing code. Read-only for every agent, always. When
  the source root is the repository root (`.`), the only paths you may change
  are `openspec/` and the target root.
- **Target root**: where the new implementation goes.
- **Capability**: one cohesive behavior of the system (for example
  `billing/invoice`). Every change covers exactly one capability, so an
  extract change has exactly one spec file.
- **Extract change**: `openspec/changes/extract-<capability>` with schema
  `spec-relay-extract`. Produces the baseline spec (phases 1-2).
- **Port change**: `openspec/changes/port-<capability>` with schema
  `spec-relay-port`. Implements the baseline spec (phase 3).
- **Baseline spec**: `openspec/specs/<capability>/spec.md`, created when a
  reviewed extract change is archived.
- **Plan**: `openspec/spec-relay/plan.md`, the capability list and order.

## 0. Setup (once per repository)

1. Run `openspec --version`. If the command is missing, ask the person before
   installing it with `npm install -g @fission-ai/openspec@1.17.0` (Node.js
   22.12 or later; 1.17.0 is the version the kit is tested with).
2. If `openspec/config.yaml` already contains `# spec-relay: managed`, setup is
   done; read its context and go to the first unfinished phase.
3. Otherwise ask, one question at a time: the source language (propose what you
   detect from the files), the target language, the source root, the target root
   and the language for artifacts (default: the person's language).
4. Run `node <kit>/scripts/setup.mjs --target . --source-language ...
   --target-language ... --source-root ... --target-root ... --language ...`
   without `--apply`, show the plan, and run it again with `--apply` after the
   person agrees. On a conflict, show it and ask how to resolve it; never
   overwrite, move or delete the person's files to get past it.
   Setup removes OpenSpec's generic apply, archive and sync workflows because
   they skip the review gate. `openspec update` adds them back; run setup again
   after it.
5. Commit nothing on your own. Suggest a commit when setup is done.

## 1. Analyze: extract specs from the source code

1. **Plan capabilities.** Survey the source root (structure, entry points,
   build files, tests). Propose a capability list in dependency order, with the
   source directories of each, and write it to the plan after the person agrees
   to the list. Start with a small capability that has few dependencies.
   Avoid names that collide once `/` becomes `-` (`billing/invoice` and
   `billing-invoice` would get the same change name).
2. **Create the change.** `openspec new change extract-<capability> --schema
   spec-relay-extract`. Use the capability path with `/` replaced by `-` as the
   change name.
3. **Write the artifacts in order**: source-map, specs, trace, questions,
   review. For each, run `openspec instructions <artifact> --change
   extract-<capability> --json` and follow its instruction, template, context
   and rules. For a large capability, give the reading to the
   `spec-relay-analyst` subagent with the file list and the instructions, then
   write the files it returns yourself.
4. **Validate.** `openspec validate extract-<capability> --strict`. Fix every
   error and warning, then check that every requirement has a trace entry.
5. Report to the person: the number of requirements, the questions they must
   decide, and that phase 2 is theirs. Then stop and wait.

## 2. Review: the person decides

The person reviews; you assist. This gate is the point of the kit.

1. Run `openspec instructions apply --change extract-<capability> --json` and
   follow the schema's apply instruction: walk `review.md` one item at a time.
2. Tick a box only when the person accepts that item in this conversation, or
   when they ticked it in the file themselves. Write their decision after
   `decision:` on each question line, and their name after `Reviewer:`. When
   they ask for a change, edit the artifacts, untick every item whose
   requirement, trace entry or question you changed, show the result, validate
   again and ask again.
3. When every box is ticked, run `node <kit>/scripts/gate.mjs review --change
   extract-<capability>`. It fails when a requirement or question has no review
   item, an item is unticked, a decision is blank or no reviewer is named.
   `openspec archive --yes` checks none of this, so never archive while the gate
   fails. Then ask whether to archive, and archive only on an explicit yes:
   `openspec archive extract-<capability> --yes`. The spec is now the baseline
   under `openspec/specs/`.
4. A suspected bug the person chose to fix is not fixed during the migration.
   Note it in the plan as follow-up work after the port.

## 3. Implement: port the baseline spec

1. Port only capabilities whose extract change is archived, in plan order.
   `node <kit>/scripts/gate.mjs port-ready --capability <capability>` must pass
   before you create the port change.
2. `openspec new change port-<capability> --schema spec-relay-port`, then write
   proposal, design and tasks with `openspec instructions <artifact> --change
   port-<capability> --json`. Copy the source references for each requirement
   from the archived extract change's `trace.md` into design.md.
3. Show the person the design's language-mapping decisions and open risks, and
   start implementing after they agree.
4. Run `openspec instructions apply --change port-<capability> --json` and work
   through tasks.md. Give a group of tasks to the `spec-relay-implementer`
   subagent when it helps; check its report and its verification results before
   accepting the work.
5. When the code and the baseline spec disagree, stop and ask the person. Never
   change the spec or the code's behavior to make the two agree on your own.
6. When every task is done and verified, run `node <kit>/scripts/gate.mjs
   port-done --change port-<capability>`, report the results, and archive the
   port change after the person agrees: `openspec archive port-<capability>
   --yes`.

## Status and resuming

- `openspec list --json` shows active changes; `openspec list --specs` shows
  baseline specs; `openspec status --change <name>` shows artifact progress.
- A capability's phase follows from OpenSpec: no extract change - phase 1 not
  started; active extract change - phase 1 or 2 (check review.md); archived
  extract - baseline exists; active port - phase 3; archived port - ported.
- On resume, read the plan and these commands, tell the person where things
  stand, and continue the first unfinished step.
