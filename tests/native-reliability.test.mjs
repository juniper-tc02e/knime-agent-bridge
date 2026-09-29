import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BridgeClient} from '../src/client.mjs';
import {waitForCondition} from '../src/wait.mjs';
import {needsGuard,targetArgs} from './helpers/guarded-native.mjs';
import {configureTableCreatorFixture} from './helpers/table-fixture.mjs';

test('a durable acceptance write failure explicitly reports no native dispatch',{skip:process.env.KNIME_RELIABILITY_TEST!=='1',timeout:30000},async()=>{
 const client=new BridgeClient(),health=await client.call('health');assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace-w2-/);
 const context=await client.call('context.bind',{}),operationId=randomUUID(),blocker=path.join(client.runtime,'sessions',health.id,'operations',operationId+'.events');
 await fs.writeFile(blocker,'Synthetic obstruction before durable acceptance',{flag:'wx'});
 try {await assert.rejects(client.call('gateway.call',{method:'SpaceService.createWorkflow',params:{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName:'Must Not Be Created '+operationId}},{operationId,precondition:{contextId:context.contextId,expected:{}}}),e=>e.details.nativeDispatch==='not_started');}
 finally {await fs.unlink(blocker);}
});

test('a final receipt failure preserves the successful native result for reconciliation',{skip:process.env.KNIME_RELIABILITY_TEST!=='1',timeout:30000},async()=>{
 const client=new BridgeClient(),health=await client.call('health');assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace-w2-/);
 const context=await client.call('context.bind',{}),operationId=randomUUID(),events=path.join(client.runtime,'sessions',health.id,'operations',operationId+'.events');
 await fs.mkdir(events);const blocker=path.join(events,'0004.json');await fs.writeFile(blocker,'{}',{flag:'wx'});
 const itemName='Final Receipt Recovery '+operationId;
 try {await assert.rejects(client.call('gateway.call',{method:'SpaceService.createWorkflow',params:{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName}},{operationId,precondition:{contextId:context.contextId,expected:{}}}),error=>{
  assert.equal(error.details.nativeReturnedSuccessfully,true);assert.equal(error.details.journalStatus,'outcome_not_persisted');assert.equal(typeof error.details.nativeResult?.id,'string');return true;
 });assert.ok((await fs.stat(path.join(fileURLToPath(health.workspace),itemName))).isDirectory());}
 finally {await fs.unlink(blocker);}
});

test('incomplete Random Forest defaults are visible and cannot execute or save as reloadable',{skip:process.env.KNIME_RELIABILITY_TEST!=='1',timeout:120000},async()=>{
 const client=new BridgeClient();const health=await client.call('health',{});assert.match(health.workspace,/knime-agent-bridge.*runtime.*workspace-w2-/);
 const call=async(op,args={})=>{let options={};if(needsGuard(op,args)){const c=await client.call('context.bind',targetArgs(op,args));options.precondition={contextId:c.contextId,expected:c.revisions??{}};}return client.call(op,args,options);};
 const gateway=(method,params={})=>call('gateway.call',{method,params});
 const itemName='Reliability Regression '+Date.now();const item=await gateway('SpaceService.createWorkflow',{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName});
 await call('desktop.openProject',{spaceProviderId:'local',spaceId:'local',itemId:item.id});
 let project;for(let i=0;i<120;i++){project=(await gateway('ApplicationService.getState')).openProjects.find(p=>p.origin?.itemId===item.id);if(project)break;await new Promise(r=>setTimeout(r,200));}assert.ok(project);
 const projectId=project.projectId,cmd=workflowCommand=>gateway('WorkflowService.executeWorkflowCommand',{projectId,workflowId:'root',workflowCommand});
 const source=await cmd({kind:'add_node',position:{x:100,y:150},nodeFactory:{className:'org.knime.base.node.io.tablecreator.TableCreator3NodeFactory'}});
 await configureTableCreatorFixture(call,{projectId,nodeId:source.newNodeId});
 const forest=await cmd({kind:'add_node',position:{x:320,y:150},nodeFactory:{className:'org.knime.base.node.mine.treeensemble2.node.randomforest.learner.regression.RandomForestRegressionLearnerNodeFactory'}});
 await cmd({kind:'connect',sourceNodeId:source.newNodeId,sourcePortIdx:1,destinationNodeId:forest.newNodeId,destinationPortIdx:1});
 const settings=await call('core.settings.get',{projectId,nodeId:forest.newNodeId});
 assert.equal(settings.settingsValidation?.validForSave,false,'Partial Random Forest settings must not be advertised as reloadable');
 assert.equal(settings.settingsValidation?.serialization,'failed');
 await assert.rejects(call('core.execute',{projectId,nodeId:forest.newNodeId}),e=>e.code==='NODE_SETTINGS_INVALID'&&e.details.nativeDispatch==='not_started');
 await assert.rejects(gateway('NodeService.changeNodeStates',{projectId,workflowId:'root',nodeIds:[forest.newNodeId],action:'execute'}),e=>e.code==='NODE_SETTINGS_INVALID'&&e.details.nativeDispatch==='not_started');
 const executionContext=await client.call('context.bind',{projectId});
 await assert.rejects(client.call('gateway.call',{method:'NodeService.changeNodeStates',params:[projectId,'root',[forest.newNodeId],'execute']},{precondition:{contextId:executionContext.contextId,expected:executionContext.revisions}}),e=>e.code==='INVALID_ARGUMENT'&&e.details.nativeDispatch==='not_started'&&/named parameter/.test(e.message));
 await assert.rejects(call('desktop.saveProject',{projectId}),e=>e.code==='NODE_SETTINGS_INVALID'&&e.details.nativeDispatch==='not_started');
 const snapshot=await call('core.snapshot',{projectId,nodeId:forest.newNodeId});assert.equal(snapshot.settingsValidation?.validForSave,false);
 const log=path.join(fileURLToPath(health.workspace),'.metadata','knime','knime.log');
 const errorCount=async()=>((await fs.readFile(log,'utf8').catch(()=>'' )).match(/Could not save model/g)||[]).length;
 const errorsBefore=await errorCount();for(let i=0;i<8;i++){await call('context.bind',{projectId});await call('core.settings.get',{projectId,nodeId:forest.newNodeId});}
 assert.equal(await errorCount(),errorsBefore,'Read-only bridge settings/revision checks must not repeatedly log swallowed save failures');
 const patches=[
  ['targetColumn','xstring','value'],['nrModels','xint',5],['splitCriterion','xstring','InformationGainRatio'],
  ['missingValueHandling','xstring','XGBoost'],['useAverageSplitPoints','xboolean',true],['useBinaryNominalSplits','xboolean',true],['fingerprintColumn','xstring',null],
 ].map(([key,type,value])=>({path:['model',key],type,value}));
 for(const [keys,type,value] of [
  [['filter-type'],'xstring','STANDARD'],[['included_names'],'stringArray',['label']],[['excluded_names'],'stringArray',[]],[['enforce_option'],'xstring','EnforceInclusion'],
 ])patches.push({path:['model','columnFilterConfig',...keys],type,value,createParents:true});
 const repaired=await call('core.settings.patch',{projectId,nodeId:forest.newNodeId,patches});
 assert.equal(repaired.settingsValidation.validForSave,true,'A complete typed repair must be possible without editing workflow XML');
 await call('core.execute',{projectId,nodeId:forest.newNodeId});
 assert.equal((await waitForCondition(client,{session:client.session,condition:'execution',projectId,nodeId:forest.newNodeId,timeoutMs:30000})).status,'settled');
 await call('desktop.saveProject',{projectId});assert.equal((await waitForCondition(client,{session:client.session,condition:'saved',projectId})).status,'settled');
 await call('desktop.closeProject',{projectId});assert.equal((await waitForCondition(client,{session:client.session,condition:'closed',projectId})).status,'settled');
 await call('desktop.openProject',{spaceProviderId:'local',spaceId:'local',itemId:item.id});
 const reopened=await waitForCondition(client,{session:client.session,condition:'opened',origin:{providerId:'local',spaceId:'local',itemId:item.id}});assert.equal(reopened.status,'settled');
 const persisted=await call('core.settings.get',{projectId:reopened.observation.projectId,nodeId:forest.newNodeId});assert.equal(persisted.settingsValidation.validForSave,true);
 const ui=await call('desktop.uiState');assert.equal(ui.blocked,false,'Repaired workflow must reopen without a Workflow Load warning');
 await call('desktop.closeProject',{projectId:reopened.observation.projectId});
 assert.equal((await waitForCondition(client,{session:client.session,condition:'closed',projectId:reopened.observation.projectId})).status,'settled');
 // Produce one deliberately corrupt CLOSED synthetic copy to exercise KNIME's real load dialog.
 const brokenName='Reliability Load Warning '+Date.now();const broken=await gateway('SpaceService.createWorkflow',{spaceProviderId:'local',spaceId:'local',itemId:'root',itemName:brokenName});
 const workspace=fileURLToPath(health.workspace),sourceFolder=path.join(workspace,itemName),brokenFolder=path.join(workspace,brokenName);
 assert.ok(path.resolve(brokenFolder).startsWith(path.resolve(workspace)+path.sep));
 await fs.cp(sourceFolder,brokenFolder,{recursive:true});
 const folder=(await fs.readdir(brokenFolder)).find(name=>name.startsWith('Random Forest Learner'));assert.ok(folder);
 const settingsPath=path.join(brokenFolder,folder,'settings.xml'),savedXml=await fs.readFile(settingsPath,'utf8');
 assert.match(savedXml,/<entry key="splitCriterion"[^>]*\/>/);await fs.writeFile(settingsPath,savedXml.replace(/<entry key="splitCriterion"[^>]*\/>/,''));
 await call('desktop.openProject',{spaceProviderId:'local',spaceId:'local',itemId:broken.id});
 let warning;for(let i=0;i<100;i++){const state=await call('desktop.uiState');warning=state.shells?.find(s=>s.title==='Workflow Load'&&s.visible);if(warning)break;await new Promise(r=>setTimeout(r,150));}
 assert.ok(warning,'KNIME should expose its actual workflow load warning');const context=await call('context.bind',{});
 if(warning.detailsCollapsed) {
  const reveal=warning.actions.find(a=>a.kind==='reveal-load-details');assert.ok(reveal);
  await client.call('desktop.dialogAction',{dialogId:warning.dialogId,fingerprint:warning.fingerprint,actionId:reveal.actionId},{precondition:{contextId:context.contextId,expected:{}}});
  warning=(await call('desktop.uiState')).shells.find(s=>s.dialogId===warning.dialogId);assert.ok(warning&&!warning.detailsCollapsed);
 }
 assert.match(JSON.stringify(warning.controls),/splitCriterion/);assert.ok(warning.actions.length===1);
 const dismissed=await client.call('desktop.dialogAction',{dialogId:warning.dialogId,fingerprint:warning.fingerprint,actionId:warning.actions[0].actionId},{precondition:{contextId:context.contextId,expected:{}}});assert.equal(dismissed.accepted,true);
 const recovered=await waitForCondition(client,{session:client.session,condition:'opened',origin:{providerId:'local',spaceId:'local',itemId:broken.id}});assert.equal(recovered.status,'settled');
 await assert.rejects(call('desktop.saveProject',{projectId:recovered.observation.projectId}),e=>e.code==='NODE_SETTINGS_INVALID');
});
