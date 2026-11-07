# StockSwap

A buyer-approved replacement for an out-of-stock accessory, before payment capture. Compatibility, inventory and the authorized amount are checked in code; the buyer accepts exact terms; the merchant separately captures or voids the authorization.

## Status

The local application is implemented and browser-verified. Its default PayPal and AI modes are clearly labeled test doubles. Live Sandbox transactions, real model inference, provider webhooks and public deployment remain pending configuration and release verification.

## Intended use

A small single merchant discovers an ordered accessory is out of stock after payment authorization but before fulfillment. StockSwap proposes a compatible replacement, obtains explicit buyer acceptance and captures only the authorized, agreed amount—or voids the authorization when no option is accepted.

## Workflow

Choose Harbor USB-C cable → create local checkout → explicitly simulate buyer approval and authorization → mark the original unavailable → request a replacement → review Reef USB-C cable at $11.99 → accept → separately capture → read back and export. A separate order exercises voiding. Local mode makes zero external provider requests.

Acceptance binds SKU, quantity, amount, currency, authorization, inventory revision and proposal version. Changed stock or proposals invalidate consent. Intent and stable request IDs are persisted before payment writes. Unknown outcomes require reconciliation; duplicate completed actions preserve one receipt. Higher prices require a new buyer-approved order.

## Development

Use Node.js 24. No npm packages or credentials are required for local development.

```sh
npm test
npm start
```

Open http://127.0.0.1:8802. Local SQLite persists private sessions and test fixtures across restarts. Copy `.env.example` to ignored `.env.local` for configured Sandbox/model operation. Credentials stay server-side. Cloud mode uses generation-checked GCS writes; it refuses startup without explicit Sandbox mode, isolated persistence and HTTPS origin. See [deployment configuration](docs/deployment.md).

Tests cover domain gates, HTTP workflows, persistence, payment transport and AI-output validation. Actual browser verification covers the local workflow, restart recovery, receipt read-back and export. Transport fixtures are not live integration evidence.

Keep credentials in local ignored files or the deployment secret store. Do not commit user data, provider tokens or private evaluation records.

## Development approach

Built with AI-assisted coding and ChatGPT-assisted research. Plain JavaScript ES modules and native Node APIs keep setup small. The merchant/buyer panels are demo controls in one private session, not independently authenticated commerce roles. One fictional accessory catalog, USD and quantities 1–3; no real payments, shipping, refunds, marketplace or escrow flow.

## License

Original application code, fictional catalog and interface assets use the [MIT license](LICENSE).
