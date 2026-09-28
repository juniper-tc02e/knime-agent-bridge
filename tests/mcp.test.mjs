import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = fileURLToPath(new URL('..', import.meta.url));

test('MCP stdio discovery, tools, errors and resources use the real file transport', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'knime-mcp-test-'));
  const sessionDir = path.join(runtime, 'sessions', 'mcp-fixture');
  await mkdir(path.join(sessionDir, 'requests'), { recursive: true });
  await mkdir(path.join(sessionDir, 'responses'), { recursive: true });
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
    id: 'mcp-fixture', pid: process.pid, bridgeVersion: '0.1.0-beta.1',
    knimeVersion: '5.12.0', workspace: 'C:\\synthetic MCP test',
    startedAt: new Date().toISOString(), heartbeat: new Date().toISOString(),
    status: 'ready', services: ['WorkflowService'],
  }));
  let stopped = false;
  const requests = [];
  const seen = new Set();
  const worker = (async () => {
    while (!stopped) {
      for (const filename of await readdir(path.join(sessionDir, 'requests'))) {
        if (!filename.endsWith('.json') || seen.has(filename)) continue;
        seen.add(filename);
        const r = JSON.parse(await readFile(path.join(sessionDir, 'requests', filename), 'utf8'));
        requests.push(r);
        let response;
        if (r.operation === 'health') response = { id: r.id, ok: true, result: { knimeVersion: '5.12.0', services: ['WorkflowService'] } };
        else if (r.operation === 'gateway.describe') response = { id: r.id, ok: true, result: { services: ['WorkflowService'], methods: ['getWorkflow'], requested: r.args } };
        else if (r.operation === 'gateway.call' && r.args.method === 'WorkflowService.getWorkflow') response = { id: r.id, ok: true, result: { id: r.args.params[0] ?? r.args.params.projectId, nodes: [{ id: 'root:1', label: '数量' }] } };
        else if (r.operation === 'core.list') response = { id: r.id, ok: true, result: ['α', null, 7] };
        else if (r.operation === 'core.snapshot') response = { id: r.id, ok: true, result: { projectId: 'project-read', gatewayWorkflowId: 'root', nodes: [{ gatewayId: '1', state: 'EXECUTED', label: '数量' }], connections: [], truncated: false } };
        else if (r.operation === 'core.settings.get') response = { id: r.id, ok: true, result: { projectId: 'project-read', nodeId: '0:1', state: 'EXECUTED', applied: false, settings: { type: 'config', entries: { model: { type: 'config', entries: {} } } } } };
        else if (r.operation === 'core.nodes.search') response = { id: r.id, ok: true, result: { total: 1, offset: 0, limit: 10, hasMore: false, nodes: [{ factoryId: 'org.knime.base.node.io.tablecreator.TableCreatorNodeFactory', name: 'Table Creator', categoryPath: '/io/read', hidden: false }] } };
        else if (r.operation === 'core.table.read') response = { id: r.id, ok: true, result: { nodeId: '0:1', portIndex: 1, offset: '9007199254740993', limit: 2, totalRows: '9007199254740995', schema: [{ index: 0, name: 'value', type: 'String', encoding: 'string' }], rows: [{ key: 'Row9007199254740993', values: [null] }, { key: 'Row9007199254740994', values: [''] }], nextOffset: '9007199254740995', hasMore: false } };
        else if (r.operation === 'desktop.describe') response = { id: r.id, ok: true, result: { operations: ['desktop.openProject'] } };
        else response = { id: r.id, ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'Unknown operation', details: { operation: r.operation } } };
        const target = path.join(sessionDir, 'responses', filename);
        await writeFile(`${target}.tmp`, JSON.stringify(response));
        await rename(`${target}.tmp`, target);
      }
      await delay(5);
    }
  })();
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(project, 'src', 'server.mjs'), '--runtime', runtime, '--session', 'mcp-fixture'],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'knime-adapter-test', version: '1.0.0' });
  t.after(async () => { await client.close(); stopped = true; await worker; await rm(runtime, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'knime-agent-bridge');

  await t.test('tool discovery documents explicit sessions and advanced call contracts', async () => {
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['knime_core_call', 'knime_describe', 'knime_desktop_call', 'knime_gateway_call', 'knime_health', 'knime_nodes', 'knime_sessions', 'knime_settings', 'knime_table', 'knime_workflow']);
    const advanced = list.tools.find(tool => tool.name === 'knime_gateway_call');
    assert.match(advanced.description, /knime_describe/);
    assert.deepEqual(advanced.inputSchema.properties.params.anyOf.map(branch => branch.type), ['array', 'object']);
    assert.equal(advanced.annotations.readOnlyHint, false);
    for (const name of ['knime_workflow', 'knime_settings', 'knime_nodes', 'knime_table']) {
      const tool = list.tools.find(tool => tool.name === name);
      assert.equal(tool.annotations.readOnlyHint, true, name);
      assert.equal(tool.annotations.destructiveHint, false, name);
      assert.equal(tool.inputSchema.additionalProperties, false, name);
    }
  });
  await t.test('workflow reader sends exact project, nested workflow and depth to native snapshot', async () => {
    const result = await client.callTool({ name: 'knime_workflow', arguments: { projectId: 'project-read', workflowId: 'root:2', depth: 3, session: 'mcp-fixture', timeoutMs: 1000 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.nodes, [{ gatewayId: '1', state: 'EXECUTED', label: '数量' }]);
    assert.equal(requests.at(-1).operation, 'core.snapshot');
    assert.deepEqual(requests.at(-1).args, { projectId: 'project-read', workflowId: 'root:2', depth: 3 });
    await client.callTool({ name: 'knime_workflow', arguments: { projectId: 'project-read' } });
    assert.deepEqual(requests.at(-1).args, { projectId: 'project-read' });
  });
  await t.test('settings reader targets one native node and never sets patch arguments', async () => {
    const result = await client.callTool({ name: 'knime_settings', arguments: { projectId: 'project-read', nodeId: '1', workflowId: 'root:2' } });
    assert.equal(result.structuredContent.applied, false);
    assert.equal(result.structuredContent.settings.type, 'config');
    assert.equal(requests.at(-1).operation, 'core.settings.get');
    assert.deepEqual(requests.at(-1).args, { projectId: 'project-read', nodeId: '1', workflowId: 'root:2' });
  });
  await t.test('installed node search transmits query and pagination and preserves factory identities', async () => {
    const result = await client.callTool({ name: 'knime_nodes', arguments: { query: 'Table Creator', limit: 10, offset: 0 } });
    assert.equal(result.structuredContent.nodes[0].factoryId, 'org.knime.base.node.io.tablecreator.TableCreatorNodeFactory');
    assert.equal(requests.at(-1).operation, 'core.nodes.search');
    assert.deepEqual(requests.at(-1).args, { query: 'Table Creator', limit: 10, offset: 0 });
  });
  await t.test('table reader preserves 64-bit offsets, selected columns, missing values and empty strings', async () => {
    const result = await client.callTool({ name: 'knime_table', arguments: { projectId: 'project-read', nodeId: '1', workflowId: 'root:2', portIndex: 1, offset: '9007199254740993', limit: 2, columns: ['value', 3] } });
    assert.equal(requests.at(-1).operation, 'core.table.read');
    assert.deepEqual(requests.at(-1).args, { projectId: 'project-read', nodeId: '1', workflowId: 'root:2', portIndex: 1, offset: '9007199254740993', limit: 2, columns: ['value', 3] });
    assert.equal(result.structuredContent.nextOffset, '9007199254740995');
    assert.deepEqual(result.structuredContent.rows.map(row => row.values), [[null], ['']]);
  });
  await t.test('read-only schemas reject invalid bounds, unsafe offsets and mutation fields before IPC', async () => {
    const count = requests.length;
    for (const [name, args] of [
      ['knime_workflow', { projectId: 'project-read', depth: 9 }],
      ['knime_workflow', { projectId: '  ' }],
      ['knime_settings', { projectId: 'project-read' }],
      ['knime_settings', { projectId: 'project-read', nodeId: '1', patches: [] }],
      ['knime_nodes', { query: 'Table', limit: 501 }],
      ['knime_nodes', { query: 'Table', offset: -1 }],
      ['knime_table', { projectId: 'project-read', nodeId: '1' }],
      ['knime_table', { projectId: 'project-read', nodeId: '1', portIndex: -1 }],
      ['knime_table', { projectId: 'project-read', nodeId: '1', portIndex: 1, limit: 1001 }],
      ['knime_table', { projectId: 'project-read', nodeId: '1', portIndex: 1, offset: 9007199254740992 }],
      ['knime_table', { projectId: 'project-read', nodeId: '1', portIndex: 1, offset: '9223372036854775808' }],
      ['knime_table', { projectId: 'project-read', nodeId: '1', portIndex: 1, columns: [-1] }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT', name);
    }
    assert.equal(requests.length, count);
  });
  await t.test('session and health results contain machine-readable structured content', async () => {
    const sessions = await client.callTool({ name: 'knime_sessions', arguments: {} });
    assert.equal(sessions.structuredContent.sessions[0].id, 'mcp-fixture');
    assert.equal(sessions.structuredContent.sessions[0].alive, true);
    const health = await client.callTool({ name: 'knime_health', arguments: {} });
    assert.equal(health.structuredContent.knimeVersion, '5.12.0');
    assert.deepEqual(JSON.parse(health.content[0].text), health.structuredContent);
  });
  await t.test('gateway call transmits positional parameters and preserves nested output', async () => {
    const result = await client.callTool({ name: 'knime_gateway_call', arguments: { method: 'WorkflowService.getWorkflow', params: ['project-42', 'root'] } });
    assert.deepEqual(result.structuredContent, { id: 'project-42', nodes: [{ id: 'root:1', label: '数量' }] });
    assert.deepEqual(requests.at(-1).args, { method: 'WorkflowService.getWorkflow', params: ['project-42', 'root'] });
  });
  await t.test('gateway call transmits named parameters using discovered parameter names', async () => {
    const result = await client.callTool({ name: 'knime_gateway_call', arguments: { method: 'WorkflowService.getWorkflow', params: { projectId: 'named-project', workflowId: 'root' } } });
    assert.equal(result.structuredContent.id, 'named-project');
    assert.deepEqual(requests.at(-1).args.params, { projectId: 'named-project', workflowId: 'root' });
  });
  await t.test('non-object output is wrapped without losing nulls or array values', async () => {
    const result = await client.callTool({ name: 'knime_core_call', arguments: { operation: 'core.list', args: {} } });
    assert.deepEqual(result.structuredContent, { result: ['α', null, 7] });
  });
  await t.test('native failures are MCP tool errors with preserved code and details', async () => {
    const result = await client.callTool({ name: 'knime_core_call', arguments: { operation: 'core.unknown', args: {} } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'METHOD_NOT_FOUND');
    assert.deepEqual(result.structuredContent.error.details, { operation: 'core.unknown' });
  });
  await t.test('core namespace validation rejects gateway calls before IPC publication', async () => {
    const count = requests.length;
    const result = await client.callTool({ name: 'knime_core_call', arguments: { operation: 'gateway.call', args: {} } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(requests.length, count);
  });
  await t.test('invalid input returns a structured error and misspelled session fields cannot be ignored', async () => {
    const count = requests.length;
    const invalid = await client.callTool({ name: 'knime_gateway_call', arguments: { method: 'WorkflowService.getWorkflow', params: 'invalid' } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent?.error.code, 'INVALID_ARGUMENT');
    const typo = await client.callTool({ name: 'knime_health', arguments: { sessionID: 'unintended-workspace' } });
    assert.equal(typo.isError, true);
    assert.equal(typo.structuredContent?.error.code, 'INVALID_ARGUMENT');
    assert.equal(requests.length, count);
  });
  await t.test('desktop capabilities and entity schemas are discoverable without losing arguments', async () => {
    const desktop = await client.callTool({ name: 'knime_desktop_call', arguments: { operation: 'desktop.describe' } });
    assert.deepEqual(desktop.structuredContent, { operations: ['desktop.openProject'] });
    const entity = await client.callTool({ name: 'knime_describe', arguments: { entity: 'AddNodeCommandEnt' } });
    assert.deepEqual(entity.structuredContent.requested, { entity: 'AddNodeCommandEnt' });
    const count = requests.length;
    const invalid = await client.callTool({ name: 'knime_desktop_call', arguments: { operation: 'core.describe' } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
    assert.equal(requests.length, count);
  });
  await t.test('resources disclose capabilities and sessions through shared client', async () => {
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), ['knime://capabilities', 'knime://guide', 'knime://sessions']);
    const capabilities = await client.readResource({ uri: 'knime://capabilities' });
    assert.equal(capabilities.contents[0].mimeType, 'application/json');
    assert.deepEqual(JSON.parse(capabilities.contents[0].text).services, ['WorkflowService']);
    const sessions = await client.readResource({ uri: 'knime://sessions' });
    assert.equal(JSON.parse(sessions.contents[0].text).sessions[0].id, 'mcp-fixture');
    const guide = await client.readResource({ uri: 'knime://guide' });
    assert.match(guide.contents[0].text, /core\.describe/);
    assert.match(guide.contents[0].text, /desktop\.describe/);
    assert.match(guide.contents[0].text, /AddNodeCommandEnt/);
  });
  assert.equal(stderr, '');
});
