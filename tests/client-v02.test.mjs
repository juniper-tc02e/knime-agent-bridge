import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {BridgeClient} from '../src/client.mjs';

async function setup(t,id='A') {
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-v02-client-'));
  t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
  const publish=async id=>{
    const dir=path.join(runtime,'sessions',id);
    await fs.mkdir(path.join(dir,'requests'),{recursive:true});
    await fs.mkdir(path.join(dir,'responses'),{recursive:true});
    await fs.writeFile(path.join(dir,'session.json'),JSON.stringify({id,pid:process.pid,heartbeat:new Date().toISOString(),status:'ready'}));
    return dir;
  };
  return {runtime,dir:await publish(id),publish,client:new BridgeClient({runtime,pollMs:5,timeoutMs:40})};
}
test('a selected session remains pinned when a different sole session appears',async t=>{
  const f=await setup(t);
  await assert.rejects(f.client.call('health'),{code:'REQUEST_TIMEOUT'});
  await fs.writeFile(path.join(f.dir,'session.json'),JSON.stringify({id:'A',pid:process.pid,heartbeat:new Date().toISOString(),status:'stopped'}));
  await f.publish('B');
  await assert.rejects(f.client.call('health'),{code:'SESSION_UNAVAILABLE'});
  assert.deepEqual(await fs.readdir(path.join(f.runtime,'sessions','B','requests')),[]);
});
test('request UUID and precondition survive an unknown timeout outcome',async t=>{
  const f=await setup(t), operationId=randomUUID();
  const precondition={contextId:'context',expected:{structure:'s',configuration:'c',layout:'l'}};
  await assert.rejects(f.client.call('layout.apply',{changes:[]},{operationId,precondition}),e=>e.details.operationId===operationId&&e.details.sessionId==='A');
  const request=JSON.parse(await fs.readFile(path.join(f.dir,'requests',operationId+'.json')));
  assert.deepEqual(request.precondition,precondition);
  assert.equal(request.id,operationId);
});
test('malformed operation identity and preconditions are rejected before submission',async t=>{
  const f=await setup(t);
  await assert.rejects(f.client.call('layout.apply',{}, {operationId:'../other'}),{code:'INVALID_ARGUMENT'});
  await assert.rejects(f.client.call('layout.apply',{}, {precondition:{contextId:'x',expected:[],extra:1}}),{code:'INVALID_ARGUMENT'});
  assert.deepEqual(await fs.readdir(path.join(f.dir,'requests')),[]);
});
