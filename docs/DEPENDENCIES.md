# Effective model settings and dependency inspection

`knime_dependencies` is read-only and requires `projectId` and `nodeId`. Set `workflowId` to the node's immediate component/metanode scope. It never broadens a nested request to the root workflow.

```json
{"projectId":"loaded-project","workflowId":"root:7","nodeId":"root:7:3","maxNodes":2000,"maxVariables":100,"includeEffectiveSettings":true}
```

The native operation is `dependency.inspect`; use the MCP tool or CLI `tool knime_dependencies --args-file request.json`. It returns native/gateway identities, revisions, node state, upstream connection port IDs, upstream states, bounded available variable names/types/scalar values and stored `used_variable` bindings.

For a native single-node container, `effectiveModelSettings` calls `SingleNodeContainer.getModelSettingsUsingFlowObjectStack`. `status:native_resolved` means KNIME returned a typed model envelope with variable substitutions. `unavailable`, `not_requested` and `unsupported_container` are different outcomes; an unresolved fallback must never be advertised as the effective value. Protected settings and credential variables are redacted. Other custom variable values are opaque, rather than arbitrary string serialization.

The node's native flow-object stack is observed at read time. No upstream node is executed, no file is opened by the bridge and no producer is rerun by this operation. Cross-scope dependencies are not followed; maxNodes/maxVariables or the 20,000-connection bound may truncate coverage. Relevant revisions omit protected settings, progress and full table values as before.

For a UUID-specific Reader, compare the native resolved path and variable binding to the requested UUID, then verify the executed table's full row count, schema, row-key uniqueness and UUID column through stable paged reads. Re-read the table identity and revisions at the end. Missing variable resolution or an older file's data must fail your run check. A title, accepted execution, stored fallback or first page cannot establish complete current-run output.

Changing a relay and executing its downstream Reader can preserve an already executed expensive producer. Verify that producer's table identity and settings independently; lineage reports `producerDataFingerprint:not_read`. The bridge does not validate model-study science or authorize rerunning a learner.
