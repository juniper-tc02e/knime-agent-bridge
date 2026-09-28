import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {guardedMcp} from './helpers/guarded-native.mjs';
import {configureTableCreatorFixture,executeAndWaitForNode,tableCreatorFixtureRows} from './helpers/table-fixture.mjs';

test('real MCP sees and repairs node-on-instruction layout while retaining executed table data', {timeout:180000,skip:process.env.KNIME_VISUAL_ACCEPTANCE!=='1'},async()=>{
 const runtime=process.env.KNIME_AGENT_RUNTIME||path.resolve('runtime');
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/server.mjs'),'--runtime',runtime],stderr:'pipe'});
 const client=new Client({name:'knime-visual-acceptance',version:'0.2.0'});await client.connect(transport);
 const raw=async(name,args={})=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw new Error(JSON.stringify(r.structuredContent));return r.structuredContent;};
 const invoke=guardedMcp(raw),gateway=(method,params={})=>invoke('knime_gateway_call',{method,params});
 const core=(operation,args)=>invoke('knime_core_call',{operation,args});
 const until=async(fn)=>{for(let i=0;i<100;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw new Error('Native postcondition timed out');};
 try {
  const health=await raw('knime_health');assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace/);assert.match(health.bridgeVersion,/^0\.2\./);
  const item=await gateway('SpaceService.createWorkflow',{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName:'Visual Beta '+Date.now()});
  await invoke('knime_desktop_call',{operation:'desktop.openProject',args:{spaceProviderId:'local',spaceId:'local',itemId:item.id}});
  const project=await until(async()=>(await gateway('ApplicationService.getState')).openProjects.find(p=>p.origin?.itemId===item.id));
  const projectId=project.projectId,cmd=workflowCommand=>gateway('WorkflowService.executeWorkflowCommand',{projectId,workflowId:'root',workflowCommand});
  const node=await cmd({kind:'add_node',position:{x:160,y:145},nodeFactory:{className:'org.knime.base.node.io.tablecreator.TableCreator3NodeFactory'}});
  await configureTableCreatorFixture(core,{projectId,nodeId:node.newNodeId});await executeAndWaitForNode(core,{projectId,nodeId:node.newNodeId});
  await cmd({kind:'add_workflow_annotation',bounds:{x:100,y:100,width:500,height:320},borderColor:'#D6A400'});
  const annotated=await gateway('WorkflowService.getWorkflow',{projectId,workflowId:'root',versionId:null,includeInteractionInfo:true});const annotation=annotated.workflow.workflowAnnotations[0];assert.ok(annotation);
  await cmd({kind:'update_workflow_annotation',annotationId:annotation.id,text:'<h2>Read these instructions first</h2><p>Keep the node below this text. Check the visible result before finishing.</p>',borderColor:'#D6A400'});
  let context=await raw('knime_context',{action:'bind',projectId});
  const original=await raw('knime_table',{projectId,nodeId:node.newNodeId,portIndex:1});assert.deepEqual(original.rows.map(r=>r.values),tableCreatorFixtureRows);
  const image=async(label)=>{
   const result=await client.callTool({name:'knime_canvas_view',arguments:{contextId:context.contextId,mode:'overview'}});
   if(result.isError)throw new Error(JSON.stringify(result.structuredContent));
   const pixels=result.content.find(c=>c.type==='image');assert.ok(pixels,'Real MCP must return an image block');
   await fs.writeFile(path.join(runtime,label+'.png'),Buffer.from(pixels.data,'base64'));
   return result.structuredContent.evidence;
  };
  const before=await image('visual-before');
  const bad=await raw('knime_layout_check',{evidenceId:before.evidenceId});assert.ok(bad.findings.some(f=>f.kind==='node-text-overlap'&&f.severity==='high'));
  const plan=await raw('knime_layout_plan',{evidenceId:before.evidenceId,groups:[{annotationId:annotation.id,nodeIds:[node.newNodeId]}]});assert.ok(plan.changes.length);
  context=await raw('knime_context',{action:'inspect',contextId:context.contextId});
  const applied=await raw('knime_layout_apply',{planId:plan.planId,precondition:{contextId:context.contextId,expected:context.revisions}});
  assert.ok(['applied','completed'].includes(applied.operation?.status??applied.status),JSON.stringify(applied));
  await assert.rejects(raw('knime_layout_apply',{planId:plan.planId,precondition:{contextId:context.contextId,expected:context.revisions}}),/claimed|applied|REVISION|stale/i);
  await assert.rejects(raw('knime_layout_check',{evidenceId:before.evidenceId}),/REVISION|stale/i);
  const after=await image('visual-after');
  const checked=await raw('knime_layout_check',{evidenceId:after.evidenceId});assert.equal(checked.findings.filter(f=>f.severity==='high').length,0,JSON.stringify(checked.findings));
  const preserved=await raw('knime_table',{projectId,nodeId:node.newNodeId,portIndex:1});assert.deepEqual(preserved.rows,original.rows);
  assert.equal((await raw('knime_workflow',{projectId})).nodes[0].state,'EXECUTED');
  await invoke('knime_desktop_call',{operation:'desktop.saveProject',args:{projectId}});await until(async()=>!(await raw('knime_workflow',{projectId})).dirty);
  await fs.writeFile(path.join(runtime,'visual-acceptance.json'),JSON.stringify({projectId,item,nodeId:node.newNodeId,before,after,findingsBefore:bad.findings,findingsAfter:checked.findings,applied,tableRows:preserved.rows,saved:true},null,2));
 } finally {await client.close();}
});
