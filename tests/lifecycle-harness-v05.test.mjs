import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('lifecycle harness preserves its first failure and closes all owned transports by EOF',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'knime-lifecycle-failure-')),markers=path.join(directory,'eof');await mkdir(markers);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const fake=path.join(directory,'fake.cjs'),preload=path.join(directory,'preload.cjs'),output=path.join(directory,'report');
 await writeFile(fake,`const fs=require('node:fs');const path=require('node:path');process.stdin.on('end',()=>fs.writeFileSync(path.join(${JSON.stringify(markers)},process.pid+'.txt'),'eof'));process.stdin.resume();process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32603,message:'controlled initialization failure'}})+'\\n');`);
 // Replace only the spawned fixture entry point in this isolated harness process;
 // child stdio and EOF handling still use actual OS pipes.
 await writeFile(preload,`const cp=require('node:child_process');const original=cp.spawn;cp.spawn=(exe,args,options)=>original(exe,[${JSON.stringify(fake)}],options);require('node:module').syncBuiltinESMExports();`);
 const child=spawn(process.execPath,['--require',preload,path.resolve('scripts/verify-lifecycle-v05.mjs'),output,'1'],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stdout.resume();child.stderr.on('data',c=>stderr+=c);const exit=await new Promise(resolve=>child.once('exit',resolve));
 assert.equal(exit,1,stderr);const failure=JSON.parse(await readFile(path.join(output,'failure-run.json'),'utf8'));
 assert.equal(failure.status,'failed');assert.equal(failure.primary.message,'Initialize returned an RPC error.');assert.equal(failure.cleanup.ownedChildrenRemaining,0);assert.deepEqual(failure.secondary,[]);
 assert.equal(failure.cleanup.deadlineMs-failure.primary.firstFailureMs,5000);assert.equal((await readdir(markers)).length,3,'Each owned fixture must receive EOF during bounded cleanup');
});
