import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
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

const IDENTITY_FIELDS = ['pid', 'startedAt', 'workspace', 'bridgeVersion', 'knimeVersion', 'bundleFingerprint', 'capabilityFingerprint'];
export function sessionIdentity(metadata) {
  return Object.fromEntries(IDENTITY_FIELDS.map(key => [key, metadata?.[key] ?? null]));
}
function identityMatches(a, b) { return IDENTITY_FIELDS.every(key => a[key] === b[key]); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export function reconciliationDetails(runtime, sessionId, operationId) {
  return { runtime, sessionId, operationId, action: 'operation.get', readOnly: true, resubmits: false,
    guidance: 'Read the original durable receipt and inspect native state. Reconciliation never resubmits, retries or cancels the operation.' };
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

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
    this.pinnedIdentities = new Map();
    this.operationPayloads = new Map();
    this.responseObservations = new Map();
    this.canonicalRuntime = undefined;
    this.canonicalRuntimePromise = undefined;
  }

  async resolveRuntime() {
    // One shared initial resolution also prevents concurrent callers from pinning
    // different canonical roots while a configured runtime link is replaced.
    if (!this.canonicalRuntimePromise) {
      this.canonicalRuntimePromise = realpath(this.runtime).then(root => {
        this.canonicalRuntime = root;
        return root;
      }).catch(error => { this.canonicalRuntimePromise = undefined; throw error; });
    }
    const pinned = await this.canonicalRuntimePromise, current = await realpath(this.runtime);
    if (path.relative(pinned, current) !== '') throw new BridgeError('RUNTIME_IDENTITY_CHANGED',
      `Configured runtime '${this.runtime}' now resolves to a different directory. Create a new client after reviewing the replacement.`,
      { runtime: this.runtime, canonicalRuntime: pinned, currentCanonicalRuntime: current, outcome: 'not_submitted' });
    return pinned;
  }

  async confinedPath(...parts) {
    const root = await this.resolveRuntime(), expected = path.join(root, ...parts);
    const resolved = await realpath(path.join(this.runtime, ...parts));
    // Exact location, rather than merely a descendant, prevents cross-session
    // redirection inside the same root as well as redirection into another root.
    if (path.relative(expected, resolved) !== '') throw new BridgeError('INVALID_ARTIFACT',
      `IPC path resolves outside its exact runtime/session location: ${parts.join('/')}.`,
      { runtime: this.runtime, canonicalRuntime: root, ipcPath: parts.join('/'), outcome: 'not_submitted' });
    return resolved;
  }

  async validateQueues(sessionId) {
    await this.confinedPath('sessions');
    await this.confinedPath('sessions', sessionId);
    await this.confinedPath('sessions', sessionId, 'session.json');
    const requests = await this.confinedPath('sessions', sessionId, 'requests');
    const responses = await this.confinedPath('sessions', sessionId, 'responses');
    return { requests, responses };
  }

  async removeConfinedFile(...parts) {
    try { await unlink(await this.confinedPath(...parts)); } catch { /* Never clean up through a replaced path. */ }
  }

  async listSessions() {
    let root;
    let entries;
    try { root = await this.confinedPath('sessions'); entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('IPC_ERROR', `Cannot read KNIME runtime directory '${this.runtime}': ${error.message}`, { runtime: this.runtime });
    }
    const sessions = await Promise.all(entries.filter(entry => entry.isDirectory() && SESSION_ID.test(entry.name)).map(async entry => {
      try {
        await this.confinedPath('sessions', entry.name);
        const metadataPath = await this.confinedPath('sessions', entry.name, 'session.json');
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        const reason = unavailableReason(metadata, entry.name, this.staleMs);
        const reportedStatus=object(metadata)?metadata.status:undefined;
        let effectiveStatus=reason===null?'ready':reportedStatus==='stopped'?'stopped':'unavailable';
        if(reason) {
          if(Number.isSafeInteger(metadata?.pid)&&metadata.pid>0) {
            try {process.kill(metadata.pid,0);if(/Heartbeat is stale/.test(reason))effectiveStatus='stale';else if(reportedStatus==='starting')effectiveStatus='starting';}
            catch(error){if(error.code==='ESRCH')effectiveStatus='dead';}
          }
        }
        return { ...(object(metadata) ? metadata : {}), id: entry.name, runtime: this.runtime, reportedStatus, status:effectiveStatus,effectiveStatus,alive: reason === null, ...(reason ? { reason } : {}) };
      } catch (error) {
        return { id: entry.name, runtime: this.runtime, alive: false, reason: `Invalid or unreadable session metadata: ${error.message}` };
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
      this.assertIdentity(selected);
      if (!selected.alive) throw new BridgeError('SESSION_UNAVAILABLE', `KNIME session '${id}' in runtime '${this.runtime}' is unavailable: ${selected.reason}`, { sessionId: id, runtime: this.runtime, outcome: 'not_submitted' });
      return selected;
    }
    const alive = sessions.filter(session => session.alive);
    if (alive.length === 0) throw new BridgeError('NO_LIVE_SESSION', 'No live KNIME bridge session is ready. Launch KNIME with the bridge and inspect sessions.', { runtime: this.runtime, sessions });
    if (alive.length > 1) throw new BridgeError('AMBIGUOUS_SESSION', `Multiple KNIME sessions are ready in runtime '${this.runtime}'. Select an explicit session ID before operating a workflow. A session ID cannot select another runtime.`, { runtime: this.runtime, sessions: alive.map(({ id, workspace, pid }) => ({ id, workspace, pid })) });
    return alive[0];
  }

  assertIdentity(selected) {
    const pinned = this.pinnedIdentities.get(selected.id), current = sessionIdentity(selected);
    if (pinned && !identityMatches(pinned, current)) throw new BridgeError('SESSION_IDENTITY_CHANGED',
      `KNIME session '${selected.id}' changed process identity in runtime '${this.runtime}'. Create a new client after reviewing the replacement; this request was not submitted.`,
      { runtime: this.runtime, sessionId: selected.id, pinnedIdentity: pinned, currentIdentity: current, outcome: 'not_submitted' });
  }

  // Descriptor-only diagnosis: heartbeat/ready flags cannot prove the native queue responds.
  async connectionDiagnostics({ session = this.session } = {}) {
    if (session !== undefined) validateSessionId(session);
    const sessions = await this.listSessions();
    let selected = sessions.find(s => s.id === session), selectionError;
    if (session === undefined) {
      const ready = sessions.filter(s => s.alive);
      if (ready.length === 1) selected = ready[0];
      else selectionError = { code: ready.length ? 'AMBIGUOUS_SESSION' : 'NO_LIVE_SESSION', message: 'Choose a ready session in this runtime.' };
    } else if (!selected) selectionError = { code: 'NO_SESSION', message: 'The requested session does not exist in this runtime. A session ID cannot switch runtime roots.' };
    const pinnedIdentity = selected ? this.pinnedIdentities.get(selected.id) ?? null : this.pinnedIdentities.get(session) ?? null;
    const identity = selected ? sessionIdentity(selected) : null;
    const matches = pinnedIdentity && identity ? identityMatches(pinnedIdentity, identity) : null;
    const age = selected ? Date.now() - Date.parse(selected.heartbeat) : NaN;
    return { runtime: this.runtime, canonicalRuntime: this.canonicalRuntime ?? null, requestedSessionId: session ?? null, sessionId: selected?.id ?? session ?? null,
      identity, pinnedIdentity, identityMatches: matches,
      readiness: { ready: selected?.alive === true, reportedStatus: selected?.reportedStatus ?? null,
        effectiveStatus: selected?.effectiveStatus ?? 'unavailable', processAlive: processAlive(selected?.pid),
        heartbeatFresh: Number.isFinite(age) && Math.abs(age) <= this.staleMs, reason: selected?.reason ?? null },
      responsiveness: matches === false ? { status: 'not_probed', reason: 'Process identity changed.' } : this.responseObservations.get(selected?.id) ?? { status: 'not_probed' },
      ...(selectionError ? { selectionError } : {}), sessions,
      guidance: 'Runtime selection is a client startup boundary. Descriptor readiness does not prove native responsiveness; call health explicitly to observe a response.' };
  }

  async call(operation, args = {}, { session = this.session, timeoutMs = this.timeoutMs, precondition, operationId = randomUUID() } = {}) {
    this.lastReceipt = undefined;
    this.lastOperation = undefined;
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
    if (!this.pinnedIdentities.has(selected.id)) this.pinnedIdentities.set(selected.id, sessionIdentity(selected));
    let payload;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    try { payload = JSON.stringify({ id, operation, args, ...(precondition ? {precondition} : {}), expiresAt }); }
    catch (error) { throw new BridgeError('INVALID_ARGUMENT', `Arguments must be serializable JSON: ${error.message}`); }
    const {requests} = await this.validateQueues(selected.id);
    const requestPath = path.join(requests, `${id}.json`);
    const tempPath = `${requestPath}.tmp`;
    const payloadKey = selected.id + ':' + id;
    const parsedPayload = JSON.parse(payload);
    const payloadDigest = createHash('sha256').update(JSON.stringify(canonical({operation: parsedPayload.operation, args: parsedPayload.args, precondition: parsedPayload.precondition ?? null}))).digest('hex');
    const previousPayload = this.operationPayloads.get(payloadKey);
    if (previousPayload && previousPayload !== payloadDigest) throw new BridgeError('OPERATION_ID_REUSED', 'Operation UUID was already submitted by this client with a different payload. Use the original ID only to reconcile the original request.', { runtime: this.runtime, sessionId: selected.id, operationId: id, outcome: 'not_submitted' });
    const details = { requestId: id, operationId: id, sessionId: selected.id, runtime: this.runtime,
      identity: this.pinnedIdentities.get(selected.id), operation, outcome: 'unknown',
      submission: { state: 'not_submitted', publishedAt: null, expiresAt },
      reconciliation: reconciliationDetails(this.runtime, selected.id, id) };
    this.lastOperation = details;
    this.lastReceipt = undefined;
    let staged = false;
    try {
      await writeFile(tempPath, payload, { flag: 'wx', mode: 0o600 });
      staged = true;
      // Recheck after staging, immediately before publication. Never follows a replacement.
      await this.selectSession(selected.id);
      await this.validateQueues(selected.id);
      await this.confinedPath('sessions', selected.id, 'requests', `${id}.json.tmp`);
      await rename(tempPath, requestPath);
      details.submission = { state: 'published', publishedAt: new Date().toISOString(), expiresAt };
      this.operationPayloads.set(payloadKey, payloadDigest);
      if (this.operationPayloads.size > 1024) this.operationPayloads.delete(this.operationPayloads.keys().next().value);
    } catch (error) {
      if (staged) await this.removeConfinedFile('sessions', selected.id, 'requests', `${id}.json.tmp`);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('IPC_ERROR', `Could not publish the KNIME request: ${error.message}`, { ...details, outcome: 'not_submitted' });
    }

    // Once published, leave the request to the bridge. Timeout or client shutdown
    // cannot establish whether the engine has already applied a mutation.
    const deadline = performance.now() + timeoutMs;
    while (true) {
      let raw;
      try {
        await this.validateQueues(selected.id);
        const safeResponse = await this.confinedPath('sessions', selected.id, 'responses', `${id}.json`);
        raw = await readFile(safeResponse, 'utf8');
      }
      catch (error) {
        if (error instanceof BridgeError) throw new BridgeError(error.code, error.message, { ...error.details, ...details });
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
          await this.removeConfinedFile('sessions', selected.id, 'responses', `${id}.json`);
        }
        this.lastReceipt = response.receipt;
        this.responseObservations.set(selected.id, { status: 'responded', observedAt: new Date().toISOString(), operationId: id, operation });
        if (!response.ok) throw new BridgeError(response.error.code, response.error.message, { ...response.error.details, ...details,
          outcome: response.error.details?.outcome ?? details.outcome, ...(response.receipt ? { receipt: response.receipt } : {}) });
        return response.result;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        this.responseObservations.set(selected.id, { status: 'no_response', observedAt: new Date().toISOString(), operationId: id, operation, timeoutMs });
        throw new BridgeError('REQUEST_TIMEOUT', `KNIME session '${selected.id}' in runtime '${this.runtime}' did not respond within ${timeoutMs} ms; the outcome is unknown. Inspect the original operation receipt and workflow state. Transport expiry does not prove cancellation or prevent an accepted action completing. The request was not retried or cancelled.`, { ...details, timeoutMs });
      }
      await delay(Math.min(this.pollMs, remaining));
    }
  }
}
