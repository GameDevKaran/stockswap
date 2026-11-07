import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxPayPal, MockPayPal, centsToMoney, moneyToCents, PAYPAL_SANDBOX_BASE } from '../src/paypal.mjs';

const secret = 'private-test-secret-NOT-REAL';
const token = 'private-test-token-NOT-REAL';
const orderInput = { requestId: 'create-001', amountCents: 2499, currency: 'USD', sku: 'CASE-01', name: 'Fictional case',
  description: 'Owned test catalog accessory', quantity: 1, returnUrl: 'https://stockswap.example/return', cancelUrl: 'https://stockswap.example/cancel' };
const payment = (status = 'CREATED', paymentId = 'AUTH1', amount = '24.99') => ({ id: paymentId, status,
  amount: { currency_code: 'USD', value: amount }, expiration_time: '2026-12-01T00:00:00Z' });
const order = () => ({ id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', intent: 'AUTHORIZE',
  purchase_units: [{ amount: { currency_code: 'USD', value: '24.99' } }],
  links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] });
const response = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
function setup(replies, options = {}) {
  const calls = [];
  const api = new SandboxPayPal({ clientId: 'test-client', clientSecret: secret, webhookId: 'WHCONFIG1', ...options,
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      if (url.endsWith('/v1/oauth2/token')) return response({ access_token: token, expires_in: 3600 });
      const next = replies.shift();
      if (!next) throw Error(`Unexpected test request ${url}`);
      return typeof next === 'function' ? next(url, request) : next;
    } });
  return { api, calls };
}

test('OAuth and AUTHORIZE creation use exact Sandbox origin, trusted redirects and cent-exact catalog totals', async () => {
  const { api, calls } = setup([response(order())]);
  const result = await api.createOrder(orderInput);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`);
  assert.equal(calls[0].request.body, 'grant_type=client_credentials');
  assert.equal(calls[0].request.headers.Authorization, `Basic ${Buffer.from(`test-client:${secret}`).toString('base64')}`);
  const request = calls[1].request; const body = JSON.parse(request.body);
  assert.equal(body.intent, 'AUTHORIZE');
  assert.equal(body.purchase_units[0].amount.value, '24.99');
  assert.equal(body.purchase_units[0].items[0].unit_amount.value, '24.99');
  assert.equal(body.purchase_units[0].items[0].quantity, '1');
  assert.equal(body.payment_source.paypal.experience_context.return_url, orderInput.returnUrl);
  assert.equal(request.headers['PayPal-Request-Id'], 'create-001');
  assert.equal(request.redirect, 'error');
  assert.equal(result.amountCents, 2499); assert.equal(result.execution, 'paypal_sandbox_http');
  assert.match(result.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  assert.ok(!JSON.stringify(api).includes(secret));
});

test('authorization, final capture and capture lookup retain stable IDs and exact provider status', async () => {
  const authorized = order(); authorized.status = 'COMPLETED';
  authorized.purchase_units[0].payments = { authorizations: [payment()] };
  const { api, calls } = setup([response(authorized), response(payment('COMPLETED', 'CAP1', '20.00')), response(payment('COMPLETED', 'CAP1', '20.00'))]);
  const auth = await api.authorizeOrder('ORDER1', { requestId: 'auth-001' });
  assert.equal(auth.authorizations[0].id, 'AUTH1');
  const captured = await api.captureAuthorization('AUTH1', { requestId: 'capture-001', amountCents: 2000, currency: 'USD' });
  assert.equal(captured.status, 'COMPLETED'); assert.equal(captured.amountCents, 2000);
  const captureRequest = calls[2].request;
  assert.deepEqual(JSON.parse(captureRequest.body), { amount: { currency_code: 'USD', value: '20.00' }, final_capture: true });
  assert.equal(captureRequest.headers['PayPal-Request-Id'], 'capture-001');
  assert.equal((await api.getCapture('CAP1')).id, 'CAP1');
  assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 1);
});

test('void is followed by authoritative GET rather than assuming a 204 means a terminal state', async () => {
  const { api, calls } = setup([response(null, 204), response(payment('VOIDED'))]);
  const result = await api.voidAuthorization('AUTH1', { requestId: 'void-001' });
  assert.equal(result.status, 'VOIDED'); assert.equal(result.authoritativeReadback, true);
  assert.equal(calls[1].request.method, 'POST'); assert.equal(calls[2].request.method, 'GET');
  assert.equal(calls[2].url, `${PAYPAL_SANDBOX_BASE}/v2/payments/authorizations/AUTH1`);
});

test('money conversion rejects floating, negative, unsupported currency and imprecise decimals', () => {
  assert.equal(centsToMoney(1), '0.01'); assert.equal(moneyToCents('19.99'), 1999);
  for (const value of [-1, 1.2, NaN, Infinity, 1_000_001]) assert.throws(() => centsToMoney(value));
  for (const value of ['1.1', '1.999', '-1.00', '01.00', '1e2', 1.00]) assert.throws(() => moneyToCents(value));
  assert.throws(() => moneyToCents('1.00', 'EUR'), /USD/);
});

test('production base, malicious approval URL and invalid request inputs are refused', async () => {
  assert.throws(() => new SandboxPayPal({ clientId: 'x', clientSecret: 'y', apiBase: 'https://api-m.paypal.com' }), /Sandbox/);
  const malicious = order(); malicious.links[0].href = 'https://www.paypal.com/checkoutnow?token=ORDER1';
  const { api, calls } = setup([response(malicious)]);
  await assert.rejects(api.createOrder({ ...orderInput, currency: 'EUR' }), /USD/);
  await assert.rejects(api.createOrder({ ...orderInput, quantity: 2 }), /whole-cent/);
  await assert.rejects(api.createOrder({ ...orderInput, returnUrl: 'javascript:alert(1)' }), /Callback/);
  await assert.rejects(api.captureAuthorization('../real', { requestId: 'c', amountCents: 1 }), /resource/);
  await assert.rejects(api.authorizeOrder('ORDER1', {}), /stable request/);
  assert.equal(calls.length, 0);
  await assert.rejects(api.createOrder(orderInput), /unsupported response/);
});

test('HTTP, malformed responses and transport errors never expose bodies, credentials or tokens', async () => {
  const { api } = setup([response({ error: secret, token }, 401)]);
  await assert.rejects(api.getOrder('ORDER1'), error => {
    assert.equal(error.code, 'PAYPAL_HTTP'); assert.equal(error.status, 401);
    assert.ok(!String(error).includes(secret)); assert.ok(!JSON.stringify(error).includes(token)); return true;
  });
  const failing = new SandboxPayPal({ clientId: 'test-client', clientSecret: secret,
    fetchImpl: async () => { throw Error(secret); } });
  await assert.rejects(failing.getOrder('ORDER1'), error => !String(error).includes(secret) && error.code === 'PAYPAL_TRANSPORT');
  const malformed = setup([new Response(secret)]).api;
  await assert.rejects(malformed.getOrder('ORDER1'), error => error.code === 'PAYPAL_PROTOCOL' && !String(error).includes(secret));
});

test('timeout and both declared and streamed response-size bounds fail safely', async () => {
  const hanging = new SandboxPayPal({ clientId: 'test-client', clientSecret: secret, timeoutMs: 15,
    fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(hanging.getOrder('ORDER1'), error => error.code === 'PAYPAL_TIMEOUT');
  const declared = setup([response({}, 200, { 'content-length': String(129 * 1024) })]).api;
  await assert.rejects(declared.getOrder('ORDER1'), error => error.code === 'PAYPAL_RESPONSE_LIMIT');
  const streamed = setup([new Response('x'.repeat(129 * 1024))]).api;
  await assert.rejects(streamed.getOrder('ORDER1'), error => error.code === 'PAYPAL_RESPONSE_LIMIT');
});

test('webhooks verify through PayPal with exact signed headers, event and configured webhook ID', async () => {
  const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'transmission-1', 'paypal-transmission-time': '2026-11-07T10:00:00Z', 'paypal-transmission-sig': 'YWJjZA==' };
  const event = { id: 'WH-EVENT1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP1' } };
  const { api, calls } = setup([response({ verification_status: 'SUCCESS' }), response({ verification_status: 'FAILURE' })]);
  const passed = await api.verifyWebhook({ headers, event });
  assert.equal(passed.verified, true);
  const posted = JSON.parse(calls[1].request.body);
  assert.equal(posted.webhook_id, 'WHCONFIG1'); assert.deepEqual(posted.webhook_event, event);
  assert.equal(posted.transmission_sig, headers['paypal-transmission-sig']);
  assert.equal((await api.verifyWebhook({ headers: {}, event })).verified, false);
  assert.equal((await api.verifyWebhook({ headers: { ...headers, 'paypal-cert-url': 'https://evil.example/cert' }, event })).verified, false);
  assert.equal((await api.verifyWebhook({ headers, event })).verified, false);
  assert.equal(calls.length, 3);
});

test('MockPayPal labels every result and requires explicit simulated approval before authorization', async () => {
  const mock = new MockPayPal();
  const created = await mock.createOrder(orderInput);
  assert.equal(created.execution, 'mock_paypal'); assert.equal(created.approvalUrl, null);
  await assert.rejects(mock.authorizeOrder(created.id, { requestId: 'auth-001' }), /approval/);
  await mock.approveOrder(created.id);
  const authorized = await mock.authorizeOrder(created.id, { requestId: 'auth-001' });
  const authId = authorized.authorizations[0].id;
  const first = await mock.captureAuthorization(authId, { requestId: 'capture-001', amountCents: 2000 });
  const retry = await mock.captureAuthorization(authId, { requestId: 'capture-001', amountCents: 2000 });
  assert.equal(first.id, retry.id); assert.equal(first.execution, 'mock_paypal');
  await assert.rejects(mock.captureAuthorization(authId, { requestId: 'capture-001', amountCents: 2100 }), /different payload/);
  await assert.rejects(mock.captureAuthorization(authId, { requestId: 'capture-002', amountCents: 2000 }), /not capturable/);
  await assert.rejects(mock.voidAuthorization(authId, { requestId: 'void-001' }), /current state/);
  assert.equal((await mock.verifyWebhook({})).verified, false);
});

test('separate mock cancellation fixture closes authorization without inventing provider evidence', async () => {
  const mock = new MockPayPal(); const created = await mock.createOrder(orderInput);
  await mock.approveOrder(created.id);
  const auth = await mock.authorizeOrder(created.id, { requestId: 'auth-001' });
  const authorizationId = auth.authorizations[0].id;
  await assert.rejects(mock.captureAuthorization(authorizationId, { requestId: 'capture-001', amountCents: 2500 }), /exceeds/);
  const voided = await mock.voidAuthorization(authorizationId, { requestId: 'void-001' });
  assert.equal(voided.status, 'VOIDED'); assert.equal(voided.authoritativeReadback, false);
  assert.equal((await mock.getAuthorization(authorizationId)).status, 'VOIDED');
});
