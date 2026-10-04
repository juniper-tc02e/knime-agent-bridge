import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BridgeClient,CLIENT_OPERATION} from '../src/client.mjs';
import {dispatchTool} from '../src/catalog.mjs';
import {structuredResult,prepareResult} from '../src/mcp-result.mjs';
import {readDetail} from '../src/details.mjs';

test('MCP retains complete small structured errors without duplicating JSON in text',()=>{
 const value={error:{code:'NO_LIVE_SESSION',message:'Launch an explicitly selected runtime.',details:{sessions:Array.from({length:60},(_,i)=>({id:'s'+i,reason:'unavailable'.repeat(12)}))}}};
 const result=structuredResult(value,true);
 assert.deepEqual(result.structuredContent,value);
 assert.ok(Buffer.byteLength(result.content[0].text)<1500);
 assert.ok(!result.content[0].text.includes('s59'));
});
test('large results have immutable complete detail with bounded Unicode chunk retrieval',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-v05-detail-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const client=new BridgeClient({runtime}),value={state:'applied',operationId:'original-uuid',text:'中英 · → 🚀'.repeat(40000)};
 const result=await prepareResult(client,value);
 assert.equal(result.structuredContent.state,'applied');assert.equal(result.structuredContent.detailAvailable,true);
 const reference=result.structuredContent.detail;
 assert.equal(reference.sha256,createHash('sha256').update(JSON.stringify(value)).digest('hex'));
 assert.ok(JSON.stringify(result).length<4000);
 let json='',offset=0;
 do{const chunk=await readDetail(client,{id:reference.id,offset,limit:16000});assert.equal(chunk.sha256,reference.sha256);json+=chunk.text;offset=chunk.hasMore?chunk.nextOffset:null;}while(offset!==null);
 assert.deepEqual(JSON.parse(json),value);
 const file=path.join(runtime,'details',reference.id+'.json');const body=JSON.parse(await fs.readFile(file,'utf8'));body.payload.state='old-success';await fs.writeFile(file,JSON.stringify(body));
 await assert.rejects(readDetail(client,{id:reference.id}),/integrity|hash/i);
});
test('explicit full mode preserves old structured payload shape',async()=>{
 const value={text:'x'.repeat(140000)};const result=await prepareResult({},value,{resultMode:'full'});assert.deepEqual(result.structuredContent,value);assert.ok(result.content[0].text.length<2000);
});
test('detail identifiers reject paths and unknown selectors',async()=>{
 await assert.rejects(readDetail({}, {id:'../foreign'}),/UUID|identifier/i);
});
test('opt-in success traces preserve each original UUID through compact formatting',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-v05-trace-result-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const client=new BridgeClient({runtime});let count=0;
 client.call=async()=>{const id=String(++count),result={status:'returned',text:'x'.repeat(140000)};Object.defineProperty(result,CLIENT_OPERATION,{value:{operationId:id,trace:{operationId:id,path:'fixture-'+id,sha256:'hash-'+id}}});return result;};
 const a=await dispatchTool(client,'knime_health'),b=await dispatchTool(client,'knime_health');
 const first=await prepareResult(client,a),second=await prepareResult(client,b);
 assert.equal(first.structuredContent._clientOperation.operationId,'1');assert.equal(second.structuredContent._clientOperation.operationId,'2');
 assert.equal(first.structuredContent._clientOperation.trace.path,'fixture-1');
});
test('mutation result uses its original receipt rather than another concurrent call receipt',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-v05-exact-receipt-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const client=new BridgeClient({runtime});client.lastReceipt={operationId:'other-operation'};
 client.call=async()=>{const result={status:'accepted'};Object.defineProperty(result,CLIENT_OPERATION,{value:{operationId:'original-operation',receipt:{operationId:'original-operation',guardCoverage:'apply-time'}}});return result;};
 const result=await dispatchTool(client,'knime_core_call',{operation:'core.execute',args:{projectId:'p',nodeId:'n'},precondition:{contextId:'ctx',expected:{}}});
 assert.equal(result._operation.operationId,'original-operation');
});
