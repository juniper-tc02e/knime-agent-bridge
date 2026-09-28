# Workflow quality and preservation contract

The bridge keeps structural correctness, configuration, execution/data, visual review and persistence separate. `readyForCompletion` is derived from the required dimensions of a stored task manifest. A successful native command or a generated image does not establish completion.

## Begin, inspect, edit, review, assess

1. Bind the intended session, project and scope with `knime_context`. Bind changed nested scopes separately.
2. Begin `knime_verify_workflow` with `{action:"begin",input:{contextId,requestedScopes,requiredDimensions,dataChecks,fidelityRequirements}}`. The bridge stores an immutable task manifest and reads preservation baselines where supported.
3. Inspect structure/settings/data and an initial native canvas. Plans retain the exact source frame, native old coordinates and revisions. Review pins and preserved annotation groups.
4. Apply an immutable layout plan once. Each native edit receives revision guards and exact old values. The bridge reads changes back, compares integrity evidence and renders again. It reports partial failure without replaying the plan or undoing concurrent user work.
5. Inspect the overview and readable required tiles. For a large canvas, call `knime_canvas_view` with the preceding `evidenceId` to page the same immutable SVG frame. Keep scale, crop and render parameters consistent.
6. Record `{action:"review",input:{taskId,evidenceIds,frames:[{evidenceId,sourceFrameId,tileIds,received:true,readable:true,inspected:true,notes}],dispositions:[]}}`. Each attested tile must have been produced in that evidence record and emitted by the server. Concrete frame-specific notes are required. Review can cover one page at a time.
7. Call `{action:"assess",input:{taskId,evidenceIds}}`. It independently reads supported native snapshots and table assertions, resolves immutable captures/checks, and reports any missing dimension. Do not replace an incomplete receipt with a generic “done”.

Do not run external writers, queries, or other side effects merely to verify a cosmetic change. This contract does not expand authorisation for external systems, publishing, spending, or credentials.

## Immutable evidence and scope

The bridge-owned `runtime/quality` directory contains append-only JSON records. Files are created exclusively, content digests are verified on read, and returned records are deeply frozen. This protects the protocol from caller-forged pass flags and accidental overwrite; it is not a security boundary against a user who controls the local filesystem.

Task changes add scopes and dimensions monotonically. Observed native revision changes are recorded. Explicit `respecify` actions record their reason and caller-declared user source. A root capture cannot cover a changed component. Unverified mutation coverage remains incomplete. Assessment rereads its manifest after native observations and checks scope/revisions again before publication, refusing a complete receipt if they changed during assessment.

Dimension assertions are task-specific. Client assessment input contains IDs only; it cannot submit authoritative freshness, pass, or not-applicable flags. Native structure/configuration producers currently verify preservation against the task baseline. Intentional semantic changes require additional expected-change adapters; this beta does not reinterpret a changed baseline as an approved new graph.

## Images and review

Artifact production, server image emission, host delivery acknowledgement, and agent review are separate facts. The server emission callback runs when actual MCP image blocks are formatted. Filenames and resource links are not image delivery.

Pages can combine only when source frame, context, scope, revisions, source artifact, renderer and required tile manifest match. Matching artifact IDs must carry identical metadata. Every required region must be produced, emitted and attested. Missing resources, incomplete geometry, expired artifacts, stale frames and native renderer omissions remain incomplete even when every available image was reviewed.

Without independent host acknowledgements, an evidence-specific receipt/readability/inspection attestation provides an `agent-attested` delivery basis. Host scaling remains unknown. It never becomes `host-confirmed`. A task requiring host-confirmed delivery stays incomplete until that independent evidence exists.

An agent can explain a geometric false positive with evidence. An actual unresolved high-priority defect needs a scoped user exception and remains `accepted_exception`. The server records caller-declared user authorisation, which it cannot independently authenticate without host support. The server also cannot prove model comprehension or prohibit arbitrary final prose claiming completion.

## Full data integrity

`integritySnapshot` records structure, redacted settings-envelope, layout, execution-state and explicitly selected output fingerprints with coverage. A full table hash streams every selected row, column metadata/type, row key, missing marker and typed value. A one-cell change changes its digest even when row count and schema do not change.

The native paging adapter supplies an immutable `BufferedDataTable` object identity. Every page and a final reread must use that identity, and relevant native revisions must remain stable. Unsupported tokens, opaque/truncated values, changed identities, paging gaps, read limits, or unavailable output types produce incomplete coverage. Samples remain sampled. An empty table selection is `none`, never a vacuous full pass. Protected settings values are not extracted or hashed; preservation remains incomplete unless an independently trusted native mechanism proves it.

Data checks use declarative `kind:"data"|"schema"|"count"`, explicit scope/node/native port, and JSON `expected` values. Data expectations are native `{key,values}` rows; schema expectations are native schema records; count expectations may be safe integers or decimal strings. They never execute caller-provided code. Table-value assertion collection is bounded to 100,000 rows; larger comparisons remain incomplete rather than silently sampling.

## Current boundaries

Native preview fidelity and embedded-viewport synchronization retain the actual renderer's reported limitations. The quality layer cannot promote `model-stable-render-unconfirmed` to verified. Conservative plans are proposals until KNIME rerenders them; native spline behaviour is authoritative. Generated positions/bendpoints use bounded integers and annotation enlargement uses integer dimensions. Agents should stop after three unsuccessful repair cycles and review unresolved cases. The public tool creates independent plans and does not enforce a sequence-wide cycle counter; unresolved cases propose widening a gutter or moving its group.

The current tool adapter does not independently verify exact saved/reopened artifacts. Persistence therefore remains incomplete even when the live workflow is clean or an asynchronous save was acknowledged. Native core/layout changes may not create gateway undo entries. Full host behavioural trials and actual model image comprehension are separate release evidence, not implied by these unit tests.
