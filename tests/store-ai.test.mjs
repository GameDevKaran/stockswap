import test from 'node:test';import assert from 'node:assert/strict';
import {SqliteStore,GcsStore,serialQueue,StoreConflict} from '../src/store.mjs';
import {ProposalAI,validateProposal} from '../src/ai.mjs';
test('persistent record version prevents stale overwrite and rejects path keys',async()=>{const s=new SqliteStore(':memory:');try{assert.equal(await s.write('session_test',{consent:false}),'1');await assert.rejects(s.write('session_test',{consent:true},'0'),StoreConflict);assert.deepEqual((await s.read('session_test')).value,{consent:false});await assert.rejects(s.read('../secret'));}finally{s.close();}});
test('per-session queue serializes failures and subsequent work',async()=>{const q=serialQueue();const a=[];await Promise.allSettled([q('x',async()=>{a.push(1);throw Error('failed');}),q('x',async()=>a.push(2))]);assert.deepEqual(a,[1,2]);});
test('cloud store cannot be pointed at other projects or buckets',()=>{assert.throws(()=>new GcsStore({bucket:'production',project:'other'}));assert.throws(()=>new GcsStore({bucket:'other'}));});

test('GCS fixture pins media generation and refuses stale writes before overwriting',async()=>{
 const calls=[];let revision=0,saved;
 const s=new GcsStore({bucket:'stockswap-sessions-564976398462',fetchImpl:async(raw,options)=>{const u=new URL(raw);calls.push(u.href);
  if(u.pathname.endsWith('/project-id'))return new Response('tough-melody-508008-p8');
  if(u.pathname.endsWith('/token'))return Response.json({access_token:'fixture-token',expires_in:300});
  assert.equal(options.headers.Authorization,'Bearer fixture-token');
  if(options.method==='POST'){if(u.searchParams.get('ifGenerationMatch')!==String(revision))return new Response('',{status:412});saved=JSON.parse(options.body);revision++;return Response.json({generation:String(revision)});}
  if(u.searchParams.get('alt')==='media'){assert.equal(u.searchParams.get('generation'),String(revision));return Response.json(saved);}
  return revision?Response.json({generation:String(revision)}):new Response('',{status:404});
 }});
 assert.equal(await s.read('fixture'),null);await s.write('fixture',{consent:false});assert.deepEqual((await s.read('fixture')).value,{consent:false});await assert.rejects(s.write('fixture',{consent:true},'0'),StoreConflict);assert.equal(saved.consent,false);assert.equal(calls.filter(x=>x.endsWith('/project-id')).length,1);
});
test('model cannot invent SKU, payment fields or unsupported schema',()=>{const e=[{sku:'A',unitAmountCents:100}];assert.throws(()=>validateProposal({kind:'proposal',sku:'B',reason:'yes'},e));assert.throws(()=>validateProposal({kind:'proposal',sku:'A',reason:'yes',capture:true},e));assert.deepEqual(validateProposal({kind:'clarify',question:'Which color?'},e),{kind:'clarify',question:'Which color?'});});
test('mock is explicit and expired live allowance makes zero calls',async()=>{const mock=new ProposalAI();assert.equal((await mock.propose({preferences:'cheaper',eligible:[{sku:'A',unitAmountCents:100}]})).execution,'local_test_double');let calls=0;const ai=new ProposalAI({mode:'live',baseUrl:'https://api.openai.com/v1',apiKey:'test-fixture',model:'fixture',approvalReference:'test',expiresAt:'2000-01-01',fetchImpl:async()=>{calls++;}});await assert.rejects(ai.propose({preferences:'cheaper',eligible:[{sku:'A'}]}),/expired/);assert.equal(calls,0);});
