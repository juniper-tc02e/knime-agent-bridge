import {createHash} from 'node:crypto';
import {BridgeError} from './client.mjs';
import {canonical} from './quality/store.mjs';

const equal=(a,b)=>canonical(a)===canonical(b);
const opaque=v=>v!==null&&typeof v==='object';
function metricResult(pairs,positiveLabel,threshold) {
 const classes=new Set(pairs.map(p=>canonical(p.label)));
 if(classes.size!==2||!classes.has(canonical(positiveLabel)))throw new Error('Metric labels require exactly two classes including the named positiveLabel.');
 let positives=0,correct=0;
 for(const p of pairs){p.positive=equal(p.label,positiveLabel);if(p.positive)positives++;if((p.score>=threshold)===p.positive)correct++;}
 const negatives=pairs.length-positives;if(!positives||!negatives)throw new Error('ROC AUC requires positive and negative examples.');
 pairs.sort((a,b)=>a.score-b.score);let positiveRankSum=0;
 for(let i=0;i<pairs.length;){let j=i+1;while(j<pairs.length&&pairs[j].score===pairs[i].score)j++;const rank=(i+1+j)/2;for(let k=i;k<j;k++)if(pairs[k].positive)positiveRankSum+=rank;i=j;}
 return {positiveLabel,threshold,positiveCount:positives,negativeCount:negatives,accuracy:correct/pairs.length,
  rocAuc:(positiveRankSum-positives*(positives+1)/2)/(positives*negatives),tiePolicy:'average-rank-half-credit',coverage:'full'};
}

/** Full output evidence; fresh inference is deliberately not inferred from bytes/revisions. */
export async function verifyTable(client,{projectId,workflowId,nodeId,portIndex,session,expectations={},pageSize=1000,maxRows=100000,timeoutMs=60000}={}) {
 if(!projectId||!nodeId||!Number.isInteger(portIndex)||portIndex<0||!Number.isInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isInteger(maxRows)||maxRows<1||maxRows>1000000||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new BridgeError('INVALID_ARGUMENT','Explicit table target and bounded page/row/deadline limits are required.');
 const started=performance.now(),deadline=started+timeoutMs,hash=createHash('sha256'),keys=new Set(),uniques=new Map(),pairs=[],pages=[],failures=[];
 let rowsRead=0,offset=0,total=null,schema=null,identity=null,source=null,revisions=null,complete=false,failureCount=0;
 const fail=message=>{failureCount++;if(failures.length<20&&!failures.includes(message))failures.push(message);};
 const read=async args=>{
  const remaining=Math.floor(deadline-performance.now());if(remaining<25)return null;
  return client.call('core.table.read',{projectId,...(workflowId?{workflowId}:{}),nodeId,portIndex,...args},{session,timeoutMs:remaining});
 };
 while(rowsRead<maxRows) {
  const page=await read({offset:String(offset),limit:Math.min(pageSize,maxRows-rowsRead),...(identity?{expectedTableIdentity:identity}:{})});if(!page)break;
  if(!Array.isArray(page.schema)||!Array.isArray(page.rows)||!/^[0-9]+$/.test(page.totalRows)||!/^[0-9]+$/.test(page.offset)||BigInt(page.offset)!==BigInt(offset)||page.stableReadPolicy!=='native-immutable-buffered-table'||typeof page.tableIdentity!=='string'||!page.tableIdentity)throw new BridgeError('INVALID_RESPONSE','Table page lacks stable immutable identity or contiguous offset/schema.');
  if(page.rows.length>Math.min(pageSize,maxRows-rowsRead))throw new BridgeError('INVALID_RESPONSE','Table page exceeds requested limit.');
  if(identity&&identity!==page.tableIdentity)throw new BridgeError('TABLE_IDENTITY_CHANGED','Table changed during full verification.');
  if(total!==null&&(total!==BigInt(page.totalRows)||!equal(schema,page.schema)||!equal(revisions,page.revisions??null)))throw new BridgeError('TABLE_IDENTITY_CHANGED','Table count/schema/revisions changed during verification.');
  if(!identity){identity=page.tableIdentity;schema=page.schema;total=BigInt(page.totalRows);source=page.source??{projectId,workflowId:workflowId??'root',nodeId,portIndex};revisions=page.revisions??null;hash.update(canonical({schema,totalRows:String(total)}));}
  const columns=new Map(schema.map((c,i)=>[c.name,i]));
  if(columns.size!==schema.length)throw new BridgeError('INVALID_RESPONSE','Table schema has duplicate column names.');
  for(const name of [...(expectations.uniqueColumns??[]),...Object.keys(expectations.constants??{}),...(expectations.metrics?[expectations.metrics.labelColumn,expectations.metrics.scoreColumn]:[])])if(!columns.has(name))throw new BridgeError('INVALID_ARGUMENT','Expected named column is absent: '+name);
  for(const row of page.rows) {
   if(typeof row.key!=='string'||!Array.isArray(row.values)||row.values.length!==schema.length)throw new BridgeError('INVALID_RESPONSE','Malformed table key/value row.');
   if(keys.has(row.key))fail('Duplicate native row key.');keys.add(row.key);
   if(row.values.some(opaque))fail('Opaque/truncated values prevent complete deterministic verification.');
   hash.update('\n'+canonical({key:row.key,values:row.values}));rowsRead++;
   for(const name of expectations.uniqueColumns??[]){if(!uniques.has(name))uniques.set(name,new Set());const key=canonical(row.values[columns.get(name)]);if(uniques.get(name).has(key))fail('Duplicate value in unique column '+name);uniques.get(name).add(key);}
   for(const [name,value] of Object.entries(expectations.constants??{}))if(!equal(row.values[columns.get(name)],value))fail('Constant expectation mismatch in '+name);
   if(expectations.metrics){const m=expectations.metrics,label=row.values[columns.get(m.labelColumn)],score=row.values[columns.get(m.scoreColumn)];if(label===null||opaque(label)||typeof score!=='number'||!Number.isFinite(score)||score<0||score>1)fail('Metric labels cannot be null/opaque and probabilities must be finite numbers in [0,1].');else pairs.push({label,score});}
  }
  const next=offset+page.rows.length;
  if(String(page.nextOffset)!==String(next)||page.hasMore!==Boolean(BigInt(next)<total))throw new BridgeError('INVALID_RESPONSE','Noncontiguous table continuation or premature end.');
  pages.push({offset:String(offset),rows:page.rows.length,operationId:client.lastOperation?.operationId??null});
  if(!page.hasMore){complete=BigInt(rowsRead)===total;break;}
  if(!page.rows.length)throw new BridgeError('INVALID_RESPONSE','Table paging stalled.');offset=next;
  await new Promise(resolve=>setImmediate(resolve));
 }
 let finalRecheck=false;
 if(complete){const final=await read({offset:'0',limit:1,expectedTableIdentity:identity});if(final){if(final.tableIdentity!==identity||final.stableReadPolicy!=='native-immutable-buffered-table'||BigInt(final.totalRows)!==total||!equal(final.schema,schema)||!equal(final.revisions??null,revisions))throw new BridgeError('TABLE_IDENTITY_CHANGED','Final table identity/schema/count/revision recheck failed.');finalRecheck=true;}else complete=false;}
 if(expectations.rowCount!==undefined&&BigInt(expectations.rowCount)!==total)fail('Expected full rowCount differs from native total.');
 let metrics=null;
 if(expectations.metrics&&complete&&pairs.length===rowsRead)try{
  const m=expectations.metrics;metrics=metricResult(pairs,m.positiveLabel,m.threshold??.5);
  for(const [key,expected] of [['accuracy',m.expectedAccuracy],['rocAuc',m.expectedRocAuc]])if(expected!==undefined&&Math.abs(metrics[key]-expected)>(m.tolerance??1e-12))fail('Expected '+key+' mismatch for named positive-class semantics.');
 }catch(error){fail(error.message);}
 else if(expectations.metrics&&complete)fail('Metrics do not cover every row.');
 return {status:!complete?'incomplete':failureCount?'failed':'passed',coverage:complete?'full':'incomplete',source,sessionId:session??client.session??null,
  tableIdentity:identity,revisions,totalRows:total===null?null:String(total),rowsRead,pagesRead:pages.length,pages,finalRecheck,
  keyedValuesSha256:hash.digest('hex'),failureCount,failures,failuresTruncated:failureCount>failures.length,metrics,
  freshInference:'unverified',cachedVersusFresh:'not_inferred_from_table',elapsedMs:performance.now()-started,
  clocks:{owner:'table_verification',budgetMs:timeoutMs,hostMcpLimit:'not_observable',nativeExecutionDeadline:'not_changed'},
  limitations:['Full immutable output coverage is separate from producer execution lineage, visual review, persistence and external file freshness.']};
}
