# Observe routes, waiting stages and original outcomes

v0.5 distinguishes descriptor readiness, native bridge responsiveness, workflow state and host rendering. Its measurements establish specific bounded fixtures; they do not establish the cause of desktop lag or promise its elimination. Use [MIGRATION-0.5.md](MIGRATION-0.5.md) to select a named, pinned route and [VERIFICATION-0.5.md](VERIFICATION-0.5.md) for acceptance evidence.

## The 25-tool surface

Every tool accepts optional `resultMode:"compact"|"full"`. Unknown keys are rejected. This list groups the current catalogue by purpose rather than treating every read as equally lightweight.

| Tools | Purpose / important boundary |
|---|---|
| `knime_connection`, `knime_sessions` | Local filesystem descriptors; no native dispatch. Connection defaults to at most eight session summaries plus counts; `detail:true` requests full descriptor detail. |
| `knime_health`, `knime_diagnostics` | Native bridge response and bridge-owned telemetry; safe native read lane. Neither proves UI responsiveness. |
| `knime_describe`, `knime_core_call`, `knime_desktop_call`, `knime_gateway_call` | Discover installed contracts and invoke exact advanced operations. Advanced calls may have workflow or external effects. |
| `knime_context` | Bind, inspect, usage, release or prune exact authority bindings; no silent retargeting. |
| `knime_workflow`, `knime_settings`, `knime_nodes`, `knime_table` | Live snapshot, typed settings, factory search and bounded table pages. These can involve native work/locks. |
| `knime_settings_preview`, `knime_dependencies` | Detached settings validation and bounded effective dependency/path inspection; no producer execution or freshness inference. |
| `knime_table_verify` | Complete keyed table coverage with stable identity and optional named accuracy/AUC expectations; separate from fresh inference. |
| `knime_canvas_view`, `knime_layout_check`, `knime_layout_plan`, `knime_layout_apply` | Actual image evidence and guarded layout work. Capture/emission is not image review. |
| `knime_verify_workflow` | Track explicit completion dimensions and evidence; unsupported persistence/visual proof stays incomplete. |
| `knime_operation` | Read the original durable operation receipt locally, including after process shutdown. No replay. |
| `knime_history`, `knime_detail` | Async checked local history and complete-result chunks. No native dispatch or deletion. |
| `knime_wait` | Bound a read-only observation window; never repeat or cancel its triggering mutation. |

## Identify the configured instance first

Call `knime_connection {}` through the intended MCP alias. Inspect:

- `route`: selected profile/configuration source, Node source path/version/fingerprint.
- `runtime` and `canonicalRuntime`: configured and pinned real runtime roots.
- `sessionId`, `identity`, `pinnedIdentity` and `identityMatches`: native process/start/workspace/version/bundle/capability identity.
- `compatibility`: configured profile expectations and any mismatch; no named profile reports `unconstrained`, not an attested match.
- `readiness`: effective availability, process liveness and heartbeat freshness.
- `responsiveness`: the latest response/no-response observed by this client, or `not_probed`; it is not a fresh implicit health request.
- `lifecycle`, `tracing` and `sessionCounts`: owned server lifetime and bounded telemetry summaries.

Use `knime_connection {"detail":true}` for the full descriptor list. Follow with `knime_health {}` only when native dispatch to that route is intended. A session ID does not select a different runtime. Identity changes fail closed; inspect and create a new reviewed connection rather than letting the existing client follow a replacement.

## Observe the native queue without waiting for workflow locks

```json
{"requestId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","timeoutMs":2000}
```

Send this to `knime_diagnostics`, using an original operation UUID you actually received. Omit `requestId` for the overall bridge view. `session` is optional when the server/profile already pins it.

`bridge.diagnostics` reads bridge-owned synchronized metadata through the same native safe-read lane as `health` and native `operation.get`. It bypasses the serialized native worker and does not inspect a workflow under its root lock or marshal onto SWT. It still requires client selection, filesystem publication/polling and a live native process; it is not a transport-independent guarantee.

The result includes `clock:"native_process_monotonic"`, `queue.depth`, `queue.capacity:64`, `queue.oldestAgeMs`, `worker`, bounded counters, `retainedRequests`, `requestLimit:256` and explicit unmeasured stages. A requested entry has `available:false` when it is absent/evicted; that is not proof the request never ran.

Per-request metadata includes `requestId`, `operation`, `phase`, request/response byte counts, elapsed time and `durationsMs` for `queueWait`, `nativeCall`, `resultSerialization`, `journal` and `responsePublication`. A duration whose stage has not started is `null`; an in-progress duration is a current native-process observation. `publication.state` and `completionObserved` distinguish pending, published or failed response publication. A response carrying telemetry may precede its own completed publication; a later diagnostics or native receipt lookup can observe the publication state.

KNIME lock wait inside the native call, SWT/UI work, external-node work and host rendering remain unmeasured as separate stages. Do not label the whole `nativeCall` duration as queue delay, Python learner time or UI freeze.

`core.cancel` remains in the serialized native lane. A cancellation request can wait behind other work and native synchronization. Requested, queued or acknowledged cancellation is not verified terminal cancellation. No increased worker count, automatic cancellation or universal 500 ms cancellation guarantee is shipped.

## Keep the clocks and outcomes separate

| Clock owner | What it bounds / does not establish |
|---|---|
| Host MCP client | The host's request/delivery budget; the bridge cannot infer a native outcome from host expiry. |
| `client_ipc` | Total call budget from call entry, including selection, staging and filesystem response polling. The absolute `expiresAt` is fixed once, not reset at publication. |
| Native `expiresAt: queue/start only` | Native admission/start expiry; it does not force-cancel already running work. |
| `observer` | One `knime_wait` observation window; the scientific operation may still run after it expires. |
| `lifecycle_fixture` | Controlled harness initialization/EOF/failed-only cleanup bounds; these are not workflow timeouts. |
| External application/controller | Its independently governed model/resource deadlines; bridge success cannot override them. |

Monotonic elapsed times are meaningful within their own process. Correlate client/native entries with the original UUID. Do not subtract their unsynchronized wall clocks to manufacture queue or transport latency. Expiry strings are absolute deadline metadata, not evidence of synchronized clocks.

Client errors expose original `operationId`/`requestId`, `deadline.owner`, original `startedAt`/`expiresAt`, remaining budget, submission metadata and `state`. The legacy `outcome` field stays compatible while `state` adds distinctions:

| Observed state | Interpretation |
|---|---|
| `not_submitted` | This client did not publish this request; it is distinct from a published unknown result. |
| `publication_in_progress` | Recorded in lifecycle pending metadata when atomic publication has begun but its result is not established. |
| `submitted_outcome_unknown` | The request was published or publication was already in progress; lack of response does not establish zero effects. |
| `native_result_returned` | A validated native response arrived; receipt/journal, scientific completion, visuals and persistence still have their own evidence. |

Native receipts additionally describe acceptance/dispatch/status/publication. Keep those fields rather than inventing a single terminal success from an acknowledgement. A returned native failure's authoritative `outcome`, `nativeDispatch` and primary error are preserved even if secondary journal/publication diagnostics fail.

`knime_wait` supports `execution`, `saved`, `opened` and `closed`, with explicit `session` and `timeoutMs` from 1 to 60000. Except for `opened`, provide `projectId`; `workflowId`/`nodeId` apply only to execution. `opened` requires exact `origin:{providerId,spaceId,itemId}`. It returns `settled`, `failed`, `blocked` or `timeout`. Timeout includes `expiration:"observer_expired"`, an observer deadline and the latest available observation. Before another read, the helper checks the residual budget; it stops instead of submitting an unusably small secondary read or extending the total window. Tiny explicitly selected whole windows can therefore expire without another observation.

A `saved` wait observes `dirty:false` and reports `persistenceVerified:false`. An `opened` wait requires a corresponding loaded native model, not merely a restored tab. A screenshot, execution acknowledgement or clean dirty flag does not prove complete functional, visual, persisted or exported evidence.

## Reconcile the original UUID locally

After a timeout, lost response or EOF, preserve the original runtime, session and UUID. Send this exact shape to `knime_operation`:

```json
{"sessionId":"ORIGINAL-SESSION-ID","operationId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}
```

Use the UUID from the original error/receipt, not this example value. The tool reads confined local durable aggregate/events and does not send a new native request, retry, replay or cancel a workflow action. It can recover a newer durable event when an aggregate is absent, stale or locked. Native `operation.get` is a different live request; it must not be confused with this local recovery path.

`OPERATION_NOT_FOUND` is uncertainty, not proof of zero effects. Nonterminal queued/running/dispatching receipts from an unavailable/replaced process become `unknown_after_restart`. Retention expiry does not imply cancellation or erase known status. A new execute UUID is not a reconciliation recipe. Preserve native UUID/payload guards: identical explicit redelivery remains a protocol capability, but changed command meaning under a reused UUID is rejected and no automatic redelivery is performed.

## Opt into client traces without raw payloads

Start a server with tracing and a distinct lifecycle receipt:

```powershell
& 'C:\Tools\nodejs\node.exe' 'C:\Tools\knime-agent-bridge-v05\knime-agent-bridge\src\server.mjs' --profile trial-v05 --profiles-file 'C:\Tools\knime-agent-bridge-v05\knime-agent-bridge\profiles.json' --trace-directory 'C:\Tools\knime-agent-bridge-v05\knime-agent-bridge\runtime-v05-trial\traces' --lifecycle-file 'C:\Tools\knime-agent-bridge-v05\knime-agent-bridge\runtime-v05-trial\lifecycle-trial.json'
```

MCP stdout is protocol output; send diagnostics to the configured trace/lifecycle files. Client traces retain the original UUID, route/session identity, absolute deadline, submission/outcome, monotonic stage events and counts for polls/request bytes/result bytes/dropped events. They do not record raw args, table contents, results or credentials. They still contain local runtime/workspace identities; review and sanitize them before sharing.

Default client trace event capacity is 100 per call; the programmatic constructor accepts `traceMaxEvents` from 1 to 1000. New artifacts are refused once the directory already contains 128 `client-trace-*.json` files; old evidence is not deleted. This check is not a cross-process quota reservation, so simultaneous writers can exceed that nominal directory threshold. Event truncation leaves bounded counters and a dropped-event count. Trace write/budget failure is reported as unavailable and must not replace the original operation outcome.

Error metadata exposes `details.trace` with original UUID/path/SHA-256/byte count, or an unavailable reason. When tracing is enabled, direct native JSON results expose `_clientOperation.trace` in MCP/CLI output, tied to that exact call's original UUID; compact summaries preserve it. Successful JavaScript result objects also carry the nonenumerable `CLIENT_OPERATION` symbol, and `client.traceReferences` is keyed by UUID. A wrapper performing several native calls may not expose one aggregate client trace; inspect its constituent error/receipt identities and the configured trace directory. No shared `lastTraceRef` supplies authority for concurrent calls.

The client trace explicitly lists native queue/work and host rendering as unmeasured. Read native diagnostics separately for its own monotonic stages. A directory scan or synchronous source function alone does not prove the user's observed lag was caused by the bridge.

## Retrieve complete compact results

For MCP, read `structuredContent`. The text content is a bounded summary. Above 128 KiB, default compact formatting stores a complete JSON payload and returns `detailAvailable:true`, `detail` and `payloadBytes`. Every tool accepts `resultMode:"full"` to keep the full structured payload inline; it does not restore duplicated full JSON text.

The detail reference contains an ID, full UTF-8 JSON SHA-256, byte count and a `nextCall` for `knime_detail`. Storage is bounded to 32 MiB per payload. Files are flushed, closed and hash-verified; the directory itself is not fsynced, so do not equate that receipt with universal crash-proof directory durability. Failure to preserve detail returns `detailAvailable:false`/`detailFailure` and preserves original error/operation identity when available.

First chunk request:

```json
{"id":"bbbbbbbb-cccc-dddd-eeee-ffffffffffff","offset":0,"limit":16000}
```

Use the returned detail ID. `limit` is 1–16000, default 16000; `offset` is a nonnegative safe integer. Each result includes `text`, `offset`, `nextOffset`, `hasMore`, `totalCharacters`, `bytes`, `sha256` and `offsetEncoding:"UTF-16-code-units"`. Continue with the returned `nextOffset`, preserve one ID/hash, concatenate strings in offset order, then SHA-256 the complete **UTF-8 encoding** before parsing JSON. UTF-16 offsets are not byte offsets; a chunk can split a surrogate pair. Every chunk revalidates current file integrity and exact confinement.

In JavaScript, after collecting chunks:

```js
import {createHash} from 'node:crypto';
const json = chunks.map(chunk => chunk.text).join('');
if (createHash('sha256').update(json, 'utf8').digest('hex') !== reference.sha256) {
  throw new Error('Complete detail SHA-256 mismatch');
}
const completePayload = JSON.parse(json);
```

For table output, prefer native pages of at most 1000 rows and preserve `expectedTableIdentity` after the first page. `knime_table_verify` can check complete keyed coverage within `pageSize:1..1000`, `maxRows:1..1000000` (default 100000) and an explicit timeout. It verifies named expectations and a final identity recheck; it does not execute/reset a producer or infer fresh inference from cached bytes. Native export remains separately investigated; no universal port export or portability claim follows.

## Page retained history and handle invalidation

First page:

```json
{"action":"page","kind":"table-verification","limit":50,"metrics":true}
```

`kind` is optional, and `limit` is 1–200, default 50. `metrics:true` adds counts for enumerations, files enumerated, stats, reads, bytes read, cooperative yields and elapsed milliseconds. Pages contain metadata `items` with `id`, `recordKind`, `recordedAt` and `digest`; they do not embed all evidence payloads. Ordering is recorded time then ID.

Follow `nextCursor` with the same `kind` and, if present, the same `baseDigest`; `limit` can remain 50:

```json
{"action":"page","kind":"table-verification","limit":50,"cursor":"RETURNED-CURSOR"}
```

The returned `snapshotDigest` identifies the checked metadata observation. Cursors are process/store-local, expire after five minutes by default, and are bounded to 128 retained tokens. Restart/reconnect, expiry, changed query, lost retained state, or observed add/replace/delete can invalidate them. `STALE_HISTORY_CURSOR` requires a fresh first page; do not continue a partial old page sequence as a complete current snapshot.

Request an exact payload with only its ID:

```json
{"action":"get","id":"RETURNED-EVIDENCE-ID"}
```

Do not add `kind`, `limit`, `cursor`, `baseDigest` or `metrics` to `get`. Its payload is freshly checked from disk, including digest and identity; compact MCP formatting may subsequently return a `knime_detail` reference.

For a delta from a previously returned 64-character lowercase SHA-256 `snapshotDigest`, submit:

```json
{"action":"page","kind":"table-verification","limit":50,"baseDigest":"PREVIOUS-SNAPSHOT-DIGEST"}
```

When that base is retained for the same kind, `mode:"delta"` items carry `change:"added"|"changed"|"removed"`. `totalCount` counts the delta items, not the entire store. Continue a delta with both its cursor and the same base digest. If a usable base is not retained, a fresh first query returns `mode:"full"` with `baseUnavailable:true` where safe; losing a base midway invalidates continuation rather than silently changing its meaning.

Default history bounds are 100000 scanned JSON records, 8 MiB per evidence record, 16 MiB for selected aggregate results, eight retained snapshots sharing a 16 MiB snapshot budget, batches of 32 with cooperative event-loop yields, and a five-minute cursor TTL. A too-large scan fails explicitly; a large selected result should be paged/retrieved by ID. Immutable record tampering, kind replacement, missing records, access denial or a record/directory changing during a checked scan fail rather than returning an earlier successful payload. This is checked filesystem observation, not a filesystem-wide transactional lock. Page/query cursors do not authorize deletion or evidence replacement.

## Owned server lifetime and the measured limits

Each stdio server instance has a UUID, own and parent PID plus OS creation identity, loaded Node client/server source version/hash, route/profile, start/end reason, bounded activity counters and memory observations. If OS creation lookup is unavailable, identity is explicitly unknown; a numeric PID alone is not ownership proof. Intentional independent concurrent clients remain supported.

On definitive stdin EOF, this instance synchronously closes its client's publication/observation gate before awaiting lifecycle I/O. A staged request cannot newly publish during delayed receipt persistence. An atomic rename already in progress may still complete: its original UUID is retained as `publication_in_progress` with unknown outcome. Published requests and durable journals are left intact; no native cancellation or KNIME/arbitrary PID kill occurs. Pending EOF receipt entries are capped at 64 with `pendingTruncated` indicating omitted entries. Receipt I/O can fail; absence of a final receipt does not establish a known native result or zero effects.

The final Windows qualifier used one uniform final v0.5.0 client/server source identity for **100 sequential connections plus three concurrent clients**: **103/103**, zero owned children remaining. EOF p95 was **30.624 ms**, maximum **34.627 ms**. The final client captures each call's exact receipt; concurrency regressions verify overlapping result/receipt/trace UUIDs. A separate instrumented **13/13** probe and an earlier pre-receipt-repair 103 run are published with their own hashes. Earlier final-client qualification attempts stopped on unavailable OS creation identities; they remain failures and are not folded into the later passing run. Fixture deadlines were 10 seconds for initialize, five seconds for EOF, and an immutable five-second failed-only cleanup grace. These are measured disposable server lifetimes, not native workflow cancellation or UI responsiveness guarantees. Fresh-process RSS is not additive physical RAM and does not constitute a same-process/native soak.

An earlier uniform attempt stopped at iteration 56 with an incomplete connected receipt; that attempt did not qualify, and its exit cause remains unknown because its original harness omitted detailed exit diagnostics. Its evidence is preserved separately. Later qualified runs and the improved failure harness do not retroactively explain that event. See [VERIFICATION-0.5.md](VERIFICATION-0.5.md) for final source identities, commands, counts and separate unverified boundaries.

The final client's later identity-unavailable attempts failed at sequential iterations 22, 3 (small probe) and 19. All failed children received EOF and bounded cleanup reported zero remaining. Ten sequential plus three concurrent connections in the instrumented probe returned valid OS identities in 399–1,410 ms, without reproducing the failures. Their underlying cause remains unknown; an unavailable identity never becomes ownership permission.
