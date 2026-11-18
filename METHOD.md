# Unminted — method

Unminted prices protocols that record no token yet off the protocols that
already trade one, then tells the reader what farming each one costs and
whether it is worth it. Everything below is computed by `lib/model.ts` from
the sealed snapshot alone; nothing is hardcoded per protocol.

## Universe

- **Comps (pricing anchors, never board rows):** token-bearing protocols
  (`gecko_id` or `symbol` present) with mcap ≥ $5M, TVL ≥ $5M and an
  mcap/TVL ratio between 0.02 and 50, de-duplicated to one comp per ticker
  (largest mcap kept). On this snapshot: **80 comps**.
- **Board:** pre-token protocols (both token fields null) passing the
  house's wrapped/staked sanity logic — category not in {Bridge, Canonical
  Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX}, no version
  suffix in the name, no whole word wrapped/staked/staking, no exchange-name
  prefix — with TVL ≥ $5,000,000. On this snapshot: **198 rows**, covering
  the full watchlist **40/40** (asserted in `main.ts`).

## The fitted curve

Least squares over the comps of `log(mcap/TVL)` on `log(TVL)`:

    log(mcap/TVL) = 9.2257 − 0.5466 × log(TVL)

so the multiple a protocol "should" trade at shrinks as it grows. Each
category with at least 5 comps then adds half of its median residual
(shrunk 50% toward zero); 8 categories qualify on this snapshot. Predicted
FDV = TVL × exp(fitted log-multiple).

## Out-of-sample validation (computed every run, shown on the board)

- **5-fold, folds assigned by slug hash:** fit on 4/5 of the comps, predict
  the held-out fold's market cap from TVL alone. Median absolute error
  **74.52%**; **37.5%** of held-out comps priced within a factor of 2.
- **Leave-one-out:** every comp predicted from the other 79. Median
  absolute error **74.99%**; **38.75%** within a factor of 2.

The errors are large because traded multiples genuinely disperse — that is
exactly why every board row also carries a rank range (below) instead of
pretending the point rank is exact.

## From FDV to implied value

`implied = predicted FDV × launch share × age factor × momentum factor`

- **Launch share** — the slice of FDV a launch puts in community/farmer
  hands, by category: Dexs 12%, Lending 11%, Derivatives 11%, Yield /
  Yield Aggregator / CDP 9%, RWA / Risk Curators / Onchain Capital
  Allocator / Basis Trading 7%, default 8%.
- **Age factor** — years live with no token (snapshot date minus
  `listed_at`): 0.85 at listing, +0.08 per year, capped at 1.25 at 5+
  years. Unreported listing date → neutral 1.00.
- **Momentum factor** — `change_7d` clamped to ±30%, mapped to 0.90–1.10;
  unreported → 1.00.

Rows are sorted by implied value (ties: TVL, then slug) and ranked 1..N.
Total implied value on this snapshot: **$464,748,970**.

## Rank ranges

The comps fit is bootstrapped **200 times** (resample with replacement,
mulberry32 PRNG seeded with a fixed constant, so runs are byte-identical).
Each row's rank across the refits gives a 10th–90th percentile range,
shown on the board, in the detail view, and stored as `rank_low` /
`rank_high` in `board.json`.

## Farm plans and verdicts

Every row gets a 6-step plan generated from its category playbook (Dexs,
Lending, Yield, Yield Aggregator, Derivatives, CDP, RWA, generic fallback),
its chains (any low-cost chain → ~$6/month gas; Ethereum-only economics →
~$45/month) and its TVL tier (deposit $250–$1,000 under $25M TVL, up to
$2,500–$5,000 at $500M+). Every step states a dollar figure and a time;
`main.ts` asserts both before writing anything. Step 5 totals the 3-month
cost; the final step is the verdict, from value density
(implied ÷ TVL) netted against that cost:

- **FARM** — density ≥ 5% of TVL (114 rows)
- **THIN** — density ≥ 2%, or FARM-density but Ethereum-tier costs above
  $150 with density under 8%: farm only at small size (65 rows)
- **SKIP** — density under 2%: expected launch value too thin against the
  plan's costs (19 rows)

## Reproduce

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

Node 22, standard library only. Two runs write identical bytes.
