import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { services, v02Tools } from '../src/v02-tools.mjs';
import { IMAGES, structuredResult } from '../src/mcp-result.mjs';
import {CLIENT_OPERATION} from '../src/client.mjs';

async function fixture() {
 const runtime=await mkdtemp(path.join(tmpdir(),'knime-v02-tools-'));
 const ctx={contextId:'ctx',sessionId:'session',projectId:'project',workflowId:'root',workspace:'fixture',revisions:{structure:'s',configuration:'c',layout:'l',execution:'e'},dirty:false};
 const rows=[{key:'Row0',values:['alpha',1]},{key:'Row1',values:['',2]}];
 const schema=[{name:'label',type:'String',encoding:'string'},{name:'count',type:'Int',encoding:'number'}];
 const snapshot={id:'0',gatewayId:'root',kind:'workflow',nodes:[{id:'0:1',gatewayId:'root:1',factoryId:'literal',state:'EXECUTED',bounds:[100,150,-1,-1],settings:{key:'node_settings',type:'config',entries:[]},outputPorts:[{index:1,className:'org.knime.core.node.BufferedDataTable',dataAvailable:true,tableIdentity:'table'}]}],connections:[],annotations:[]};
 let mutations=0;
 const client={runtime,call:async(operation,args,options)=>{
   assert.equal(options?.session,'session');
   if(operation==='context.inspect'||operation==='context.bind')return structuredClone(ctx);
   if(operation==='core.snapshot')return structuredClone(snapshot);
   if(operation==='core.table.read')return {schema,rows:rows.slice(Number(args.offset??0),Number(args.offset??0)+(args.limit??100)),offset:String(args.offset??0),totalRows:'2',nextOffset:String(Math.min(2,Number(args.offset??0)+(args.limit??100))),hasMore:Number(args.offset??0)+(args.limit??100)<2,tableIdentity:'table',stableReadPolicy:'native-immutable-buffered-table'};
   if(operation==='layout.apply') {
     assert.equal(options.precondition.expected.layout,ctx.revisions.layout);mutations++;
     for(const change of args.changes){const node=snapshot.nodes.find(n=>n.gatewayId===change.objectId);assert.deepEqual(change.before,{x:node.bounds[0],y:node.bounds[1]});node.bounds[0]=change.after.x;node.bounds[1]=change.after.y;}
     const beforeRevisions={...ctx.revisions};ctx.revisions.layout+='x';ctx.dirty=true;
     client.lastReceipt={operationId:randomUUID(),sessionId:'session',status:'applied',guardCoverage:'apply-time'};
     const result={status:'applied',guardCoverage:'apply-time',beforeRevisions,afterRevisions:{...ctx.revisions}};
     Object.defineProperty(result,CLIENT_OPERATION,{value:{receipt:client.lastReceipt}});return result;
   }
   throw new Error(`Unexpected ${operation}`);
 }};
 const capture=async()=>{
   const eid=randomUUID(),frame=randomUUID(),tile=`${frame}.png`;
   const evidence={evidenceId:eid,contextId:'ctx',scopeId:'root',revisions:{...ctx.revisions},layoutRevision:ctx.revisions.layout,executionRevision:'e',sourceFrameId:frame,sourceKind:'native-preview',freshness:'verified',renderer:{fontsReady:true},coverage:{complete:true,requiredTileIds:[tile],omittedObjectIds:[],gaps:[]},artifacts:[{artifactId:tile}]};
   const node=snapshot.nodes[0];
   const geometry={contextId:'ctx',scopeId:'root',evidenceId:eid,sourceFrameId:frame,layoutRevision:ctx.revisions.layout,bounds:{x:0,y:0,width:1000,height:1000},nodes:[{id:'root:1',bounds:{x:node.bounds[0],y:node.bounds[1]+10,width:32,height:32}}],texts:[],connections:[],annotations:[],coverage:{complete:true,gaps:[]},nativeLayout:{nodes:[{id:'root:1',position:{x:node.bounds[0],y:node.bounds[1]}}],connections:[],annotations:[]}};
   const png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(10,16);png.writeUInt32BE(10,20);
   return {evidence,geometry,context:structuredClone(ctx),images:[{artifactId:tile,mimeType:'image/png',data:png}]};
 };
 const svc=await services(client,{captureCanvas:capture});svc.store.put('context',ctx,{id:'context-ctx'});
 const invoke=(name,input)=>v02Tools.find(t=>t.name===name).run(client,input);
 return {client,ctx,snapshot,rows,schema,svc,invoke,mutations:()=>mutations};
}
test('quality integration produces independent baseline and full typed value assertions',async()=>{
 const f=await fixture();const task=await f.invoke('knime_verify_workflow',{action:'begin',input:{contextId:'ctx',requestedScopes:['root'],requiredDimensions:['structure','configuration','executionData'],dataChecks:[{id:'literal',scopeId:'root',nodeId:'0:1',portIndex:1,kind:'data',expected:f.rows,coverage:'full'}],fidelityRequirements:{fullTableValues:true}}});
 const result=await f.invoke('knime_verify_workflow',{action:'assess',input:{taskId:task.taskId,evidenceIds:[]}});
 assert.equal(result.readyForCompletion,true);assert.equal(result.dimensions.executionData.status,'passed');
 f.rows[0].values[1]=99;
 const changed=await f.invoke('knime_verify_workflow',{action:'assess',input:{taskId:task.taskId,evidenceIds:[]}});assert.equal(changed.dimensions.executionData.status,'failed');
});
test('layout tools enrich exact native coordinates and emit fresh post-apply images only at response formatting',async()=>{
 const f=await fixture();const view=await f.invoke('knime_canvas_view',{contextId:'ctx'});
 assert.ok(view[IMAGES].length);assert.equal(f.svc.store.list('image-emission').length,0);structuredResult(view);assert.equal(f.svc.store.list('image-emission').length,1);
 const plan=await f.invoke('knime_layout_plan',{evidenceId:view.evidence.evidenceId,changes:[{kind:'node-position',objectId:'root:1',before:{x:100,y:150},after:{x:220,y:150}}]});
 const applied=await f.invoke('knime_layout_apply',{planId:plan.planId,precondition:{contextId:'ctx',expected:{...f.ctx.revisions}}});
 assert.equal(applied.operation.status,'applied');assert.equal(applied.operation.postconditions.find(p=>p.kind==='integrity').status,'passed');assert.equal(applied.operation.postconditions.find(p=>p.kind==='native-render').status,'passed');assert.ok(applied[IMAGES].length);assert.equal(f.mutations(),1);
 await assert.rejects(f.invoke('knime_layout_apply',{planId:plan.planId,precondition:{contextId:'ctx',expected:{...f.ctx.revisions}}}),/already|replay/i);assert.equal(f.mutations(),1);
});
test('stale plan semantic revision rejects before native mutation even when caller supplies current revisions',async()=>{
 const f=await fixture();const view=await f.invoke('knime_canvas_view',{contextId:'ctx'});const plan=await f.invoke('knime_layout_plan',{evidenceId:view.evidence.evidenceId,changes:[{kind:'node-position',objectId:'root:1',before:{x:100,y:150},after:{x:220,y:150}}]});f.ctx.revisions.configuration='changed';
 await assert.rejects(f.invoke('knime_layout_apply',{planId:plan.planId,precondition:{contextId:'ctx',expected:{...f.ctx.revisions}}}),/REVISION_CONFLICT/);assert.equal(f.mutations(),0);
});
test('quality schema rejects nested caller pass flags and persistence is incomplete without exact save verification',async()=>{
 const f=await fixture();const task=await f.invoke('knime_verify_workflow',{action:'begin',input:{contextId:'ctx',requestedScopes:['root'],requiredDimensions:['persistence']}});
 await assert.rejects(f.invoke('knime_verify_workflow',{action:'assess',input:{taskId:task.taskId,evidenceIds:[],dimensions:{persistence:'passed'}}}),/unrecognized/i);
 const result=await f.invoke('knime_verify_workflow',{action:'assess',input:{taskId:task.taskId,evidenceIds:[]}});assert.equal(result.readyForCompletion,false);assert.equal(result.dimensions.persistence.status,'incomplete');
});
