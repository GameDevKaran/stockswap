import { createHash, randomBytes } from 'node:crypto';

export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const RESPONSE_LIMIT = 128 * 1024;
const MONEY_LIMIT = 1_000_000;
const clone = value => structuredClone(value);

export class PayPalError extends Error {
  constructor(message, code = 'PAYPAL_VALIDATION', status = null) {
    super(message); this.name = 'PayPalError'; this.code = code; this.status = status;
  }
}
const invalid = message => { throw new PayPalError(message); };
const protocol = () => { throw new PayPalError('PayPal returned an unsupported response.', 'PAYPAL_PROTOCOL'); };
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value)) invalid('Invalid payment resource ID.');
  return value;
};
const requestId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,38}$/.test(value)) invalid('A stable request ID of 1–38 safe characters is required.');
  return value;
};
function checkedText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(`Invalid ${label}.`);
  return value;
}
function currency(value) { if (value !== 'USD') invalid('Only USD is supported by StockSwap.'); return value; }
export function centsToMoney(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MONEY_LIMIT) invalid('Amount must be whole cents within the supported range.');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
export function moneyToCents(value, code = 'USD') {
  currency(code);
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})\.\d{2}$/.test(value)) invalid('Provider amount must use an exact USD decimal.');
  const [whole, fraction] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction);
  centsToMoney(cents);
  return cents;
}
function positiveAmount(cents, code = 'USD') {
  currency(code); const value = centsToMoney(cents);
  if (cents < 1) invalid('Payment amount must be positive.');
  return { currency_code: code, value };
}
function callbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { invalid('Invalid configured callback URL.'); }
  if (url.username || url.password || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    invalid('Callback URLs require HTTPS or a local development origin.');
  }
  if (value.length > 2048) invalid('Configured callback URL is too long.');
  return url.href;
}
function approvalUrl(links) {
  const link = Array.isArray(links) && links.find(item => ['approve', 'payer-action'].includes(item?.rel));
  if (!link) return null;
  let url;
  try { url = new URL(link.href); } catch { protocol(); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname)) protocol();
  return url.href;
}
function orderBody(input) {
  if (!input || typeof input !== 'object') invalid('Order input is required.');
  requestId(input.requestId);
  const amount = positiveAmount(input.amountCents, input.currency ?? 'USD');
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99 || input.amountCents % quantity !== 0) {
    invalid('Quantity must be 1–99 with an exact whole-cent unit price.');
  }
  const name = checkedText(input.name, 127, 'catalog name');
  const sku = checkedText(input.sku, 127, 'catalog SKU');
  const description = checkedText(input.description ?? name, 127, 'catalog description');
  const returnUrl = callbackUrl(input.returnUrl);
  const cancelUrl = callbackUrl(input.cancelUrl);
  if (new URL(returnUrl).origin !== new URL(cancelUrl).origin) invalid('Callback URLs must use the same configured app origin.');
  return {
    intent: 'AUTHORIZE',
    purchase_units: [{ reference_id: 'default', description,
      amount: { ...amount, breakdown: { item_total: amount } },
      items: [{ name, sku, description, quantity: String(quantity), category: 'PHYSICAL_GOODS',
        unit_amount: { currency_code: amount.currency_code, value: centsToMoney(input.amountCents / quantity) } }] }],
    payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl,
      user_action: 'PAY_NOW', shipping_preference: 'GET_FROM_FILE' } } }
  };
}
function normalizedAmount(amount) {
  if (!amount) return { amountCents: null, currency: null };
  return { amountCents: moneyToCents(amount.value, amount.currency_code), currency: amount.currency_code };
}
function normalizedPayment(data, execution) {
  if (!data || typeof data !== 'object' || typeof data.status !== 'string' || !/^[A-Z_]{1,40}$/.test(data.status)) protocol();
  return { id: id(data.id), status: data.status, ...normalizedAmount(data.amount),
    expirationTime: typeof data.expiration_time === 'string' ? data.expiration_time : null,
    finalCapture: typeof data.final_capture === 'boolean' ? data.final_capture : null,
    authorizationId: data.supplementary_data?.related_ids?.authorization_id ? id(data.supplementary_data.related_ids.authorization_id) : null,
    execution, environment: 'sandbox' };
}
function normalizedOrder(data, execution) {
  if (!data || typeof data.status !== 'string' || !/^[A-Z_]{1,40}$/.test(data.status) ||
      (data.intent && data.intent !== 'AUTHORIZE')) protocol();
  const units = data.purchase_units ?? [];
  if (!Array.isArray(units) || units.length > 1) protocol();
  const unit = units[0];
  const payments = unit?.payments ?? {};
  if ((payments.authorizations && !Array.isArray(payments.authorizations)) ||
      (payments.captures && !Array.isArray(payments.captures))) protocol();
  return { id: id(data.id), status: data.status, intent: data.intent ?? null,
    ...normalizedAmount(unit?.amount), approvalUrl: approvalUrl(data.links),
    authorizations: (payments.authorizations ?? []).map(value => normalizedPayment(value, execution)),
    captures: (payments.captures ?? []).map(value => normalizedPayment(value, execution)),
    execution, environment: 'sandbox' };
}

/** Server-side transport. Credentials and OAuth tokens are private class fields. */
export class SandboxPayPal {
  #clientId; #clientSecret; #webhookId; #fetch; #timeout; #token = null; #tokenUntil = 0; #pendingToken = null;
  execution = 'paypal_sandbox_http';
  environment = 'sandbox';
  constructor({ clientId, clientSecret, webhookId = '', fetchImpl = globalThis.fetch,
    timeoutMs = 10_000, apiBase = PAYPAL_SANDBOX_BASE } = {}) {
    if (apiBase !== PAYPAL_SANDBOX_BASE) invalid('Only the exact PayPal Sandbox API endpoint is allowed.');
    this.#clientId = checkedText(clientId, 4096, 'PayPal Sandbox client ID');
    this.#clientSecret = checkedText(clientSecret, 4096, 'PayPal Sandbox client secret');
    if (typeof fetchImpl !== 'function') invalid('A fetch implementation is required.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) invalid('Timeout must be 10–30000 milliseconds.');
    if (webhookId) id(webhookId);
    this.#webhookId = webhookId; this.#fetch = fetchImpl; this.#timeout = timeoutMs;
  }
  async #request(path, { method = 'GET', body, headers = {} } = {}) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(`${PAYPAL_SANDBOX_BASE}${path}`, {
            method, body, headers: { Accept: 'application/json', ...headers },
            redirect: 'error', signal: controller.signal
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new PayPalError(`PayPal Sandbox request failed (HTTP ${response.status}).`, 'PAYPAL_HTTP', response.status);
          }
          const declared = Number(response.headers.get('content-length') || 0);
          if (declared > RESPONSE_LIMIT) {
            await response.body?.cancel().catch(() => {});
            throw new PayPalError('PayPal response exceeded the allowed size.', 'PAYPAL_RESPONSE_LIMIT');
          }
          const chunks = []; let total = 0;
          const reader = response.body?.getReader();
          if (reader) {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > RESPONSE_LIMIT) { await reader.cancel(); throw new PayPalError('PayPal response exceeded the allowed size.', 'PAYPAL_RESPONSE_LIMIT'); }
              chunks.push(value);
            }
          }
          if (!total) return null;
          let result;
          try { result = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { protocol(); }
          if (!result || typeof result !== 'object' || Array.isArray(result)) protocol();
          return result;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new PayPalError('PayPal request timed out. Reconcile provider state before retrying.', 'PAYPAL_TIMEOUT'));
          }, this.#timeout);
        })
      ]);
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      throw new PayPalError('PayPal Sandbox transport failed. Provider state may require reconciliation.', 'PAYPAL_TRANSPORT');
    } finally { clearTimeout(timer); }
  }
  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenUntil) return this.#token;
    if (!this.#pendingToken) this.#pendingToken = (async () => {
      const response = await this.#request('/v1/oauth2/token', {
        method: 'POST', body: 'grant_type=client_credentials', headers: {
          Authorization: `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      if (typeof response?.access_token !== 'string' || !response.access_token || response.access_token.length > 8192 ||
          !Number.isFinite(response.expires_in) || response.expires_in <= 0) protocol();
      this.#token = response.access_token;
      this.#tokenUntil = Date.now() + Math.max(0, Math.min(response.expires_in, 28_800) - 30) * 1000;
      return this.#token;
    })().finally(() => { this.#pendingToken = null; });
    return this.#pendingToken;
  }
  async #api(path, { method = 'GET', body, requestId: stableId } = {}) {
    const token = await this.#accessToken();
    return this.#request(path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation',
        ...(stableId ? { 'PayPal-Request-Id': requestId(stableId) } : {}) } });
  }
  async createOrder(input) {
    const body = orderBody(input);
    return normalizedOrder(await this.#api('/v2/checkout/orders', { method: 'POST', body, requestId: input.requestId }), this.execution);
  }
  async authorizeOrder(orderId, options = {}) {
    id(orderId); requestId(options.requestId);
    return normalizedOrder(await this.#api(`/v2/checkout/orders/${orderId}/authorize`, {
      method: 'POST', body: {}, requestId: options.requestId }), this.execution);
  }
  async getOrder(orderId) { return normalizedOrder(await this.#api(`/v2/checkout/orders/${id(orderId)}`), this.execution); }
  async getAuthorization(authorizationId) {
    return normalizedPayment(await this.#api(`/v2/payments/authorizations/${id(authorizationId)}`), this.execution);
  }
  async captureAuthorization(authorizationId, options = {}) {
    id(authorizationId); requestId(options.requestId);
    const body = { amount: positiveAmount(options.amountCents, options.currency ?? 'USD'), final_capture: true };
    return normalizedPayment(await this.#api(`/v2/payments/authorizations/${authorizationId}/capture`, {
      method: 'POST', body, requestId: options.requestId }), this.execution);
  }
  async getCapture(captureId) { return normalizedPayment(await this.#api(`/v2/payments/captures/${id(captureId)}`), this.execution); }
  async voidAuthorization(authorizationId, options = {}) {
    id(authorizationId); requestId(options.requestId);
    await this.#api(`/v2/payments/authorizations/${authorizationId}/void`, { method: 'POST', requestId: options.requestId });
    return { ...await this.getAuthorization(authorizationId), authoritativeReadback: true };
  }
  async verifyWebhook({ headers, event } = {}) {
    const refusal = verificationStatus => ({ verified: false, verificationStatus, execution: this.execution, environment: 'sandbox' });
    if (!this.#webhookId) return refusal('UNCONFIGURED');
    const get = name => {
      const value = typeof headers?.get === 'function' ? headers.get(name) :
        Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
      return typeof value === 'string' && value.length <= 8192 && !/[\r\n]/.test(value) ? value : null;
    };
    const authAlgo = get('paypal-auth-algo'); const certUrl = get('paypal-cert-url');
    const transmissionId = get('paypal-transmission-id'); const transmissionTime = get('paypal-transmission-time');
    const transmissionSig = get('paypal-transmission-sig');
    if (authAlgo !== 'SHA256withRSA' || !certUrl || !transmissionId || !transmissionTime || !transmissionSig ||
        !Number.isFinite(Date.parse(transmissionTime)) || !/^[A-Za-z0-9+/]+=*$/.test(transmissionSig)) return refusal('INVALID_HEADERS');
    let cert;
    try { cert = new URL(certUrl); } catch { return refusal('INVALID_HEADERS'); }
    if (cert.protocol !== 'https:' || cert.port || cert.username || cert.password || cert.search || cert.hash ||
        !['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(cert.hostname) ||
        !/^\/v1\/notifications\/certs\/[A-Za-z0-9_-]+$/.test(cert.pathname)) return refusal('INVALID_HEADERS');
    let serialized;
    try { serialized = JSON.stringify(event); } catch { return refusal('INVALID_EVENT'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || !event.id || !event.event_type ||
        typeof serialized !== 'string' || Buffer.byteLength(serialized) > 100_000) return refusal('INVALID_EVENT');
    const result = await this.#api('/v1/notifications/verify-webhook-signature', { method: 'POST', body: {
      auth_algo: authAlgo, cert_url: cert.href, transmission_id: transmissionId,
      transmission_time: transmissionTime, transmission_sig: transmissionSig,
      webhook_id: this.#webhookId, webhook_event: event
    } });
    const verificationStatus = result?.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
    return { verified: verificationStatus === 'SUCCESS', verificationStatus, execution: this.execution, environment: 'sandbox' };
  }
}

/** Explicit in-memory test double; no request reaches PayPal and webhooks never verify. */
export class MockPayPal {
  execution = 'mock_paypal'; environment = 'sandbox';
  #orders = new Map(); #authorizations = new Map(); #captures = new Map(); #requests = new Map();
  #namespace = randomBytes(6).toString('hex');
  constructor(snapshot = null) {
    if(snapshot) { this.#orders=new Map(snapshot.orders);this.#authorizations=new Map(snapshot.authorizations);this.#captures=new Map(snapshot.captures);this.#requests=new Map(snapshot.requests);this.#namespace=snapshot.namespace||this.#namespace; }
  }
  exportState() { return {namespace:this.#namespace,orders:[...this.#orders],authorizations:[...this.#authorizations],captures:[...this.#captures],requests:[...this.#requests]}; }
  #memo(key, payload, make) {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const prior = this.#requests.get(key);
    if (prior) {
      if (prior.hash !== hash) invalid('A stable request ID cannot be reused with a different payload.');
      return clone(prior.result);
    }
    const result = make(); this.#requests.set(key, { hash, result: clone(result) }); return result;
  }
  #order(orderId) { id(orderId); const item = this.#orders.get(orderId); if (!item) invalid('Mock order does not exist.'); return item; }
  #authorization(authorizationId) { id(authorizationId); const item = this.#authorizations.get(authorizationId); if (!item) invalid('Mock authorization does not exist.'); return item; }
  async createOrder(input) {
    const body = orderBody(input);
    return this.#memo(`create:${input.requestId}`, body, () => {
      const orderId = `MOCKORDER${this.#namespace}${this.#orders.size + 1}`;
      const order = { id: orderId, status: 'CREATED', intent: 'AUTHORIZE', amountCents: input.amountCents,
        currency: input.currency ?? 'USD', approvalUrl: null, authorizations: [], captures: [],
        execution: this.execution, environment: 'sandbox' };
      this.#orders.set(orderId, order); return clone(order);
    });
  }
  async approveOrder(orderId) {
    const order = this.#order(orderId);
    if (order.status !== 'CREATED') invalid('Mock order is not awaiting approval.');
    order.status = 'APPROVED'; return clone(order);
  }
  async getOrder(orderId) { return clone(this.#order(orderId)); }
  async authorizeOrder(orderId, options = {}) {
    id(orderId); requestId(options.requestId);
    return this.#memo(`authorize:${orderId}:${options.requestId}`, {}, () => {
      const order = this.#order(orderId);
      if (order.status !== 'APPROVED') invalid('Mock buyer approval is required before authorization.');
      const authorizationId = `MOCKAUTH${this.#namespace}${this.#authorizations.size + 1}`;
      const authorization = { id: authorizationId, status: 'CREATED', amountCents: order.amountCents, currency: order.currency,
        expirationTime: new Date(Date.now() + 29 * 86_400_000).toISOString(), finalCapture: null, authorizationId: null,
        execution: this.execution, environment: 'sandbox' };
      this.#authorizations.set(authorizationId, authorization);
      order.authorizations = [authorization]; order.status = 'COMPLETED'; return clone(order);
    });
  }
  async getAuthorization(authorizationId) { return clone(this.#authorization(authorizationId)); }
  async captureAuthorization(authorizationId, options = {}) {
    id(authorizationId); requestId(options.requestId); positiveAmount(options.amountCents, options.currency ?? 'USD');
    return this.#memo(`capture:${authorizationId}:${options.requestId}`, { amountCents: options.amountCents, currency: options.currency ?? 'USD' }, () => {
      const authorization = this.#authorization(authorizationId);
      if (authorization.status !== 'CREATED' || Date.parse(authorization.expirationTime) <= Date.now()) invalid('Mock authorization is not capturable.');
      if (options.amountCents > authorization.amountCents || (options.currency ?? 'USD') !== authorization.currency) invalid('Capture exceeds the mock authorization or changes currency.');
      const capture = { id: `MOCKCAPTURE${this.#namespace}${this.#captures.size + 1}`, status: 'COMPLETED', amountCents: options.amountCents,
        currency: authorization.currency, expirationTime: null, finalCapture: true, authorizationId,
        execution: this.execution, environment: 'sandbox' };
      authorization.status = options.amountCents === authorization.amountCents ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
      // A final capture closes further operations even when the numeric capture is partial.
      authorization.finalCapture = true;
      this.#captures.set(capture.id, capture);
      for (const order of this.#orders.values()) if (order.authorizations.some(value => value.id === authorizationId)) order.captures.push(capture);
      return clone(capture);
    });
  }
  async getCapture(captureId) { id(captureId); const capture = this.#captures.get(captureId); if (!capture) invalid('Mock capture does not exist.'); return clone(capture); }
  async voidAuthorization(authorizationId, options = {}) {
    id(authorizationId); requestId(options.requestId);
    return this.#memo(`void:${authorizationId}:${options.requestId}`, {}, () => {
      const authorization = this.#authorization(authorizationId);
      if (authorization.status !== 'CREATED') invalid('Mock authorization cannot be voided in its current state.');
      authorization.status = 'VOIDED'; return { ...clone(authorization), authoritativeReadback: false };
    });
  }
  async verifyWebhook() { return { verified: false, verificationStatus: 'MOCK_NOT_VERIFIED', execution: this.execution, environment: 'sandbox' }; }
}
