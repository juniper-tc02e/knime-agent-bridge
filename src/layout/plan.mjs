import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, immutable } from '../quality/store.mjs';
import { flattenPath, intersectRects, validRect } from './geometry.mjs';

const coordinate=z.number().int().min(-1000000).max(1000000);
const point=z.object({x:coordinate,y:coordinate}).strict();
const rect=point.extend({width:z.number().int().positive().max(1000000),height:z.number().int().positive().max(1000000)}).strict();
const identity={objectId:z.string().min(1)};
export const layoutChangeSchema=z.discriminatedUnion('kind',[
  z.object({...identity,kind:z.literal('node-position'),before:point,after:point}).strict(),
  z.object({...identity,kind:z.literal('annotation-bounds'),before:rect,after:rect}).strict(),
  z.object({...identity,kind:z.literal('connection-bendpoints'),before:z.array(point).max(1000),after:z.array(point).max(1000)}).strict(),
]);
const contained=(a,b)=>a.x>=b.x&&a.y>=b.y&&a.x+a.width<=b.x+b.width&&a.y+a.height<=b.y+b.height;
const nonzeroIntersection=(a,b)=>{const r=intersectRects(a,b);return r&&r.width>0&&r.height>0;};
const ids=f=>(f.participants??[]).map(p=>typeof p==='string'?p:p.id??p.objectId);
export function layoutValue(geometry,change) {
  const key=change.kind==='node-position'?'nodes':change.kind==='annotation-bounds'?'annotations':'connections';
  const object=(geometry[key]??[]).find(o=>o.id===change.objectId);if(!object)throw new Error(`Unknown layout object: ${change.objectId}`);
  if(change.kind==='node-position') {if(!object.position||!point.safeParse(object.position).success)throw new Error(`Exact native node position unavailable for ${change.objectId}.`);return object.position;}
  if(change.kind==='annotation-bounds')return object.nativeBounds??object.bounds;
  if(!Array.isArray(object.bendpoints??object.bendPoints))throw new Error(`Exact old bendpoints unavailable for ${change.objectId}.`);
  return object.bendpoints??object.bendPoints;
}
function assertChange(change,geometry,pins,groups) {
  layoutChangeSchema.parse(change);
  if(pins.includes(change.objectId))throw new Error(`Pinned object cannot move: ${change.objectId}`);
  if(canonical(layoutValue(geometry,change))!==canonical(change.before))throw new Error(`Exact old value differs for ${change.objectId}.`);
  if(change.kind==='node-position') {
    const n=geometry.nodes.find(n=>n.id===change.objectId);if(!validRect(n.bounds))throw new Error('Measured node bounds are required.');
    const offset={x:change.after.x-change.before.x,y:change.after.y-change.before.y};
    const moved={...n.bounds,x:n.bounds.x+offset.x,y:n.bounds.y+offset.y};
    for(const g of groups.filter(g=>(g.nodeIds??g.members??[]).includes(n.id))) {
      const bounds=g.bounds??geometry.annotations?.find(a=>a.id===g.annotationId)?.bounds;
      if(!bounds||!contained(moved,bounds))throw new Error(`Move violates preserved group ${g.id??g.annotationId}.`);
      if(g.alignment==='fixed')throw new Error(`Move violates fixed group alignment ${g.id}.`);
    }
  }
  if(change.kind==='annotation-bounds') {
    if(geometry.sourceFrameId&&!geometry.annotations.find(a=>a.id===change.objectId)?.nativeBounds)throw new Error('Exact native annotation bounds are required; measured text bounds cannot be substituted.');
    const before=change.before,after=change.after;
    if(after.x!==before.x||after.y!==before.y||after.width<before.width||after.height<before.height)throw new Error('Conservative annotation repair may only enlarge existing bounds.');
    for(const a of geometry.annotations??[])if(a.id!==change.objectId&&nonzeroIntersection(after,a.bounds)&&!nonzeroIntersection(before,a.bounds))throw new Error('Annotation enlargement would enter occupied space.');
  }
}
function displacement(change) {return change.kind==='connection-bendpoints'?change.after.reduce((n,p,i)=>n+Math.hypot(p.x-(change.before[i]?.x??p.x),p.y-(change.before[i]?.y??p.y)),0):Math.hypot(change.after.x-change.before.x,change.after.y-change.before.y)+Math.abs((change.after.width??0)-(change.before.width??0))+Math.abs((change.after.height??0)-(change.before.height??0));}

/** Propose measured local changes only; native renderer decides final spline clearance. */
export function planLayout({context,geometry,findings=[],pins=[],groups=[],changes,cycle=1}={}, {store}={}) {
  if(!context?.contextId||!geometry?.evidenceId||!geometry?.sourceFrameId)throw new Error('Bound context and measured source frame are required.');
  if(geometry.contextId!==context.contextId||geometry.layoutRevision!==context.revisions?.layout)throw new Error('Stale geometry or layout revision/context mismatch.');
  if(!Number.isInteger(cycle)||cycle<1||cycle>3)throw new Error('Automatic repair is bounded to three cycles.');
  if(!Array.isArray(pins)||!Array.isArray(groups))throw new Error('Pins and groups must be arrays.');
  const allIds=new Set([...(geometry.nodes??[]),...(geometry.annotations??[]),...(geometry.connections??[])].map(o=>o.id));
  for(const pin of pins)if(!allIds.has(pin))throw new Error(`Unknown pinned object: ${pin}`);
  for(const g of groups)for(const member of g.nodeIds??g.members??[])if(!allIds.has(member))throw new Error(`Unknown group object: ${member}`);
  const proposed=changes?structuredClone(changes):[],unresolved=[];
  if(!changes)for(const finding of findings) {
    const participants=ids(finding);const connection=geometry.connections?.find(c=>participants.includes(c.id));const text=geometry.texts?.find(t=>participants.includes(t.id)||participants.includes(t.ownerId));
    if(connection&&text&&!pins.includes(connection.id)) {
      const path=(connection.paths??[])[0];const transform=typeof path==='string'?connection.transform:path?.transform??connection.transform;const flat=flattenPath(typeof path==='string'?path:path?.d,{...(transform?{transform}:{})});
      if(!flat.complete||!flat.segments.length||!Array.isArray(connection.bendpoints??connection.bendPoints)){unresolved.push({findingId:finding.id??finding.findingId,reason:'Exact native route or endpoints are unavailable.'});continue;}
      const start=flat.segments[0].a,end=flat.segments.at(-1).b;
      const texts=(geometry.texts??[]).filter(t=>validRect(t.bounds));const margin=48;
      const left=Math.min(...texts.map(t=>t.bounds.x),start.x,end.x)-margin;
      const right=Math.max(...texts.map(t=>t.bounds.x+t.bounds.width),start.x,end.x)+margin;
      const x=Math.abs(left-start.x)+Math.abs(left-end.x)<=Math.abs(right-start.x)+Math.abs(right-end.x)?left:right;
      proposed.push({kind:'connection-bendpoints',objectId:connection.id,before:connection.bendpoints??connection.bendPoints,after:[{x:Math.round(x),y:Math.round(start.y)},{x:Math.round(x),y:Math.round(end.y)}]});continue;
    }
    const node=geometry.nodes?.find(n=>participants.includes(n.id));
    if(node&&text&&!pins.includes(node.id)&&validRect(node.bounds)&&point.safeParse(node.position).success) {
      const before=node.position,b=node.bounds,t=text.bounds;
      const candidates=[{x:before.x,y:before.y+t.y+t.height+12-b.y},{x:before.x,y:before.y+t.y-12-(b.y+b.height)},{x:before.x+t.x+t.width+12-b.x,y:before.y},{x:before.x+t.x-12-(b.x+b.width),y:before.y}]
        .map(after=>({kind:'node-position',objectId:node.id,before,after:{x:Math.round(after.x),y:Math.round(after.y)}})).sort((a,b)=>displacement(a)-displacement(b));
      const selected=candidates.find(c=>{try{assertChange(c,geometry,pins,groups);const moved={...b,x:b.x+c.after.x-before.x,y:b.y+c.after.y-before.y};return !(geometry.texts??[]).some(t=>t.ownerId!==node.id&&nonzeroIntersection(moved,t.bounds))&&!(geometry.nodes??[]).some(n=>n.id!==node.id&&nonzeroIntersection(moved,n.bounds));}catch{return false;}});
      if(selected){proposed.push(selected);continue;}
    }
    const annotation=geometry.annotations?.find(a=>participants.includes(a.id)||a.id===text?.ownerId);
    if(annotation&&annotation.nativeBounds&&text?.clipped&&validRect(text.unclippedBounds)&&!pins.includes(annotation.id)) {
      const before=annotation.nativeBounds??annotation.bounds,after={...before,width:Math.ceil(Math.max(before.width,text.unclippedBounds.x+text.unclippedBounds.width-before.x+12)),height:Math.ceil(Math.max(before.height,text.unclippedBounds.y+text.unclippedBounds.height-before.y+12))};
      const candidate={kind:'annotation-bounds',objectId:annotation.id,before,after};try{assertChange(candidate,geometry,pins,groups);proposed.push(candidate);continue;}catch{}
    }
    unresolved.push({findingId:finding.id??finding.findingId,reason:'No conservative local candidate preserves the current pins/groups.'});
  }
  const seen=new Set();const validated=[];
  for(const change of proposed){assertChange(change,geometry,pins,groups);const key=`${change.kind}:${change.objectId}`;if(seen.has(key)){if(changes)throw new Error('Duplicate object edits are not a valid exact-before plan.');continue;}seen.add(key);if(canonical(change.before)!==canonical(change.after))validated.push(change);}
  const planId=randomUUID();const plan={planId,contextId:context.contextId,scopeId:geometry.scopeId??context.scopeId??context.workflowId,sourceEvidenceId:geometry.evidenceId,sourceFrameId:geometry.sourceFrameId,beforeRevisions:context.revisions,changes:validated,pins,groups,cycle,ranking:{semanticPreservation:true,unresolvedHighPriority:unresolved.length,pinsAndGroupsPreserved:true,movedObjects:validated.length,totalDisplacement:validated.reduce((sum,c)=>sum+displacement(c),0)},predictedIssues:unresolved,requiresNativeRevalidation:true,semanticChangesAllowed:false,alternative:unresolved.length?'Widen the affected gutter or move the containing group after explicit review.':null};
  return store?store.put('layout-plan',plan,{id:planId}):immutable(plan);
}
