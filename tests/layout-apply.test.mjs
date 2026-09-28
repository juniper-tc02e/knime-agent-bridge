import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QualityStore } from '../src/quality/store.mjs';
import { planLayout } from '../src/layout/plan.mjs';
import { applyLayout } from '../src/layout/apply.mjs';

function fixture() {
  const store=new QualityStore({directory:mkdtempSync(path.join(tmpdir(),'knime-apply-'))});
  const context={contextId:'ctx',revisions:{structure:'s',configuration:'c',layout:'l',execution:'e'}};
  const canvas={contextId:'ctx',scopeId:'root',evidenceId:'e',sourceFrameId:'f',layoutRevision:'l',nodes:[{id:'a',position:{x:0,y:0},bounds:{x:0,y:0,width:50,height:30}},{id:'b',position:{x:0,y:50},bounds:{x:0,y:50,width:50,height:30}}],connections:[],annotations:[],texts:[],coverage:{complete:true}};
  const changes=canvas.nodes.map(n=>({kind:'node-position',objectId:n.id,before:n.position,after:{x:100,y:n.position.y}}));
  const plan=planLayout({context,geometry:canvas,changes},{store});
  const integrity=()=>({structureDigest:'s',configurationDigest:'c',layoutDigest:context.revisions.layout,executionStates:{a:'EXECUTED',b:'EXECUTED'},executedOutputFingerprints:[{digest:'values'}],coverage:{structure:'full',configuration:'full',protectedSettings:'not_present',tableValues:'full'}});
  const deps={store,getContext:async()=>structuredClone(context),readCanvas:async()=>structuredClone(canvas),integritySnapshot:async()=>integrity(),applyChange:async(change,precondition)=>{assert.equal(precondition.expected.layout,context.revisions.layout);canvas.nodes.find(n=>n.id===change.objectId).position=change.after;context.revisions.layout+='x';return {guardCoverage:'apply-time',status:'applied'};},renderAndCheck:async()=>({evidenceId:'rendered',findings:[],coverage:{complete:true}})};
  return {store,context,canvas,plan,deps};
}
test('guarded layout apply reads back exact values and preserves semantic/data fingerprints',async()=>{
  const f=fixture();const op=await applyLayout({planId:f.plan.planId,precondition:{contextId:'ctx',expected:{...f.context.revisions}}},f.deps);
  assert.equal(op.status,'applied');assert.equal(op.postconditions.find(p=>p.kind==='integrity').status,'passed');assert.equal(op.postconditions.find(p=>p.kind==='native-render').status,'passed');
  assert.equal(f.canvas.nodes[0].position.x,100);
  await assert.rejects(applyLayout({planId:f.plan.planId,precondition:{contextId:'ctx',expected:{...f.context.revisions}}},f.deps),/already|replay/i);
});
test('mid-apply failure stays partial and does not blindly undo concurrent work',async()=>{
  const f=fixture();const apply=f.deps.applyChange;let count=0;
  f.deps.applyChange=async(...args)=>{if(++count===2){f.canvas.nodes[1].position={x:333,y:444};f.context.revisions.layout='user-change';throw new Error('Concurrent edit');}return apply(...args);};
  const op=await applyLayout({planId:f.plan.planId,precondition:{contextId:'ctx',expected:{...f.context.revisions}}},f.deps);
  assert.equal(op.status,'partially_applied');assert.equal(f.canvas.nodes[0].position.x,100);assert.equal(f.canvas.nodes[1].position.x,333);assert.equal(op.rollback,'not_attempted');
});
