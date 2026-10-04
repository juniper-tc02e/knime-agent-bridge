import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {BridgeClient,CLIENT_OPERATION} from '../src/client.mjs';
import {waitForCondition} from '../src/wait.mjs';

async function fixture(t) {
 const runtime=await mkdtemp(path.join(os.tmpdir(),'knime-v05-client-'));
 const directory=path.join(runtime,'sessions','synthetic');
 await mkdir(path.join(directory,'requests'),{recursive:true});await mkdir(path.join(directory,'responses'));
 await writeFile(path.join(directory,'session.json'),JSON.stringify({id:'synthetic',pid:process.pid,startedAt:new Date().toISOString(),heartbeat:new Date().toISOString(),status:'ready',bridgeVersion:'0.5.0',bundleFingerprint:'sha256-fixture',knimeVersion:'5.12.0',workspace:'synthetic'}));
 t.after(()=>rm(runtime,{recursive:true,force:true}));return {runtime,directory};
}
test('named profile rejects wrong native bundle before publishing any UUID',async t=>{
 const f=await fixture(t);
 const c=new BridgeClient({profile:'isolated',profiles:{isolated:{runtime:f.runtime,session:'synthetic',bridgeVersion:'0.5.0',bundleFingerprint:'wrong'}}});
 await assert.rejects(c.call('health',{}, {timeoutMs:50}),{code:'PROFILE_INCOMPATIBLE'});
 assert.deepEqual(await readdir(path.join(f.directory,'requests')),[]);
 const d=await c.connectionDiagnostics();assert.equal(d.compatibility.compatible,false);assert.equal(d.route.profile,'isolated');
});
test('named profile reads a relative runtime and never overrides session silently',async t=>{
 const f=await fixture(t),file=path.join(f.runtime,'profiles.json');
 await writeFile(file,JSON.stringify({schemaVersion:1,profiles:{isolated:{runtime:'.',session:'synthetic',bridgeVersion:'0.5.0',bundleFingerprint:'sha256-fixture'}}}));
 const c=new BridgeClient({profile:'isolated',profilesFile:file});assert.equal(c.runtime,f.runtime);
 await assert.rejects(c.selectSession('other'),{code:'PROFILE_CONFLICT'});
 assert.throws(()=>new BridgeClient({profile:'isolated',profilesFile:file,runtime:path.dirname(f.runtime)}),{code:'PROFILE_CONFLICT'});
});
test('client total deadline includes slow selection and refuses late publication',async t=>{
 const f=await fixture(t),c=new BridgeClient({runtime:f.runtime,session:'synthetic'}),select=c.selectSession.bind(c);
 c.selectSession=async(...args)=>{await delay(70);return select(...args);};
 const started=performance.now();await assert.rejects(c.call('health',{}, {timeoutMs:40}),e=>e.code==='REQUEST_TIMEOUT'&&e.details.outcome==='not_submitted'&&e.details.deadline.owner==='client_ipc');
 assert.ok(performance.now()-started<160);assert.deepEqual(await readdir(path.join(f.directory,'requests')),[]);
});
test('trace is bounded and preserves original UUID, bytes and deadlines without raw payloads',async t=>{
 const f=await fixture(t),c=new BridgeClient({runtime:f.runtime,session:'synthetic',timeoutMs:500,pollMs:5,traceDirectory:path.join(f.runtime,'traces'),traceMaxEvents:4});
 const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';let error;
 try {await c.call('core.snapshot',{secret:'do-not-record'},{operationId:id});}catch(e){error=e;}
 assert.equal(error.code,'REQUEST_TIMEOUT');assert.equal(error.details.submission.state,'published');
 const ref=error.details.trace;assert.equal(ref.operationId,id);const raw=await readFile(ref.path,'utf8'),trace=JSON.parse(raw);
 assert.equal(raw.includes('do-not-record'),false);assert.equal(trace.operationId,id);assert.ok(trace.events.length<=4);assert.ok(trace.counts.polls>0);assert.ok(trace.counts.requestBytes>0);assert.equal(trace.deadline.expiresAt,error.details.deadline.expiresAt);assert.equal(trace.submission.state,'published');
 assert.deepEqual(error.details.reconciliation.tool,{name:'knime_operation',arguments:{sessionId:'synthetic',operationId:id}});
});
test('observer preserves last observation and stops before dispatching unusable residual reads',async()=>{
 const calls=[];const c={async call(op){calls.push(op);if(op==='desktop.uiState'){await delay(45);return {blocked:false};}return {state:'EXECUTING'};}};
 const r=await waitForCondition(c,{session:'s',condition:'execution',projectId:'p',timeoutMs:130,pollMs:1,minReadBudgetMs:100});
 assert.equal(r.status,'timeout');assert.equal(r.expiration,'observer_expired');assert.equal(r.deadline.owner,'observer');assert.deepEqual(calls,['desktop.uiState']);assert.equal(r.completed,false);
});
test('observer expiry retains a previous running observation instead of replacing it with null',async()=>{
 let ui=0;const c={async call(op){if(op==='desktop.uiState'){ui++;await delay(ui===1?20:420);return {blocked:false};}return {state:'EXECUTING',nodeId:'n'};}};
 const r=await waitForCondition(c,{session:'s',condition:'execution',projectId:'p',timeoutMs:500,pollMs:1,minReadBudgetMs:100});
 assert.equal(r.expiration,'observer_expired');assert.deepEqual(r.observation,{state:'EXECUTING',nodeId:'n'});assert.equal(ui,2);
});
test('traces reject malformed UUIDs without producing path artifacts',async t=>{
 const f=await fixture(t),directory=path.join(f.runtime,'traces'),c=new BridgeClient({runtime:f.runtime,traceDirectory:directory});
 await assert.rejects(c.call('health',{}, {operationId:'../bad'}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(readdir(directory),{code:'ENOENT'});
});

test('overlapping replies keep the original receipt while another call finishes during trace persistence',{timeout:10000},async t=>{
 const f=await fixture(t),directory=path.join(f.runtime,'traces'),c=new BridgeClient({runtime:f.runtime,session:'synthetic',timeoutMs:3000,pollMs:5,traceDirectory:directory});
 const firstId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',secondId='bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
 let releaseTrace,traceStarted;const traceGate=new Promise(resolve=>{releaseTrace=resolve;}),firstTraceStarted=new Promise(resolve=>{traceStarted=resolve;});
 const originalWrite=fs.writeFile,calls=[];
 fs.writeFile=async(file,...args)=>{if(String(file).startsWith(path.join(directory,'client-trace-'+firstId+'-'))){traceStarted();await traceGate;}return originalWrite(file,...args);};
 syncBuiltinESMExports();
 t.after(async()=>{releaseTrace();fs.writeFile=originalWrite;syncBuiltinESMExports();c.stopObserving('test_cleanup');await Promise.allSettled(calls);});
 const bounded=async(promise)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Concurrency fixture barrier expired.')),3000);})]);}finally{clearTimeout(timer);}};
 const reply=async(id,tag)=>{
  await bounded((async()=>{while(!(await readdir(path.join(f.directory,'requests'))).includes(id+'.json'))await delay(5);})());
  await originalWrite(path.join(f.directory,'responses',id+'.json'),JSON.stringify({id,ok:true,result:{tag},receipt:{operationId:id,status:'succeeded'}}));
 };
 const first=c.call('core.snapshot',{}, {operationId:firstId});calls.push(first);await reply(firstId,'first');await bounded(firstTraceStarted);
 const second=c.call('core.snapshot',{}, {operationId:secondId});calls.push(second);await reply(secondId,'second');const b=await bounded(second);
 // The shared compatibility field now points at B while A is still in finally.
 assert.equal(c.lastReceipt.operationId,secondId);releaseTrace();const a=await bounded(first);
 assert.equal(a[CLIENT_OPERATION].operationId,firstId);assert.equal(a[CLIENT_OPERATION].receipt?.operationId,firstId);
 assert.equal(b[CLIENT_OPERATION].operationId,secondId);assert.equal(b[CLIENT_OPERATION].receipt?.operationId,secondId);
 assert.equal(a[CLIENT_OPERATION].trace.operationId,firstId);assert.equal(b[CLIENT_OPERATION].trace.operationId,secondId);
 assert.equal(a.tag,'first');assert.equal(b.tag,'second');
});
