import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

async function jars(directory){const out=[];for(const e of await fs.readdir(directory,{withFileTypes:true})){const p=path.join(directory,e.name);if(e.isDirectory())out.push(...await jars(p));else if(p.endsWith('.jar'))out.push(p);}return out;}
const quote=s=>'"'+s.replaceAll('\\','/')+'"';
test('actual installed native exporter obeys production bounds without launching KNIME',{timeout:60000},async()=>{
 const plugins=path.join(process.env.KNIME_HOME??path.join(process.env.LOCALAPPDATA,'Programs','KNIME'),'plugins'),scratch=path.resolve('build','native-export-harness-'+randomUUID());await fs.mkdir(scratch,{recursive:true});
 const unpacked=(await fs.readdir(plugins,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name.startsWith('com.sun.jna_')).map(e=>path.join(plugins,e.name));
 const cp=[scratch,path.resolve('build/classes'),...unpacked,...await jars(plugins)].join(path.delimiter),jdk=process.env.KNIME_AGENT_JDK??'C:/Program Files/Java/jdk-24';
 const helper=path.resolve('java/src/org/knime/agent/NativeWorkflowExport.java'),sources=[path.resolve('tests/java/NativeWorkflowExportHarness.java')];try{await fs.access(helper);sources.push(helper);}catch(e){if(e.code!=='ENOENT')throw e;}
 const compile=path.join(scratch,'compile.args');await fs.writeFile(compile,['--release','21','-encoding','UTF-8','-cp',quote(cp),'-d',quote(scratch),...sources.map(quote)].join('\n'));
 const compiled=spawnSync(path.join(jdk,'bin/javac.exe'),['@'+compile],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 const run=path.join(scratch,'run.args');await fs.writeFile(run,['-ea','-cp',quote(cp),'org.knime.agent.NativeWorkflowExportHarness',quote(scratch)].join('\n'));
 const executed=spawnSync(path.join(jdk,'bin/java.exe'),['@'+run],{encoding:'utf8',windowsHide:true,timeout:30000});await fs.writeFile(path.join(scratch,'execution.txt'),executed.stdout+executed.stderr);assert.equal(executed.status,0,executed.stdout+executed.stderr);assert.match(executed.stdout,/actual installed exporter/);
});

test('fresh native bridge exports only its saved isolated Unicode workflow',{skip:process.env.KNIME_V05_NATIVE!=='1',timeout:180000},async()=>{
 const {BridgeClient}=await import('../src/client.mjs');const runtime=process.env.KNIME_AGENT_RUNTIME;assert.ok(runtime,'Explicit isolated runtime required');
 const client=new BridgeClient({runtime,session:process.env.KNIME_V05_SESSION??process.env.KNIME_AGENT_SESSION,timeoutMs:10000});const selected=await client.selectSession();assert.match(selected.workspace,/knime-agent-bridge.*runtime.*workspace-w2-v04-/,'Only the owned synthetic workspace is allowed');
 const canonicalRuntime=await fs.realpath(runtime),workspace=await fs.realpath(fileURLToPath(selected.workspace)),relative=path.relative(canonicalRuntime,workspace);assert.ok(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Synthetic workspace must remain within the explicit canonical runtime');
 if(process.env.KNIME_V05_PID)assert.equal(selected.pid,Number(process.env.KNIME_V05_PID));
 const latest=JSON.parse(await fs.readFile('artifacts/latest.json','utf8'));const expected=createHash('sha256').update(await fs.readFile(path.join('artifacts',latest.bundle))).digest('hex');assert.equal(selected.bundleFingerprint,expected,'Restart the owned synthetic process with the latest exact JAR before this test');
 const contexts=[];const bind=async projectId=>{const ctx=await client.call('context.bind',projectId?{projectId}:{});contexts.push(ctx.contextId);return ctx;};
 const mutate=async(op,args,ctx)=>{const current=await client.call('context.inspect',{contextId:ctx.contextId});return client.call(op,args,{precondition:{contextId:current.contextId,expected:current.revisions??{}}});};
 const poll=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('Bounded export fixture observation timed out');};
 const receiptFile=path.join(runtime,'evidence','export-v05-'+randomUUID()+'.json');let receipt={status:'RUNNING',startedAt:new Date().toISOString(),jar:latest.bundle,expectedBundleFingerprint:expected};let projectId,firstError;
 try{
  const scope=await bind();const item=await mutate('gateway.call',{method:'SpaceService.createWorkflow',params:{spaceId:'local',spaceProviderId:'local',itemId:'root',itemName:'V05 Export 中英 🚀 '+Date.now()}},scope);
  await mutate('desktop.openProject',{spaceId:'local',spaceProviderId:'local',itemId:item.id},scope);
  const project=await poll(async()=>(await client.call('gateway.call',{method:'ApplicationService.getState'})).openProjects.find(p=>p.origin?.itemId===item.id));projectId=project.projectId;
  await poll(async()=>{try{return await client.call('core.snapshot',{projectId,depth:0});}catch{return null;}});const ctx=await bind(projectId);
  const factory='org.knime.base.node.io.tablecreator.TableCreator3NodeFactory';const nodes=await client.call('core.nodes.search',{query:factory,limit:10});assert.ok(nodes.nodes.some(n=>n.factoryId===factory));
  const added=await mutate('gateway.call',{method:'WorkflowService.executeWorkflowCommand',params:{projectId,workflowId:'root',workflowCommand:{kind:'add_node',nodeFactory:{className:factory},position:{x:100,y:150}}}},ctx);const nodeId=added.newNodeId;
  const {configureTableCreatorFixture,executeAndWaitForNode}=await import('./helpers/table-fixture.mjs');
  const core=async(op,args)=>['core.settings.patch','core.execute'].includes(op)?mutate(op,args,ctx):client.call(op,args);
  await configureTableCreatorFixture(core,{projectId,nodeId});const unicode=['中英 · → 🚀','',null];
  await core('core.settings.patch',{projectId,nodeId,patches:[{path:['model','columns','0','values'],type:'stringArray',value:unicode}]});await executeAndWaitForNode(core,{projectId,nodeId});
  assert.deepEqual((await client.call('core.table.read',{projectId,nodeId,portIndex:1})).rows.map(r=>r.values[0]),unicode);
  await assert.rejects(mutate('core.workflow.export',{projectId},ctx),e=>e.code==='WORKFLOW_NOT_SAVED');assert.equal((await client.call('core.snapshot',{projectId,depth:0})).dirty,true);
  await mutate('desktop.saveProject',{projectId},ctx);await poll(async()=>!(await client.call('core.snapshot',{projectId,depth:0})).dirty);
  const exported=await mutate('core.workflow.export',{projectId,excludeData:false,maxBytes:1048576,maxEntries:1000},ctx);
  assert.equal(exported.manifestComplete,true);assert.equal(exported.savePerformed,false);assert.equal(exported.freshInference,'unverified');assert.equal(createHash('sha256').update(await fs.readFile(exported.path)).digest('hex'),exported.sha256);assert.ok(exported.manifest.some(e=>e.name.endsWith('/workflow.knime')));assert.ok(exported.manifest.every(e=>typeof e.sha256==='string'&&e.sha256.length===64));
  assert.ok(exported.manifest.some(e=>/\/(?:port_|internalTables|filestore)/.test(e.name)),'Native export with data must retain actual cached output resources');
  await assert.rejects(mutate('core.workflow.export',{projectId,maxBytes:1},ctx),/bound/);
  await assert.rejects(mutate('core.workflow.export',{projectId,workflowId:'root'},ctx),/Unknown argument|root only/);
  await assert.rejects(mutate('core.workflow.export',{projectId,path:path.join(runtime,'unexpected.knwf')},ctx),/Unknown argument/);
  assert.deepEqual((await client.call('core.table.read',{projectId,nodeId,portIndex:1})).rows.map(r=>r.values[0]),unicode);assert.equal((await client.call('core.snapshot',{projectId,depth:0})).dirty,false);
  receipt={...receipt,status:'PASSED',health:await client.call('health'),projectId,nodeId,unicodeTableVerified:true,export:exported,negativeCases:['dirty-root','byte-bound','nested-selector','arbitrary-output'],visualReview:'separate-fixture',durableReopen:'separate-fixture'};
  await mutate('desktop.closeProject',{projectId},ctx);await poll(async()=>!(await client.call('gateway.call',{method:'ApplicationService.getState'})).openProjects.some(p=>p.projectId===projectId));projectId=null;
 }catch(error){firstError=error;receipt={...receipt,status:'FAILED',error:{code:error.code??'ASSERTION_OR_IO',message:error.message,details:error.details??null}};}
 finally{
  receipt.finishedAt=new Date().toISOString();
  try{await fs.mkdir(path.dirname(receiptFile),{recursive:true});await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2),{flag:'wx'});}
  catch(evidenceError){if(firstError){firstError.secondaryEvidenceIO={code:evidenceError.code??'EVIDENCE_IO',message:evidenceError.message,receiptFile};console.error('Export fixture evidence write failed after primary error:',JSON.stringify(firstError.secondaryEvidenceIO));}else{firstError=evidenceError;firstError.message='Export fixture evidence could not be persisted: '+evidenceError.message;}}
  for(const contextId of contexts)await client.call('context.release',{contextId}).catch(()=>{});
 }
 if(firstError)throw firstError;
});
