# v0.2 canvas and context API

The local MCP server exposes 18 tools in beta.2 (17 in beta.1). The original 10 discovery, workflow, settings, data and advanced native tools remain, with context/revision preconditions for v0.2 mutations. Seven tools add context binding, canvas images, layout checks/plans/application, operation lookup and quality evidence; beta.2 adds the read-only `knime_wait` observer.

## Bind before editing

Call `knime_sessions` and `knime_health`, identify the intended workspace, then:

```json
{"name":"knime_context","arguments":{"action":"bind","projectId":"PROJECT_FROM_APPLICATION_STATE","workflowId":"root"}}
```

The returned context includes the session identity, loaded bridge fingerprint and separate structure/configuration/layout/execution revisions. Omit the project only when binding a workspace for create/open operations. Use `action:"inspect"` with `contextId` to refresh the same binding. A restart requires rediscovery and rebinding.

Mutating advanced tools accept a `precondition` beside their existing arguments:

```json
{"contextId":"RETURNED_CONTEXT_ID","expected":{"structure":"RETURNED_DIGEST","configuration":"RETURNED_DIGEST","layout":"RETURNED_DIGEST","execution":"RETURNED_DIGEST"}}
```

Do not invent revision digests or refresh them merely to force an old plan through. Reinspect and replan after a conflict. Native core settings and layout mutations have stronger apply-time guards; lifecycle and generic gateway calls expose weaker coverage explicitly. Unknown expert operations are not a universal atomic edit interface.

## See and check the canvas

`knime_canvas_view` accepts `contextId` and a mode:

| Mode | Purpose |
|---|---|
| `overview` | Orientation image of the complete native preview |
| `detail` | Readable crop, with explicit workflow-coordinate `crop:{x,y,width,height}` |
| `tiles` | Readable tiled coverage; use returned tile metadata and immutable evidence paging |
| `viewport` | Experimental embedded editor screenshot; synchronization and coordinate mapping remain unconfirmed |

The result contains actual MCP PNG image blocks and metadata in `structuredContent.evidence`. Inspect `sourceKind`, `freshness`, `coverage`, `omissions`, `revisions` and per-image `workflowToPixel`. A native preview is generated from the loaded model; it is not a screenshot of all UI controls. A viewport is only the visible embedded browser, not native dialogs or an entire offscreen workflow.

Run `knime_layout_check` with the returned `evidenceId`. It checks measured text and node footprints against actual cubic connector paths. Whole annotation rectangles are not treated as solid text obstacles. Warnings, uncertainty and coverage gaps remain visible; list-marker geometry and unsupported render details can require manual image review.

For large canvases, use the same `evidenceId` when requesting additional tiles of its immutable source frame. An intervening model revision invalidates it. Do not combine unrelated screenshots into a claim that one current canvas was reviewed.

## Plan and apply

`knime_layout_plan` takes current `evidenceId`, optional pinned object IDs/group constraints, or explicit native layout changes. The stored plan contains exact old/new node positions, annotation bounds or connection bendpoints. It does not alter topology, annotation text, settings or input paths.

`knime_layout_apply` takes `planId` and `precondition`. Plans are claimed once, revisions and exact old values are checked, and the native result is reread. Direct layout setters do not create a gateway undo entry. A partial/failed application must be reconciled; never blindly repeat it or undo someone else's changes. Inspect native integrity coverage rather than assuming all opaque data values were fingerprinted.

After application, obtain current images and check the rendered result again. Clear bendpoints do not guarantee a clear curve. Automatic candidate planning is conservative and can return unresolved issues requiring a different route or more space.

## Quality and operation evidence

Use `knime_verify_workflow` with `action` plus an `input` object. Begin a task with explicit `contextId`, `requestedScopes` and `requiredDimensions`. Record exact frame/tile review with concrete notes, then assess immutable evidence IDs. Read the [quality contract](QUALITY_CONTRACT.md) for the full schema and evidence requirements.

Dimensions are structure, configuration, execution/data, visual and persistence. Missing/unproved coverage stays incomplete; passing execution alone does not certify layout. Agent review is an attestation, not proof of model comprehension. Host-confirmed image delivery and agent-attested delivery are distinct.

Timeout errors retain `operationId` and `sessionId`. Query them with `knime_operation`, including after the original process stops. Nonterminal records from a dead process remain `unknown_after_restart`. Reconciliation never replays the command.

## CLI

All tools are callable through the CLI using UTF-8 JSON argument files:

```powershell
node src/cli.mjs tool knime_context --args-file bind.json
node src/cli.mjs tool knime_canvas_view --args-file canvas.json --output '.\canvas-preview'
node src/cli.mjs tool knime_layout_check --args-file check.json
```

For `call`, `core` or `desktop`, use `--precondition-file context-precondition.json`. CLI exports are image files plus evidence JSON; exporting files is not a claim that the model viewed them. Use an image-capable MCP host for the primary agent workflow.

## Beta limits

The native preview adapter is pinned to the tested KNIME gateway build. Viewport synchronization, native dialogs, every third-party node view, arbitrary component fidelity and universal semantic node configuration are not certified. The release receipt records live tests and remaining evaluation work. No full-access or perfect-layout guarantee is implied by tool discovery.
