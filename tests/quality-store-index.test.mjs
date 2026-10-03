import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {QualityStore,canonical,digest} from '../src/quality/store.mjs';

function fixture(t) {
  const directory=fs.mkdtempSync(path.join(tmpdir(),'knime-quality-index-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {directory,store:new QualityStore({directory})};
}
function reads(t,directory) {
  const original=fs.readFileSync,files=[];
  t.mock.method(fs,'readFileSync',function(file,...args){
    if(typeof file==='string'&&path.dirname(file)===directory&&file.endsWith('.json'))files.push(path.basename(file));
    return original.call(this,file,...args);
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return files;
}
function history(store,count=400) {
  for(let i=0;i<count;i++) {
    store.put('context',{contextId:'ctx-'+i},{id:'context-'+i});
    store.put('context-release',{contextId:'ctx-'+i},{id:'release-'+i});
  }
}
function rewrite(directory,id,change,{resign=false}={}) {
  const file=path.join(directory,id+'.json'),record=JSON.parse(fs.readFileSync(file,'utf8'));
  change(record);
  if(resign){const {digest:old,...body}=record;record.digest=digest(body);}
  fs.writeFileSync(file,canonical(record));
}

test('new records register kind immediately and repeated selected lists read only matching payloads',t=>{
  const f=fixture(t);history(f.store);
  for(let i=0;i<3;i++)f.store.put('context-observation',{contextId:'ctx',scopeId:'scope-'+i},{id:'observation-'+i});
  const files=reads(t,f.directory);
  assert.equal(f.store.list('context-observation').length,3);
  assert.deepEqual(files.sort(),['observation-0.json','observation-1.json','observation-2.json']);
  files.length=0;assert.equal(f.store.list('context-observation').length,3);assert.equal(files.length,3);
  assert.throws(()=>f.store.put('capture',{}, {id:'observation-0'}),/exist|immutable/i);
  f.store.put('context-observation',{contextId:'ctx'},{id:'observation-new'});f.store.put('context-release',{}, {id:'release-new'});
  files.length=0;assert.equal(f.store.list('context-observation').length,4);assert.equal(files.length,4);
  assert.ok(files.every(name=>name.startsWith('observation-')));
});

test('a restarted store discovers legacy history once then freshly reads only selected records',t=>{
  const f=fixture(t);history(f.store);
  f.store.put('context-observation',{scopeId:'one'},{id:'observation'});
  const restarted=new QualityStore({directory:f.directory}),files=reads(t,f.directory);
  assert.equal(restarted.list('context-observation')[0].scopeId,'one');assert.equal(files.length,801);
  files.length=0;assert.equal(restarted.list('context-observation').length,1);assert.deepEqual(files,['observation.json']);
  files.length=0;assert.equal(restarted.list().length,801);assert.equal(files.length,801);
});

test('another store additions are discovered incrementally without rereading old unrelated history',t=>{
  const f=fixture(t);history(f.store);
  f.store.put('context-observation',{scopeId:'old'},{id:'old-observation'});
  assert.equal(f.store.list('context-observation').length,1);
  const another=new QualityStore({directory:f.directory});
  another.put('context-observation',{scopeId:'new'},{id:'new-observation'});another.put('context-release',{}, {id:'external-release'});
  const files=reads(t,f.directory);
  assert.deepEqual(f.store.list('context-observation').map(r=>r.scopeId).sort(),['new','old']);
  assert.deepEqual(files.sort(),['external-release.json','new-observation.json','old-observation.json']);
  files.length=0;assert.equal(f.store.list('context-observation').length,2);
  assert.deepEqual(files.sort(),['new-observation.json','old-observation.json']);
});

test('get and selected lists reject tampered payloads even after classification was cached',t=>{
  const f=fixture(t);f.store.put('context-observation',{scopeId:'root'},{id:'selected'});
  assert.equal(f.store.get('selected').scopeId,'root');assert.equal(f.store.list('context-observation').length,1);
  rewrite(f.directory,'selected',record=>{record.payload.scopeId='tampered';});
  assert.throws(()=>f.store.get('selected'),/integrity|digest/i);
  assert.throws(()=>f.store.list('context-observation'),/integrity|digest/i);
});

test('selected kind replacement fails closed even if its new envelope has a valid digest',t=>{
  const f=fixture(t);f.store.put('context-observation',{scopeId:'root'},{id:'selected'});
  assert.equal(f.store.list('context-observation').length,1);
  rewrite(f.directory,'selected',record=>{record.kind='context-release';},{resign:true});
  assert.throws(()=>f.store.list('context-observation'),/kind|classification|immutable/i);
  assert.throws(()=>f.store.get('selected'),/kind|classification|immutable/i);
});

test('a cached unrelated record rewritten into the requested kind cannot silently disappear from manifests',t=>{
  const f=fixture(t);f.store.put('context-release',{contextId:'ctx'},{id:'changed-history'});
  assert.equal(f.store.list('context-observation').length,0);
  rewrite(f.directory,'changed-history',record=>{record.kind='context-observation';},{resign:true});
  assert.throws(()=>f.store.list('context-observation'),/kind|classification|immutable/i);
});

test('another writer recreating a cached unrelated ID as a relevant kind fails closed',t=>{
  const f=fixture(t);f.store.put('context-release',{contextId:'old'},{id:'recreated-history'});
  assert.equal(f.store.list('context-observation').length,0);
  fs.unlinkSync(path.join(f.directory,'recreated-history.json'));
  const another=new QualityStore({directory:f.directory});
  another.put('context-observation',{contextId:'new'},{id:'recreated-history'});
  assert.throws(()=>f.store.list('context-observation'),/kind|classification|immutable/i);
});

test('metadata changes trigger a fresh verification even for cached unrelated records',t=>{
  const f=fixture(t);f.store.put('context-release',{}, {id:'touched-history'});f.store.put('context-observation',{}, {id:'selected'});
  assert.equal(f.store.list('context-observation').length,1);
  const file=path.join(f.directory,'touched-history.json'),stat=fs.statSync(file);
  fs.utimesSync(file,stat.atime,new Date(stat.mtimeMs+10000));
  const files=reads(t,f.directory);
  assert.equal(f.store.list('context-observation').length,1);
  assert.deepEqual(files.sort(),['selected.json','touched-history.json']);
  files.length=0;assert.equal(f.store.list('context-observation').length,1);assert.deepEqual(files,['selected.json']);
});

test('metadata replacement during a fresh read cannot baseline the older verified payload against the newer file',t=>{
  const f=fixture(t);f.store.put('context-release',{contextId:'old'},{id:'racing-record'});
  const file=path.join(f.directory,'racing-record.json'),original=fs.readFileSync;
  let replaced=false;
  t.mock.method(fs,'readFileSync',function(candidate,...args){
    const contents=original.call(this,candidate,...args);
    if(candidate===file&&!replaced) {
      replaced=true;const record=JSON.parse(contents);record.payload.contextId='new-payload-with-different-size';
      const {digest:previous,...body}=record;record.digest=digest(body);
      fs.writeFileSync(file,canonical(record));
    }
    return contents;
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  assert.throws(()=>f.store.get('racing-record'),/changed during verification/i);
  assert.equal(replaced,true);
});

test('deleting a selected record is an error and a discovered ID cannot be reused in that instance',t=>{
  const f=fixture(t);f.store.put('context-observation',{}, {id:'selected'});
  assert.equal(f.store.list('context-observation').length,1);
  fs.unlinkSync(path.join(f.directory,'selected.json'));
  assert.throws(()=>f.store.list('context-observation'),/unknown|missing/i);
  assert.throws(()=>f.store.get('selected'),/unknown|missing/i);
  assert.throws(()=>f.store.put('context-observation',{replacement:true},{id:'selected'}),/exist|immutable/i);
  assert.equal(fs.existsSync(path.join(f.directory,'selected.json')),false);
});

test('metadata-detected unselected tampering is rejected before typed filtering',t=>{
  const f=fixture(t);f.store.put('context',{}, {id:'unselected'});f.store.put('context-observation',{}, {id:'selected'});
  assert.equal(f.store.list('context-observation').length,1);
  rewrite(f.directory,'unselected',record=>{record.payload.forged=true;});
  assert.throws(()=>f.store.list('context-observation'),/integrity|digest/i);
  assert.throws(()=>f.store.get('unselected'),/integrity|digest/i);
  assert.throws(()=>f.store.list(),/integrity|digest/i);
});
