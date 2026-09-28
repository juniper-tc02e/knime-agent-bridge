import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {configureTableCreatorFixture,executeAndWaitForNode,tableCreatorFixtureRows} from './helpers/table-fixture.mjs';
import {guardedMcp} from './helpers/guarded-native.mjs';

// Every operation here crosses the real MCP stdio connection and the live Java
// bridge. The test only creates its own disposable workflow in the beta workspace.
test('MCP creates, configures, edits, executes, inspects and persists a real KNIME workflow', {timeout:180000}, async()=>{
 const client=new Client({name:'knime-native-beta-test',version:'0.1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),'--runtime',process.env.KNIME_AGENT_RUNTIME||path.resolve('runtime')],stderr:'pipe'});
 await client.connect(transport);
 const invoke=guardedMcp(async(name,args={})=>{
  const r=await client.callTool({name,arguments:args});
  if(r.isError)throw new Error(JSON.stringify(r.structuredContent || r.content));
  return r.structuredContent;
 });
 const gateway=(method,params={})=>invoke('knime_gateway_call',{method,params});
 const core=(operation,args={})=>invoke('knime_core_call',{operation,args});
 const desktop=(operation,args={})=>invoke('knime_desktop_call',{operation,args});
 const until=async(fn,reason)=>{for(let n=0;n<100;n++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,200));}throw new Error(reason);};
 try {
  const health=await invoke('knime_health');
  assert.match(health.workspace,/knime-agent-bridge[\\/]runtime[\\/]workspace/,'Native mutation tests require the disposable beta workspace');
  const name='MCP Beta '+Date.now();
  const item=await gateway('SpaceService.createWorkflow',{spaceId:'local',spaceProviderId:'local',itemId:'root',itemName:name});
  await invoke('knime_desktop_call',{operation:'desktop.openProject',args:{spaceId:'local',spaceProviderId:'local',itemId:item.id}});
  const project=await until(async()=>{const app=await gateway('ApplicationService.getState');return app.openProjects.find(p=>p.origin?.itemId===item.id);},'Desktop acknowledged open but the workflow did not open');
  let projectId=project.projectId;
  assert.equal(typeof projectId,'string');
  const command=workflowCommand=>gateway('WorkflowService.executeWorkflowCommand',{projectId,workflowId:'root',workflowCommand});
  const added=await command({kind:'add_node',position:{x:120,y:160},nodeFactory:{className:'org.knime.base.node.io.tablecreator.TableCreator3NodeFactory'}});
  assert.ok(added.newNodeId,'Native add must return the new node ID');
  const nodeId=added.newNodeId;
  const snapshot=await invoke('knime_workflow',{projectId,depth:2});
  assert.equal(snapshot.nodes.length,1);
  assert.equal(snapshot.nodes[0].name,'Table Creator');
  await command({kind:'update_node_label',nodeId,label:'Literal beta fixture'});
  const labelled=await invoke('knime_workflow',{projectId});
  assert.ok(JSON.stringify(labelled.nodes[0]).includes('Literal beta fixture'));
  const before=labelled.nodes[0].bounds;
  await command({kind:'translate',nodeIds:[nodeId],annotationIds:[],connectionBendpoints:{},translation:{x:40,y:20}});
  const moved=await invoke('knime_workflow',{projectId});
  assert.notDeepEqual(moved.nodes[0].bounds,before);
  await gateway('WorkflowService.undoWorkflowCommand',{projectId,workflowId:'root'});
  assert.deepEqual((await invoke('knime_workflow',{projectId})).nodes[0].bounds,before);
  await gateway('WorkflowService.redoWorkflowCommand',{projectId,workflowId:'root'});
  assert.deepEqual((await invoke('knime_workflow',{projectId})).nodes[0].bounds,moved.nodes[0].bounds);
  const settings=await invoke('knime_settings',{projectId,nodeId});
  assert.ok(settings.settings.entries.some(e=>e.key==='model'));
  await configureTableCreatorFixture(core,{projectId,nodeId});
  await executeAndWaitForNode(core,{projectId,nodeId});
  const source=await invoke('knime_table',{projectId,nodeId,portIndex:1,limit:3});
  assert.deepEqual(source.rows.map(r=>r.values),tableCreatorFixtureRows);
  const page=await invoke('knime_table',{projectId,nodeId,portIndex:1,offset:1,limit:1,columns:['value']});
  assert.deepEqual(page.rows.map(r=>r.values),[[2]]);assert.equal(page.hasMore,true);

  const filter=await command({kind:'add_node',position:{x:380,y:180},nodeFactory:{className:'org.knime.base.node.preproc.filter.column.DataColumnSpecFilterNodeFactory'}});
  const filterId=filter.newNodeId;
  await command({kind:'connect',sourceNodeId:nodeId,sourcePortIdx:1,destinationNodeId:filterId,destinationPortIdx:1});
  await core('core.settings.patch',{projectId,nodeId:filterId,patches:[
   {path:['model','column-filter','included_names'],type:'stringArray',value:['value']},
   {path:['model','column-filter','excluded_names'],type:'stringArray',value:['label']},
   {path:['model','column-filter','enforce_option'],type:'xstring',value:'EnforceInclusion'}
  ]});
  await executeAndWaitForNode(core,{projectId,nodeId:filterId});
  const filtered=await invoke('knime_table',{projectId,nodeId:filterId,portIndex:1});
  assert.deepEqual(filtered.rows.map(r=>r.values),[[1],[2],[3]]);
  assert.deepEqual(filtered.schema.map(c=>c.name),['value']);

  const connected=await invoke('knime_workflow',{projectId,depth:2});
  assert.equal(connected.connections.length,1);
  const canvas=await gateway('WorkflowService.getWorkflow',{projectId,workflowId:'root',versionId:null,includeInteractionInfo:true});
  assert.ok(canvas.workflow,'The UI service must see the same live graph');
  const connections=canvas.workflow.connections;
  const connectionId=Array.isArray(connections)?connections[0].id:Object.keys(connections)[0];
  assert.ok(connectionId);
  await command({kind:'delete',nodeIds:[],annotationIds:[],connectionBendpoints:{},connectionIds:[connectionId]});
  assert.equal((await invoke('knime_workflow',{projectId})).connections.length,0);
  await gateway('WorkflowService.undoWorkflowCommand',{projectId,workflowId:'root'});
  assert.equal((await invoke('knime_workflow',{projectId})).connections.length,1);

  await command({kind:'collapse',nodeIds:[filterId],annotationIds:[],connectionBendpoints:{},containerType:'metanode'});
  const nested=await invoke('knime_workflow',{projectId,depth:3});
  const metanode=nested.nodes.find(n=>n.nestedWorkflowId);
  assert.ok(metanode?.workflow?.nodes.some(n=>n.name==='Column Filter'),'Nested nodes must be visible');
  const sourceBefore=await invoke('knime_settings',{projectId,nodeId});
  await assert.rejects(core('core.settings.patch',{projectId,workflowId:metanode.nestedWorkflowId,nodeId,patches:[{path:['model','numRows'],type:'xlong',value:'99'}]}),/outside|not found/i);
  assert.deepEqual((await invoke('knime_settings',{projectId,nodeId})).settings,sourceBefore.settings,'A scoped failure must not modify a root node');
  await gateway('WorkflowService.undoWorkflowCommand',{projectId,workflowId:'root'});
  assert.equal((await invoke('knime_workflow',{projectId})).nodes.length,2);

  await core('core.reset',{projectId,nodeId});
  await assert.rejects(invoke('knime_table',{projectId,nodeId,portIndex:1}),/executed|available|table/i);
  await executeAndWaitForNode(core,{projectId,nodeId:filterId});
  assert.deepEqual((await invoke('knime_table',{projectId,nodeId:filterId,portIndex:1})).rows.map(r=>r.values),[[1],[2],[3]]);
  const exportPath=path.resolve('runtime','beta-table-'+Date.now()+'.table');
  await core('core.port.export',{projectId,nodeId,portIndex:1,path:exportPath});
  assert.ok((await fs.stat(exportPath)).size>0);

  await assert.rejects(gateway('WorkflowService.saveProject',{projectId}),/desktop.saveProject/i);
  await desktop('desktop.saveProject',{projectId});
  await until(async()=>!(await invoke('knime_workflow',{projectId,depth:0})).dirty,'Desktop save did not clear dirty state');
  await desktop('desktop.closeProject',{projectId});
  await until(async()=>!(await gateway('ApplicationService.getState')).openProjects.some(p=>p.projectId===projectId),'Saved project did not close');
  await desktop('desktop.openProject',{spaceId:'local',spaceProviderId:'local',itemId:item.id});
  const reopened=await until(async()=>(await gateway('ApplicationService.getState')).openProjects.find(p=>p.origin?.itemId===item.id),'Saved project did not reopen');
  projectId=reopened.projectId;
  const persisted=await invoke('knime_workflow',{projectId,depth:2});
  assert.equal(persisted.nodes.length,2);assert.equal(persisted.connections.length,1);
  assert.ok(JSON.stringify(persisted.nodes).includes('Literal beta fixture'));
  const persistedRows=await invoke('knime_table',{projectId,nodeId:filterId,portIndex:1});
  assert.deepEqual(persistedRows.rows.map(r=>r.values),[[1],[2],[3]]);
  assert.deepEqual((await invoke('knime_table',{projectId,nodeId,portIndex:1})).rows.map(r=>r.values),tableCreatorFixtureRows);
  await fs.writeFile('runtime/native-fixture.json',JSON.stringify({item,projectId,nodeId,filterId,exportPath},null,2));
 } finally {await client.close();}
});
