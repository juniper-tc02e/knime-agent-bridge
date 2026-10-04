import {BridgeError} from './client.mjs';
import {storeDetail} from './details.mjs';
export const IMAGES=Symbol.for('knime.agent.images');
const EMIT=Symbol.for('knime.agent.image-emission');
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
export function withImages(metadata,images,onEmit) {
  const result={...metadata};
  Object.defineProperty(result,IMAGES,{value:images});
  if(onEmit)Object.defineProperty(result,EMIT,{value:onEmit});
  return result;
}
export function structuredResult(value,isError=false) {
  const structuredContent=value!==null&&typeof value==='object'&&!Array.isArray(value)?{...value}:{result:value};
  // Structured content carries the complete payload once. Human-readable text
  // is a bounded summary, avoiding repeated stale-session/settings/table JSON.
  const summary=isError?{error:{code:value?.error?.code??'UNKNOWN',message:String(value?.error?.message??'Operation failed.').slice(0,600)},
    ...(value?.error?.details?.operationId?{operationId:value.error.details.operationId}:{}),
    ...(value?.error?.details?.reconciliation?{nextStep:'Reconcile the original UUID with knime_operation; do not resubmit.'}:{}),detail:'See structuredContent.'}
   :Object.fromEntries(['status','state','completed','sessionId','operationId','evidenceId','tableIdentity','totalRows','rowCount','detailAvailable','detail','nextCall'].filter(k=>Object.hasOwn(structuredContent,k)).map(k=>[k,structuredContent[k]]));
  if(!isError)summary.detailSource='structuredContent';
  let summaryText=JSON.stringify(summary);
  if(Buffer.byteLength(summaryText)>2000)summaryText=JSON.stringify({status:structuredContent.status??structuredContent.state??'returned',detailSource:'structuredContent'});
  const content=[{type:'text',text:summaryText}];
  let total=Buffer.byteLength(content[0].text);
  for(const image of value?.[IMAGES]??[]) {
    const data=image.data;
    if(!Buffer.isBuffer(data)||data.length>4*1024*1024) throw new BridgeError('IMAGE_BUDGET','PNG image exceeds the 4 MiB size budget. Request a smaller crop.');
    if(image.mimeType!=='image/png'||data.length<33||!data.subarray(0,8).equals(PNG)||data.toString('ascii',12,16)!=='IHDR') throw new BridgeError('INVALID_IMAGE','Capture must contain a valid PNG header.');
    const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
    if(!width||!height||width*height>16000000)throw new BridgeError('IMAGE_BUDGET','PNG decoded size exceeds 16 megapixels.');
    const encoded=data.toString('base64'); total+=encoded.length+80;
    if(total>6*1024*1024)throw new BridgeError('IMAGE_BUDGET','Image response exceeds the 6 MiB transport budget. Request fewer tiles.');
    content.push({type:'image',mimeType:'image/png',data:encoded});
  }
  if(content.length>1)value?.[EMIT]?.();
  return {content,structuredContent,...(isError?{isError:true}:{})};
}

export async function prepareResult(client,value,{isError=false,resultMode='compact'}={}) {
 if(!['compact','full'].includes(resultMode))throw new BridgeError('INVALID_ARGUMENT','resultMode must be compact or full.');
 const text=JSON.stringify(value);
 if(resultMode==='full'||Buffer.byteLength(text??'null')<=128*1024)return structuredResult(value,isError);
 let detail;
 try{detail=await storeDetail(client,value);}
 catch(error){
  // Formatting failure never overwrites a native primary error or invents a
  // durable result. Preserve original outcome/identity and disclose detail loss.
  const summary=isError?{error:{code:value?.error?.code??'UNKNOWN',message:String(value?.error?.message??'Failed').slice(0,600),details:value?.error?.details?.operationId?{operationId:value.error.details.operationId,sessionId:value.error.details.sessionId,runtime:value.error.details.runtime,outcome:value.error.details.outcome,reconciliation:value.error.details.reconciliation}:{} }}:{};
  for(const key of ['status','state','operationId','sessionId','_operation','_clientOperation'])if(value?.[key]!==undefined)summary[key]=value[key];
  return structuredResult({...summary,detailAvailable:false,detailFailure:{code:error.code??'IO_ERROR',message:String(error.message).slice(0,300)},verification:'Full detail could not be preserved; inspect the original operation receipt.'},isError);
 }
 const summary={detailAvailable:true,detail,payloadBytes:Buffer.byteLength(text),resultMode:'compact'};
 if(isError)summary.error={code:value?.error?.code??'UNKNOWN',message:String(value?.error?.message??'Failed').slice(0,600),details:{detail,operationId:value?.error?.details?.operationId,sessionId:value?.error?.details?.sessionId,outcome:value?.error?.details?.outcome,reconciliation:value?.error?.details?.reconciliation}};
 for(const key of ['status','state','completed','operationId','sessionId','contextId','evidenceId','_operation','_clientOperation'])if(value?.[key]!==undefined)summary[key]=value[key];
 return structuredResult(value?.[IMAGES]?withImages(summary,value[IMAGES],value[EMIT]):summary,isError);
}
