// Unminted — Token Launch Radar: the value model.
//
// Idea in one paragraph: protocols that already trade a token are the pricing
// anchors (the comps). Fit how their market-cap-to-TVL multiple bends with
// size — log(mcap / TVL) as a straight line in log(TVL), least squares — then
// nudge the line per category by half of that category's median residual.
// Price every pre-token protocol off that curve, take the slice of the
// predicted fully-diluted value a launch actually puts in community hands,
// and bend it by how long the protocol has run tokenless (age) and by its
// 7-day TVL momentum. The fit is then graded out of sample on the comps
// themselves (5-fold by slug hash, plus leave-one-out) and every board rank
// carries a 10th–90th percentile range from 200 seeded bootstrap refits.
//
// Everything here is deterministic: the only randomness is a mulberry32
// stream seeded with a fixed constant, so two runs write identical bytes.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  tvl_usd: number;
  category: string | null;
  chains: string[];
  change_7d: number | null;
  listed_at: string | null;
  age_years: number | null;
  predicted_fdv_usd: number;
  fitted_multiple: number;
  launch_share: number;
  age_factor: number;
  momentum_factor: number;
  rank_low: number;
  rank_high: number;
  verdict: string;
  est_cost_usd: number;
  on_watchlist: boolean;
}

export interface RadarMeta {
  brand: string;
  as_of: string;
  source: string;
  protocols_total: number;
  board_rows: number;
  watchlist_total: number;
  watchlist_covered: number;
  comps_count: number;
  comps_raw: number;
  fit_intercept: number;
  fit_slope: number;
  fit_categories_adjusted: number;
  oos_folds: number;
  oos_median_ape_pct: number;
  oos_within_2x_pct: number;
  loo_median_ape_pct: number;
  loo_within_2x_pct: number;
  bootstrap_refits: number;
  total_implied_usd: number;
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
}

// ---------------------------------------------------------------- utilities

/** FNV-1a 32-bit hash of a slug, as a fraction in [0, 1). Stable across runs. */
export function slugFraction(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/** mulberry32: tiny seeded PRNG so the bootstrap refits are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const at = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
  return sortedAsc[at]!;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// ------------------------------------------------------------- the universe

/** Token-bearing protocols are the comps: pricing anchors, never board rows. */
export function isTokenBearing(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORDS = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * The house's wrapped/staked sanity logic, mirrored: a pre-token protocol is
 * board material when it is not a bridge/staking wrapper category, its name
 * carries no version marker and no whole word wrapped/staked/staking, and it
 * does not wear an exchange's name.
 */
export function passesSanity(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORDS.test(p.name)) return false;
  for (const ex of EXCHANGE_PREFIXES) if (p.name.startsWith(ex)) return false;
  return true;
}

export const BOARD_MIN_TVL_USD = 5_000_000;
export const COMP_MIN_USD = 5_000_000;
export const COMP_RATIO_MIN = 0.02;
export const COMP_RATIO_MAX = 50;

/** Pre-token, sane, at or above the snapshot's own $5M floor. */
export function selectBoardProtocols(snapshot: Snapshot): Protocol[] {
  return snapshot.protocols.filter(
    (p) => !isTokenBearing(p) && passesSanity(p) && p.tvl_usd >= BOARD_MIN_TVL_USD,
  );
}

/**
 * The comps: token-bearing, both legs at least $5M, a sane mcap/TVL ratio,
 * de-duplicated to one comp per ticker (largest mcap kept) so a single token
 * family listed under several slugs cannot dominate the fit.
 */
export function selectComps(snapshot: Snapshot): { comps: Protocol[]; raw: number } {
  const eligible = snapshot.protocols.filter((p) => {
    if (!isTokenBearing(p) || p.mcap_usd === null) return false;
    if (p.mcap_usd < COMP_MIN_USD || p.tvl_usd < COMP_MIN_USD) return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return ratio >= COMP_RATIO_MIN && ratio <= COMP_RATIO_MAX;
  });
  const byTicker = new Map<string, Protocol>();
  for (const p of eligible) {
    const key = (p.symbol ?? p.gecko_id ?? p.slug).toUpperCase();
    const kept = byTicker.get(key);
    if (kept === undefined || (p.mcap_usd ?? 0) > (kept.mcap_usd ?? 0)) byTicker.set(key, p);
  }
  return { comps: [...byTicker.values()], raw: eligible.length };
}

// ------------------------------------------------------------------- the fit

export interface Fit {
  intercept: number;
  slope: number;
  categoryAdj: Map<string, number>;
  n: number;
}

/**
 * Least squares of log(mcap/TVL) on log(TVL) over the given comps, then a
 * per-category adjustment: the category's median residual, shrunk 50% toward
 * zero, applied only when the category contributes at least 5 comps.
 */
export function fitCurve(comps: Protocol[]): Fit {
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log((p.mcap_usd as number) / p.tvl_usd));
  const n = comps.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const cat = comps[i]!.category;
    if (cat === null) continue;
    const r = ys[i]! - (intercept + slope * xs[i]!);
    const list = residuals.get(cat) ?? [];
    list.push(r);
    residuals.set(cat, list);
  }
  const categoryAdj = new Map<string, number>();
  for (const [cat, list] of residuals) {
    if (list.length >= 5) categoryAdj.set(cat, 0.5 * median(list));
  }
  return { intercept, slope, categoryAdj, n };
}

/** The fitted log-multiple for any TVL and category under a fit. */
export function fittedLogMultiple(fit: Fit, tvlUsd: number, category: string | null): number {
  const adj = category === null ? 0 : (fit.categoryAdj.get(category) ?? 0);
  return fit.intercept + fit.slope * Math.log(tvlUsd) + adj;
}

export function predictedFdv(fit: Fit, tvlUsd: number, category: string | null): number {
  return tvlUsd * Math.exp(fittedLogMultiple(fit, tvlUsd, category));
}

// -------------------------------------------------------------- validation

export interface Validation {
  folds: number;
  medianApePct: number;
  within2xPct: number;
  looMedianApePct: number;
  looWithin2xPct: number;
  tested: number;
}

function scorePredictions(pairs: { predicted: number; actual: number }[]): { medianApePct: number; within2xPct: number } {
  const apes = pairs.map(({ predicted, actual }) => Math.abs(predicted - actual) / actual);
  const within = pairs.filter(({ predicted, actual }) => {
    const r = predicted / actual;
    return r >= 0.5 && r <= 2;
  }).length;
  return {
    medianApePct: round4(median(apes) * 100),
    within2xPct: round4((within / pairs.length) * 100),
  };
}

/**
 * Out-of-sample honesty check, run on the comps themselves. Five folds are
 * assigned by slug hash; each fold is predicted from a fit that never saw it.
 * A leave-one-out pass follows: every comp predicted from all the others.
 */
export function validateOutOfSample(comps: Protocol[], folds = 5): Validation {
  const heldOut: { predicted: number; actual: number }[] = [];
  for (let f = 0; f < folds; f++) {
    const train = comps.filter((p) => Math.floor(slugFraction(p.slug) * folds) !== f);
    const test = comps.filter((p) => Math.floor(slugFraction(p.slug) * folds) === f);
    if (train.length < 10 || test.length === 0) continue;
    const fit = fitCurve(train);
    for (const p of test) {
      heldOut.push({ predicted: predictedFdv(fit, p.tvl_usd, p.category), actual: p.mcap_usd as number });
    }
  }
  const loo: { predicted: number; actual: number }[] = [];
  for (let i = 0; i < comps.length; i++) {
    const fit = fitCurve(comps.filter((_, j) => j !== i));
    const p = comps[i]!;
    loo.push({ predicted: predictedFdv(fit, p.tvl_usd, p.category), actual: p.mcap_usd as number });
  }
  const cv = scorePredictions(heldOut);
  const lo = scorePredictions(loo);
  return {
    folds,
    medianApePct: cv.medianApePct,
    within2xPct: cv.within2xPct,
    looMedianApePct: lo.medianApePct,
    looWithin2xPct: lo.within2xPct,
    tested: heldOut.length,
  };
}

// ------------------------------------------------------- per-row adjustments

/** Share of predicted FDV a launch puts in community/farmer hands, by category. */
export const LAUNCH_SHARE_BY_CATEGORY = new Map<string, number>([
  ['Dexs', 0.12],
  ['Lending', 0.11],
  ['Derivatives', 0.11],
  ['Yield', 0.09],
  ['Yield Aggregator', 0.09],
  ['CDP', 0.09],
  ['RWA', 0.07],
  ['Risk Curators', 0.07],
  ['Onchain Capital Allocator', 0.07],
  ['Basis Trading', 0.07],
]);
export const LAUNCH_SHARE_DEFAULT = 0.08;

export function launchShare(category: string | null): number {
  if (category === null) return LAUNCH_SHARE_DEFAULT;
  return LAUNCH_SHARE_BY_CATEGORY.get(category) ?? LAUNCH_SHARE_DEFAULT;
}

/** Whole years between listed_at and the snapshot date; null when unreported. */
export function ageYears(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const days = (Date.parse(asOf) - Date.parse(p.listed_at)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return null;
  return days / 365.25;
}

/**
 * Time-without-a-token factor: 0.85 for a protocol listed today, rising
 * linearly to 1.25 at five years tokenless, flat past that. An unreported
 * listing date is neutral (1.00) rather than guessed.
 */
export function ageFactor(years: number | null): number {
  if (years === null) return 1;
  return Math.min(1.25, Math.max(0.85, 0.85 + 0.08 * years));
}

/** 7-day TVL momentum: change clamped to ±30%, mapped onto 0.90–1.10. */
export function momentumFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  const clamped = Math.min(30, Math.max(-30, change7d));
  return 1 + clamped / 300;
}

// -------------------------------------------------------------- farm plans

const LOW_COST_CHAINS = new Set([
  'Base', 'Arbitrum', 'Solana', 'Optimism', 'Polygon', 'BSC', 'Binance', 'Avalanche',
  'Sonic', 'Berachain', 'Monad', 'Unichain', 'Ink', 'Linea', 'Scroll', 'zkSync Era',
  'Mantle', 'Sui', 'Aptos', 'Near', 'Hyperliquid L1', 'Plasma', 'Katana', 'Corn',
  'BOB', 'Arc', 'Tempo', 'Stable', 'Morph', 'Robinhood Chain',
]);

export interface CostProfile {
  cheap: boolean;
  monthlyGasUsd: number;
  depositLabel: string;
  depositMidUsd: number;
  totalCostUsd: number;
}

/** Chain-aware cost profile and a deposit size scaled to the protocol's TVL tier. */
export function costProfile(p: Protocol): CostProfile {
  const cheap = p.chains.some((c) => LOW_COST_CHAINS.has(c));
  const monthlyGasUsd = cheap ? 6 : 45;
  let depositLabel = '$250–$1,000';
  let depositMidUsd = 600;
  if (p.tvl_usd >= 500_000_000) { depositLabel = '$2,500–$5,000'; depositMidUsd = 3750; }
  else if (p.tvl_usd >= 100_000_000) { depositLabel = '$1,500–$3,000'; depositMidUsd = 2250; }
  else if (p.tvl_usd >= 25_000_000) { depositLabel = '$750–$1,500'; depositMidUsd = 1125; }
  // Three months of gas/fees plus a small one-off setup and exit allowance.
  const totalCostUsd = Math.round(monthlyGasUsd * 3 + (cheap ? 12 : 60));
  return { cheap, monthlyGasUsd, depositLabel, depositMidUsd, totalCostUsd };
}

interface Playbook { open: string; deepen: string; routine: string }
const PLAYBOOKS = new Map<string, Playbook>([
  ['Dexs', {
    open: 'make your first swap',
    deepen: 'open a small concentrated LP position in its busiest pair',
    routine: 'swap a modest amount each week so volume and fee history build steadily',
  }],
  ['Lending', {
    open: 'supply a first tranche of a blue-chip asset',
    deepen: 'borrow a modest amount against the supply and repay it in full to complete a clean borrow cycle',
    routine: 'top up supply and roll one borrow-and-repay cycle each week',
  }],
  ['Yield', {
    open: 'deposit into its flagship vault',
    deepen: 'split a second tranche into a higher-yield vault and compare realised APY after 2 weeks',
    routine: 'rotate or compound the vault position each week and log the yield actually paid',
  }],
  ['Yield Aggregator', {
    open: 'deposit into its main auto-compounding vault',
    deepen: 'move a second tranche into a second strategy so both strategies record your wallet',
    routine: 'compound or rotate between its strategies each week',
  }],
  ['Derivatives', {
    open: 'open a first small perpetual position and close it the same day',
    deepen: 'trade a modest weekly volume across two markets, always closing flat overnight',
    routine: 'open and close two small positions each week to keep volume and fee history current',
  }],
  ['CDP', {
    open: 'open a first vault and mint a small amount of its stablecoin against collateral',
    deepen: 'add collateral to keep the vault comfortably above its liquidation line and repay part of the debt',
    routine: 'adjust collateral and repay or re-mint a small amount each week',
  }],
  ['RWA', {
    open: 'complete onboarding and make a first small purchase of its flagship real-world asset',
    deepen: 'hold the position through a full yield or coupon period and record what it pays',
    routine: 'check the position and add a small amount each month',
  }],
]);
const GENERIC_PLAYBOOK: Playbook = {
  open: 'use its core product for the first time with a small amount',
  deepen: 'repeat the core action at a second size tier so the wallet shows real, varied usage',
  routine: 'use the core product once each week and keep a live balance in it',
};

/** Verdict thresholds, stated plainly: value density first, cost as a downgrade. */
export const VERDICT_FARM_RATIO = 0.05;
export const VERDICT_THIN_RATIO = 0.02;
export const VERDICT_COSTLY_USD = 150;
export const VERDICT_COSTLY_RATIO = 0.08;

export function verdictFor(impliedUsd: number, tvlUsd: number, totalCostUsd: number): string {
  const ratio = impliedUsd / tvlUsd;
  let level = ratio >= VERDICT_FARM_RATIO ? 'FARM' : ratio >= VERDICT_THIN_RATIO ? 'THIN' : 'SKIP';
  if (totalCostUsd > VERDICT_COSTLY_USD && ratio < VERDICT_COSTLY_RATIO && level === 'FARM') level = 'THIN';
  return level;
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * A costed farm plan for one protocol: every step names the protocol, a
 * concrete action, a dollar cost (or $0) and a time. The plan closes with a
 * 3-month cost summary and a verdict line netted against that cost.
 */
export function buildFarmPlan(p: Protocol, impliedUsd: number): { steps: string[]; verdict: string; totalCostUsd: number } {
  const cost = costProfile(p);
  const book = PLAYBOOKS.get(p.category ?? '') ?? GENERIC_PLAYBOOK;
  const gasNote = cost.cheap
    ? `gas runs about ${money(cost.monthlyGasUsd)} a month on its low-cost chains`
    : `Ethereum mainnet gas runs about ${money(cost.monthlyGasUsd)} a month, so batch actions`;
  const verdict = verdictFor(impliedUsd, p.tvl_usd, cost.totalCostUsd);
  const ratioPct = ((impliedUsd / p.tvl_usd) * 100).toFixed(1);
  const verdictLine =
    verdict === 'FARM'
      ? `Verdict: FARM — implied launch value of ${money(impliedUsd)} is ${ratioPct}% of TVL against ~${money(cost.totalCostUsd)} of 3-month costs, so a steady farm over 12 weeks at the stated size is worth its time.`
      : verdict === 'THIN'
        ? `Verdict: THIN — only at small size: implied launch value of ${money(impliedUsd)} is ${ratioPct}% of TVL against ~${money(cost.totalCostUsd)} of 3-month costs, so keep the deposit at the low end for 12 weeks.`
        : `Verdict: SKIP — expected launch value too thin against ~${money(cost.totalCostUsd)} of costs: implied value of ${money(impliedUsd)} is only ${ratioPct}% of TVL, so spend 0 minutes here until its TVL or the model moves.`;
  const steps = [
    `Set up a fresh wallet for ${p.name} and ${book.open}; budget a ${cost.depositLabel} deposit and about ${money(cost.cheap ? 2 : 18)} in first gas — 20 minutes to set up.`,
    `Deepen the position in ${p.name}: ${book.deepen}; allow ${money(cost.cheap ? 3 : 25)} in fees and gas — 25 minutes in week 1.`,
    `Run the weekly routine on ${p.name}: ${book.routine}; ${gasNote} — 15 minutes per week for 12 weeks.`,
    `Hold a live balance in ${p.name} between sessions and join its community and points or quests channel ($0, free) — 10 minutes per week to check in.`,
    `Budget the full 3-month farm of ${p.name} at ~${money(cost.totalCostUsd)} total (gas, swap and borrow fees, one exit), with ${cost.depositLabel} of working capital at risk — review the spend at 30 minutes per month.`,
    verdictLine,
  ];
  return { steps, verdict, totalCostUsd: cost.totalCostUsd };
}

// ------------------------------------------------------------ board assembly

export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 0xc0ffee;

/**
 * Bootstrap rank ranges: resample the comps with replacement under a seeded
 * PRNG, refit, re-price and re-rank every board row, and keep each row's
 * 10th–90th percentile rank across the refits.
 */
export function bootstrapRankRanges(
  comps: Protocol[],
  board: Protocol[],
  shares: Map<string, number>,
  ages: Map<string, number>,
  momenta: Map<string, number>,
  refits = BOOTSTRAP_REFITS,
): Map<string, { low: number; high: number }> {
  const rand = mulberry32(BOOTSTRAP_SEED);
  const seen = new Map<string, number[]>();
  for (const p of board) seen.set(p.slug, []);
  for (let b = 0; b < refits; b++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rand() * comps.length)]!);
    const fit = fitCurve(sample);
    const scored = board.map((p) => ({
      slug: p.slug,
      value:
        predictedFdv(fit, p.tvl_usd, p.category) *
        (shares.get(p.slug) ?? LAUNCH_SHARE_DEFAULT) *
        (ages.get(p.slug) ?? 1) *
        (momenta.get(p.slug) ?? 1),
      tvl: p.tvl_usd,
    }));
    scored.sort((a, z) => z.value - a.value || z.tvl - a.tvl || (a.slug < z.slug ? -1 : 1));
    scored.forEach((row, i) => seen.get(row.slug)!.push(i + 1));
  }
  const ranges = new Map<string, { low: number; high: number }>();
  for (const [slug, ranks] of seen) {
    const sorted = [...ranks].sort((a, b) => a - b);
    ranges.set(slug, { low: percentile(sorted, 0.1), high: percentile(sorted, 0.9) });
  }
  return ranges;
}

export interface CompPoint { slug: string; tvl_usd: number; mcap_usd: number; category: string | null }

/** Build the full board plus the metadata the dashboard and METHOD.md quote. */
export function buildRadar(snapshot: Snapshot): { rows: BoardRow[]; meta: RadarMeta; comps: CompPoint[] } {
  const boardProtocols = selectBoardProtocols(snapshot);
  const { comps, raw } = selectComps(snapshot);
  const fit = fitCurve(comps);
  const validation = validateOutOfSample(comps);
  const watchlist = new Set(snapshot.watchlist);

  const shares = new Map<string, number>();
  const ageFactors = new Map<string, number>();
  const momenta = new Map<string, number>();
  const draft = boardProtocols.map((p) => {
    const years = ageYears(p, snapshot.as_of);
    const share = launchShare(p.category);
    const aF = ageFactor(years);
    const mF = momentumFactor(p.change_7d);
    shares.set(p.slug, share);
    ageFactors.set(p.slug, aF);
    momenta.set(p.slug, mF);
    const fdv = predictedFdv(fit, p.tvl_usd, p.category);
    const implied = Math.max(1, Math.round(fdv * share * aF * mF));
    return { p, years, share, aF, mF, fdv, implied };
  });

  const ranges = bootstrapRankRanges(comps, boardProtocols, shares, ageFactors, momenta);
  draft.sort((a, z) => z.implied - a.implied || z.p.tvl_usd - a.p.tvl_usd || (a.p.slug < z.p.slug ? -1 : 1));

  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  const rows: BoardRow[] = draft.map((d, i) => {
    const plan = buildFarmPlan(d.p, d.implied);
    verdictCounts[plan.verdict as keyof typeof verdictCounts] += 1;
    const range = ranges.get(d.p.slug) ?? { low: i + 1, high: i + 1 };
    return {
      slug: d.p.slug,
      name: d.p.name,
      rank: i + 1,
      implied_value_usd: d.implied,
      farm_steps: plan.steps,
      tvl_usd: d.p.tvl_usd,
      category: d.p.category,
      chains: d.p.chains,
      change_7d: d.p.change_7d,
      listed_at: d.p.listed_at,
      age_years: d.years === null ? null : round4(d.years),
      predicted_fdv_usd: Math.round(d.fdv),
      fitted_multiple: round4(Math.exp(fittedLogMultiple(fit, d.p.tvl_usd, d.p.category))),
      launch_share: d.share,
      age_factor: round4(d.aF),
      momentum_factor: round4(d.mF),
      rank_low: range.low,
      rank_high: range.high,
      verdict: plan.verdict,
      est_cost_usd: plan.totalCostUsd,
      on_watchlist: watchlist.has(d.p.slug),
    };
  });

  const meta: RadarMeta = {
    brand: 'Unminted — Token Launch Radar',
    as_of: snapshot.as_of,
    source: snapshot.source,
    protocols_total: snapshot.protocols.length,
    board_rows: rows.length,
    watchlist_total: snapshot.watchlist.length,
    watchlist_covered: rows.filter((r) => r.on_watchlist).length,
    comps_count: comps.length,
    comps_raw: raw,
    fit_intercept: round4(fit.intercept),
    fit_slope: round4(fit.slope),
    fit_categories_adjusted: fit.categoryAdj.size,
    oos_folds: validation.folds,
    oos_median_ape_pct: validation.medianApePct,
    oos_within_2x_pct: validation.within2xPct,
    loo_median_ape_pct: validation.looMedianApePct,
    loo_within_2x_pct: validation.looWithin2xPct,
    bootstrap_refits: BOOTSTRAP_REFITS,
    total_implied_usd: rows.reduce((a, r) => a + r.implied_value_usd, 0),
    verdict_counts: verdictCounts,
  };
  const compPoints = comps.map((p) => ({ slug: p.slug, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd as number, category: p.category }));
  return { rows, meta, comps: compPoints };
}

/** The data.js payload the dashboard reads (no fetch, works from file://). */
export function dataScript(rows: BoardRow[], meta: RadarMeta, comps: CompPoint[]): string {
  return `window.UNMINTED = ${JSON.stringify({ meta, rows, comps })};\n`;
}
