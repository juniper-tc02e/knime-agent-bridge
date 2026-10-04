import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {QualityStore,canonical,digest} from '../src/quality/store.mjs';

const sizes=(process.env.HISTORY_SIZES??'10,1000,10000').split(',').map(Number);
const samples=Number(process.env.HISTORY_SAMPLES??5);
const implementations=(process.env.HISTORY_IMPLEMENTATIONS??'sync,async').split(',');
const output=path.resolve(process.env.HISTORY_OUTPUT??'runtime/evidence/history-baseline.json');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'knime-history-benchmark-'));
const rows=[];
const sourceHashes=Object.fromEntries(['scripts/benchmark-quality-history.mjs','src/quality/store.mjs','src/quality/history.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
let counters=null;
const originals={};
for(const method of ['readdirSync','statSync','readFileSync']) {
  originals[method]=fs[method];
  fs[method]=function(file,...args) {
    const selected=counters&&typeof file==='string'&&file.startsWith(directory);
    if(selected)counters[method==='readdirSync'?'enumerations':method==='statSync'?'stats':'reads']++;
    const result=originals[method].call(this,file,...args);
    if(selected&&method==='readdirSync')counters.filesEnumerated+=result.length;
    if(selected&&method==='readFileSync')counters.bytesRead+=Buffer.byteLength(result);
    return result;
  };
}
syncBuiltinESMExports();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function measure(count,sample,mode,store,implementation) {
  const histogram=monitorEventLoopDelay({resolution:1});histogram.enable();await pause(5);
  counters={enumerations:0,filesEnumerated:0,stats:0,reads:0,bytesRead:0};
  const utilization=performance.eventLoopUtilization(),cpu=process.cpuUsage(),start=performance.now();
  let peakRss=process.memoryUsage().rss,heartbeatMaxDelayMs=0,lastHeartbeat=start;
  const heartbeat=setInterval(()=>{const now=performance.now();heartbeatMaxDelayMs=Math.max(heartbeatMaxDelayMs,now-lastHeartbeat-5);lastHeartbeat=now;peakRss=Math.max(peakRss,process.memoryUsage().rss);},5);
  let timerDelay;
  const timer=new Promise(resolve=>setTimeout(()=>{timerDelay=performance.now()-start;resolve();},0));
  const records=implementation==='async'?await store.listAsync('context-observation'):store.list('context-observation');
  const elapsedMs=performance.now()-start,counts=implementation==='async'?store.historyMetrics():counters;counters=null;
  await timer;await pause(5);histogram.disable();clearInterval(heartbeat);
  const used=process.cpuUsage(cpu);
  rows.push({count,sample,implementation,mode,elapsedMs,timerDelayMs:timerDelay,eventLoopP95Ms:histogram.percentile(95)/1e6,eventLoopMaxMs:histogram.max/1e6,eventLoopUtilization:performance.eventLoopUtilization(utilization).utilization,heartbeatMaxDelayMs,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,peakRssSampledBytes:peakRss,returned:records.length,...Object.fromEntries(['enumerations','filesEnumerated','stats','reads','bytesRead'].map(key=>[key,counts[key]]))});
}
try {
  for(const count of sizes) {
    const fixture=path.join(directory,String(count));fs.mkdirSync(fixture);
    for(let i=0;i<count;i++) {
      const id='record-'+String(i).padStart(8,'0');
      const body={id,kind:i<8?'context-observation':'context-release',createdAt:new Date(1700000000000+i).toISOString(),payload:i<8?{contextId:'fixture',scopeId:'scope-'+i}:{contextId:'old-'+i,padding:'x'.repeat(4096)}};
      fs.writeFileSync(path.join(fixture,id+'.json'),canonical({...body,digest:digest(body)}));
    }
    for(let sample=0;sample<samples;sample++)for(const implementation of implementations) {
      const store=new QualityStore({directory:fixture,historyOptions:{metrics:true}});
      await measure(count,sample,'cold',store,implementation);await measure(count,sample,'warm',store,implementation);
    }
    process.stderr.write(`Measured ${count} records\n`);
  }
  const percentile=(values,fraction)=>values.toSorted((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*fraction)-1)];
  const summary=sizes.flatMap(count=>implementations.flatMap(implementation=>['cold','warm'].map(mode=>{const selected=rows.filter(r=>r.count===count&&r.mode===mode&&r.implementation===implementation);return {count,implementation,mode,samples:selected.length,p50Ms:percentile(selected.map(r=>r.elapsedMs),.5),p95Ms:percentile(selected.map(r=>r.elapsedMs),.95),maxMs:Math.max(...selected.map(r=>r.elapsedMs)),timerDelayMaxMs:Math.max(...selected.map(r=>r.timerDelayMs)),eventLoopMaxMs:Math.max(...selected.map(r=>r.eventLoopMaxMs)),heartbeatMaxDelayMs:Math.max(...selected.map(r=>r.heartbeatMaxDelayMs)),...Object.fromEntries(['filesEnumerated','stats','reads','bytesRead'].map(k=>[k,selected[0][k]]))};})));
  const result={schemaVersion:1,sourceHashes,fixture:{selected:8,unrelatedPayloadBytes:4096,cacheMeaning:'cold is new store instance; OS cache and other host task activity are uncontrolled',samples,omissions:'50000 omitted because 10000 sync cold already takes multiple seconds; no host UI or native queue timing measured'},environment:{node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,cpuModel:os.cpus()[0]?.model,totalMemoryBytes:os.totalmem(),freeMemoryBytes:os.freemem(),clock:'performance.now monotonic',capturedAt:new Date().toISOString()},summary,rows};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
  fs.writeFileSync(output.replace(/\.json$/,'.csv'),[Object.keys(rows[0]).join(','),...rows.map(r=>Object.values(r).join(','))].join('\n'));
  console.log(JSON.stringify({output,summary},null,2));
} finally {
  for(const [method,original] of Object.entries(originals))fs[method]=original;
  syncBuiltinESMExports();fs.rmSync(directory,{recursive:true,force:true});
}
