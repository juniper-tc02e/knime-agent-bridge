import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {BridgeClient} from '../src/client.mjs';

test('an expired queued mutation is rejected before KNIME creates a workflow',async()=>{
 const client=new BridgeClient();const session=await client.selectSession();
 const id=randomUUID(),name='EXPIRED-'+id;
 const directory=path.join(client.runtime,'sessions',session.id);
 const request=path.join(directory,'requests',id+'.json');
 await fs.writeFile(request+'.tmp',JSON.stringify({id,expiresAt:new Date(Date.now()-60000).toISOString(),
  operation:'gateway.call',args:{method:'SpaceService.createWorkflow',params:{spaceId:'local',spaceProviderId:'local',itemId:'root',itemName:name}}}));
 await fs.rename(request+'.tmp',request);
 let response;const resultPath=path.join(directory,'responses',id+'.json');
 for(let i=0;i<100;i++) {
  try {response=JSON.parse(await fs.readFile(resultPath,'utf8'));break;}catch(e){if(e.code!=='ENOENT')throw e;}
  await new Promise(r=>setTimeout(r,50));
 }
 assert.ok(response,'Bridge must return a response for the expired request');
 assert.equal(response.ok,false);assert.match(response.error.message,/expired before execution/i);
 await fs.unlink(resultPath);
 const folder=await client.call('gateway.call',{method:'SpaceService.listWorkflowGroup',params:{spaceId:'local',spaceProviderId:'local',itemId:'root'}});
 assert.equal(folder.items.some(item=>item.name===name),false,'Expired mutation must not have reached KNIME');
 await assert.rejects(fs.access(path.join(directory,'inflight',id+'.json')));
});
