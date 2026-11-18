# Unminted — Token Launch Radar

Entry for the make.fun **token-radar-01** bounty
(https://make.fun/bounty/token-radar-01).

Unminted ranks 198 pre-token protocols by implied launch value, priced off
a comps curve fitted on 80 traded protocols and **tested out of sample**
(5-fold + leave-one-out, printed on the dashboard). Every row carries a
rank range from 200 bootstrap refits and a 6-step farm plan with dollar
costs and times, netted to a FARM / THIN / SKIP verdict. The full watchlist
is covered 40/40.

- `main.ts` — entry point (Node 22, stdlib only): reads the snapshot,
  asserts the board's shape, writes `board.json`, `data.js`, the dashboard
  and screenshots, and `dossier.json`.
- `lib/model.ts` — the comps-curve fit, validation, bootstrap rank ranges
  and farm-plan generator.
- `dashboard/` — static page (board, detail view, filters, comps-curve
  chart), no network, no framework.
- `METHOD.md` — the model, its measured out-of-sample error, and every
  constant, stated plainly.

Run it:

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
