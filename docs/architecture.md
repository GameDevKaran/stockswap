# StockSwap: architecture

Proposed design; no components have been implemented.

Buyer approves an AUTHORIZED sandbox order → stock change creates an exception → a text model compares allowed catalog attributes and asks about missing preferences → deterministic rules reject incompatible or over-budget choices → buyer reviews exact SKU/price → capture permitted amount or void → read provider state → update fulfillment ledger. A price increase or incompatible authorization requires a fresh buyer-approved order; never assume consent transfers.

TypeScript storefront/service, PayPal Orders/Payments adapter, isolated database and verified webhook inbox. Use ten fictional owned accessory SKUs and separate business/personal Sandbox accounts. Model handles negotiation; code/provider responses own totals, authorization validity and final status. Exclude allergens/medical substitutes, third-party marketplaces, escrow, live charges and automatic shipping.

## Failure handling and data boundaries

Preserve original inputs and make unavailable evidence explicit. Provider failures must return a visible unresolved state. Decisions that change user or provider state need the confirmation specified above. Record source versions and operation identifiers without exposing credentials.

## Implementation record

Add pinned dependencies, actual component boundaries and operational instructions when the first working slice exists. Document departures from this design with their reason; do not describe planned integrations as verified.
