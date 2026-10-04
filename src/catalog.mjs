import { z } from 'zod';
import { BridgeError,CLIENT_OPERATION } from './client.mjs';
import {v02Tools,preconditionSchema,noteMutation,services} from './v02-tools.mjs';
import {waitForCondition} from './wait.mjs';
import {readDetail} from './details.mjs';
import {verifyTable} from './table-verification.mjs';

const session = z.string().min(1).optional().describe('Explicit live session ID from knime_sessions. Required when multiple KNIME instances are running.');
const timeoutMs = z.number().int().min(1).max(3600000).optional().describe('Response timeout in milliseconds (default 30000). Timeout never cancels or retries the operation; inspect state before retrying.');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const advanced = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const precondition=preconditionSchema.optional().describe('Required for mutations. Graph: {contextId,expected:context.revisions}; workspace-only create/open: {contextId,expected:{}} (never null). Inspect the same binding after each edit.');
const operationId=z.string().uuid().optional().describe('Optional original request UUID for reconciling identical redelivery. Never generate a fresh ID merely to retry an unknown mutation outcome.');
const coreId = z.string().min(1).refine(value => value.trim().length > 0, 'ID must not be blank.');
const projectId = coreId.describe('ID of an already loaded project from the live application state.');
const workflowId = coreId.optional().describe('Nested component/metanode workflow ID from knime_workflow. Omit or use root for the project root.');
const nodeId = coreId.describe('Native or gateway node ID from knime_workflow; use workflowId to address a nested workflow.');
const tableOffset = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+$/).refine(value => /^\d+$/.test(value) && BigInt(value) <= 9223372036854775807n, 'Offset must fit a nonnegative signed 64-bit integer.'),
]).optional().describe('Zero-based row offset (default 0). Use a decimal string above 9007199254740991, up to 9223372036854775807; preserve returned nextOffset strings.');
const scalar=z.union([z.string(),z.number().finite(),z.boolean(),z.null()]);
const metricExpectations=z.object({labelColumn:z.string().min(1),scoreColumn:z.string().min(1),positiveLabel:scalar.refine(v=>v!==null,'positiveLabel must name a class'),threshold:z.number().min(0).max(1).optional(),expectedAccuracy:z.number().min(0).max(1).optional(),expectedRocAuc:z.number().min(0).max(1).optional(),tolerance:z.number().min(0).max(.01).optional()}).strict();

export const toolCatalog = [
  {
    name:'knime_diagnostics',title:'Observe bounded native queue and request stages',
    description:'Read bridge-owned queue/worker telemetry without waiting for workflow locks, UI or native mutations. A fresh heartbeat is not UI health. Cancellation remains serialized; queued/requested/acknowledged are separate from verified terminal cancellation. Use the original request UUID when available.',
    inputSchema:{requestId:z.string().uuid().optional(),session,timeoutMs},annotations:readOnly,
    run:(client,{session,timeoutMs,...args})=>client.call('bridge.diagnostics',args,{session,timeoutMs}),
  },
  {
    name:'knime_history',title:'Page retained evidence or retrieve an exact record',
    description:'Local read-only async disk-authoritative evidence lookup. Pages contain bounded metadata and a cursor invalidated by observed additions/changes/deletions. Get verifies current payload and digest. Does not dispatch or remove evidence. Large details use knime_detail; no cached payload supplies authority.',
    inputSchema:{action:z.enum(['page','get']),id:z.string().min(1).max(180).optional(),kind:z.string().min(1).max(180).optional(),limit:z.number().int().min(1).max(200).optional(),cursor:z.string().max(2000).optional(),baseDigest:z.string().min(1).max(200).optional(),metrics:z.boolean().optional()},annotations:readOnly,
    run:async(client,{action,id,...args})=>{const {store}=await services(client);if(action==='get'){if(!id||Object.values(args).some(v=>v!==undefined))throw new BridgeError('INVALID_ARGUMENT','get requires only id.');return store.getAsync(id);}if(id!==undefined)throw new BridgeError('INVALID_ARGUMENT','page does not accept id.');return store.historyPage(args);},
  },
  {
    name:'knime_detail',title:'Read a bounded full-detail JSON chunk',
    description:'Retrieve the complete payload referenced by compact responses, using character offsets and full-payload SHA-256. Concatenate chunks then verify SHA-256 of UTF-8 JSON. Every chunk revalidates current disk integrity; no native dispatch.',
    inputSchema:{id:z.string().uuid(),offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),limit:z.number().int().min(1).max(16000).optional()},annotations:readOnly,run:readDetail,
  },
  {
    name:'knime_table_verify',title:'Verify complete keyed output and named metrics',
    description:'Read every native immutable table page within explicit bounds, guard the table identity and recheck it at the end. Check exact row count, unique named columns, constant run UUID and optional binary accuracy/AUC with named positive class and half-credit ties. Never executes/reset nodes. Full output is separate from fresh inference, persistence and visuals.',
    inputSchema:{projectId,workflowId,nodeId,portIndex:z.number().int().min(0).max(2147483647),session,timeoutMs,pageSize:z.number().int().min(1).max(1000).optional(),maxRows:z.number().int().min(1).max(1000000).optional(),expectations:z.object({rowCount:z.number().int().min(0).max(1000000).optional(),uniqueColumns:z.array(z.string().min(1)).max(100).optional(),constants:z.record(scalar).optional(),metrics:metricExpectations.optional()}).strict().optional()},annotations:readOnly,
    run:async(client,args)=>{const result=await verifyTable(client,args);const {store}=await services(client);const receipt=store.put('table-verification',result);return {...result,evidenceId:receipt.id};},
  },
  {
    name:'knime_connection',title:'Inspect the configured KNIME connection',
    description:'Read filesystem runtime and exact session/process/workspace/bundle identity without dispatching to KNIME. Descriptor readiness does not certify UI responsiveness. A session UUID cannot switch runtime directories.',
    inputSchema:{session,detail:z.boolean().optional()},annotations:readOnly,
    run:(client,input)=>client.connectionDiagnostics(input),
  },
  {
    name:'knime_settings_preview',title:'Preview a typed settings change',
    description:'Native read-only validation of patches on a detached full settings envelope. Returns typed diff, candidate validation, coverage and potential downstream reset impact. Never loads settings or resets nodes. Applying still needs fresh revisions.',
    inputSchema:{projectId,workflowId,nodeId,patches:z.array(z.object({path:z.array(z.string().min(1)).min(1).max(64),value:z.unknown(),type:z.string().min(1).optional(),createParents:z.boolean().optional()}).strict()).min(1).max(1000),session,timeoutMs},annotations:readOnly,
    run:(client,{session,timeoutMs,...args})=>client.call('core.settings.preview',args,{session,timeoutMs}),
  },
  {
    name:'knime_dependencies',title:'Inspect dependencies and effective model settings',
    description:'Read bounded upstream connections, available typed flow variables, setting bindings and native flow-variable-resolved model settings for one exact scope/node. Protected values are redacted; unsupported resolution remains explicit. Does not execute nodes or certify output run identity.',
    inputSchema:{projectId,workflowId,nodeId,maxNodes:z.number().int().min(1).max(10000).optional(),maxVariables:z.number().int().min(1).max(1000).optional(),variableNames:z.array(z.string().min(1)).max(1000).optional(),pathChecks:z.array(z.object({variableName:z.string().min(1).optional(),settingsPath:z.array(z.string().min(1)).min(1).max(64).optional(),expectedRoot:z.string().min(1).optional()}).strict()).max(100).optional(),includeEffectiveSettings:z.boolean().optional(),session,timeoutMs},annotations:readOnly,
    run:(client,{session,timeoutMs,...args})=>client.call('dependency.inspect',args,{session,timeoutMs}),
  },
  {
    name: 'knime_sessions', title: 'List local KNIME sessions',
    description: 'List bridge sessions with process ID, workspace, versions, readiness and heartbeat status. Stale and unavailable sessions remain visible for diagnosis. Inspect this before selecting a workspace; multiple live sessions require an explicit ID.',
    inputSchema: {}, annotations: readOnly,
    run: async client => ({ runtime:client.runtime, sessions: await client.listSessions() }),
  },
  {
    name: 'knime_health', title: 'Inspect KNIME bridge health',
    description: 'Read the selected live KNIME process version, bridge health and installed service capabilities. Does not mutate workflows.',
    inputSchema: { session, timeoutMs }, annotations: readOnly,
    run: (client, input) => client.call('health', {}, input),
  },
  {
    name: 'knime_describe', title: 'Describe live KNIME capabilities',
    description: 'Discover installed gateway services, methods, argument types and entity schemas, optionally filtering by service and method, or inspecting a named entity such as AddNodeCommandEnt. Entity descriptions include supported fields and type discriminator details when available. Use this before knime_gateway_call; installed KNIME versions and extensions change the available surface. Discover native engine operations with knime_core_call core.describe and visible desktop actions with knime_desktop_call desktop.describe. Read knime://guide for the full context workflow.',
    inputSchema: { service: z.string().min(1).optional(), method: z.string().min(1).optional(), entity: z.string().min(1).optional(), session, timeoutMs }, annotations: readOnly,
    run: (client, { service, method, entity, ...options }) => client.call('gateway.describe', { ...(service === undefined ? {} : { service }), ...(method === undefined ? {} : { method }), ...(entity === undefined ? {} : { entity }) }, options),
  },
  {
    name: 'knime_workflow', title: 'Read a live workflow snapshot',
    description: 'Read core.snapshot for a loaded project or nested workflow. Returns graph nodes and identities, positions, states, messages, available execution actions, ports, connections, annotations and nested context up to the requested depth. Default depth is 1; at most 2000 nodes are included by the native default. Inspect truncated, omittedNodes and childrenTruncated before assuming the snapshot is complete. Reads the live engine without editing or executing it.',
    inputSchema: { projectId, workflowId, depth: z.number().int().min(0).max(8).optional().describe('Nested workflow traversal depth, from 0 to 8 (native default 1).'), session, timeoutMs }, annotations: readOnly,
    run: (client, { session, timeoutMs, ...args }) => client.call('core.snapshot', args, { session, timeoutMs }),
  },
  {
    name: 'knime_settings', title: 'Read typed node settings',
    description: 'Read core.settings.get for one node, component or metanode in a loaded project. Returns the typed settings envelope and current node state without patching configuration. Preserve the envelope and native type names when reasoning about a later authorized settings change; supported fields depend on the actual node and its input data.',
    inputSchema: { projectId, nodeId, workflowId, session, timeoutMs }, annotations: readOnly,
    run: (client, { session, timeoutMs, ...args }) => client.call('core.settings.get', args, { session, timeoutMs }),
  },
  {
    name: 'knime_nodes', title: 'Search installed node factories',
    description: 'Search the live installed active node catalogue through core.nodes.search. Matches node name, factory ID, category and keywords. Returns factory identities and paging information; an empty query lists active nodes. Discover the actual installed factory before adding nodes. No workflow is created or modified.',
    inputSchema: { query: z.string().describe('Case-insensitive search text; an empty string browses the active installed catalogue.'), limit: z.number().int().min(1).max(500).optional().describe('Maximum results, 1 to 500 (native default 50).'), offset: z.number().int().min(0).max(2147483647).optional().describe('Zero-based result offset (native default 0).'), session, timeoutMs }, annotations: readOnly,
    run: (client, { session, timeoutMs, ...args }) => client.call('core.nodes.search', args, { session, timeoutMs }),
  },
  {
    name: 'knime_table', title: 'Read an executed output table page',
    description: 'Read core.table.read from an already executed native BufferedDataTable output. Returns selected column schema, row keys, values and paging metadata. Missing cells are null; empty strings remain empty; long values and row offsets use decimal strings. Inspect schema encodings and opaque markers. This tool does not execute the node. Use the native port index reported by knime_workflow: implicit flow-variable port is normally 0 and the first data port normally 1.',
    inputSchema: { projectId, nodeId, workflowId, expectedTableIdentity:z.string().min(1).optional(),portIndex: z.number().int().min(0).max(2147483647).describe('Native output port index from the workflow snapshot; first data output is normally 1.'), offset: tableOffset, limit: z.number().int().min(1).max(1000).optional().describe('Page size, 1 to 1000 rows (native default 100).'), columns: z.array(z.union([z.string(), z.number().int().min(0).max(2147483647)])).max(10000).optional().describe('Optional column names or zero-based indices in the desired order, without duplicates; omit for all columns.'), session, timeoutMs }, annotations: readOnly,
    run: (client, { session, timeoutMs, ...args }) => client.call('core.table.read', args, { session, timeoutMs }),
  },
  {
    name: 'knime_gateway_call', title: 'Call a discovered KNIME gateway method',
    description: 'Advanced live gateway access. First use knime_describe to obtain the exact installed service method and argument contract. Pass Service.method and a named JSON params object using discovered names, or a positional array in the listed order. Calls may edit, execute, save or delete workflows; Kai, Hub and other services may contact external or paid services. Do not call these merely to gather context. Obtain appropriate authorization for the intended action and re-read state after mutations. Timeout means unknown outcome and must not trigger an automatic retry.',
    inputSchema: { method: z.string().min(1).describe('Discovered qualified method, e.g. WorkflowService.getWorkflow.'), params: z.union([z.array(z.unknown()), z.record(z.unknown())]).default([]).describe('Named JSON arguments using exact discovered names (preferred), or positional arguments in the listed order.'), session, timeoutMs, precondition, operationId }, annotations: advanced,
    run: (client, { method, params = [], ...options }) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(method) || params === null || typeof params !== 'object') throw new BridgeError('INVALID_ARGUMENT', 'Gateway calls require Service.method and a named params object or positional array.');
      return client.call('gateway.call', { method, params }, options);
    },
  },
  {
    name: 'knime_core_call', title: 'Call a native KNIME core operation',
    description: 'Advanced native engine operation for bridge capabilities such as typed settings, graph editing, execution and paged output data. First call operation core.describe with args {} for supported operations and argument contracts; read knime://guide for complete workflow context. This tool requires a core. operation name. Operations may mutate workflows or run nodes with external effects; obtain appropriate user authorization. Inspect state after mutations and after unknown timeout outcomes; never automatically retry a timed-out mutation.',
    inputSchema: { operation: z.string().min(1).describe('Supported full core operation name, starting core.'), args: z.record(z.unknown()).default({}).describe('Named JSON arguments for this native operation.'), session, timeoutMs, precondition, operationId }, annotations: advanced,
    run: (client, { operation, args = {}, ...options }) => {
      if (!/^core\.[A-Za-z][A-Za-z0-9_.]*$/.test(operation)) throw new BridgeError('INVALID_ARGUMENT', 'Core operation must begin with core. and name a supported native operation.');
      return client.call(operation, args, options);
    },
  },
  {
    name: 'knime_desktop_call', title: 'Control the visible KNIME editor',
    description: 'Discover and invoke supported KNIME desktop actions. Start with operation desktop.describe and args {}. For desktop.openProject provide the discovered spaceProviderId, spaceId and itemId so the project opens in the actual KNIME editor. Other operations depend on the installed bridge catalogue. This changes the visible application; select the correct session and use it only for the requested workflow. Timeout means unknown outcome: inspect application state before retrying.',
    inputSchema: { operation: z.string().min(1).describe('Supported full desktop operation name, starting desktop.'), args: z.record(z.unknown()).default({}).describe('Named JSON arguments documented by desktop.describe.'), session, timeoutMs, precondition, operationId }, annotations: advanced,
    run: (client, { operation, args = {}, ...options }) => {
      if (!/^desktop\.[A-Za-z][A-Za-z0-9_.]*$/.test(operation)) throw new BridgeError('INVALID_ARGUMENT', 'Desktop operation must begin with desktop. and name a supported desktop action.');
      return client.call(operation, args, options);
    },
  },
  ...v02Tools,
  {
    name:'knime_wait',title:'Wait for an observed KNIME condition',
    description:'Bounded read-only wait for execution, project open/close, or clean save state. Explicit session required. Stops on a blocking dialog and never retries the mutation. Clean state does not verify a saved artifact.',
    inputSchema:{session:z.string().min(1),condition:z.enum(['execution','saved','opened','closed']),projectId:z.string().min(1).optional(),workflowId:z.string().min(1).optional(),nodeId:z.string().min(1).optional(),origin:z.object({providerId:z.string().min(1),spaceId:z.string().min(1),itemId:z.string().min(1)}).strict().optional(),timeoutMs:z.number().int().min(1).max(60000).optional()},
    annotations:readOnly,run:waitForCondition,
  },
];
for(const tool of toolCatalog)tool.inputSchema={...tool.inputSchema,resultMode:z.enum(['compact','full']).optional().describe('Default compact: structured payload once and full-detail reference above128KiB. Explicit full preserves the entire structured payload; text remains concise.')};

export const operationGuide = {
  purpose: 'Operate the selected live KNIME instance and inspect the same workflow model used by its editor.',
  discovery: [
    'In v0.5 prefer a named route profile pinned to runtime, session, native version and bundle fingerprint. knime_connection is descriptor-only; knime_diagnostics observes bridge-owned queue/worker stages without workflow locks. Neither certifies UI responsiveness. Keep intentional concurrent clients separate.',
    'In v0.2 and later, bind knime_context to the intended workspace/project/nested scope before mutation. Workspace-only create/open uses precondition {contextId,expected:{}}; graph changes use current context.revisions. Refresh observations and replan after conflicts; never force an old plan through with new digests.',
    'In v0.4 inspect knime_connection to confirm configured runtime, PID and fingerprints. A session ID cannot switch runtime directories. Bind once per live scope, inspect to refresh, monitor usage, and release after outstanding operations and assessments finish. Prune frees only proven invalid models; historical evidence remains readable.',
    'Call knime_sessions, identify the intended workspace and pass its session ID explicitly when more than one instance is ready. Then call knime_health.',
    'Call knime_describe for gateway services; filter with service and method. Obtain native operation contracts through knime_core_call {operation:"core.describe",args:{}} and visible editor contracts through knime_desktop_call {operation:"desktop.describe",args:{}}.',
    'Before constructing a command entity, call knime_describe {entity:"AddNodeCommandEnt"} or the exact entity type in the method schema. Include any required discriminator and respect discovered field names and enum values.',
    'Prefer named gateway params objects when names are supplied by discovery. Positional arrays are supported in the listed order. Do not guess methods, node factory IDs, project IDs or nested workflow IDs.',
  ],
  fullContext: [
    'Default MCP text is concise; structuredContent remains complete below the 128 KiB threshold. Large payloads return immutable detail references. Fetch knime_detail chunks, concatenate exact text and verify its full UTF-8 SHA-256. resultMode:"full" explicitly requests the whole structured payload. Page knime_history metadata with the same kind/baseDigest; a stale cursor must restart rather than merge unknown state.',
    'Read application state to establish open projects, the active project and available actions. Use the discovered desktop.openProject action when the workflow needs to be visible in the editor.',
    'Use read-only knime_workflow for the selected project to inspect node IDs, factory/types, labels, positions, state, connections, annotations, errors and permitted actions. Include components and metanodes by traversing nested workflow IDs within a deliberate depth limit and inspect truncation fields.',
    'Use read-only knime_settings for typed settings and knime_table for bounded output table pages. Use the native port indices from knime_workflow. Preserve missing values separately from empty strings, decimal-string long values and nextOffset, and inspect reported truncation/continuation. Avoid passwords and secrets in routine snapshots.',
    'Use read-only knime_nodes to search the installed active node catalogue before adding a node. Configuration support depends on the actual node implementation; report unsupported or opaque settings instead of inventing them.',
    'Use knime_dependencies to inspect upstream connections, native variable stacks and variable-resolved model settings. A stored Reader fallback is not its effective path. Independently check the requested run UUID and all expected values across stable table pages; a resolved path or sample alone does not prove freshness. Preserve and verify expensive producer output identity rather than rerunning it merely for inspection.',
    'Use knime_dependencies variableNames and pathChecks to compare selected consumed scalar paths with the actual physical workflow root. Unknown/opaque/remote values remain unknown. Copied executed output may still belong to its parent. This read-only gate never refreshes a producer and cannot certify producer lineage.',
    'Use knime_table_verify for bounded complete rows, contiguous immutable table identity, unique named keys, constant run UUID and binary metrics with an explicit positiveLabel. It performs a final recheck, never executes nodes, and keeps freshInference unverified. A sample cannot establish full-cohort metrics.',
  ],
  mutations: [
    'Inspect settingsValidation after adding/configuring a node. Configured/executed state does not prove model settings serialize and validate. Incomplete settings must be repaired before execution or save; do not edit loaded workflow XML.',
    'Use knime_settings_preview before typed configuration changes. Review native validation, diff and conservative reset impact; apply still requires current revision guards. Supply xlong/longArray values as decimal strings, and preserve explicitly reported unknown validation, variable, view and persistence coverage.',
    'knime_wait observes execution, open/close or clean-save conditions without repeating the operation. Its saved condition is not saved-artifact verification. Use desktop.uiState for bounded warning text; desktop.dialogAction reveals Details then acknowledges only an unchanged observed Workflow Load warning. Re-inspect after revealing details.',
    'For copy/paste, pass the exact copy.content string unchanged to paste.content; do not JSON.parse or stringify it again. core.execute uses nodeId, NodeService.changeNodeStates uses nodeIds, and knime_table uses portIndex.',
    'For canvas work, use knime_canvas_view before and after editing. Run knime_layout_check, then actually inspect readable images and required tiles. A generated image, executed node, or clean graph alone does not establish visual completion. Preserve instructional group membership by supplying groups/pins to layout planning; geometric clearance does not understand annotation meaning.',
    'Use knime_verify_workflow to retain requested scope and evidence-specific review. Report functional, visual and persistence statuses separately. Viewport synchronization, list-marker geometry, nested fidelity and unsupported output checks may remain incomplete. Do not conceal those gaps with a blanket done claim.',
    'Use native or gateway operations on the live model; do not edit the XML of an open workflow behind KNIME.',
    'After an edit, re-read the graph/settings and validate the resulting state. After execution, inspect completion, node errors, output schema and sample rows. Saving alone does not establish successful execution.',
    'In Desktop mode, save local workflows with knime_desktop_call {operation:"desktop.saveProject",args:{projectId}} and poll the root workflow until dirty is false. WorkflowService.saveProject is ineffective in Desktop and the bridge rejects it. Verify saved results by closing/reopening when persistence matters.',
    'Gateway services and node execution can access network, credentials or paid services, including Kai and Hub. Do not invoke these services merely to gather context. Obtain authorization for external actions, charges and destructive operations.',
    'Requests carry expiresAt so a compatible bridge can reject expired work that has not started. A client timeout still means unknown outcome: running work may complete. Do not retry automatically; inspect knime_operation using operationId/sessionId from the error and nativeDispatch. Full immutable receipt events remain authoritative if a Windows lock delays the aggregate JSON. Layout wrapper receipts contain native operation IDs in progress; reconcile those exact IDs.',
    'Observer expiration, client IPC deadline, native start deadline and the host MCP request limit are different clocks. A small residual budget must not dispatch another slow snapshot. Cancellation stays in the serialized native lane; requested/queued/acknowledged does not mean verified terminal cancellation. On definitive stdio EOF only the owned observer stops, retaining unknown original UUIDs; no KNIME or arbitrary process is killed.',
  ],
  limits: 'KNIME gateway APIs are internal and version-specific. A discoverable method is not evidence every node family or third-party extension has been verified. Use the packaged capability matrix for beta acceptance evidence.',
};

export async function dispatchTool(client, name, input = {}) {
  const tool = toolCatalog.find(item => item.name === name);
  if (!tool) throw new BridgeError('UNKNOWN_TOOL', `Unknown tool '${name}'.`);
  const parsed = z.object(tool.inputSchema).strict().safeParse(input);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', parsed.error.message);
  const {resultMode:_resultMode,...argumentsOnly}=parsed.data;
  const result = await tool.run(client, argumentsOnly);
  // Use metadata on this exact native result, never a shared last-trace pointer.
  // It is opt-in and contains no argument/result values.
  if(result&&typeof result==='object'&&!Array.isArray(result)&&result[CLIENT_OPERATION]?.trace){
    const {receipt:_receipt,...metadata}=result[CLIENT_OPERATION];
    Object.defineProperty(result,'_clientOperation',{value:metadata,enumerable:true,configurable:true});
  }
  if (['knime_gateway_call','knime_core_call','knime_desktop_call'].includes(name) && parsed.data.precondition) {
    const receipt=result?.[CLIENT_OPERATION]?.receipt;
    await noteMutation(client,{precondition:parsed.data.precondition,receipt,uncertain:!receipt});
    if (result && typeof result === 'object' && !Array.isArray(result) && receipt) return {...result,_operation:receipt};
  }
  return result;
}

export function errorPayload(error) {
  const payload=error instanceof BridgeError ? error.toJSON() : { code:error?.code||'INTERNAL_ERROR',message:error?.message||String(error),details:{} };
  const next=payload.details?.reconciliation?{tool:'knime_operation',arguments:{sessionId:payload.details.sessionId,operationId:payload.details.operationId}}:
    /TABLE_IDENTITY/.test(payload.code)?{tool:'knime_table',arguments:{projectId:'<selected project>',nodeId:'<selected node>',portIndex:'<discovered data port>',limit:1}}:
    /CONTEXT|REVISION/.test(payload.code)?{tool:'knime_context',arguments:{action:'inspect',contextId:'<existing bound context>'}}:
    /SESSION|RUNTIME|PROFILE|COMPATIBILITY/.test(payload.code)?{tool:'knime_connection',arguments:{detail:true}}:
    payload.code==='STALE_HISTORY_CURSOR'?{tool:'knime_history',arguments:{action:'page'}}:
    payload.code==='INVALID_ARGUMENT'?{tool:'knime_core_call',arguments:{operation:'core.describe',args:{}}}:null;
  return {error:{...payload,...(next?{suggestedReadOnlyNextCall:next}:{})}};
}

export {structuredResult} from './mcp-result.mjs';
