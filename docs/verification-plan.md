# StockSwap: verification plan

No tests or evaluations have run. The following are prospective acceptance targets, not results.

## Fixtures and acceptance

ten development and ten held-out scenarios including rejection, lower price, price increase, duplicate delivery, timeout and expired authorization. Zero capture without recorded exact consent; zero capture above the approved supported amount; repeated requests never create a second intended charge. At least 9/10 supported scenarios reach the correct terminal state. Compare a fixed substitute list with the model-assisted proposal on valid choices and needed clarification; do not claim conversion improvement.

## Demonstration to verify

order authorization, missing stock, incompatible option rejected, buyer accepts a valid replacement, actual capture read-back and duplicate-event immunity.

## Result record

For each run, record the source commit, fixture version, runtime/provider versions, actual pass and failure counts, latency, cost where relevant, and limitations. Keep development and held-out inputs separate. Report negative findings; freeze the protocol before inspecting held-out results.

A release requires a functioning end-to-end workflow and a clean-session replay. Documentation, repository creation and HTTP availability alone do not establish application correctness.
