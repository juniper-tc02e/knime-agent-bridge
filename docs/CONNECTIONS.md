# Connection identity and reconciliation

Each `BridgeClient` resolves one absolute runtime directory at construction. An explicit `--runtime` selects that directory; otherwise `KNIME_AGENT_RUNTIME` or the adapter's default applies. Session IDs select only directories under that runtime. Supplying an ID from a different runtime returns `NO_SESSION`; no search outside the selected runtime, newest-PID fallback or restart rerouting occurs. Use a new client/CLI/MCP process with the correct runtime to change this startup boundary.

The runtime's canonical filesystem location is pinned when first resolved. An initially linked runtime is supported, but replacing that link with another root fails with `RUNTIME_IDENTITY_CHANGED`. Session discovery, metadata, request/response queues and individual response files must resolve to their exact canonical runtime/session locations. Junctions/symlinks redirecting these paths elsewhere (including another session inside the same runtime) are rejected before use. Checks run before staging, before publication and during response reads. Cleanup also revalidates the path; if a staged directory moves, the abandoned `.tmp` can remain in that old directory rather than deleting a same-named file through a replacement link. These filesystem checks are bounded observations, not an atomic transaction against malicious concurrent filesystem changes.

`listSessions()` adds `runtime` to each descriptor. `reportedStatus` is the descriptor's claim, while `status`/`effectiveStatus` also account for heartbeat age and PID availability. `alive:true` means eligible for a request; it does not establish a responsive native queue, a dialog-free UI or workflow completion.

## Descriptor-only diagnosis

```js
const client = new BridgeClient({runtime: 'C:/isolated-runtime', session: 'session-id'});
const connection = await client.connectionDiagnostics();
// Optional session override is restricted to the same runtime:
const other = await client.connectionDiagnostics({session: 'another-session-id'});
```

`connectionDiagnostics({session} = {})` never publishes an IPC request. It returns:

- `runtime`, `requestedSessionId`, `sessionId`, and the discovered `sessions` in this runtime.
- `canonicalRuntime`: the pinned real filesystem runtime location, or `null` if it does not yet exist.
- `identity`: PID, `startedAt`, workspace, bridge/KNIME versions, `bundleFingerprint` and `capabilityFingerprint`. A missing legacy field is `null`, rather than invented or verified.
- `pinnedIdentity` and `identityMatches`: the identity first used for requests to that session and its comparison with the current descriptor. Before first use, the pin/comparison is `null`.
- `readiness`: descriptor readiness, effective/reported status, process availability, heartbeat freshness and an unavailable reason.
- `responsiveness.status`: `not_probed`, `responded` or `no_response`. A response/timeout is historical evidence with `observedAt`, original `operationId` and operation name. A changed identity resets the reported observation to `not_probed`; diagnostics do not probe it. Call native `health` explicitly when a live response is needed.
- `selectionError` for an absent, empty or ambiguous selection. An explicitly selected unavailable descriptor remains inspectable through `readiness`.

The first submitted call pins the default session and that session's process identity. Later explicit session overrides remain supported within the same runtime and independently pin their identities. Changes to PID, start, workspace, versions, bundle or capability fingerprint cause `SESSION_IDENTITY_CHANGED` before publishing another request. Heartbeat/status changes never retarget the pin. The identity is checked when selecting and again immediately before the staged request is renamed into the queue. These checks observe descriptors; they are not OS process-start attestation, an atomic transaction with KNIME, or a defence against a malicious writer changing metadata immediately after the check. Native context guards remain necessary for mutations.

## Submission, transport expiry and native completion

Successful `client.call()` keeps its existing native result contract. Transport identity is available in `client.lastOperation`; response receipts are in `client.lastReceipt`. Both are cleared when a new call begins, so a rejection before publication cannot attribute an earlier receipt to the new call. Transport/native errors carry the resolved `runtime`, original session/operation IDs, pinned identity and:

```json
{
  "outcome": "unknown",
  "submission": {
    "state": "published",
    "publishedAt": "2026-10-03T01:00:00.000Z",
    "expiresAt": "2026-10-03T01:00:30.000Z"
  },
  "reconciliation": {
    "runtime": "C:/isolated-runtime",
    "sessionId": "original-session-id",
    "operationId": "original-operation-uuid",
    "action": "operation.get",
    "readOnly": true,
    "resubmits": false
  }
}
```

Failed publication has `outcome:"not_submitted"`. A transport timeout has `outcome:"unknown"`: request expiry can reject a request before native acceptance, but cannot cancel an accepted job or prove that a mutation did not run. The client leaves the request for the bridge and performs no automatic retry/cancellation. Native asynchronous acknowledgement (`completionVerified:false`) likewise requires observation of native state/data and independent persistence evidence.

If a native error includes journal uncertainty, its `journalError`, dispatch details and receipt are preserved in the error. `nativeDispatch` describes whether a native call started/returned; it does not classify an operation as a mutation. Discovery and other read-only failures must remain read-only when callers interpret these fields.

## Reconcile the original operation

Read the durable receipt with `knime_operation` / CLI `tool knime_operation --args-file request.json`, using the **original** runtime, session and operation UUID. At the JavaScript boundary:

```js
await readOperation(client, {sessionId: originalSessionId, operationId: originalOperationId});
```

This reads the local journal without native submission, including after the original process stops. The newest validated immutable full event wins over a missing/stale or Windows-locked aggregate. Linked journals outside the selected runtime/session are rejected. The replay response payload is omitted. Results add the runtime and reconciliation guidance; nonterminal records return `outcome:"unknown"`. An unavailable/replaced process changes a nonterminal public `status` to `unknown_after_restart`, preserving its `recordedStatus` and the reason. This status is uncertainty, not proof of an actual restart or successful completion.

Receipt `expiresAt` is the journal's retention deadline, distinct from the request's transport expiry. `retention` reports its deadline/pin/expired state and `cancellationImplied:false`; it does not discard a readable receipt or change a known applied result to cancelled. Missing records (`OPERATION_NOT_FOUND`) are also not proof that an unrecorded legacy action never ran. Inspect native state before deciding on a separate new action.

Native journal UUID deduplication is authoritative: an identical explicit redelivery may replay its accepted receipt without repeating effects; changed operation/args/precondition with the same UUID is `OPERATION_ID_REUSED`. Transport expiry is excluded from request identity. A bounded 1,024-entry digest history also catches altered reuse early within the same client/session. That convenience does not establish identity across client restart/history eviction; the native journal provides that guard. Reconciliation uses `readOperation`/`operation.get` and never redelivers.

## Verification limits

`tests/connection-lifecycle.test.mjs` uses independent temporary filesystem runtimes and synthetic IPC only. It covers cross-root rejection (including a linked journal), replacement identity before/during publication, heartbeat updates, timeout effect count, late receipt reconciliation, read-only journal uncertainty and explicit same/altered UUID behavior. Existing `tests/operations.test.mjs` exercises an actual Windows exclusive aggregate lock with durable-event fallback. These adapter tests establish neither real KNIME compatibility nor native side-effect deduplication; native acceptance tests provide that separate evidence.
