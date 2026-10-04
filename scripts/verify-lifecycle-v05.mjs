#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('..',import.meta.url)),output=path.resolve(process.argv[2]??path.join(project,'runtime','evidence','lifecycle-v05-'+Date.now()));
const iterations=Number(process.argv[3]??100);
if(!Number.isInteger(iterations)||iterations<1||iterations>100)throw new Error('Iterations must be an integer between 1 and 100.');
await mkdir(output,{recursive:true});
const runtime=await mkdtemp(path.join(os.tmpdir(),'knime-lifecycle100-'));
const rows=[];
const active=new Map();
async function bounded(promise,ms,stage){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Lifecycle fixture deadline expired at ${stage}.`)),Math.max(1,ms));})]);}finally{clearTimeout(timer);}}
async function connect(index) {
 const file=path.join(output,`instance-${index}.json`),start=performance.now();
 const child=spawn(process.execPath,[path.join(project,'src/server.mjs'),'--runtime',runtime,'--lifecycle-file',file],{stdio:['pipe','pipe','pipe']});
 let stderr='',buffer='';child.stderr.on('data',c=>stderr+=c);
 const done=new Promise(resolve=>child.once('exit',(code,signal)=>{active.delete(index);resolve({code,signal});}));
 const handle={index,child,done,file,stderr:()=>stderr};active.set(index,handle);
 const initialized=new Promise((resolve,reject)=>{child.stdout.on('data',c=>{buffer+=c;let n;while((n=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const message=JSON.parse(raw);if(message.id===1){if(message.error)reject(new Error('Initialize returned an RPC error.'));else resolve(message);}}catch(error){reject(error);}}});child.once('exit',()=>reject(new Error('Server exited before initialize: '+stderr)));child.once('error',reject);});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'lifecycle-fixture-'+index,version:'1'}}})+'\n');
 await bounded(initialized,10000,'initialize');
 const receipt=JSON.parse(await readFile(file,'utf8'));
 if(!receipt.self.creationIdentity||!receipt.parent.creationIdentity)throw new Error('OS creation identity is unavailable.');
 handle.connectMs=performance.now()-start;handle.receipt=receipt;return handle;
}
async function disconnect(c) {
 const start=performance.now();c.child.stdin.end();const exit=await bounded(c.done,5000,'stdio_eof');
 const receipt=JSON.parse(await readFile(c.file,'utf8'));
 if(exit.code!==0||receipt.endReason!=='stdio_eof'){
  const failure={iteration:c.index,exit,stderr:c.stderr(),receipt,completedSamples:rows};
  await writeFile(path.join(output,`failure-${c.index}.json`),JSON.stringify(failure,null,2));
  throw new Error(`Lifecycle fixture exit failed at ${c.index}: code=${exit.code}, signal=${exit.signal}, state=${receipt.state}, stderr=${c.stderr()}`);
 }
 const row={iteration:c.index,instanceId:receipt.instanceId,pid:receipt.self.pid,creationIdentity:receipt.self.creationIdentity,parentPid:receipt.parent.pid,parentCreationIdentity:receipt.parent.creationIdentity,sourceVersion:receipt.source?.version??'unknown',sourceSha256:receipt.source?.sha256??'unknown',serverSha256:receipt.serverSource?.sha256??'unknown',connectMs:c.connectMs,eofMs:performance.now()-start,rssStart:receipt.resources.start.rss,rssEnd:receipt.resources.end.rss,exitCode:exit.code,pendingCount:receipt.pendingAtDisconnect.length,ownedAliveAfterExit:0};rows.push(row);return row;
}
// Intentional concurrent clients survive every other client's EOF.
try {
const parallel=await Promise.all([connect('parallel-a'),connect('parallel-b'),connect('parallel-c')]);
if(new Set(parallel.map(c=>c.receipt.instanceId)).size!==3)throw new Error('Concurrent instances mixed identity.');
await disconnect(parallel[0]);
if(parallel[1].child.exitCode!==null||parallel[2].child.exitCode!==null)throw new Error('EOF affected another client.');
await disconnect(parallel[1]);await disconnect(parallel[2]);
for(let i=1;i<=iterations;i++){await disconnect(await connect(i));if(i%10===0)process.stdout.write(JSON.stringify({completed:i,ownedActiveChildren:0})+'\n');}
const sequential=rows.filter(r=>Number.isInteger(r.iteration));
const sourceIdentities=[...new Set(rows.map(r=>JSON.stringify({version:r.sourceVersion,clientSha256:r.sourceSha256,serverSha256:r.serverSha256})))].map(s=>JSON.parse(s));
if(sourceIdentities.length!==1||sourceIdentities[0].version!=='0.5.0'||sourceIdentities[0].clientSha256==='unknown'||sourceIdentities[0].serverSha256==='unknown')throw new Error('Lifecycle qualification requires one uniform v0.5.0 client/server source identity.');
function summary(field){const values=sequential.map(r=>r[field]).sort((a,b)=>a-b);return {sampleCount:values.length,p50:values[Math.ceil(values.length*.5)-1],p95:values[Math.ceil(values.length*.95)-1],max:values.at(-1)};}
const mean=sequential.reduce((s,r)=>s+r.rssEnd,0)/iterations,center=(iterations-1)/2;
const rssSlope=iterations>1?sequential.reduce((s,r,i)=>s+(i-center)*(r.rssEnd-mean),0)/sequential.reduce((s,r,i)=>s+(i-center)**2,0):null;
const report={schemaVersion:1,fixture:`${iterations} sequential stdio connections plus 3 parallel clients; no native process`,source:sourceIdentities[0],deadlines:{owner:'lifecycle_fixture',initializeMs:10000,eofMs:5000,failedOnlyCleanupMs:5000},node:process.version,platform:process.platform,arch:process.arch,completedAt:new Date().toISOString(),observedChildProcesses:iterations+3,ownedChildrenRemaining:active.size,connectMs:summary('connectMs'),eofMs:summary('eofMs'),rssStartBytes:summary('rssStart'),rssEndBytes:summary('rssEnd'),rssEndSlopeBytesPerIteration:rssSlope,hostRendering:'unmeasured',limits:'Fresh server processes; RSS is process-local and not additive physical RAM. No native soak or real host lag causal intervention.'};
await writeFile(path.join(output,'summary.json'),JSON.stringify(report,null,2));
const fields=Object.keys(rows[0]);await writeFile(path.join(output,'samples.csv'),fields.join(',')+'\n'+rows.map(r=>fields.map(k=>r[k]).join(',')).join('\n')+'\n');
await rm(runtime,{recursive:true,force:true});
process.stdout.write(JSON.stringify({output,summary:report})+'\n');
}catch(error){
 const firstFailure=performance.now(),firstFailureAt=new Date().toISOString(),cleanupDeadline=firstFailure+5000,owned=[...active.values()];
 // Only close transports created by this harness. The first cleanup deadline
 // is immutable; subsequent disposal failures never grant another grace.
 for(const handle of owned)handle.child.stdin?.end();
 const secondary=await Promise.all(owned.map(handle=>bounded(handle.done,cleanupDeadline-performance.now(),'failed_only_cleanup').then(()=>null,error=>({iteration:handle.index,message:error.message}))));
 const failure={status:'failed',primary:{message:error.message,observedAt:firstFailureAt,clock:'process_monotonic',firstFailureMs:firstFailure},cleanup:{owner:'lifecycle_fixture',deadlineMs:cleanupDeadline,remainingMs:Math.max(0,cleanupDeadline-performance.now()),ownedChildrenRemaining:active.size},secondary:secondary.filter(Boolean),ownedAtFailure:owned.map(h=>({iteration:h.index,pid:h.child.pid,receipt:h.receipt??null,stderr:h.stderr()})),completedSamples:rows};
 try{await writeFile(path.join(output,'failure-run.json'),JSON.stringify(failure,null,2));}catch(secondary){process.stderr.write(JSON.stringify({primary:error.message,secondary:secondary.message})+'\n');}
 for(const handle of active.values()){handle.child.stdin?.destroy();handle.child.stdout?.destroy();handle.child.stderr?.destroy();handle.child.unref();}
 throw error;
}
