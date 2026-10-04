# Native core operations

Target: installed KNIME Analytics Platform 5.12.0, Java 21. `CoreAccess` looks up the already loaded gateway `ProjectManager` project. It does not load another copy of a workflow or edit workflow XML. Port and node data are read under the workflow lock. Execution methods schedule KNIME jobs and never wait for those jobs under the lock.

## v0.5 complete output and workflow export

`core.table.read` accepts `expectedTableIdentity` from the first page. Replacement is rejected under the workflow lock before rows are accessed. Responses include the exact source node/scope/port, all four revisions, immutable table token and explicit cached/freshness flags. `knime_table_verify` supplies bounded complete row/key/value coverage, named constants and optional binary metrics; it never executes nodes and leaves fresh inference unverified. See [OBSERVABILITY-0.5.md](OBSERVABILITY-0.5.md).

`core.workflow.export` invokes the installed **org.knime.core.node.workflow.WorkflowExporter.exportInto** to create a fresh native `.knwf`. This is distinct from port export. Its only target is an already loaded **local project root**. Do not supply `workflowId`, `nodeId`, `path` or an arbitrary source/destination. It requires a current context precondition with structure/configuration/layout/execution revisions, refuses a dirty or executing root, and never saves/resets/executes implicitly.

Example arguments for `knime_core_call`, after explicitly saving and observing the intended root:

```json
{
  "operation": "core.workflow.export",
  "args": {"projectId": "DISCOVERED-PROJECT-ID", "excludeData": false, "maxBytes": 134217728, "maxEntries": 20000},
  "precondition": {"contextId": "BOUND-ROOT-CONTEXT-ID", "expected": {"structure": "CURRENT", "configuration": "CURRENT", "layout": "CURRENT", "execution": "CURRENT"}}
}
```

Replace every target/revision placeholder with observed values; the strings `CURRENT` are not valid current revisions. Discover the installed contract through `core.describe` before submitting an advanced call.

The bridge chooses `runtime/exports/<new UUID>.knwf`, rejects links/junctions and existing destinations, bounds source/output bytes and archive entries, and verifies source identities plus full archive entry SHA-256 manifests. Default/max bytes are 128/512 MiB; max entries 20,000; source depth 64. Source bounds apply before data exclusion. Windows file identities use the installed JNA native API when Java fileKey is unavailable. Protected runtime/parent/directory/temp identities are checked; cleanup never deletes a replacement file or an unconfirmed published target.

Successful export reports forced/closed/hash-verified file durability and `directoryDurability:"not_fsynced"`. Full manifests may use a compact detail reference. Filesystem changes after the final check remain possible; verify the artifact SHA-256 again when consuming it. `excludeData:false` includes available saved cached resources; exported bytes cannot certify fresh inference or portable external checkpoints/files/runtimes. Native exporter verification, persistence and actual canvas review are separate facts.

## Identifiers and shared arguments

Graph operations require `projectId`, obtained from the gateway/desktop project operations. The optional `workflowId` selects a nested component or metanode. The optional `nodeId` selects a node within that workflow; omitting it selects the workflow itself. Use the full native IDs returned by `core.snapshot` (for example `0:3:7`). Relative IDs and `root` are accepted as conveniences. Full IDs outside an explicitly selected workflow are rejected; resolution never falls back to an unrelated root node. A missing or unloaded project is rejected.

Top-level argument names and types are checked before project lookup. Unknown keys, null/blank/non-string targets and missing required arguments are rejected. Omit an optional target intentionally to select the workflow; a misspelled `nodeID` or `workflowID` cannot silently broaden an execution/reset. Settings patches always require an explicit `nodeId`.

Port indices are **native KNIME indices**: the implicit flow-variable port is normally index `0`; the first data port is normally index `1`. Read the node's `outputPorts` instead of guessing. Repository port details return both the repository index and corresponding `nativeIndex`.

`core.describe` takes `{}` and returns operations, limits, encodings, limitations, and a `contracts` map with each operation's structured JSON Schema parameters, required arguments, and descriptions.

## Snapshot

`core.snapshot` takes shared graph arguments plus `depth` (default `1`, range `0..8`), `maxNodes` (default `2000`, range `1..10000`), and `includeSettings` (default `false`).

The selected node/workflow includes its full `id`, project-relative `gatewayId` (`root:1`, for example), name/label, kind, factory ID for native nodes, state, dirty flag, progress, messages with child errors, position, annotation, input/output port metadata, and available execution actions. Workflows include `nodes`, `connections`, and `annotations`. Child components/metanodes have `nestedWorkflowId`; their `workflow` expands through the requested depth. Depth zero still includes the selected workflow's immediate nodes and connections. Truncation is explicit through `childrenTruncated`, `omittedNodes`, or `connectionsTruncated`.

Snapshots read live state. They do not promise consistency with a previous request; execution and UI activity may change it between calls. `includeSettings` returns protected-value-redacted settings and can create large responses.

## Typed settings

`core.settings.get` takes shared arguments selecting a node and returns `{projectId,nodeId,state,applied:false,settings}`. The settings view preserves the native envelope:

Starting with `0.2.0-beta.2`, it also returns `settingsValidation`: serialization/validation status, `validForSave`, the model settings source and bounded error details. Native snapshots expose this status even without `includeSettings`. A node can be `CONFIGURED` or `EXECUTED` while its settings are incomplete. Native execution and desktop save reject detected invalid settings with `NODE_SETTINGS_INVALID` and `nativeDispatch:"not_started"`. This checks model settings; custom view settings and exact saved-file reopen behavior still need separate verification.

The KNIME 5.12 adapter reads the stored envelope and invokes the protected model serializer directly only when defaults must be generated. This observes errors that KNIME's public wrapper otherwise logs and swallows. Failed serialization returns partial typed settings for an explicit repair; it does not mark the node valid or repeatedly emit the same KNIME error through revision polling. Complete all missing fields in a typed patch, then re-read validation. No model-specific defaults are silently invented.

```json
{
  "key": "node_settings",
  "type": "config",
  "entries": [
    {"key":"model","type":"config","entries":[
      {"key":"count","type":"xint","value":3},
      {"key":"seed","type":"xlong","value":"9007199254740993"}
    ]}
  ]
}
```

`core.settings.patch` additionally requires `patches`, an array of `1..1000` edits. A path is an array of exact keys relative to the root settings group. Existing entries retain their types; omit `type` to reuse an existing scalar type. New keys require an explicit type. Missing parent groups are rejected unless the individual edit contains `createParents:true`.

```json
{
  "projectId":"project-id",
  "nodeId":"0:3:7",
  "patches":[
    {"path":["model","count"],"type":"xint","value":3},
    {"path":["model","seed"],"type":"xlong","value":"9007199254740993"},
    {"path":["model","labels"],"type":"stringArray","value":["alpha","",null]}
  ]
}
```

Supported scalar types: `xstring`, `xboolean`, `xbyte`, `xshort`, `xint`, `xlong`, `xfloat`, `xdouble`, `xchar`. Supported native array setters: `stringArray`, `booleanArray`, `intArray`, `longArray`, `doubleArray`. Arrays appear as KNIME's native config groups when read; setters update their native representation. Existing arrays must retain their element type. Arbitrary group replacement/removal is not supported. `xlong` values are returned as decimal strings to avoid JavaScript precision loss. Nonfinite floats are strings `NaN`, `Infinity`, or `-Infinity`; numeric overflow is rejected. String null and empty string remain distinct.

Password and transient entries, and conservatively identified credential/secret keys, return `{key,type,redacted:true,editable:false}` without values. Patches cannot target those entries or traverse protected groups. The actual values remain untouched in the full native settings snapshot passed back to KNIME.

Edits are applied to the detached full `getNodeSettings()` envelope. KNIME's `loadNodeSettings` validates it before resetting/reconfiguring the node and successors. Type/range and validation errors are returned; they are not reported as successful configuration. Read the returned `state` and a new snapshot for node configuration messages. Core settings mutations do not create gateway undo entries. Use gateway editing commands when undo support is required.

## Execution control

`core.execute`, `core.reset`, and `core.cancel` take shared graph arguments. Execute schedules the selected node and dependencies, or the whole selected workflow. Reset resets and reconfigures the selection and affected successors. Cancel requests cancellation. The return value includes `accepted`, current `state`, and `completionVerified:false`.

Poll `core.snapshot` for resulting states/messages; an accepted command does not establish successful execution. Workflows with external side effects must be authorised by the caller before execution.

The MCP/CLI tool `knime_wait` can perform this bounded polling. Supply the explicit `session`, `condition:"execution"`, `projectId`, and optional `workflowId`/`nodeId`. It returns `settled`, `failed`, `blocked` or `timeout`; it never executes, retries or cancels a command. `timeoutMs` is bounded to 60 seconds. A `saved` wait checks the root dirty flag and explicitly returns `persistenceVerified:false`.

## Tables and ports

`core.table.read` takes shared arguments, `portIndex` (default `1`), `offset` (default `0`, nonnegative number or decimal string), `limit` (default `100`, range `1..1000`), and optional `columns` (unique names or zero-based indices, returned in requested order).

The output includes `schema`, `rows:[{key,values}]`, `totalRows`, `offset`, `nextOffset`, and `hasMore`. Counts/offsets are decimal strings. Missing cells are JSON `null`, distinct from empty strings. Booleans and integers are native JSON values; long cells are decimal strings; double cells are numbers or special-value strings. Collections are recursive arrays within depth/item limits. Unsupported types return explicit `{opaque:true,type,display,truncated}` objects rather than invented data. A schema entry records its original index, name, KNIME type, cell/value classes, and encoding. Paging beyond the end returns no rows and `hasMore:false`. Unexecuted or nontable ports are rejected.

`core.port.inspect` takes shared arguments and `portIndex` (default `0`) and reports output type, spec/data availability, summary, and table schema/row count when available. It is read-only and rejects a `path` argument. It does not serialize arbitrary Java object internals. Input port types are available through snapshots.

`core.port.export` requires a `path` and exports the selected native port object using KNIME's serializer. Buffered tables use KNIME's table archive serializer and return `exportFormat:"knime-table"`; other registered port serializers return `exportFormat:"knime-port-object"`. The path must have an existing parent directory, and an existing destination is never overwritten. Serialization completes in a temporary sibling file before the destination is created; failures clean up that temporary file. Known credential/secret port classes and unregistered serializers are rejected. Native exported files may contain the actual user data held in that port and are not a redacted table preview.

## Installed nodes

`core.nodes.search`: `{query:"Table Creator",offset:0,limit:50,includeHidden:false}`. Limit is `1..500`. Search matches names, factory IDs, categories, and keywords. `includeHidden:true` includes deprecated/hidden nodes too. Returns `nodes`, `total`, and paging metadata. First use may take time while KNIME initializes its installed-node index.

`core.nodes.details`: `{factoryId:"org.knime.base.node.io.tablecreator.TableCreator3NodeFactory"}`. Returns metadata, input/output ports, and native XML documentation if available. Inspect settings on an instantiated node for actual configuration values: configuration depends on the implementation and current input data. Unavailable documentation is explicitly marked.

## Verification scope

`tests/native-core.test.mjs` runs real discovery, structured-contract, and missing-project checks. Optional `KNIME_CORE_TEST_PROJECT` and `KNIME_CORE_TEST_NODE` select an explicitly created disposable fixture for settings/snapshot checks. Set `KNIME_CORE_TEST_NESTED_WORKFLOW` to a component/metanode that does not contain that root source node to verify scope isolation. Set `KNIME_CORE_TABLE_FIXTURE=1` only for a source with rows `['alpha',1]`, `['',2]`, `[null,3]`; it verifies literal rows, paging, column selection, and missing versus empty values. The broader beta integration suite owns fixture creation, execution, and save/reopen checks. A compile result alone does not establish native runtime support for every third-party node or port.
