# StockSwap

Negotiate out-of-stock substitutions before authorized capture.

## Status

This repository contains the initial product documentation. Application development has not started. There is no runnable application, measured benchmark or deployed service yet.

## Intended use

A small single merchant discovers an ordered accessory is out of stock after payment authorization but before fulfillment. StockSwap proposes a compatible replacement, obtains explicit buyer acceptance and captures only the authorized, agreed amount—or voids the authorization when no option is accepted.

## Planned workflow

Buyer approves an AUTHORIZED sandbox order → stock change creates an exception → a text model compares allowed catalog attributes and asks about missing preferences → deterministic rules reject incompatible or over-budget choices → buyer reviews exact SKU/price → capture permitted amount or void → read provider state → update fulfillment ledger. A price increase or incompatible authorization requires a fresh buyer-approved order; never assume consent transfers.

## Development

Start with the behavior and boundaries in [Architecture](docs/architecture.md), then establish the fixtures and acceptance checks in [Verification plan](docs/verification-plan.md). Runtime versions, dependency installation, commands and deployment instructions will be added alongside working code. No installation command is available at this stage.

Keep credentials in local ignored files or the deployment secret store. Do not commit user data, provider tokens or private evaluation records.

## Development approach

The planned development approach is AI-assisted coding and ChatGPT-assisted research. This repository is a preparation foundation; implementation and application verification remain pending.

## License

Original application code and these documents use the [MIT license](LICENSE). Future dependencies, models, datasets and media retain their own licenses and must be reviewed before inclusion.
