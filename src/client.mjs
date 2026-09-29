import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9_.]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }

  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

export function defaultRuntimeDirectory() {
  return path.resolve(process.env.KNIME_AGENT_RUNTIME || path.join(projectRoot, 'runtime'));
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new BridgeError('INVALID_ARGUMENT', `${name} must be a positive finite number.`);
  return value;
}

function validateSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new BridgeError('INVALID_ARGUMENT', 'Session must be an ID from knime_sessions; paths are not accepted.');
}

function unavailableReason(metadata, id, staleMs) {
  if (!object(metadata) || metadata.id !== id || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0 ||
      typeof metadata.heartbeat !== 'string' || !Number.isFinite(Date.parse(metadata.heartbeat))) return 'Invalid session metadata.';
  if (metadata.status !== 'ready') return `Session is not ready (status: ${metadata.status ?? 'unknown'}).`;
  const age = Date.now() - Date.parse(metadata.heartbeat);
  if (age > staleMs) return `Heartbeat is stale (${Math.round(age)} ms old).`;
  if (age < -staleMs) return 'Heartbeat is in the future; check the local clock.';
  try { process.kill(metadata.pid, 0); }
  catch (error) { if (error.code !== 'EPERM') return 'KNIME process is not running.'; }
  return null;
}

export class BridgeClient {
  constructor({ runtime = defaultRuntimeDirectory(), session, timeoutMs = 30000, pollMs = 50, staleMs = 15000 } = {}) {
    if (typeof runtime !== 'string' || !runtime.trim()) throw new BridgeError('INVALID_ARGUMENT', 'Runtime directory must be a nonempty path.');
    if (session !== undefined) validateSessionId(session);
    this.runtime = path.resolve(runtime);
    this.session = session;
    this.timeoutMs = positive(timeoutMs, 'timeoutMs');
    this.pollMs = positive(pollMs, 'pollMs');
    this.staleMs = positive(staleMs, 'staleMs');
  }

  async listSessions() {
    const root = path.join(this.runtime, 'sessions');
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new BridgeError('IPC_ERROR', `Cannot read KNIME runtime directory: ${error.message}`);
    }
    const sessions = await Promise.all(entries.filter(entry => entry.isDirectory() && SESSION_ID.test(entry.name)).map(async entry => {
      try {
        const metadata = JSON.parse(await readFile(path.join(root, entry.name, 'session.json'), 'utf8'));
        const reason = unavailableReason(metadata, entry.name, this.staleMs);
        const reportedStatus=object(metadata)?metadata.status:undefined;
        let effectiveStatus=reason===null?'ready':reportedStatus==='stopped'?'stopped':'unavailable';
        if(reason) {
          if(Number.isSafeInteger(metadata?.pid)&&metadata.pid>0) {
            try {process.kill(metadata.pid,0);if(/Heartbeat is stale/.test(reason))effectiveStatus='stale';else if(reportedStatus==='starting')effectiveStatus='starting';}
            catch(error){if(error.code==='ESRCH')effectiveStatus='dead';}
          }
        }
        return { ...(object(metadata) ? metadata : {}), id: entry.name, reportedStatus, status:effectiveStatus,effectiveStatus,alive: reason === null, ...(reason ? { reason } : {}) };
      } catch (error) {
        return { id: entry.name, alive: false, reason: `Invalid or unreadable session metadata: ${error.message}` };
      }
    }));
    return sessions.sort((a, b) => a.id.localeCompare(b.id));
  }

  async selectSession(id = this.session) {
    if (id !== undefined) validateSessionId(id);
    const sessions = await this.listSessions();
    if (id !== undefined) {
      const selected = sessions.find(session => session.id === id);
      if (!selected) throw new BridgeError('NO_SESSION', `KNIME session '${id}' was not found. Run sessions to inspect available instances.`, { sessionId: id, runtime: this.runtime });
      if (!selected.alive) throw new BridgeError('SESSION_UNAVAILABLE', `KNIME session '${id}' is unavailable: ${selected.reason}`, { sessionId: id });
      return selected;
    }
    const alive = sessions.filter(session => session.alive);
    if (alive.length === 0) throw new BridgeError('NO_LIVE_SESSION', 'No live KNIME bridge session is ready. Launch KNIME with the bridge and inspect sessions.', { runtime: this.runtime, sessions });
    if (alive.length > 1) throw new BridgeError('AMBIGUOUS_SESSION', 'Multiple KNIME sessions are ready. Select an explicit session ID before operating a workflow.', { sessions: alive.map(({ id, workspace, pid }) => ({ id, workspace, pid })) });
    return alive[0];
  }

  async call(operation, args = {}, { session = this.session, timeoutMs = this.timeoutMs, precondition, operationId = randomUUID() } = {}) {
    if (typeof operation !== 'string' || !OPERATION.test(operation) || !object(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'Operation must be a nonempty operation name and args must be a JSON object.');
    }
    positive(timeoutMs, 'timeoutMs');
    if (!UUID.test(operationId)) throw new BridgeError('INVALID_ARGUMENT', 'operationId must be a UUID. Reuse only to reconcile the identical request.');
    if (precondition !== undefined && (!object(precondition) || Object.keys(precondition).some(key => !['contextId','expected'].includes(key)) || typeof precondition.contextId !== 'string' || !precondition.contextId || !object(precondition.expected) || Object.entries(precondition.expected).some(([key,value]) => !['structure','configuration','layout','execution'].includes(key) || typeof value !== 'string' || !value))) {
      throw new BridgeError('INVALID_ARGUMENT', 'precondition requires contextId and an expected revision object.');
    }
    const id = operationId;
    const selected = await this.selectSession(session);
    // Once used, this client stays with that process even if another instance
    // later becomes the sole live session. Explicit selection remains possible.
    if (this.session === undefined) this.session = selected.id;
    let payload;
    try { payload = JSON.stringify({ id, operation, args, ...(precondition ? {precondition} : {}), expiresAt: new Date(Date.now() + timeoutMs).toISOString() }); }
    catch (error) { throw new BridgeError('INVALID_ARGUMENT', `Arguments must be serializable JSON: ${error.message}`); }
    const sessionDir = path.join(this.runtime, 'sessions', selected.id);
    const requestPath = path.join(sessionDir, 'requests', `${id}.json`);
    const tempPath = `${requestPath}.tmp`;
    const responsePath = path.join(sessionDir, 'responses', `${id}.json`);
    const details = { requestId: id, operationId: id, sessionId: selected.id, operation, outcome: 'unknown' };
    this.lastOperation = details;
    try {
      await writeFile(tempPath, payload, { flag: 'wx', mode: 0o600 });
      await rename(tempPath, requestPath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw new BridgeError('IPC_ERROR', `Could not publish the KNIME request: ${error.message}`, { ...details, outcome: 'not_submitted' });
    }

    // Once published, leave the request to the bridge. Timeout or client shutdown
    // cannot establish whether the engine has already applied a mutation.
    const deadline = performance.now() + timeoutMs;
    while (true) {
      let raw;
      try { raw = await readFile(responsePath, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new BridgeError('IPC_ERROR', `Could not read the KNIME response. Inspect state before retrying: ${error.message}`, details);
      }
      if (raw !== undefined) {
        let response;
        try {
          response = JSON.parse(raw);
          if (!object(response) || response.id !== id || typeof response.ok !== 'boolean' ||
              (response.ok && !Object.hasOwn(response, 'result')) ||
              (!response.ok && (!object(response.error) || typeof response.error.code !== 'string' || typeof response.error.message !== 'string'))) {
            throw new Error('Response identity or result/error envelope is invalid.');
          }
        } catch (error) {
          throw new BridgeError('INVALID_RESPONSE', `Invalid KNIME response. Inspect state before retrying: ${error.message}`, details);
        } finally {
          await unlink(responsePath).catch(() => {});
        }
        this.lastReceipt = response.receipt;
        if (!response.ok) throw new BridgeError(response.error.code, response.error.message, { ...details, ...response.error.details });
        return response.result;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new BridgeError('REQUEST_TIMEOUT', `KNIME did not respond within ${timeoutMs} ms; the outcome is unknown. Inspect workflow state before retrying. The request was not retried or cancelled.`, { ...details, timeoutMs });
      }
      await delay(Math.min(this.pollMs, remaining));
    }
  }
}
