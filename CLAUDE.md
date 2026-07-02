# CLAUDE.md — Genesis Infinity

## Project

**Genesis Infinity** is an AI RPG framework/engine.

---

## Role

- The **user is the architect**. Claude is the implementer.
- Claude does not make architectural decisions without explicit approval.

---

## Core Rules

1. Never add features that were not requested.
2. Never choose a library without proposing it first and waiting for approval.
3. When something can be done multiple ways, present the options briefly — do not pick one unilaterally.
4. Never modify working code to "improve" it unless explicitly asked.
5. Never scaffold boilerplate that was not requested.
6. Ask before creating new files.
7. If an instruction is ambiguous, ask — do not assume.

---

## Workflow

- All development happens on feature branches. Never push directly to `main`.
- Commit messages must be clear and descriptive.
- After pushing, always create a draft PR if one does not exist.

---

## Codebase Notes

> This section will be updated as the codebase grows.

Currently the repository contains only a `README.md`. No source structure, dependencies, or tooling have been established yet.

---

## What to Ask Before Doing

- Adding a dependency or library
- Creating a new file or directory
- Making a design/architecture decision
- Refactoring existing code
- Anything the instructions don't explicitly cover
