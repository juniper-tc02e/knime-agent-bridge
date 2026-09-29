import { createHash } from 'node:crypto';
import { canonical, digest, immutable } from './store.mjs';

function walk(node,fn) {fn(node);for(const child of node?.nodes??[])walk(child,fn);if(node?.workflow)walk(node.workflow,fn);}
function hasMarker(value,predicate) {if(!value||typeof value!=='object')return false;if(predicate(value))return true;return Object.values(value).some(v=>hasMarker(v,predicate));}
function fields(value,keys) {return Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));}
function compareRevision(a,b) {return ['structure','configuration','execution'].every(k=>typeof a?.[k]==='string'&&a[k]===b?.[k]);}

/** Full values require a caller-proven stable native table read policy; never inferred from count/schema. */
export async function integritySnapshot(context,{tableOutputs=[],mode='full',pageSize=1000,sampleRows=100,maxRows=1000000,maxPages=10000}={},deps={}) {
  if(!['full','sampled'].includes(mode))throw new Error('Integrity mode must be full or sampled.');
  if(!Array.isArray(tableOutputs)||tableOutputs.some(o=>typeof o.nodeId!=='string'||!Number.isInteger(o.portIndex)||o.portIndex<0))throw new Error('Explicit node/port tableOutputs are required.');
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isInteger(maxPages)||maxPages<1||!Number.isInteger(sampleRows)||sampleRows<1||!Number.isInteger(maxRows)||maxRows<1)throw new Error('Invalid bounded table read limits.');
  if(typeof deps.readSnapshot!=='function')throw new Error('readSnapshot adapter required.');
  const before=await deps.readSnapshot(context);const graph=before.workflow??before;
  const structure=[],configuration=[],layout=[],executionStates={};let complete=true,settingsComplete=true,protectedSettings=false;
  walk(graph,n=>{
    if(n.childrenTruncated||n.omittedNodes||n.connectionsTruncated)complete=false;
    const port=p=>fields(p,['index','name','type','className','specClassName','optional','hidden']);
    structure.push({...fields(n,['id','gatewayId','factoryId','kind']),inputPorts:(n.inputPorts??[]).map(port),outputPorts:(n.outputPorts??[]).map(port)});
    for(const c of n.connections??[]) structure.push({connection:fields(c,['id','source','destination','destinationPort','type','flowVariable','sourceNodeId','targetNodeId','sourcePort','targetPort','sourceNode','destNode','destPort','sourcePortIndex','destPortIndex'])});
    if(n.id)executionStates[n.id]=n.state??'unknown';
    if(n.factoryId && n.settings===undefined)settingsComplete=false;
    if(n.settingsAvailable===false||n.settingsValidation?.validForSave===false&&n.factoryId)settingsComplete=false;
    if(n.settings!==undefined){configuration.push({id:n.id??null,settings:n.settings});if(hasMarker(n.settings,v=>v.redacted===true||v.protected===true))protectedSettings=true;}
    if(n.variables!==undefined)configuration.push({id:n.id??null,variables:n.variables});
    layout.push({id:n.id??null,...fields(n,['name','label','position','bounds','annotation']),annotations:n.annotations??[],connections:(n.connections??[]).map(c=>fields(c,['id','bendpoints','bendPoints']))});
  });
  const coverage={structure:complete?'full':'incomplete',configuration:settingsComplete&&complete?'full':'incomplete',protectedSettings:protectedSettings?(deps.protectedSettingsPreserved===true?'native-preserved':'incomplete'):'not_present',tableValues:tableOutputs.length?'full':'none',outputs:[],stableReadPolicy:deps.stableReadPolicy??'unverified',gaps:[]};
  const fingerprints=[];
  for(const output of tableOutputs) {
    const result={...output,coverage:'incomplete',rowsHashed:'0',reason:null};let offset=0n,count=0n,schema=null,total=null,opaque=false,completeOutput=false,tableIdentity=null,tokenStable=true;
    const hash=createHash('sha256');
    try {
      if(typeof deps.readTablePage!=='function')throw new Error('Table paging adapter unavailable.');
      for(let pageIndex=0;pageIndex<maxPages;pageIndex++) {
        const remaining=mode==='sampled'?sampleRows-Number(count):maxRows-Number(count);
        if(remaining<=0)break;
        const page=await deps.readTablePage(context,{...output,offset:String(offset),limit:Math.min(pageSize,remaining)});
        if(!Array.isArray(page.schema)||!Array.isArray(page.rows)||!/^[0-9]+$/.test(String(page.totalRows))||!/^[0-9]+$/.test(String(page.offset)))throw new Error('Malformed table page.');
        if(BigInt(page.offset)!==offset)throw new Error('Table page offset mismatch.');
        if(deps.stableReadPolicy==='native-immutable-table-token') {
          if(typeof page.tableIdentity!=='string'||!page.tableIdentity||page.stableReadPolicy!=='native-immutable-buffered-table')tokenStable=false;
          if(tableIdentity!==null&&page.tableIdentity!==tableIdentity)throw new Error('Native immutable table identity changed during paging.');
          tableIdentity=page.tableIdentity??null;
        }
        if(schema===null){schema=page.schema;total=BigInt(page.totalRows);hash.update(canonical({schema,totalRows:String(total)}));}
        else if(canonical(schema)!==canonical(page.schema)||total!==BigInt(page.totalRows))throw new Error('Table schema/count changed during paging.');
        for(const row of page.rows) {
          if(typeof row.key!=='string'||!Array.isArray(row.values)||row.values.length!==schema.length)throw new Error('Malformed typed table row.');
          if(hasMarker(row.values,v=>v.opaque===true||v.truncated===true))opaque=true;
          hash.update('\n');hash.update(canonical({key:row.key,values:row.values.map((value,i)=>({type:schema[i].type??null,encoding:schema[i].encoding??null,missing:value===null,value}))}));count++;
        }
        const expectedOffset=offset+BigInt(page.rows.length);
        if(!page.hasMore){if(expectedOffset!==total)throw new Error('Table ended before total row coverage.');completeOutput=true;break;}
        if(!page.rows.length||!/^[0-9]+$/.test(String(page.nextOffset))||BigInt(page.nextOffset)!==expectedOffset)throw new Error('Noncontiguous or stalled table paging.');
        offset=expectedOffset;
      }
      if(deps.stableReadPolicy==='native-immutable-table-token'&&tokenStable&&tableIdentity) {
        const final=await deps.readTablePage(context,{...output,offset:'0',limit:1});
        tokenStable=final.tableIdentity===tableIdentity&&final.stableReadPolicy==='native-immutable-buffered-table';
      }
      const stable=deps.stableReadPolicy==='native-immutable-table-revision-guarded'||deps.stableReadPolicy==='native-read-lease'||(deps.stableReadPolicy==='native-immutable-table-token'&&tokenStable&&!!tableIdentity);
      result.coverage=opaque||!stable?'incomplete':mode==='sampled'?'sampled':completeOutput?'full':'incomplete';
      result.reason=opaque?'Opaque/truncated cells lack deterministic typed values.':!stable?'Stable table read policy is unverified.':!completeOutput&&mode==='full'?'Bounded read ended before all rows.':null;
      result.rowsHashed=String(count);fingerprints.push({...output,digest:hash.digest('hex'),rowCount:total===null?null:String(total),coverage:result.coverage});
    } catch(error){result.reason=error.message;fingerprints.push({...output,digest:null,coverage:'incomplete'});}
    coverage.outputs.push(result);
    await new Promise(resolve=>setImmediate(resolve));
  }
  const after=await deps.readSnapshot(context);
  if(tableOutputs.length&&!compareRevision(before.revisions,after.revisions)) {
    coverage.outputs.forEach(o=>{o.coverage='incomplete';o.reason='Structure, configuration or execution revision changed or is unavailable.';});fingerprints.forEach(f=>f.coverage='incomplete');
  }
  if(tableOutputs.length)coverage.tableValues=coverage.outputs.some(o=>o.coverage==='incomplete')?'incomplete':mode==='sampled'?'sampled':'full';
  coverage.gaps.push(...coverage.outputs.filter(o=>o.reason).map(o=>({nodeId:o.nodeId,portIndex:o.portIndex,reason:o.reason})));
  return immutable({contextId:context.contextId??null,structureDigest:digest(structure),configurationDigest:digest(configuration),layoutDigest:digest(layout),executionStates,executedOutputFingerprints:fingerprints,coverage});
}
