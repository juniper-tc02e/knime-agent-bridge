import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {needsGuard,targetArgs} from './helpers/guarded-native.mjs';

const runtime = process.env.KNIME_AGENT_RUNTIME || path.resolve('runtime');
export async function nativeCall(operation, args = {}, timeoutMs = 30000) {
  let precondition;
  if(needsGuard(operation,args)) {
    try {const context=await nativeCall('context.bind',targetArgs(operation,args),timeoutMs);precondition={contextId:context.contextId,expected:context.revisions??{}};}
    catch(error) {if(!/not found|not loaded|unknown.*project/i.test(error.message))throw error;}
  }
  const sessions = await fs.readdir(path.join(runtime, 'sessions')).catch(() => []);
  const active = [];
  for (const id of sessions) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(runtime,'sessions',id,'session.json'),'utf8'));
      if (meta.status === 'ready' && Date.now()-Date.parse(meta.heartbeat)<15000) active.push(meta);
    } catch {}
  }
  assert.equal(active.length,1,'Expected exactly one ready live KNIME bridge');
  const dir=path.join(runtime,'sessions',active[0].id), id=randomUUID();
  const req=path.join(dir,'requests',id+'.json');
  await fs.writeFile(req+'.tmp',JSON.stringify({id,operation,args,...(precondition?{precondition}:{})}));
  await fs.rename(req+'.tmp',req);
  const response=path.join(dir,'responses',id+'.json');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    try {
      const reply=JSON.parse(await fs.readFile(response,'utf8'));
      await fs.unlink(response);
      if(!reply.ok) throw Object.assign(new Error(JSON.stringify(reply.error)),{bridgeError:reply.error});
      return reply.result;
    } catch(e) { if(e.code!=='ENOENT') throw e; }
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error('Native KNIME call timed out: '+operation);
}

test('bridge attaches to real KNIME 5.12 and discovers its live workflow service', async()=>{
  const health=await nativeCall('health');
  assert.match(health.knimeVersion,/^5\.12\./);
  assert.ok(health.services.includes('WorkflowService'));
  const app=await nativeCall('gateway.call',{method:'ApplicationService.getState',params:[]});
  assert.equal(typeof app,'object');
  assert.ok('openProjects' in app);
});
