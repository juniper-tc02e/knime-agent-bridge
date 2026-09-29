import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForCondition} from '../src/wait.mjs';
function client(states){let index=0;const calls=[];return {calls,async call(op,args,options){calls.push({op,args,options});if(op==='desktop.uiState')return {blocked:false,responsive:true};return states[Math.min(index++,states.length-1)];}};}
test('wait observes completion without issuing another mutation',async()=>{
 const c=client([{state:'EXECUTING'},{state:'EXECUTED'}]);const r=await waitForCondition(c,{session:'s',condition:'execution',projectId:'p',nodeId:'root:1',timeoutMs:1000,pollMs:1});
 assert.equal(r.completed,true);assert.equal(r.status,'settled');assert.deepEqual(c.calls.filter(c=>c.op==='core.snapshot').map(c=>c.args.nodeId),['root:1','root:1']);assert.ok(c.calls.every(c=>['core.snapshot','desktop.uiState'].includes(c.op)));
});
test('wait reports a load modal and timeout without pretending completion',async()=>{
 const blocked={call:async()=>({blocked:true,responsive:true,shells:[{title:'Workflow Load'}]})};
 assert.equal((await waitForCondition(blocked,{session:'s',condition:'saved',projectId:'p',timeoutMs:100})).status,'blocked');
 const c=client([{state:'EXECUTING'}]);const r=await waitForCondition(c,{session:'s',condition:'execution',projectId:'p',timeoutMs:20,pollMs:1});assert.equal(r.completed,false);assert.equal(r.status,'timeout');
});
test('clean state is explicitly weaker than persisted-artifact verification',async()=>{
 const r=await waitForCondition(client([{dirty:false}]),{session:'s',condition:'saved',projectId:'p'});assert.equal(r.completed,true);assert.equal(r.persistenceVerified,false);
});
test('wait rejects ambiguous targets before native calls',async()=>{
 const c=client([]);await assert.rejects(waitForCondition(c,{session:'s',condition:'opened'}),/origin/);assert.equal(c.calls.length,0);
});

test('expired queued observations report timeout without replaying or claiming completion',async()=>{
 let calls=0;
 const c={async call(operation){calls++;assert.equal(operation,'desktop.uiState');throw Object.assign(new Error('Observation expired in queue'),{code:'REQUEST_EXPIRED'});}};
 const r=await waitForCondition(c,{session:'s',condition:'execution',projectId:'p',timeoutMs:100});
 assert.equal(r.status,'timeout');assert.equal(r.completed,false);assert.equal(r.outcome,'unknown');assert.equal(r.lastError.code,'REQUEST_EXPIRED');assert.equal(calls,1);
});
