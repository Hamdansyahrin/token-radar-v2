// Unminted — Token Launch Radar (make.fun token-radar-01 entry).
//
// Reads the sealed snapshot, builds the ranked board with lib/model.ts,
// writes board.json and the dashboard's data.js into the output directory,
// copies dashboard/ and screenshots/ beside them, and finishes with the
// dossier the judge reads, built by vendor/makefun-board.ts.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, dataScript, type BoardRow, type Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = dirname(fileURLToPath(import.meta.url));

function argValue(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`unminted: ${message}\n`);
  process.exit(1);
}

/** Every gate-shaped promise this entry makes, checked before anything is written. */
function assertBoard(rows: BoardRow[], snapshot: Snapshot): void {
  if (rows.length < 100 || rows.length > 4000) fail(`board holds ${rows.length} rows, outside 100–4000`);
  const slugs = new Set(rows.map((r) => r.slug));
  if (slugs.size !== rows.length) fail('board holds a duplicate slug');
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of rows) if (!known.has(r.slug)) fail(`board invents slug ${r.slug}`);
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) fail(`watchlist slug missing from board: ${slug}`);
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  byRank.forEach((r, i) => {
    if (r.rank !== i + 1) fail(`ranks are not exactly 1..N (rank ${r.rank} at position ${i + 1})`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) fail(`row ${r.slug} has a bad implied value`);
    if (i > 0 && r.implied_value_usd > byRank[i - 1]!.implied_value_usd) fail(`implied value rises at rank ${r.rank}`);
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) fail(`row ${r.slug} has ${r.farm_steps.length} farm steps`);
    for (const step of r.farm_steps) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) fail(`row ${r.slug} has a farm step of ${t.length} chars`);
      if (!/\$\d/.test(t)) fail(`row ${r.slug} has a farm step with no dollar figure: ${t.slice(0, 60)}…`);
      if (!/\d+\s*(min|hour|week|month)/i.test(t)) fail(`row ${r.slug} has a farm step with no time figure: ${t.slice(0, 60)}…`);
    }
    if (r.rank_low > r.rank || r.rank_high < r.rank) fail(`row ${r.slug} rank range ${r.rank_low}–${r.rank_high} excludes its rank ${r.rank}`);
  });
}

/** Recursive copy of a directory's regular files, skipping dot-names. */
function copyTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) count += copyTree(src, dst);
    else if (statSync(src).isFile()) {
      copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

const inputArg = argValue('input', '/input/snapshot.json');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile} — pass --input <snapshot.json>`);
const outDir = argValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const started = Date.now();
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8')) as Snapshot;
const { rows, meta, comps } = buildRadar(snapshot);
assertBoard(rows, snapshot);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ meta, rows }, null, 1)}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(rows, meta, comps));
const dashFiles = copyTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles < 3) fail(`screenshots/ holds ${shotFiles} images; the entry hands in exactly 3`);
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));

const secs = ((Date.now() - started) / 1000).toFixed(2);
process.stdout.write(
  `unminted: ${meta.protocols_total} protocols, board ${meta.board_rows} rows, watchlist ${meta.watchlist_covered}/${meta.watchlist_total}, comps ${meta.comps_count} (of ${meta.comps_raw} eligible before de-dup)\n` +
    `unminted: fit log(mcap/TVL) = ${meta.fit_intercept} + ${meta.fit_slope} * log(TVL), ${meta.fit_categories_adjusted} categories adjusted; out-of-sample median APE ${meta.oos_median_ape_pct}%, within 2x ${meta.oos_within_2x_pct}%; LOO median APE ${meta.loo_median_ape_pct}%\n` +
    `unminted: total implied $${meta.total_implied_usd.toLocaleString('en-US')}; verdicts FARM ${meta.verdict_counts.FARM} / THIN ${meta.verdict_counts.THIN} / SKIP ${meta.verdict_counts.SKIP}; dashboard ${dashFiles} files, screenshots ${shotFiles}; ran in ${secs}s\n`,
);
