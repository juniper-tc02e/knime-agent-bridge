# v0.5 diagnosis and engineering decisions

The desktop lag cause remains **unknown**. The supplied observations established stale route metadata, duplicate response detail and many transport instances. They did not measure UI frames, disk latency, garbage collection or a causal intervention. Repeated instances can belong to legitimate clients; idle instances are not proven leaks. Process private bytes cannot be summed into physical memory consumption.

Development used a separate source checkout, runtime and synthetic workspace. It did not dispatch into the analytical runtime, update global MCP configuration, operate on accepted workflows or message the analytical session. The user subsequently authorized publication of this version.

## Issue classification and resulting behavior

| ID | Diagnosis | v0.5 change | Remaining boundary |
|---|---|---|---|
| B01 | Observed old configured route and unavailable native session; historical acceptance remains valid | Named profiles pin canonical runtime, session, native version and bundle. Concise connection diagnostics show configured client source separately from process availability. Conflicts refuse before publication. | Descriptor readiness does not establish UI health. A new JAR requires a deliberately restarted instance and rediscovered IDs. |
| B02 | Source-supported queue risk; reported lag causality unproved | Bounded queue/worker/request-stage telemetry on a safe observation lane that never constructs the workflow gateway. Queue overflow finalizes the original request as rejected before dispatch. | Mutations and cancellation remain serialized. KNIME lock/SWT/external-node and host-rendering durations are unmeasured. |
| B03 | Historical observer expiration could resemble operation failure | One immutable client deadline starts at call entry. Observer expiry is separate and refuses another expensive read when the remaining budget is too small. Original UUID and read-only recovery survive errors and EOF. | Host MCP timeout is owned by the host; it cannot be inferred from a native receipt. Running work may outlive an observer. |
| B04 | Transport multiplicity is a diagnostic priority, not a proven leak | Per-server instance/source/process creation identity, definitive EOF teardown and retained unknown UUIDs. Controlled sequential and concurrent lifecycle fixtures. | No arbitrary PID cleanup, pooling or proof of real-client memory leaks. An earlier unexplained fixture failure is retained in verification. |
| B05 | Duplicate MCP text and history work are confirmed engineering costs | Concise text, complete structured content for small payloads, bounded immutable detail chunks for large payloads, async history scans/pages/deltas and independent-writer invalidation. | Metadata enumeration/stat remains O(N). Cold scans read retained payloads; the OS filesystem does not provide a cross-process snapshot transaction. No evidence is pruned. |
| B06 | Copied executed output may retain parent paths even with a correct child context | Named safe scalar selection; actual physical-root and effective local-path comparison with explicit unknown states. | This gate does not execute a producer, decode opaque objects or prove output producer/run lineage. Remote filesystem semantics and unsupported variables remain unknown. |
| B07 | Primary outcome and journal/publication can diverge | Earliest primary native error is retained separately from secondary I/O failures. Original immutable events are the recovery authority; bounded process-memory fallback is explicitly nondurable. | Missing receipts remain uncertain. Memory fallback disappears with process death. Directory fsync is not promised. |
| B08 | A stable revision/sample is insufficient for full-output proof | Native immutable table token on each page and final recheck; complete contiguous row coverage, keys/values digest, named constants and tie-aware binary accuracy/AUC. | Full output is separate from fresh inference. Metric semantics require exactly two nonnull classes and explicit positiveLabel. |
| B09 | Functional, visual and durable evidence had been conflated by callers | Preserve separate visual/functional/persistence quality dimensions and save/close/reopen tests. Actual image inspection and export are recorded separately in the verification receipt. | Model preview and viewport frames differ. Partial/offscreen/unconfirmed rendering cannot become visual PASS. Same-host reopen is not universal portability. |
| B10 | Strict contracts caused avoidable caller errors | Discoverable typed guide, installed contracts, concise error-specific next inspection, exact profile/history/table examples. | IDs, port types, nested scopes and expected:{} remain strict; caller mistakes are not silently coerced. |

Historical context-cap/release, typed preview, variable-resolved Reader behavior, immutable deduplication and original-operation recovery remain regression requirements. Earlier measurements and resolved defects were not counted as fresh v0.5 verification.

## Why this architecture

MCP remains the agent-facing interface because it provides discoverable schemas, structured results and actual image blocks. The CLI is useful for scripts, profile inspection and troubleshooting. Both use the same native filesystem IPC; a separate HTTP service would not solve the observed identity or payload issues.

The native worker remains serialized. More workers could invalidate scope/revision ordering and expose unsynchronized KNIME internals. Safe diagnostics read bridge-owned telemetry only. Cancellation is not placed into an unsafe parallel lane merely to meet an arbitrary latency target.

Async history makes long scans yield to Node while keeping disk authoritative. Cache entries contain metadata and digests, not reusable successful payloads. A selected record is freshly read and hashed. Observed additions, replacements, deletions, malformed/unreadable records and locks invalidate or fail the query. Selected same-stat replacement is detected by its fresh digest; invisible hostile changes to unrelated metadata between filesystem observations remain outside the guarantee.

Quality task writes within one store/task now serialize revision allocation and final assessment. Final context observation precedes the last evidence manifest, and the manifest includes an event digest. Observed same-revision additions invalidate an assessment. This is not an operating-system-wide transaction across independent writers.

## Performance interpretation

See [the measured receipt](VERIFICATION-0.5.md) and its JSON/CSV files. History responsiveness improved in the controlled Node fixture. Native instrumentation added work and response bytes in its production-boundary benchmark; it is not claimed to speed native processing. Controlled process teardown demonstrates owned transport behavior, not the cause of the user's host lag. Cold means a new store instance, not a flushed operating-system disk cache. Sampled memory peaks are not unsampled maxima.

## Explicitly unverified

- A causal reproduction or elimination of the original desktop lag.
- Real host UI frame/rendering delay, KNIME internal lock wait, active external Python model duration or cancellation interrupt latency.
- Every KNIME extension/node family, every operating system or a second-machine installation.
- Producer lineage or fresh inference inferred from cached output, a path gate, save acknowledgement or archive alone.
- Automatic cleanup of unrelated clients/processes, evidence pruning or hidden refresh of expensive producers.

Use the [migration guide](MIGRATION-0.5.md) for a deliberate switch and rollback. Existing installations are not silently replaced.
