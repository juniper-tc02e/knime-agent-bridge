# v0.4 diagnosis and change boundaries

The operating handover described several kinds of failures. They should produce different fixes.

| Finding | Classification | v0.4 response |
|---|---|---|
| Every bind retained a native reference; 1,024 slots were exhausted | Confirmed bridge lifecycle limit | Atomic cap, usage warning, explicit release, conservative invalid-model pruning, immutable IDs |
| Retained evidence made each filtered lookup reread every history record | Confirmed during final long-session acceptance: 6,221 files scanned to return eight observations; canvas repair hit MCP's unchanged timeout | Incremental record-kind discovery; matching records retain fresh disk/digest validation and historical files remain intact |
| A session UUID in another IPC directory was invisible to the configured MCP | Connection ergonomics; no proven silent process switching | `knime_connection`, runtime in session/error/receipt diagnostics, process identity pinning, isolated alias guide |
| Patching can reset/reconfigure selected and downstream nodes | Native configuration behavior; preview gap | Detached typed diff and validation through `knime_settings_preview`, conservative reset impact |
| Stored Reader fallback named an older output | Workflow integration error; inspection gap | Native variable-resolved model settings and upstream lineage through `knime_dependencies`; explicit run-data validation remains required |
| Timeout followed by uncertain native/journal outcome | Existing asynchronous boundary | Submission/expiry/reconciliation metadata, preserved uncertainty, no automatic replay, original UUID |
| Partial learner defaults, swallowed serialization failures, Windows metadata locks, restored tabs before model load | Previously reproduced and repaired in v0.3 | Keep and rerun regressions; do not present as newly discovered defects |
| Guessed unsupported dialog service; null lifecycle revisions; wrong ID/port/argument shape | API constraints and caller mistakes | Discovery-first examples, exact scope targeting, workspace `expected:{}`, strict validation |
| Middle-dot text already contained an extra character in the request | Caller-origin encoding error | Unicode/native/save-reopen regression; preserve the supplied input exactly |
| Model-owner watchdog identity and timeout proposals | Separate analytics runtime concerns | No changes to model science, fitted states, guards, deadlines or admissions |
| Context exhaustion and an unresponsive-UI dialog occurred in the same old process | Causality unproved | No claim that release fixes a UI hang; descriptor readiness is distinct from responsiveness |

## Why these interfaces

MCP stays the discoverable agent interface and the CLI stays its script/diagnostic counterpart. A second control stack would introduce divergent targeting and validation. Both use the same pinned filesystem client and native bridge. No HTTP port, Business Hub account or hosted service was added.

Explicit release is preferable to automatic eviction of live contexts: a long-running client keeps its authority until it releases it. Bind once per live scope, use inspect to refresh, release when finished. Closing/replacing a model permanently invalidates old contexts; pruning frees only bindings whose invalidity is proved. Historical quality records are not authority and remain readable after release.

Preview shares preparation and validation with apply, but has no loading or reset step. It reports uncertainty about effective variable overrides, views, exact reset effects and future persisted artifacts. Native validation is version-specific and third-party validators are outside the bridge's universal purity guarantee. Applying still requires a fresh live revision guard.

Dependency inspection calls the installed native model-settings resolution API. It does not derive an effective path from a stored fallback. Opaque variable values, cross-scope lineage, output freshness and producer table fingerprints have explicit coverage limits. A resolved path alone cannot prove the correct run was read.

## Migration and limits

The wire protocol remains compatible with v0.3 callers using valid typed inputs. New operations require a v0.4 native JAR. Unknown, duplicate/overlapping patch paths and numeric `xlong` inputs now fail before apply; use decimal strings. Empty native array type uncertainty remains explicit.

An already running v0.3 JVM retains its old bundle and cannot acquire these lifecycle operations by replacing source files. Use a new version folder and private runtime for trials; save and deliberately relaunch the old instance later. Never replace an active runtime's configuration or registration to deploy this release.

The verification report states the actual installed build, fresh test counts and remaining gaps. A same-host save/reopen is not proof of second-machine portability. Canvas rendering and layout certification are not expanded in this release.
