import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setImmediate as yieldTurn} from 'node:timers/promises';

const identifier=/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const failure=(code,message)=>Object.assign(new Error(message),{code});
const fingerprint=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const order=(a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id);

/** Asynchronous disk-authoritative history. Only discovery metadata is retained. */
export class AsyncQualityHistory {
  #snapshots=new Map();#cursors=new Map();#lastMetrics;
  constructor({directory,kinds,fingerprints,canonical,digest,immutable,options={}}) {
    Object.assign(this,{directory,kinds,fingerprints,canonical,digest,immutable});
    this.options={batchSize:32,maxRecords:100000,maxRecordBytes:8*1024*1024,maxResultBytes:16*1024*1024,maxSnapshots:8,maxSnapshotBytes:16*1024*1024,maxCursors:128,cursorTtlMs:300000,metrics:false,...options};
    for(const name of ['batchSize','maxRecords','maxRecordBytes','maxResultBytes','maxSnapshots','maxSnapshotBytes','maxCursors','cursorTtlMs'])if(!Number.isSafeInteger(this.options[name])||this.options[name]<1)throw new Error(`Invalid history bound: ${name}`);
    if(this.options.batchSize>64)throw new Error('History batchSize must be at most 64.');
  }
  metrics(){return this.#lastMetrics?{...this.#lastMetrics}:undefined;}
  async #run(enabled,operation) {
    const metrics={enumerations:0,filesEnumerated:0,stats:0,reads:0,bytesRead:0,yields:0};const started=performance.now();
    try{return await operation(metrics);}finally{metrics.elapsedMs=performance.now()-started;if(enabled)this.#lastMetrics={...metrics};}
  }
  async #stat(file,metrics) {
    metrics.stats++;
    try{return await fs.stat(file,{bigint:true});}catch(error){if(error.code==='ENOENT')throw failure('EVIDENCE_MISSING',`Unknown or missing evidence record: ${path.basename(file,'.json')}`);throw error;}
  }
  async #read(id,metrics,before) {
    if(typeof id!=='string'||!identifier.test(id))throw new Error('Invalid record identifier.');
    const file=path.join(this.directory,id+'.json');before??=await this.#stat(file,metrics);
    if(before.size>BigInt(this.options.maxRecordBytes))throw failure('HISTORY_RECORD_TOO_LARGE',`Evidence record exceeds the ${this.options.maxRecordBytes} byte detail bound: ${id}`);
    let handle;
    try {
      handle=await fs.open(file,'r');metrics.stats++;const opened=await handle.stat({bigint:true});
      if(fingerprint(before)!==fingerprint(opened))throw failure('EVIDENCE_CHANGED',`Immutable record changed during verification: ${id}`);
      // Bound allocation even when an independent writer grows the file after stat.
      const buffer=Buffer.alloc(Number(opened.size)+1);metrics.reads++;
      let length=0;while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
      metrics.bytesRead+=length;
      metrics.stats++;const after=await handle.stat({bigint:true});
      const current=await this.#stat(file,metrics);
      if(length!==Number(opened.size)||fingerprint(before)!==fingerprint(after)||fingerprint(before)!==fingerprint(current))throw failure('EVIDENCE_CHANGED',`Immutable record changed during verification: ${id}`);
      const envelope=JSON.parse(buffer.subarray(0,length).toString('utf8'));
      const {digest:expected,...body}=envelope;
      if(body.id!==id||this.digest(body)!==expected)throw failure('EVIDENCE_INTEGRITY',`Record integrity digest mismatch: ${id}`);
      if(typeof body.createdAt!=='string'||body.createdAt.length>40||!Number.isFinite(Date.parse(body.createdAt))||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))throw failure('EVIDENCE_ENVELOPE_INVALID',`Invalid immutable evidence envelope: ${id}`);
      if(typeof body.kind!=='string'||!identifier.test(body.kind))throw new Error(`Invalid immutable record kind: ${id}`);
      if(this.kinds.has(id)&&this.kinds.get(id)!==body.kind)throw failure('EVIDENCE_KIND_CHANGED',`Immutable record kind changed: ${id}`);
      this.kinds.set(id,body.kind);this.fingerprints.set(id,fingerprint(current));
      return {record:this.immutable({...body.payload,id,recordKind:body.kind,recordedAt:body.createdAt}),summary:{id,recordKind:body.kind,recordedAt:body.createdAt,digest:expected},fingerprint:fingerprint(current),bytes:length};
    }catch(error){if(error.code==='ENOENT')throw failure('EVIDENCE_MISSING',`Unknown or missing evidence record: ${id}`);throw error;}finally{await handle?.close();}
  }
  async get(id) {return this.#run(this.options.metrics,async metrics=>(await this.#read(id,metrics)).record);}
  async #scan(kind,metrics,{records=false,allowMissing=false,maxResultBytes=this.options.maxResultBytes}={}) {
    if(kind!==undefined&&(typeof kind!=='string'||!identifier.test(kind)))throw new Error('Invalid immutable record kind.');
    const seen=new Set(),metadata=new Map(),selected=new Map(),values=[];let resultBytes=0;
    const before=fingerprint(await this.#stat(this.directory,metrics));metrics.enumerations++;
    const directory=await fs.opendir(this.directory);let batch=[];
    const processBatch=async()=>{
      const completed=await Promise.allSettled(batch.map(async name=>{
        const id=name.slice(0,-5);if(!identifier.test(id))throw new Error('Invalid immutable record identifier.');
        const stat=await this.#stat(path.join(this.directory,name),metrics),current=fingerprint(stat);
        let verified;
        if(!this.kinds.has(id)||this.fingerprints.get(id)!==current||kind===undefined||this.kinds.get(id)===kind)verified=await this.#read(id,metrics,stat);
        metadata.set(id,current);
        if(kind===undefined||this.kinds.get(id)===kind) {
          selected.set(id,{...verified.summary,fingerprint:verified.fingerprint});
          if(records){resultBytes+=verified.bytes;if(resultBytes>maxResultBytes)throw failure('HISTORY_RESULT_LIMIT','Selected evidence exceeds the bounded list result; use historyPage and getAsync detail.');values.push(verified.record);}
        }
      }));const rejected=completed.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
      batch=[];metrics.yields++;await yieldTurn();
    };
    try {
      for await(const entry of directory) {
        if(!entry.name.endsWith('.json'))continue;
        seen.add(entry.name.slice(0,-5));metrics.filesEnumerated++;
        if(seen.size>this.options.maxRecords)throw failure('HISTORY_SCAN_LIMIT',`History exceeds the ${this.options.maxRecords} record scan bound; no complete snapshot was returned.`);
        batch.push(entry.name);if(batch.length>=this.options.batchSize)await processBatch();
      }
      if(batch.length)await processBatch();
    }catch(error){try{await directory.close();}catch{}throw error;}
    if(before!==fingerprint(await this.#stat(this.directory,metrics)))throw failure('HISTORY_CHANGED_DURING_SCAN','History directory changed during enumeration; retry a new bounded query.');
    // Detect changes to earlier entries while later records were being verified.
    // This is a checked observation, not a filesystem-wide transactional lock.
    const entries=[...metadata];
    for(let start=0;start<entries.length;start+=this.options.batchSize) {
      const verified=await Promise.allSettled(entries.slice(start,start+this.options.batchSize).map(async([id,expected])=>{
        if(fingerprint(await this.#stat(path.join(this.directory,id+'.json'),metrics))!==expected)throw failure('HISTORY_CHANGED_DURING_SCAN','History record changed before scan completion; retry a new bounded query.');
      }));
      const rejected=verified.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
      metrics.yields++;await yieldTurn();
    }
    if(before!==fingerprint(await this.#stat(this.directory,metrics)))throw failure('HISTORY_CHANGED_DURING_SCAN','History directory changed before scan completion; retry a new bounded query.');
    const missing=[...this.kinds].filter(([id,recordKind])=>!seen.has(id)&&(kind===undefined||recordKind===kind)).map(([id])=>id);
    if(missing.length&&!allowMissing)throw failure('EVIDENCE_MISSING',`Unknown or missing evidence record: ${missing[0]}`);
    const hash=createHash('sha256');hash.update(`${kind??'*'}\n`);
    // maxRecords bounds sorting; metadata hashing yields between batches.
    const names=[...metadata.keys()].sort();
    for(let start=0;start<names.length;start+=this.options.batchSize){for(const id of names.slice(start,start+this.options.batchSize))hash.update(`${id}:${metadata.get(id)}:${selected.get(id)?.digest??''}\n`);metrics.yields++;await yieldTurn();}
    return {digest:hash.digest('hex'),selected,records:values.sort(order),missing};
  }
  async list(kind,{maxResultBytes=this.options.maxResultBytes}={}) {
    if(!Number.isSafeInteger(maxResultBytes)||maxResultBytes<1||maxResultBytes>this.options.maxResultBytes)throw new Error('Invalid bounded history result bytes.');
    return this.#run(this.options.metrics,async metrics=>(await this.#scan(kind,metrics,{records:true,maxResultBytes})).records);
  }
  #expire() {
    const now=Date.now();for(const [key,value] of this.#snapshots)if(value.expiresAt<=now)this.#snapshots.delete(key);
    for(const [key,value] of this.#cursors)if(value.expiresAt<=now)this.#cursors.delete(key);
  }
  #remember(snapshot,kind) {
    const bytes=Buffer.byteLength(JSON.stringify([...snapshot.selected]));
    if(bytes>this.options.maxSnapshotBytes)return;
    this.#snapshots.delete(snapshot.digest);this.#snapshots.set(snapshot.digest,{kind,selected:snapshot.selected,bytes,expiresAt:Date.now()+this.options.cursorTtlMs});
    let total=[...this.#snapshots.values()].reduce((n,s)=>n+s.bytes,0);
    while(this.#snapshots.size>this.options.maxSnapshots||total>this.options.maxSnapshotBytes){const key=this.#snapshots.keys().next().value;total-=this.#snapshots.get(key).bytes;this.#snapshots.delete(key);}
  }
  async page({kind,limit=50,cursor,baseDigest,metrics:requestedMetrics=false}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('History page limit must be between 1 and 200.');
    if(baseDigest!==undefined&&(typeof baseDigest!=='string'||!/^[a-f0-9]{64}$/.test(baseDigest)))throw new Error('History baseDigest must be an explicit snapshot digest.');
    const enabled=this.options.metrics||requestedMetrics;
    return this.#run(enabled,async metrics=>{
      this.#expire();const continuation=cursor===undefined?undefined:this.#cursors.get(cursor);
      if(cursor!==undefined&&!continuation)throw failure('STALE_HISTORY_CURSOR','History cursor is expired, unknown or belongs to another store; request a fresh first page.');
      if(continuation&&(continuation.kind!==kind||continuation.baseDigest!==baseDigest))throw failure('STALE_HISTORY_CURSOR','History cursor query changed; request a fresh first page.');
      const snapshot=await this.#scan(kind,metrics,{allowMissing:!!continuation||baseDigest!==undefined});
      if(continuation&&continuation.digest!==snapshot.digest)throw failure('STALE_HISTORY_CURSOR','History changed since this cursor was issued; request a fresh first page.');
      const base=baseDigest===undefined?undefined:this.#snapshots.get(baseDigest);
      const validBase=base&&base.kind===kind;let mode=validBase?'delta':'full',items;
      if(continuation&&continuation.mode!==mode)throw failure('STALE_HISTORY_CURSOR','History delta base is no longer retained; request a fresh first page.');
      if(!validBase&&snapshot.missing.length)throw failure('EVIDENCE_MISSING',`Unknown or missing evidence record: ${snapshot.missing[0]}`);
      const clean=entry=>{const {fingerprint:ignored,...summary}=entry;return summary;};
      if(validBase) {
        items=[];
        for(const [id,entry] of snapshot.selected){const old=base.selected.get(id);if(!old||old.fingerprint!==entry.fingerprint||old.digest!==entry.digest)items.push({...clean(entry),change:old?'changed':'added'});}
        for(const [id,entry] of base.selected)if(!snapshot.selected.has(id))items.push({...clean(entry),change:'removed'});
      }else items=[...snapshot.selected.values()].map(clean);
      items.sort(order);const offset=continuation?.offset??0,page=items.slice(offset,offset+limit),truncated=offset+page.length<items.length;
      this.#remember(snapshot,kind);let nextCursor=null;
      if(truncated){nextCursor=randomUUID();this.#cursors.set(nextCursor,{kind,baseDigest,mode,digest:snapshot.digest,offset:offset+page.length,expiresAt:Date.now()+this.options.cursorTtlMs});while(this.#cursors.size>this.options.maxCursors)this.#cursors.delete(this.#cursors.keys().next().value);}
      return {items:page,totalCount:items.length,returnedCount:page.length,truncated,nextCursor,snapshotDigest:snapshot.digest,mode,...(baseDigest===undefined?{}:{baseDigest,...(!validBase?{baseUnavailable:true}:{})}),...(enabled?{metrics}:{} )};
    });
  }
}
