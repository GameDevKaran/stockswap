import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as d from './domain.mjs';
import {SqliteStore,GcsStore,serialQueue} from './store.mjs';
import {SandboxPayPal,MockPayPal} from './paypal.mjs';
import {ProposalAI} from './ai.mjs';
import {operatorAccess} from './operator.mjs';

const now=()=>new Date().toISOString();
const hash=x=>createHash('sha256').update(x).digest('hex');
const error=(code,message,httpStatus=409)=>Object.assign(Error(message),{code,httpStatus});
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(),microphone=(),geolocation=()',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
const files=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/styles.css',['styles.css','text/css']]]);
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>100000)throw error('BODY_LIMIT','Request too large',413);chunks.push(chunk);}try{const v=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw error('INVALID_JSON','A JSON object is required',400);}}
function send(res,status,value,extra={}){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));}
function cookieIdentity(req){const c=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('stockswap='))?.slice(10);if(!c)return null;const match=/^([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(c);return match?{id:match[1],secret:match[2]}:null;}
function sameHash(a,b){return typeof a==='string'&&a.length===64&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
const terminal=s=>['captured','voided','expired'].includes(s?.status);
export function createApp({store=new SqliteStore(),paypal=null,ai=new ProposalAI(),origin='http://127.0.0.1:8802',maxAiCalls=0,operatorCode,requireOperatorCode=false}={}){
 if(!Number.isSafeInteger(maxAiCalls)||maxAiCalls<0||maxAiCalls>1000)throw Error('AI request allowance must be an integer from zero to 1000');
 const site=new URL(origin);if(site.username||site.password||site.pathname!=='/'||site.search||site.hash||!(site.protocol==='https:'||(site.protocol==='http:'&&['127.0.0.1','localhost'].includes(site.hostname))))throw Error('Invalid application origin');
 origin=site.origin;const queue=serialQueue();const rate=new Map();
 const access=operatorAccess({required:ai.mode==='live'||requireOperatorCode,code:operatorCode,origin});
 const getPay=record=>paypal||new MockPayPal(record.mockProvider);
 const view=(record,operatorRequired=false)=>{let options=[];try{if(record?.state.authorization)options=d.replacementOptions(record.state,{now:now()});}catch{}
  return{session:record?.state||null,catalog:d.CATALOG,integration:{paypal:paypal?.execution||'mock_paypal',ai:ai.execution,liveVerified:false,operatorRequired},eligible:options,providerReadback:record?.providerReadback||null,aiProposal:record?.aiProposal||null,approvalUrl:record?.state.order?.approveUrl||null};};
 async function load(identity){if(!identity)return null;const row=await store.read(identity.id);if(!row||!sameHash(row.value.authHash,hash(identity.secret)))throw error('SESSION_NOT_FOUND','This private session is unavailable. Start a new session.',401);return row;}
 async function providerIndex(id,sessionId){if(!id)return;const key='provider_'+hash(id);const row=await store.read(key);if(row&&row.value.sessionId!==sessionId)throw error('PROVIDER_CONFLICT','Provider identifier already belongs to a different session.');if(!row)await store.write(key,{sessionId});}
 async function reconcile(record,pay,save){
  const state=record.state;if(!state.order?.orderId)throw error('ORDER_UNRESOLVED','The order response is unresolved. Retry creation with its stored request ID within five minutes, or review the Sandbox account.');
  const order=await pay.getOrder(state.order.orderId);record.providerReadback=order;
  if(order.id!==state.order.orderId)throw error('ORDER_PROOF_MISMATCH','Provider returned a different order.');
  if(state.operation?.kind==='capture'){
   // Order summaries can omit related authorization IDs. Resolve each matching
   // candidate through Payments GET, never infer the relationship from price.
   let id=record.pendingCaptureId;
   if(!id)for(const candidate of order.captures.filter(x=>x.amountCents===state.operation.amountCents&&x.currency===state.operation.currency)){
    const found=await pay.getCapture(candidate.id);
    if(found.authorizationId===state.authorization.authorizationId){if(id&&id!==found.id)throw error('MULTIPLE_CAPTURES','Multiple matching captures require merchant review.');id=found.id;}
   }
   if(id){const proof=await pay.getCapture(id);if(proof.authorizationId!==state.authorization.authorizationId)throw error('CAPTURE_RELATION_UNVERIFIED','Capture relationship was not confirmed by the provider.');record.providerReadback=proof;record.state=d.confirmCapture(state,{operationId:state.operation.operationId,captureId:proof.id,authorizationId:proof.authorizationId,amountCents:proof.amountCents,currency:proof.currency,status:proof.status,now:now()});}
  }else if(state.operation?.kind==='void'){
   const proof=await pay.getAuthorization(state.authorization.authorizationId);record.providerReadback=proof;
   if(proof.status==='VOIDED')record.state=d.confirmVoid(state,{operationId:state.operation.operationId,authorizationId:proof.id,status:proof.status,now:now()});
  }else if(!state.authorization&&state.order.authorizationOperation){
   const auth=order.authorizations[0];if(auth){const proof=await pay.getAuthorization(auth.id);record.providerReadback=proof;
    if(proof.status==='CREATED'&&proof.expirationTime)record.state=d.markAuthorised(state,{orderId:order.id,authorizationId:proof.id,amountCents:proof.amountCents,currency:proof.currency,validUntil:proof.expirationTime,status:'AUTHORIZED',now:now()});
   }
  }else if(!state.authorization){record.state=d.markOrderCreated(state,{orderId:order.id,approveUrl:order.approvalUrl,status:order.status,now:now()});}
  else if(!terminal(state)){
   const proof=await pay.getAuthorization(state.authorization.authorizationId);record.providerReadback=proof;
   if(['VOIDED','EXPIRED'].includes(proof.status)){
    if(order.captures.length)throw error('UNEXPECTED_CAPTURE','This order includes a capture outside the recorded workflow. Review it before starting another order.');
    record.state=d.confirmClosedAuthorization(state,{authorizationId:proof.id,amountCents:proof.amountCents,currency:proof.currency,status:proof.status,now:now()});
   }
  }
  await save();if(record.state.authorization)await providerIndex(record.state.authorization.authorizationId,record.state.id);
 }
 async function mutation(path,input,record,pay,save){
  let operationId=null;
  try{
   if(path==='/api/order/create'){
    if(record.state.order?.orderId)return;
    const op=record.state.order||{operationId:randomUUID(),idempotencyKey:randomUUID()};
    if(op.preparedAt&&Date.now()-Date.parse(op.preparedAt)>300000)throw error('RETRY_WINDOW_EXPIRED','Do not create another order blindly. Review the unresolved Sandbox operation first.');
    record.state=d.beginOrder(record.state,{...op,now:now()});operationId=op.operationId;await save();
    const s=record.state;const created=await pay.createOrder({requestId:op.idempotencyKey,amountCents:s.original.totalAmountCents,currency:'USD',sku:s.original.sku,name:s.original.name,quantity:s.quantity,returnUrl:origin+'/?paypal=returned',cancelUrl:origin+'/?paypal=cancelled'});
    if(created.amountCents!==s.original.totalAmountCents||created.currency!=='USD')throw error('ORDER_PROOF_MISMATCH','PayPal order total differs from the original catalog order.');
    record.state=d.markOrderCreated(s,{orderId:created.id,approveUrl:created.approvalUrl,status:created.status,now:now()});record.providerReadback=created;await save();await providerIndex(created.id,s.id);return;
   }
   if(path==='/api/order/authorize'){
    if(record.state.authorization)return;
    if(record.state.order?.authorizationOperation){await reconcile(record,pay,save);return;}
    if(!record.state.order?.orderId)throw error('NO_ORDER','Create checkout first.');
    let order=await pay.getOrder(record.state.order.orderId);
    if(pay.execution==='mock_paypal'&&order.status==='CREATED')order=await pay.approveOrder(order.id);
    if(order.status!=='APPROVED')throw error('BUYER_APPROVAL_REQUIRED','Complete buyer approval in PayPal Sandbox first.');
    record.state=d.markOrderCreated(record.state,{orderId:order.id,status:order.status,approveUrl:order.approvalUrl,now:now()});
    const op={operationId:randomUUID(),idempotencyKey:randomUUID(),now:now()};record.state=d.beginAuthorize(record.state,op);operationId=op.operationId;await save();
    await pay.authorizeOrder(order.id,{requestId:op.idempotencyKey});await save();await reconcile(record,pay,save);return;
   }
   if(path==='/api/stock/change'){record.state=d.changeInventory(record.state,{sku:input.sku,stock:input.stock,unitAmountCents:input.unitAmountCents,now:now()});record.aiProposal=null;}
   else if(path==='/api/proposal'){
    if(record.state.operation||terminal(record.state))throw error('PAYMENT_IN_PROGRESS','Finish reconciliation before requesting another proposal.');
    if(!record.state.authorization)throw error('NOT_AUTHORISED','Authorize the order first.');
    if(record.state.inventory.find(x=>x.sku===record.state.original.sku).stock>=record.state.quantity)throw error('NO_STOCK_EXCEPTION','Mark the original item unavailable first.');
    const eligible=d.eligibleReplacements(record.state,{now:now()});
    if(ai.mode==='live')await queue('ai_allowance',async()=>{const row=await store.read('ai_calls');const used=row?.value.count||0;if(used>=maxAiCalls)throw error('AI_LIMIT','Approved inference request limit reached.',429);await store.write('ai_calls',{count:used+1,updatedAt:now()},row?.version||'0');});
    // Invalidate earlier consent before a changed preference is sent to a model.
    record.state={...record.state,consent:null,proposal:null,status:'stock_exception'};record.aiProposal=null;await save();
    const proposal=await ai.propose({preferences:input.preferences,original:record.state.original,eligible});record.aiProposal=proposal;
    if(proposal.kind==='proposal')record.state=d.proposeReplacement(record.state,{sku:proposal.sku,reason:proposal.reason,source:proposal.execution==='local_test_double'?'manual':'model',now:now()});
   }else if(path==='/api/consent'){record.state=d.acceptReplacement(record.state,{...input,now:now()});}
   else if(path==='/api/capture'||path==='/api/void'){
    if(terminal(record.state))return;
    if(record.state.operation){await reconcile(record,pay,save);return;}
    const op={operationId:randomUUID(),idempotencyKey:randomUUID(),now:now()};
    // Gate intent locally before calling any payment provider.
    const prepared=path.endsWith('capture')?d.prepareCapture(record.state,op):d.prepareVoid(record.state,op);
    const auth=await pay.getAuthorization(record.state.authorization.authorizationId);record.providerReadback=auth;
    if(auth.id!==record.state.authorization.authorizationId||auth.status!=='CREATED'||auth.currency!=='USD'||auth.amountCents!==record.state.authorization.amountCents)throw error('AUTHORIZATION_CHANGED','Provider authorization is no longer in the expected state; review before settlement.');
    record.state=prepared;operationId=op.operationId;await save();
    if(path.endsWith('capture')){const proof=await pay.captureAuthorization(auth.id,{requestId:op.idempotencyKey,amountCents:record.state.operation.amountCents,currency:'USD'});record.pendingCaptureId=proof.id;await save();}
    else {await pay.voidAuthorization(auth.id,{requestId:op.idempotencyKey});await save();}
    await reconcile(record,pay,save);return;
   }else if(path==='/api/reconcile'){await reconcile(record,pay,save);return;}
   else throw error('NOT_FOUND','Unknown action',404);
   await save();
  }catch(e){if(operationId){try{record.state=d.markUncertain(record.state,{operationId,reason:'Provider action is unresolved. Read back before retrying.',now:now()});await save();}catch{}}
   throw e;
  }
 }
 const server=http.createServer(async(req,res)=>{
  let identity=cookieIdentity(req);let record=null;
  const operatorRequired=ai.mode==='live'&&!access.allowed(req);
  try{
   const url=new URL(req.url,origin),path=url.pathname;
   if(req.method==='GET'&&path==='/health'){send(res,200,{ok:true,app:'StockSwap',mode:paypal?'sandbox':'mock'});return;}
   if(req.method==='GET'&&files.has(path)){const [file,type]=files.get(path);res.writeHead(200,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(await readFile(new URL('../public/'+file,import.meta.url)));return;}
   if(path==='/api/webhook'&&req.method==='POST'){
    if(!paypal)throw error('WEBHOOK_UNCONFIGURED','Local test mode does not verify PayPal webhooks.',503);
    const event=await body(req);const result=await paypal.verifyWebhook({headers:req.headers,event});if(!result.verified)throw error('WEBHOOK_UNVERIFIED','Webhook signature was not verified.',401);
    const key='webhook_'+hash(String(event.id));await queue(key,async()=>{
     if(await store.read(key)){send(res,200,{accepted:true,duplicate:true});return;}
     const ids=[event.resource?.id,event.resource?.supplementary_data?.related_ids?.authorization_id,event.resource?.supplementary_data?.related_ids?.order_id].filter(x=>typeof x==='string');
     let link=null;for(const id of ids){link=await store.read('provider_'+hash(id));if(link)break;}
     if(link)await queue(link.value.sessionId,async()=>{const row=await store.read(link.value.sessionId);if(!row)return;const r=row.value;let version=row.version;const save=async()=>{version=await store.write(r.state.id,r,version);};await reconcile(r,paypal,save);});
     await store.write(key,{eventId:event.id,eventType:event.event_type,processedAt:now(),matched:!!link});send(res,200,{accepted:true,matched:!!link});
    });return;
   }
   if(req.method==='GET'&&(path==='/api/session'||path==='/api/export')){const row=await load(identity);record=row?.value;if(path==='/api/export'){if(!record)throw error('NO_SESSION','Start a session first.',401);send(res,200,{...view(record,operatorRequired),exportedAt:now()},{'Content-Disposition':'attachment; filename="stockswap-record.json"'});}else send(res,200,view(record,operatorRequired));return;}
   if(req.method!=='POST'||!path.startsWith('/api/'))throw error('NOT_FOUND','Not found',404);
   if(req.headers.origin!==origin||!String(req.headers['content-type']||'').startsWith('application/json'))throw error('ORIGIN_REQUIRED','Use the same-origin application to perform this action.',403);
   const input=await body(req);
   const rateKey=identity?.id||req.socket.remoteAddress||'local';const minute=Math.floor(Date.now()/60000);if(rate.size>2000)rate.clear();const prior=rate.get(rateKey);const count=prior?.minute===minute?prior.count+1:1;rate.set(rateKey,{minute,count});if(count>40)throw error('RATE_LIMIT','Too many actions. Wait a minute before retrying.',429);
   if(path==='/api/operator/login'){
    record=(await load(identity))?.value;
    const cookie=access.unlock(input.accessCode);if(!cookie)throw error('OPERATOR_REQUIRED','The operator access code was not accepted.',401);
    send(res,200,view(record,false),{'Set-Cookie':cookie});return;
   }
   await queue(identity?.id||rateKey,async()=>{
    let row;
    try{row=await load(identity);}catch(e){if(path!=='/api/session/new'||e.code!=='SESSION_NOT_FOUND')throw e;}
    record=row?.value;
    if(path==='/api/session/new'){
     if(record?.state.order&&!terminal(record.state))throw error('UNSETTLED_ORDER','Finish or reconcile the existing order before starting another session.');
     const id=randomUUID(),secret=randomBytes(32).toString('hex');record={state:d.createSession({id,originalSku:input.originalSku,quantity:input.quantity??1,now:now()}),authHash:hash(secret),createdAt:now(),providerReadback:null,aiProposal:null};
     await store.write(id,record);send(res,201,view(record,operatorRequired),{'Set-Cookie':`stockswap=${id}.${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${site.protocol==='https:'?'; Secure':''}`});return;
    }
    if(!record)throw error('NO_SESSION','Start an order first.',401);
    if(path==='/api/proposal'&&operatorRequired)throw error('OPERATOR_REQUIRED','Unlock live AI suggestions with the private operator code first.',401);
    const pay=getPay(record);let version=row.version;const save=async()=>{if(pay.execution==='mock_paypal')record.mockProvider=pay.exportState();version=await store.write(record.state.id,record,version);};
    await mutation(path,input,record,pay,save);send(res,200,view(record,operatorRequired));
   });
  }catch(e){const status=Number.isInteger(e.httpStatus)?e.httpStatus:502;send(res,status,{...view(record,operatorRequired),error:{code:e.code||'REQUEST_FAILED',message:e.code?e.message:'The operation could not be completed. Stored payment outcomes require read-back before retrying.'}});}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const env=process.env;const mode=env.STOCKSWAP_PAYPAL_MODE||'mock';if(!['mock','sandbox'].includes(mode))throw Error('Only mock or PayPal Sandbox is allowed');
 if(env.PAYPAL_ENV&&env.PAYPAL_ENV!=='sandbox')throw Error('Production payments are forbidden');
 const store=env.STOCKSWAP_STORE==='gcs'?new GcsStore({bucket:env.STOCKSWAP_BUCKET,project:env.GCP_PROJECT_ID}):new SqliteStore(env.STOCKSWAP_SQLITE_PATH||'.local/stockswap.sqlite');
 const paypal=mode==='sandbox'?new SandboxPayPal({clientId:env.STOCKSWAP_PAYPAL_CLIENT_ID,clientSecret:env.STOCKSWAP_PAYPAL_CLIENT_SECRET,webhookId:env.STOCKSWAP_PAYPAL_WEBHOOK_ID}):null;
 const ai=new ProposalAI({mode:env.STOCKSWAP_AI_MODE||'mock',baseUrl:env.STOCKSWAP_AI_BASE_URL,apiKey:env.STOCKSWAP_AI_API_KEY,model:env.STOCKSWAP_AI_MODEL,approvalReference:env.STOCKSWAP_AI_APPROVAL,expiresAt:env.STOCKSWAP_AI_EXPIRES_AT});
 const port=Number(env.PORT||8802),origin=env.STOCKSWAP_ORIGIN||`http://127.0.0.1:${port}`;
 if(env.K_SERVICE&&(mode!=='sandbox'||env.STOCKSWAP_STORE!=='gcs'||!env.STOCKSWAP_ORIGIN?.startsWith('https://')))throw Error('Cloud deployment requires Sandbox mode, isolated GCS persistence and explicit HTTPS origin');
 const app=createApp({store,paypal,ai,origin,maxAiCalls:Number(env.STOCKSWAP_AI_MAX_CALLS||0),operatorCode:env.STOCKSWAP_OPERATOR_CODE,requireOperatorCode:Boolean(env.K_SERVICE)});app.listen(port,env.K_SERVICE?'0.0.0.0':'127.0.0.1',()=>console.log(`StockSwap ${mode} at ${origin}`));
}
