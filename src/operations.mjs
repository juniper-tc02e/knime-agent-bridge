import fs from 'node:fs/promises';
import path from 'node:path';
import {BridgeError} from './client.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export async function readOperation(client,{sessionId,operationId}) {
  if(!SESSION.test(sessionId)||!UUID.test(operationId))throw new BridgeError('INVALID_ARGUMENT','A session ID and UUID operation ID are required.');
  const directory=path.join(client.runtime,'sessions',sessionId,'operations');
  const file=path.join(directory,operationId+'.json');
  let receipt;
  try {
    const [base,real]=await Promise.all([fs.realpath(directory),fs.realpath(file)]);
    if(path.dirname(real)!==base)throw new BridgeError('INVALID_ARTIFACT','Receipt resolves outside its journal.');
    if((await fs.stat(real)).size>16*1024*1024)throw new BridgeError('INVALID_ARTIFACT','Receipt exceeds size limit.');
    receipt=JSON.parse(await fs.readFile(real,'utf8'));
  } catch(error) {if(error.code==='ENOENT')throw new BridgeError('OPERATION_NOT_FOUND','No durable acceptance record was found; this is not proof that an unrecorded legacy request did not run.',{sessionId,operationId});throw error;}
  if(receipt.operationId!==operationId||receipt.sessionId!==sessionId)throw new BridgeError('INVALID_ARTIFACT','Receipt identity does not match journal lookup.');
  const {response,...publicReceipt}=receipt;
  if(['queued','running'].includes(receipt.status)) {
    const live=(await client.listSessions()).find(s=>s.id===sessionId&&s.alive);
    if(!live) publicReceipt.status='unknown_after_restart';
  }
  return publicReceipt;
}
