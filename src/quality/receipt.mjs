import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, immutable, digest } from './store.mjs';

const id=z.string().trim().min(1).max(200);
export const dimensionSchema=z.enum(['structure','configuration','executionData','visual','persistence']);
const scopeArray=z.array(id).min(1).max(1000).refine(a=>new Set(a).size===a.length,'Duplicate scopes.');
const json=z.lazy(()=>z.union([z.string(),z.number().finite(),z.boolean(),z.null(),z.array(json),z.record(json)]));
export const dataCheckSchema=z.object({id,scopeId:id,nodeId:id.optional(),portIndex:z.number().int().nonnegative().optional(),kind:z.enum(['data','schema','count']),expected:json,coverage:z.enum(['full','sampled']).default('full')}).strict();
const fidelity=z.object({hostConfirmedDelivery:z.boolean().default(false),fullTableValues:z.boolean().default(false),protectedSettings:z.boolean().default(false),nativeViewport:z.boolean().default(false)}).strict();
const exception=z.object({scopeId:id,dimension:dimensionSchema,findingId:id,reason:z.string().trim().min(8),source:z.literal('user')}).strict();
const beginSchema=z.object({contextId:id,requestedScopes:scopeArray,requiredDimensions:z.array(dimensionSchema).min(1).refine(a=>new Set(a).size===a.length),dataChecks:z.array(dataCheckSchema).default([]),fidelityRequirements:fidelity.default({})}).strict();
const frame=z.object({evidenceId:id,sourceFrameId:id,tileIds:z.array(id).min(1),received:z.literal(true),readable:z.literal(true),inspected:z.literal(true),notes:z.string().trim().min(12)}).strict();
const disposition=z.object({findingId:id,scopeId:id,kind:z.literal('geometric-false-positive'),reason:z.string().trim().min(12),evidenceIds:z.array(id).min(1)}).strict();
const reviewSchema=z.object({taskId:id,evidenceIds:z.array(id).min(1),frames:z.array(frame).min(1),dispositions:z.array(disposition).default([])}).strict();
const assessSchema=z.object({taskId:id,evidenceIds:z.array(id)}).strict();
const respecifySchema=z.object({taskId:id,source:z.literal('user'),reason:z.string().trim().min(8),requestedScopes:scopeArray.optional(),requiredDimensions:z.array(dimensionSchema).min(1).optional(),exceptions:z.array(exception).default([])}).strict();
export const verifyWorkflowSchema=z.discriminatedUnion('action',[
  beginSchema.extend({action:z.literal('begin')}),reviewSchema.extend({action:z.literal('review')}),assessSchema.extend({action:z.literal('assess')}),respecifySchema.extend({action:z.literal('respecify')}),
]);
const dims=['structure','configuration','executionData','visual','persistence'];
const relevant={structure:['structure'],configuration:['structure','configuration'],executionData:['structure','configuration','execution'],visual:['structure','configuration','layout'],persistence:['structure','configuration','layout','execution']};
const unique=a=>[...new Set(a)];
const recordId=r=>r.id??r.evidenceId;
const equal=(a,b)=>a!==undefined&&b!==undefined&&canonical(a)===canonical(b);
const result=(status,reason,evidenceIds=[],extra={})=>({status,reason,evidenceIds:unique(evidenceIds),...extra});
const taskQueues=new WeakMap();

export class QualityManager {
  constructor({store,getContext,resolveEvidence}={}) {if(!store||typeof getContext!=='function')throw new Error('Quality store and getContext adapter required.');this.store=store;this.getContext=getContext;this.resolveEvidence=resolveEvidence;}
  recordEvidence(kind,payload,options={}) {return this.store.put(kind,payload,options);}
  async evidence(id) {try{return this.store.get(id);}catch(error){if(!this.resolveEvidence)throw error;const record=await this.resolveEvidence(id);if(!record)throw error;return immutable(record);}}
  manifest(taskId) {
    const base=this.store.get(taskId);if(base.recordKind!=='quality-task')throw new Error('Unknown quality task.');
    const events=[...this.store.list('task-change'),...this.store.list('task-respecification')].filter(e=>e.taskId===taskId).sort((a,b)=>a.scopeRevision-b.scopeRevision||a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
    return this.assembleManifest(base,events);
  }
  assembleManifest(base,events) {
    const manifest=structuredClone(base);
    manifest.eventDigest=digest(events);
    for(const event of events){manifest.scopeRevision=event.scopeRevision;if(event.recordKind==='task-change'){manifest.changedScopes=unique([...manifest.changedScopes,event.scopeId]);manifest.requiredDimensions=unique([...manifest.requiredDimensions,...event.dimensions]);manifest.contextIds=unique([...manifest.contextIds,event.contextId]);if(event.uncertain)manifest.uncertainScopes=unique([...manifest.uncertainScopes,event.scopeId]);}else {if(event.requestedScopes)manifest.requestedScopes=event.requestedScopes;if(event.requiredDimensions)manifest.requiredDimensions=event.requiredDimensions;manifest.exceptions.push(...event.exceptions);}}
    return immutable(manifest);
  }
  serialTask(taskId,action) {
    let queues=taskQueues.get(this.store);if(!queues){queues=new Map();taskQueues.set(this.store,queues);}
    const previous=queues.get(taskId)??Promise.resolve();const next=previous.catch(()=>{}).then(action);queues.set(taskId,next);
    return next.finally(()=>{if(queues.get(taskId)===next)queues.delete(taskId);});
  }
  async manifestAsync(taskId) {
    const base=await this.store.getAsync(taskId);if(base.recordKind!=='quality-task')throw new Error('Unknown quality task.');
    // Serialize scans of the shared discovery index. Values remain fresh disk reads.
    const events=[...await this.store.listAsync('task-change'),...await this.store.listAsync('task-respecification')].filter(e=>e.taskId===taskId).sort((a,b)=>a.scopeRevision-b.scopeRevision||a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
    return this.assembleManifest(base,events);
  }
  async recordChangeAsync(input) {
    const {taskId,contextId,scopeId,dimensions,operationId,uncertain=false}=input;
    return this.serialTask(taskId,async()=>{const m=await this.manifestAsync(taskId);scopeArray.parse([scopeId]);z.array(dimensionSchema).min(1).parse(dimensions);id.parse(contextId);
      return this.store.put('task-change',{taskId,contextId,scopeId,dimensions:unique(dimensions),operationId:operationId??null,uncertain,scopeRevision:m.scopeRevision+1});});
  }
  async begin(input) {
    const value=beginSchema.parse(input);await this.getContext(value.contextId);const taskId=randomUUID();
    return this.store.put('quality-task',{taskId,initialContextId:value.contextId,contextIds:[value.contextId],...value,changedScopes:[],uncertainScopes:[],scopeRevision:0,exceptions:[]},{id:taskId});
  }
  recordChange({taskId,contextId,scopeId,dimensions,operationId,uncertain=false}) {
    if(taskQueues.get(this.store)?.has(taskId))throw new Error('An asynchronous task write is pending; use recordChangeAsync to preserve revision allocation.');
    const m=this.manifest(taskId);scopeArray.parse([scopeId]);z.array(dimensionSchema).min(1).parse(dimensions);id.parse(contextId);
    return this.store.put('task-change',{taskId,contextId,scopeId,dimensions:unique(dimensions),operationId:operationId??null,uncertain,scopeRevision:m.scopeRevision+1});
  }
  async respecify(input) {
    const value=respecifySchema.parse(input);return this.serialTask(value.taskId,async()=>{const m=await this.manifestAsync(value.taskId);
      return this.store.put('task-respecification',{...value,scopeRevision:m.scopeRevision+1,authorizationBasis:'caller-declared-user-instruction',authorizationIndependentlyConfirmed:false});});
  }
  async review(input) {
    const value=reviewSchema.parse(input);const manifest=await this.manifestAsync(value.taskId);
    for(const attestation of value.frames) {
      if(!value.evidenceIds.includes(attestation.evidenceId))throw new Error('Review frame must reference an explicit evidence ID.');
      const c=await this.evidence(attestation.evidenceId);
      if(c.sourceFrameId!==attestation.sourceFrameId||!manifest.contextIds.includes(c.contextId))throw new Error('Review frame/context does not match immutable evidence.');
      const required=c.coverage?.requiredTileIds??[];const artifacts=(c.artifacts??[]).map(a=>a.artifactId);
      if(!required.length||attestation.tileIds.some(t=>!artifacts.includes(t)))throw new Error('Review references unknown tiles or lacks a coverage manifest.');
      const emitted=unique((await this.store.listAsync('image-emission')).filter(e=>e.evidenceId===attestation.evidenceId&&e.sourceFrameId===c.sourceFrameId).flatMap(e=>e.tileIds??[]));
      if(attestation.tileIds.some(t=>!emitted.includes(t)))throw new Error('Review requires the exact tiles to have been emitted by the server.');
    }
    return this.store.put('agent-review',{...value,scopeRevision:manifest.scopeRevision,eventDigest:manifest.eventDigest,attestationBasis:'agent-declared',modelComprehensionProven:false});
  }
  async assess(input) {
    const value=assessSchema.parse(input);let manifest=await this.manifestAsync(value.taskId);
    const context=await this.getContext(manifest.initialContextId);manifest=await this.manifestAsync(value.taskId);
    const records=await Promise.all(value.evidenceIds.map(e=>this.evidence(e)));
    const scopes=unique([...manifest.requestedScopes,...manifest.changedScopes]);const dimensions={};const remainingIssues=[];
    const reviews=(await this.store.listAsync('agent-review')).filter(r=>r.taskId===value.taskId);
    for(const dimension of dims) {
      if(!manifest.requiredDimensions.includes(dimension)){dimensions[dimension]=result('not_applicable','Not required by the stored task scope.');continue;}
      const perScope=[];
      for(const scopeId of scopes) {
        if(manifest.uncertainScopes.includes(scopeId)){perScope.push(result('incomplete',`${scopeId}: scope includes an unverified mutation or incomplete change tracking.`));continue;}
        const current=await this.getContext(manifest.initialContextId,scopeId);
        const scoped=records.filter(r=>r.scopeId===scopeId&&manifest.contextIds.includes(r.contextId));
        perScope.push(dimension==='visual'?await this.assessVisual(scoped,reviews,manifest,current,scopeId):this.assessDimension(dimension,scoped,manifest,current,scopeId));
      }
      const status=perScope.some(r=>r.status==='failed')?'failed':perScope.some(r=>r.status==='incomplete')?'incomplete':perScope.some(r=>r.status==='accepted_exception')?'accepted_exception':'passed';
      dimensions[dimension]=result(status,perScope.map(r=>r.reason).join(' '),perScope.flatMap(r=>r.evidenceIds),dimension==='visual'?{deliveryBasis:perScope.every(r=>r.deliveryBasis==='host-confirmed')?'host-confirmed':perScope.every(r=>['host-confirmed','agent-attested'].includes(r.deliveryBasis))?'agent-attested':'unconfirmed',hostScaling:perScope.every(r=>r.hostScaling&&r.hostScaling!=='unknown')?'host-recorded':'unknown'}:{});
      if(!['passed','accepted_exception'].includes(status))remainingIssues.push({dimension,reason:dimensions[dimension].reason});
    }
    const finalContext=await this.getContext(manifest.initialContextId);
    return this.serialTask(value.taskId,async()=>{
    // Scope/event validation is the final awaited operation. In-process task
    // writers share this lane; independent writers are detected by event digest.
    const latest=await this.manifestAsync(value.taskId);
    if(latest.scopeRevision!==manifest.scopeRevision||latest.eventDigest!==manifest.eventDigest||!equal(finalContext.revisions,context.revisions)) {
      manifest=latest;scopes.splice(0,scopes.length,...unique([...latest.requestedScopes,...latest.changedScopes]));
      for(const dimension of latest.requiredDimensions)dimensions[dimension]=result('incomplete','Task scope or workflow revisions changed during assessment; inspect new scopes and assess again.',dimensions[dimension]?.evidenceIds??[]);
      remainingIssues.push({dimension:'scope',reason:'Task scope or workflow changed while assessment was reading evidence.'});
    }
    const receiptId=randomUUID();return this.store.put('quality-receipt',{receiptId,contextId:manifest.initialContextId,taskId:manifest.taskId,taskScope:{scopes,requiredDimensions:manifest.requiredDimensions,scopeRevision:manifest.scopeRevision,eventDigest:manifest.eventDigest},finalRevisions:finalContext.revisions,dimensions,requiredEvidenceIds:unique(Object.values(dimensions).flatMap(d=>d.evidenceIds)),agentReview:reviews.length?{frameIds:unique(reviews.flatMap(r=>r.frames.map(f=>f.sourceFrameId))),tileIds:unique(reviews.flatMap(r=>r.frames.flatMap(f=>f.tileIds))),notes:reviews.flatMap(r=>r.frames.map(f=>f.notes))}:null,remainingIssues,readyForCompletion:remainingIssues.length===0},{id:receiptId});
    });
  }
  fresh(record,current,dimension) {
    const revisions=current.scopeRevisions?.[record.scopeId]??current.revisions;
    const captured=record.revisions??{layout:record.layoutRevision};
    const keys=dimension==='visual'&&!record.revisions?['layout']:relevant[dimension];
    return keys.every(k=>typeof captured?.[k]==='string'&&captured[k]===revisions?.[k])&&(!record.expiresAt||Date.parse(record.expiresAt)>Date.now());
  }
  async assessVisual(records,reviews,manifest,current,scopeId) {
    const captures=records.filter(r=>r.recordKind==='capture'||r.sourceKind);
    const eligible=captures.filter(r=>this.fresh(r,current,'visual')&&r.freshness==='verified'&&r.sourceKind!=='synthetic-proposal'&&!(r.sourceKind==='saved-preview'&&current.dirty)&&(r.coverage?.complete===true||(r.coverage?.resourcesComplete===true&&r.coverage?.geometryComplete===true))&&!(r.coverage.omittedObjectIds??[]).length&&!(r.coverage.gaps??[]).length&&!(r.omissions??[]).length&&r.renderer?.fontsReady===true);
    const compatible=(a,b)=>a.sourceFrameId===b.sourceFrameId&&a.contextId===b.contextId&&a.scopeId===b.scopeId&&sameFrame(a,b);
    function sameFrame(a,b){return canonical(a.revisions??{layout:a.layoutRevision})===canonical(b.revisions??{layout:b.layoutRevision})&&canonical(a.sourceArtifact??null)===canonical(b.sourceArtifact??null)&&canonical(a.renderParameters??null)===canonical(b.renderParameters??null)&&canonical(a.renderer??null)===canonical(b.renderer??null)&&canonical(a.coverage.requiredTileIds)===canonical(b.coverage.requiredTileIds);}
    const completeGroup=base=>{const pages=eligible.filter(p=>compatible(base,p)),artifacts=pages.flatMap(p=>p.artifacts??[]);return (base.coverage.requiredTileIds??[]).every(t=>artifacts.some(a=>a.artifactId===t))&&artifacts.every(a=>artifacts.filter(b=>b.artifactId===a.artifactId).every(b=>canonical(a)===canonical(b)));};
    const c=eligible.find(completeGroup);
    if(!c)return result('incomplete',`${scopeId}: current, complete rendered evidence is missing.`);
    const pages=eligible.filter(p=>compatible(c,p)),pageIds=pages.map(recordId),eid=recordId(c),tiles=c.coverage.requiredTileIds??[],used=[...pageIds];
    if(!tiles.length)return result('incomplete',`${scopeId}: readable tile coverage is missing.`,used);
    if(manifest.fidelityRequirements.nativeViewport&&c.sourceKind!=='live-viewport')return result('incomplete',`${scopeId}: task requires a verified native viewport.`,used);
    const check=records.find(r=>r.recordKind==='layout-check'&&r.sourceFrameId===c.sourceFrameId&&(pageIds.includes(r.evidenceId)||pageIds.includes(r.canvasEvidenceId))&&r.layoutRevision===c.layoutRevision&&r.coverage?.complete===true&&!(r.coverage.gaps??[]).length);
    if(!check)return result('incomplete',`${scopeId}: geometry coverage/check at the reviewed frame is missing.`,used);used.push(recordId(check));
    const matchedReviews=reviews.filter(r=>r.frames.some(f=>pageIds.includes(f.evidenceId)&&f.sourceFrameId===c.sourceFrameId));
    const reviewed=unique(matchedReviews.flatMap(r=>r.frames.filter(f=>pageIds.includes(f.evidenceId)&&f.sourceFrameId===c.sourceFrameId).flatMap(f=>f.tileIds)));
    if(!tiles.every(t=>reviewed.includes(t)))return result('incomplete',`${scopeId}: evidence-specific received/readable/inspected attestation is missing.`,used);used.push(...matchedReviews.map(recordId));
    const emissions=(await this.store.listAsync('image-emission')).filter(r=>pageIds.includes(r.evidenceId)&&r.sourceFrameId===c.sourceFrameId);const emitted=unique(emissions.flatMap(e=>e.tileIds??[]));
    if(!tiles.every(t=>emitted.includes(t)))return result('incomplete',`${scopeId}: required images were not all emitted.`,used);
    const delivery=(await this.store.listAsync('host-delivery')).filter(r=>pageIds.includes(r.evidenceId)&&r.sourceFrameId===c.sourceFrameId&&r.confirmed===true);const delivered=unique(delivery.flatMap(d=>d.tileIds??[]));const hostConfirmed=tiles.every(t=>delivered.includes(t));
    if(manifest.fidelityRequirements.hostConfirmedDelivery&&!hostConfirmed)return result('incomplete',`${scopeId}: independent host delivery is required and unavailable.`,used);
    used.push(...emissions.map(recordId),...delivery.map(recordId));let accepted=false;
    for(const finding of check.findings??[]) {
      if(!['error','high','critical'].includes(finding.severity))continue;
      const findingId=finding.findingId??finding.id;
      const falsePositive=matchedReviews.some(review=>review.dispositions.some(d=>d.findingId===findingId&&d.scopeId===scopeId&&d.evidenceIds.some(e=>pageIds.includes(e))));
      const acceptedDefect=manifest.exceptions.some(e=>e.dimension==='visual'&&e.scopeId===scopeId&&e.findingId===findingId&&e.source==='user');
      if(!falsePositive&&!acceptedDefect)return result('failed',`${scopeId}: unresolved finding ${findingId}.`,used);
      if(acceptedDefect)accepted=true;
    }
    return result(accepted?'accepted_exception':'passed',`${scopeId}: current rendered tiles were emitted and specifically reviewed${accepted?'; user accepted scoped defects':''}.`,used,{deliveryBasis:hostConfirmed?'host-confirmed':'agent-attested',hostScaling:hostConfirmed?delivery.find(d=>d.hostScaling)?.hostScaling??'unknown':'unknown'});
  }
  assessDimension(dimension,records,manifest,current,scopeId) {
    const candidates=records.filter(r=>r.recordKind==='dimension-check'&&r.taskId===manifest.taskId&&r.dimension===dimension&&this.fresh(r,current,dimension)).sort((a,b)=>(b.recordedAt??'').localeCompare(a.recordedAt??''));
    const record=candidates[0];
    if(!record)return result('incomplete',`${scopeId}: ${dimension} evidence is missing or stale.`);
    if(candidates.some(r=>r.recordedAt===record.recordedAt&&(r.checks??[]).some(c=>!equal(c.actual,c.expected))))return result('failed',`${scopeId}: conflicting ${dimension} assertions at the latest observation.`,candidates.filter(r=>r.recordedAt===record.recordedAt).map(recordId));
    const ids=[recordId(record)];if(record.coverage?.complete!==true)return result('incomplete',`${scopeId}: ${dimension} evidence coverage is incomplete.`,ids);
    if(dimension==='persistence'&&(current.dirty||record.saveObserved!==true||record.artifactVerified!==true||!record.artifactDigest||record.operationStatus!=='applied'))return result('incomplete',`${scopeId}: completed save and exact persisted artifact are unverified.`,ids);
    if(dimension==='executionData'&&manifest.fidelityRequirements.fullTableValues&&record.coverage.tableValues!=='full')return result('incomplete',`${scopeId}: full typed table value coverage is required.`,ids);
    if(dimension==='configuration'&&manifest.fidelityRequirements.protectedSettings&&!['native-preserved','not_present'].includes(record.coverage.protectedSettings))return result('incomplete',`${scopeId}: protected settings preservation is unverified.`,ids);
    const checks=record.checks??[];
    if(!checks.length)return result('incomplete',`${scopeId}: independent ${dimension} assertions are missing.`,ids);
    for(const check of checks)if(!equal(check.actual,check.expected))return result('failed',`${scopeId}: ${dimension} assertion ${check.id??check.kind??'unnamed'} failed.`,ids);
    if(dimension==='executionData')for(const declared of manifest.dataChecks.filter(c=>c.scopeId===scopeId)) {
      const check=checks.find(c=>c.id===declared.id&&c.kind===declared.kind&&equal(c.expected,declared.expected));
      if(!check||(declared.coverage==='full'&&check.coverage!=='full'))return result('incomplete',`${scopeId}: declared data assertion ${declared.id} lacks required coverage.`,ids);
    }
    return result('passed',`${scopeId}: ${dimension} recorded assertions passed.`,ids);
  }
}

export async function assessQuality(input,dependencies) {return (dependencies instanceof QualityManager?dependencies:new QualityManager(dependencies)).assess(input);}
export async function beginQualityTask(input,dependencies) {return (dependencies instanceof QualityManager?dependencies:new QualityManager(dependencies)).begin(input);}
