import {createHash} from 'node:crypto';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Metadata only: callers never supply raw arguments, results or protected values. */
export function startTrace({directory,maxEvents=100,operationId,operation,deadline,runtime,profile}) {
 if(!directory)return null;
 const start=performance.now();const events=[];const counts={polls:0,requestBytes:0,resultBytes:0,droppedEvents:0};
 return {event(stage){if(events.length<maxEvents)events.push({stage,elapsedMs:Number((performance.now()-start).toFixed(3))});else counts.droppedEvents++;},counts,
  async finish({sessionId,identity,submission,outcome}) {
   try {
    const root=path.resolve(directory);await mkdir(root,{recursive:true,mode:0o700});
    // Preserve existing evidence. Once the explicit artifact budget is full,
    // disable new artifacts instead of removing an earlier operation's trace.
    if((await readdir(root)).filter(n=>/^client-trace-.*\.json$/.test(n)).length>=128)return {operationId,status:'unavailable',reason:'Trace artifact budget reached (128).'};
    const value={schemaVersion:1,operationId,operation,clock:'process_monotonic',deadline,runtime,profile:profile??null,sessionId:sessionId??null,identity:identity??null,submission,outcome,events,counts,unmeasured:['native_queue','native_work','host_rendering']};
    const raw=JSON.stringify(value),file=path.join(root,`client-trace-${operationId}-${process.pid}-${Math.trunc(start*1000)}.json`);
    await writeFile(file,raw,{flag:'wx',mode:0o600});return {operationId,path:file,sha256:createHash('sha256').update(raw).digest('hex'),bytes:Buffer.byteLength(raw)};
   }catch(error){return {operationId,status:'unavailable',reason:error.code??'TRACE_WRITE_FAILED'};}
  }};
}
