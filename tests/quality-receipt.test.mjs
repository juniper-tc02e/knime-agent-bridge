import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QualityStore } from '../src/quality/store.mjs';
import { QualityManager, verifyWorkflowSchema } from '../src/quality/receipt.mjs';

const revisions = { structure:'s1',configuration:'c1',layout:'l1',execution:'e1' };
function fixture(requirements = {}) {
  const directory = mkdtempSync(path.join(tmpdir(),'knime-quality-'));
  const store = new QualityStore({directory});
  const context = {contextId:'ctx',scopeId:'root',revisions:{...revisions},dirty:false};
  const manager = new QualityManager({store,getContext:async()=>context});
  const begin = () => manager.begin({contextId:'ctx',requestedScopes:['root'],requiredDimensions:['visual'],dataChecks:[],fidelityRequirements:requirements});
  const capture = (scopeId='root') => manager.recordEvidence('capture',{contextId:'ctx',scopeId,sourceFrameId:`frame-${scopeId}`,sourceKind:'native-preview',revisions:{...context.revisions},layoutRevision:context.revisions.layout,freshness:'verified',renderer:{fontsReady:true},coverage:{complete:true,requiredTileIds:[`tile-${scopeId}`],omittedObjectIds:[]},artifacts:[{artifactId:`tile-${scopeId}`,role:'detail'}]});
  const check = c => manager.recordEvidence('layout-check',{contextId:'ctx',scopeId:c.scopeId,sourceFrameId:c.sourceFrameId,evidenceId:c.id,layoutRevision:c.layoutRevision,findings:[],coverage:{complete:true,gaps:[]}});
  const emit = c => manager.recordEvidence('image-emission',{contextId:'ctx',evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:c.coverage.requiredTileIds});
  const review = (taskId,c) => manager.review({taskId,evidenceIds:[c.id],frames:[{evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:c.coverage.requiredTileIds,received:true,readable:true,inspected:true,notes:'Inspected heading text, node labels and wire clearance in the detail tile.'}],dispositions:[]});
  return {store,manager,context,begin,capture,check,emit,review,directory};
}
test('task manifests query only event kinds and retain mixed change/respecification ordering',async()=>{
  const f=fixture(),task=await f.begin(),requested=[];
  f.store.put('context-release',{contextId:'unrelated-history'});
  const list=f.store.list.bind(f.store);
  f.store.list=kind=>{assert.ok(['task-change','task-respecification'].includes(kind),'Manifest must not scan unrelated history');requested.push(kind);return list(kind);};
  f.manager.recordChange({taskId:task.taskId,contextId:'ctx7',scopeId:'root:7',dimensions:['visual'],uncertain:true});
  await f.manager.respecify({taskId:task.taskId,source:'user',reason:'Synthetic scope revision for regression',requestedScopes:['root','root:7'],requiredDimensions:['visual','persistence']});
  f.manager.recordChange({taskId:task.taskId,contextId:'ctx',scopeId:'root',dimensions:['executionData']});
  f.store.put('task-change',{taskId:'foreign-task',scopeRevision:50,contextId:'foreign',scopeId:'foreign',dimensions:['configuration']});
  const manifest=f.manager.manifest(task.taskId);
  assert.equal(manifest.scopeRevision,3);assert.deepEqual(manifest.requestedScopes,['root','root:7']);
  assert.deepEqual(manifest.changedScopes,['root:7','root']);assert.deepEqual(manifest.uncertainScopes,['root:7']);
  assert.deepEqual(manifest.contextIds,['ctx','ctx7']);assert.deepEqual(manifest.requiredDimensions,['visual','persistence','executionData']);
  assert.deepEqual(new Set(requested),new Set(['task-change','task-respecification']));
});
test('capture production, emission and exact image review are independent quality gates',async()=>{
  const f=fixture();const task=await f.begin();const c=f.capture();const ch=f.check(c);
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
  f.emit(c);
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
  await f.review(task.taskId,c);
  const done=await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]});
  assert.equal(done.readyForCompletion,true);assert.equal(done.dimensions.visual.deliveryBasis,'agent-attested');
  assert.equal(done.dimensions.visual.hostScaling,'unknown');
});
test('missing required tile, stale revision and changed nested scope block completion',async()=>{
  const f=fixture();const task=await f.begin();const c=f.capture();const ch=f.check(c);f.emit(c);await f.review(task.taskId,c);
  f.context.revisions.layout='l2';
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
  f.context.revisions.layout='l1';f.manager.recordChange({taskId:task.taskId,contextId:'ctx',scopeId:'root:7',dimensions:['visual']});
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
  const n=f.capture('root:7');const nch=f.check(n);
  await assert.rejects(f.review(task.taskId,n),/emitted/i);
  f.emit(n);await f.review(task.taskId,n);
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id,n.id,nch.id]})).readyForCompletion,true);
});
test('forged assessment status and unscoped generic review never enter trusted records',async()=>{
  const f=fixture();const task=await f.begin();
  await assert.rejects(f.manager.assess({taskId:task.taskId,evidenceIds:[],dimensions:{visual:'passed'}}),/unknown|unrecognized/i);
  await assert.rejects(f.manager.review({taskId:task.taskId,evidenceIds:[],notes:'looks good'}),/frames|unrecognized/i);
  assert.equal(verifyWorkflowSchema.safeParse({action:'assess',taskId:task.taskId,evidenceIds:[],requiredDimensions:[]}).success,false);
  await assert.rejects(f.manager.assess({taskId:task.taskId,evidenceIds:['invented']}),/unknown|missing/i);
});
test('host confirmation cannot be replaced by agent delivery attestation',async()=>{
  const f=fixture({hostConfirmedDelivery:true});const task=await f.begin();const c=f.capture();const ch=f.check(c);f.emit(c);await f.review(task.taskId,c);
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
  f.manager.recordEvidence('host-delivery',{contextId:'ctx',evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:c.coverage.requiredTileIds,confirmed:true,hostScaling:'1:1'});
  const receipt=await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]});
  assert.equal(receipt.readyForCompletion,true);assert.equal(receipt.dimensions.visual.deliveryBasis,'host-confirmed');
});
test('dirty saved previews and incomplete geometry cannot claim live visual completion',async()=>{
  const f=fixture();const task=await f.begin();const original=f.capture();const c=f.manager.recordEvidence('capture',{...original,id:undefined,sourceKind:'saved-preview'});const ch=f.check(c);f.emit(c);await f.review(task.taskId,c);f.context.dirty=true;
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
});
test('real defects require user sourced scoped exception and remain accepted_exception',async()=>{
  const f=fixture();const task=await f.begin();const c=f.capture();f.emit(c);await f.review(task.taskId,c);
  const ch=f.manager.recordEvidence('layout-check',{contextId:'ctx',scopeId:'root',sourceFrameId:c.sourceFrameId,evidenceId:c.id,layoutRevision:'l1',coverage:{complete:true,gaps:[]},findings:[{id:'collision',severity:'error',kind:'wire-text'}]});
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
  await f.manager.respecify({taskId:task.taskId,reason:'User accepts this exact legacy wire placement.',source:'user',exceptions:[{scopeId:'root',dimension:'visual',findingId:'collision',reason:'Preserve legacy appearance.',source:'user'}]});
  const result=await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]});
  assert.equal(result.readyForCompletion,true);assert.equal(result.dimensions.visual.status,'accepted_exception');
});
test('records survive restart, resist overwrite, and fail closed on disk tampering',async()=>{
  const f=fixture();const c=f.capture();const reopened=new QualityStore({directory:f.directory});
  assert.equal(reopened.get(c.id).sourceFrameId,'frame-root');assert.throws(()=>reopened.put('capture',{}, {id:c.id}),/exist|immutable/i);
  assert.throws(()=>{c.scopeId='other';},TypeError);
  const file=path.join(f.directory,`${c.id}.json`);const value=JSON.parse(readFileSync(file,'utf8'));value.payload.scopeId='other';writeFileSync(file,JSON.stringify(value));
  assert.throws(()=>reopened.get(c.id),/integrity|digest/i);
});
test('partial tile emission, expired artifacts and renderer uncertainty remain incomplete',async()=>{
  const f=fixture();const task=await f.begin();const original=f.capture();
  const c=f.manager.recordEvidence('capture',{...original,coverage:{complete:true,requiredTileIds:['one','two'],omittedObjectIds:[]},artifacts:[{artifactId:'one'},{artifactId:'two'}]});
  f.manager.recordEvidence('image-emission',{contextId:'ctx',evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:['one']});
  await assert.rejects(f.manager.review({taskId:task.taskId,evidenceIds:[c.id],frames:[{evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:['one','two'],received:true,readable:true,inspected:true,notes:'Reviewed labels and route clearances.'}]}),/emitted/i);
  for(const extra of [{expiresAt:'2020-01-01T00:00:00Z'},{freshness:'model-stable-render-unconfirmed'},{renderer:{fontsReady:false}},{coverage:{complete:false,requiredTileIds:['tile-root'],omittedObjectIds:['native-unknown']}}]) {
    const bad=f.manager.recordEvidence('capture',{...original,...extra});const ch=f.check(bad);f.emit(bad);await f.review(task.taskId,bad);
    assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[bad.id,ch.id]})).readyForCompletion,false);
  }
});
test('asynchronous save acknowledgement cannot satisfy persistence or hide a failed assertion',async()=>{
  const f=fixture();const task=await f.manager.begin({contextId:'ctx',requestedScopes:['root'],requiredDimensions:['persistence'],dataChecks:[],fidelityRequirements:{}});
  const args={taskId:task.taskId,dimension:'persistence',scopeId:'root',contextId:'ctx',revisions,coverage:{complete:true},checks:[{expected:'saved-hash',actual:'saved-hash'}],saveObserved:true,artifactVerified:true,artifactDigest:'saved-hash',operationStatus:'queued'};
  const queued=f.manager.recordEvidence('dimension-check',args);assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[queued.id]})).readyForCompletion,false);
  const failed=f.manager.recordEvidence('dimension-check',{...args,operationStatus:'applied',checks:[{expected:'saved-hash',actual:'other'}]});assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[failed.id]})).dimensions.persistence.status,'failed');
  const done=f.manager.recordEvidence('dimension-check',{...args,operationStatus:'applied'});assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[done.id]})).readyForCompletion,true);
});
test('declared value checks cannot be substituted with schema/count metadata',async()=>{
  const f=fixture();const task=await f.manager.begin({contextId:'ctx',requestedScopes:['root'],requiredDimensions:['executionData'],dataChecks:[{id:'value',scopeId:'root',kind:'data',expected:[['alpha',1]],coverage:'full'}],fidelityRequirements:{fullTableValues:true}});
  const args={taskId:task.taskId,dimension:'executionData',scopeId:'root',contextId:'ctx',revisions,coverage:{complete:true,tableValues:'sampled'},checks:[{id:'count',kind:'count',expected:1,actual:1}]};
  const metadata=f.manager.recordEvidence('dimension-check',args);assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[metadata.id]})).readyForCompletion,false);
  const complete=f.manager.recordEvidence('dimension-check',{...args,coverage:{complete:true,tableValues:'full'},checks:[{id:'value',kind:'data',expected:[['alpha',1]],actual:[['alpha',1]],coverage:'full'}]});assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[complete.id]})).readyForCompletion,true);
});
test('exceptions are scoped and cannot excuse a defect in another changed scope',async()=>{
  const f=fixture();const task=await f.begin();f.manager.recordChange({taskId:task.taskId,contextId:'ctx',scopeId:'nested',dimensions:['visual']});
  const root=f.capture(),nested=f.capture('nested');f.emit(root);f.emit(nested);await f.review(task.taskId,root);await f.review(task.taskId,nested);
  const rootCheck=f.check(root);const nestedCheck=f.manager.recordEvidence('layout-check',{contextId:'ctx',scopeId:'nested',sourceFrameId:nested.sourceFrameId,evidenceId:nested.id,layoutRevision:'l1',findings:[{id:'wire',severity:'error'}],coverage:{complete:true,gaps:[]}});
  await f.manager.respecify({taskId:task.taskId,source:'user',reason:'Accept root wire only.',exceptions:[{scopeId:'root',dimension:'visual',findingId:'wire',reason:'Preserve root historical design.',source:'user'}]});
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[root.id,rootCheck.id,nested.id,nestedCheck.id]})).readyForCompletion,false);
});
test('post-review semantic edits invalidate visual evidence even at the same layout revision',async()=>{
  const f=fixture();const task=await f.begin();const c=f.capture();const ch=f.check(c);f.emit(c);await f.review(task.taskId,c);f.context.revisions.configuration='new-config';
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]})).readyForCompletion,false);
});
test('matching immutable tile pages combine only after each emitted region is attested',async()=>{
  const f=fixture();const task=await f.begin();const common={contextId:'ctx',scopeId:'root',sourceFrameId:'large-frame',sourceArtifact:{sha256:'source-hash'},sourceKind:'native-preview',revisions,layoutRevision:'l1',freshness:'verified',renderer:{fontsReady:true,version:'1'},coverage:{complete:false,resourcesComplete:true,geometryComplete:true,requiredTileIds:['one','two'],omittedObjectIds:[],gaps:[]}};
  const first=f.manager.recordEvidence('capture',{...common,artifacts:[{artifactId:'one',sha256:'hash1'}]}),second=f.manager.recordEvidence('capture',{...common,artifacts:[{artifactId:'two',sha256:'hash2'}]});const checked=f.check(first);
  const attest=async(c,tile)=>{f.manager.recordEvidence('image-emission',{contextId:'ctx',evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:[tile]});return f.manager.review({taskId:task.taskId,evidenceIds:[c.id],frames:[{evidenceId:c.id,sourceFrameId:c.sourceFrameId,tileIds:[tile],received:true,readable:true,inspected:true,notes:'Reviewed occupied labels and all wire routes in this detail region.'}],dispositions:[]});};
  await attest(first,'one');assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[first.id,checked.id]})).readyForCompletion,false);
  await attest(second,'two');assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[first.id,second.id,checked.id]})).readyForCompletion,true);
  const wrong=f.manager.recordEvidence('capture',{...common,sourceArtifact:{sha256:'changed-source'},artifacts:[{artifactId:'two',sha256:'hash2'}]});await attest(wrong,'two');
  assert.equal((await f.manager.assess({taskId:task.taskId,evidenceIds:[first.id,wrong.id,checked.id]})).readyForCompletion,false);
});
test('a changed scope observed during assessment cannot be omitted by a cached manifest',async()=>{
 const f=fixture();const task=await f.begin();const c=f.capture();const ch=f.check(c);f.emit(c);await f.review(task.taskId,c);
 const inspect=f.manager.getContext;let calls=0;
 f.manager.getContext=async(...args)=>{if(++calls===2)f.manager.recordChange({taskId:task.taskId,contextId:'ctx',scopeId:'new-nested',dimensions:['visual']});return inspect(...args);};
 const receipt=await f.manager.assess({taskId:task.taskId,evidenceIds:[c.id,ch.id]});
 assert.equal(receipt.readyForCompletion,false);assert.ok(receipt.taskScope.scopes.includes('new-nested'));
});
test('a successful assertion from another task cannot override this task failed preservation',async()=>{
 const f=fixture();const begin=()=>f.manager.begin({contextId:'ctx',requestedScopes:['root'],requiredDimensions:['structure']});const a=await begin(),b=await begin();
 const pass=f.manager.recordEvidence('dimension-check',{taskId:b.taskId,contextId:'ctx',scopeId:'root',dimension:'structure',revisions,coverage:{complete:true},checks:[{expected:'s1',actual:'s1'}]});
 const fail=f.manager.recordEvidence('dimension-check',{taskId:a.taskId,contextId:'ctx',scopeId:'root',dimension:'structure',revisions,coverage:{complete:true},checks:[{expected:'old',actual:'s1'}]});
 assert.equal((await f.manager.assess({taskId:a.taskId,evidenceIds:[pass.id,fail.id]})).readyForCompletion,false);
});
