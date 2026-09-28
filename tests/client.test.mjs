import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeClient, BridgeError } from '../src/client.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t, { id = 'knime-test', overrides = {}, respond } = {}) {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'knime-client-test-'));
  const sessionDir = path.join(runtime, 'sessions', id);
  await mkdir(path.join(sessionDir, 'requests'), { recursive: true });
  await mkdir(path.join(sessionDir, 'responses'), { recursive: true });
  const metadata = {
    id, pid: process.pid, bridgeVersion: '0.1.0-beta.1', knimeVersion: '5.12.0',
    workspace: 'C:\\synthetic KNIME\\工作区', startedAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(), status: 'ready', services: ['WorkflowService'],
    ...overrides,
  };
  await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(metadata));
  let stopped = false;
  const seen = new Set();
  const requests = [];
  const worker = (async () => {
    while (!stopped) {
      for (const filename of await readdir(path.join(sessionDir, 'requests'))) {
        if (!filename.endsWith('.json') || seen.has(filename)) continue;
        seen.add(filename);
        const request = JSON.parse(await readFile(path.join(sessionDir, 'requests', filename), 'utf8'));
        requests.push(request);
        if (respond) {
          const response = await respond(request);
          if (response !== undefined) {
            const target = path.join(sessionDir, 'responses', filename);
            await writeFile(`${target}.tmp`, typeof response === 'string' ? response : JSON.stringify(response));
            await rename(`${target}.tmp`, target);
          }
        }
      }
      await delay(5);
    }
  })();
  t.after(async () => { stopped = true; await worker; await rm(runtime, { recursive: true, force: true }); });
  return { runtime, sessionDir, requests, metadata, client: new BridgeClient({ runtime, pollMs: 5, timeoutMs: 500 }) };
}

test('atomic IPC round trip preserves Unicode and nested settings and removes consumed responses', async t => {
  const f = await fixture(t, { respond: request => ({ id: request.id, ok: true, result: { label: request.args.label, rows: [1, null, 'α'] } }) });
  const result = await f.client.call('core.configure', { label: '成绩 \"A\"\nlong', settings: { nested: { value: false } } });
  assert.deepEqual(result, { label: '成绩 \"A\"\nlong', rows: [1, null, 'α'] });
  assert.match(f.requests[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(Number.isFinite(Date.parse(f.requests[0].expiresAt)), true);
  assert.ok(Date.parse(f.requests[0].expiresAt) <= Date.now() + 500);
  assert.ok(Date.parse(f.requests[0].expiresAt) > Date.now() - 1000);
  assert.equal(f.requests[0].operation, 'core.configure');
  assert.deepEqual(f.requests[0].args.settings, { nested: { value: false } });
  assert.deepEqual(await readdir(path.join(f.sessionDir, 'responses')), []);
  assert.equal((await readdir(path.join(f.sessionDir, 'requests'))).filter(x => x.endsWith('.tmp')).length, 0);
});

test('multiple live sessions require explicit selection before submitting a mutation', async t => {
  const f = await fixture(t);
  const second = path.join(f.runtime, 'sessions', 'knime-second');
  await mkdir(second);
  await writeFile(path.join(second, 'session.json'), JSON.stringify({ ...f.metadata, id: 'knime-second' }));
  await assert.rejects(f.client.call('core.addNode', {}), e => e instanceof BridgeError && e.code === 'AMBIGUOUS_SESSION');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.client.selectSession('knime-test')).id, 'knime-test');
});

test('stale session and dead process are visible but cannot receive requests', async t => {
  const f = await fixture(t, { overrides: { heartbeat: new Date(Date.now() - 60000).toISOString() } });
  const sessions = await f.client.listSessions();
  assert.equal(sessions[0].alive, false);
  assert.match(sessions[0].reason, /heartbeat/i);
  await assert.rejects(f.client.call('health'), { code: 'NO_LIVE_SESSION' });
  await assert.rejects(f.client.selectSession('knime-test'), { code: 'SESSION_UNAVAILABLE' });
  await writeFile(path.join(f.sessionDir, 'session.json'), JSON.stringify({ ...f.metadata, heartbeat: new Date().toISOString(), pid: 2147483647 }));
  assert.equal((await f.client.listSessions())[0].alive, false);
  assert.match((await f.client.listSessions())[0].reason, /process/i);
});

test('malformed descriptors and path traversal never become a selectable session', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sessionDir, 'session.json'), '{ broken');
  assert.equal((await f.client.listSessions())[0].alive, false);
  await assert.rejects(f.client.selectSession('../outside'), { code: 'INVALID_ARGUMENT' });
});

test('timeout reports unknown outcome, publishes only once and leaves the request in flight', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.call('core.addNode', { factory: 'synthetic' }, { timeoutMs: 80 }), e => {
    assert.equal(e.code, 'REQUEST_TIMEOUT');
    assert.equal(e.details.outcome, 'unknown');
    assert.match(e.message, /inspect|check/i);
    return true;
  });
  await delay(25);
  assert.equal(f.requests.length, 1);
  const files = await readdir(path.join(f.sessionDir, 'requests'));
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);
});

test('native error code and details survive without being converted to success', async t => {
  const f = await fixture(t, { respond: r => ({ id: r.id, ok: false, error: { code: 'INVALID_SETTINGS', message: 'Missing column', details: { nodeId: 'root:4', column: '数量' } } }) });
  await assert.rejects(f.client.call('core.configure'), e => {
    assert.equal(e.code, 'INVALID_SETTINGS');
    assert.equal(e.details.nodeId, 'root:4');
    assert.equal(e.details.column, '数量');
    assert.equal(e.details.operationId, e.details.requestId);
    assert.equal(e.details.sessionId, 'knime-test');
    return true;
  });
  assert.deepEqual(await readdir(path.join(f.sessionDir, 'responses')), []);
});

for (const [label, response] of [
  ['malformed JSON', () => '{ nope'],
  ['mismatched identity', () => ({ id: 'wrong-request', ok: true, result: {} })],
  ['missing result', r => ({ id: r.id, ok: true })],
  ['invalid error', r => ({ id: r.id, ok: false, error: 'bad' })],
]) {
  test(`rejects ${label} IPC response`, async t => {
    const f = await fixture(t, { respond: response });
    await assert.rejects(f.client.call('health'), { code: 'INVALID_RESPONSE' });
  });
}

async function cli(args, env = {}) {
  const child = spawn(process.execPath, [path.join(project, 'src', 'cli.mjs'), ...args], { env: { ...process.env, ...env }, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { code, stdout, stderr };
}

test('CLI help/version work without KNIME and invalid flags fail with JSON diagnostics', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--args-file/);
  assert.match(help.stdout, /sessions/);
  const version = await cli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^0\.2\.0-beta\.1/);
  const error = await cli(['health', '--surprise']);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.equal(JSON.parse(error.stderr).error.code, 'INVALID_ARGUMENT');
});

test('CLI reads params from a UTF-8 args file and honors explicit runtime/session', async t => {
  const f = await fixture(t, { respond: r => ({ id: r.id, ok: true, result: { method: r.args.method, params: r.args.params } }) });
  const argsPath = path.join(f.runtime, '参数 with spaces.json');
  await writeFile(argsPath, '\uFEFF' + JSON.stringify(['project-α', 'root', { nested: ['a', null] }]));
  const result = await cli(['call', 'WorkflowService.getWorkflow', '--runtime', f.runtime, '--session', 'knime-test', '--args-file', argsPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { method: 'WorkflowService.getWorkflow', params: ['project-α', 'root', { nested: ['a', null] }] });
});

test('CLI core validates operation namespace without publishing to the bridge', async t => {
  const f = await fixture(t);
  const result = await cli(['core', 'gateway.call', '--runtime', f.runtime, '--args', '{}']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
  assert.equal(f.requests.length, 0);
});

test('CLI desktop forwards named JSON arguments and validates the desktop namespace', async t => {
  const f = await fixture(t, { respond: r => ({ id: r.id, ok: true, result: { operation: r.operation, args: r.args } }) });
  const argsPath = path.join(f.runtime, 'open editor.json');
  await writeFile(argsPath, JSON.stringify({ spaceId: 'space', itemId: 'project', spaceProviderId: 'local' }));
  const result = await cli(['desktop', 'desktop.openProject', '--runtime', f.runtime, '--args-file', argsPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { operation: 'desktop.openProject', args: { spaceId: 'space', itemId: 'project', spaceProviderId: 'local' } });
  const invalid = await cli(['desktop', 'core.describe', '--runtime', f.runtime]);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_ARGUMENT');
  assert.equal(f.requests.length, 1);
});

test('CLI describe transmits entity filter for installed command schemas', async t => {
  const f = await fixture(t, { respond: r => ({ id: r.id, ok: true, result: r.args }) });
  const result = await cli(['describe', '--entity', 'AddNodeCommandEnt', '--runtime', f.runtime]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { entity: 'AddNodeCommandEnt' });
});

test('CLI gateway call accepts named params without reordering or dropping values', async t => {
  const f = await fixture(t, { respond: r => ({ id: r.id, ok: true, result: r.args.params }) });
  const argsPath = path.join(f.runtime, 'named params.json');
  await writeFile(argsPath, JSON.stringify({ projectId: 'project-α', workflowId: 'root', includeData: false }));
  const result = await cli(['call', 'WorkflowService.getWorkflow', '--runtime', f.runtime, '--args-file', argsPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { projectId: 'project-α', workflowId: 'root', includeData: false });
});

test('CLI sessions honors runtime environment and reports absent runtime without errors', async t => {
  const f = await fixture(t);
  const result = await cli(['sessions'], { KNIME_AGENT_RUNTIME: f.runtime });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessions[0].id, 'knime-test');
  const absent = await cli(['sessions', '--runtime', path.join(f.runtime, 'absent')]);
  assert.equal(absent.code, 0);
  assert.deepEqual(JSON.parse(absent.stdout), { sessions: [] });
});

test('CLI rejects mixed argument formats and invalid JSON without creating a request', async t => {
  const f = await fixture(t);
  for (const args of [
    ['call', 'WorkflowService.getWorkflow', '--params', '"invalid"'],
    ['call', 'WorkflowService.getWorkflow', '--params', '[]', '--args-file', 'unused.json'],
    ['core', 'core.create', '--args', '{ broken'],
    ['health', '--args', '{}'],
  ]) {
    const result = await cli([...args, '--runtime', f.runtime]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(f.requests.length, 0);
});
