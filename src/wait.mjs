import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError} from './client.mjs';

/** Observe a specific postcondition. Never reissues the command or follows a new session. */
export async function waitForCondition(client,{session,condition,projectId,workflowId,nodeId,origin,timeoutMs=30000,pollMs=250}) {
 if(!session||!['execution','saved','opened','closed'].includes(condition))throw new BridgeError('INVALID_ARGUMENT','Explicit session and supported condition are required.');
 if(condition==='opened'&&(!origin||!['providerId','spaceId','itemId'].every(k=>typeof origin[k]==='string'&&origin[k])))throw new BridgeError('INVALID_ARGUMENT','opened requires an exact origin.');
 if(condition!=='opened'&&(typeof projectId!=='string'||!projectId))throw new BridgeError('INVALID_ARGUMENT','projectId is required.');
 if((nodeId||workflowId)&&condition!=='execution')throw new BridgeError('INVALID_ARGUMENT','nodeId/workflowId apply only to execution.');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(pollMs)||pollMs<1||pollMs>5000)throw new BridgeError('INVALID_ARGUMENT','Invalid wait bounds.');
 const started=performance.now(),deadline=started+timeoutMs;let observation=null,attempts=0;
 const result=(status,extra={})=>({status,completed:status==='settled',condition,sessionId:session,attempts,elapsedMs:Math.round(performance.now()-started),observation,...(condition==='saved'?{persistenceVerified:false}:{}),...extra});
 const read=async(operation,args={})=>{const remaining=Math.floor(deadline-performance.now());if(remaining<1)return null;return client.call(operation,args,{session,timeoutMs:remaining});};
 while(performance.now()<deadline) {
  attempts++;
  try {
   const ui=await read('desktop.uiState');if(!ui)break;
   if(ui.blocked||ui.responsive===false)return result('blocked',{uiState:ui});
   if(condition==='opened'||condition==='closed') {
    const state=await read('gateway.call',{method:'ApplicationService.getState',params:{}});if(!state)break;
    if(!Array.isArray(state.openProjects))throw new BridgeError('INVALID_RESPONSE','Application state lacks openProjects.');
    observation=condition==='opened'?state.openProjects.find(p=>p.origin?.providerId===origin.providerId&&p.origin?.spaceId===origin.spaceId&&p.origin?.itemId===origin.itemId)??null:state.openProjects.find(p=>p.projectId===projectId)??null;
    if(condition==='opened'?observation!==null:observation===null)return result('settled');
   } else {
    observation=await read('core.snapshot',{projectId,...(workflowId?{workflowId}:{}),...(nodeId?{nodeId}:{})});if(!observation)break;
    if(condition==='saved'&&observation.dirty===false)return result('settled',{note:'Clean live state observed. Reopen/export verification is still required.'});
    if(condition==='execution') {
     if(observation.state==='EXECUTED')return result('settled');
     if(observation.message?.type==='ERROR')return result('failed');
    }
   }
  }catch(error){if(['REQUEST_TIMEOUT','REQUEST_EXPIRED'].includes(error.code))return result('timeout',{lastError:{code:error.code,message:error.message},outcome:'unknown'});throw error;}
  const remaining=deadline-performance.now();if(remaining>0)await delay(Math.min(pollMs,remaining));
 }
 return result('timeout',{outcome:'unknown',note:'Observation timed out. No command was retried or cancelled.'});
}
