// Isolated regression fixture: delay only lifecycle persistence, preserving
// actual filesystem effects and the real MCP stdio transport.
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
const [runtime,receipt,mode]=process.argv.slice(2);
const write=fs.writeFile,rename=fs.rename;
let lifecycleWrites=0,release;
const barrier=new Promise(resolve=>{release=resolve;});
fs.writeFile=async(target,...args)=>{
 if(String(target).startsWith(receipt+'.tmp-')&&++lifecycleWrites===2){
  release();await delay(250);
 }
 return write(target,...args);
};
if(mode==='publication')fs.rename=async(source,target)=>{
 if(path.basename(path.dirname(String(target)))==='requests'&&String(target).endsWith('.json')){
  process.stderr.write('publication-in-progress\n');await barrier;
 }
 return rename(source,target);
};
syncBuiltinESMExports();
const {BridgeClient}=await import('../../src/client.mjs');
const {startServer}=await import('../../src/server.mjs');
class StagedClient extends BridgeClient {
 selections=0;
 async selectSession(...args){
  const selected=await super.selectSession(...args);
  if(mode==='staging'&&++this.selections===2){process.stderr.write('staging-await\n');await barrier;}
  return selected;
 }
}
await startServer({client:new StagedClient({runtime,session:'synthetic',timeoutMs:2000}),lifecycleFile:receipt});
