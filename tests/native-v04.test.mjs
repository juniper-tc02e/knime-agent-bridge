import {VERSION} from '../src/cli.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {guardedMcp} from './helpers/guarded-native.mjs';
import {configureTableCreatorFixture,executeAndWaitForNode} from './helpers/table-fixture.mjs';

test('v0.4 native contexts, detached preview, Unicode persistence and two-UUID effective Reader lineage',{skip:process.env.KNIME_V04_NATIVE!=='1',timeout:600000},async()=>{
 const client=new Client({name:'knime-v04-native',version:'0.4.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),'--runtime',process.env.KNIME_AGENT_RUNTIME],stderr:'pipe'}));
 const evidence=[];
 const raw=async(name,input={})=>{const r=await client.callTool({name,arguments:input});evidence.push({name,input,result:r.structuredContent,isError:r.isError??false});if(r.isError)throw Object.assign(new Error(JSON.stringify(r.structuredContent)),{detail:r.structuredContent});return r.structuredContent;};
 const invoke=guardedMcp(raw),core=(operation,args={})=>invoke('knime_core_call',{operation,args}),gateway=(method,params={})=>invoke('knime_gateway_call',{method,params}),desktop=(operation,args={})=>invoke('knime_desktop_call',{operation,args});
 const until=async(fn)=>{for(let i=0;i<150;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('Bounded native observation did not settle');};
 let receipt={status:'RUNNING',startedAt:new Date().toISOString()};
 try{
  const connection=await raw('knime_connection');const health=await raw('knime_health');
  assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace-w2-v04-/);assert.equal(health.bridgeVersion,VERSION);
  receipt={...receipt,health,connection};
  const item=await gateway('SpaceService.createWorkflow',{spaceId:'local',spaceProviderId:'local',itemId:'root',itemName:'V04 Synthetic '+Date.now()});
  await desktop('desktop.openProject',{spaceId:'local',spaceProviderId:'local',itemId:item.id});
  let project=await until(async()=>(await gateway('ApplicationService.getState')).openProjects.find(p=>p.origin?.itemId===item.id));let projectId=project.projectId;
  const command=workflowCommand=>gateway('WorkflowService.executeWorkflowCommand',{projectId,workflowId:'root',workflowCommand});
  const add=async(factory,x)=>{const found=await raw('knime_nodes',{query:factory,limit:10});assert.ok(found.nodes.some(n=>n.factoryId===factory),'Factory must be installed/discovered');return (await command({kind:'add_node',nodeFactory:{className:factory},position:{x,y:150}})).newNodeId;};
  const producer=await add('org.knime.base.node.io.tablecreator.TableCreator3NodeFactory',100);
  await configureTableCreatorFixture(core,{projectId,nodeId:producer});await executeAndWaitForNode(core,{projectId,nodeId:producer});
  const original=await core('core.settings.get',{projectId,nodeId:producer}),before=await raw('knime_table',{projectId,nodeId:producer,portIndex:1});
  const preview=await raw('knime_settings_preview',{projectId,nodeId:producer,patches:[{path:['model','columns','0','values'],type:'stringArray',value:['preview','',null]}]});
  assert.equal(preview.applied,false);assert.equal(preview.accepted,true);assert.ok(preview.diff.some(d=>d.changed));assert.equal(preview.resetImpact.exact,false);
  assert.deepEqual((await core('core.settings.get',{projectId,nodeId:producer})).settings,original.settings);
  assert.equal((await raw('knime_table',{projectId,nodeId:producer,portIndex:1})).tableIdentity,before.tableIdentity);
  await assert.rejects(core('core.settings.patch',{projectId,nodeId:producer,patches:[{path:['model','numRows'],type:'xint',value:3}]}),/type|match|xlong/i);
  await assert.rejects(raw('knime_settings_preview',{projectId,nodeId:producer,patches:[{path:['model','numRows'],value:'3'},{path:['model','numRows'],value:'4'}]}),/duplicate|overlap/i);
  assert.equal((await raw('knime_table',{projectId,nodeId:producer,portIndex:1})).tableIdentity,before.tableIdentity);
  const unicode=['中英 · → 🚀','PASS Â· caller-origin','line1\nline2\u0001','',null];
  const encoding=await add('org.knime.base.node.io.tablecreator.TableCreator3NodeFactory',300);
  await core('core.settings.patch',{projectId,nodeId:encoding,patches:[{path:['model','numRows'],type:'xlong',value:String(unicode.length)},{path:['model','columns','0','name'],value:'encoding'},{path:['model','columns','0','values'],type:'stringArray',value:unicode}]});
  await executeAndWaitForNode(core,{projectId,nodeId:encoding});assert.deepEqual((await raw('knime_table',{projectId,nodeId:encoding,portIndex:1})).rows.map(r=>r.values[0]),unicode);
  const relay=await add('org.knime.base.node.io.tablecreator.TableCreator3NodeFactory',500),row=await add('org.knime.base.node.flowvariable.tablerowtovariable3.TableToVariable3NodeFactory',700),location=await add('org.knime.filehandling.utility.nodes.stringtopath.variable.StringToPathVariableNodeFactory',900),reader=await add('org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory',1100);
  for(const [sourceNodeId,sourcePortIdx,destinationNodeId,destinationPortIdx] of [[relay,1,row,1],[row,1,location,1],[location,1,reader,0]])await command({kind:'connect',sourceNodeId,sourcePortIdx,destinationNodeId,destinationPortIdx});
  const fixtureDir=path.join(fileURLToPath(health.workspace),'data','v04');await fs.mkdir(fixtureDir,{recursive:true});
  const runs=[];for(let round=0;round<2;round++){
   const runId=randomUUID(),dir=path.join(fixtureDir,runId);await fs.mkdir(dir);const file=path.join(dir,'predictions.csv');
   const rows=Array.from({length:1005},(_,i)=>[String(i),String(round),String(i%2),String(i/1005),String(i+1),String(i+2),String(i+3),String(i+4),runId]);
   const bytes='id,round,target,probability,a,b,c,d,run_id\n'+rows.map(r=>r.join(',')).join('\n')+'\n';await fs.writeFile(file,bytes);
   await fs.writeFile(path.join(dir,'receipt.json'),JSON.stringify({runId,rows:1005,sha256:createHash('sha256').update(bytes).digest('hex')}));
   await core('core.settings.patch',{projectId,nodeId:relay,patches:[{path:['model','numRows'],type:'xlong',value:'1'},{path:['model','columns','0','name'],value:'predictions_path'},{path:['model','columns','0','values'],type:'stringArray',value:[file]}]});
   if(round===0){
    await core('core.settings.patch',{projectId,nodeId:row,patches:[{path:['model','column_selection','included_names'],type:'stringArray',value:['predictions_path']},{path:['model','column_selection','enforce_option'],value:'EnforceInclusion'}]});
    await core('core.settings.patch',{projectId,nodeId:location,patches:[{path:['model','variable_filter','included_names'],type:'stringArray',value:['predictions_path']},{path:['model','fail_on_missing_file_folder'],value:true}]});
    // The CSV reader has native defaults; configure its stored fallback to run 1, then bind a whole typed FSLocation.
    const defaults=await core('core.settings.get',{projectId,nodeId:reader});receipt.readerDefaults=defaults;
    await core('core.settings.patch',{projectId,nodeId:reader,patches:[
     {path:['model','csvReaderParameters','multiFileSelectionParams','source','path','path'],value:file},
     {path:['variables','version'],type:'xstring',value:'V_2019_09_13',createParents:true},
     {path:['variables','tree','csvReaderParameters','multiFileSelectionParams','source','path','used_variable'],type:'xstring',value:'predictions_path_location',createParents:true},
     {path:['variables','tree','csvReaderParameters','multiFileSelectionParams','source','path','exposed_variable'],type:'xstring',value:null,createParents:true}
    ]});
   }
   await executeAndWaitForNode(core,{projectId,nodeId:reader});
   const lineage=await raw('knime_dependencies',{projectId,nodeId:reader});assert.equal(lineage.effectiveModelSettings.status,'native_resolved');assert.ok(JSON.stringify(lineage.effectiveModelSettings.settings).includes(runId));assert.equal(lineage.connections.length,3);
   const pages=[];let offset='0',identity;do{const page=await raw('knime_table',{projectId,nodeId:reader,portIndex:1,offset,limit:1000});if(identity)assert.equal(page.tableIdentity,identity);identity=page.tableIdentity;pages.push(page);offset=page.hasMore?page.nextOffset:null;}while(offset!==null);
   const output=pages.flatMap(p=>p.rows);assert.equal(output.length,1005);assert.equal(pages[0].schema.length,9);assert.equal(new Set(output.map(r=>r.key)).size,1005);assert.deepEqual(new Set(output.map(r=>r.values[8])),new Set([runId]));assert.deepEqual(output.map(r=>r.values),Array.from({length:1005},(_,i)=>[i,round,i%2,i/1005,i+1,i+2,i+3,i+4,runId]));assert.equal((await raw('knime_table',{projectId,nodeId:reader,portIndex:1,limit:1})).tableIdentity,identity);
   assert.equal((await raw('knime_table',{projectId,nodeId:producer,portIndex:1})).tableIdentity,before.tableIdentity);
   runs.push({runId,file,lineage,pages:pages.map(p=>({offset:p.offset,rows:p.rows.length,tableIdentity:p.tableIdentity})),producerIdentity:before.tableIdentity});
  }
  assert.notEqual(runs[0].runId,runs[1].runId);
  const checkOutput=async expectedId=>{
   const ctx=await raw('knime_context',{action:'bind',projectId});
   const expected=Array.from({length:1005},(_,i)=>({key:'Row'+i,values:[i,1,i%2,i/1005,i+1,i+2,i+3,i+4,expectedId]}));
   const task=await raw('knime_verify_workflow',{action:'begin',input:{contextId:ctx.contextId,requestedScopes:['root'],requiredDimensions:['executionData'],dataChecks:[{id:'current-run-output',scopeId:'root',nodeId:reader,portIndex:1,kind:'data',expected,coverage:'full'}]}});
   const assessed=await raw('knime_verify_workflow',{action:'assess',input:{taskId:task.taskId,evidenceIds:[]}});
   return assessed;
  };
  const wrongUuid=await checkOutput(randomUUID());assert.notEqual(wrongUuid.dimensions.executionData.status,'passed');
  await core('core.settings.patch',{projectId,nodeId:relay,patches:[{path:['model','columns','0','values'],type:'stringArray',value:[runs[0].file]}]});
  await executeAndWaitForNode(core,{projectId,nodeId:reader});
  const stale=await checkOutput(runs[1].runId);assert.notEqual(stale.dimensions.executionData.status,'passed');
  await core('core.settings.patch',{projectId,nodeId:reader,patches:[{path:['variables','tree','csvReaderParameters','multiFileSelectionParams','source','path','used_variable'],value:'missing_v04_variable'}]});
  const missingVariable=await raw('knime_dependencies',{projectId,nodeId:reader});assert.equal(missingVariable.effectiveModelSettings.status,'unavailable');
  await core('core.settings.patch',{projectId,nodeId:relay,patches:[{path:['model','columns','0','values'],type:'stringArray',value:[runs[1].file]}]});
  await core('core.settings.patch',{projectId,nodeId:reader,patches:[{path:['variables','tree','csvReaderParameters','multiFileSelectionParams','source','path','used_variable'],value:'predictions_path_location'}]});
  await executeAndWaitForNode(core,{projectId,nodeId:reader});
  const correctUuid=await checkOutput(runs[1].runId);assert.equal(correctUuid.dimensions.executionData.status,'passed');
  assert.equal((await raw('knime_table',{projectId,nodeId:producer,portIndex:1})).tableIdentity,before.tableIdentity);
  receipt.outputChecks={wrongUuid:wrongUuid.dimensions.executionData.status,stale:stale.dimensions.executionData.status,missingVariable:missingVariable.effectiveModelSettings.status,correctUuid:correctUuid.dimensions.executionData.status};
  const oldContext=await raw('knime_context',{action:'bind',projectId});
  await desktop('desktop.saveProject',{projectId});await until(async()=>!(await core('core.snapshot',{projectId,depth:0})).dirty);
  await desktop('desktop.closeProject',{projectId});await until(async()=>!(await gateway('ApplicationService.getState')).openProjects.some(p=>p.projectId===projectId));
  await assert.rejects(raw('knime_context',{action:'inspect',contextId:oldContext.contextId}),/CONTEXT_CHANGED/);
  await raw('knime_context',{action:'prune'});
  await desktop('desktop.openProject',{spaceId:'local',spaceProviderId:'local',itemId:item.id});project=await until(async()=>(await gateway('ApplicationService.getState')).openProjects.find(p=>p.origin?.itemId===item.id));projectId=project.projectId;
  await until(async()=>{try{return await core('core.snapshot',{projectId,depth:0});}catch{return null;}});
  assert.notEqual(projectId,oldContext.projectId);assert.deepEqual((await raw('knime_table',{projectId,nodeId:encoding,portIndex:1})).rows.map(r=>r.values[0]),unicode);
  assert.deepEqual(new Set((await raw('knime_table',{projectId,nodeId:reader,portIndex:1,limit:1000})).rows.map(r=>r.values[8])),new Set([runs[1].runId]));
  receipt={...receipt,status:'PASS',finishedAt:new Date().toISOString(),item,projectId,producer,encoding,relay,row,location,reader,preview,runs,unicode};
 }catch(error){receipt={...receipt,status:'FAIL',error:error.message};throw error;}
 finally{await fs.mkdir('runtime/evidence',{recursive:true});await fs.writeFile('runtime/evidence/native-v04-receipt.json',JSON.stringify(receipt,null,2));await fs.writeFile('runtime/evidence/native-v04-calls.json',JSON.stringify(evidence,null,2));await client.close();}
});
