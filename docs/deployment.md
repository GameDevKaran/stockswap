# Isolated deployment configuration

Prepared configuration, not a deployed release. Only `tough-melody-508008-p8` is authorized. Preserve all existing services.

Use one `stockswap` Cloud Run service in `us-central1`, minimum instances 0, maximum instances 1, 512 MiB, concurrency 8. Use dedicated runtime/build identities, one private image repository and one private `stockswap-sessions-564976398462` bucket with public-access prevention. Grant runtime object access only to this bucket and secret access only to StockSwap's named versions. Use its attached identity, never service-account keys.

The container allowlist includes package metadata, `src/` and `public/`. Resolve and record the Node 24 image digest for the first release; this Dockerfile is a preparation template and has not been built/deployed. Deploy an immutable image digest with exact project flags. No Cloud SQL, Firebase Auth, purchased domain or new project is needed.

Required environment: `PAYPAL_ENV=sandbox`, `STOCKSWAP_PAYPAL_MODE=sandbox`, `STOCKSWAP_STORE=gcs`, `STOCKSWAP_BUCKET=stockswap-sessions-564976398462`, `GCP_PROJECT_ID=tough-melody-508008-p8`, and `STOCKSWAP_ORIGIN` equal to the final HTTPS origin. Use Secret Manager references for PayPal/model credentials. Configure `<origin>/api/webhook` and save its PayPal webhook ID privately. Simulator events are not verified provider evidence.

Live AI also requires `STOCKSWAP_AI_MODE=live`, an allowed base URL, model, allowance reference, expiry and integer request limit. Requests count durably before dispatch, including failures. This counter is not a monetary billing cap.

Release gates: approved hosting/model spending; Sandbox merchant/buyer/app; real authorization, capture and separate void with read-back; actual model proposal; verified webhook and duplicate handling; cloud persistence; public browser workflow; live demo; verified private source push. Source publication and final submission belong to the owner.

Reconcile uncertain operations before retrying. Do not reset state to hide unresolved outcomes. Preserve receipts. Roll back only this service to its prior verified image when needed.
