import { randomUUID } from 'node:crypto';
import { canonical, digest } from '../quality/store.mjs';
import { layoutChangeSchema, layoutValue } from './plan.mjs';

const same=(a,b)=>a!==undefined&&b!==undefined&&canonical(a)===canonical(b);
function validatePrecondition(current,precondition) {
  if(!precondition||current.contextId!==precondition.contextId)throw new Error('CONTEXT_CHANGED: plan context does not match.');
  for(const dim of ['structure','configuration','layout'])if(typeof precondition.expected?.[dim]!=='string'||current.revisions?.[dim]!==precondition.expected[dim])throw new Error(`REVISION_CONFLICT: ${dim} precondition changed or is missing.`);
}
export function compareIntegrity(before,after) {
  const checks=['structureDigest','configurationDigest','executionStates','executedOutputFingerprints'].map(kind=>({kind,status:same(before?.[kind],after?.[kind])?'passed':'failed'}));
  const coverage=before?.coverage&&after?.coverage;
  const complete=coverage&&['before','after'].every(which=>{const c=which==='before'?before.coverage:after.coverage;return c.structure==='full'&&c.configuration==='full'&&['native-preserved','not_present'].includes(c.protectedSettings)&&c.tableValues==='full';});
  return {status:checks.some(c=>c.status==='failed')?'failed':complete?'passed':'not_checked',checks,reason:complete?'Full selected-output integrity compared.':'Full table/protected settings coverage is incomplete; counts/schema alone do not prove value preservation.'};
}

/** Sequential guarded native commands. Never retries, executes nodes, or blindly undoes partial work. */
export async function applyLayout({planId,precondition}, {store,getContext,readCanvas,applyChange,integritySnapshot,renderAndCheck}={}) {
  if(!store||![getContext,readCanvas,applyChange].every(f=>typeof f==='function'))throw new Error('Plan store, current state and guarded native apply adapters are required.');
  const plan=store.get(planId);if(plan.recordKind!=='layout-plan')throw new Error('Unknown layout plan.');
  if(store.list('layout-application').some(r=>r.planId===planId))throw new Error('Plan already claimed/applied; reconcile the existing operation rather than replay.');
  const current=await getContext(plan.contextId);validatePrecondition(current,precondition);validatePrecondition(current,{contextId:plan.contextId,expected:plan.beforeRevisions});
  const claimId=`apply-${planId}`;
  try{store.put('layout-application',{planId,contextId:plan.contextId,operationId:claimId,status:'running'},{id:claimId});}catch(error){if(error.code==='EEXIST')throw new Error('Plan already claimed/applied; reconcile the existing operation rather than replay.');throw error;}
  const operationId=randomUUID(),progress=[],postconditions=[];let before=null,after=null,latest=current,failed=null,attempted=0;
  try {
    if(integritySnapshot)before=await integritySnapshot(current);
    for(const change of plan.changes) {
      layoutChangeSchema.parse(change);const observed=await getContext(plan.contextId);
      validatePrecondition(observed,{contextId:plan.contextId,expected:latest.revisions});
      const canvas=await readCanvas(observed);
      if(!same(layoutValue(canvas,change),change.before))throw new Error(`REVISION_CONFLICT: old layout value for ${change.objectId} changed.`);
      attempted++;
      const native=await applyChange(change,{contextId:plan.contextId,expected:observed.revisions});
      progress.push({index:progress.length,change,nativeOperationId:native?.operationId??null,status:native?.status??'unknown',guardCoverage:native?.guardCoverage??'unverified'});
      if(native?.status!=='applied'||native?.guardCoverage!=='apply-time')throw new Error('Native command is not confirmed applied with an apply-time guard; reconcile without retry.');
      latest=await getContext(plan.contextId);
      if(!same(latest.revisions.structure,current.revisions.structure)||!same(latest.revisions.configuration,current.revisions.configuration))throw new Error('Semantic revisions changed during layout application.');
      const readback=await readCanvas(latest);
      if(!same(layoutValue(readback,change),change.after))throw new Error(`Read-back differs for ${change.objectId}.`);
      progress.at(-1).readbackVerified=true;
    }
  } catch(error){failed={message:error.message,code:error.code??null,details:error.details??null};}
  try {latest=await getContext(plan.contextId);if(integritySnapshot){after=await integritySnapshot(latest);const comparison=compareIntegrity(before,after);postconditions.push({kind:'integrity',status:comparison.status,evidenceIds:[],details:comparison});}}catch(error){postconditions.push({kind:'integrity',status:'not_checked',evidenceIds:[],reason:error.message});}
  if(!postconditions.some(p=>p.kind==='integrity'))postconditions.push({kind:'integrity',status:'not_checked',evidenceIds:[],reason:'No integrity adapter supplied.'});
  try {
    if(renderAndCheck){const checked=await renderAndCheck(latest);const severe=(checked.findings??[]).filter(f=>['error','high','critical'].includes(f.severity));postconditions.push({kind:'native-render',status:checked.coverage?.complete===true&&!severe.length?'passed':severe.length?'failed':'not_checked',evidenceIds:checked.evidenceId?[checked.evidenceId]:[],remainingFindings:checked.findings??[],alternative:severe.length?'Widen the affected gutter or move its group; automatic repair is bounded to three planned cycles.':null});}
    else postconditions.push({kind:'native-render',status:'not_checked',evidenceIds:[],reason:'Native post-edit capture adapter unavailable.'});
  }catch(error){postconditions.push({kind:'native-render',status:'not_checked',evidenceIds:[],reason:error.message});}
  const status=failed?(attempted>0?'partially_applied':'failed'):'applied';
  return store.put('layout-operation',{operationId,planId,claimId,contextId:plan.contextId,sessionId:current.sessionId??null,payloadDigest:digest(plan.changes),guardCoverage:progress.length&&progress.every(p=>p.guardCoverage==='apply-time')?'apply-time':'unverified',beforeRevisions:current.revisions,afterRevisions:latest?.revisions??null,status,progress,postconditions,error:failed,rollback:'not_attempted',completionVerified:status==='applied'&&postconditions.every(p=>p.status==='passed'),integrityBefore:before,integrityAfter:after},{id:operationId});
}
