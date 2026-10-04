import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {BridgeError} from './client.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES=32*1024*1024;
const hash=text=>createHash('sha256').update(text).digest('hex');
async function directory(client,{create=false}={}) {
 const root=await client.resolveRuntime(),expected=path.join(root,'details');
 if(create)await fs.mkdir(expected,{recursive:true});
 const actual=await fs.realpath(expected);
 if(path.relative(expected,actual)!=='')throw new BridgeError('INVALID_ARTIFACT','Detail directory resolves outside its exact runtime location.');
 return actual;
}
export async function storeDetail(client,payload) {
 const text=JSON.stringify(payload),bytes=Buffer.byteLength(text);
 if(bytes>MAX_BYTES)throw new BridgeError('DETAIL_BUDGET','Full detail exceeds the 32 MiB storage bound. Request smaller native pages.');
 const dir=await directory(client,{create:true}),id=randomUUID(),sha256=hash(text),createdAt=new Date().toISOString();
 const body={schemaVersion:1,id,createdAt,sha256,bytes,payload},file=path.join(dir,id+'.json'),temporary=file+'.tmp';
 let handle,ownedTemporary=false;
 try{
  handle=await fs.open(temporary,'wx',0o600);ownedTemporary=true;await handle.writeFile(JSON.stringify(body),'utf8');await handle.sync();await handle.close();handle=undefined;
  await directory(client);await fs.rename(temporary,file);
  const stored=JSON.parse(await fs.readFile(file,'utf8'));
  if(stored.id!==id||hash(JSON.stringify(stored.payload))!==sha256)throw new BridgeError('INVALID_ARTIFACT','Detail integrity verification failed after publication.');
 }finally{if(handle)await handle.close().catch(()=>{});if(ownedTemporary)await fs.unlink(temporary).catch(()=>{});}
 return {id,sha256,bytes,createdAt,durability:'file-flushed-closed-and-hash-verified',directoryDurability:'not_fsynced',
  nextCall:{tool:'knime_detail',arguments:{id,offset:0,limit:16000}},readOnly:true};
}
export async function readDetail(client,{id,offset=0,limit=16000}={}) {
 if(typeof id!=='string'||!UUID.test(id))throw new BridgeError('INVALID_ARGUMENT','Detail identifier must be a UUID returned by this bridge.');
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>16000)throw new BridgeError('INVALID_ARGUMENT','Detail character offset must be nonnegative and limit 1..16000.');
 const dir=await directory(client),expected=path.join(dir,id+'.json'),file=await fs.realpath(expected);
 if(path.relative(expected,file)!=='')throw new BridgeError('INVALID_ARTIFACT','Detail file resolves outside its exact location.');
 const before=await fs.stat(file,{bigint:true});if(before.size>BigInt(MAX_BYTES+4096))throw new BridgeError('DETAIL_BUDGET','Stored detail exceeds the byte bound.');
 const body=JSON.parse(await fs.readFile(file,'utf8')),text=JSON.stringify(body.payload);
 const after=await fs.stat(file,{bigint:true});
 if(before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||before.size!==after.size||body.schemaVersion!==1||body.id!==id||body.bytes!==Buffer.byteLength(text)||body.sha256!==hash(text))throw new BridgeError('INVALID_ARTIFACT','Detail integrity/hash changed during retrieval.');
 if(offset>text.length)throw new BridgeError('INVALID_ARGUMENT','Detail offset exceeds full character length.');
 // Offsets count UTF-16 code units, so concatenating chunks reconstructs exact JSON,
 // including a surrogate pair split at a boundary. Full UTF-8 SHA-256 checks that result.
 const nextOffset=Math.min(text.length,offset+limit);
 return {id,sha256:body.sha256,bytes:body.bytes,totalCharacters:text.length,offset,nextOffset,hasMore:nextOffset<text.length,
  offsetEncoding:'UTF-16-code-units',text:text.slice(offset,nextOffset),completePayloadReturned:offset===0&&nextOffset===text.length};
}
