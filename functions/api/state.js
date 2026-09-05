/* Cross-device sync. Needs a KV namespace bound as STATE in the Pages project.
   GET  /api/state?code=...  -> { updated, data } or 404
   PUT  /api/state?code=...  -> stores { updated, data }
   The code is a passphrase you choose. Anyone with it can read and write, so
   make it long. Nothing sensitive is stored: no key, no real money, no accounts. */

const MAX = 512 * 1024;

function badCode(code) {
  return !code || code.length < 12 || code.length > 128 || !/^[\w-]+$/.test(code);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

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
    try { JSON.parse(body); } catch (e) {
      return new Response(JSON.stringify({ error: 'Not valid JSON.' }), { status: 400, headers });
    }
    await env.STATE.put(slot, body);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return new Response(JSON.stringify({ error: 'Use GET or PUT.' }), { status: 405, headers });
}
