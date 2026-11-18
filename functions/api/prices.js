/* Price proxy. Fetches daily closes server-side, which sidesteps CORS and gets
   same-day data. Two sources, tried in order:

     1. Stooq   https://stooq.com/q/d/l/   CSV, no key, no quota
     2. Yahoo   query1.finance.yahoo.com   JSON, no key

   Yahoo is tried first. Stooq has never answered from Cloudflare's egress —
   every symbol times out — so it is kept only as a long-shot second source for
   the day Yahoo breaks, and costs nothing while Yahoo is working.

   Both are undocumented, so every failure path returns JSON with a reason
   rather than throwing, and the response says which source each symbol came
   from. Symbols are given in Stooq form (ba.uk) and mapped to Yahoo (BA.L).

   GET /api/prices?symbols=chg.uk,sgln.uk&days=140
   GET /api/prices?symbols=chg.uk&debug=1     -> also reports what each source said
   GET /api/prices?symbols=chg.uk&source=yahoo -> force one source (stooq|yahoo) */

const MAX_SYMBOLS = 30;
const BATCH = 4;          // these are small sites; do not hammer them
const TIMEOUT_MS = 6000;  // per request, per source

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 'ba.uk' -> 'BA.L', 'tw.uk' -> 'TW.L'. Anything not .uk is passed through upper-cased. */
function yahooSymbol(sym) {
  const m = /^(.+)\.uk$/.exec(sym);
  return m ? m[1].toUpperCase() + '.L' : sym.toUpperCase();
}

function rangeFor(days) {
  if (days <= 35) return '1mo';
  if (days <= 95) return '3mo';
  if (days <= 190) return '6mo';
  return '1y';
}

async function get(src, accept, timeoutMs) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetch(src, {
      signal: control.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; portfolio-game/1.1)',
        'Accept': accept
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text };
  } finally {
    clearTimeout(timer);
  }
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const head = lines[0].toLowerCase();
  if (head.indexOf('date') === -1 || head.indexOf('close') === -1) return null;
  const cols = head.split(',');
  const iDate = cols.indexOf('date');
  const iClose = cols.indexOf('close');
  if (iDate === -1 || iClose === -1) return null;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const d = parts[iDate];
    const c = parseFloat(parts[iClose]);
    if (d && isFinite(c) && c > 0) out.push({ d: d, c: c });
  }
  return out.length ? out : null;
}

async function grabStooq(sym, d1, d2, notes) {
  const src = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym) + '&d1=' + d1 + '&d2=' + d2 + '&i=d';
  try {
    const r = await get(src, 'text/csv,text/plain,*/*', TIMEOUT_MS);
    if (!r.ok) { notes.push(sym + ' stooq: HTTP ' + r.status); return null; }
    const rows = parseCsv(r.text);
    if (!rows) { notes.push(sym + ' stooq: ' + JSON.stringify(r.text.slice(0, 100))); return null; }
    return rows;
  } catch (e) {
    notes.push(sym + ' stooq: ' + (e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e)));
    return null;
  }
}

async function grabYahoo(sym, days, notes) {
  const ysym = yahooSymbol(sym);
  const src = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(ysym) + '?interval=1d&range=' + rangeFor(days);
  try {
    const r = await get(src, 'application/json,*/*', TIMEOUT_MS);
    if (!r.ok) { notes.push(sym + ' yahoo(' + ysym + '): HTTP ' + r.status); return null; }

    let j;
    try { j = JSON.parse(r.text); } catch (e) {
      notes.push(sym + ' yahoo(' + ysym + '): not JSON, ' + JSON.stringify(r.text.slice(0, 80)));
      return null;
    }

    const err = j && j.chart && j.chart.error;
    if (err) {
      notes.push(sym + ' yahoo(' + ysym + '): ' + (err.description || err.code || 'error'));
      return null;
    }

    const result = j && j.chart && j.chart.result && j.chart.result[0];
    if (!result) { notes.push(sym + ' yahoo(' + ysym + '): no result'); return null; }

    /* LSE lines normally quote in pence, which is what Stooq gives and what the
       app expects. If Yahoo ever hands back pounds for a line, say so rather
       than silently returning a number a hundred times too small. */
    const cur = result.meta && result.meta.currency;
    if (cur && cur !== 'GBp' && cur !== 'GBX') {
      notes.push(sym + ' yahoo(' + ysym + '): currency is ' + cur + ', not pence — skipped');
      return null;
    }

    const ts = result.timestamp || [];
    const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    const closes = (quote && quote.close) || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (!isFinite(c) || c <= 0) continue;
      out.push({ d: iso(new Date(ts[i] * 1000)), c: c });
    }
    if (!out.length) { notes.push(sym + ' yahoo(' + ysym + '): no usable closes'); return null; }
    return out;
  } catch (e) {
    notes.push(sym + ' yahoo(' + ysym + '): ' + (e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e)));
    return null;
  }
}

/* Yahoo first, Stooq if it gives nothing. Returns { rows, from } or null. */
async function grab(sym, d1, d2, days, notes, only) {
  if (only !== 'stooq') {
    const rows = await grabYahoo(sym, days, notes);
    if (rows) return { rows: rows, from: 'yahoo' };
    if (only === 'yahoo') return null;
  }
  const rows = await grabStooq(sym, d1, d2, notes);
  return rows ? { rows: rows, from: 'stooq' } : null;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': url.origin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS'
  };

  try {
    if (context.request.method === 'OPTIONS') return new Response(null, { headers });
    if (context.request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Use GET.' }), { status: 405, headers });
    }

    const raw = (url.searchParams.get('symbols') || '').trim();
    const debug = url.searchParams.get('debug') === '1';
    const onlyRaw = (url.searchParams.get('source') || '').trim().toLowerCase();
    const only = (onlyRaw === 'stooq' || onlyRaw === 'yahoo') ? onlyRaw : null;

    if (!raw) {
      return new Response(JSON.stringify({ error: 'No symbols given.' }), { status: 400, headers });
    }

    const symbols = raw.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => /^[a-z0-9._-]{1,20}$/.test(s))
      .slice(0, MAX_SYMBOLS);
    if (!symbols.length) {
      return new Response(JSON.stringify({ error: 'No usable symbols.' }), { status: 400, headers });
    }

    const days = Math.min(400, Math.max(30, parseInt(url.searchParams.get('days') || '140', 10)));
    const end = new Date();
    const start = new Date(end.getTime() - days * 864e5);
    const d1 = ymd(start), d2 = ymd(end);

    const series = {};
    const sources = {};
    const missing = [];
    const notes = [];
    let asOf = null;

    for (let i = 0; i < symbols.length; i += BATCH) {
      const slice = symbols.slice(i, i + BATCH);
      const got = await Promise.all(slice.map(s => grab(s, d1, d2, days, notes, only)));
      slice.forEach((sym, k) => {
        const hit = got[k];
        if (!hit) { missing.push(sym); return; }
        series[sym] = hit.rows;
        sources[sym] = hit.from;
        const last = hit.rows[hit.rows.length - 1].d;
        if (!asOf || last > asOf) asOf = last;
      });
    }

    const body = { asOf: asOf, series: series, sources: sources, missing: missing };
    if (debug) body.notes = notes;

    if (!Object.keys(series).length) {
      body.error = 'Neither Stooq nor Yahoo returned anything usable. ' + (notes[0] || 'No detail.');
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    return new Response(JSON.stringify(body), { headers });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Proxy failed: ' + String(e && e.message || e) }),
      { status: 200, headers });
  }
}
