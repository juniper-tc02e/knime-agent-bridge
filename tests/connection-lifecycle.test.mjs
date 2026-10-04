import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeClient} from '../src/client.mjs';
import {readOperation} from '../src/operations.mjs';

async function fixture(t, id='same-session') {
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-connection-'));
  t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
  const dir=path.join(runtime,'sessions',id);
  for(const part of ['requests','responses','operations'])await fs.mkdir(path.join(dir,part),{recursive:true});
  const metadata={id,pid:process.pid,startedAt:'2026-10-03T01:00:00Z',workspace:'file:/synthetic/工作区/',bridgeVersion:'0.4.0',bundleFingerprint:'bundle-a',capabilityFingerprint:'cap-a',heartbeat:new Date().toISOString(),status:'ready'};
  const publish=changes=>fs.writeFile(path.join(dir,'session.json'),JSON.stringify({...metadata,...changes}));
  await publish({});
  // Total IPC budget includes selection/staging; these fixtures require actual publication.
  return {runtime,dir,metadata,publish,client:new BridgeClient({runtime,session:id,pollMs:2,timeoutMs:300})};
}

test('connection diagnostics separate descriptor readiness from native responsiveness without publishing',async t=>{
  const f=await fixture(t),d=await f.client.connectionDiagnostics();
  assert.equal(d.runtime,f.runtime);assert.equal(d.sessionId,'same-session');
  assert.equal(d.identity.pid,process.pid);assert.equal(d.identity.startedAt,'2026-10-03T01:00:00Z');
  assert.equal(d.identity.workspace,'file:/synthetic/工作区/');assert.equal(d.identity.bundleFingerprint,'bundle-a');assert.equal(d.identity.capabilityFingerprint,'cap-a');
  assert.equal(d.readiness.ready,true);assert.equal(d.responsiveness.status,'not_probed');
  assert.deepEqual(await fs.readdir(path.join(f.dir,'requests')),[]);
  await f.publish({status:'starting'});
  const starting=await f.client.connectionDiagnostics();
  assert.equal(starting.readiness.ready,false);assert.equal(starting.readiness.processAlive,true);assert.equal(starting.responsiveness.status,'not_probed');
});

test('independent runtime roots never discover or publish to a session from the other root',async t=>{
  const a=await fixture(t,'A'),b=await fixture(t,'B');
  await assert.rejects(a.client.call('health',{}, {session:'B'}),e=>e.code==='NO_SESSION'&&e.details.runtime===a.runtime);
  assert.deepEqual(await fs.readdir(path.join(b.dir,'requests')),[]);
  const ambiguous=await fs.mkdtemp(path.join(os.tmpdir(),'knime-empty-root-'));t.after(()=>fs.rm(ambiguous,{recursive:true,force:true}));
  await assert.rejects(new BridgeClient({runtime:ambiguous}).call('health'),e=>e.code==='NO_LIVE_SESSION'&&e.details.runtime===ambiguous);
  assert.deepEqual(await fs.readdir(path.join(a.dir,'requests')),[]);
});

for(const [field,value] of [['pid',2147483647],['startedAt','2026-10-03T02:00:00Z'],['workspace','file:/different/'],['bundleFingerprint','bundle-b'],['capabilityFingerprint','cap-b']]) {
  test(`same-session ${field} replacement fails closed before second publication`,async t=>{
    const f=await fixture(t);
    await assert.rejects(f.client.call('health'),{code:'REQUEST_TIMEOUT'});
    await f.publish({[field]:value});
    await assert.rejects(f.client.call('core.execute',{}),e=>e.code==='SESSION_IDENTITY_CHANGED'&&e.details.runtime===f.runtime&&e.details.outcome==='not_submitted');
    assert.equal((await fs.readdir(path.join(f.dir,'requests'))).length,1);
    const d=await f.client.connectionDiagnostics();assert.equal(d.identityMatches,false);assert.equal(d.pinnedIdentity[field],f.metadata[field]);
  });
}

test('heartbeat refresh does not replace process identity',async t=>{
  const f=await fixture(t);await assert.rejects(f.client.call('health'),{code:'REQUEST_TIMEOUT'});
  await f.publish({heartbeat:new Date().toISOString()});
  await assert.rejects(f.client.call('health'),{code:'REQUEST_TIMEOUT'});
  assert.equal((await fs.readdir(path.join(f.dir,'requests'))).length,2);
});

test('timeout exposes transport expiry and reconcile-only identity; later receipts never repeat effects',async t=>{
  const f=await fixture(t),operationId=randomUUID();let effects=0;
  const dispatch=(async()=>{
    const target=path.join(f.dir,'requests',operationId+'.json');
    const fixtureDeadline=performance.now()+3000;
    while(true){try{await fs.readFile(target);break;}catch(e){if(e.code!=='ENOENT')throw e;if(performance.now()>=fixtureDeadline)throw new Error('Synthetic request was never published within fixture bound.');await delay(2);}}
    effects++;
    await delay(65);
    await fs.writeFile(path.join(f.dir,'operations',operationId+'.json'),JSON.stringify({operationId,sessionId:'same-session',status:'running',nativeDispatch:'returned',completionVerified:false,acceptedAt:new Date().toISOString(),expiresAt:'2026-10-10T01:00:00Z'}));
  })();
  try {await assert.rejects(f.client.call('core.execute',{projectId:'synthetic'}, {operationId}),e=>{
    assert.equal(e.details.runtime,f.runtime);assert.equal(e.details.submission.state,'published');
    assert.ok(Number.isFinite(Date.parse(e.details.submission.expiresAt)));assert.ok(Number.isFinite(Date.parse(e.details.submission.publishedAt)));
    assert.equal(e.details.reconciliation.operationId,operationId);assert.equal(e.details.reconciliation.resubmits,false);assert.equal(e.details.outcome,'unknown');return true;
  });} finally {await dispatch;}
  const published=JSON.parse(await fs.readFile(path.join(f.dir,'requests',operationId+'.json'),'utf8'));
  assert.equal(published.expiresAt,f.client.lastOperation.submission.expiresAt);
  for(let i=0;i<3;i++){
    const receipt=await readOperation(f.client,{sessionId:'same-session',operationId});
    assert.equal(receipt.runtime,f.runtime);assert.equal(receipt.status,'running');assert.equal(receipt.completionVerified,false);
    assert.equal(receipt.reconciliation.resubmits,false);assert.equal(receipt.outcome,'unknown');
  }
  assert.equal(effects,1);assert.equal((await fs.readdir(path.join(f.dir,'requests'))).length,1);
  const diagnostics=await f.client.connectionDiagnostics();assert.equal(diagnostics.responsiveness.status,'no_response');
});

test('read-only native failure preserves receipt uncertainty without inventing a mutation',async t=>{
  const f=await fixture(t),operationId=randomUUID();
  await fs.writeFile(path.join(f.dir,'responses',operationId+'.json'),JSON.stringify({id:operationId,ok:false,error:{code:'DISCOVERY_FAILED',message:'Unavailable node repository',details:{nativeDispatch:'returned',journalError:'final journal write failed'}},receipt:{operationId,sessionId:'same-session',status:'failed',nativeDispatch:'returned'}}));
  await assert.rejects(f.client.call('core.nodes.search',{query:'synthetic'}, {operationId}),e=>{
    assert.equal(e.code,'DISCOVERY_FAILED');assert.equal(e.details.runtime,f.runtime);assert.equal(e.details.journalError,'final journal write failed');
    assert.equal(e.details.reconciliation.resubmits,false);assert.equal(e.details.receipt.status,'failed');assert.equal(e.details.mutation,undefined);return true;
  });
});

test('identical explicit ID redelivery remains supported but altered payload is rejected locally',async t=>{
  const f=await fixture(t),operationId=randomUUID();
  await assert.rejects(f.client.call('core.execute',{projectId:'synthetic'}, {operationId}),{code:'REQUEST_TIMEOUT'});
  await fs.unlink(path.join(f.dir,'requests',operationId+'.json'));
  await fs.writeFile(path.join(f.dir,'responses',operationId+'.json'),JSON.stringify({id:operationId,ok:true,result:{accepted:true,completionVerified:false}}));
  assert.equal((await f.client.call('core.execute',{projectId:'synthetic'}, {operationId})).accepted,true);
  await fs.unlink(path.join(f.dir,'requests',operationId+'.json'));
  await assert.rejects(f.client.call('core.execute',{projectId:'different'}, {operationId}),e=>e.code==='OPERATION_ID_REUSED'&&e.details.outcome==='not_submitted');
  assert.deepEqual(await fs.readdir(path.join(f.dir,'requests')),[]);
});

test('identity replacement during staging removes the temporary request before publication',async t=>{
  const f=await fixture(t);let reads=0;
  class ReplacingClient extends BridgeClient {
    async listSessions(){if(++reads===2)await f.publish({startedAt:'2026-10-03T04:00:00Z'});return super.listSessions();}
  }
  const client=new ReplacingClient({runtime:f.runtime,session:'same-session'});
  await assert.rejects(client.call('core.execute',{}),{code:'SESSION_IDENTITY_CHANGED'});
  assert.deepEqual(await fs.readdir(path.join(f.dir,'requests')),[]);
});

test('journal retention expiry never implies cancellation or deletes the recorded result',async t=>{
  const f=await fixture(t),operationId=randomUUID();
  await fs.writeFile(path.join(f.dir,'operations',operationId+'.json'),JSON.stringify({operationId,sessionId:'same-session',status:'applied',nativeDispatch:'returned',expiresAt:'2000-01-01T00:00:00Z',completionVerified:true}));
  const receipt=await readOperation(f.client,{sessionId:'same-session',operationId});
  assert.equal(receipt.status,'applied');assert.equal(receipt.retention.expired,true);assert.equal(receipt.retention.cancellationImplied,false);assert.equal(receipt.completionVerified,true);
});

test('reconciliation detects replaced identity without publishing a new native request',async t=>{
  const f=await fixture(t),operationId=randomUUID();
  await assert.rejects(f.client.call('core.execute',{}, {operationId}),{code:'REQUEST_TIMEOUT'});
  await fs.writeFile(path.join(f.dir,'operations',operationId+'.json'),JSON.stringify({operationId,sessionId:'same-session',status:'running',nativeDispatch:'returned'}));
  await f.publish({startedAt:'2026-10-03T03:00:00Z'});
  const receipt=await readOperation(f.client,{sessionId:'same-session',operationId});
  assert.equal(receipt.status,'unknown_after_restart');assert.equal(receipt.recordedStatus,'running');assert.match(receipt.uncertainty,/identity/);
  assert.equal((await fs.readdir(path.join(f.dir,'requests'))).length,1);
});

test('an operation journal linked to another runtime is rejected before receipt discovery',async t=>{
  const a=await fixture(t,'A'),b=await fixture(t,'B'),operationId=randomUUID();
  await fs.writeFile(path.join(b.dir,'operations',operationId+'.json'),JSON.stringify({operationId,sessionId:'A',status:'applied'}));
  await fs.rm(path.join(a.dir,'operations'),{recursive:true});
  await fs.symlink(path.join(b.dir,'operations'),path.join(a.dir,'operations'),'junction');
  await assert.rejects(readOperation(a.client,{sessionId:'A',operationId}),{code:'INVALID_ARTIFACT'});
});

test('a native outcome survives transport enrichment without losing authoritative runtime identity',async t=>{
  const f=await fixture(t),operationId=randomUUID();
  await fs.writeFile(path.join(f.dir,'responses',operationId+'.json'),JSON.stringify({id:operationId,ok:false,error:{code:'PRECONDITION_FAILED',message:'Not dispatched',details:{outcome:'not_applied',nativeDispatch:'not_started',runtime:'incorrect-native-value'}}}));
  await assert.rejects(f.client.call('core.execute',{}, {operationId}),e=>e.details.outcome==='not_applied'&&e.details.nativeDispatch==='not_started'&&e.details.runtime===f.runtime);
});

test('a pre-submission rejection cannot retain a prior call receipt or operation identity',async t=>{
  const f=await fixture(t),operationId=randomUUID();
  await fs.writeFile(path.join(f.dir,'responses',operationId+'.json'),JSON.stringify({id:operationId,ok:true,result:{ok:true},receipt:{operationId,status:'applied'}}));
  await f.client.call('health',{}, {operationId});assert.equal(f.client.lastReceipt.operationId,operationId);
  await f.publish({startedAt:'2026-10-03T06:00:00Z'});
  await assert.rejects(f.client.call('core.execute'),{code:'SESSION_IDENTITY_CHANGED'});
  assert.equal(f.client.lastReceipt,undefined);assert.equal(f.client.lastOperation,undefined);
});

for (const component of ['sessions','session','requests','responses']) {
  test(`${component} junction cannot route request publication into another runtime`,async t=>{
    const a=await fixture(t),b=await fixture(t),source=component==='sessions'?path.join(a.runtime,'sessions'):component==='session'?a.dir:path.join(a.dir,component);
    const target=component==='sessions'?path.join(b.runtime,'sessions'):component==='session'?b.dir:path.join(b.dir,component);
    await fs.rename(source,source+'-original');await fs.symlink(target,source,'junction');
    await assert.rejects(a.client.call('core.execute',{}),e=>e.code!=='REQUEST_TIMEOUT'&&e.details.runtime===a.runtime);
    assert.deepEqual(await fs.readdir(path.join(b.dir,'requests')),[]);
    assert.deepEqual(await fs.readdir(path.join(b.dir,'responses')),[]);
  });
}

test('a request queue replaced by a junction during staging cannot publish or clean up files in another root',async t=>{
  const a=await fixture(t),b=await fixture(t),operationId=randomUUID();let selections=0;
  const queue=path.join(a.dir,'requests'),otherTemp=path.join(b.dir,'requests',operationId+'.json.tmp');
  await fs.writeFile(otherTemp,'other runtime owns this file');
  class ReplacingQueueClient extends BridgeClient {
    async selectSession(id){
      if(++selections===2){await fs.rename(queue,queue+'-staged');await fs.symlink(path.join(b.dir,'requests'),queue,'junction');}
      return super.selectSession(id);
    }
  }
  const client=new ReplacingQueueClient({runtime:a.runtime,session:'same-session',pollMs:2,timeoutMs:35});
  await assert.rejects(client.call('core.execute',{}, {operationId}),e=>e.code==='INVALID_ARTIFACT'&&e.details.outcome==='not_submitted');
  assert.equal(await fs.readFile(otherTemp,'utf8'),'other runtime owns this file');
  assert.equal((await fs.readdir(path.join(b.dir,'requests'))).filter(n=>n.endsWith('.json')).length,0);
  assert.equal((await fs.readdir(queue+'-staged')).filter(n=>n.endsWith('.json')).length,0);
});

test('a configured runtime junction is pinned to its original canonical root and cannot switch later',async t=>{
  const a=await fixture(t),b=await fixture(t),aliases=await fs.mkdtemp(path.join(os.tmpdir(),'knime-runtime-alias-'));
  t.after(()=>fs.rm(aliases,{recursive:true,force:true}));
  const alias=path.join(aliases,'runtime');await fs.symlink(a.runtime,alias,'junction');
  const client=new BridgeClient({runtime:alias,session:'same-session',pollMs:2,timeoutMs:35});
  const initial=await client.connectionDiagnostics();assert.equal(initial.readiness.ready,true);assert.equal(initial.canonicalRuntime,await fs.realpath(a.runtime));
  await fs.rm(alias);await fs.symlink(b.runtime,alias,'junction');
  await assert.rejects(client.call('core.execute'),e=>e.code==='RUNTIME_IDENTITY_CHANGED'&&e.details.runtime===alias);
  assert.deepEqual(await fs.readdir(path.join(b.dir,'requests')),[]);
});

test('a response queue replaced after publication is rejected without consuming another runtime response',async t=>{
  const a=await fixture(t),b=await fixture(t),operationId=randomUUID(),queue=path.join(a.dir,'responses');
  const foreign=path.join(b.dir,'responses',operationId+'.json');
  await fs.writeFile(foreign,JSON.stringify({id:operationId,ok:true,result:{foreign:true}}));
  const requestPath=path.join(a.dir,'requests',operationId+'.json');
  const replace=(async()=>{
    for(let i=0;i<100;i++){try{await fs.readFile(requestPath);break;}catch(e){if(e.code!=='ENOENT')throw e;await delay(2);}}
    await fs.rename(queue,queue+'-original');await fs.symlink(path.join(b.dir,'responses'),queue,'junction');
  })();
  try{await assert.rejects(a.client.call('core.execute',{}, {operationId,timeoutMs:100}),e=>e.code==='INVALID_ARTIFACT'&&e.details.outcome==='unknown');}finally{await replace;}
  assert.equal(JSON.parse(await fs.readFile(foreign,'utf8')).result.foreign,true);
});

test('operation reconciliation cannot follow a replaced configured runtime alias',async t=>{
  const a=await fixture(t),b=await fixture(t),operationId=randomUUID(),aliases=await fs.mkdtemp(path.join(os.tmpdir(),'knime-reconcile-alias-'));
  t.after(()=>fs.rm(aliases,{recursive:true,force:true}));
  const alias=path.join(aliases,'runtime');await fs.symlink(a.runtime,alias,'junction');
  const client=new BridgeClient({runtime:alias,session:'same-session'});await client.connectionDiagnostics();
  await fs.writeFile(path.join(b.dir,'operations',operationId+'.json'),JSON.stringify({operationId,sessionId:'same-session',status:'applied'}));
  await fs.rm(alias);await fs.symlink(b.runtime,alias,'junction');
  await assert.rejects(readOperation(client,{sessionId:'same-session',operationId}),e=>e.code==='RUNTIME_IDENTITY_CHANGED'&&e.details.runtime===alias);
  assert.deepEqual(await fs.readdir(path.join(b.dir,'requests')),[]);
});

test('failed exclusive staging cannot remove a temporary request owned by another caller',async t=>{
  const f=await fixture(t),operationId=randomUUID(),temporary=path.join(f.dir,'requests',operationId+'.json.tmp');
  await fs.writeFile(temporary,'another caller owns this staged request');
  await assert.rejects(f.client.call('core.execute',{}, {operationId}),{code:'IPC_ERROR'});
  assert.equal(await fs.readFile(temporary,'utf8'),'another caller owns this staged request');
});
