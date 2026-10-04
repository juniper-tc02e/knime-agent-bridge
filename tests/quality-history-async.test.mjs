import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import promises from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {QualityStore,canonical,digest} from '../src/quality/store.mjs';

function fixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(tmpdir(),'knime-async-history-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {directory,store:new QualityStore({directory,...options})};
}
function rewrite(directory,id,change,resign=true) {
  const file=path.join(directory,id+'.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));change(record);
  if(resign){const {digest:old,...body}=record;record.digest=digest(body);}
  fs.writeFileSync(file,canonical(record));
}
test('async selected records are fresh after independent writers and valid payload replacement',async t=>{
  const f=fixture(t);f.store.put('observation',{value:'old'},{id:'one'});
  assert.equal((await f.store.listAsync('observation'))[0].value,'old');
  new QualityStore({directory:f.directory}).put('observation',{value:'new'},{id:'two'});
  rewrite(f.directory,'one',r=>r.payload.value='changed');
  assert.deepEqual((await f.store.listAsync('observation')).map(r=>r.value).sort(),['changed','new']);
  assert.equal((await f.store.getAsync('one')).value,'changed');
});
test('async selected removal and tampering never return a previous success',async t=>{
  const f=fixture(t);f.store.put('observation',{success:true},{id:'one'});await f.store.listAsync('observation');
  rewrite(f.directory,'one',r=>r.payload.success=false,false);
  await assert.rejects(f.store.getAsync('one'),/integrity|digest/i);
  await assert.rejects(f.store.listAsync('observation'),/integrity|digest/i);
  fs.unlinkSync(path.join(f.directory,'one.json'));
  await assert.rejects(f.store.getAsync('one'),/unknown|missing/i);
  await assert.rejects(f.store.listAsync('observation'),/unknown|missing/i);
});
test('async unrelated classification changes and tampering fail before filtering',async t=>{
  const f=fixture(t);f.store.put('other',{}, {id:'one'});await f.store.listAsync('observation');
  rewrite(f.directory,'one',r=>r.kind='observation');
  await assert.rejects(f.store.listAsync('observation'),/kind|immutable/i);
});
test('bounded history pages omit payloads and detail is freshly verified',async t=>{
  const f=fixture(t);for(let i=0;i<5;i++)f.store.put('observation',{large:'x'.repeat(10000)},{id:'record-'+i});
  const first=await f.store.historyPage({kind:'observation',limit:2});
  assert.equal(first.totalCount,5);assert.equal(first.returnedCount,2);assert.equal(first.truncated,true);
  assert.equal(first.items[0].payload,undefined);assert.equal(first.items[0].large,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<4000);
  const second=await f.store.historyPage({kind:'observation',limit:2,cursor:first.nextCursor});
  assert.equal(second.items.length,2);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,4);
  assert.equal((await f.store.getAsync(first.items[0].id)).large.length,10000);
});
for(const change of ['add','replace','delete'])test(`cursor explicitly invalidates after independent ${change}`,async t=>{
  const f=fixture(t);for(let i=0;i<3;i++)f.store.put('observation',{value:i},{id:'record-'+i});
  const first=await f.store.historyPage({kind:'observation',limit:1});
  if(change==='add')new QualityStore({directory:f.directory}).put('other',{}, {id:'new-writer'});
  if(change==='replace')rewrite(f.directory,'record-1',r=>r.payload.value=42);
  if(change==='delete')fs.unlinkSync(path.join(f.directory,'record-1.json'));
  await assert.rejects(f.store.historyPage({kind:'observation',limit:1,cursor:first.nextCursor}),e=>e.code==='STALE_HISTORY_CURSOR');
});
test('delta has explicit base digest and reports changed/new/removed references with missing-base fallback',async t=>{
  const f=fixture(t);f.store.put('observation',{value:1},{id:'one'});f.store.put('observation',{}, {id:'remove'});
  const base=await f.store.historyPage({kind:'observation'});
  rewrite(f.directory,'one',r=>r.payload.value=2);fs.unlinkSync(path.join(f.directory,'remove.json'));
  new QualityStore({directory:f.directory}).put('observation',{}, {id:'new'});
  const delta=await f.store.historyPage({kind:'observation',baseDigest:base.snapshotDigest});
  assert.equal(delta.mode,'delta');assert.deepEqual(delta.items.map(r=>[r.id,r.change]).sort(),[['new','added'],['one','changed'],['remove','removed']]);
  const missing=await new QualityStore({directory:f.directory}).historyPage({kind:'observation',baseDigest:base.snapshotDigest,limit:1});
  assert.equal(missing.mode,'full');assert.equal(missing.baseUnavailable,true);assert.equal(missing.returnedCount,1);assert.equal(missing.truncated,true);
});
test('expired and foreign cursors fail explicitly without disk writes',async t=>{
  const f=fixture(t,{historyOptions:{cursorTtlMs:1}});for(let i=0;i<3;i++)f.store.put('observation',{}, {id:'r-'+i});
  const before=fs.readdirSync(f.directory),first=await f.store.historyPage({limit:1});
  await new Promise(r=>setTimeout(r,10));
  await assert.rejects(f.store.historyPage({cursor:first.nextCursor,limit:1}),e=>e.code==='STALE_HISTORY_CURSOR');
  await assert.rejects(new QualityStore({directory:f.directory}).historyPage({cursor:first.nextCursor,limit:1}),e=>e.code==='STALE_HISTORY_CURSOR');
  assert.deepEqual(fs.readdirSync(f.directory),before);
});
test('bounded scan limit fails explicitly and yields to a pending observer',async t=>{
  const f=fixture(t,{historyOptions:{maxRecords:10}});for(let i=0;i<12;i++)f.store.put('other',{}, {id:'r-'+i});
  let observed=false;setImmediate(()=>{observed=true;});
  await assert.rejects(f.store.historyPage({}),e=>e.code==='HISTORY_SCAN_LIMIT');assert.equal(observed,true);
});
test('oversize record fails without returning its successful payload',async t=>{
  const f=fixture(t,{historyOptions:{maxRecordBytes:1024}});f.store.put('observation',{success:true,data:'x'.repeat(2000)},{id:'large'});
  await assert.rejects(f.store.getAsync('large'),e=>e.code==='HISTORY_RECORD_TOO_LARGE');
});
test('metrics are opt-in, bounded, and count fresh selected bytes with unrelated metadata checks',async t=>{
  const f=fixture(t,{historyOptions:{metrics:true}});for(let i=0;i<10;i++)f.store.put(i===0?'observation':'other',{}, {id:'r-'+i});
  const page=await f.store.historyPage({kind:'observation'});
  assert.equal(page.metrics.filesEnumerated,10);assert.ok(page.metrics.stats>=10);assert.equal(page.metrics.reads,1);assert.ok(page.metrics.bytesRead>0);
  assert.equal((await new QualityStore({directory:f.directory}).historyPage({kind:'observation'})).metrics,undefined);
});
test('unreadable selected file propagates denial instead of returning cached success',async t=>{
  const f=fixture(t);f.store.put('observation',{success:true},{id:'one'});await f.store.listAsync('observation');
  const original=promises.open;
  t.mock.method(promises,'open',async function(file,...args){if(file===path.join(f.directory,'one.json'))throw Object.assign(new Error('Synthetic OS access denial'),{code:'EACCES'});return original.call(this,file,...args);});
  await assert.rejects(f.store.getAsync('one'),e=>e.code==='EACCES');
  await assert.rejects(f.store.listAsync('observation'),e=>e.code==='EACCES');
});
test('actual Windows exclusive lock cannot expose the old successful receipt',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.store.put('observation',{success:true},{id:'one'});await f.store.listAsync('observation');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=[Console]::ReadLine(); $h=[IO.File]::Open($p,'Open','ReadWrite','None'); [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null; $h.Dispose()"],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exit=new Promise(resolve=>child.once('exit',resolve));
  try {
    await new Promise((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('LOCKED'))resolve();});child.once('error',reject);child.once('exit',code=>{if(!output.includes('LOCKED'))reject(new Error('Lock helper exited: '+code));});child.stdin.write(path.join(f.directory,'one.json')+'\n');});
    await assert.rejects(f.store.getAsync('one'),e=>['EBUSY','EACCES','EPERM'].includes(e.code));
    await assert.rejects(f.store.historyPage({kind:'observation'}),e=>['EBUSY','EACCES','EPERM'].includes(e.code));
  }finally{child.kill();await exit;}
});
test('replacement during asynchronous read fails verification without baselining the replaced payload',async t=>{
  const f=fixture(t);f.store.put('observation',{value:'old'},{id:'one'});
  const original=promises.open;let replaced=false;
  t.mock.method(promises,'open',async function(file,...args){const handle=await original.call(this,file,...args);if(file===path.join(f.directory,'one.json')&&!replaced){const read=handle.read.bind(handle);handle.read=async(...readArgs)=>{const result=await read(...readArgs);if(!replaced){replaced=true;rewrite(f.directory,'one',r=>r.payload.value='new-longer-payload');}return result;};}return handle;});
  await assert.rejects(f.store.getAsync('one'),e=>e.code==='EVIDENCE_CHANGED');assert.equal(replaced,true);
});
test('lost delta base invalidates its continuation instead of silently switching to full',async t=>{
  const f=fixture(t,{historyOptions:{maxSnapshots:1}});f.store.put('observation',{}, {id:'one'});
  const base=await f.store.historyPage({kind:'observation'});
  new QualityStore({directory:f.directory}).put('observation',{}, {id:'two'});
  new QualityStore({directory:f.directory}).put('observation',{}, {id:'three'});
  const delta=await f.store.historyPage({kind:'observation',baseDigest:base.snapshotDigest,limit:1});assert.equal(delta.mode,'delta');
  await assert.rejects(f.store.historyPage({kind:'observation',baseDigest:base.snapshotDigest,limit:1,cursor:delta.nextCursor}),e=>e.code==='STALE_HISTORY_CURSOR');
});
test('valid file replacement by a second store is freshly read and sync metadata remains interoperable',async t=>{
  const f=fixture(t);f.store.put('observation',{value:'old'},{id:'one'});await f.store.listAsync('observation');
  fs.unlinkSync(path.join(f.directory,'one.json'));
  new QualityStore({directory:f.directory}).put('observation',{value:'replacement'},{id:'one'});
  assert.equal((await f.store.getAsync('one')).value,'replacement');
  assert.equal(f.store.list('observation')[0].value,'replacement');
  assert.throws(()=>f.store.put('observation',{}, {id:'one'}),/immutable|exists/i);
});
test('bounded selected list refuses an oversized aggregate and metadata pages still work',async t=>{
  const f=fixture(t,{historyOptions:{maxResultBytes:1000}});
  for(let i=0;i<4;i++)f.store.put('observation',{data:'x'.repeat(500)},{id:'r-'+i});
  await assert.rejects(f.store.listAsync('observation'),e=>e.code==='HISTORY_RESULT_LIMIT');
  assert.equal((await f.store.historyPage({kind:'observation',limit:2})).returnedCount,2);
});
test('snapshot byte cap causes explicit missing-base fallback and cursor count cap rejects lost cursors',async t=>{
  const f=fixture(t,{historyOptions:{maxSnapshotBytes:1,maxCursors:1}});
  for(let i=0;i<4;i++)f.store.put('observation',{}, {id:'r-'+i});
  const first=await f.store.historyPage({limit:1});
  const second=await f.store.historyPage({limit:1,baseDigest:first.snapshotDigest});
  assert.equal(second.baseUnavailable,true);assert.equal(second.mode,'full');
  await assert.rejects(f.store.historyPage({limit:1,cursor:first.nextCursor}),e=>e.code==='STALE_HISTORY_CURSOR');
});
test('a selected record changed after its read but before scan completion invalidates the snapshot',async t=>{
  const f=fixture(t);f.store.put('observation',{success:true},{id:'one'});
  const original=promises.stat;let directoryChecks=0;
  t.mock.method(promises,'stat',async function(file,...args){if(file===f.directory&&++directoryChecks===2)rewrite(f.directory,'one',r=>r.payload.success=false);return original.call(this,file,...args);});
  await assert.rejects(f.store.historyPage({kind:'observation'}),e=>e.code==='HISTORY_CHANGED_DURING_SCAN');
});
test('separate Node writer invalidates a cursor and is discovered without reader-local registration',async t=>{
  const f=fixture(t);for(let i=0;i<3;i++)f.store.put('observation',{}, {id:'r-'+i});
  const first=await f.store.historyPage({kind:'observation',limit:1});
  const writer=spawnSync(process.execPath,['--input-type=module','-e',"const {QualityStore}=await import(process.argv[1]);new QualityStore({directory:process.argv[2]}).put('observation',{writer:'separate-process'},{id:'new-process'});",new URL('../src/quality/store.mjs',import.meta.url).href,f.directory],{encoding:'utf8',windowsHide:true});
  assert.equal(writer.status,0,writer.stderr);
  await assert.rejects(f.store.historyPage({kind:'observation',limit:1,cursor:first.nextCursor}),e=>e.code==='STALE_HISTORY_CURSOR');
  assert.equal((await f.store.listAsync('observation')).find(r=>r.id==='new-process').writer,'separate-process');
});
test('cursor uses freshly verified selected content digest even when filesystem metadata collides',async t=>{
  const f=fixture(t);for(let i=0;i<3;i++)f.store.put('observation',{value:0},{id:'r-'+i});
  const first=await f.store.historyPage({kind:'observation',limit:1});
  const file=path.join(f.directory,'r-1.json'),fixed=await promises.stat(file,{bigint:true});
  rewrite(f.directory,'r-1',r=>r.payload.value=9);
  const stat=promises.stat,open=promises.open;
  t.mock.method(promises,'stat',async function(candidate,...args){return candidate===file?fixed:stat.call(this,candidate,...args);});
  t.mock.method(promises,'open',async function(candidate,...args){const handle=await open.call(this,candidate,...args);if(candidate===file)handle.stat=async()=>fixed;return handle;});
  await assert.rejects(f.store.historyPage({kind:'observation',limit:1,cursor:first.nextCursor}),e=>e.code==='STALE_HISTORY_CURSOR');
});
test('a valid digest cannot smuggle an oversized timestamp into bounded page metadata',async t=>{
  const f=fixture(t);f.store.put('observation',{}, {id:'one'});
  rewrite(f.directory,'one',r=>r.createdAt='x'.repeat(10000));
  await assert.rejects(f.store.historyPage({kind:'observation'}),e=>e.code==='EVIDENCE_ENVELOPE_INVALID');
});
