# Proposals for the target design

<!-- Written before the target design's artifacts, to
openspec/spec-relay/work/<change>/proposals.md (not an artifact of the change).
An analyst fills Question, Recommended, Why and Other choices for every entry
from the survey (context-map.md, inventory.md, database.md, glossary.md,
capabilities.md) and the source's build and configuration files, following
the instructions of this schema's artifacts. The orchestrator asks the person
one entry at a time, the recommended choice first, and writes their answer
after "Answer:". The analysts who write the artifacts follow the answers.

- Question: in everyday words, what the person decides.
- Recommended: the answer you recommend, as a choice the person can take.
  Per-context answers (P4, P6) give one line per context id.
- Why: the reason, with the survey file or the source path it rests on. When
  only the person can know the answer, recommend what the code suggests and
  write "a guess from the code".
- Other choices: one line each, with what follows from it.
- Answer: left empty for the orchestrator.
Never recommend a `new` screen look: only the person picks it. Keep the
headings P1-P7 in English as they are. -->

## P1 Architecture style and modules
<!-- Default: a modular monolith in the manner of Spring Modulith - one module
per context plus platform, public API and events only, one owner per table,
an automated boundary check. Another style only for a reason the survey shows. -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:

## P2 Runtime, frameworks and main libraries
<!-- The target language's version, web or batch framework, data access and
test libraries, chosen for what the source does today (screens, batch jobs,
reports, the database). -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:

## P3 Running the old system as a test copy
<!-- Whether the source program can still be built and run here, and how
(build files, a container definition, a README). Comparisons with the old
system (B1, B2, C) need it. Only the person names a system on another
machine, never production. -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:

## P4 Verification levels per context
<!-- A (scenario tests) always. B2 for each context with web screens when the
old system runs here as a test copy (docs/E2E.md); C adds screenshots to the
same tests. Desktop screens (WinForms, WPF) cannot have B2. B1 for contexts
with calculations or business rules when the source can run here, over HTTP
for logic that cannot be called by itself, or records of real runs exist
(docs/COMPARE.md). A context with A only is reported as "inferred". -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:

## P5 Resetting the test databases
<!-- How the old and the new test database are put back to the starting state,
best as one command. Never a connection string or a password. -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:

## P6 Screens: users, look and technology
<!-- Who uses the screens and whether manuals, training or printed forms show
them; the target UI technology; the policy of each context (same, layout,
none), as ui.md's instruction suggests them. -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:

## P7 Data during the switch
<!-- All at once or side by side on the same database, whether the database
product stays, and whether data.md's defaults for the logic in the database
(keep triggers, constraints, views, procedures and functions) fit. -->
- Question:
- Recommended:
- Why:
- Other choices:
- Answer:
