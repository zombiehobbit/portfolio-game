/* Price proxy. Fetches daily closes from Stooq server-side, which sidesteps CORS
   and gets same-day data. No key, no quota. Undocumented endpoint, so treat a
   failure as routine and fall back to another source rather than erroring hard.

   GET /api/prices?symbols=chg.uk,sgln.uk&days=140
   -> { asOf: "2026-09-07", series: { "chg.uk": [{d,c}, ...] }, missing: ["..."] } */

const MAX_SYMBOLS = 30;

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function parseCsv(text) {
  // Date,Open,High,Low,Close,Volume  — oldest first
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

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': url.origin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS'
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Use GET.' }), { status: 405, headers });
  }

  const raw = (url.searchParams.get('symbols') || '').trim();
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
  const missing = [];
  let asOf = null;

  await Promise.all(symbols.map(async function (sym) {
    try {
      const src = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym)
        + '&d1=' + d1 + '&d2=' + d2 + '&i=d';
      const res = await fetch(src, {
        headers: { 'User-Agent': 'portfolio-game/1.0 (personal use)' },
        cf: { cacheTtl: 900, cacheEverything: true }
      });
      if (!res.ok) { missing.push(sym); return; }
      const rows = parseCsv(await res.text());
      if (!rows) { missing.push(sym); return; }
      series[sym] = rows;
      const last = rows[rows.length - 1].d;
      if (!asOf || last > asOf) asOf = last;
    } catch (e) {
      missing.push(sym);
    }
  }));

  if (!Object.keys(series).length) {
    return new Response(JSON.stringify({ error: 'No data came back for any symbol.', missing: missing }),
      { status: 502, headers });
  }

  return new Response(JSON.stringify({ asOf: asOf, series: series, missing: missing }), { headers });
}
