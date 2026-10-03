import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchTool,toolCatalog} from '../src/catalog.mjs';
test('v0.4 explicit connection and non-mutating preview/lineage tools forward exact scopes',async()=>{
 const calls=[];const client={connectionDiagnostics:async options=>({runtime:'/isolated',...options}),call:async(op,args,options)=>{calls.push({op,args,options});return {applied:false};}};
 assert.equal((await dispatchTool(client,'knime_connection',{session:'fixture'})).runtime,'/isolated');
 await dispatchTool(client,'knime_settings_preview',{projectId:'p',workflowId:'root:3',nodeId:'root:3:7',patches:[{path:['model','x'],value:'new'}]});
 assert.equal(calls[0].op,'core.settings.preview');assert.equal(calls[0].args.workflowId,'root:3');assert.equal(calls[0].options.precondition,undefined);
 await dispatchTool(client,'knime_dependencies',{projectId:'p',workflowId:'root:3',nodeId:'root:3:7'});
 assert.equal(calls[1].op,'dependency.inspect');assert.equal(calls[1].args.nodeId,'root:3:7');
 for(const name of ['knime_connection','knime_settings_preview','knime_dependencies'])assert.equal(toolCatalog.find(t=>t.name===name).annotations.readOnlyHint,true);
 await assert.rejects(dispatchTool(client,'knime_dependencies',{projectId:'p',nodeId:'n',unexpected:true}),e=>e.code==='INVALID_ARGUMENT');
});
