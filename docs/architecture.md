# StockSwap: architecture

The local application is implemented as native Node24 JavaScript modules with a responsive HTML/CSS interface. The original design below is retained as context. Actual local persistence uses SQLite; cloud preparation uses an isolated GCS object store with generation checks. Real PayPal/AI adapters are implemented, but live execution and deployment remain unverified.

Buyer approves an AUTHORIZED sandbox order → stock change creates an exception → a text model compares allowed catalog attributes and asks about missing preferences → deterministic rules reject incompatible or over-budget choices → buyer reviews exact SKU/price → capture permitted amount or void → read provider state → update fulfillment ledger. A price increase or incompatible authorization requires a fresh buyer-approved order; never assume consent transfers.

JavaScript storefront/service, PayPal Orders/Payments adapter, private session storage and a signature-verification webhook endpoint. Ten fictional owned accessory SKUs are included; separate business/personal Sandbox accounts remain a live setup dependency. The model suggests alternatives; code/provider responses own totals, authorization validity and final status. Excludes allergens/medical substitutes, third-party marketplaces, escrow, live charges and automatic shipping.

## Failure handling and data boundaries

Preserve original inputs and make unavailable evidence explicit. Provider failures must return a visible unresolved state. Decisions that change user or provider state need the confirmation specified above. Record source versions and operation identifiers without exposing credentials.

## Implementation record

`domain.mjs` owns immutable state and constraints; `paypal.mjs` owns Sandbox transport; `ai.mjs` validates model suggestions; `store.mjs` owns SQLite/GCS persistence; `server.mjs` owns private sessions, idempotent orchestration and HTTP boundaries. No third-party npm packages are needed. Local fixtures are labeled in every response. See README and deployment.md for setup and unresolved release gates.
