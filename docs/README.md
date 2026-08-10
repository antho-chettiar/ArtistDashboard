# docs/

## Purpose
This folder holds the **current, canonical project documentation** — the latest audits, plans, and migration records produced during Sprint 3/4 cleanup. It is the first place to look for an up-to-date view of the backend, its technical debt, and the cleanup roadmap.

## Naming convention
- **Every current document begins with the prefix `my`** (e.g., `myBACKEND_AUDIT.md`).
- **The `my` prefix marks a file as the latest, authoritative version** of that topic. When you need the current state, read the `my*` file.
- File names are otherwise descriptive and are **never renamed** once created, so links and references stay stable.

## Why files begin with "my"
The prefix is a deliberate signal: it separates the **new canonical documentation** from the large body of **historical/legacy documentation** that predates this cleanup. A quick `my*` filter always surfaces the current set, with no ambiguity about which document is authoritative.

## Where historical docs live
Older documentation (e.g., `MASTER_PROJECT.md`, `CLAUDE.md`, `ARCHITECTURE_AUDIT.md`, `FORMULAS*.md`, `DEPLOYMENT.md`, and other pre-cleanup files) **remains in place at the repository root** and is intentionally left untouched. Those files are historical reference; the `my*` files in this folder supersede them where they overlap.

## Index
See [`INDEX.md`](INDEX.md) for the full catalogue of documents in this folder — purpose, last-updated date, dependencies, and owner.
