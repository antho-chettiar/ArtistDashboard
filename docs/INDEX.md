# docs/ — INDEX

Catalogue of current canonical documentation. All files use the `my` prefix (see [`README.md`](README.md)). "Dependencies" means _which other document a file is derived from or references_.

| Document | Purpose | Last updated | Dependencies | Owner |
|---|---|---|---|---|
| [README.md](README.md) | Explains this folder, the `my` naming convention, and where historical docs live | 2026-08-05 | — | Engineering — Lead Architect |
| [INDEX.md](INDEX.md) | This catalogue of all documents in `docs/` | 2026-08-05 | Lists all `my*` docs | Engineering — Lead Architect |
| [myBACKEND_AUDIT.md](myBACKEND_AUDIT.md) | Sprint 4.1 backend cleanup & technical-debt audit — unused code, duplicate implementations, dead APIs, dead/write-only models | 2026-08-05 | Source document (feeds the three below) | Engineering — Backend |
| [myREMOVAL_LIST.md](myREMOVAL_LIST.md) | Itemized Safe-to-Remove / Needs-Review / Keep decisions | 2026-08-05 | Derived from `myBACKEND_AUDIT.md` | Engineering — Backend |
| [myCLEANUP_PLAN.md](myCLEANUP_PLAN.md) | Phased, reversible cleanup plan (Phase 0–5) | 2026-08-05 | Derived from `myBACKEND_AUDIT.md`, `myREMOVAL_LIST.md` | Engineering — Lead Architect |
| [myDEPENDENCY_GRAPH.md](myDEPENDENCY_GRAPH.md) | Active-vs-legacy backend wiring graph | 2026-08-05 | Derived from `myBACKEND_AUDIT.md` | Engineering — Backend |
| [myLEGACY_MIGRATION_REPORT.md](myLEGACY_MIGRATION_REPORT.md) | Record of moving 🟢 SAFE dead files into `legacy/` | 2026-08-05 | Based on `myREMOVAL_LIST.md` (🟢 items); see `legacy/MANIFEST.md` | Engineering — Lead Architect |
| [myDOCUMENTATION_MIGRATION_REPORT.md](myDOCUMENTATION_MIGRATION_REPORT.md) | Record of this documentation-consolidation task (moving `my*` docs into `docs/`) | 2026-08-05 | Meta — none | Engineering — Lead Architect |

## Related, outside this folder (not moved)
- `legacy/MANIFEST.md` — manifest of files quarantined under `legacy/`.
- Historical docs at repo root (`MASTER_PROJECT.md`, `CLAUDE.md`, `ARCHITECTURE_AUDIT.md`, `FORMULAS*.md`, etc.) — retained as historical reference.
