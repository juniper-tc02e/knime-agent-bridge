# Live KNIME gateway and desktop operations

The bridge attaches to KNIME 5.12's modern UI. It uses a transport-independent `DefaultJsonRpcRequestHandler` backed by KNIME's existing `ServiceInstances` registry. It does not load another copy of an open workflow, create another workflow middleware, or replace the UI's dependencies.

This is an internal KNIME API and can change between versions. Discover methods and entities from the running installation before constructing unfamiliar calls. The installed classes are authoritative; the public `releases/STS` source may differ slightly from this installed build.

## Request forms and discovery

The examples below are arguments to the shared client's `call(operation, args)` method. The client handles request IDs and the local IPC envelope. `client` must already identify the intended KNIME session and workspace.

```js
await client.call("gateway.describe", {});
await client.call("gateway.describe", { service: "WorkflowService" });
await client.call("gateway.describe", { method: "WorkflowService.getWorkflow" });
await client.call("gateway.describe", { entity: "AddNodeCommandEnt" });
await client.call("gateway.describe", { entity: "ConnectCommandEnt" });
await client.call("gateway.describe", { commands: true });
await client.call("desktop.describe", {});
await client.call("desktop.functions", {});
await client.call("desktop.uiState", {});
```

Service descriptions provide full method names, exact named parameters, positional indices, Java types, result types, and whether this bridge permits invocation. Parameter names come from the installed JSON-RPC wrappers' `JsonRpcParam` annotations, rather than compiler-generated names such as `arg0`.

Entity descriptions use KNIME's Jackson mapper and its mixins. They include serialized field names, enum values, and polymorphic discriminator/subtype information when available. `WorkflowCommandEnt` reports its `kind` discriminator and the command entities associated with each kind. Descriptions do not invent requiredness or defaults: absent required metadata means unknown, not optional. `NodeIDEnt` is serialized as a string, such as `root` or `root:1`, rather than an object containing its internal fields.

```js
const gateway = (method, params = {}) =>
  client.call("gateway.call", { method, params });

const app = await gateway("ApplicationService.getState");
```

Named parameters are recommended. Positional arrays are also accepted in the order returned by discovery. Omitted `params` becomes an empty object. A JSON-RPC error becomes a structured bridge error with KNIME's original error details.

## Create and open a workflow

Local workspace IDs are `spaceProviderId: "local"` and `spaceId: "local"`. Its root directory item ID is the literal string `"root"`, not `/`. Other items have opaque IDs: use IDs returned by KNIME, not filesystem paths or names.

```js
const folder = await gateway("SpaceService.listWorkflowGroup", {
  spaceId: "local", spaceProviderId: "local", itemId: "root"
});

const item = await gateway("SpaceService.createWorkflow", {
  spaceId: "local", spaceProviderId: "local", itemId: "root",
  itemName: "Agent Bridge Example"
});

const acknowledgement = await client.call("desktop.openProject", {
  spaceId: "local", itemId: item.id, spaceProviderId: "local"
});
```

Creating a workflow creates its space item; opening it is a separate desktop operation. Opening uses KNIME's public desktop callback wrapper, which schedules the operation on KNIME's SWT UI thread and performs the normal project registration, active-project update, and recent-project update.

`desktop.openProject` returns `{accepted:true, completed:false, ...}` after scheduling. It does not synchronously report success. Poll `ApplicationService.getState` and match `openProjects[].origin.providerId`, `origin.spaceId`, and `origin.itemId`. Keep the returned `projectId` for subsequent operations. Errors after acceptance are reported in KNIME's UI. If completion is not observed before a client timeout, inspect the current state instead of automatically retrying the mutation.

```js
const state = await gateway("ApplicationService.getState");
const project = state.openProjects.find(p =>
  p.origin?.providerId === "local" &&
  p.origin?.spaceId === "local" && p.origin?.itemId === item.id);
// Poll again if project is absent; acceptance alone does not establish success.
```

## Read the current canvas

`projectId` identifies an open project. `workflowId` identifies the root workflow or a nested workflow within that project. The root workflow ID is `"root"`; use the returned IDs for nested workflows and nodes.

```js
const snapshot = await gateway("WorkflowService.getWorkflow", {
  projectId: project.projectId,
  workflowId: "root",
  versionId: null,
  includeInteractionInfo: true
});
```

`versionId: null` selects the current editable state. `includeInteractionInfo: true` includes information such as available actions and undo/redo state, matching the live editor's representation. The result contains a `snapshotId` and `workflow` object. Read the resulting graph after mutations rather than treating command acceptance as proof of the final graph or successful execution.

## Native canvas commands

Graph edits go through `WorkflowService.executeWorkflowCommand` and KNIME's existing command stack. The `workflowCommand.kind` value selects the concrete command entity. This preserves the ordinary canvas behavior and native undo/redo for commands that support it.

KNIME also requires the project's current editable version to be active. Opening a local project through `desktop.openProject` activates it; inspect the intended canvas before issuing graph commands. If KNIME returns `Project version "current-state" is not active`, restore the intended active workflow and inspect again. Do not interpret that error as a successful edit or blindly retry against another project. Avoid concurrent agents/tests switching active projects during an editing sequence; the native acceptance suite runs its test files serially for this reason.

The following examples contain replacement values. Use a factory key obtained from installed node discovery, node IDs returned by `add_node`, and port indices from the actual workflow snapshot. Node factories can require a `settings` string in addition to `className`; preserve the complete factory key for dynamic factories.

Add a node:

```js
const added = await gateway("WorkflowService.executeWorkflowCommand", {
  projectId: project.projectId,
  workflowId: "root",
  workflowCommand: {
    kind: "add_node",
    position: { x: 120, y: 160 },
    nodeFactory: { className: "REPLACE_WITH_DISCOVERED_FACTORY_CLASS" }
  }
});
const sourceNodeId = added.newNodeId;
```

Discover `NodeRepositoryService.searchNodes`, `getNodeTemplates`, and `NodeService.getNodeDescription` for node lookup and documentation. Adding a node does not configure it. Use its supported configuration adapter before attempting execution.

Connect two existing nodes:

```js
await gateway("WorkflowService.executeWorkflowCommand", {
  projectId: project.projectId,
  workflowId: "root",
  workflowCommand: {
    kind: "connect",
    sourceNodeId: "REPLACE_WITH_SOURCE_NODE_ID",
    sourcePortIdx: 1,
    destinationNodeId: "REPLACE_WITH_DESTINATION_NODE_ID",
    destinationPortIdx: 1
  }
});
```

The example indices are not universal. Use the indices and compatible port types returned by the snapshot; hidden flow-variable ports can affect numbering. Connecting can replace an existing connection, so inspect the destination port first.

Undo or redo the last native canvas command:

```js
await gateway("WorkflowService.undoWorkflowCommand", {
  projectId: project.projectId, workflowId: "root"
});
await gateway("WorkflowService.redoWorkflowCommand", {
  projectId: project.projectId, workflowId: "root"
});
```

Additional command kinds include `translate`, `update_node_label`, `delete`, `add_workflow_annotation`, and commands for components, metanodes, ports, and bendpoints. Request `{commands:true}` and then describe the corresponding entity before use. Do not assume core settings changes participate in the gateway's undo stack.

## Execute, monitor, and save

```js
await gateway("NodeService.changeNodeStates", {
  projectId: project.projectId,
  workflowId: "root",
  nodeIds: ["REPLACE_WITH_TARGET_NODE_ID"],
  action: "execute"
});

const monitor = await gateway("WorkflowService.getWorkflowMonitorState", {
  projectId: project.projectId
});

await client.call("desktop.saveProject", {
  projectId: project.projectId
});
```

Execution is asynchronous. Poll the monitor and workflow/node states; verify data outputs separately. Other state actions are `reset` and `cancel`. Pass explicit node IDs. A completed gateway request does not mean the workflow executed successfully.

`desktop.saveProject` uses KNIME's normal desktop save callback for an already-loaded project with a verified local origin. It returns asynchronous acceptance, not proof that saving finished. Poll `core.snapshot` for the root workflow until its `dirty` flag is false; avoid concurrent edits during this check. Then close, reopen, and inspect the persisted graph, settings, and outputs when verifying a full round trip. Errors after acceptance can appear in KNIME's UI; inspect `desktop.uiState` when saving stalls. Remote projects and Save As are not supported by this operation.

The native callback signature is `saveProject(String projectId, Boolean allowOverwritePrompt)`, called through `DesktopAPI.forEachAPIFunction` with `[projectId, false]`. The beta permits only local origins before disabling the remote overwrite prompt. KNIME schedules the callback on SWT and uses its normal progress service, workflow save, and app-state update.

**Do not call `WorkflowService.saveProject` in this desktop bridge.** KNIME's installed implementation returns without saving when the browser-only `DefaultServiceContext` project ID is absent. It can otherwise look like a successful request while the workflow remains dirty. The bridge rejects this gateway method with an explanation and marks it `callable:false` in discovery. Use `desktop.saveProject` instead.

## Close a saved workflow and reopen it

`desktop.closeProject` refuses a project that the live project manager reports as dirty. Save first. `nextProjectId` may identify another open project, or be omitted/null.

```js
await client.call("desktop.saveProject", { projectId: project.projectId });
// Poll core.snapshot for this root workflow and require dirty === false first.
await client.call("desktop.closeProject", {
  projectId: project.projectId, nextProjectId: null
});
```

Close also returns asynchronous acceptance. Poll `ApplicationService.getState` until that project is absent before reopening it by its original space item ID. Reopening can produce a different `projectId`; reacquire it by matching the origin. Avoid simultaneous manual edits during close. If a user edit occurs after the bridge's clean-state check, KNIME retains its own save prompt rather than discarding the new change.

Opening, saving local projects, and closing saved projects are the invocable desktop actions. `desktop.functions` lists installed callback names for discovery and marks which are allowed; it does not provide general invocation, application exit, forced close, login, or arbitrary modal-dialog actions.

`desktop.uiState` reads SWT shell titles, visibility, enabled state, and modality without interacting with the UI. Its read waits at most 1.5 seconds for the SWT thread, and reports `responsive:false` and `blocked:true` if the check cannot complete. Open/save/close preflight rejects a visible modal shell or an unresponsive desktop rather than silently scheduling behind a dialog. The state can change after the check, so asynchronous completion still needs verification.

## Shared event subscriptions

All `EventService` calls are rejected by this bridge, including add/remove listener. Discovery still describes these methods with `callable:false` and an explanation. The desktop UI's workflow listeners are shared per workflow rather than independently scoped to each bridge client. Adding/removing subscriptions could alter the UI's listener or patch history.

Poll snapshots and monitor state instead. The UI's existing listeners continue receiving changes made through its shared gateway services. The bridge never replaces KNIME's `EventConsumer` or disposes its services.

## Bundle and lifecycle notes

The adapter uses the exported gateway API/implementation/JSON-RPC packages, the exported `WrapWithJsonRpcService` utility, and the exported desktop API. It does not import non-exported UI lifecycle classes or directly import the JSON-RPC wrapper package.

In addition to the core/desktop/gateway bundles, method annotation and entity discovery require these bundle dependencies:

```text
org.knime.gateway.json
com.github.briandilley.jsonrpc4j
com.fasterxml.jackson.core.jackson-databind
com.fasterxml.jackson.core.jackson-core
com.fasterxml.jackson.core.jackson-annotations
org.eclipse.swt
org.eclipse.ui
```

Start bridge attachment only once the Eclipse workbench exists. Calling `DesktopAPI` too early can initialize UI classes before KNIME startup is ready. Once the workbench is running, `DesktopAPI.areDependenciesInjected()` is the gate for modern-UI calls. Do not call `setDefaultServiceDependencies`, create separate service middleware, or dispose shared service instances.

An initialized gateway does not imply a dialog-free desktop. For example, a fresh workspace can display the first-run "Help improve KNIME" question while the gateway already responds. The disposable beta launcher can preconfigure a declined telemetry choice before launch in `.metadata/.plugins/org.eclipse.core.runtime/.settings/org.knime.workbench.core.prefs`:

```properties
eclipse.preferences.version=1
knime.askedToSendStatistics=true
knime.sendAnonymousStatistics=false
```

These values suppress the first-run question and disable anonymous usage statistics in that workspace. Preserve unrelated preference entries and do not rewrite a running workspace's settings file. The installed `KNIMEApplicationWorkbenchAdvisor.checkAnonymousUsageStatistics` reads the first key as its dialog guard and writes the second key from the user's yes/no result.

Modern startup reads `startWithWebUI=true` from the configuration-scope `org.knime.ui.java` preference node. KNIME's installed `KNIMEApplication.fixPerspectiveSwitchProblem` can still force the classic perspective when the workspace has `.metadata/.plugins/org.eclipse.e4.workbench/workbench.xmi` but lacks `.metadata/knime/app_state.json`. This can follow an interrupted first modern session. Prefer an orderly modern shutdown to persist app state, or use the ordinary "Open KNIME Modern UI" action. Do not fabricate application-state JSON or overwrite another workspace's layout. The toolbar's command ID is `org.knime.ui.java.command.switch`.

For a supplemental core adapter, obtain the already-loaded manager through `ProjectManager.getInstance().getProject(projectId).get().getWorkflowManagerIfLoaded()`. Such code still needs proper workflow locking and its own mutation/validation contract; it should not independently reopen the workflow directory.

## Source references

- [JSON-RPC handler and service suppliers](https://github.com/knime-oss/knime-gateway/blob/releases/STS/org.knime.gateway.impl.jsonrpc/src/eclipse/org/knime/gateway/impl/webui/jsonrpc/DefaultJsonRpcRequestHandler.java)
- [Shared service registry](https://github.com/knime-oss/knime-gateway/blob/releases/STS/org.knime.gateway.impl/src/eclipse/org/knime/gateway/impl/webui/service/ServiceInstances.java)
- [Modern UI initialization](https://github.com/knime-oss/knime-ui/blob/releases/STS/org.knime.ui.java/src/eclipse/org/knime/ui/java/browser/lifecycle/Init.java)
- [Desktop API callbacks](https://github.com/knime-oss/knime-ui/blob/releases/STS/org.knime.ui.java/src/eclipse/org/knime/ui/java/api/DesktopAPI.java)
- [Opening a project](https://github.com/knime-oss/knime-ui/blob/releases/STS/org.knime.ui.java/src/eclipse/org/knime/ui/java/api/OpenProject.java)
- [Desktop project callback signatures](https://github.com/knime-oss/knime-ui/blob/releases/STS/org.knime.ui.java/src/eclipse/org/knime/ui/java/api/ProjectAPI.java)
- [Native desktop save implementation](https://github.com/knime-oss/knime-ui/blob/releases/STS/org.knime.ui.java/src/eclipse/org/knime/ui/java/api/SaveProject.java)
- [Native workflow service](https://github.com/knime-oss/knime-gateway/blob/releases/STS/org.knime.gateway.impl/src/eclipse/org/knime/gateway/impl/webui/service/DefaultWorkflowService.java)
- [Generated client and entity definitions](https://github.com/knime-oss/knime-ui/blob/releases/STS/org.knime.ui.js/src/api/gateway-api/generated-api.ts)
- [Shared workflow event listener implementation](https://github.com/knime-oss/knime-gateway/blob/releases/STS/org.knime.gateway.impl/src/eclipse/org/knime/gateway/impl/webui/service/events/WorkflowChangedEventSource.java)

## Copy and paste without changing the payload

`CopyCommandEnt` returns an opaque `content` string. Keep it byte-for-byte as returned; a JSON-quoted-looking string is still the native clipboard envelope. Do not call `JSON.parse(copy.content)` or wrap it in another `JSON.stringify` before paste.

```js
const copied = await command({
  kind: 'copy', nodeIds: [nodeId], annotationIds: [], connectionBendpoints: {}
});
await command({kind: 'paste', content: copied.content, position: {x: 500, y: 200}});
```

These examples assume the usual bound-context gateway helper. Inspect installed command schemas before changing fields. `core.execute` uses singular `nodeId`; `NodeService.changeNodeStates` accepts `nodeIds`; output reads use `portIndex`. These APIs deliberately do not silently coerce misspelled targets.

## Load warning recovery (beta.2)

`desktop.uiState` returns bounded native modal labels, read-only text, instantiated tree/table/list items, button labels, stable dialog/action IDs, a content fingerprint, and truncation/coverage information. Editable text and password fields are omitted. Embedded browser/custom dialog content can remain unavailable.

For an observed **Workflow Load** warning only, `desktop.dialogAction` accepts `{dialogId,fingerprint,actionId}` with a normal context precondition. The adapter rechecks the exact visible dialog before dispatching a supported button event. If `detailsCollapsed:true`, only `reveal-load-details` is offered: invoke it, inspect again, then use the new fingerprint and `acknowledge-load-warning` action. Old fingerprints, unknown dialogs and unlisted actions are rejected. `desktop.dismissDialog` is an alias. There is no generic click, destructive confirmation, credentials submission or progress-cancel action.

Acknowledging a warning does not repair its node. Inspect the loaded graph and `settingsValidation`, then repair through typed settings. Save/execute guards still reject known invalid settings. A UI action timeout is an unknown outcome; inspect again before deciding on another action.

## Waiting and operation records (beta.2)

`knime_wait` polls a specific session for `execution`, `saved`, `opened` or `closed`. Open waits require the exact `{providerId,spaceId,itemId}` origin; close waits require the original project ID. It returns on the observed condition, a blocking modal, an execution error or timeout. It never repeats the native command. A clean-save condition is not a reopen/round-trip certificate.

Operation receipts expose `nativeDispatch` (`not_started`, `started`, `returned` or `started_outcome_unknown`). This describes dispatch, not completion of asynchronous work. Metadata write retries are bounded and never retry KNIME actions. Full immutable receipt events are authoritative if Windows delays replacing the aggregate `.json`; `knime_operation` reads the newest event even when the aggregate is missing/stale. A failed final journal write reports its uncertainty and retains the original native result/error details.

Session listings expose both the descriptor's `reportedStatus` and the current effective `status`/`effectiveStatus`. A dead process with an old ready descriptor is shown as `dead`, and a live process with an expired heartbeat as `stale`.
