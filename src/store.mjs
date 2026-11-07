import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const keyOK = key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(key);
export class StoreConflict extends Error { constructor() { super('State changed. Reload before continuing.'); this.code='STATE_CONFLICT'; this.httpStatus=409; } }
function keyCheck(key) { if(!keyOK(key)) throw Error('Invalid storage key'); }
export class SqliteStore {
  constructor(path='.local/stockswap.sqlite') {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)');
  }
  async read(key) { keyCheck(key); const row=this.db.prepare('SELECT revision,value FROM records WHERE key=?').get(key); return row?{version:String(row.revision),value:JSON.parse(row.value)}:null; }
  async write(key,value,expected='0') {
    keyCheck(key); const body=JSON.stringify(value); if(Buffer.byteLength(body)>262144) throw Error('Record exceeds storage limit');
    this.db.exec('BEGIN IMMEDIATE');
    try { const row=this.db.prepare('SELECT revision FROM records WHERE key=?').get(key);
      if(String(row?.revision??0)!==String(expected)) throw new StoreConflict();
      const next=(row?.revision??0)+1;
      this.db.prepare('INSERT INTO records(key,revision,value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(key,next,body);
      this.db.exec('COMMIT'); return String(next);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}

/** Uses only the attached service identity in the single owner-authorized project. */
export class GcsStore {
  constructor({bucket,project='tough-melody-508008-p8',fetchImpl=fetch}) {
    if(project!=='tough-melody-508008-p8'||bucket!=='stockswap-sessions-564976398462') throw Error('Storage must use the isolated StockSwap bucket in the authorized project');
    this.bucket=bucket; this.fetch=fetchImpl; this.token=null;
  }
  async accessToken() {
    if(this.token&&Date.now()<this.token.until) return this.token.value;
    const options={headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000),redirect:'error'};
    const p=await this.fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id',options);
    if(!p.ok || (await p.text()).trim()!=='tough-melody-508008-p8') throw Error('Unauthorized runtime project');
    const r=await this.fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',options);
    if(!r.ok) throw Error('Runtime identity unavailable');
    const data=await r.json(); if(typeof data.access_token!=='string') throw Error('Runtime identity unavailable');
    this.token={value:data.access_token,until:Date.now()+Math.max(0,(Number(data.expires_in)-60))*1000};return this.token.value;
  }
  async request(url,options={}) {
    const response=await this.fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${await this.accessToken()}`},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(response.status===412) throw new StoreConflict();
    if(response.status===404)return null;
    if(!response.ok) throw Object.assign(Error('Private storage temporarily unavailable'),{httpStatus:503,code:'STORAGE_UNAVAILABLE'});
    return response;
  }
  async read(key) {
    keyCheck(key); const url=`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(key+'.json')}`;
    const meta=await this.request(url); if(!meta)return null; const details=await meta.json();
    const content=await this.request(`${url}?alt=media&generation=${details.generation}`);if(!content)throw new StoreConflict();
    const text=await content.text(); if(Buffer.byteLength(text)>262144)throw Error('Stored record too large');
    return {version:String(details.generation),value:JSON.parse(text)};
  }
  async write(key,value,expected='0') {
    keyCheck(key); if(!/^\d+$/.test(String(expected)))throw Error('Invalid generation');
    const body=JSON.stringify(value);if(Buffer.byteLength(body)>262144)throw Error('Record exceeds storage limit');
    const response=await this.request(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(key+'.json')}&ifGenerationMatch=${expected}`,{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!response)throw Error('Private storage unavailable');return String((await response.json()).generation);
  }
}

export function serialQueue() {
  const queues=new Map();
  return async (key,action)=>{
    const previous=queues.get(key)||Promise.resolve();
    const current=previous.catch(()=>{}).then(action);queues.set(key,current);
    try{return await current;}finally{if(queues.get(key)===current)queues.delete(key);}
  };
}
