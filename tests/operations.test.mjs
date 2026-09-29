import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {BridgeClient} from '../src/client.mjs';
import {readOperation} from '../src/operations.mjs';
test('stopped-session receipts are recoverable without selecting a new process',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-journal-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const dir=path.join(runtime,'sessions','old','operations');await fs.mkdir(dir,{recursive:true});
 const operationId=randomUUID(),base={operationId,sessionId:'old',status:'running',response:{result:'private replay payload'}};
 await fs.writeFile(path.join(dir,operationId+'.json'),JSON.stringify(base));
 const client=new BridgeClient({runtime});
 const r=await readOperation(client,{sessionId:'old',operationId});
 assert.equal(r.status,'unknown_after_restart');assert.equal(r.response,undefined);
 await fs.writeFile(path.join(dir,operationId+'.json'),JSON.stringify({...base,status:'applied'}));
 assert.equal((await readOperation(client,{sessionId:'old',operationId})).status,'applied');
 await assert.rejects(readOperation(client,{sessionId:'../outside',operationId}),{code:'INVALID_ARGUMENT'});
 await assert.rejects(readOperation(client,{sessionId:'old',operationId:randomUUID()}),{code:'OPERATION_NOT_FOUND'});
});

test('latest durable event survives a missing or stale aggregate without replay',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-journal-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const operationId=randomUUID(),dir=path.join(runtime,'sessions','old','operations'),events=path.join(dir,operationId+'.events');await fs.mkdir(events,{recursive:true});
 const latest={operationId,sessionId:'old',status:'applied',nativeDispatch:'returned',sequence:2};
 await fs.writeFile(path.join(events,'0002.json'),JSON.stringify(latest));
 const client=new BridgeClient({runtime});assert.equal((await readOperation(client,{sessionId:'old',operationId})).status,'applied');
 await fs.writeFile(path.join(dir,operationId+'.json'),JSON.stringify({...latest,sequence:1,status:'queued'}));
 assert.equal((await readOperation(client,{sessionId:'old',operationId})).nativeDispatch,'returned');
});

test('a Windows exclusive aggregate lock does not hide a validated durable event',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'knime-journal-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const operationId=randomUUID(),dir=path.join(runtime,'sessions','old','operations'),events=path.join(dir,operationId+'.events');await fs.mkdir(events,{recursive:true});
 const aggregate=path.join(dir,operationId+'.json'),latest={operationId,sessionId:'old',status:'applied',sequence:2};
 await fs.writeFile(aggregate,JSON.stringify({...latest,sequence:1,status:'queued'}));
 await fs.writeFile(path.join(events,'0002.json'),JSON.stringify(latest));
 const locker=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$f=[System.IO.File]::Open('${aggregate.replaceAll("'","''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $f.Dispose()`],{windowsHide:true});
 const exited=once(locker,'exit');
 try {
  assert.match(String((await once(locker.stdout,'data'))[0]),/LOCKED/);
  const client=new BridgeClient({runtime});
  assert.equal((await readOperation(client,{sessionId:'old',operationId})).status,'applied');
  await fs.writeFile(path.join(events,'0002.json'),JSON.stringify({...latest,operationId:randomUUID()}));
  await assert.rejects(readOperation(client,{sessionId:'old',operationId}),{code:'INVALID_ARTIFACT'});
  await fs.unlink(path.join(events,'0002.json'));
  await assert.rejects(readOperation(client,{sessionId:'old',operationId}),e=>['EBUSY','EACCES','EPERM'].includes(e.code));
 }finally{locker.stdin.end('\n');await exited;}
});
