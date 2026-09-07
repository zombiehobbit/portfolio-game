/* Price proxy. Fetches daily closes from Stooq server-side, which sidesteps CORS
   and gets same-day data. No key, no quota. Undocumented endpoint, so every
   failure path returns JSON with a reason rather than throwing.

   GET /api/prices?symbols=chg.uk,sgln.uk&days=140
   GET /api/prices?symbols=chg.uk&debug=1     -> also reports what Stooq actually said */

const MAX_SYMBOLS = 30;
const BATCH = 4;          // Stooq is a small site; do not hammer it
const TIMEOUT_MS = 8000;

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
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

async function grab(sym, d1, d2, notes) {
  const src = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sym) + '&d1=' + d1 + '&d2=' + d2 + '&i=d';
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(src, {
      signal: control.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; portfolio-game/1.0)',
        'Accept': 'text/csv,text/plain,*/*'
      }
    });
    const text = await res.text();
    if (!res.ok) {
      notes.push(sym + ': HTTP ' + res.status);
      return null;
    }
    const rows = parseCsv(text);
    if (!rows) {
      notes.push(sym + ': ' + JSON.stringify(text.slice(0, 120)));
      return null;
    }
    return rows;
  } catch (e) {
    notes.push(sym + ': ' + (e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e)));
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    const notes = [];
    let asOf = null;

    for (let i = 0; i < symbols.length; i += BATCH) {
      const slice = symbols.slice(i, i + BATCH);
      const rows = await Promise.all(slice.map(s => grab(s, d1, d2, notes)));
      slice.forEach((sym, k) => {
        const r = rows[k];
        if (!r) { missing.push(sym); return; }
        series[sym] = r;
        const last = r[r.length - 1].d;
        if (!asOf || last > asOf) asOf = last;
      });
    }

    const body = { asOf: asOf, series: series, missing: missing };
    if (debug) body.notes = notes;

    if (!Object.keys(series).length) {
      body.error = 'Stooq returned nothing usable. ' + (notes[0] || 'No detail.');
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    return new Response(JSON.stringify(body), { headers });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Proxy failed: ' + String(e && e.message || e) }),
      { status: 200, headers });
  }
}
