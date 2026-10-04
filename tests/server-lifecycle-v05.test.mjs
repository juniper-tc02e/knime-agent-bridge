import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const server=path.resolve('src/server.mjs');
async function fixture(t){const runtime=await mkdtemp(path.join(os.tmpdir(),'knime-v05-lifecycle-'));const dir=path.join(runtime,'sessions','synthetic');await mkdir(path.join(dir,'requests'),{recursive:true});await mkdir(path.join(dir,'responses'));await writeFile(path.join(dir,'session.json'),JSON.stringify({id:'synthetic',pid:process.pid,startedAt:new Date().toISOString(),heartbeat:new Date().toISOString(),status:'ready',bridgeVersion:'0.5.0'}));t.after(()=>rm(runtime,{recursive:true,force:true}));return {runtime,dir};}
async function waitUntil(predicate,ms=5000){const end=performance.now()+ms;while(performance.now()<end){if(await predicate())return;await delay(10);}throw new Error('Fixture condition timed out.');}
function child(runtime,extra=[]){const p=spawn(process.execPath,[server,'--runtime',runtime,'--session','synthetic','--timeout-ms','1000',...extra],{stdio:['pipe','pipe','pipe']});p.stdout.resume();p.stderr.resume();p.done=new Promise(resolve=>p.once('exit',code=>resolve(code)));return p;}
test('definitive stdio EOF abandons only local observation and leaves original request intact',async t=>{
 const f=await fixture(t),p=child(f.runtime);t.after(async()=>{p.stdin.end();await p.done;});
 p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'knime_health',arguments:{}}})+'\n');
 await waitUntil(async()=>(await readdir(path.join(f.dir,'requests'))).filter(n=>n.endsWith('.json')).length===1);
 const start=performance.now();p.stdin.end();await p.done;assert.ok(performance.now()-start<350,'EOF must not wait for original IPC timeout');assert.equal((await readdir(path.join(f.dir,'requests'))).length,1);
});
test('lifecycle receipt identifies self and parent creation and records EOF unknown original UUID',async t=>{
 const f=await fixture(t),receipt=path.join(f.runtime,'life.json'),p=child(f.runtime,['--lifecycle-file',receipt]);t.after(async()=>{p.stdin.end();await p.done;});
 p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'knime_health',arguments:{}}})+'\n');await waitUntil(async()=>(await readdir(path.join(f.dir,'requests'))).filter(n=>n.endsWith('.json')).length===1);
 const original=JSON.parse(await readFile(path.join(f.dir,'requests',(await readdir(path.join(f.dir,'requests'))).find(n=>n.endsWith('.json'))),'utf8'));p.stdin.end();await p.done;
 const r=JSON.parse(await readFile(receipt,'utf8'));assert.equal(r.self.pid,p.pid);assert.equal(r.parent.pid,process.pid);assert.ok(r.self.creationIdentity);assert.ok(r.parent.creationIdentity);assert.equal(r.endReason,'stdio_eof');assert.equal(r.pendingAtDisconnect[0].operationId,original.id);assert.equal(r.pendingAtDisconnect[0].outcome,'submitted_outcome_unknown');
});

for(const mode of ['staging','publication'])test(`EOF during ${mode} stops observation before delayed lifecycle IO`,async t=>{
 const f=await fixture(t),receipt=path.join(f.runtime,'delayed-life.json');
 const p=spawn(process.execPath,[path.resolve('tests/fixtures/lifecycle-delayed-io.mjs'),f.runtime,receipt,mode],{stdio:['pipe','pipe','pipe']});
 let stderr='';p.stdout.resume();p.stderr.on('data',c=>stderr+=c);const done=new Promise(resolve=>p.once('exit',code=>resolve(code)));
 t.after(async()=>{p.stdin.end();await done;});
 p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'knime_health',arguments:{}}})+'\n');
 await waitUntil(()=>stderr.includes(mode==='staging'?'staging-await':'publication-in-progress'));
 p.stdin.end();assert.equal(await done,0,stderr);
 const published=(await readdir(path.join(f.dir,'requests'))).filter(n=>n.endsWith('.json'));
 const r=JSON.parse(await readFile(receipt,'utf8'));assert.equal(r.endReason,'stdio_eof');
 if(mode==='staging'){
  assert.deepEqual(published,[],'EOF must prevent publication while lifecycle persistence is still awaiting IO');assert.deepEqual(r.pendingAtDisconnect,[]);
 }else{
  assert.equal(published.length,1);const original=JSON.parse(await readFile(path.join(f.dir,'requests',published[0]),'utf8'));
  assert.equal(r.pendingAtDisconnect[0].operationId,original.id);assert.equal(r.pendingAtDisconnect[0].submission.state,'publication_in_progress');assert.equal(r.pendingAtDisconnect[0].outcome,'submitted_outcome_unknown');
 }
});
