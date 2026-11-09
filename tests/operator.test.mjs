import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {operatorAccess} from '../src/operator.mjs';import {createApp} from '../src/server.mjs';import {SqliteStore} from '../src/store.mjs';
const origin='http://127.0.0.1:8802',code='fixture-only-operator-code-32-characters';
test('operator tokens expire, reject tampering and cannot move between origins',()=>{
 let time=1800000000000;const options={required:true,code,origin:'https://stockswap.example',now:()=>time},gate=operatorAccess(options);
 assert.equal(gate.allowed({headers:{}}),false);assert.equal(gate.unlock('wrong'),null);
 const cookie=gate.unlock(code);assert.match(cookie,/HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
 const req={headers:{cookie:cookie.split(';')[0]}};assert.equal(gate.allowed(req),true);
 assert.equal(gate.allowed({headers:{cookie:req.headers.cookie.replace(/.$/,'z')}}),false);
 assert.equal(operatorAccess({...options,origin:'https://other.example'}).allowed(req),false);
 time+=3600000;assert.equal(gate.allowed(req),false);
});
test('live AI or cloud startup requires a private code; local doubles do not',()=>{
 assert.throws(()=>operatorAccess({required:true,origin}),/private operator/);
 assert.throws(()=>operatorAccess({required:true,origin,code:'short'}),/private operator/);
 assert.equal(operatorAccess({required:false,origin}).allowed({headers:{}}),true);
 const store=new SqliteStore(':memory:');
 assert.throws(()=>createApp({store,ai:{mode:'live'},origin}),/private operator/);
 assert.throws(()=>createApp({store,origin,requireOperatorCode:true}),/private operator/);store.close();
});
test('paid proposal requires login while buyer workflow, quota, readback and void stay independent',async t=>{
 const store=new SqliteStore(':memory:');let calls=0;
 const ai={mode:'live',execution:'controlled_transport_fixture',propose:async()=>{calls++;return{kind:'proposal',sku:'REEF-C1',reason:'Controlled lower-price fixture.',execution:'controlled_transport_fixture'};}};
 const app=createApp({store,origin,ai,operatorCode:code,maxAiCalls:1});app.listen(0,'127.0.0.1');await once(app,'listening');
 t.after(()=>{app.closeAllConnections();app.close();store.close();});const base=`http://127.0.0.1:${app.address().port}`,cookies=new Map();
 const call=async(path,input,extra={})=>{
  const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(input===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...extra},body:input===undefined?undefined:JSON.stringify(input)});
  for(const set of r.headers.getSetCookie()){const first=set.split(';')[0],at=first.indexOf('=');cookies.set(first.slice(0,at),first.slice(at+1));}
  return{status:r.status,...await r.json()};
 };
 const ok=async(path,input)=>{const r=await call(path,input);assert.ok(r.status<300,JSON.stringify(r.error));return r;};
 assert.equal((await ok('/api/session')).integration.operatorRequired,true);
 await ok('/api/session/new',{originalSku:'HBR-C1',quantity:1});await ok('/api/order/create',{});const auth=await ok('/api/order/authorize',{});
 await ok('/api/stock/change',{sku:'HBR-C1',stock:0});
 assert.equal((await call('/api/proposal',{preferences:'lower price'})).error.code,'OPERATOR_REQUIRED');
 assert.equal(calls,0);assert.equal(await store.read('ai_calls'),null);
 assert.equal((await call('/api/operator/login',{accessCode:code},{Origin:'https://other.example'})).status,403);
 assert.equal((await call('/api/operator/login',{accessCode:'wrong'})).status,401);
 const unlocked=await ok('/api/operator/login',{accessCode:code});assert.equal(unlocked.integration.operatorRequired,false);assert.equal(unlocked.session.id,auth.session.id);assert.equal(JSON.stringify(unlocked).includes(code),false);
 assert.equal((await ok('/api/session')).integration.operatorRequired,false);
 const proposed=await ok('/api/proposal',{preferences:'lower price'});assert.equal(proposed.session.proposal.sku,'REEF-C1');assert.equal(calls,1);
 assert.equal((await call('/api/proposal',{preferences:'lower price'})).error.code,'AI_LIMIT');assert.equal(calls,1);
 cookies.delete('stockswap_operator');assert.equal((await ok('/api/session')).integration.operatorRequired,true);
 assert.equal((await ok('/api/export')).session.id,auth.session.id);
 const terms=Object.fromEntries(['sku','quantity','amountCents','currency','authorizationId','inventoryRevision','proposalVersion'].map(k=>[k,proposed.session.proposal[k]]));
 await ok('/api/consent',terms);assert.equal((await ok('/api/capture',{})).session.status,'captured');
 await ok('/api/session/new',{originalSku:'HBR-C1',quantity:1});await ok('/api/order/create',{});await ok('/api/order/authorize',{});assert.equal((await ok('/api/void',{})).session.status,'voided');
});
