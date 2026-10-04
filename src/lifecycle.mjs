import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rename} from 'node:fs/promises';
const execute=promisify(execFile);

export async function processIdentities() {
 const pids=[process.pid,process.ppid];
 try {
  if(process.platform==='win32') {
   const script=`$ErrorActionPreference='Stop'; @(${pids.join(',')}) | ForEach-Object { $p=Get-Process -Id $_; [pscustomobject]@{pid=$p.Id;creationIdentity=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();creationIdentitySource='windows_process_start_filetime'} } | ConvertTo-Json -Compress`;
   const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:3000,maxBuffer:4096});return JSON.parse(stdout);
  }
  return await Promise.all(pids.map(async pid=>{const raw=await readFile(`/proc/${pid}/stat`,'utf8');return {pid,creationIdentity:raw.slice(raw.lastIndexOf(')')+2).split(' ')[19],creationIdentitySource:'linux_proc_start_ticks'};}));
 }catch(error){return pids.map(pid=>({pid,creationIdentity:null,creationIdentitySource:'unknown',reason:error.code??'IDENTITY_UNAVAILABLE'}));}
}

export async function createLifecycle(client,{file,serverSource}={}) {
 const identities=await processIdentities();
 const value={schemaVersion:1,instanceId:randomUUID(),self:identities.find(p=>p.pid===process.pid),parent:identities.find(p=>p.pid===process.ppid),connectionStartedAt:new Date().toISOString(),connectionEndedAt:null,endReason:null,source:client.sourceIdentity,serverSource:serverSource??null,runtime:client.runtime,sessionId:client.session??null,profile:client.profile?.name??null,nativeExpected:client.profile?.expected??null,state:'connected',activity:{requests:0,completed:0,failed:0},resources:{start:process.memoryUsage()},pendingAtDisconnect:[]};
 const snapshot=()=>({...value,activity:{...value.activity},pendingCount:client.pendingOperations.size});
 const persist=async()=>{if(!file)return;const temporary=file+'.tmp-'+value.instanceId;await writeFile(temporary,JSON.stringify(snapshot(),null,2),{mode:0o600});await rename(temporary,file);};
 await persist();
 return {snapshot,begin(){value.activity.requests++;},complete(failed=false){value.activity.completed++;if(failed)value.activity.failed++;},async disconnect(reason){if(value.connectionEndedAt)return;value.connectionEndedAt=new Date().toISOString();value.endReason=reason;value.state='disconnected';value.pendingAtDisconnect=Array.from(client.pendingOperations.values()).slice(0,64);value.pendingTruncated=client.pendingOperations.size>64;value.resources.end=process.memoryUsage();await persist();}};
}
