import { z } from 'zod';
import { BridgeError } from './client.mjs';
import {v02Tools,preconditionSchema,noteMutation} from './v02-tools.mjs';

const session = z.string().min(1).optional().describe('Explicit live session ID from knime_sessions. Required when multiple KNIME instances are running.');
const timeoutMs = z.number().int().min(1).max(3600000).optional().describe('Response timeout in milliseconds (default 30000). Timeout never cancels or retries the operation; inspect state before retrying.');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const advanced = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const precondition=preconditionSchema.optional().describe('Required for v0.2 mutations: bind knime_context, then send {contextId,expected:context.revisions}. Re-read after each edit.');
const operationId=z.string().uuid().optional().describe('Optional original request UUID for reconciling identical redelivery. Never generate a fresh ID merely to retry an unknown mutation outcome.');
const coreId = z.string().min(1).refine(value => value.trim().length > 0, 'ID must not be blank.');
const projectId = coreId.describe('ID of an already loaded project from the live application state.');
const workflowId = coreId.optional().describe('Nested component/metanode workflow ID from knime_workflow. Omit or use root for the project root.');
const nodeId = coreId.describe('Native or gateway node ID from knime_workflow; use workflowId to address a nested workflow.');
const tableOffset = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+$/).refine(value => /^\d+$/.test(value) && BigInt(value) <= 9223372036854775807n, 'Offset must fit a nonnegative signed 64-bit integer.'),
]).optional().describe('Zero-based row offset (default 0). Use a decimal string above 9007199254740991, up to 9223372036854775807; preserve returned nextOffset strings.');

export const toolCatalog = [
  {
    name: 'knime_sessions', title: 'List local KNIME sessions',
    description: 'List bridge sessions with process ID, workspace, versions, readiness and heartbeat status. Stale and unavailable sessions remain visible for diagnosis. Inspect this before selecting a workspace; multiple live sessions require an explicit ID.',
    inputSchema: {}, annotations: readOnly,
    run: async client => ({ sessions: await client.listSessions() }),
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
    inputSchema: { projectId, nodeId, workflowId, portIndex: z.number().int().min(0).max(2147483647).describe('Native output port index from the workflow snapshot; first data output is normally 1.'), offset: tableOffset, limit: z.number().int().min(1).max(1000).optional().describe('Page size, 1 to 1000 rows (native default 100).'), columns: z.array(z.union([z.string(), z.number().int().min(0).max(2147483647)])).max(10000).optional().describe('Optional column names or zero-based indices in the desired order, without duplicates; omit for all columns.'), session, timeoutMs }, annotations: readOnly,
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
];

export const operationGuide = {
  purpose: 'Operate the selected live KNIME instance and inspect the same workflow model used by its editor.',
  discovery: [
    'In v0.2, bind knime_context to the intended workspace/project/nested scope before mutation. Pass precondition {contextId,expected:context.revisions} to native mutating calls. Refresh observations and replan after conflicts; never force an old plan through with new digests.',
    'Call knime_sessions, identify the intended workspace and pass its session ID explicitly when more than one instance is ready. Then call knime_health.',
    'Call knime_describe for gateway services; filter with service and method. Obtain native operation contracts through knime_core_call {operation:"core.describe",args:{}} and visible editor contracts through knime_desktop_call {operation:"desktop.describe",args:{}}.',
    'Before constructing a command entity, call knime_describe {entity:"AddNodeCommandEnt"} or the exact entity type in the method schema. Include any required discriminator and respect discovered field names and enum values.',
    'Prefer named gateway params objects when names are supplied by discovery. Positional arrays are supported in the listed order. Do not guess methods, node factory IDs, project IDs or nested workflow IDs.',
  ],
  fullContext: [
    'Read application state to establish open projects, the active project and available actions. Use the discovered desktop.openProject action when the workflow needs to be visible in the editor.',
    'Use read-only knime_workflow for the selected project to inspect node IDs, factory/types, labels, positions, state, connections, annotations, errors and permitted actions. Include components and metanodes by traversing nested workflow IDs within a deliberate depth limit and inspect truncation fields.',
    'Use read-only knime_settings for typed settings and knime_table for bounded output table pages. Use the native port indices from knime_workflow. Preserve missing values separately from empty strings, decimal-string long values and nextOffset, and inspect reported truncation/continuation. Avoid passwords and secrets in routine snapshots.',
    'Use read-only knime_nodes to search the installed active node catalogue before adding a node. Configuration support depends on the actual node implementation; report unsupported or opaque settings instead of inventing them.',
  ],
  mutations: [
    'For canvas work, use knime_canvas_view before and after editing. Run knime_layout_check, then actually inspect readable images and required tiles. A generated image, executed node, or clean graph alone does not establish visual completion. Preserve instructional group membership by supplying groups/pins to layout planning; geometric clearance does not understand annotation meaning.',
    'Use knime_verify_workflow to retain requested scope and evidence-specific review. Report functional, visual and persistence statuses separately. Viewport synchronization, list-marker geometry, nested fidelity and unsupported output checks may remain incomplete. Do not conceal those gaps with a blanket done claim.',
    'Use native or gateway operations on the live model; do not edit the XML of an open workflow behind KNIME.',
    'After an edit, re-read the graph/settings and validate the resulting state. After execution, inspect completion, node errors, output schema and sample rows. Saving alone does not establish successful execution.',
    'In Desktop mode, save local workflows with knime_desktop_call {operation:"desktop.saveProject",args:{projectId}} and poll the root workflow until dirty is false. WorkflowService.saveProject is ineffective in Desktop and the bridge rejects it. Verify saved results by closing/reopening when persistence matters.',
    'Gateway services and node execution can access network, credentials or paid services, including Kai and Hub. Do not invoke these services merely to gather context. Obtain authorization for external actions, charges and destructive operations.',
    'Requests carry expiresAt so a compatible bridge can reject expired work that has not started. A client timeout still means unknown outcome: running work may complete. Do not retry automatically; inspect knime_operation using operationId/sessionId from the error. Layout wrapper receipts contain native operation IDs in progress; reconcile those exact IDs.',
  ],
  limits: 'KNIME gateway APIs are internal and version-specific. A discoverable method is not evidence every node family or third-party extension has been verified. Use the packaged capability matrix for beta acceptance evidence.',
};

export async function dispatchTool(client, name, input = {}) {
  const tool = toolCatalog.find(item => item.name === name);
  if (!tool) throw new BridgeError('UNKNOWN_TOOL', `Unknown tool '${name}'.`);
  const parsed = z.object(tool.inputSchema).strict().safeParse(input);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENT', parsed.error.message);
  const result = await tool.run(client, parsed.data);
  if (['knime_gateway_call','knime_core_call','knime_desktop_call'].includes(name) && parsed.data.precondition) {
    await noteMutation(client,{precondition:parsed.data.precondition,receipt:client.lastReceipt});
    if (result && typeof result === 'object' && !Array.isArray(result) && client.lastReceipt) return {...result,_operation:client.lastReceipt};
  }
  return result;
}

export function errorPayload(error) {
  return { error: error instanceof BridgeError ? error.toJSON() : { code: 'INTERNAL_ERROR', message: error?.message || String(error), details: {} } };
}

export {structuredResult} from './mcp-result.mjs';
