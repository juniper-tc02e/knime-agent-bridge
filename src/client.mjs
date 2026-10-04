import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {resolveProfile,profileCompatibility} from './profiles.mjs';
import {startTrace} from './trace.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION = /^[A-Za-z][A-Za-z0-9_.]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceVersion=JSON.parse(readFileSync(path.join(projectRoot,'package.json'),'utf8')).version;
const sourceFingerprint=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
export const CLIENT_OPERATION=Symbol.for('knime.agent.client-operation');

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
    transport:'local_durable_journal',tool:{name:'knime_operation',arguments:{sessionId,operationId}},
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
  constructor({ runtime, session, timeoutMs = 30000, pollMs = 50, staleMs = 15000, profile, profiles, profilesFile, traceDirectory, traceMaxEvents=100 } = {}) {
    this.profile=resolveProfile({profile,profiles,profilesFile,runtime,session});
    this.sourceIdentity={source:projectRoot,version:sourceVersion,sha256:sourceFingerprint};
    runtime=this.profile?.runtime??runtime??defaultRuntimeDirectory();session=this.profile?.session??session;
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
    if(!Number.isInteger(traceMaxEvents)||traceMaxEvents<1||traceMaxEvents>1000)throw new BridgeError('INVALID_ARGUMENT','traceMaxEvents must be between 1 and 1000.');
    this.traceDirectory=traceDirectory;this.traceMaxEvents=traceMaxEvents;this.traceReferences=new Map();
    this.pendingOperations=new Map();this.observationAbort=new AbortController();
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
    if(this.profile&&id!==this.profile.session)throw new BridgeError('PROFILE_CONFLICT','Session override conflicts with selected profile.',{profile:this.profile.name,outcome:'not_submitted'});
    if (id !== undefined) validateSessionId(id);
    const sessions = await this.listSessions();
    if (id !== undefined) {
      const selected = sessions.find(session => session.id === id);
      if (!selected) throw new BridgeError('NO_SESSION', `KNIME session '${id}' was not found. Run sessions to inspect available instances.`, { sessionId: id, runtime: this.runtime });
      this.assertIdentity(selected);
      const compatibility=profileCompatibility(this.profile,selected);
      if(compatibility.compatible===false)throw new BridgeError('PROFILE_INCOMPATIBLE','Selected native identity does not match the configured profile. No request was submitted.',{profile:this.profile.name,compatibility,outcome:'not_submitted'});
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
  async connectionDiagnostics({ session = this.session, detail=false } = {}) {
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
      route:{profile:this.profile?.name??null,configurationSource:this.profile?.source??'runtime/session options or KNIME_AGENT_RUNTIME/default',source:projectRoot,sourceVersion,sourceFingerprint},compatibility:profileCompatibility(this.profile,selected),
      lifecycle:this.lifecycleDiagnostics?.()??null,tracing:{enabled:!!this.traceDirectory,retainedReferences:this.traceReferences.size,maxEvents:this.traceMaxEvents},
      identity, pinnedIdentity, identityMatches: matches,
      readiness: { ready: selected?.alive === true, reportedStatus: selected?.reportedStatus ?? null,
        effectiveStatus: selected?.effectiveStatus ?? 'unavailable', processAlive: processAlive(selected?.pid),
        heartbeatFresh: Number.isFinite(age) && Math.abs(age) <= this.staleMs, reason: selected?.reason ?? null },
      responsiveness: matches === false ? { status: 'not_probed', reason: 'Process identity changed.' } : this.responseObservations.get(selected?.id) ?? { status: 'not_probed' },
      ...(selectionError ? { selectionError } : {}), sessionCounts:{total:sessions.length,ready:sessions.filter(s=>s.alive).length,unavailable:sessions.filter(s=>!s.alive).length},
      sessions:detail?sessions:sessions.slice(0,8).map(({id,pid,status,alive,reason,bridgeVersion})=>({id,pid,status,alive,reason,bridgeVersion})),sessionsTruncated:!detail&&sessions.length>8,
      guidance: 'Runtime selection is a client startup boundary. Descriptor readiness does not prove native responsiveness; call health explicitly to observe a response.' };
  }

  stopObserving(reason='stdio_eof') {this.observationAbort.abort(reason);}

  async call(operation,args={},options={}) {
    this.lastOperation=undefined;this.lastReceipt=undefined;
    const timeoutMs=options.timeoutMs??this.timeoutMs;positive(timeoutMs,'timeoutMs');
    const operationId=options.operationId??randomUUID(),started=performance.now();
    if(!UUID.test(operationId)||typeof operation!=='string'||!OPERATION.test(operation)||!object(args))throw new BridgeError('INVALID_ARGUMENT','Operation, JSON object arguments and UUID operationId are required.');
    const deadline={owner:'client_ipc',startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+timeoutMs).toISOString(),timeoutMs};
    const context={deadline,monotonicDeadline:started+timeoutMs,operationId,submission:{state:'not_submitted',publishedAt:null,expiresAt:deadline.expiresAt}};
    const trace=startTrace({directory:this.traceDirectory,maxEvents:this.traceMaxEvents,operationId,operation,deadline,runtime:this.runtime,profile:this.profile?.name});context.trace=trace;
    trace?.event('client_start');
    try {const result=await this.callInternal(operation,args,{...options,operationId,timeoutMs},context);context.outcome='native_result_returned';context.result=result;return result;}
    catch(error){context.outcome=context.nativeResultReturned?'native_result_returned':context.submission.state==='published'?'submitted_outcome_unknown':'not_submitted';
      if(error instanceof BridgeError)error.details={...error.details,requestId:operationId,operationId,operation,runtime:this.runtime,...(context.sessionId?{sessionId:context.sessionId,identity:context.identity}:{}),deadline:{...deadline,remainingMs:Math.max(0,Math.floor(context.monotonicDeadline-performance.now()))},submission:context.submission,state:context.outcome,outcome:error.details.outcome??(context.submission.state==='published'?'unknown':'not_submitted'),...(context.sessionId?{reconciliation:reconciliationDetails(this.runtime,context.sessionId,operationId)}:{})};
      context.error=error;throw error;
    }finally {
      this.pendingOperations.delete(operationId);
      if(trace){trace.event('client_end');const ref=await trace.finish(context);context.traceReference=ref;this.traceReferences.set(operationId,ref);if(this.traceReferences.size>128)this.traceReferences.delete(this.traceReferences.keys().next().value);if(context.error instanceof BridgeError)context.error.details.trace=ref;}
      if(context.result!==null&&typeof context.result==='object')Object.defineProperty(context.result,CLIENT_OPERATION,{value:{operationId,sessionId:context.sessionId,deadline,submission:context.submission,state:context.outcome,receipt:context.receipt,...(context.traceReference?{trace:context.traceReference}:{})},enumerable:false});
    }
  }

  async callInternal(operation, args = {}, { session = this.session, timeoutMs = this.timeoutMs, precondition, operationId = randomUUID() } = {},context) {
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
    context.sessionId=selected.id;context.identity=sessionIdentity(selected);context.trace?.event('session_selected');
    const assertBudget=()=>{if(this.observationAbort.signal.aborted)throw new BridgeError('OBSERVER_DISCONNECTED','Client transport closed; inspect the original receipt. Native outcome remains unknown.',{outcome:context.submission.state==='published'?'unknown':'not_submitted'});if(performance.now()>=context.monotonicDeadline){if(context.submission.state==='published')this.responseObservations.set(selected.id,{status:'no_response',observedAt:new Date().toISOString(),operationId:id,operation,timeoutMs});throw new BridgeError('REQUEST_TIMEOUT','Client IPC deadline expired. Inspect the original operation receipt. No replay or cancellation was performed.',{outcome:context.submission.state==='published'?'unknown':'not_submitted',stage:context.submission.state==='published'?'filesystem_poll':'selection_or_publication'});}};
    assertBudget();
    // Once used, this client stays with that process even if another instance
    // later becomes the sole live session. Explicit selection remains possible.
    if (this.session === undefined) this.session = selected.id;
    if (!this.pinnedIdentities.has(selected.id)) this.pinnedIdentities.set(selected.id, sessionIdentity(selected));
    let payload;
    const expiresAt = context.deadline.expiresAt;
    try { payload = JSON.stringify({ id, operation, args, ...(precondition ? {precondition} : {}), expiresAt, ...(context.trace?{trace:true}:{}) }); }
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
    context.trace&&(context.trace.counts.requestBytes=Buffer.byteLength(payload));
    let staged = false;
    try {
      await writeFile(tempPath, payload, { flag: 'wx', mode: 0o600 });
      staged = true;
      context.trace?.event('staged');
      // Recheck after staging, immediately before publication. Never follows a replacement.
      await this.selectSession(selected.id);
      await this.validateQueues(selected.id);
      await this.confinedPath('sessions', selected.id, 'requests', `${id}.json.tmp`);
      assertBudget();
      this.pendingOperations.set(id,{operationId:id,sessionId:selected.id,operation,deadline:context.deadline,submission:{state:'publication_in_progress',expiresAt},outcome:'submitted_outcome_unknown'});
      await rename(tempPath, requestPath);
      details.submission = { state: 'published', publishedAt: new Date().toISOString(), expiresAt };
      context.submission=details.submission;this.pendingOperations.set(id,{operationId:id,sessionId:selected.id,operation,deadline:context.deadline,submission:context.submission,outcome:'submitted_outcome_unknown'});context.trace?.event('published');
      this.operationPayloads.set(payloadKey, payloadDigest);
      if (this.operationPayloads.size > 1024) this.operationPayloads.delete(this.operationPayloads.keys().next().value);
    } catch (error) {
      if (staged) await this.removeConfinedFile('sessions', selected.id, 'requests', `${id}.json.tmp`);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('IPC_ERROR', `Could not publish the KNIME request: ${error.message}`, { ...details, outcome: 'not_submitted' });
    }

    // Once published, leave the request to the bridge. Timeout or client shutdown
    // cannot establish whether the engine has already applied a mutation.
    const deadline = context.monotonicDeadline;
    while (true) {
      assertBudget();if(context.trace)context.trace.counts.polls++;
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
        if(context.trace)context.trace.counts.resultBytes=Buffer.byteLength(raw);context.trace?.event('result_read');
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
        // Preserve this response before trace persistence or another call can
        // replace the compatibility-only lastReceipt field.
        context.receipt = response.receipt === undefined ? undefined : structuredClone(response.receipt);
        this.lastReceipt = response.receipt;
        context.nativeResultReturned=true;
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
      try {await delay(Math.min(this.pollMs, remaining),undefined,{signal:this.observationAbort.signal});}
      catch(error){if(error.name==='AbortError')assertBudget();throw error;}
    }
  }
}
