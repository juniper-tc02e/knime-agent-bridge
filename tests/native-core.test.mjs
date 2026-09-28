import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {nativeCall} from './native-health.test.mjs';
import {configureTableCreatorFixture,executeAndWaitForNode} from './helpers/table-fixture.mjs';

// These are native acceptance tests: no fake gateway or model results.
test('installed node discovery returns the real Table Creator factory and port metadata', async () => {
  const found = await nativeCall('core.nodes.search', {query: 'Table Creator', limit: 30}, 120000);
  const creator = found.nodes.find(n => n.name === 'Table Creator');
  assert.ok(creator, 'Installed Table Creator must be discoverable');
  assert.match(creator.factoryId, /TableCreator/);
  const detail = await nativeCall('core.nodes.details', {factoryId: creator.factoryId});
  assert.equal(detail.factoryId, creator.factoryId);
  assert.ok(detail.outputPorts.length > 0);
  assert.equal(typeof detail.categoryPath, 'string');
});

test('live snapshot rejects a project that is not loaded instead of creating a second model', async () => {
  await assert.rejects(nativeCall('core.snapshot', {projectId: 'nonexistent-core-test-project'}),
    e => /project.*not.*(found|loaded)|unknown.*project/i.test(e.message));
});

test('core argument validation rejects malformed targets before even looking up a project', async () => {
  const projectId='nonexistent-argument-validation-project';
  for(const operation of ['core.execute','core.reset','core.cancel']) {
    for(const malformed of [{nodeID:'root:1'},{workflowID:'root:1'},{nodeId:null},{workflowId:null},{nodeId:1},{workflowId:[]}]) {
      await assert.rejects(nativeCall(operation,{projectId,...malformed}), /unknown argument|nodeId must|workflowId must/i);
    }
  }
  await assert.rejects(nativeCall('core.settings.patch',{projectId,patches:[{path:['model','x'],value:1}]}), /nodeId.*required/i);
  await assert.rejects(nativeCall('core.snapshot',{projectId,includeSettings:'false'}), /includeSettings must.*boolean/i);
});

// The parent integration test supplies a new synthetic project, populated with
// a Table Creator containing literal fixtures. Never target normal coursework.
const projectId = process.env.KNIME_CORE_TEST_PROJECT;
const nodeId = process.env.KNIME_CORE_TEST_NODE;
const nestedWorkflowId = process.env.KNIME_CORE_TEST_NESTED_WORKFLOW;
test('rejected target arguments leave the executed workflow and its table unchanged',
  {skip: !projectId || !nodeId || process.env.KNIME_CORE_TABLE_FIXTURE !== '1'}, async () => {
    const before=await nativeCall('core.table.read',{projectId,nodeId,portIndex:1});
    for(const operation of ['core.reset','core.execute','core.cancel']) {
      for(const malformed of [{nodeID:nodeId},{workflowID:'root:999'},{nodeId:null},{workflowId:null}]) {
        await assert.rejects(nativeCall(operation,{projectId,...malformed}), /unknown argument|nodeId must|workflowId must/i);
      }
    }
    assert.deepEqual(await nativeCall('core.table.read',{projectId,nodeId,portIndex:1}),before);
    assert.equal((await nativeCall('core.snapshot',{projectId,nodeId})).state,'EXECUTED');
  });
test('explicit nested workflow scope rejects a root node reference before settings mutation',
  {skip: !projectId || !nodeId}, async () => {
    let scope=nestedWorkflowId,added=false,collapsed=false;
    const gateway=(method,params)=>nativeCall('gateway.call',{method,params});
    const command=workflowCommand=>gateway('WorkflowService.executeWorkflowCommand',{projectId,workflowId:'root',workflowCommand});
    try {
      if(!scope) {
        const before=await nativeCall('core.snapshot',{projectId});
        const ids=new Set(before.nodes.map(n=>n.id));
        const temp=await command({kind:'add_node',position:{x:700,y:200},nodeFactory:{className:'org.knime.base.node.io.tablecreator.TableCreator3NodeFactory'}});added=true;
        await command({kind:'collapse',nodeIds:[temp.newNodeId],annotationIds:[],connectionBendpoints:{},containerType:'metanode'});collapsed=true;
        scope=(await nativeCall('core.snapshot',{projectId,depth:2})).nodes.find(n=>n.nestedWorkflowId&&!ids.has(n.id))?.nestedWorkflowId;
        assert.ok(scope,'Synthetic nested workflow must be created');
      }
      const before=await nativeCall('core.settings.get',{projectId,nodeId});
      await assert.rejects(nativeCall('core.settings.patch', {projectId, workflowId:scope,
        nodeId, patches:[{path:['model','numRows'],type:'xlong',value:'99'}]}), /outside|Node or workflow not found/i);
      assert.deepEqual((await nativeCall('core.settings.get',{projectId,nodeId})).settings,before.settings);
    } finally {
      if(collapsed)await gateway('WorkflowService.undoWorkflowCommand',{projectId,workflowId:'root'});
      if(added)await gateway('WorkflowService.undoWorkflowCommand',{projectId,workflowId:'root'});
    }
  });

test('core discovery supplies callable argument and typed patch contracts', async () => {
  const description=await nativeCall('core.describe');
  const patch=description.contracts['core.settings.patch'].parameters;
  assert.ok(patch.required.includes('projectId'));
  assert.ok(patch.required.includes('patches'));
  assert.ok(patch.required.includes('nodeId'));
  assert.equal(patch.additionalProperties,false);
  assert.equal(patch.properties.patches.items.properties.path.type,'array');
  assert.ok(patch.properties.patches.items.properties.type.enum.includes('longArray'));
  assert.equal(description.contracts['core.table.read'].parameters.properties.limit.maximum,1000);
});

test('live settings preserve the envelope and reject invalid typed patches without changes',
  {skip: !projectId || !nodeId}, async () => {
    const args = {projectId, nodeId};
    const original = await nativeCall('core.settings.get', args);
    assert.equal(original.settings.type, 'config');
    assert.ok(original.settings.entries.some(e => e.key === 'model'));
    await assert.rejects(nativeCall('core.settings.patch', {...args,
      patches: [{path: ['model', 'nonexistent'], type: 'xint', value: 'not-an-integer'}]}));
    await assert.rejects(nativeCall('core.settings.patch', {...args,
      patches: [{path: ['model'], type: 'stringArray', value: []}]}), /native.*array|array.*group/i);
    const after = await nativeCall('core.settings.get', args);
    assert.deepEqual(after.settings, original.settings);
    const snapshot = await nativeCall('core.snapshot', {projectId, depth: 2});
    assert.ok(snapshot.nodes.some(n => n.id === nodeId || n.gatewayId === nodeId));
    assert.ok(snapshot.nodes.every(n => n.gatewayId.startsWith('root:')));
  });

test('table pages retain missing versus empty strings and independent row keys',
  {skip: !projectId || !nodeId || process.env.KNIME_CORE_TABLE_FIXTURE !== '1'}, async () => {
    const args = {projectId, nodeId, portIndex: 1};
    const page = await nativeCall('core.table.read', {...args, offset: 0, limit: 2});
    assert.equal(page.totalRows, '3');
    assert.equal(page.rows.length, 2);
    assert.deepEqual(page.rows.map(r => r.values), [['alpha', 1], ['', 2]]);
    assert.ok(page.rows.every(r => typeof r.key === 'string'));
    assert.equal(page.hasMore, true);
    const tail = await nativeCall('core.table.read', {...args, offset: 2, limit: 2});
    assert.deepEqual(tail.rows.map(r => r.values), [[null, 3]]);
    assert.equal(tail.hasMore, false);
    const selected = await nativeCall('core.table.read', {...args, columns: [1], offset: 1, limit: 1});
    assert.deepEqual(selected.rows.map(r => r.values), [[2]]);
    await assert.rejects(nativeCall('core.table.read', {...args, offset: -1}));
  });

test('native node validation rejects duplicate names without resetting a previously executed table',
  {skip: !projectId || !nodeId || process.env.KNIME_CORE_TABLE_FIXTURE !== '1'}, async () => {
    const args={projectId,nodeId};
    const before=await nativeCall('core.settings.get',args);
    await assert.rejects(nativeCall('core.settings.patch',{...args,patches:[
      {path:['model','columns','1','name'],type:'xstring',value:'label'}
    ]}), /duplicate|unique|same name/i);
    const after=await nativeCall('core.settings.get',args);
    assert.deepEqual(after.settings,before.settings);
    assert.equal(after.state,'EXECUTED');
    const data=await nativeCall('core.table.read',{...args,portIndex:1});
    assert.deepEqual(data.rows.map(row=>row.values),[['alpha',1],['',2],[null,3]]);
  });

test('reset clears native output and asynchronous reexecution restores exact source rows',
  {skip: !projectId || !nodeId || process.env.KNIME_CORE_TABLE_FIXTURE !== '1'}, async () => {
    const args={projectId,nodeId};
    await nativeCall('core.reset',args);
    const reset=await nativeCall('core.port.inspect',{...args,portIndex:1});
    assert.equal(reset.dataAvailable,false);
    const cancel=await nativeCall('core.cancel',args);
    assert.equal(cancel.accepted,true);
    assert.equal(cancel.completionVerified,false);
    await executeAndWaitForNode(nativeCall,args);
    const data=await nativeCall('core.table.read',{...args,portIndex:1});
    assert.deepEqual(data.rows.map(row=>row.values),[['alpha',1],['',2],[null,3]]);
  });

test('port inspection never writes and explicit native export refuses to overwrite',
  {skip: !projectId || !nodeId || process.env.KNIME_CORE_TABLE_FIXTURE !== '1'}, async () => {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'knime-core-port-'));
    const inspectPath=path.join(dir,'inspect.knimeport'),exportPath=path.join(dir,'export.knimeport');
    const args={projectId,nodeId,portIndex:1};
    try {
      await assert.rejects(nativeCall('core.port.inspect',{...args,path:inspectPath}),/core.port.export/);
      await assert.rejects(fs.stat(inspectPath),{code:'ENOENT'});
      const exported=await nativeCall('core.port.export',{...args,path:exportPath});
      const before=await fs.readFile(exportPath);
      assert.ok(before.length>40);
      assert.equal(exported.exportBytes,String(before.length));
      await assert.rejects(nativeCall('core.port.export',{...args,path:exportPath}),/exists|FileAlreadyExists/i);
      assert.deepEqual(await fs.readFile(exportPath),before);
    } finally {
      await fs.unlink(inspectPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
      await fs.unlink(exportPath).catch(e=>{if(e.code!=='ENOENT')throw e;});
      await fs.rmdir(dir);
    }
  });

test('native long cells preserve values beyond JavaScript integer precision',
  {skip: !projectId || !nodeId || process.env.KNIME_CORE_TABLE_FIXTURE !== '1'}, async () => {
    const args={projectId,nodeId};
    try {
      await nativeCall('core.settings.patch',{...args,patches:[
        {path:['model','columns','1','type','cell_class'],type:'xstring',value:'org.knime.core.data.def.LongCell'},
        {path:['model','columns','1','values'],type:'stringArray',value:['9007199254740993','-9007199254740993','9223372036854775807']}
      ]});
      await executeAndWaitForNode(nativeCall,args);
      const data=await nativeCall('core.table.read',{...args,portIndex:1,columns:['value']});
      assert.deepEqual(data.rows.map(row=>row.values),[['9007199254740993'],['-9007199254740993'],['9223372036854775807']]);
      assert.equal(data.schema[0].encoding,'decimal-string');
    } finally {
      await configureTableCreatorFixture(nativeCall,args);
      await executeAndWaitForNode(nativeCall,args);
    }
  });
