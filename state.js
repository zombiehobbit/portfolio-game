/* Sync and spectating. Needs a KV namespace bound as STATE in the Pages project.

   GET  /api/state?code=...   -> { updated, data }        full, needs the private code
   GET  /api/state?view=...   -> { updated, data }        read-only, needs the view code
   PUT  /api/state?code=...   -> { ok: true, view: "..." }

   A PUT writes two copies: the private slot, and a read-only slot under a code
   derived from the private one by hashing. The derivation is one way, so a view
   code can never be turned back into write access. PUT to a view slot is refused. */

const MAX = 512 * 1024;

function badCode(code) {
  return !code || code.length < 12 || code.length > 128 || !/^[\w-]+$/.test(code);
}

async function viewCodeFor(code) {
  const bytes = new TextEncoder().encode('portfolio-view:' + code);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].slice(0, 9)
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.replace(/(.{6})(?=.)/g, '$1-');
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const view = url.searchParams.get('view');

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': url.origin,
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  if (!env.STATE) {
    return new Response(JSON.stringify({ error: 'Sync is not set up on this site yet.' }),
      { status: 501, headers });
  }

  /* ---- spectating: read only, by construction ---- */
  if (request.method === 'GET' && view) {
    if (!/^[\w-]{8,64}$/.test(view)) {
      return new Response(JSON.stringify({ error: 'That is not a view code.' }), { status: 400, headers });
    }
    const hit = await env.STATE.get('view:' + view);
    if (!hit) {
      return new Response(JSON.stringify({ error: 'No one is sharing under that code yet.' }), { status: 404, headers });
    }
    return new Response(hit, { headers });
  }

  if (badCode(code)) {
    return new Response(JSON.stringify({ error: 'Sync code must be 12 or more letters, numbers, dashes or underscores.' }),
      { status: 400, headers });
  }

  const slot = 'state:' + code;

  if (request.method === 'GET') {
    const hit = await env.STATE.get(slot);
    if (!hit) return new Response(JSON.stringify({ error: 'nothing stored' }), { status: 404, headers });
    return new Response(hit, { headers });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX) {
      return new Response(JSON.stringify({ error: 'Too large to sync.' }), { status: 413, headers });
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      return new Response(JSON.stringify({ error: 'Not valid JSON.' }), { status: 400, headers });
    }

    const vc = await viewCodeFor(code);
    await env.STATE.put(slot, body);

    // The shared copy carries only what a spectator needs: no key, no sync code, no chart history.
    const d = (parsed && parsed.data) || {};
    const strip = function (book) {
      if (!book) return null;
      return {
        name: book.name,
        cash: book.cash || 0,
        positions: (book.positions || []).map(function (p) {
          return { name: p.name, ticker: p.ticker, cost: p.cost, entry: p.entry, now: p.now, note: p.note };
        })
      };
    };
    const shared = {
      updated: parsed.updated || Date.now(),
      data: {
        books: {
          screened: strip(d.books && d.books.screened),
          defence: strip(d.books && d.books.defence)
        }
      }
    };
    await env.STATE.put('view:' + vc, JSON.stringify(shared));

    return new Response(JSON.stringify({ ok: true, view: vc }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Use GET or PUT.' }), { status: 405, headers });
}
