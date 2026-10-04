import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {executeAndWaitForNode} from './helpers/table-fixture.mjs';
import {v05Calls,creatorColumnsPatches,endOwnedMcpWithEof} from './helpers/v05-native.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const expectedSession=process.env.KNIME_V05_SESSION;
const tableFactory='org.knime.base.node.io.tablecreator.TableCreator3NodeFactory';
const variableFactory='org.knime.base.node.flowvariable.tablerowtovariable3.TableToVariable3NodeFactory';

test('frozen v0.5 native MCP full cohort and copied executed-parent scalar path lineage',{skip:process.env.KNIME_V05_NATIVE!=='1',timeout:600000},async()=>{
  const runId=randomUUID(),evidenceDirectory=path.join(root,'runtime/evidence/native-v05',runId);await fs.mkdir(evidenceDirectory,{recursive:true});
  const runtime=process.env.KNIME_AGENT_RUNTIME;
  const lifecycleFile=path.join(evidenceDirectory,'mcp-lifecycle.json');
  const client=new Client({name:'v05-native-acceptance-'+runId,version:'0.5.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs'),'--runtime',runtime,'--session',expectedSession,'--lifecycle-file',lifecycleFile],stderr:'pipe'});
  let stderr='';transport.stderr.on('data',bytes=>{stderr+=bytes.toString();});
  let receipt={status:'RUNNING',runId,startedAt:new Date().toISOString(),runtime,evidenceDirectory,cases:{table:{status:'NOT_STARTED'},copy:{status:'NOT_STARTED'}},limitations:[]};
  const extraContexts=new Set();
  const save=async()=>{await fs.writeFile(path.join(evidenceDirectory,'receipt.json'),JSON.stringify(receipt,null,2));};
  await save();let expectedPid,expectedBundle,pinnedDescriptor;
  try {
    assert.ok(typeof runtime==='string'&&runtime.trim(),'Explicit KNIME_AGENT_RUNTIME is required');
    assert.match(expectedSession??'',/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,'Explicit KNIME_V05_SESSION is required');
    const canonicalRoot=await fs.realpath(root),ownedRuntimeRoot=path.join(canonicalRoot,'runtime'),canonicalRuntime=await fs.realpath(runtime);
    assert.equal(path.relative(ownedRuntimeRoot,await fs.realpath(path.join(root,'runtime'))),'','Owned runtime root must not redirect');
    assert.equal(path.relative(path.resolve(runtime),canonicalRuntime),'','Selected runtime must not redirect');
    const relative=path.relative(ownedRuntimeRoot,canonicalRuntime);assert.ok(!relative.startsWith('..')&&!path.isAbsolute(relative),'Selected runtime must be contained in this checkout/runtime');
    pinnedDescriptor=JSON.parse(await fs.readFile(path.join(runtime,'sessions',expectedSession,'session.json'),'utf8'));
    assert.equal(pinnedDescriptor.id,expectedSession);assert.equal(pinnedDescriptor.bridgeVersion,'0.5.0');
    expectedPid=Number(process.env.KNIME_V05_PID);assert.ok(Number.isSafeInteger(expectedPid)&&expectedPid>0,'Explicit KNIME_V05_PID is required');assert.equal(pinnedDescriptor.pid,expectedPid);
    const latest=JSON.parse(await fs.readFile(path.join(root,'artifacts/latest.json'),'utf8'));assert.equal(path.basename(latest.bundle),latest.bundle);
    const jar=path.join(root,'artifacts',latest.bundle);expectedBundle=createHash('sha256').update(await fs.readFile(jar)).digest('hex');
    receipt.pin={session:expectedSession,pid:expectedPid,descriptorStartedAt:pinnedDescriptor.startedAt,latestArtifact:jar,latestArtifactSha256:expectedBundle,latestRevision:latest.revision};await save();
    await client.connect(transport);
  }catch(error){receipt.status='FAIL';receipt.error={phase:'setup_or_connect',message:error.message};try{receipt.mcpExit=await endOwnedMcpWithEof(client,transport);}catch(exitError){receipt.mcpExit={status:'FAIL',message:exitError.message,killed:false};}await save();throw error;}
  const {raw,core,gateway,desktop,calls,details,release}=await v05Calls(client,evidenceDirectory);
  const until=async(fn,reason)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error(reason);};
  const open=async item=>{await desktop('desktop.openProject',{spaceId:'local',spaceProviderId:'local',itemId:item.id});const app=await until(async()=>(await gateway('ApplicationService.getState')).openProjects.find(p=>p.origin?.itemId===item.id),'Synthetic project did not open');await until(async()=>{try{return await core('core.snapshot',{projectId:app.projectId,depth:0});}catch{return null;}},'Opened synthetic model did not load');return app.projectId;};
  const command=(projectId,workflowCommand)=>gateway('WorkflowService.executeWorkflowCommand',{projectId,workflowId:'root',workflowCommand});
  const add=async(projectId,factory,x)=>{const found=await raw('knime_nodes',{query:factory,limit:10});assert.ok(found.nodes.some(n=>n.factoryId===factory));return (await command(projectId,{kind:'add_node',nodeFactory:{className:factory},position:{x,y:160}})).newNodeId;};
  const dependencies=(projectId,nodeId)=>raw('knime_dependencies',{projectId,nodeId,variableNames:['fixture_path','fixture_run'],pathChecks:[{variableName:'fixture_path'}],includeEffectiveSettings:false});
  try {
    const listing=await client.listTools();assert.equal(listing.tools.length,25);receipt.tools=listing.tools.map(t=>t.name);await fs.writeFile(path.join(evidenceDirectory,'tools.json'),JSON.stringify(listing,null,2));
    const connection=await raw('knime_connection',{session:expectedSession,detail:true}),health=await raw('knime_health',{session:expectedSession});
    assert.equal(health.id,expectedSession);assert.equal(health.pid,expectedPid);assert.equal(health.startedAt,pinnedDescriptor.startedAt);assert.equal(health.bridgeVersion,'0.5.0');assert.equal(health.bundleFingerprint,expectedBundle);
    const workspace=fileURLToPath(health.workspace);assert.match(workspace,/knime-agent-bridge.*runtime.*workspace-w2-v04-/,'Native fixture requires owned beta workspace');assert.equal(path.dirname(path.resolve(workspace)),await fs.realpath(runtime));assert.equal(health.workspace,pinnedDescriptor.workspace);assert.equal(health.descriptorOnly,true);
    const diagnostics=await raw('knime_diagnostics',{session:expectedSession});assert.equal(diagnostics.sessionId,expectedSession);assert.equal(diagnostics.descriptorOnly,true);assert.equal(diagnostics.control.parallelNativeCalls,false);assert.equal(diagnostics.control.cancellationDispatch,'serialized_native_lane');
    receipt={...receipt,health,connection,diagnostics};await save();
    const item=await gateway('SpaceService.createWorkflow',{spaceId:'local',spaceProviderId:'local',itemId:'root',itemName:'V05 Synthetic '+runId});
    receipt.cases.table.status='RUNNING';await save();const parentProjectId=await open(item),cohort=await add(parentProjectId,tableFactory,120);
    const rows=Array.from({length:3544},(_,i)=>[i,runId,i%2,i%2?.75:.25,'V05 literal '+i+' · 中英 🚀 '+('x'.repeat(140))]);
    await core('core.settings.patch',{projectId:parentProjectId,nodeId:cohort,patches:creatorColumnsPatches([
      {name:'id',type:'IntCell',values:rows.map(r=>r[0])},{name:'run_id',values:rows.map(r=>r[1])},{name:'target',type:'IntCell',values:rows.map(r=>r[2])},{name:'probability',type:'DoubleCell',values:rows.map(r=>r[3])},{name:'literal',values:rows.map(r=>r[4])}],3544)});
    await executeAndWaitForNode(core,{projectId:parentProjectId,nodeId:cohort});
    const full=await raw('knime_table_verify',{projectId:parentProjectId,nodeId:cohort,portIndex:1,pageSize:1000,maxRows:3544,timeoutMs:60000,expectations:{rowCount:3544,uniqueColumns:['id'],constants:{run_id:runId},metrics:{labelColumn:'target',scoreColumn:'probability',positiveLabel:1,threshold:.5,expectedAccuracy:1,expectedRocAuc:1}}});
    assert.equal(full.status,'passed');assert.equal(full.rowsRead,3544);assert.equal(full.pagesRead,4);assert.equal(full.coverage,'full');assert.equal(full.finalRecheck,true);assert.equal(full.metrics.accuracy,1);assert.equal(full.metrics.rocAuc,1);assert.equal(full.freshInference,'unverified');
    let offset='0',seen=[],identity;const pages=[];
    do {const page=await raw('knime_table',{projectId:parentProjectId,nodeId:cohort,portIndex:1,offset,limit:1000,...(identity?{expectedTableIdentity:identity}:{})});identity??=page.tableIdentity;assert.equal(page.tableIdentity,identity);seen.push(...page.rows);pages.push({offset:page.offset,rows:page.rows.length,identity:page.tableIdentity});offset=page.hasMore?page.nextOffset:null;}while(offset!==null);
    assert.equal(seen.length,3544);assert.equal(new Set(seen.map(r=>r.key)).size,3544);assert.deepEqual(seen.map(r=>r.values),rows);
    assert.equal((await raw('knime_table',{projectId:parentProjectId,nodeId:cohort,portIndex:1,limit:1,expectedTableIdentity:identity})).tableIdentity,identity);assert.equal(identity,full.tableIdentity);
    assert.ok(details.some(d=>d.tool==='knime_table'&&d.bytes>128*1024),'Real native table pages must exercise compact detail retrieval');
    receipt.cases.table={status:'PASS',item,parentProjectId,cohort,full,pages,compactDetails:details.filter(d=>d.tool==='knime_table')};await save();
    receipt.cases.copy.status='RUNNING';await save();const relay=await add(parentProjectId,tableFactory,380),row=await add(parentProjectId,variableFactory,630),sink=await add(parentProjectId,tableFactory,880);
    await command(parentProjectId,{kind:'connect',sourceNodeId:relay,sourcePortIdx:1,destinationNodeId:row,destinationPortIdx:1});
    await command(parentProjectId,{kind:'connect',sourceNodeId:row,sourcePortIdx:1,destinationNodeId:sink,destinationPortIdx:0});
    const parentPhysical=(await dependencies(parentProjectId,sink)).physicalWorkflow;assert.equal(parentPhysical.status,'resolved');
    const parentRoot=await fs.realpath(parentPhysical.currentRoot);assert.ok(!path.relative(workspace,parentRoot).startsWith('..'));
    const pathA=path.join(parentRoot,'data','run-A-'+runId+'.csv');await fs.mkdir(path.dirname(pathA),{recursive:true});await fs.writeFile(pathA,'run_id,value\n'+runId+'-A,1\n',{flag:'wx'});
    const configureRelay=async(projectId,fixturePath,fixtureRun)=>core('core.settings.patch',{projectId,nodeId:relay,patches:creatorColumnsPatches([{name:'fixture_path',values:[fixturePath]},{name:'fixture_run',values:[fixtureRun]}],1)});
    await configureRelay(parentProjectId,pathA,runId+'-A');
    await core('core.settings.patch',{projectId:parentProjectId,nodeId:row,patches:[{path:['model','column_selection','included_names'],type:'stringArray',value:['fixture_path','fixture_run']},{path:['model','column_selection','enforce_option'],value:'EnforceInclusion'}]});
    await core('core.settings.patch',{projectId:parentProjectId,nodeId:sink,patches:creatorColumnsPatches([{name:'proof',values:['literal cached sink']}],1)});
    await executeAndWaitForNode(core,{projectId:parentProjectId,nodeId:sink});
    const parentLineage=await dependencies(parentProjectId,sink);assert.equal(parentLineage.pathChecks[0].status,'within_expected_root');assert.equal(parentLineage.availableVariables.find(v=>v.name==='fixture_run').value,runId+'-A');
    await desktop('desktop.saveProject',{projectId:parentProjectId});await until(async()=>!(await core('core.snapshot',{projectId:parentProjectId,depth:0})).dirty,'Parent save did not settle');
    await desktop('desktop.closeProject',{projectId:parentProjectId});await until(async()=>!(await gateway('ApplicationService.getState')).openProjects.some(p=>p.projectId===parentProjectId),'Parent did not close for native copy');
    const copyContract=await raw('knime_describe',{service:'SpaceService',method:'moveOrCopyItems'}),groupContract=await raw('knime_describe',{service:'SpaceService',method:'createWorkflowGroup'});receipt.copyContracts={copyContract,groupContract};
    assert.deepEqual(copyContract.services[0].methods[0].parameters.map(p=>p.name),['spaceId','spaceProviderId','itemIds','destSpaceId','destWorkflowGroupItemId','copy','collisionHandling']);
    const group=await gateway('SpaceService.createWorkflowGroup',{spaceId:'local',spaceProviderId:'local',itemId:'root'});
    await gateway('SpaceService.moveOrCopyItems',{spaceId:'local',spaceProviderId:'local',itemIds:[item.id],destSpaceId:'local',destWorkflowGroupItemId:group.id,copy:true,collisionHandling:null});
    const copied=await until(async()=>(await gateway('SpaceService.listWorkflowGroup',{spaceId:'local',spaceProviderId:'local',itemId:group.id})).items.find(i=>i.name===item.name),'Native workflow copy did not appear');
    const childProjectId=await open(copied),childContext=await raw('knime_context',{action:'bind',projectId:childProjectId});extraContexts.add(childContext.contextId);assert.equal(childContext.projectId,childProjectId);assert.notEqual(childProjectId,parentProjectId);
    const childBefore=await core('core.snapshot',{projectId:childProjectId,depth:0}),tableBefore=await raw('knime_table',{projectId:childProjectId,nodeId:cohort,portIndex:1,limit:1});
    const inherited=await dependencies(childProjectId,sink),childRoot=await fs.realpath(inherited.physicalWorkflow.currentRoot);assert.notEqual(childRoot,parentRoot);
    const childAfter=await core('core.snapshot',{projectId:childProjectId,depth:0}),tableAfter=await raw('knime_table',{projectId:childProjectId,nodeId:cohort,portIndex:1,limit:1});
    assert.equal(inherited.executedByInspection,false);assert.equal(tableBefore.tableIdentity,tableAfter.tableIdentity);assert.ok(tableBefore.revisions?.structure&&tableAfter.revisions?.execution,'Actual native table scope revisions are required');assert.deepEqual(tableBefore.revisions,tableAfter.revisions);assert.deepEqual(childContext.revisions,inherited.revisions);
    const inheritedPath=inherited.availableVariables.find(v=>v.name==='fixture_path'),inheritedRun=inherited.availableVariables.find(v=>v.name==='fixture_run');
    if(inheritedPath?.value!==pathA||inheritedRun?.value!==runId+'-A') {
      receipt.cases.copy={status:'LIMITATION',reason:'Installed native copy did not retain the executed scalar cache as requested',group,copied,childProjectId,childContext,childBefore,inherited,tableBefore,tableAfter};receipt.limitations.push(receipt.cases.copy.reason);await save();
    }else {
      assert.equal(inherited.pathChecks[0].status,'outside_expected_root');assert.equal(inherited.pathChecks[0].matchesPhysicalWorkflowRoot,false);assert.equal(inherited.pathChecks[0].inspectionExecutedOrResetNodes,false);
      receipt.cases.copy={status:'INHERITED_CACHE_PASS',group,copied,childProjectId,childContext,relay,row,sink,parentRoot,pathA,parentLineage,inherited,tableBefore,tableAfter};await save();
      // A separate, explicit synthetic refresh phase; inspection above never executed/reset a producer.
      const refreshId=randomUUID(),pathB=path.join(childRoot,'data','run-B-'+refreshId+'.csv');await fs.mkdir(path.dirname(pathB),{recursive:true});await fs.writeFile(pathB,'run_id,value\n'+refreshId+'-B,2\n',{flag:'wx'});
      receipt.cases.copy.refreshAuthorization={scope:'this owned synthetic child only',action:'configure relay path/run-B and explicitly execute sink/upstream',refreshId,pathB};await save();
      await configureRelay(childProjectId,pathB,refreshId+'-B');await executeAndWaitForNode(core,{projectId:childProjectId,nodeId:sink});
      const refreshed=await dependencies(childProjectId,sink);assert.equal(refreshed.pathChecks[0].status,'within_expected_root');assert.equal(refreshed.pathChecks[0].matchesPhysicalWorkflowRoot,true);assert.equal(refreshed.availableVariables.find(v=>v.name==='fixture_run').value,refreshId+'-B');assert.equal(refreshed.executedByInspection,false);
      assert.equal((await raw('knime_table',{projectId:childProjectId,nodeId:cohort,portIndex:1,limit:1})).tableIdentity,tableBefore.tableIdentity,'Refresh unrelated scalar relay cannot change cached cohort output');
      receipt.cases.copy={...receipt.cases.copy,status:'PASS',refreshed};await raw('knime_context',{action:'release',contextId:childContext.contextId});extraContexts.delete(childContext.contextId);await save();
    }
    receipt.status=receipt.limitations.length?'PASS_WITH_LIMITATIONS':'PASS';receipt.finishedAt=new Date().toISOString();
  }catch(error){receipt.status='FAIL';for(const c of Object.values(receipt.cases))if(['RUNNING','INHERITED_CACHE_PASS'].includes(c.status))c.status='FAIL';receipt.error={message:error.message,callNumber:error.callNumber,detail:error.detail,stack:error.stack};receipt.finishedAt=new Date().toISOString();throw error;}
  finally {
    receipt.extraContextRelease=[];for(const contextId of extraContexts)try{receipt.extraContextRelease.push(await raw('knime_context',{action:'release',contextId}));}catch(error){receipt.extraContextRelease.push({contextId,error:error.message});}
    receipt.contextRelease=await release();receipt.calls=calls;receipt.compactDetails=details;receipt.callCounts={primaryToolCalls:calls.length,detailChunkCalls:details.reduce((sum,d)=>sum+d.chunks,0),toolsListCalls:1};await save();
    await fs.writeFile(path.join(evidenceDirectory,'mcp-stderr.txt'),stderr);
    try{receipt.mcpExit=await endOwnedMcpWithEof(client,transport);}catch(error){receipt.mcpExit={status:'FAIL',message:error.message,killed:false};receipt.status='FAIL';throw error;}finally{await save();}
    console.log('v05 native acceptance receipt: '+path.join(evidenceDirectory,'receipt.json'));
  }
});
