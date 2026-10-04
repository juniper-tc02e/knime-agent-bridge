# v0.5 long-session reliability design

The measured desktop lag has no established cause. This release repairs reproducible bridge defects and adds observability without claiming desktop lag elimination. The original configured installation, global MCP configuration and analytical workspaces remain untouched. Development and native validation use a separate synthetic workspace.

## Architecture choices

Retain MCP stdio plus filesystem IPC and one serialized native mutation worker. Adding native workers risks revision and scope guarantees; cancellation acquires native locks and therefore remains serialized. A narrow descriptor/telemetry observation path avoids gateway initialization, workflow locks and SWT. Its response explicitly cannot certify UI responsiveness or cancellation completion.

Retain v0.4 disk-authoritative evidence validation. Async history discovery and bounded pages reduce event-loop blocking and duplicated payloads; cached file metadata never supplies receipt authority. Full detail remains explicitly retrievable by immutable reference. Do not delete retained evidence or silently increase timeouts.

Explicit optional profiles bind readable names to runtime, session and expected bundle/version. No fallback or global configuration rewrite. Client call deadlines start once before selection/staging; observation deadlines stay separate. Unknown published mutations return their original UUID and read-only local reconciliation recipe, never an automatic retry.

## Release requirements

1. B01: join configured source/version/profile/runtime, exact native descriptor and process identity, compatibility and effective availability; reject mismatches before dispatch.
2. B02: bounded queue/current-stage/counter diagnostics outside the worker. Preserve serialized cancellation and distinguish queued, requested, acknowledged and terminal evidence.
3. B03: immutable monotonic client deadline and observer budget. Do not launch a two-step observation with unusable residual budget. Label clock owners and submission uncertainty.
4. B04: instance UUID and self/parent OS creation identities where available; definitive EOF shuts down only its own transport and preserves unknown pending operations. Test repeated lifecycle and intentional concurrency.
5. B05: small MCP text summaries, one structured full payload, explicit large-detail references and history pages. Async scans retain independent-writer and replacement invalidation. Measure cold/warm history, bytes and event-loop boundaries.
6. B06: selected safe scalar variables and explicit physical workflow root/effective path comparison; opaque and cached provenance stay unknown. Inspection never executes/resets a producer.
7. B07: primary error immutable, secondary journal/publication failures separate, original result and UUID reconcilable. Publication is distinct from durable journal confirmation.
8. B08: expected immutable table identity at every page; full keyed/constant/metric verification, exact page coverage and final recheck. Named positive-class semantics and ties/null cases. Fresh inference remains unverified without independent execution evidence.
9. B09: existing functional/visual/persistence distinctions retained. Fresh native render images are actually inspected; durable reopen and archive manifest are separate from save acknowledgment. No universal viewport synchronization or second-machine portability claim.
10. B10: strict typed examples and error-specific read-only next calls; no permissive ID/scope/port coercion.

## Acceptance boundaries

Use fresh temporary histories and synthetic native workflows only. Record exact test counts per invocation, skips and composed evidence. Collect comparable p50/p95/max with sample counts and counters; do not compare unlike observations or subtract unsynchronized process clocks. Live KNIME tests prove integration separately from Java boundary harnesses. Host rendering/GPU frames and genuine user lag episodes remain unmeasured if unavailable. No full-response/table/credential values in timing traces. Public package excludes private handover, raw machine paths, coursework and runtime artifacts.
