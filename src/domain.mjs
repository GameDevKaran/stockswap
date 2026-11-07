/** Pure Sandbox domain. The server owns stored state and provider proof inputs.
 * Persist a prepared operation before the provider POST; never accept client-posted
 * session state or provider proof. A returned existing operation is not a new charge.
 */
import { CATALOG, initialInventory } from './catalog.mjs';
export { CATALOG };
export class DomainError extends Error {
  constructor(code, message, httpStatus = 409) { super(message); this.name = 'DomainError'; this.code = code; this.httpStatus = httpStatus; this.status = httpStatus; }
}
const fail = (code, message, status) => { throw new DomainError(code, message, status); };
const copy = value => structuredClone(value);
const terminal = state => ['captured', 'voided'].includes(state.status);
const iso = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_TIME', 'A valid explicit timestamp is required.', 400);
  return new Date(value).toISOString();
};
const id = (value, label = 'Identifier') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('INVALID_ID', `${label} is invalid.`, 400);
  return value;
};
const integer = (value, low, high, label) => {
  if (!Number.isSafeInteger(value) || value < low || value > high) fail('INVALID_VALUE', `${label} must be an integer from ${low} to ${high}.`, 400);
  return value;
};
function checked(state) {
  if (!state || state.version !== 1 || !state.id || !Array.isArray(state.inventory) || !Array.isArray(state.audit)) fail('INVALID_STATE', 'A stored StockSwap session is required.', 400);
  return state;
}
function event(state, type, now, detail = {}) {
  const next = copy(checked(state));
  next.updatedAt = iso(now);
  next.audit.push({ type, at: next.updatedAt, ...detail });
  return next;
}
function mutable(state) {
  checked(state);
  if (terminal(state)) fail('TERMINAL_SESSION', 'This session has already reached a final payment outcome.');
  if (state.operation) fail('PAYMENT_IN_PROGRESS', 'Reconcile the existing payment operation before any other change.');
}
function authorised(state, now) {
  checked(state);
  const at = iso(now);
  if (!state.authorization) fail('NOT_AUTHORISED', 'A provider-confirmed authorization is required.');
  if (Date.parse(state.authorization.validUntil) <= Date.parse(at)) fail('AUTHORIZATION_EXPIRED', 'The authorization has expired. Create a fresh buyer-approved order.');
  if (state.authorization.currency !== 'USD') fail('CURRENCY_MISMATCH', 'Only the authorized USD amount is supported.');
  return state.authorization;
}
function sameOperation(existing, input, kind) {
  if (!existing) return false;
  if (existing.kind === kind && existing.operationId === input.operationId && existing.idempotencyKey === input.idempotencyKey) return true;
  fail('OPERATION_CONFLICT', 'An operation already exists; reuse its identifiers and reconcile its provider state.');
}
function operation(kind, input) {
  return { kind, operationId: id(input.operationId, 'Operation ID'), idempotencyKey: id(input.idempotencyKey, 'Idempotency key'), status: 'prepared', preparedAt: iso(input.now) };
}
function consentTuple(proposal) {
  return Object.fromEntries(['sku', 'quantity', 'amountCents', 'currency', 'authorizationId', 'inventoryRevision', 'proposalVersion'].map(key => [key, proposal[key]]));
}
function equalTuple(a, b) { return Object.keys(a).every(key => a[key] === b?.[key]); }

export function createSession({ id: sessionId, originalSku, quantity = 1, now }) {
  id(sessionId, 'Session ID'); integer(quantity, 1, 3, 'Quantity');
  const item = CATALOG.find(row => row.sku === originalSku);
  if (!item) fail('UNKNOWN_SKU', 'Choose an item from the owned catalog.', 400);
  if (item.stock < quantity) fail('OUT_OF_STOCK', 'The original item must initially be available.');
  const at = iso(now);
  return { version: 1, id: sessionId, status: 'created', quantity, currency: 'USD',
    original: { ...copy(item), totalAmountCents: item.unitAmountCents * quantity },
    inventory: initialInventory(), inventoryRevision: 1, proposalCounter: 0,
    order: null, authorization: null, proposal: null, consent: null, operation: null, receipt: null,
    createdAt: at, updatedAt: at, audit: [{ type: 'session_created', at }] };
}
export function beginOrder(state, input) {
  checked(state);
  if (state.order) { sameOperation(state.order, input, 'create_order'); return copy(state); }
  mutable(state);
  if (state.status !== 'created') fail('INVALID_TRANSITION', 'Create an order only from a new session.');
  const next = event(state, 'order_prepared', input.now);
  next.order = { ...operation('create_order', input), orderId: null, approveUrl: null, providerStatus: null, authorizationOperation: null };
  next.status = 'order_pending'; return next;
}
export function markOrderCreated(state, { orderId, approveUrl = null, status, now }) {
  checked(state); id(orderId, 'Provider order ID');
  if (!state.order) fail('ORDER_NOT_PREPARED', 'Persist an order operation before attaching provider state.');
  if (!['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'].includes(status)) fail('ORDER_NOT_APPROVABLE', 'The provider order is not in a supported approval state.');
  if (state.order.orderId && state.order.orderId !== orderId) fail('ORDER_MISMATCH', 'Provider order ID differs from the stored order.');
  if (state.authorization || state.order.authorizationOperation) fail('AUTHORIZATION_STARTED', 'Authorization has already started; reconcile it instead of changing order approval.');
  if (state.order.providerStatus === 'APPROVED' && status !== 'APPROVED') fail('ORDER_REGRESSION', 'An approved order cannot regress to an earlier state.');
  if (approveUrl !== null) {
    let url; try { url = new URL(approveUrl); } catch { fail('INVALID_APPROVAL_URL', 'Provider approval URL is invalid.', 400); }
    if (url.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname) || url.username || url.password) fail('INVALID_APPROVAL_URL', 'Only a PayPal Sandbox approval URL is accepted.', 400);
  }
  const next = event(state, 'order_readback', now, { orderId, status });
  Object.assign(next.order, { orderId, approveUrl: approveUrl ?? next.order.approveUrl, providerStatus: status, status: 'completed' });
  next.status = 'order_created'; return next;
}
export function beginAuthorize(state, input) {
  mutable(state);
  if (!state.order?.orderId) fail('NO_ORDER', 'A provider-created order is required.');
  if (state.order.authorizationOperation) { sameOperation(state.order.authorizationOperation, input, 'authorize'); return copy(state); }
  if (state.order.providerStatus !== 'APPROVED') fail('BUYER_APPROVAL_REQUIRED', 'Read back the buyer-approved order before authorization.');
  const next = event(state, 'authorization_prepared', input.now);
  next.order.authorizationOperation = operation('authorize', input); next.status = 'authorization_pending'; return next;
}
export function markAuthorised(state, proof) {
  checked(state); const at = iso(proof.now);
  id(proof.authorizationId, 'Authorization ID');
  if (!state.order?.authorizationOperation || state.order.orderId !== proof.orderId) fail('ORDER_MISMATCH', 'Authorization must match the prepared, buyer-approved order.');
  if (proof.status !== 'AUTHORIZED' || proof.currency !== 'USD' || proof.amountCents !== state.original.totalAmountCents) fail('AUTHORIZATION_MISMATCH', 'Authorization state, currency or amount does not match the order.');
  const validUntil = iso(proof.validUntil);
  if (Date.parse(validUntil) <= Date.parse(at)) fail('AUTHORIZATION_EXPIRED', 'Provider authorization is already expired.');
  if (state.authorization) {
    if (state.authorization.authorizationId === proof.authorizationId && state.authorization.amountCents === proof.amountCents && state.authorization.orderId === proof.orderId && state.authorization.validUntil === validUntil) return copy(state);
    fail('AUTHORIZATION_MISMATCH', 'A different authorization is already attached.');
  }
  const next = event(state, 'authorization_readback', at, { authorizationId: proof.authorizationId });
  next.authorization = { orderId: proof.orderId, authorizationId: proof.authorizationId, amountCents: proof.amountCents, currency: 'USD', validUntil };
  next.order.authorizationOperation.status = 'completed'; next.status = 'authorised'; return next;
}
export function changeInventory(state, { sku, stock, unitAmountCents, now }) {
  mutable(state);
  if (!state.authorization) fail('NOT_AUTHORISED', 'The stock-exception workflow begins after authorization.');
  const item = state.inventory.find(row => row.sku === sku);
  if (!item) fail('UNKNOWN_SKU', 'Unknown inventory item.', 400);
  if (stock === undefined && unitAmountCents === undefined) fail('NO_CHANGE', 'Supply stock or price.', 400);
  if (stock !== undefined) integer(stock, 0, 10000, 'Stock');
  if (unitAmountCents !== undefined) integer(unitAmountCents, 1, 1000000, 'Unit amount');
  if ((stock === undefined || stock === item.stock) && (unitAmountCents === undefined || unitAmountCents === item.unitAmountCents)) return copy(state);
  const next = event(state, 'inventory_changed', now, { sku });
  const changed = next.inventory.find(row => row.sku === sku);
  if (stock !== undefined) changed.stock = stock;
  if (unitAmountCents !== undefined) changed.unitAmountCents = unitAmountCents;
  next.inventoryRevision += 1; next.proposal = null; next.consent = null;
  next.status = next.inventory.find(row => row.sku === next.original.sku).stock < next.quantity ? 'stock_exception' : 'authorised';
  return next;
}
export function replacementOptions(state, { now }) {
  const authorization = authorised(state, now);
  return state.inventory.filter(item => item.sku !== state.original.sku).map(item => {
    const reasons = [];
    if (item.kind !== state.original.kind) reasons.push('Different accessory kind.');
    if (item.connector !== state.original.connector) reasons.push('Connector does not match.');
    for (const [key, minimum] of Object.entries(state.original.attributes)) {
      if (!Number.isFinite(item.attributes[key]) || item.attributes[key] < minimum) reasons.push(`Does not meet the original ${key} requirement (${minimum}).`);
    }
    if (item.stock < state.quantity) reasons.push('Insufficient current stock.');
    if (item.unitAmountCents * state.quantity > authorization.amountCents) reasons.push('Price exceeds the authorization; a fresh buyer-approved order is required.');
    if (item.currency !== authorization.currency) reasons.push('Currency differs from the authorization.');
    return { ...copy(item), amountCents: item.unitAmountCents * state.quantity, quantity: state.quantity, eligible: reasons.length === 0, reasons };
  });
}
export function eligibleReplacements(state, input) { return replacementOptions(state, input).filter(item => item.eligible); }
export function proposeReplacement(state, { sku, reason, source = 'manual', now }) {
  mutable(state); authorised(state, now);
  if (state.inventory.find(row => row.sku === state.original.sku).stock >= state.quantity) fail('NO_STOCK_EXCEPTION', 'The original item is still available; no stock substitution is needed.');
  if (!['manual', 'model'].includes(source) || typeof reason !== 'string' || !reason.trim() || reason.length > 600) fail('INVALID_PROPOSAL', 'A bounded explanation and supported proposal source are required.', 400);
  const item = replacementOptions(state, { now }).find(row => row.sku === sku);
  if (!item?.eligible) fail('INELIGIBLE_REPLACEMENT', item?.reasons.join(' ') || 'Unknown replacement SKU.', 422);
  const next = event(state, 'replacement_proposed', now, { sku, source });
  next.proposalCounter += 1;
  next.proposal = { sku: item.sku, name: item.name, quantity: state.quantity, unitAmountCents: item.unitAmountCents, amountCents: item.amountCents,
    currency: 'USD', authorizationId: state.authorization.authorizationId, inventoryRevision: state.inventoryRevision,
    proposalVersion: next.proposalCounter, reason: reason.trim(), source };
  next.consent = null; next.status = 'proposed'; return next;
}
export function acceptReplacement(state, input) {
  mutable(state); authorised(state, input.now);
  if (!state.proposal) fail('NO_PROPOSAL', 'A valid current proposal is required.');
  const exact = consentTuple(state.proposal);
  if (!equalTuple(exact, input)) fail('CONSENT_MISMATCH', 'Acceptance must match the exact SKU, quantity, amount, currency, authorization and current proposal.');
  const next = event(state, 'buyer_accepted', input.now, { sku: exact.sku, proposalVersion: exact.proposalVersion });
  next.consent = { ...exact, acceptedAt: iso(input.now) }; next.status = 'accepted'; return next;
}
export function prepareCapture(state, input) {
  checked(state);
  if (state.operation) { sameOperation(state.operation, input, 'capture'); return copy(state); }
  mutable(state); authorised(state, input.now);
  if (!state.proposal || !state.consent || !equalTuple(consentTuple(state.proposal), state.consent)) fail('CONSENT_REQUIRED', 'Exact buyer acceptance is required before capture.');
  if (state.proposal.inventoryRevision !== state.inventoryRevision) fail('STALE_CONSENT', 'Inventory changed; a new proposal and acceptance are required.');
  const option = replacementOptions(state, { now: input.now }).find(item => item.sku === state.proposal.sku);
  if (!option?.eligible || option.amountCents !== state.consent.amountCents) fail('STOCK_OR_PRICE_CHANGED', 'Recheck stock and price, then obtain new buyer acceptance.');
  const next = event(state, 'capture_prepared', input.now);
  next.operation = { ...operation('capture', input), ...consentTuple(state.proposal) };
  next.status = 'capture_pending'; return next;
}
export function prepareVoid(state, input) {
  checked(state);
  if (state.operation) { sameOperation(state.operation, input, 'void'); return copy(state); }
  mutable(state);
  if (!state.authorization) fail('NOT_AUTHORISED', 'A known authorization is required before voiding.');
  const next = event(state, 'void_prepared', input.now);
  next.operation = { ...operation('void', input), authorizationId: state.authorization.authorizationId };
  next.consent = null; next.status = 'void_pending'; return next;
}
export function markUncertain(state, { operationId, reason = 'Provider response is unresolved; read back before retrying.', now }) {
  checked(state);
  if (typeof reason !== 'string' || reason.length > 500) fail('INVALID_REASON', 'Use a bounded failure explanation.', 400);
  const next = copy(state);
  let target;
  if (next.operation?.operationId === operationId) target = next.operation;
  else if (next.order?.authorizationOperation?.operationId === operationId) target = next.order.authorizationOperation;
  else if (next.order?.operationId === operationId) target = next.order;
  if (!target) fail('UNKNOWN_OPERATION', 'No matching persisted operation exists.');
  if (target.status === 'completed') return copy(state);
  target.status = 'uncertain'; target.reason = reason;
  next.status = ({ create_order: 'order_uncertain', authorize: 'authorization_uncertain', capture: 'capture_uncertain', void: 'void_uncertain' })[target.kind];
  return event(next, 'provider_outcome_uncertain', now, { operationId });
}
export function confirmCapture(state, proof) {
  checked(state); const op = state.operation;
  if (op?.kind !== 'capture' || op.operationId !== proof.operationId) fail('UNKNOWN_OPERATION', 'Capture proof must match the persisted capture operation.');
  id(proof.captureId, 'Capture ID');
  if (proof.status !== 'COMPLETED' || proof.authorizationId !== op.authorizationId || proof.amountCents !== op.amountCents || proof.currency !== op.currency) fail('CAPTURE_PROOF_MISMATCH', 'Provider read-back must confirm the exact authorization, capture amount, currency and completed state.');
  if (op.status === 'completed') {
    if (state.receipt?.captureId === proof.captureId) return copy(state);
    fail('CAPTURE_PROOF_MISMATCH', 'A different completed capture is already recorded.');
  }
  const next = event(state, 'capture_readback', proof.now, { captureId: proof.captureId });
  const item = next.inventory.find(row => row.sku === op.sku);
  if (!item || item.stock < op.quantity) fail('INVENTORY_INCONSISTENT', 'Stored inventory is inconsistent; reconcile fulfillment manually.');
  item.stock -= op.quantity; next.inventoryRevision += 1; next.operation.status = 'completed';
  next.receipt = { kind: 'capture', captureId: proof.captureId, authorizationId: proof.authorizationId, amountCents: proof.amountCents, currency: proof.currency, sku: op.sku, quantity: op.quantity, confirmedAt: iso(proof.now) };
  next.status = 'captured'; return next;
}
export function confirmVoid(state, proof) {
  checked(state); const op = state.operation;
  if (op?.kind !== 'void' || op.operationId !== proof.operationId || proof.authorizationId !== op.authorizationId || proof.status !== 'VOIDED') fail('VOID_PROOF_MISMATCH', 'Provider read-back must confirm the matching authorization is voided.');
  if (op.status === 'completed') return copy(state);
  const next = event(state, 'void_readback', proof.now);
  next.operation.status = 'completed'; next.receipt = { kind: 'void', authorizationId: proof.authorizationId, confirmedAt: iso(proof.now) };
  next.status = 'voided'; return next;
}
