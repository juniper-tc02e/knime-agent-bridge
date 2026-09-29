import test from 'node:test';
import assert from 'node:assert/strict';
import { integritySnapshot } from '../src/quality/integrity.mjs';

function fixture() {
  const rows=[{key:'Row0',values:['alpha',1]},{key:'Row1',values:['',2]},{key:'Row2',values:[null,3]}];
  const schema=[{name:'name',type:'String',encoding:'string'},{name:'count',type:'Int',encoding:'integer'}];
  const state={nodes:[{id:'0:1',factoryId:'literal',position:{x:10,y:20},state:'EXECUTED',settings:{key:'model',type:'config',entries:[]}}],connections:[],annotations:[],revisions:{structure:'s',configuration:'c',layout:'l',execution:'e'}};
  return {rows,state,deps:{readSnapshot:async()=>structuredClone(state),readTablePage:async(_ctx,args)=>({schema,rows:rows.slice(Number(args.offset),Number(args.offset)+args.limit),totalRows:'3',offset:String(args.offset),nextOffset:String(Math.min(3,Number(args.offset)+args.limit)),hasMore:Number(args.offset)+args.limit<3}),stableReadPolicy:'native-immutable-table-revision-guarded'}};
}
const options={tableOutputs:[{nodeId:'0:1',portIndex:1}],mode:'full',pageSize:2};
test('full paged typed hashing detects one changed cell at identical count/schema',async()=>{
  const f=fixture();const before=await integritySnapshot({contextId:'ctx'},options,f.deps);f.rows[1].values[1]=99;
  const after=await integritySnapshot({contextId:'ctx'},options,f.deps);
  assert.equal(before.coverage.tableValues,'full');assert.equal(after.coverage.tableValues,'full');
  assert.notDeepEqual(before.executedOutputFingerprints,after.executedOutputFingerprints);
  assert.equal(before.structureDigest,after.structureDigest);
});
test('missing versus empty and schema type distinctions enter canonical table hashes',async()=>{
  const f=fixture();const a=await integritySnapshot({},options,f.deps);f.rows[2].values[0]='';const b=await integritySnapshot({},options,f.deps);
  assert.notEqual(a.executedOutputFingerprints[0].digest,b.executedOutputFingerprints[0].digest);
});
test('opaque, unproven stability, sampled and empty selections never report full preservation',async()=>{
  const f=fixture();f.rows[0].values[0]={opaque:true,type:'Unknown',display:'x'};
  assert.equal((await integritySnapshot({},options,f.deps)).coverage.tableValues,'incomplete');
  assert.equal((await integritySnapshot({},options,{...f.deps,stableReadPolicy:null})).coverage.tableValues,'incomplete');
  assert.equal((await integritySnapshot({},{tableOutputs:[],mode:'full'},f.deps)).coverage.tableValues,'none');
  const clean=fixture();assert.equal((await integritySnapshot({},{...options,mode:'sampled',sampleRows:1},clean.deps)).coverage.tableValues,'sampled');
});
test('layout has a separate digest and protected settings are explicitly incomplete',async()=>{
  const f=fixture();const a=await integritySnapshot({},options,f.deps);f.state.nodes[0].position.x=99;const b=await integritySnapshot({},options,f.deps);
  assert.equal(a.structureDigest,b.structureDigest);assert.equal(a.configurationDigest,b.configurationDigest);assert.notEqual(a.layoutDigest,b.layoutDigest);
  f.state.nodes[0].settings.entries.push({key:'password',redacted:true,editable:false});
  assert.equal((await integritySnapshot({},options,f.deps)).coverage.protectedSettings,'incomplete');
});
test('mid-read execution revision drift and paging gaps invalidate full coverage',async()=>{
  const f=fixture();const read=f.deps.readTablePage;f.deps.readTablePage=async(...args)=>{const page=await read(...args);f.state.revisions.execution='changed';return page;};
  assert.equal((await integritySnapshot({},options,f.deps)).coverage.tableValues,'incomplete');
  const gap=fixture();const readGap=gap.deps.readTablePage;gap.deps.readTablePage=async(...args)=>({...await readGap(...args),nextOffset:'99'});
  assert.equal((await integritySnapshot({},options,gap.deps)).coverage.tableValues,'incomplete');
});
test('stale bound context cannot substitute for current snapshot execution revisions',async()=>{
  const f=fixture();delete f.state.revisions;
  assert.equal((await integritySnapshot({revisions:{structure:'s',configuration:'c',execution:'e'}},options,f.deps)).coverage.tableValues,'incomplete');
});
test('native core source/destination port topology and native bounds enter their correct digests',async()=>{
  const f=fixture();f.state.nodes[0].bounds=[10,20,-1,-1];f.state.connections=[{id:'c',source:'0:1',destination:'0:2',sourcePort:1,destinationPort:1}];
  const before=await integritySnapshot({},options,f.deps);f.state.connections[0].destination='0:3';const rewired=await integritySnapshot({},options,f.deps);
  assert.notEqual(before.structureDigest,rewired.structureDigest);f.state.nodes[0].bounds[0]=44;const moved=await integritySnapshot({},options,f.deps);assert.notEqual(rewired.layoutDigest,moved.layoutDigest);
});

test('partial or invalid serialized settings cannot earn complete configuration coverage',async()=>{
 const {state:graph}=fixture();const invalid={...graph,nodes:graph.nodes.map(n=>({...n,settingsValidation:{validForSave:false,serialization:'failed'},settingsAvailable:false}))};
 const result=await integritySnapshot({}, {}, {readSnapshot:async()=>invalid});
 assert.equal(result.coverage.configuration,'incomplete');
});
