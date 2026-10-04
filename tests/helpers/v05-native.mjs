import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {needsGuard,targetArgs} from './guarded-native.mjs';

export async function v05Calls(client,evidenceDirectory) {
  const calls=[],details=[],contexts=new Map();let sequence=0;
  const hash=text=>createHash('sha256').update(text).digest('hex');
  async function raw(name,input={}) {
    const number=++sequence,start=performance.now();
    const result=await client.callTool({name,arguments:input},undefined,{timeout:90000});
    let value=result.structuredContent;
    const file=String(number).padStart(4,'0')+'-'+name+'.json';
    await fs.writeFile(path.join(evidenceDirectory,file),JSON.stringify({name,input,result},null,2));
    calls.push({number,name,file,isError:Boolean(result.isError),elapsedMs:performance.now()-start,structuredBytes:Buffer.byteLength(JSON.stringify(value)),operationId:value?._operation?.operationId??null});
    if(value?.detailAvailable&&value.detail?.id) {
      const ref=value.detail;let text='',offset=0,chunks=0;
      do {
        const r=await client.callTool({name:'knime_detail',arguments:{id:ref.id,offset,limit:16000}},undefined,{timeout:90000});
        assert.notEqual(r.isError,true);const chunk=r.structuredContent;
        assert.equal(chunk.id,ref.id);assert.equal(chunk.sha256,ref.sha256);assert.equal(chunk.offset,offset);
        assert.equal(chunk.nextOffset,offset+chunk.text.length);text+=chunk.text;offset=chunk.nextOffset;chunks++;
        if(!chunk.hasMore)break;assert.ok(chunks<2048,'Detail retrieval must stay bounded');
      }while(true);
      assert.equal(hash(text),ref.sha256);assert.equal(Buffer.byteLength(text),ref.bytes);
      const expanded=JSON.parse(text);await fs.writeFile(path.join(evidenceDirectory,file.replace('.json','.detail.json')),text);
      details.push({number,tool:name,ref,chunks,bytes:Buffer.byteLength(text),verifiedSha256:hash(text)});value=expanded;
    }
    if(result.isError)throw Object.assign(new Error(JSON.stringify(value)),{detail:value,callNumber:number});
    return value;
  }
  async function invoke(name,args={}) {
    const op=name==='knime_gateway_call'?'gateway.call':args.operation,payload=name==='knime_gateway_call'?args:args.args;
    if(op&&payload&&needsGuard(op,payload)&&!args.precondition) {
      const target=targetArgs(op,payload),key=JSON.stringify(target);let context=contexts.get(key);
      if(context)context=await raw('knime_context',{action:'inspect',contextId:context.contextId});
      else context=await raw('knime_context',{action:'bind',...target});
      contexts.set(key,context);args={...args,precondition:{contextId:context.contextId,expected:context.revisions??{}}};
    }
    return raw(name,args);
  }
  return {raw,invoke,calls,details,contexts,core:(operation,args={})=>invoke('knime_core_call',{operation,args}),gateway:(method,params={})=>invoke('knime_gateway_call',{method,params}),desktop:(operation,args={})=>invoke('knime_desktop_call',{operation,args}),
    release:async()=>{const results=[];for(const c of contexts.values())try{results.push(await raw('knime_context',{action:'release',contextId:c.contextId}));}catch(error){results.push({contextId:c.contextId,error:error.message});}return results;}};
}

export function creatorColumnsPatches(columns,rowCount) {
  const patches=[{path:['model','numRows'],type:'xlong',value:String(rowCount)}];
  columns.forEach(({name,type='StringCell',values},index)=> {
    const prefix=['model','columns',String(index)];
    patches.push({path:[...prefix,'name'],type:'xstring',value:name,createParents:true},
      {path:[...prefix,'type','cell_class'],type:'xstring',value:'org.knime.core.data.def.'+type,createParents:true},
      {path:[...prefix,'type','is_null'],type:'xboolean',value:false,createParents:true},
      {path:[...prefix,'values'],type:'stringArray',value:values.map(v=>v===null?null:String(v)),createParents:true});
  });return patches;
}

export async function endOwnedMcpWithEof(client,transport) {
  // SDK close has a kill fallback. Use EOF explicitly and only close SDK after exit.
  const child=transport._process;if(!child)return {alreadyClosed:true};
  const result=await new Promise(resolve=> {
    const timer=setTimeout(()=>resolve({exited:false,pid:child.pid}),10000);
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({exited:true,pid:child.pid,code,signal});});child.stdin.end();
  });
  assert.equal(result.exited,true,'Owned MCP did not exit after EOF; no process was killed');
  assert.equal(result.signal,null);assert.equal(result.code,0);await client.close();return {...result,method:'stdin_eof',killed:false};
}
