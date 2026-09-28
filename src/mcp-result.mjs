import {BridgeError} from './client.mjs';
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
  const content=[{type:'text',text:JSON.stringify(structuredContent)}];
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
