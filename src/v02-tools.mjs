import path from 'node:path';
import fs from 'node:fs/promises';
import {z} from 'zod';
import {BridgeError} from './client.mjs';
import {readOperation} from './operations.mjs';
import {withImages} from './mcp-result.mjs';
import {canonical} from './quality/store.mjs';
import {integritySnapshot} from './quality/integrity.mjs';
import {applyLayout} from './layout/apply.mjs';
import {layoutChangeSchema} from './layout/plan.mjs';
import {verifyWorkflowSchema} from './quality/receipt.mjs';

const id=z.string().min(1).max(200), session=id.optional(),timeoutMs=z.number().int().min(1).max(3600000).optional();
const readonly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const local={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
const instances=new WeakMap();
const same=(a,b)=>a!==undefined&&b!==undefined&&canonical(a)===canonical(b);
const projectMatches=(a,b)=>a.sessionId===b.sessionId&&a.projectId!=null&&a.projectId===b.projectId&&a.workspace===b.workspace;
const allNodes=graph=>{const found=[];const walk=n=>{if(n.id)found.push(n);for(const c of n.nodes??[])walk(c);if(n.workflow)walk(n.workflow);};walk(graph);return found;};
export async function services(client,adapters={}) {
 if(instances.has(client))return instances.get(client);
 const promise=(async()=>{
  const {QualityStore}=await import('./quality/store.mjs');
  const {QualityManager}=await import('./quality/receipt.mjs');
  const store=new QualityStore({directory:path.join(client.runtime,'quality')});
  let quality;
  const observe=current=>{
   const previous=store.list('context-observation').filter(r=>r.contextId===current.contextId).at(-1);
   if(previous&&same(previous.revisions,current.revisions)&&previous.dirty===current.dirty)return;
   store.put('context-observation',current);
   if(!previous||!quality)return;
   const changed=['structure','configuration','layout','execution'].filter(d=>previous.revisions?.[d]!==current.revisions?.[d]);
   if(!changed.length&&previous.dirty===current.dirty)return;
   const dimensions=changed.some(d=>['structure','configuration'].includes(d))?['structure','configuration','executionData','visual','persistence']:changed.includes('execution')?['executionData','persistence',...(changed.includes('layout')?['visual']:[])]:['visual','persistence'];
   for(const task of store.list('quality-task'))if(projectMatches(store.get('context-'+task.initialContextId),current))quality.recordChange({taskId:task.taskId,contextId:current.contextId,scopeId:current.workflowId,dimensions});
  };
  const context=async(contextId,scopeId)=>{
   const saved=store.get('context-'+contextId);
   if(scopeId&&scopeId!==saved.workflowId) {
    // A root context is never reused as proof about a different nested scope.
    const known=store.list('context').find(c=>c.sessionId===saved.sessionId&&c.projectId===saved.projectId&&c.workflowId===scopeId);
    if(!known)throw new BridgeError('SCOPE_NOT_BOUND','Bind and inspect the requested nested scope before verifying it.');
    const current=await client.call('context.inspect',{contextId:known.contextId},{session:known.sessionId});
    observe(current);return {...current,scopeId:current.workflowId};
   }
   const current=await client.call('context.inspect',{contextId},{session:saved.sessionId});
   for(const key of ['contextId','sessionId','projectId','workflowId','workspace'])if(current[key]!==saved[key])throw new BridgeError('CONTEXT_CHANGED',`Bound ${key} changed.`);
   observe(current);return {...current,scopeId:current.workflowId};
  };
  quality=new QualityManager({store,getContext:context});
  const snapshot=async ctx=>{
   const before=await context(ctx.contextId);
   const graph=await client.call('core.snapshot',{projectId:ctx.projectId,workflowId:ctx.workflowId,depth:8,maxNodes:10000,includeSettings:true},{session:ctx.sessionId});
   const after=await context(ctx.contextId);
   if(!same(before.revisions,after.revisions))throw new BridgeError('REVISION_CONFLICT','Snapshot changed during read.');
   return {...graph,revisions:after.revisions};
  };
  const tablePage=(ctx,args)=>client.call('core.table.read',{projectId:ctx.projectId,workflowId:ctx.workflowId,...args},{session:ctx.sessionId});
  const integrity=async ctx=>{
   const graph=await snapshot(ctx);
   const tableOutputs=allNodes(graph).flatMap(n=>(n.outputPorts??[]).filter(p=>p.dataAvailable&&(p.tableIdentity||/BufferedDataTable/.test(p.className??''))).map(p=>({nodeId:n.id,portIndex:p.index})));
   return integritySnapshot(ctx,{tableOutputs,mode:'full'},{readSnapshot:snapshot,readTablePage:tablePage,stableReadPolicy:'native-immutable-table-token'});
  };
  const capture=adapters.captureCanvas??(await import('./canvas/capture.mjs')).captureCanvas;
  return {store,context,quality,snapshot,tablePage,integrity,capture};
 })();
 instances.set(client,promise);
 try{return await promise;}catch(error){instances.delete(client);throw error;}
}
export async function noteMutation(client,{precondition,receipt,uncertain=false}) {
 if(!precondition?.contextId)return;
 const {store,quality}=await services(client);let ctx;
 try{ctx=store.get('context-'+precondition.contextId);}catch{return;}
 for(const task of store.list('quality-task')) {
  if(!projectMatches(store.get('context-'+task.initialContextId),ctx))continue;
  quality.recordChange({taskId:task.taskId,contextId:ctx.contextId,scopeId:ctx.workflowId??'workspace',dimensions:['structure','configuration','executionData','visual','persistence'],operationId:receipt?.operationId,uncertain:uncertain||receipt?.guardCoverage==='unverified'});
 }
}
async function bind(client,input) {
 const {store,context}=await services(client);
 if(input.action==='inspect')return context(input.contextId);
 const args={};if(input.projectId!==undefined)args.projectId=input.projectId;if(input.workflowId!==undefined)args.workflowId=input.workflowId;
 const current=await client.call('context.bind',args,{session:input.session,timeoutMs:input.timeoutMs});
 store.put('context',current,{id:'context-'+current.contextId});return current;
}
async function produceCanvas(client,input) {
 const {store,context}=await services(client),ctx=await context(input.contextId);
 const {capture}=await services(client);
 const result=await capture({client,context:ctx,artifactDirectory:path.join(client.runtime,'sessions',ctx.sessionId,'artifacts'),mode:input.mode??'overview',crop:input.crop,scale:input.scale,reuseEvidence:input.evidenceId?store.get(input.evidenceId):undefined,options:{tileOffset:input.tileOffset??0,tileLimit:input.tileLimit??1}});
 const evidence={...result.evidence,revisions:result.context?.revisions??result.evidence.revisions};
 store.put('capture',evidence,{id:evidence.evidenceId});
 if(result.geometry){const geometry=structuredClone(result.geometry);for(const n of geometry.nodes??[]){const native=geometry.nativeLayout?.nodes?.find(x=>x.id===n.id||x.nativeId===n.id);if(native)n.position=native.position;}for(const c of geometry.connections??[]){const native=geometry.nativeLayout?.connections?.find(x=>x.id===c.id);if(native)c.bendpoints=native.bendpoints;}for(const a of geometry.annotations??[]){const native=geometry.nativeLayout?.annotations?.find(x=>x.id===a.id);if(native)a.nativeBounds=native.bounds;}store.put('geometry',{...geometry,revisions:evidence.revisions,contextId:evidence.contextId,scopeId:evidence.scopeId},{id:'geometry-'+evidence.evidenceId});}
 return {...result,evidence};
}
function imageResponse(store,metadata,result) {
 return withImages(metadata,result.images,()=>store.put('image-emission',{contextId:result.evidence.contextId,evidenceId:result.evidence.evidenceId,sourceFrameId:result.evidence.sourceFrameId,tileIds:result.images.map(i=>i.artifactId)}));
}
async function canvas(client,input) {
 const {store}=await services(client),result=await produceCanvas(client,input);
 return imageResponse(store,{evidence:result.evidence,...(result.geometry?{geometrySummary:{nodes:result.geometry.nodes.length,connections:result.geometry.connections.length,texts:result.geometry.texts.length,coverage:result.geometry.coverage}}:{})},result);
}
async function check(client,input) {
 const {store,context}=await services(client),capture=store.get(input.evidenceId);
 const ctx=await context(capture.contextId);
 if(ctx.revisions.layout!==capture.layoutRevision)throw new BridgeError('REVISION_CONFLICT','Canvas evidence is stale. Capture again before checking.');
 const geometry=store.get('geometry-'+input.evidenceId);
 const {checkLayout}=await import('./layout/check.mjs');
 return store.put('layout-check',{...checkLayout(geometry),contextId:ctx.contextId,scopeId:ctx.workflowId,revisions:ctx.revisions});
}
async function plan(client,input) {
 const {store,context}=await services(client),capture=store.get(input.evidenceId),ctx=await context(capture.contextId);
 if(!same(ctx.revisions,capture.revisions))throw new BridgeError('REVISION_CONFLICT','Canvas evidence is stale. Capture before planning.');
 const geometry=store.get('geometry-'+input.evidenceId);
 const {checkLayout}=await import('./layout/check.mjs');
 const {planLayout}=await import('./layout/plan.mjs');
 return planLayout({context:ctx,geometry,findings:checkLayout(geometry).findings,pins:input.pins??[],groups:input.groups??[],changes:input.changes},{store});
}
async function apply(client,input) {
 const svc=await services(client),p=svc.store.get(input.planId);let rendered;
 const operation=await applyLayout(input,{store:svc.store,getContext:svc.context,integritySnapshot:svc.integrity,
  readCanvas:async ctx=>{
   const graph=await svc.snapshot(ctx);
   if(p.changes.some(c=>c.kind==='connection-bendpoints')){const native=await client.call('canvas.preview',{contextId:ctx.contextId},{session:ctx.sessionId});if(!native.nativeLayout)throw new Error('Native route read-back unavailable.');return native.nativeLayout;}
   return {nodes:(graph.nodes??[]).flatMap(n=>[n.id,n.gatewayId].filter(Boolean).map(id=>({id,position:Array.isArray(n.bounds)?{x:n.bounds[0],y:n.bounds[1]}:n.position}))),annotations:(graph.annotations??[]).map(a=>({id:a.id,bounds:{x:a.x,y:a.y,width:a.width,height:a.height}})),connections:graph.connections??[]};
  },
  applyChange:async(change,precondition)=>{const ctx=await svc.context(p.contextId);const native=await client.call('layout.apply',{contextId:ctx.contextId,changes:[change]},{session:ctx.sessionId,precondition,timeoutMs:input.timeoutMs});return {...native,operationId:client.lastReceipt?.operationId??null,guardCoverage:native.guardCoverage??client.lastReceipt?.guardCoverage??'unverified'};},
  renderAndCheck:async ctx=>{rendered=await produceCanvas(client,{contextId:ctx.contextId,mode:'tiles',tileLimit:1});const checked=await check(client,{evidenceId:rendered.evidence.evidenceId});return {...checked,evidenceId:checked.id,coverage:{...checked.coverage,complete:checked.coverage.complete===true&&rendered.evidence.freshness==='verified'&&rendered.evidence.coverage.complete===true}};},
 });
 const ctx=await svc.context(p.contextId);
 for(const task of svc.store.list('quality-task'))if(projectMatches(svc.store.get('context-'+task.initialContextId),ctx))svc.quality.recordChange({taskId:task.taskId,contextId:ctx.contextId,scopeId:ctx.workflowId,dimensions:['visual','persistence'],operationId:operation.operationId,uncertain:operation.status!=='applied'||operation.guardCoverage!=='apply-time'});
 const metadata={operation,...(rendered?{evidence:rendered.evidence}:{}),next:'Inspect emitted readable tiles and verify persistence. Applied edits alone do not establish completion.'};
 return rendered?imageResponse(svc.store,metadata,rendered):metadata;
}
const rect=z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().positive(),height:z.number().positive()}).strict();
async function baselineTask(svc,task) {
 for(const scopeId of task.requestedScopes)try{const ctx=await svc.context(task.initialContextId,scopeId),integrity=await svc.integrity(ctx);svc.store.put('task-baseline',{taskId:task.taskId,contextId:ctx.contextId,scopeId,integrity});if(!svc.quality.manifest(task.taskId).contextIds.includes(ctx.contextId))svc.quality.recordChange({taskId:task.taskId,contextId:ctx.contextId,scopeId,dimensions:task.requiredDimensions});}catch(error){svc.store.put('task-baseline',{taskId:task.taskId,scopeId,integrity:null,error:error.message});}
}
async function dataAssertion(svc,ctx,check) {
 if(!check.nodeId||!Number.isInteger(check.portIndex))return {...check,actual:null,coverage:'incomplete',reason:'Explicit nodeId/portIndex required.'};
 let offset='0',identity=null,schema=null,total=null,rows=[],stable=true,complete=false;
 for(let pages=0;pages<1000&&rows.length<100000;pages++) {
  const page=await svc.tablePage(ctx,{nodeId:check.nodeId,portIndex:check.portIndex,offset,limit:Math.min(1000,100000-rows.length)});
  if(String(page.offset)!==offset||!Array.isArray(page.rows)||!Array.isArray(page.schema))throw new Error('Malformed or noncontiguous table page.');
  if(!page.tableIdentity||page.stableReadPolicy!=='native-immutable-buffered-table')stable=false;
  if(identity!==null&&(identity!==page.tableIdentity||!same(schema,page.schema)||total!==String(page.totalRows)))throw new Error('Table changed during assertion paging.');
  identity=page.tableIdentity??null;schema=page.schema;total=String(page.totalRows);rows.push(...page.rows);
  if(check.kind!=='data'){complete=true;break;}
  if(!page.hasMore){complete=BigInt(rows.length)===BigInt(total);break;}
  if(BigInt(page.nextOffset??'-1')!==BigInt(offset)+BigInt(page.rows.length)||!page.rows.length)throw new Error('Noncontiguous table page.');offset=String(page.nextOffset);
  if(check.coverage==='sampled'){complete=true;break;}
 }
 const final=await svc.tablePage(ctx,{nodeId:check.nodeId,portIndex:check.portIndex,offset:'0',limit:1});stable=stable&&identity===final.tableIdentity;
 const opaque=v=>v&&typeof v==='object'&&(v.opaque===true||v.truncated===true||Object.values(v).some(opaque));
 const actual=check.kind==='count'?(typeof check.expected==='number'&&Number.isSafeInteger(Number(total))?Number(total):total):check.kind==='schema'?schema:rows;
 return {id:check.id,kind:check.kind,expected:check.expected,actual,coverage:complete&&stable&&!opaque(actual)?check.coverage:'incomplete'};
}
async function dimensionEvidence(svc,taskId) {
 let manifest=svc.quality.manifest(taskId);const ids=[];
 for(const scopeId of new Set([...manifest.requestedScopes,...manifest.changedScopes])) {
  let ctx,integrity;try{ctx=await svc.context(manifest.initialContextId,scopeId);integrity=await svc.integrity(ctx);}catch(error){ids.push(svc.store.put('dimension-error',{taskId,scopeId,error:error.message}).id);continue;}
  if(!svc.quality.manifest(taskId).contextIds.includes(ctx.contextId))svc.quality.recordChange({taskId,contextId:ctx.contextId,scopeId,dimensions:manifest.requiredDimensions});
  manifest=svc.quality.manifest(taskId);const baseline=svc.store.list('task-baseline').find(r=>r.taskId===taskId&&r.scopeId===scopeId)?.integrity;
  const put=(dimension,coverage,checks,extra={})=>ids.push(svc.store.put('dimension-check',{taskId,contextId:ctx.contextId,scopeId,revisions:ctx.revisions,dimension,coverage,checks,...extra}).id);
  if(manifest.requiredDimensions.includes('structure'))put('structure',{complete:!!baseline&&integrity.coverage.structure==='full'},baseline?[{kind:'preserved-topology',expected:baseline.structureDigest,actual:integrity.structureDigest}]:[]);
  if(manifest.requiredDimensions.includes('configuration'))put('configuration',{complete:!!baseline&&integrity.coverage.configuration==='full'&&integrity.coverage.protectedSettings!=='incomplete',protectedSettings:integrity.coverage.protectedSettings},baseline?[{kind:'preserved-settings',expected:baseline.configurationDigest,actual:integrity.configurationDigest}]:[]);
  if(manifest.requiredDimensions.includes('executionData')) {
   const declared=manifest.dataChecks.filter(c=>c.scopeId===scopeId),checks=[];
   for(const c of declared)try{checks.push(await dataAssertion(svc,ctx,c));}catch(error){checks.push({id:c.id,kind:c.kind,expected:c.expected,actual:null,coverage:'incomplete',reason:error.message});}
   if(!declared.length&&baseline)checks.push({kind:'preserved-states',expected:baseline.executionStates,actual:integrity.executionStates},{kind:'preserved-typed-values',expected:baseline.executedOutputFingerprints,actual:integrity.executedOutputFingerprints});
   const after=await svc.context(ctx.contextId);
   put('executionData',{complete:same(ctx.revisions,after.revisions)&&checks.length>0&&checks.every(c=>c.coverage!=='incomplete')&&integrity.coverage.tableValues==='full',tableValues:integrity.coverage.tableValues},checks,{selectedOutputs:integrity.coverage.outputs});
  }
  if(manifest.requiredDimensions.includes('persistence'))put('persistence',{complete:false},[],{saveObserved:false,artifactVerified:false,operationStatus:'not_checked',reason:'Exact saved/reopened artifact verification is unavailable; clean live state is not persistence proof.'});
 }
 return ids;
}
async function verify(client,{action,input}) {
 if(Object.hasOwn(input,'action'))throw new BridgeError('INVALID_ARGUMENT','Nested input cannot replace action.');
 const parsed=verifyWorkflowSchema.parse({action,...input}),{action:_action,...args}=parsed,svc=await services(client);
 if(action==='begin'){const task=await svc.quality.begin(args);await baselineTask(svc,task);return svc.quality.manifest(task.taskId);}
 if(action==='assess'){const ids=await dimensionEvidence(svc,args.taskId);return svc.quality.assess({...args,evidenceIds:[...new Set([...args.evidenceIds,...ids])]});}
 return svc.quality[action](args);
}
const verifyInputSchema=z.union(verifyWorkflowSchema.options.map(schema=>schema.omit({action:true})));
export const preconditionSchema=z.object({contextId:id,expected:z.object({structure:id.optional(),configuration:id.optional(),layout:id.optional(),execution:id.optional()}).strict()}).strict();
export const v02Tools=[
 {name:'knime_context',title:'Bind the intended KNIME workflow',description:'Bind one running session, workspace, project and nested scope; inspect current revisions before mutations. Workspace-only binding supports create/open. Never follows another process after restart.',inputSchema:{action:z.enum(['bind','inspect']).default('bind'),projectId:id.optional(),workflowId:id.optional(),contextId:id.optional(),session,timeoutMs},annotations:readonly,run:bind},
 {name:'knime_canvas_view',title:'See the KNIME canvas',description:'Return actual PNG images of the loaded workflow preview, readable crops/tiles, or embedded viewport. Reuse evidenceId to page one immutable source frame. Inspect freshness and omissions. Capture is not review.',inputSchema:{contextId:id,evidenceId:id.optional(),mode:z.enum(['overview','detail','tiles','viewport']).default('overview'),crop:rect.optional(),scale:z.number().positive().max(4).optional(),tileOffset:z.number().int().min(0).optional(),tileLimit:z.number().int().min(1).max(4).optional()},annotations:readonly,run:canvas},
 {name:'knime_layout_check',title:'Check rendered canvas geometry',description:'Check actual curved connections, rendered node footprints and occupied text in current image evidence. Returns defect candidates and coverage gaps. Review crops; intentional empty annotation containment is allowed.',inputSchema:{evidenceId:id},annotations:readonly,run:check},
 {name:'knime_layout_plan',title:'Plan a constrained layout repair',description:'Create an immutable local plan from rendered evidence and exact native coordinates. Preserve topology, settings and annotation text; inspect before/after changes and unresolved findings.',inputSchema:{evidenceId:id,pins:z.array(id).optional(),groups:z.array(z.object({id:id.optional(),annotationId:id.optional(),nodeIds:z.array(id),bounds:rect.optional(),alignment:z.enum(['fixed','preserve']).optional()}).strict()).optional(),changes:z.array(layoutChangeSchema).max(500).optional()},annotations:local,run:plan},
 {name:'knime_layout_apply',title:'Apply a versioned layout plan',description:'Apply an immutable layout plan through native exact-old-value and revision checks. No analytical changes. Native undo coverage is reported; partial failure is not success. Re-render and verify the result.',inputSchema:{planId:id,precondition:preconditionSchema,timeoutMs},annotations:local,run:apply},
 {name:'knime_operation',title:'Reconcile an operation outcome',description:'Read a durable receipt by original session and operation UUID, including after process shutdown. Never replays a mutation. A nonterminal dead-session receipt remains unknown_after_restart.',inputSchema:{sessionId:id,operationId:z.string().uuid()},annotations:readonly,run:readOperation},
 {name:'knime_verify_workflow',title:'Track and assess completion evidence',description:'Begin explicit scopes, dimensions and data/schema/count assertions. Review emitted frames and tiles. Assessment produces native snapshot/data checks against the task baseline and resolves immutable evidence. Exact persisted-artifact checks stay incomplete when unsupported. Server cannot prove model comprehension or independently authenticate caller-declared user exceptions.',inputSchema:{action:z.enum(['begin','review','assess','respecify']),input:verifyInputSchema},annotations:local,run:verify},
];
