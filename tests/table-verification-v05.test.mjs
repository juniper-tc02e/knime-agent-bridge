import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTable} from '../src/table-verification.mjs';

function fixture({rows,replace=false}={}){
 const schema=['id','run_id','target','probability'].map(name=>({name,type:'synthetic',encoding:'number-or-string'}));let calls=0;
 return {session:'synthetic-session',calls:()=>calls,call:async(op,args)=>{
  assert.equal(op,'core.table.read');assert.equal(args.portIndex,1);calls++;
  const id=replace&&calls>1?'replaced':'immutable-table';
  if(args.expectedTableIdentity&&args.expectedTableIdentity!==id)throw Object.assign(new Error('table identity mismatch'),{code:'TABLE_IDENTITY_CHANGED'});
  const offset=Number(args.offset??0),page=rows.slice(offset,offset+args.limit);
  return {schema,rows:page.map((values,i)=>({key:'Row'+(offset+i),values})),offset:String(offset),nextOffset:String(offset+page.length),totalRows:String(rows.length),hasMore:offset+page.length<rows.length,tableIdentity:id,stableReadPolicy:'native-immutable-buffered-table',revisions:{execution:'e1',configuration:'c1',structure:'s1'},source:{projectId:'p',nodeId:'n',portIndex:1}};
 }};
}
const args={projectId:'p',nodeId:'n',portIndex:1,pageSize:1000,maxRows:10000};
test('3544 full synthetic rows have exact coverage, constants, unique keys and named tie-aware metrics',async()=>{
 const rows=Array.from({length:3544},(_,i)=>[i,'run-A',i%2,i%2?.75:.25]);const client=fixture({rows});
 const result=await verifyTable(client,{...args,expectations:{rowCount:3544,uniqueColumns:['id'],constants:{run_id:'run-A'},metrics:{labelColumn:'target',scoreColumn:'probability',positiveLabel:1,threshold:.5,expectedAccuracy:1,expectedRocAuc:1}}});
 assert.equal(result.status,'passed');assert.equal(result.coverage,'full');assert.equal(result.rowsRead,3544);assert.equal(result.pagesRead,4);assert.equal(client.calls(),5);assert.equal(result.metrics.rocAuc,1);assert.equal(result.freshInference,'unverified');
});
test('positive label reversal changes accuracy and AUC, ties count half and null metrics fail',async()=>{
 const tied=fixture({rows:[[1,'A',0,.5],[2,'A',1,.5],[3,'A',0,.5],[4,'A',1,.5]]});
 const r=await verifyTable(tied,{...args,expectations:{metrics:{labelColumn:'target',scoreColumn:'probability',positiveLabel:1,threshold:.5}}});assert.equal(r.metrics.rocAuc,.5);assert.equal(r.metrics.accuracy,.5);
 const reversed=await verifyTable(fixture({rows:[[1,'A',0,.25],[2,'A',1,.75]]}),{...args,expectations:{metrics:{labelColumn:'target',scoreColumn:'probability',positiveLabel:0,expectedRocAuc:1}}});assert.equal(reversed.status,'failed');assert.equal(reversed.metrics.rocAuc,0);
 const missing=await verifyTable(fixture({rows:[[1,'A',0,null],[2,'A',1,.75]]}),{...args,expectations:{metrics:{labelColumn:'target',scoreColumn:'probability',positiveLabel:1}}});assert.equal(missing.status,'failed');assert.match(missing.failures.join(' '),/null|finite/i);
});
test('mid-page replacement rejects changed identity and cannot certify complete output',async()=>{
 await assert.rejects(verifyTable(fixture({rows:Array.from({length:1001},(_,i)=>[i,'A',0,.5]),replace:true}),{...args}),/identity/i);
});
test('bounded reads, wrong constants, duplicate named keys and absent class cannot pass',async()=>{
 const r=await verifyTable(fixture({rows:[[1,'A',0,.5],[1,'A',0,.5]]}),{...args,expectations:{rowCount:2,uniqueColumns:['id'],constants:{run_id:'B'},metrics:{labelColumn:'target',scoreColumn:'probability',positiveLabel:1}}});assert.equal(r.status,'failed');assert.ok(r.failures.length>=3);
 const bounded=await verifyTable(fixture({rows:Array.from({length:1001},(_,i)=>[i,'A',0,.5])}),{...args,maxRows:1000});assert.equal(bounded.status,'incomplete');assert.equal(bounded.coverage,'incomplete');
});
