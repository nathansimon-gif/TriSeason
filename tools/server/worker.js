// Petit serveur TriSeason (Cloudflare Workers, offre gratuite).
//
// Rôle : garder la clé secrète de l'appli Strava hors du site. Il échange le
// code d'autorisation contre des jetons, les renouvelle et retire l'accès.
// Il relaie aussi la recherche d'aliments Open Food Facts (leur nouvelle
// recherche n'accepte pas les appels directs depuis un navigateur).
// Il n'enregistre rien et ne lit aucune séance.
//
// Réglages (Cloudflare → le Worker → Paramètres → Variables et secrets) :
//   STRAVA_CLIENT_ID      texte  : l'ID client de l'appli Strava
//   STRAVA_CLIENT_SECRET  secret : le secret client (jamais ailleurs)
//   ALLOWED_ORIGIN        texte  : l'adresse du site, ex. https://nathansimon-gif.github.io
//                                  (plusieurs possibles, séparées par des virgules)

const OFF_FIELDS = 'code,product_name,product_name_fr,brands,nutriments,serving_quantity';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    } : {};
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json', ...cors },
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (!okOrigin) return json({ error: 'Site non autorisé.' }, 403);

    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/off/search') {
        return json(await offSearch(new URL(request.url).searchParams.get('q') || ''));
      }
      if (request.method !== 'POST') return json({ error: 'Adresse inconnue.' }, 404);
      const body = await request.json().catch(() => ({}));

      if (path === '/strava/token' || path === '/strava/refresh') {
        if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) return json({ error: 'Serveur TriSeason pas encore configuré (clés Strava).' }, 500);
        const isCode = path === '/strava/token';
        const value = isCode ? body.code : body.refresh_token;
        if (!value || typeof value !== 'string') return json({ error: 'Demande incomplète.' }, 400);
        const res = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET,
            grant_type: isCode ? 'authorization_code' : 'refresh_token',
            [isCode ? 'code' : 'refresh_token']: value,
          }),
        });
        const t = await res.json().catch(() => ({}));
        // Limite d'athlètes connectés atteinte (10 tant que Strava n'a pas validé l'appli)
        if (res.status === 403 && /limit of connected athletes/i.test(JSON.stringify(t))) {
          return json({ error: 'Limite d’athlètes connectés atteinte chez Strava.', code: 'athlete_limit' }, 403);
        }
        if (!res.ok || !t.access_token) return json({ error: 'Strava a refusé la connexion (' + res.status + '). Réessaie.' }, 502);
        const a = t.athlete || {};
        return json({
          access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at,
          ...(isCode ? { athlete: { id: a.id, firstname: a.firstname, lastname: a.lastname } } : {}),
        });
      }

      if (path === '/strava/deauthorize') {
        if (!body.access_token) return json({ error: 'Demande incomplète.' }, 400);
        const res = await fetch('https://www.strava.com/oauth/deauthorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ access_token: body.access_token }),
        });
        return json({ ok: res.ok });
      }
      return json({ error: 'Adresse inconnue.' }, 404);
    } catch (err) {
      return json({ error: 'Erreur du serveur TriSeason.' }, 500);
    }
  },
};

// Recherche d'aliments : nouvelle recherche Open Food Facts (rapide), sinon
// l'ancienne (souvent saturée). Résultat au format de l'ancienne : { products }.
export async function offSearch(q) {
  q = q.trim().slice(0, 100);
  if (!q) return { products: [] };
  try {
    const url = 'https://search.openfoodfacts.org/search?page_size=20&langs=fr&fields=' + OFF_FIELDS + '&q=' + encodeURIComponent(q);
    const res = await fetchWithTimeout(url, 8000);
    if (res.ok) {
      const data = await res.json();
      const products = (data.hits || []).map(normalizeHit);
      if (products.length) return { products, source: 'search' };
    }
  } catch (e) { /* on passe à l'ancienne recherche */ }
  for (let i = 0; i < 2; i++) {
    try {
      const url = 'https://world.openfoodfacts.org/cgi/search.pl?action=process&json=1&search_simple=1&page_size=20&lc=fr'
        + '&fields=' + OFF_FIELDS + '&search_terms=' + encodeURIComponent(q);
      const res = await fetchWithTimeout(url, 10000);
      if (res.ok) { const data = await res.json(); return { products: data.products || [], source: 'legacy' }; }
    } catch (e) { /* nouvel essai */ }
  }
  throw new Error('Open Food Facts indisponible');
}

// Les champs de la nouvelle recherche peuvent être des listes ou des objets par langue.
function pick(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return v.fr || v.main || Object.values(v)[0] || '';
  return String(v);
}
function normalizeHit(h) {
  return { code: h.code, product_name: pick(h.product_name_fr) || pick(h.product_name), brands: pick(h.brands),
    nutriments: h.nutriments || {}, serving_quantity: h.serving_quantity };
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TriSeason/1.0 (tri.season.tracker@gmail.com)' } });
  } finally { clearTimeout(timer); }
}
