# Architecture

## Style
Modular monolith, one module per bounded context (Spring Modulith style).

## Modules
| Context | Module path | Public API | Events published | Depends on |
|---|---|---|---|---|
| platform | <!-- target-root/platform --> | <!-- --> | <!-- --> | - |

## Data ownership
| Table or file | Owning module |
|---|---|
| <!-- --> | <!-- --> |

## Boundary check
- Tool: <!-- Spring Modulith / dependency-cruiser / import-linter / ArchUnitNET ... -->
- Rules: <!-- no access to another module's internals; no cycles; only the owner writes its tables -->
- Command: <!-- one line, runs in PowerShell -->

## Layout
```text
<!-- target root tree -->
```
