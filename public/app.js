const $=id=>document.getElementById(id);
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((cents||0)/100);
let data={session:null,catalog:[],eligible:[],integration:{}},selected='HBR-C1',busy=false,proposalKey='';
const terminal=s=>['captured','voided','expired'].includes(s?.status);
function el(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function note(text,bad=false){$('notice').hidden=false;$('notice').textContent=text;$('notice').className='notice'+(bad?' warning':'');}
function visible(id,yes){$(id).hidden=!yes;}
function row(key,value){const r=el('div');r.append(el('dt',key),el('dd',value??'—'));return r;}
function safeApproval(url){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['sandbox.paypal.com','www.sandbox.paypal.com'].includes(u.hostname)?u.href:null;}catch{return null;}}
function controls(){
 const s=data.session,done=terminal(s),pending=!!s?.operation&&!done,auth=!!s?.authorization;
 const original=s?.inventory.find(i=>i.sku===s.original.sku),exception=auth&&original?.stock<s.quantity;
 $('catalog-fieldset').disabled=busy||!!s?.order&&!done;$('quantity').disabled=busy||!!s?.order&&!done;
 $('start-order').disabled=busy||!!s?.order&&!done;
 $('create-order').disabled=busy||!!s?.order?.orderId;
 $('authorize-order').disabled=busy||auth||!!s?.order?.authorizationOperation;
 $('mark-out').disabled=busy||done||pending||original?.stock===0;
 $('update-stock').disabled=busy||done||pending;
 $('request-proposal').disabled=busy||done||pending||!exception||data.integration.operatorRequired;
 $('operator-code').disabled=busy;$('operator-login').disabled=busy;
 $('buyer-consent').disabled=busy||done||pending||!!s?.consent;
 $('accept-proposal').disabled=busy||done||pending||!s?.proposal||!!s?.consent||!$('buyer-consent').checked;
 $('capture').disabled=busy||done||pending||!s?.consent;
 $('void').disabled=busy||done||pending||!auth;
 $('reconcile').disabled=busy||!s?.order?.orderId;
 $('refresh').disabled=busy;
}
function render(){
 const s=data.session,done=terminal(s),mock=data.integration.paypal==='mock_paypal';
 visible('operator-gate',!!data.integration.operatorRequired);
 $('paypal-mode').textContent=mock?'LOCAL PAYMENT TEST DOUBLE':'PAYPAL SANDBOX · NO REAL MONEY';
 $('ai-mode').textContent=data.integration.ai==='local_test_double'?'LOCAL SUGGESTION TEST DOUBLE':'AI PROVIDER CONFIGURED';
 $('verification-mode').textContent=mock?'Simulated provider outcomes':data.integration.liveVerified?'Live checks recorded':'Live verification pending';
 $('catalog').replaceChildren();
 for(const p of data.catalog){const label=el('label',undefined,'product-option');const radio=document.createElement('input');radio.type='radio';radio.name='originalSku';radio.value=p.sku;radio.checked=p.sku===selected;radio.disabled=p.stock<1;
  radio.addEventListener('change',()=>{selected=p.sku;total();});const top=el('span',undefined,'product-top');top.append(radio,el('span',p.kind,'product-kind'),el('span',money(p.unitAmountCents),'product-price'));
  label.append(top,el('strong',p.name),el('span',p.sku+' · '+p.connector,'product-spec'),el('span',p.stock?`${p.stock} in stock`:'Out of stock','product-stock'));$('catalog').append(label);}
 total();$('order-status').textContent=s?s.status.replaceAll('_',' '):'No order';
 visible('new-order-form',!s?.order||done);
 visible('order-summary',!!s);$('order-summary').replaceChildren();if(s){$('order-summary').append(el('strong',s.original.name),el('p',`${s.quantity} × ${money(s.original.unitAmountCents)} · ${money(s.original.totalAmountCents)} authorized maximum`));}
 visible('checkout-actions',!!s&&!s.authorization&&!done);
 const approval=safeApproval(data.approvalUrl||s?.order?.approveUrl);visible('paypal-approval',!mock&&!!approval);$('paypal-approval').href=approval||'#';
 visible('authorize-order',!!s?.order?.orderId&&!s.authorization);visible('approval-note',!mock&&!!s?.order?.orderId&&!s.authorization);
 $('authorize-order').textContent=mock?'Simulate buyer approval & authorization':'Read approval & authorize';
 $('create-order').textContent=mock?'Create local test checkout':'Create Sandbox checkout';
 $('checkout-help').textContent=mock?'Local fixture mode: no request or payment reaches PayPal. Use the explicit simulated approval step to exercise the flow.':'Create a Sandbox order, approve it using a Sandbox buyer, then read back the authorization here.';
 visible('inventory-empty',!s?.authorization);visible('inventory-controls',!!s?.authorization);
 if(s){$('original-stock-name').textContent=s.original.name;const original=s.inventory.find(x=>x.sku===s.original.sku);$('original-stock').textContent=`${original.stock} units available · inventory revision ${s.inventoryRevision}`;
 const previous=$('stock-sku').value;$('stock-sku').replaceChildren(...s.inventory.map(x=>{const option=el('option',x.name);option.value=x.sku;return option;}));if(s.inventory.some(x=>x.sku===previous))$('stock-sku').value=previous;}
 $('eligibility-list').replaceChildren();for(const p of data.eligible||[]){const r=el('div',undefined,'eligibility-item');r.append(el('strong',p.name),el('span',`${money(p.amountCents)} · ${p.stock} in stock`),el('p',p.eligible?'Eligible: catalog compatibility and authorized amount match.':p.reasons.join(' ')));$('eligibility-list').append(r);}
 $('candidate-count').textContent=String((data.eligible||[]).filter(x=>x.eligible).length);
 visible('ai-response',!!data.aiProposal);if(data.aiProposal)$('ai-response').textContent=(data.aiProposal.execution==='local_test_double'?'Test double · ':'AI · ')+(data.aiProposal.question||data.aiProposal.reason);
 const p=s?.proposal;visible('buyer-empty',!p&&!done);visible('buyer-proposal',!!p&&!done);visible('buyer-terminal',done);
 const key=p?JSON.stringify([p.sku,p.proposalVersion,p.inventoryRevision]):'';if(key!==proposalKey){$('buyer-consent').checked=false;proposalKey=key;}
 if(p){$('proposal-name').textContent=p.name;$('proposal-sku').textContent=`${p.sku} · quantity ${p.quantity}`;$('original-amount').textContent=money(s.authorization.amountCents);$('proposal-amount').textContent=money(p.amountCents);
 $('price-saving').textContent=`${money(s.authorization.amountCents-p.amountCents)} less than the original authorization`;$('proposal-reason').textContent=p.reason;
 const item=s.inventory.find(x=>x.sku===p.sku);$('proposal-attributes').replaceChildren(...Object.entries(item?.attributes||{}).map(([k,v])=>el('span',`${k}: ${v}`)));
 $('proposal-evidence').textContent=`Exact terms · ${p.currency} · authorization ${p.authorizationId} · inventory v${p.inventoryRevision} · proposal v${p.proposalVersion}`;
 $('consent-label').textContent=`I accept ${p.quantity} × ${p.name} (${p.sku}) for exactly ${money(p.amountCents)} ${p.currency}.`;
 visible('consent-box',!s.consent);visible('consent-recorded',!!s.consent);$('consent-detail').textContent=s.consent?`${money(s.consent.amountCents)} accepted at ${s.consent.acceptedAt}. Capture remains a separate action.`:'';}
 if(done)$('buyer-terminal').textContent=s.status==='captured'?`${mock?'Test-double':'Sandbox'} capture confirmed: ${money(s.receipt.amountCents)} for ${s.receipt.quantity} × ${s.receipt.sku}. ${s.receipt.captureId}.`:`${mock?'Test-double':'Sandbox'} authorization ${s.status}. No capture was recorded in this workflow. You can start a fresh buyer-approved order.`;
 $('ledger').replaceChildren();if(s){$('ledger').append(row('Session',s.id),row('Order',s.order?.orderId),row('Authorization',s.authorization?.authorizationId),row('Status',s.status),row('Authorization expires',s.authorization?.validUntil),row('Payment operation',s.operation?.status),row('Latest event',s.audit.at(-1)?.type));}else $('ledger').append(row('Session','Not started'));
 visible('readback-details',!!data.providerReadback);$('readback-json').textContent=data.providerReadback?JSON.stringify(data.providerReadback,null,2):'';visible('provider-proof',!!data.providerReadback);
 $('provider-proof').textContent=data.providerReadback?`${data.providerReadback.execution==='mock_paypal'?'Local fixture read-back':'PayPal Sandbox read-back'}: ${data.providerReadback.status}.`:'';visible('export',!!s);
 const uncertain=s?.status.includes('uncertain')||s?.status.includes('pending');visible('uncertainty',!!uncertain);$('uncertainty').textContent='An operation is pending or uncertain. Do not create a second payment. Read provider state; an unresolved result is not a successful capture.';
 for(const [id,yes] of [['step-order',!!s?.authorization],['step-proposal',!!p],['step-consent',!!s?.consent],['step-settle',done]])$(id).classList.toggle('complete',yes);
 controls();
}
function total(){const p=data.catalog.find(x=>x.sku===selected);$('selection-total').textContent=p?money(p.unitAmountCents*Number($('quantity').value||1)):'—';}
async function request(path,payload){if(busy)return;busy=true;controls();try{const response=await fetch(path,{method:payload===undefined?'GET':'POST',headers:payload===undefined?{}:{'Content-Type':'application/json'},body:payload===undefined?undefined:JSON.stringify(payload),credentials:'same-origin'});const result=await response.json();if(result.catalog)data=result;render();if(!response.ok)throw Error(result.error?.message||'The request was not completed.');note(path==='/api/session'?'Latest stored state loaded.':'Action recorded. Check the current state and receipt trail.');return result;}catch(e){note(e.message||'Connection failed. Read stored state before retrying.',true);}finally{busy=false;controls();}}
$('new-order-form').addEventListener('submit',e=>{e.preventDefault();request('/api/session/new',{originalSku:selected,quantity:Number($('quantity').value)});});
$('quantity').max='3';$('preferences').maxLength=800;$('quantity').addEventListener('input',total);
for(const [id,path] of [['refresh','/api/session'],['create-order','/api/order/create'],['authorize-order','/api/order/authorize'],['capture','/api/capture'],['void','/api/void'],['reconcile','/api/reconcile']])$(id).addEventListener('click',()=>request(path,id==='refresh'?undefined:{}));
$('mark-out').addEventListener('click',()=>request('/api/stock/change',{sku:data.session.original.sku,stock:0}));
$('stock-form').addEventListener('submit',e=>{e.preventDefault();request('/api/stock/change',{sku:$('stock-sku').value,stock:Number($('stock-count').value)});});
$('proposal-form').addEventListener('submit',e=>{e.preventDefault();request('/api/proposal',{preferences:$('preferences').value});});
$('operator-login-form').addEventListener('submit',async e=>{e.preventDefault();const accessCode=$('operator-code').value;$('operator-code').value='';const result=await request('/api/operator/login',{accessCode});if(result)note('Live AI suggestions unlocked for one hour. The approved request limit still applies.');});
$('buyer-consent').addEventListener('change',controls);
$('accept-proposal').addEventListener('click',()=>{if(!$('buyer-consent').checked||!data.session?.proposal)return;const p=data.session.proposal;request('/api/consent',Object.fromEntries(['sku','quantity','amountCents','currency','authorizationId','inventoryRevision','proposalVersion'].map(k=>[k,p[k]])));});
request('/api/session');
