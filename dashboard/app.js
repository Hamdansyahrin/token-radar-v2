/* Unminted dashboard: board, filters, sorting, detail view. Data: window.UNMINTED from data.js. */
(function () {
  'use strict';
  var D = window.UNMINTED || { meta: {}, rows: [] };
  var meta = D.meta, rows = D.rows;
  var state = { q: '', cat: '', chain: '', verdict: '', watch: false, key: 'rank', dir: 1, detail: null };

  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function full(n) { return '$' + Number(n).toLocaleString('en-US'); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMast() {
    var v = meta.verdict_counts || { FARM: 0, THIN: 0, SKIP: 0 };
    $('mastStats').innerHTML =
      stat(meta.board_rows, 'board rows') + stat(meta.watchlist_covered + '/' + meta.watchlist_total, 'watchlist covered') +
      stat(meta.comps_count, 'traded comps') + stat(money(meta.total_implied_usd), 'total implied') +
      stat(v.FARM + ' / ' + v.THIN + ' / ' + v.SKIP, 'farm / thin / skip');
    function stat(b, s) { return '<div class="stat"><b>' + esc(b) + '</b><span>' + esc(s) + '</span></div>'; }
    $('methodStrip').innerHTML =
      '<b>Method, tested out of sample:</b> log(mcap/TVL) = ' + meta.fit_intercept + ' + ' + meta.fit_slope +
      ' &times; log(TVL) fitted on ' + meta.comps_count + ' traded comps (one per ticker), ' + meta.fit_categories_adjusted +
      ' category adjustments shrunk 50%. <b>5-fold test:</b> median error ' + meta.oos_median_ape_pct +
      '%, ' + meta.oos_within_2x_pct + '% of held-out comps priced within 2&times;. <b>Leave-one-out:</b> median error ' +
      meta.loo_median_ape_pct + '%, ' + meta.loo_within_2x_pct + '% within 2&times;. Rank ranges from ' +
      meta.bootstrap_refits + ' bootstrap refits. Snapshot as of ' + esc(meta.as_of) + ' &middot; ' + meta.protocols_total + ' protocols.';
  }

  function renderChart() {
    var comps = D.comps || [];
    if (!comps.length || !$('chart')) return;
    var W = 286, H = 208, PL = 34, PB = 20, PT = 8, PR = 6;
    var xs = comps.map(function (c) { return Math.log10(c.tvl_usd); });
    var ys = comps.map(function (c) { return Math.log10(c.mcap_usd / c.tvl_usd); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    function X(v) { return PL + (v - x0) / (x1 - x0) * (W - PL - PR); }
    function Y(v) { return PT + (y1 - v) / (y1 - y0) * (H - PT - PB); }
    var s = '<svg width="' + W + '" height="' + H + '">';
    for (var g = 0; g <= 4; g++) {
      var gy = PT + g * (H - PT - PB) / 4, gx = PL + g * (W - PL - PR) / 4;
      s += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="#1d3049"/>' +
        '<line x1="' + gx + '" y1="' + PT + '" x2="' + gx + '" y2="' + (H - PB) + '" stroke="#14263c"/>';
    }
    var pts = [];
    for (var i = 0; i <= 24; i++) {
      var tvl = Math.pow(10, x0 + (x1 - x0) * i / 24);
      var mult = Math.exp(meta.fit_intercept + meta.fit_slope * Math.log(tvl));
      pts.push(X(Math.log10(tvl)).toFixed(1) + ',' + Y(Math.log10(mult)).toFixed(1));
    }
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#3dff8e" stroke-width="2"/>';
    comps.forEach(function (c) {
      s += '<circle cx="' + X(Math.log10(c.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(c.mcap_usd / c.tvl_usd)).toFixed(1) +
        '" r="2.6" fill="#ffb224" opacity="0.85"><title>' + esc(c.slug) + '</title></circle>';
    });
    s += '<text x="' + PL + '" y="' + (H - 6) + '" fill="#8499ae" font-size="9">$' + Math.pow(10, x0).toExponential(0) + ' TVL</text>' +
      '<text x="' + (W - PR - 44) + '" y="' + (H - 6) + '" fill="#8499ae" font-size="9">$' + Math.pow(10, x1).toExponential(0) + '</text>' +
      '<text x="2" y="' + (PT + 8) + '" fill="#8499ae" font-size="9">' + Math.pow(10, y1).toFixed(1) + 'x</text>' +
      '<text x="2" y="' + (H - PB) + '" fill="#8499ae" font-size="9">' + Math.pow(10, y0).toFixed(2) + 'x</text></svg>';
    $('chart').innerHTML = s;
    var v = meta.verdict_counts || { FARM: 0, THIN: 0, SKIP: 0 };
    var tot = Math.max(1, v.FARM + v.THIN + v.SKIP);
    $('mix').innerHTML = [['FARM', v.FARM, '#3dff8e'], ['THIN', v.THIN, '#ffb224'], ['SKIP', v.SKIP, '#ff6b5e']].map(function (m) {
      return '<div class="mixrow"><span class="pill ' + m[0] + '">' + m[0] + '</span><div class="bar"><div class="fill" style="width:' +
        (m[1] / tot * 100).toFixed(1) + '%;background:' + m[2] + '"></div></div><span class="n">' + m[1] + '</span></div>';
    }).join('');
  }

  function fillSelects() {
    var cats = {}, chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = 1;
      (r.chains || []).forEach(function (c) { chains[c] = 1; });
    });
    $('catSel').innerHTML = '<option value="">All categories</option>' + Object.keys(cats).sort().map(function (c) {
      return '<option' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    $('chainSel').innerHTML = '<option value="">All chains</option>' + Object.keys(chains).sort().map(function (c) {
      return '<option' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    $('verdictSel').value = state.verdict;
    $('watchOnly').checked = state.watch;
    $('q').value = state.q;
  }

  function visible() {
    var q = state.q.toLowerCase();
    var list = rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (q && (r.name + ' ' + r.slug).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var k = state.key, dir = state.dir;
    list.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (x === null || x === undefined) x = -Infinity;
      if (y === null || y === undefined) y = -Infinity;
      if (typeof x === 'string') return dir * x.localeCompare(y);
      return dir * (x - y);
    });
    return list;
  }

  function renderBoard() {
    var list = visible();
    $('rowCount').textContent = 'Showing ' + list.length + ' of ' + rows.length + ' protocols';
    $('rows').innerHTML = list.map(function (r) {
      var chg = r.change_7d === null ? '—' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' +
        (r.change_7d >= 0 ? '+' : '') + Number(r.change_7d).toFixed(1) + '%</span>';
      var age = r.age_years === null ? '—' : Number(r.age_years).toFixed(1) + 'y';
      return '<tr data-slug="' + esc(r.slug) + '"><td class="rank">#' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span> <span class="pslug">' + esc(r.slug) + '</span>' +
        (r.on_watchlist ? '<span class="star">WATCHLIST</span>' : '') + '</td>' +
        '<td class="num">' + full(r.implied_value_usd) + '</td>' +
        '<td class="num range">#' + r.rank_low + '–#' + r.rank_high + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + chg + '</td>' +
        '<td class="num">' + age + '</td><td>' + esc(r.category || '—') + '</td>' +
        '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
    });
  }

  function openDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    state.detail = slug;
    document.body.classList.add('detail');
    $('boardView').hidden = true;
    $('detailView').hidden = false;
    var plan = r.farm_steps.map(function (s, i) {
      var last = i === r.farm_steps.length - 1;
      return '<li' + (last ? ' class="verdict"' : '') + '>' + esc(s) + '</li>';
    }).join('');
    $('detailBody').innerHTML =
      '<div class="dhead"><h2>' + esc(r.name) + '</h2><span class="pill ' + r.verdict + '">' + r.verdict + '</span>' +
      (r.on_watchlist ? '<span class="star">WATCHLIST</span>' : '') + '</div>' +
      '<p class="pslug">' + esc(r.slug) + ' &middot; ' + esc(r.category || 'Uncategorised') + ' &middot; ' +
      esc((r.chains || []).join(', ')) + '</p>' +
      '<div class="dgrid">' +
      card(full(r.implied_value_usd), 'implied launch value') +
      card('#' + r.rank + ' (range #' + r.rank_low + '–#' + r.rank_high + ')', 'rank of ' + rows.length) +
      card(money(r.tvl_usd), 'TVL') +
      card(r.change_7d === null ? '—' : Number(r.change_7d).toFixed(2) + '%', 'TVL change 7d') +
      card(r.listed_at || '—', 'tracked since') +
      card(full(r.est_cost_usd), 'est. 3-month farm cost') + '</div>' +
      '<div class="formula"><b>Model breakdown:</b> predicted FDV ' + full(r.predicted_fdv_usd) +
      ' = TVL ' + full(r.tvl_usd) + ' &times; fitted multiple ' + r.fitted_multiple +
      ' (comps curve for its size and category). Implied value = FDV &times; launch share ' +
      (r.launch_share * 100).toFixed(0) + '% &times; age factor ' + r.age_factor +
      ' &times; momentum factor ' + r.momentum_factor + ' = <b>' + full(r.implied_value_usd) + '</b>. ' +
      'Rank range #' + r.rank_low + '–#' + r.rank_high + ' is its 10th–90th percentile across ' +
      meta.bootstrap_refits + ' bootstrap refits of the comps fit.' +
      '<div class="rangebar"><div class="seg" style="left:' + ((r.rank_low - 1) / rows.length * 100) +
      '%;width:' + Math.max(1.5, (r.rank_high - r.rank_low + 1) / rows.length * 100) + '%"></div>' +
      '<div class="mark" style="left:' + ((r.rank - 0.5) / rows.length * 100) + '%"></div></div>' +
      '<div class="rangelab">Board span #1–#' + rows.length + ': green band = rank range across refits, amber tick = this rank.</div></div>' +
      '<div class="plan"><h3>FARM PLAN — ' + esc(r.name.toUpperCase()) + '</h3><ol>' + plan + '</ol></div>' +
      '<div class="plan"><h3>NEIGHBOURS ON THE BOARD</h3><table class="nbr"><tbody>' +
      rows.filter(function (x) { return Math.abs(x.rank - r.rank) <= 2; }).map(function (x) {
        return '<tr' + (x.slug === r.slug ? ' class="me"' : '') + '><td class="rank">#' + x.rank + '</td><td>' +
          esc(x.name) + '</td><td class="num">' + full(x.implied_value_usd) + '</td><td class="num range">#' +
          x.rank_low + '–#' + x.rank_high + '</td><td><span class="pill ' + x.verdict + '">' + x.verdict + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
    function card(b, s) { return '<div class="dcard"><b>' + esc(b) + '</b><span>' + esc(s) + '</span></div>'; }
    setHash();
    window.scrollTo(0, 0);
  }

  function closeDetail() {
    state.detail = null;
    document.body.classList.remove('detail');
    $('detailView').hidden = true;
    $('boardView').hidden = false;
    setHash();
  }

  function setHash() {
    var parts = [];
    if (state.detail) parts.push('detail=' + encodeURIComponent(state.detail));
    if (state.cat) parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.verdict) parts.push('verdict=' + encodeURIComponent(state.verdict));
    if (state.chain) parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.watch) parts.push('watch=1');
    history.replaceState(null, '', '#' + parts.join('&'));
  }

  function applyHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0], v = decodeURIComponent(p.slice(1).join('=') || '');
      if (k === 'cat') state.cat = v;
      else if (k === 'verdict') state.verdict = v;
      else if (k === 'chain') state.chain = v;
      else if (k === 'watch') state.watch = v === '1';
      else if (k === 'detail') state.detail = v;
    });
  }

  function bind() {
    $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    $('catSel').addEventListener('change', function (e) { state.cat = e.target.value; setHash(); renderBoard(); });
    $('chainSel').addEventListener('change', function (e) { state.chain = e.target.value; setHash(); renderBoard(); });
    $('verdictSel').addEventListener('change', function (e) { state.verdict = e.target.value; setHash(); renderBoard(); });
    $('watchOnly').addEventListener('change', function (e) { state.watch = e.target.checked; setHash(); renderBoard(); });
    $('backBtn').addEventListener('click', closeDetail);
    Array.prototype.forEach.call(document.querySelectorAll('thead th'), function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-key');
        if (state.key === k) state.dir = -state.dir;
        else { state.key = k; state.dir = k === 'rank' || k === 'name' || k === 'category' || k === 'verdict' ? 1 : -1; }
        renderBoard();
      });
    });
  }

  applyHash();
  renderMast();
  renderChart();
  fillSelects();
  bind();
  renderBoard();
  if (state.detail) openDetail(state.detail);
})();
