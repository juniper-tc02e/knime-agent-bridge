import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AsyncQualityHistory } from './history.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
export function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite numbers need an explicit typed representation.');
  if (!['string','number','boolean'].includes(typeof value)) throw new Error('Records must contain JSON values only.');
  return JSON.stringify(value);
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function immutable(value) { const copy=JSON.parse(canonical(value));const freeze=v=>{if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};return freeze(copy); }

/** Bridge-owned append-only JSON records. No mutation API is exposed to MCP clients. */
export class QualityStore {
  // Append-only discovery metadata, never cached payloads or evidence authority.
  #kinds=new Map();
  #fingerprints=new Map();
  #history;
  constructor({directory,historyOptions={}}={}) {
    if(typeof directory!=='string'||!directory.trim()) throw new Error('A bridge-owned quality directory is required.');
    this.directory=path.resolve(directory);mkdirSync(this.directory,{recursive:true});
    this.historyOptions={...historyOptions};
  }
  #asyncHistory() {return this.#history??=new AsyncQualityHistory({directory:this.directory,kinds:this.#kinds,fingerprints:this.#fingerprints,canonical,digest,immutable,options:this.historyOptions});}
  getAsync(id) {return this.#asyncHistory().get(id);}
  listAsync(kind,options) {return this.#asyncHistory().list(kind,options);}
  historyPage(options) {return this.#asyncHistory().page(options);}
  historyMetrics() {return this.#asyncHistory().metrics();}
  put(kind,payload,{id=randomUUID()}={}) {
    if(!identifier.test(id)||!identifier.test(kind)) throw new Error('Invalid immutable record identifier.');
    if(!payload||typeof payload!=='object'||Array.isArray(payload)) throw new Error('Record payload must be an object.');
    if(this.#kinds.has(id))throw new Error(`Immutable record already exists: ${id}`);
    const body={id,kind,createdAt:new Date().toISOString(),payload:JSON.parse(canonical(payload))};
    const envelope={...body,digest:digest(body)};
    writeFileSync(path.join(this.directory,`${id}.json`),canonical(envelope),{flag:'wx',encoding:'utf8',mode:0o600});
    this.#kinds.set(id,kind);
    this.#fingerprints.set(id,this.#fingerprint(id));
    return immutable({...body.payload,id,recordKind:kind,recordedAt:body.createdAt});
  }
  get(id) {
    if(typeof id!=='string'||!identifier.test(id)) throw new Error('Invalid record identifier.');
    const before=this.#fingerprint(id);
    let envelope;
    try { envelope=JSON.parse(readFileSync(path.join(this.directory,`${id}.json`),'utf8')); }
    catch(error){if(error.code==='ENOENT')throw new Error(`Unknown or missing evidence record: ${id}`);throw error;}
    const {digest:expected,...body}=envelope;
    if(body.id!==id||digest(body)!==expected)throw new Error(`Record integrity digest mismatch: ${id}`);
    if(typeof body.kind!=='string'||!identifier.test(body.kind))throw new Error(`Invalid immutable record kind: ${id}`);
    if(this.#kinds.has(id)&&this.#kinds.get(id)!==body.kind)throw new Error(`Immutable record kind changed: ${id}`);
    const after=this.#fingerprint(id);
    if(before!==after)throw new Error(`Immutable record changed during verification: ${id}`);
    this.#kinds.set(id,body.kind);
    this.#fingerprints.set(id,after);
    return immutable({...body.payload,id,recordKind:body.kind,recordedAt:body.createdAt});
  }
  #fingerprint(id) {
    let stat;
    try{stat=statSync(path.join(this.directory,`${id}.json`),{bigint:true});}
    catch(error){if(error.code==='ENOENT')throw new Error(`Unknown or missing evidence record: ${id}`);throw error;}
    return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  }
  list(kind) {
    // Enumerate names and metadata every time so additions and replacements are
    // observed before kind filtering. A legacy directory is classified once per instance.
    const discovered=new Map();
    for(const name of readdirSync(this.directory)) {
      if(!name.endsWith('.json'))continue;
      const id=name.slice(0,-5);
      if(!this.#kinds.has(id)||this.#fingerprints.get(id)!==this.#fingerprint(id))discovered.set(id,this.get(id));
    }
    const records=[];
    for(const [id,recordKind] of this.#kinds) {
      if(kind!==undefined&&recordKind!==kind)continue;
      // A discovery/invalidation read is fresh for this synchronous call only. Every previously
      // classified selected record is read and verified again, including missing files.
      records.push(discovered.get(id)??this.get(id));
    }
    return records.sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
  }
}
