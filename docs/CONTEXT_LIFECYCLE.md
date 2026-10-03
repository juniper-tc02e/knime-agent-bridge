# Immutable native context lifecycle (v0.4.0)

A context identifies one bridge process and, when supplied, one exact loaded project/root/scope model. It never follows the active tab or a replacement model. Reopening the same workflow with a replacement model requires a new binding.

The native registry has a hard cap of **1,024 active bindings per session**. Capacity checking and insertion are one synchronized operation, including concurrent binds. Bind does not deduplicate clients: two clients binding the same model receive independent IDs, and releasing one leaves the other usable. No TTL, LRU or live-model eviction runs automatically. Refresh with `context.inspect` instead of repeatedly binding.

## Native operations

These examples use the shared client pinned to the intended runtime/session.

```js
const context = await client.call('context.bind', {projectId, workflowId: 'root'});
await client.call('context.inspect', {contextId: context.contextId});
await client.call('context.usage', {});

// This deliberately revokes this exact binding, even if its project has closed.
await client.call('context.release', {contextId: context.contextId});

// Reclaim only bindings whose model is provably closed, unloaded, removed or replaced.
await client.call('context.prune', {});
```

`context.usage` and `context.prune` accept only `{}`. `context.release` requires a nonempty string `contextId` and accepts no other arguments. Release never chooses the active context or releases a project-wide group. Unknown, foreign-session, already released and pruned IDs fail with `CONTEXT_CHANGED`; repeated release is deliberately not reported as a second success.

These operations update the in-memory authority registry only. They do not need workflow revision preconditions, create workflow commands, modify loaded workflows or delete historical client quality/evidence files. A release revokes authority; it does not cancel a workflow effect that already passed its final guard or a native asynchronous job already scheduled.

### Usage telemetry

`context.usage` returns:

```json
{"sessionId":"...","active":922,"cap":1024,"remaining":102,"warningAt":922,"warning":true,"status":"warning","guidance":"..."}
```

Bind and inspect also include this snapshot under `usage`. `warning` starts at 922 retained bindings (90% rounded up), before capacity exhaustion. `status` is `ok`, `warning` or `full`. The counts are atomic registry observations; other clients can bind/release immediately after the response. `active` counts retained bindings, including invalid ones awaiting explicit pruning, rather than promising that all retained models remain usable.

A bind at capacity fails with structured `CONTEXT_LIMIT`, with this usage object in its error details. Explicit release or successful invalid-model pruning frees slots. New bindings always receive new IDs; released IDs never retarget. A per-registry random UUID prefix and monotonic 62-bit suffix guarantee no reuse during that registry's lifetime without retaining an unbounded list of tombstones. Identity sequence exhaustion fails closed.

### Release result

```json
{"contextId":"...","released":true,"usage":{"active":921,"cap":1024,"remaining":103,"warningAt":922,"warning":false,"status":"ok","sessionId":"..."}}
```

Registry removal is atomic. Every `require`, inspect return and final mutation `validate` rechecks membership. A context released before the final apply-time validation completes fails closed, including release during revision reads. Dispatch-only/unguarded native paths retain their previously documented weaker coverage; registry release cannot undo an already dispatched command.

### Prune result and bounded observation

```json
{"checked":12,"removed":3,"removedContextIds":["..."],"retained":7,"skipped":2,"complete":false,"lockWaitMs":0,"budgetMs":250,"usage":{"active":9,"cap":1024,"remaining":1015,"warningAt":922,"warning":false,"status":"ok","sessionId":"..."}}
```

Prune snapshots at most 1,024 bindings, performs model observations outside the registry monitor and removes only the same binding observed. It never holds the registry monitor while waiting on a workflow lock, so explicit release and bind cannot deadlock against cleanup. Concurrent release can make `checked` exceed `removed + retained + skipped`; concurrent bind is outside that call's snapshot.

Project/root identity is checked before and under the original model's lock. Locked models are skipped with zero lock wait. Removed or replaced nested scopes are checked by exact Java object identity under that lock. Scope scans have a 10,000-visit limit, nesting limit 128 and shared cooperative 250 ms prune deadline. Scope presence that cannot be proven within these bounds, lookup failures and exceptions are retained as unknown. Session-only contexts are retained because they have no project model to become invalid. `complete:false` means there were unknown/skipped observations; retry inspection/prune when the model is observable or explicitly release an owned ID.

Bind, require and inspect use the native reentrant lock with a zero-wait admission check and return `CONTEXT_BUSY` on contention. Native scope verification also fails closed with `CONTEXT_BUSY` if its bounded scan is incomplete. The 250 ms budget bounds cooperative traversal, not arbitrary time spent inside installed KNIME methods or lock-close notification processing. No worker thread is abandoned and no native operation is cancelled to enforce a wall-clock deadline.

## Integration contract

`ContextAccess` provides these package-visible methods to `BridgeActivator`:

```java
ObjectNode usage(JsonNode args)
ObjectNode release(JsonNode args)
ObjectNode prune(JsonNode args)
```

Dispatch `context.usage`, `context.release` and `context.prune` to those methods. Classify all three as non-workflow operations in `OperationPolicy.READS`; lifecycle methods validate their own exact argument shapes. MCP `knime_context` should expose `usage`, `release` and `prune` actions; only release needs `contextId`. Preserve existing context, quality-task and evidence store files when performing these actions.

## Verification and limits

Run `node --test tests/context-lifecycle.test.mjs`. The first test compiles and executes the actual pure Java registry: exact cap/warning boundaries, 32 concurrent bind workers, independent bindings, slot recovery without ID reuse, conservative invalid/unknown cleanup and release/bind during an in-progress observation. The second compiles and executes the actual `ContextAccess` against synthetic KNIME boundary classes and the installed Jackson jars: structured usage/cap errors, strict release arguments, release before/during final validation, release during inspect, closed/replaced root and scope models, locked/failed observations and session contexts. Historical evidence bytes are retained during lifecycle calls. These are executable behavior tests, not regex assertions on source.

The harness uses Java 21 target bytecode and the configured `KNIME_AGENT_JDK` (Windows default `C:/Program Files/Java/jdk-24`) plus Jackson from `KNIME_HOME` or the default local installation. It never launches KNIME or mutates any active runtime. Fresh-process acceptance remains necessary to verify the installed lock/model API, dispatch schemas and MCP responses. A new JAR cannot change the registry in an already running exhausted v0.3.1 process; save/close/relaunch is a separate upgrade step.

Context exhaustion establishes an unreleased registry-capacity defect. It does not, by itself, establish a cause for a KNIME UI hang.
