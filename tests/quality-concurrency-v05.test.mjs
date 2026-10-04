import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {QualityStore} from '../src/quality/store.mjs';import {QualityManager} from '../src/quality/receipt.mjs';
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'knime-task-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new QualityStore({directory:dir}),context={contextId:'ctx',scopeId:'root',dirty:false,revisions:{structure:'s',configuration:'c',layout:'l',execution:'e'}};const manager=new QualityManager({store,getContext:async()=>context});const task=await manager.begin({contextId:'ctx',requestedScopes:['root'],requiredDimensions:['structure']});return {store,manager,task,context};}
test('concurrent asynchronous task events receive distinct revisions',async t=>{
 const f=await setup(t);const events=await Promise.all(Array.from({length:6},(_,i)=>f.manager.recordChangeAsync({taskId:f.task.taskId,contextId:'ctx',scopeId:'root:'+i,dimensions:['visual']})));
 assert.equal(new Set(events.map(e=>e.scopeRevision)).size,6);assert.equal(f.manager.manifest(f.task.taskId).scopeRevision,6);
});
test('scope appended during final context read cannot evade assessment freshness',async t=>{
 const f=await setup(t),record=f.store.put('dimension-check',{taskId:f.task.taskId,contextId:'ctx',scopeId:'root',revisions:f.context.revisions,dimension:'structure',coverage:{complete:true},checks:[{kind:'literal',expected:1,actual:1}]});let calls=0;
 f.manager.getContext=async()=>{if(++calls===3)f.manager.recordChange({taskId:f.task.taskId,contextId:'ctx',scopeId:'new-nested',dimensions:['persistence']});return f.context;};
 const r=await f.manager.assess({taskId:f.task.taskId,evidenceIds:[record.id]});assert.equal(r.readyForCompletion,false);assert.ok(r.taskScope.scopes.includes('new-nested'));
});
test('an independent equal-revision task event changes manifest digest',async t=>{
 const f=await setup(t);f.manager.recordChange({taskId:f.task.taskId,contextId:'ctx',scopeId:'first',dimensions:['structure']});const before=f.manager.manifest(f.task.taskId);
 f.store.put('task-change',{taskId:f.task.taskId,contextId:'ctx',scopeId:'second',dimensions:['persistence'],scopeRevision:1,uncertain:false});const after=f.manager.manifest(f.task.taskId);
 assert.equal(after.scopeRevision,before.scopeRevision);assert.notEqual(after.eventDigest,before.eventDigest);
});
test('concurrent respecification shares revision allocation with a change',async t=>{
 const f=await setup(t);const events=await Promise.all([f.manager.recordChangeAsync({taskId:f.task.taskId,contextId:'ctx',scopeId:'root',dimensions:['visual']}),f.manager.respecify({taskId:f.task.taskId,source:'user',reason:'Synthetic explicit requirement expansion',requiredDimensions:['structure','persistence']})]);assert.equal(new Set(events.map(e=>e.scopeRevision)).size,2);
});
test('sync task append rejects a queued write and failed queue recovers',async t=>{
 const f=await setup(t),pending=f.manager.recordChangeAsync({taskId:f.task.taskId,contextId:'ctx',scopeId:'root',dimensions:['invalid']});
 assert.throws(()=>f.manager.recordChange({taskId:f.task.taskId,contextId:'ctx',scopeId:'root',dimensions:['structure']}),/pending|recordChangeAsync/);await assert.rejects(pending);
 const next=await f.manager.recordChangeAsync({taskId:f.task.taskId,contextId:'ctx',scopeId:'root',dimensions:['structure']});assert.equal(next.scopeRevision,1);
});
test('independent equal-revision scope addition invalidates full assessment',async t=>{
 const f=await setup(t);f.manager.recordChange({taskId:f.task.taskId,contextId:'ctx',scopeId:'root',dimensions:['structure']});
 const record=f.store.put('dimension-check',{taskId:f.task.taskId,contextId:'ctx',scopeId:'root',revisions:f.context.revisions,dimension:'structure',coverage:{complete:true},checks:[{expected:1,actual:1}]});let calls=0;
 f.manager.getContext=async()=>{if(++calls===3)f.store.put('task-change',{taskId:f.task.taskId,contextId:'ctx',scopeId:'independent-child',dimensions:['persistence'],scopeRevision:1,uncertain:false});return f.context;};
 const r=await f.manager.assess({taskId:f.task.taskId,evidenceIds:[record.id]});assert.equal(r.readyForCompletion,false);assert.ok(r.taskScope.scopes.includes('independent-child'));assert.equal(r.taskScope.scopeRevision,1);
});
