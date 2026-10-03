import fs from 'node:fs/promises';
import path from 'node:path';
import {BridgeError,reconciliationDetails,sessionIdentity} from './client.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export async function readOperation(client,{sessionId,operationId}) {
 if(!SESSION.test(sessionId)||!UUID.test(operationId))throw new BridgeError('INVALID_ARGUMENT','A session ID and UUID operation ID are required.');
 const directory=path.join(client.runtime,'sessions',sessionId,'operations'),file=path.join(directory,operationId+'.json');
 let receipt,base,aggregateFailure;
 const read=async(candidate,parent)=>{
  const real=await fs.realpath(candidate);if(path.dirname(real)!==parent)throw new BridgeError('INVALID_ARTIFACT','Receipt resolves outside its journal.');
  if((await fs.stat(real)).size>1024*1024)throw new BridgeError('INVALID_ARTIFACT','Receipt exceeds size limit.');
  return JSON.parse(await fs.readFile(real,'utf8'));
 };
 try {
  const runtimeRoot=await client.resolveRuntime();
  await client.confinedPath('sessions');
  await client.confinedPath('sessions',sessionId);
  base=await fs.realpath(directory);
  if(path.relative(runtimeRoot,base)!==path.join('sessions',sessionId,'operations'))throw new BridgeError('INVALID_ARTIFACT','Operation journal resolves outside the selected runtime/session.',{runtime:client.runtime,sessionId,operationId});
  try{receipt=await read(file,base);}catch(error){
   if(['EBUSY','EACCES','EPERM'].includes(error.code))aggregateFailure=error;
   else if(error.code!=='ENOENT')throw error;
  }
  const events=path.join(directory,operationId+'.events');
  try {
   const real=await fs.realpath(events);if(path.dirname(real)!==base)throw new BridgeError('INVALID_ARTIFACT','Events resolve outside journal.');
   const names=(await fs.readdir(real)).filter(n=>/^\d{4,8}\.json$/.test(n)).sort((a,b)=>Number(b.slice(0,-5))-Number(a.slice(0,-5)));
   if(names.length>10000)throw new BridgeError('INVALID_ARTIFACT','Too many operation events.');
   for(const name of names){const candidate=await read(path.join(real,name),real);if(!candidate.operationId)continue;
    if(candidate.operationId!==operationId||candidate.sessionId!==sessionId)throw new BridgeError('INVALID_ARTIFACT','Event identity mismatch.');
    if(!receipt||(candidate.sequence??0)>(receipt.sequence??0))receipt=candidate;break;
   }
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }catch(error){if(error.code!=='ENOENT')throw error;}
 if(!receipt&&aggregateFailure)throw aggregateFailure;
 if(!receipt)throw new BridgeError('OPERATION_NOT_FOUND',`No durable acceptance record was found in runtime '${client.runtime}'; this is not proof that an unrecorded legacy request did not run. Inspect native state; do not automatically resubmit.`,{runtime:client.runtime,sessionId,operationId,outcome:'unknown',reconciliation:reconciliationDetails(client.runtime,sessionId,operationId)});
 if(receipt.operationId!==operationId||receipt.sessionId!==sessionId)throw new BridgeError('INVALID_ARTIFACT','Receipt identity does not match journal lookup.');
 const {response,...publicReceipt}=receipt;
 publicReceipt.runtime=client.runtime;
 publicReceipt.reconciliation=reconciliationDetails(client.runtime,sessionId,operationId);
 publicReceipt.outcome=['applied','partially_applied'].includes(receipt.status)?receipt.status:'unknown';
 const expiry=Date.parse(receipt.expiresAt);
 publicReceipt.retention={expiresAt:receipt.expiresAt??null,pinned:receipt.pinned===true,
  expired:receipt.pinned!==true&&Number.isFinite(expiry)&&expiry<Date.now(),cancellationImplied:false};
 if(['queued','running','dispatching'].includes(receipt.status)) {
  const current=(await client.listSessions()).find(s=>s.id===sessionId);
  const pinned=client.pinnedIdentities?.get(sessionId);
  const identityChanged=pinned&&current&&JSON.stringify(pinned)!==JSON.stringify(sessionIdentity(current));
  if(!current?.alive||identityChanged) {
   publicReceipt.recordedStatus=receipt.status;
   publicReceipt.status='unknown_after_restart';
   publicReceipt.uncertainty=identityChanged?'The original session descriptor was replaced by a different process identity.':'The original process is unavailable; native completion has not been verified.';
  }
 }
 return publicReceipt;
}
