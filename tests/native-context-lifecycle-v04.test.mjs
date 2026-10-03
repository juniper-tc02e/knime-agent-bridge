import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// Independent lifecycle stress has its own unchanged deadline; it never edits a graph.
test('live MCP context capacity, release and historical evidence survive bulk lifecycle calls',{skip:process.env.KNIME_V04_NATIVE!=='1',timeout:600000},async()=>{
 const client=new Client({name:'knime-v04-context-stress',version:'0.4.0'}),ids=[],batch=32;
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),'--runtime',process.env.KNIME_AGENT_RUNTIME],stderr:'pipe'}));
 const raw=async(action,args={})=>{const r=await client.callTool({name:'knime_context',arguments:{action,...args}});if(r.isError)throw Error(JSON.stringify(r.structuredContent));return r.structuredContent;};
 const healthResult=await client.callTool({name:'knime_health',arguments:{}});assert.equal(healthResult.isError??false,false);const health=healthResult.structuredContent;
 assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace-w2-v04-/);assert.equal(health.bridgeVersion,'0.4.0');
 try{
  const start=await raw('usage');
  for(let i=0;i<start.remaining;i+=batch){const bound=await Promise.all(Array.from({length:Math.min(batch,start.remaining-i)},()=>raw('bind')));ids.push(...bound.map(c=>c.contextId));}
  const full=await raw('usage');assert.equal(full.active,1024);assert.equal(full.remaining,0);assert.equal(full.warning,true);
  await assert.rejects(raw('bind'),/CONTEXT_LIMIT/);
  const released=ids.pop(),historical=path.join(process.env.KNIME_AGENT_RUNTIME,'quality','context-'+released+'.json'),bytesBefore=await fs.readFile(historical);
  await raw('release',{contextId:released});await assert.rejects(raw('inspect',{contextId:released}),/CONTEXT_CHANGED/);assert.deepEqual(await fs.readFile(historical),bytesBefore);
  const replacement=await raw('bind');assert.notEqual(replacement.contextId,released);ids.push(replacement.contextId);
  for(let i=0;i<ids.length;i+=batch)await Promise.all(ids.slice(i,i+batch).map(contextId=>raw('release',{contextId})));
  ids.length=0;const after=await raw('usage');assert.equal(after.active,start.active);
  await fs.mkdir('runtime/evidence',{recursive:true});await fs.writeFile('runtime/evidence/native-context-lifecycle-v04.json',JSON.stringify({status:'PASS',health,start,full,after,historicalEvidencePreserved:true,releasedIdRejected:true,replacementIdIsNew:true},null,2));
 }finally{
  for(let i=0;i<ids.length;i+=batch)await Promise.all(ids.slice(i,i+batch).map(contextId=>raw('release',{contextId}).catch(()=>{})));
  await client.close();
 }
});
