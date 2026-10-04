import {VERSION} from '../src/cli.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BridgeClient} from '../src/client.mjs';
import {readOperation} from '../src/operations.mjs';

test('native original UUID reconciliation preserves expired outcome and never repeats workflow creation',{skip:process.env.KNIME_V04_NATIVE!=='1',timeout:30000},async()=>{
 const client=new BridgeClient(),health=await client.call('health');assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace-w2-v04-/);assert.equal(health.bridgeVersion,VERSION);
 const context=await client.call('context.bind',{}),precondition={contextId:context.contextId,expected:{}};
 const operationId=randomUUID(),itemName='V04 Reconcile '+operationId,args={method:'SpaceService.createWorkflow',params:{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName}};
 const first=await client.call('gateway.call',args,{operationId,precondition});assert.ok(first.id);
 const before=await readOperation(client,{sessionId:health.id,operationId});assert.equal(before.status,'applied');
 const replay=await client.call('gateway.call',args,{operationId,precondition});assert.equal(replay.deduplicated,true);
 const after=await readOperation(client,{sessionId:health.id,operationId});assert.equal(after.sequence,before.sequence);
 const freshClient=new BridgeClient({runtime:client.runtime,session:health.id});
 await assert.rejects(freshClient.call('gateway.call',{...args,params:{...args.params,itemName:itemName+' Altered'}},{operationId,precondition}),e=>e.code==='OPERATION_ID_REUSED');
 assert.equal((await fs.readdir(fileURLToPath(health.workspace))).filter(n=>n.startsWith(itemName)).length,1);
 // A synthetic old receipt exercises the running native get path, not only JS journal parsing.
 const expiredId=randomUUID(),journal=path.join(client.runtime,'sessions',health.id,'operations',expiredId+'.json');
 const expired={operationId:expiredId,sessionId:health.id,status:'applied',sequence:4,expiresAt:'2000-01-01T00:00:00Z',nativeDispatch:'returned'};await fs.writeFile(journal,JSON.stringify(expired),{flag:'wx'});
 const expiredBytes=await fs.readFile(journal),native=await client.call('operation.get',{operationId:expiredId});assert.equal(native.status,'applied');assert.equal(native.retention.expired,true);assert.equal(native.retention.cancellationImplied,false);assert.deepEqual(await fs.readFile(journal),expiredBytes);
 // Obstruct only response publication after native dispatch; recover locally without redelivery.
 const uncertainId=randomUUID(),uncertainName='V04 Lost Response '+uncertainId,blocker=path.join(client.runtime,'sessions',health.id,'responses',uncertainId+'.json');await fs.mkdir(blocker);
 try{
  await assert.rejects(client.call('gateway.call',{method:'SpaceService.createWorkflow',params:{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName:uncertainName}},{operationId:uncertainId,precondition}),e=>['IPC_ERROR','REQUEST_TIMEOUT'].includes(e.code)&&e.details.outcome==='unknown');
  let recovered;for(let i=0;i<100;i++){try{recovered=await readOperation(client,{sessionId:health.id,operationId:uncertainId});if(recovered.status==='applied')break;}catch(error){if(error.code!=='OPERATION_NOT_FOUND')throw error;}await new Promise(r=>setTimeout(r,50));}
  assert.equal(recovered.status,'applied');assert.equal((await fs.readdir(fileURLToPath(health.workspace))).filter(n=>n.startsWith(uncertainName)).length,1);
  await fs.mkdir('runtime/evidence',{recursive:true});await fs.writeFile('runtime/evidence/native-reconciliation-v04.json',JSON.stringify({health,operationId,expiredId,uncertainId,first,before,after,native,recovered,effectCount:1,resubmittedUnknown:false},null,2));
 }finally{await fs.rmdir(blocker);await client.call('context.release',{contextId:context.contextId});}
});
