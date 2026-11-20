import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';

// ---- owner access: one shared secret ----
// The browser signs in once at /login (HttpOnly cookie); the QwenWork agent sends
// `Authorization: Bearer <APP_TOKEN>`. Without APP_TOKEN set, nothing private is served.
const APP_TOKEN = process.env.APP_TOKEN || '';
const SESSION_COOKIE = 'relate_session';
const SESSION_VALUE = APP_TOKEN ? createHmac('sha256', APP_TOKEN).update('relate-session-v1').digest('hex') : '';
if (!APP_TOKEN) console.warn('APP_TOKEN is not set: the workspace and its API stay locked until it is.');

const sha = s => createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => !!a && !!b && timingSafeEqual(sha(a), sha(b));

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!APP_TOKEN) return false;
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ') && sameSecret(auth.slice(7).trim(), APP_TOKEN)) return true;
  return sameSecret(cookies(req)[SESSION_COOKIE], SESSION_VALUE);
}

const isHttps = req => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Pages and actions a recipient opens from a shared link: the unguessable id in the URL is the access.
const PUBLIC_ROUTES = [
  ['GET', /^\/deck\/[0-9a-f-]{36}$/i],
  ['GET', /^\/talk\/[0-9a-f-]{36}$/i],
  ['GET', /^\/share\/[0-9a-f-]{36}$/i],
  ['GET', /^\/api\/deck\/[0-9a-f-]{36}\/pdf$/i],
  ['POST', /^\/api\/deck\/[0-9a-f-]{36}\/accept$/i],
  ['PATCH', /^\/api\/talk\/[0-9a-f-]{36}\/pick$/i]
];
const isPublicRoute = (method, p) => PUBLIC_ROUTES.some(([m, re]) => m === method && re.test(p));

// relationship columns the app may change through PATCH /api/relationships/:id
const REL_PATCH_FIELDS = ['name', 'met_context', 'note', 'contact', 'profile_card', 'assessment', 'deck_job_id', 'next_action', 'brief', 'card'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// base64 PDF stored either raw or as a data: URI
const pdfBuffer = s => Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}

function loginPage(message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relate — sign in</title>
<style>
body{background:#0b0e14;color:#e8ecf4;font-family:system-ui,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
form{max-width:380px;width:100%;background:#11151f;border:1px solid #232b3d;border-radius:18px;padding:30px 32px}
h1{font-size:20px;margin:0 0 6px} p{color:#8b95a7;font-size:13.5px;margin:0 0 18px;line-height:1.5}
input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:10px;border:1px solid #232b3d;background:#0b0e14;color:#e8ecf4;font-size:15px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:10px;background:linear-gradient(135deg,#6c8cff,#8f6cff);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#ff7a90;font-size:13px;margin-top:12px}
</style></head><body><form method="POST" action="/login">
<h1>Relate</h1><p>Your relationship workspace is private. Enter your access token to continue.</p>
<input type="password" name="token" placeholder="Access token" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
${message ? `<div class="err">${esc(message)}</div>` : ''}
</form></body></html>`;
}

// ---- Supabase REST helper (credentials injected by the Page runtime) ----
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

async function sb(method, table, { body, query } = {}) {
  if (!SB_URL || !SB_KEY) {
    const err = new Error('database not configured — set SUPABASE_URL and SUPABASE_ANON_KEY (locally these are missing; the deployed page injects them)');
    err.expose = true;
    throw err;
  }
  const url = new URL(`${SB_URL}/rest/v1/${table}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`supabase ${method} ${table}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ---- research ----
// No canned research: every relationship starts unresearched. When the client
// saves, it queues a research job (POST /api/research); the QwenWork agent
// web-searches that person and PUTs findings back with sources and gap-flags.

// ---- tiny router ----
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// bodies carry base64 media (PDF up to 8 MB, images/audio up to 6 MB), so cap at 12 MB
const MAX_BODY = 12 * 1024 * 1024;

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large'); // rest is discarded; the reply closes the connection
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch { throw new HttpError(400, 'request body must be a JSON object'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const authed = isAuthed(req);

  try {
    // ---- sign in / out ----
    if (p === '/login' && req.method === 'GET') {
      if (authed) { res.writeHead(302, { Location: '/' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage(APP_TOKEN ? '' : 'Sign-in is disabled: set the APP_TOKEN environment variable on the server.'));
    }
    if (p === '/login' && req.method === 'POST') {
      const token = new URLSearchParams(await readRaw(req)).get('token') || '';
      if (!APP_TOKEN || !sameSecret(token, APP_TOKEN)) {
        await new Promise(r => setTimeout(r, 600)); // slow down guessing
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(APP_TOKEN ? 'That token is not right.' : 'Sign-in is disabled: set APP_TOKEN on the server.'));
      }
      const secure = isHttps(req) ? '; Secure' : '';
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${SESSION_COOKIE}=${SESSION_VALUE}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`
      });
      return res.end();
    }
    if (p === '/logout') {
      res.writeHead(302, { Location: '/login', 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
      return res.end();
    }

    // everything else is the owner's, except the recipient pages behind shared links
    if (!authed && !isPublicRoute(req.method, p)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'sign in required' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (p === '/' || p === '/index.html') {
      const html = await readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ---- OCR jobs (card images queued for the QwenWork agent) ----
    if (p === '/api/ocr' && req.method === 'GET') {
      const rows = await sb('GET', 'ocr_jobs', { query: { select: 'id,status,fields,created_at', order: 'created_at.desc', limit: '20' } });
      return json(res, 200, rows);
    }
    if (p === '/api/ocr' && req.method === 'POST') {
      const { image } = await readBody(req);
      if (!image) return json(res, 400, { error: 'image required' });
      if (image.length > 6_000_000) return json(res, 413, { error: 'image too large' });
      const rows = await sb('POST', 'ocr_jobs', { body: { image } });
      return json(res, 201, rows[0]);
    }

    const o = p.match(/^\/api\/ocr\/([0-9a-f-]{36})(\/image)?$/i);
    if (o) {
      const id = o[1];
      // agent path: retrieve the queued card image
      if (req.method === 'GET' && p.endsWith('/image')) {
        const rows = await sb('GET', 'ocr_jobs', { query: { id: `eq.${id}`, select: 'image' } });
        if (!rows[0]) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ image: rows[0].image }));
      }
      if (req.method === 'GET') {
        const rows = await sb('GET', 'ocr_jobs', { query: { id: `eq.${id}`, select: 'id,status,fields,created_at' } });
        return json(res, 200, rows[0] || { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const { fields, status } = await readBody(req);
        const rows = await sb('PATCH', 'ocr_jobs', { query: { id: `eq.${id}` }, body: { fields: fields || null, status: status || 'done' } });
        return json(res, 200, rows[0]);
      }
    }

    // ---- user profile (initial setup context for the agent) ----
    if (p === '/api/profile') {
      if (req.method === 'GET') {
        const rows = await sb('GET', 'profiles', { query: { id: 'eq.me', select: 'id,name,role,offer,looking,tone,linkedin_url,linkedin_card,photo,updated_at' } });
        return json(res, 200, rows[0] || null);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body.name) return json(res, 400, { error: 'name is required' });
        const { name, role, offer, looking, tone, linkedin_url, linkedin_card, photo } = body;
        if (photo && photo.length > 1_500_000) return json(res, 413, { error: 'photo too large' });
        const rows = await sb('PATCH', 'profiles', {
          query: { id: 'eq.me' },
          body: { name, role: role || null, offer: offer || null, looking: looking || null, tone: tone || null,
            linkedin_url: linkedin_url || null, linkedin_card: linkedin_card || null, photo: photo || null, updated_at: new Date().toISOString() }
        });
        return json(res, 200, rows[0]);
      }
    }

    // GET /api/relationships — list
    if (req.method === 'GET' && p === '/api/relationships') {
      const rows = await sb('GET', 'relationships', { query: { select: '*', order: 'created_at.desc' } });
      return json(res, 200, rows);
    }

    // POST /api/relationships — create from conversation note
    if (req.method === 'POST' && p === '/api/relationships') {
      const { name, met_context, note, contact, profile_card } = await readBody(req);
      if (!name || !note) return json(res, 400, { error: 'name and note are required' });
      const rows = await sb('POST', 'relationships', {
        body: { name, met_context: met_context || '', note, contact: contact || {}, research: [], profile_card: profile_card || null }
      });
      return json(res, 201, rows[0]);
    }

    // ---- settings (Exa / AI keys stored server-side, never returned in full) ----
    async function getSettings() {
      const rows = await sb('GET', 'settings', { query: { id: 'eq.me', select: 'exa_key,ai_provider,ai_key' } });
      return rows[0] || {};
    }
    function mask(token) {
      if (!token) return null;
      return { set: true, last4: token.slice(-4) };
    }
    if (p === '/api/settings' && req.method === 'GET') {
      const s = await getSettings();
      return json(res, 200, { exa_key: mask(s.exa_key), ai_provider: s.ai_provider || null, ai_key: mask(s.ai_key) });
    }
    if (p === '/api/settings' && req.method === 'PUT') {
      const { exa_key, ai_provider, ai_key } = await readBody(req);
      const body = { updated_at: new Date().toISOString() };
      if (typeof exa_key === 'string') body.exa_key = exa_key || null;
      if (typeof ai_provider === 'string') body.ai_provider = ai_provider || null;
      if (typeof ai_key === 'string') body.ai_key = ai_key || null;
      await sb('PATCH', 'settings', { query: { id: 'eq.me' }, body });
      const s = await getSettings();
      return json(res, 200, { exa_key: mask(s.exa_key), ai_provider: s.ai_provider || null, ai_key: mask(s.ai_key) });
    }
    // verify an Exa key without storing it
    if (p === '/api/settings/test-exa' && req.method === 'POST') {
      const { exa_key } = await readBody(req);
      const key = exa_key || (await getSettings()).exa_key;
      if (!key) return json(res, 400, { ok: false, error: 'no key provided or stored' });
      try {
        const r = await fetch('https://api.exa.ai/search', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
          body: JSON.stringify({ query: 'LinkedIn', numResults: 1 })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json(res, 200, { ok: false, error: `Exa responded ${r.status}: ${String(d.detail || d.error || r.statusText || '').slice(0, 120)}` });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }

    // ---- Exa.ai direct: ask for a structured JSON overview of the person, grounded on their LinkedIn URL ----
    async function exaSearchLinkedIn(name) {
      // find someone's LinkedIn profile URL by name via Exa search
      const s = await getSettings();
      if (!s.exa_key) return { error: 'no exa key configured' };
      try {
        const r = await fetch('https://api.exa.ai/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({ query: `${name} LinkedIn profile`, numResults: 3, includeSites: ['linkedin.com'] })
        });
        if (!r.ok) return { error: `exa search failed (${r.status})` };
        const d = await r.json();
        const hit = (d.results || []).find(x => /linkedin\.com\/in\//i.test(x.url || ''));
        if (!hit) return { error: 'exa found no LinkedIn profile for that name' };
        return { url: hit.url.split('?')[0], title: hit.title || null };
      } catch (e) { return { error: 'exa search failed: ' + e.message }; }
    }
    // instant research via Exa answer: what they're known for, with cited sources.
    // Exa's citations are not ordered to match the highlights, so each highlight names its own
    // source URL and we only mark it "sourced" when that URL is one Exa actually cited.
    async function exaResearch(name, linkedinUrl) {
      const s = await getSettings();
      if (!s.exa_key || !name) return [];
      try {
        const r = await fetch('https://api.exa.ai/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({
            query: `What is ${name} known for professionally? Key projects, roles and public presence. Keep each point under 20 words. ${linkedinUrl ? `Their LinkedIn: ${linkedinUrl}.` : ''}`,
            systemPrompt: 'Only verifiable public information. Omit anything uncertain. For every highlight, give the URL of the cited page it comes from in source_url.',
            model: 'exa-fast',
            outputSchema: {
              type: 'object',
              properties: {
                highlights: {
                  type: 'array',
                  items: { type: 'object', properties: { text: { type: 'string' }, source_url: { type: 'string' } }, required: ['text', 'source_url'] }
                }
              },
              required: ['highlights']
            }
          })
        });
        if (!r.ok) return [];
        const d = await r.json();
        let a = d.answer;
        if (typeof a === 'string') { const m = a.match(/\{[\s\S]*\}/); a = m ? JSON.parse(m[0]) : null; }
        const norm = u => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
        const cites = new Map((d.citations || []).filter(c => c && c.url).map(c => [norm(c.url), c]));
        const highlights = (a && Array.isArray(a.highlights)) ? a.highlights : [];
        return highlights.slice(0, 5).map(h => {
          const text = typeof h === 'string' ? h : (h && h.text);
          const cite = h && typeof h === 'object' ? cites.get(norm(h.source_url)) : null;
          return cite
            ? { finding: String(text || ''), source: cite.title || cite.url, url: cite.url, status: 'sourced' }
            : { finding: String(text || ''), source: 'no matching citation — verify', url: null, status: 'gap flagged' };
        }).filter(x => x.finding);
      } catch (e) { return []; }
    }

    async function exaProfileCard(linkedinUrl, name) {
      const s = await getSettings();
      if (!s.exa_key) return { error: 'no exa key configured' };
      try {
        const r = await fetch('https://api.exa.ai/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({
            query: `Build a profile summary for the person at this LinkedIn profile URL: ${linkedinUrl}${name ? ` (their name is ${name})` : ''}.`,
            systemPrompt: 'Use the given LinkedIn profile URL as the primary source. Only include facts found on that profile; keep "about" to max 2 sentences. Leave a field empty if not found.',
            model: 'exa-fast',
            outputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string' }, headline: { type: 'string' }, role: { type: 'string' },
                location: { type: 'string' }, about: { type: 'string' }, company: { type: 'string' }
              },
              required: ['name'],
              additionalProperties: false
            }
          })
        });
        if (!r.ok) return { error: `exa answer failed (${r.status}): ${(await r.text()).slice(0, 200)}` };
        const d = await r.json();
        // profile photo: Exa citations can carry an image (often the profile's og:image)
        const photo = (d.citations || []).map(c => c.image).find(u => u && /^https?:\/\//.test(u)) || null;
        let c = d.answer;
        if (typeof c === 'string') { const m = c.match(/\{[\s\S]*\}/); c = m ? JSON.parse(m[0]) : null; }
        if (!c || typeof c !== 'object') return { error: 'exa returned no structured answer' };
        const pick = k => (typeof c[k] === 'string' && c[k].trim()) ? c[k].trim() : null;
        const card = {
          name: pick('name') || name || null,
          headline: pick('headline'),
          role: pick('role') || pick('headline'),
          location: pick('location'),
          about: pick('about'),
          company: pick('company'),
          photo,
          url: linkedinUrl,
          raw: c
        };
        if (!card.name) return { error: 'exa card has no name' };
        return { card };
      } catch (e) { return { error: 'exa request failed: ' + e.message }; }
    }

    // ---- LinkedIn profile pull (queued for the QwenWork agent to read the public profile) ----
    if (p === '/api/profilecard' && req.method === 'GET') {
      const rows = await sb('GET', 'profile_jobs', {
        query: { status: 'eq.queued', select: 'id,linkedin_url,name,created_at', order: 'created_at.asc' }
      });
      return json(res, 200, rows);
    }
    if (p === '/api/profilecard' && req.method === 'POST') {
      const { linkedin_url, name } = await readBody(req);
      const url = (linkedin_url && /linkedin\.com/i.test(linkedin_url)) ? linkedin_url.trim() : null;
      if (!url && !name) return json(res, 400, { error: 'a linkedin.com URL or a name is required' });
      // Exa first — instant JSON that builds the profile card; agent queue as fallback.
      // No URL? Exa search finds their LinkedIn profile by name, then pulls the card.
      const s = await getSettings();
      if (s.exa_key) {
        let resolved = url;
        if (!resolved) {
          const found = await exaSearchLinkedIn(name);
          if (!found.url) {
            const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url: null, name, note: 'exa search: ' + found.error } });
            return json(res, 201, { id: rows[0].id, status: 'queued', error: found.error, mode: 'agent-fallback' });
          }
          resolved = found.url;
        }
        const result = await exaProfileCard(resolved, name || null);
        if (result.card) {
          const card = { ...result.card, source: 'exa: exa.ai/answer' };
          card.research = await exaResearch(card.name || name, resolved); // instant, cited
          const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url: resolved, name: name || card.name || null, status: 'done', card } });
          return json(res, 201, { id: rows[0].id, status: 'done', card, mode: 'exa', linkedin_url: resolved });
        }
        // Exa failed — fall through to the agent queue so nothing silently breaks
        const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url: resolved, name: name || null, note: 'exa: ' + (result.error || 'no card') } });
        return json(res, 201, { id: rows[0].id, status: 'queued', error: result.error, mode: 'agent-fallback' });
      }
      if (!url) return json(res, 400, { error: 'a linkedin.com URL is required (name-only lookup needs an Exa key)' });
      const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url: url, name: name || null } });
      return json(res, 201, { id: rows[0].id, status: rows[0].status, mode: 'agent' });
    }
    const pc = p.match(/^\/api\/profilecard\/([0-9a-f-]{36})$/i);
    if (pc) {
      const id = pc[1];
      if (req.method === 'GET') {
        const rows = await sb('GET', 'profile_jobs', { query: { id: `eq.${id}`, select: 'id,status,card,linkedin_url,name' } });
        return json(res, 200, rows[0] || { error: 'not found' });
      }
      if (req.method === 'PUT') {
        // agent write-back: the public profile read from LinkedIn, structured as a reference card
        const { card, status } = await readBody(req);
        const rows = await sb('PATCH', 'profile_jobs', { query: { id: `eq.${id}` }, body: { card: card || null, status: status || 'done' } });
        return json(res, 200, rows[0]);
      }
    }

    // ---- insight decks: generated instantly via Exa, stored as a structured HTML deck ----
    if (p === '/api/deck' && req.method === 'GET') {
      // ?all=1 returns every job (for the app's relationship cards); default: queued only (worker)
      if (url.searchParams.get('all') === '1') {
        const rows = await sb('GET', 'deck_jobs', {
          query: { select: 'id,relationship_id,name,status,accepted,responded_at,created_at', order: 'created_at.desc', limit: '50' }
        });
        return json(res, 200, rows);
      }
      const rows = await sb('GET', 'deck_jobs', {
        query: { status: 'eq.queued', select: 'id,relationship_id,name,context,created_at', order: 'created_at.asc' }
      });
      return json(res, 200, rows);
    }
    if (p === '/api/deck' && req.method === 'POST') {
      const { relationship_id, name, context } = await readBody(req);
      if (!name) return json(res, 400, { error: 'name required' });
      const s = await getSettings();
      if (!s.exa_key) return json(res, 400, { error: 'an Exa key is required — add it in Settings for instant deck generation' });
      // everything the generator needs: their pulled profile card + your profile + conversation context
      const ctx = context || {};
      const theirCard = ctx.profile_card || {};
      const you = ctx.user_profile || {};
      const prompt = `Write the content for a professional intro deck from ${you.name || 'the sender'} to ${name}.`;
      const grounding = `Sender profile: ${JSON.stringify({ name: you.name, role: you.role, offer: you.offer, looking: you.looking })}
Their profile card: ${JSON.stringify({ headline: theirCard.headline, role: theirCard.role, about: theirCard.about, company: theirCard.company, research: theirCard.research })}
Conversation context: ${(ctx.note || '').slice(0, 400)} ${(ctx.met_context || '')}
What the sender wants: ${(ctx.contact && ctx.contact.want) || ''}`;
      try {
        const r = await fetch('https://api.exa.ai/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({
            query: prompt,
            systemPrompt: `${grounding}\nUse only the provided data. Tone: warm, professional, concrete — no fluff, no invented facts. Each bullet max 18 words.`,
            model: 'exa-fast',
            outputSchema: {
              type: 'object',
              properties: {
                why_connect: { type: 'array', items: { type: 'string' } },
                opportunities: { type: 'array', items: { type: 'string' } },
                value: { type: 'array', items: { type: 'string' } },
                next_step: { type: 'string' }
              },
              required: ['why_connect', 'opportunities', 'value', 'next_step']
            }
          })
        });
        if (!r.ok) return json(res, 502, { error: 'exa answer failed: ' + (await r.text()).slice(0, 150) });
        const d = await r.json();
        let a = d.answer;
        if (typeof a === 'string') { const m = a.match(/\{[\s\S]*\}/); a = m ? JSON.parse(m[0]) : null; }
        if (!a || !Array.isArray(a.why_connect)) return json(res, 502, { error: 'exa returned no deck content' });
        const deck = {
          sections: {
            role: theirCard.headline || theirCard.role || '',
            why_connect: a.why_connect.slice(0, 5),
            opportunities: (a.opportunities || []).slice(0, 5),
            value: (a.value || []).slice(0, 4),
            next_step: a.next_step || ''
          },
          sources_note: 'Drafted instantly via Exa from your captured profile and notes — review before sharing.'
        };
        const rows = await sb('POST', 'deck_jobs', { body: { relationship_id: relationship_id || null, name, context: ctx.note ? String(ctx.note).slice(0, 500) : null, status: 'done', deck } });
        return json(res, 201, { id: rows[0].id, status: 'done', mode: 'exa' });
      } catch (e) { return json(res, 500, { error: 'deck generation failed: ' + e.message }); }
    }
    const dk = p.match(/^\/api\/deck\/([0-9a-f-]{36})(\/pdf|\/accept)?$/i);
    if (dk) {
      const id = dk[1];
      if (req.method === 'GET' && dk[2] === '/pdf') {
        const rows = await sb('GET', 'deck_jobs', { query: { id: `eq.${id}`, select: 'pdf,status' } });
        const row = rows[0];
        if (!row?.pdf) return json(res, 404, { error: 'deck not ready' });
        const buf = pdfBuffer(row.pdf);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="insight-deck.pdf"`, 'Content-Length': buf.length });
        return res.end(buf);
      }
      if (req.method === 'GET') {
        const rows = await sb('GET', 'deck_jobs', { query: { id: `eq.${id}`, select: 'id,relationship_id,name,status,deck,pdf' } });
        if (!rows[0]) return json(res, 404, { error: 'not found' });
        const row = rows[0];
        const trimmed = { ...row };
        if (row.pdf) trimmed.pdf_ready = true; // never ship the base64 blob to the client
        delete trimmed.pdf;
        return json(res, 200, trimmed);
      }
      if (req.method === 'PUT') {
        // agent write-back: deck sections + rendered PDF (base64, data-uri or raw)
        const { deck, pdf, status } = await readBody(req);
        if (pdf && pdf.length > 8_000_000) return json(res, 413, { error: 'pdf too large' });
        const rows = await sb('PATCH', 'deck_jobs', { query: { id: `eq.${id}` }, body: { deck: deck || null, pdf: pdf || null, status: status || 'done', updated_at: new Date().toISOString() } });
        return json(res, 200, { id: rows[0].id, status: rows[0].status });
      }
      if (req.method === 'POST' && p.endsWith('/accept')) {
        // recipient response on the public deck page — no auth, the link IS the consent
        const rows = await sb('PATCH', 'deck_jobs', { query: { id: `eq.${id}` }, body: { accepted: true, responded_at: new Date().toISOString() } });
        if (!rows[0]) return json(res, 404, { error: 'not found' });
        return json(res, 200, { accepted: true, responded_at: rows[0].responded_at });
      }
    }
    // public deck page: /deck/:id — a shareable web page of the deck, with PDF export
    const dsh = p.match(/^\/deck\/([0-9a-f-]{36})$/i);
    if (dsh && req.method === 'GET') {
      const rows = await sb('GET', 'deck_jobs', { query: { id: `eq.${dsh[1]}`, select: 'name,status,pdf,deck,accepted,responded_at,relationship_id' } });
      const row = rows[0];
      const id = dsh[1];
      if (!row || (!row.deck && !row.pdf)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif">Insight deck not found or not generated yet.</h2>');
      }
      // PDF-only fallback (no structured deck written)
      if (!row.deck) {
        const buf = pdfBuffer(row.pdf);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
        return res.end(buf);
      }
      const s = row.deck.sections || {};
      const bullets = arr => (arr || []).map(x => `<li>${esc(x)}</li>`).join('');
      const prof = await sb('GET', 'profiles', { query: { id: 'eq.me', select: 'name,role,linkedin_card,photo' } }).catch(() => []);
      const from = prof[0] || {};
      // both parties' photos: theirs from the relationship's pulled LinkedIn card, yours from your profile
      let theirPhoto = null;
      if (row.relationship_id) {
        const rels = await sb('GET', 'relationships', { query: { id: `eq.${row.relationship_id}`, select: 'profile_card' } }).catch(() => []);
        theirPhoto = (rels[0] && rels[0].profile_card && rels[0].profile_card.photo) || null;
      }
      const fromPhoto = (from.photo) || (from.linkedin_card && from.linkedin_card.photo) || null;
      const theirImg = theirPhoto
        ? `<img src="${esc(theirPhoto)}" alt="${esc(row.name)}" style="width:84px;height:84px;border-radius:50%;object-fit:cover;border:2px solid #2c3550;margin-bottom:10px" onerror="this.remove()">`
        : '';
      const fromImg = (fromPhoto && from.name)
        ? `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px"><img src="${esc(fromPhoto)}" alt="${esc(from.name)}" style="width:30px;height:30px;border-radius:50%;object-fit:cover;border:1px solid #2c3550" onerror="this.remove()"><span style="color:var(--muted);font-size:12.5px">from ${esc(from.name)}</span></div>`
        : '';
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Insight Deck — ${esc(row.name)}</title>
<style>
:root{--bg:#0b0e14;--panel:#141a28;--line:#232b3d;--ink:#e8ecf4;--muted:#8b95a7;--accent:#7c94ff}
*{box-sizing:border-box} body{background:var(--bg);color:var(--ink);font-family:system-ui,"Segoe UI",sans-serif;margin:0;padding:40px 20px;line-height:1.6}
.wrap{max-width:680px;margin:auto}
.card{background:var(--panel);border:1px solid transparent;border-radius:18px;padding:36px 38px;background:linear-gradient(#11151f,#11151f) padding-box,linear-gradient(135deg,#6c8cff,#8f6cff) border-box}
.cover{text-align:center;padding:26px 0 10px}
.cover h1{font-size:26px;margin:0 0 4px}
.cover .role{color:var(--muted);font-size:14px}
.cover .sub{color:var(--accent);font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin-top:14px}
.cover .from{color:var(--muted);font-size:12.5px;margin-top:6px}
h2{font-size:14px;color:var(--accent);text-transform:uppercase;letter-spacing:1.4px;margin:34px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}
ul{padding-left:20px;margin:0} li{margin:10px 0;font-size:15px;color:#ccd5e4}
.next{background:rgba(124,148,255,.08);border:1px solid rgba(124,148,255,.25);border-radius:12px;padding:16px 20px;font-size:15px;margin-top:10px}
.foot{margin-top:34px;font-size:12px;color:var(--muted);border-top:1px dashed var(--line);padding-top:16px}
.bar{display:flex;gap:10px;justify-content:center;margin-bottom:26px;flex-wrap:wrap}
.bar a,.bar button{display:inline-block;padding:11px 22px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.bar .pdf{background:linear-gradient(135deg,#6c8cff,#8f6cff);color:#fff;border:0}
.bar .plain{border:1px solid var(--line);color:var(--ink);background:transparent}
.accepted{margin-top:30px;text-align:center;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.35);border-radius:12px;padding:18px}
.accepted b{color:#6ee7a0}
.accepted .when{color:var(--muted);font-size:12.5px;margin-top:4px}
@media print{body{background:#fff;color:#111;padding:0}.card{border-color:#ddd;background:#fff}.bar{display:none}h2{color:#3355cc}li,.next{color:#333}.cover .sub{color:#3355cc}.cover .role,.foot,.cover .from{color:#777}}
</style></head><body><div class="wrap">
<div class="bar">${row.pdf ? `<a class="pdf" href="/api/deck/${id}/pdf">Export as PDF</a>` : ''}<a class="plain" href="javascript:window.print()">Print</a></div>
${row.deck ? (row.accepted
  ? `<div class="accepted"><b>Accepted</b> — ${esc(row.name)} welcomed this intro<div class="when">${row.responded_at ? new Date(row.responded_at).toLocaleString('en-SG', { dateStyle: 'medium' }) : ''}</div></div>`
  : `<div class="bar"><button class="pdf" onclick="acceptDeck('${id}')">Accept this intro</button></div>`) : ''}
<div class="card">
  <div class="cover">
    ${theirImg}
    <h1>${esc(row.name)}</h1>
    <div class="role">${esc(s.role || '')}</div>
    <div class="sub">A considered intro to working together</div>
    ${from.name ? `<div class="from">From ${esc(from.name)}${from.role ? ' · ' + esc(from.role) : ''}</div>` : ''}
    ${fromImg}
  </div>
  <h2>Why we should connect</h2><ul>${bullets(s.why_connect)}</ul>
  <h2>Potential opportunities</h2><ul>${bullets(s.opportunities)}</ul>
  <h2>The value ${esc(from.name ? from.name.split(' ')[0] : 'the sender')} brings</h2><ul>${bullets(s.value)}</ul>
  ${s.next_step ? `<h2>A natural next step</h2><div class="next">${esc(s.next_step)}</div>` : ''}
  ${row.deck.sources_note ? `<h2>Notes on sources</h2><div style="font-size:13px;color:var(--muted)">${esc(row.deck.sources_note)}</div>` : ''}
  <div class="foot">Shared deliberately by the sender — this page is the deck only. Private notes and unverified research stay private.</div>
</div></div>
<script>
function acceptDeck(id){
  fetch('/api/deck/'+id+'/accept', { method: 'POST' })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(() => location.reload())
    .catch(() => alert('Could not record your response — please try again.'));
}
</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ---- Talk Track: a pre-planned conversation agenda — topics + discovery questions, generated instantly via Exa ----
    if (p === '/api/talk' && req.method === 'GET') {
      const rows = await sb('GET', 'talk_jobs', { query: { select: 'id,relationship_id,name,status,picked_topic,responded_at,created_at', order: 'created_at.desc', limit: '50' } });
      return json(res, 200, rows);
    }
    if (p === '/api/talk' && req.method === 'POST') {
      const { relationship_id, name, context } = await readBody(req);
      if (!name) return json(res, 400, { error: 'name required' });
      const s = await getSettings();
      if (!s.exa_key) return json(res, 400, { error: 'an Exa key is required — add it in Settings for instant talk tracks' });
      const ctx = context || {};
      const theirCard = ctx.profile_card || {};
      const you = ctx.user_profile || {};
      const grounding = `Their profile: ${JSON.stringify({ headline: theirCard.headline, role: theirCard.role, about: theirCard.about, company: theirCard.company, research: theirCard.research })}
Sender: ${JSON.stringify({ name: you.name, role: you.role, offer: you.offer, looking: you.looking })}
Conversation so far: ${(ctx.note || '').slice(0, 400)} ${ctx.met_context || ''}
What the sender wants: ${(ctx.contact && ctx.contact.want) || ''}`;
      try {
        const r = await fetch('https://api.exa.ai/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({
            query: `Plan a conversation agenda for ${you.name || 'the sender'} and ${name}: 3 topics worth digging into, each with open discovery questions about ${name}'s world.`,
            systemPrompt: `${grounding}\nUse only the provided data. Questions must be open-ended and about THEM, not the sender. "why" is one sentence on why the topic matters to them. "bring" is one short thing the sender can offer on this topic, or empty. No fluff, no invented facts.`,
            model: 'exa-fast',
            outputSchema: {
              type: 'object',
              properties: {
                topics: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      topic: { type: 'string' },
                      why: { type: 'string' },
                      questions: { type: 'array', items: { type: 'string' } },
                      bring: { type: 'string' }
                    },
                    required: ['topic', 'why', 'questions']
                  }
                }
              },
              required: ['topics']
            }
          })
        });
        if (!r.ok) return json(res, 502, { error: 'exa answer failed: ' + (await r.text()).slice(0, 150) });
        const d = await r.json();
        let a = d.answer;
        if (typeof a === 'string') { const m = a.match(/\{[\s\S]*\}/); a = m ? JSON.parse(m[0]) : null; }
        const topics = (a && Array.isArray(a.topics)) ? a.topics.slice(0, 4) : null;
        if (!topics || !topics.length) return json(res, 502, { error: 'exa returned no talk track' });
        const track = { role: theirCard.headline || theirCard.role || '', topics };
        const rows = await sb('POST', 'talk_jobs', { body: { relationship_id: relationship_id || null, name, status: 'done', track } });
        return json(res, 201, { id: rows[0].id, status: 'done', mode: 'exa' });
      } catch (e) { return json(res, 500, { error: 'talk track generation failed: ' + e.message }); }
    }
    const tk = p.match(/^\/api\/talk\/([0-9a-f-]{36})(\/pick)?$/i);
    if (tk) {
      const id = tk[1];
      if (req.method === 'GET') {
        const rows = await sb('GET', 'talk_jobs', { query: { id: `eq.${id}`, select: 'id,relationship_id,name,status,track,picked_topic,responded_at' } });
        return json(res, 200, rows[0] || { error: 'not found' });
      }
      if (req.method === 'PATCH' && tk[2] === '/pick') {
        // the recipient marks which topic to start with — no auth, the link is the consent
        const { picked_topic } = await readBody(req);
        const rows = await sb('PATCH', 'talk_jobs', { query: { id: `eq.${id}` }, body: { picked_topic: typeof picked_topic === 'number' ? picked_topic : null, responded_at: new Date().toISOString() } });
        return json(res, 200, rows[0]);
      }
    }
    // public talk track page: /talk/:id
    const tsh = p.match(/^\/talk\/([0-9a-f-]{36})$/i);
    if (tsh && req.method === 'GET') {
      const id = tsh[1];
      const rows = await sb('GET', 'talk_jobs', { query: { id: `eq.${id}`, select: 'name,status,track,picked_topic,responded_at,relationship_id' } });
      const row = rows[0];
      if (!row || !row.track) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif">Talk track not found.</h2>');
      }
      const prof = await sb('GET', 'profiles', { query: { id: 'eq.me', select: 'name,role,linkedin_card,photo' } }).catch(() => []);
      const from = prof[0] || {};
      let theirPhoto = null;
      if (row.relationship_id) {
        const rels = await sb('GET', 'relationships', { query: { id: `eq.${row.relationship_id}`, select: 'profile_card' } }).catch(() => []);
        theirPhoto = (rels[0] && rels[0].profile_card && rels[0].profile_card.photo) || null;
      }
      const fromPhoto = (from.photo) || (from.linkedin_card && from.linkedin_card.photo) || null;
      const theirImg = theirPhoto ? `<img src="${esc(theirPhoto)}" alt="" style="width:84px;height:84px;border-radius:50%;object-fit:cover;border:2px solid #2c3550;margin-bottom:10px" onerror="this.remove()">` : '';
      const fromImg = (fromPhoto && from.name) ? `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px"><img src="${esc(fromPhoto)}" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover" onerror="this.remove()"><span style="color:#8b95a7;font-size:12.5px">prepared by ${esc(from.name)}</span></div>` : '';
      const topics = row.track.topics || [];
      const topicsHtml = topics.map((t, i) => `
        <div class="topic ${row.picked_topic === i ? 'picked' : ''}">
          <div class="thead">
            <b>${esc(t.topic)}</b>
            ${row.picked_topic === null
              ? `<button class="pick" onclick="pick(${i})">Start here</button>`
              : (row.picked_topic === i ? '<span class="picked-tag">✓ Let\'s start here</span>' : '')}
          </div>
          <div class="why">${esc(t.why || '')}</div>
          <ul>${(t.questions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ul>
          ${t.bring ? `<div class="bring">I can bring: ${esc(t.bring)}</div>` : ''}
        </div>`).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Talk Track — ${esc(row.name)}</title>
<style>
:root{--bg:#0b0e14;--panel:#141a28;--line:#232b3d;--ink:#e8ecf4;--muted:#8b95a7;--accent:#7c94ff}
*{box-sizing:border-box} body{background:var(--bg);color:var(--ink);font-family:system-ui,"Segoe UI",sans-serif;margin:0;padding:40px 20px;line-height:1.6}
.wrap{max-width:680px;margin:auto}
.card{background:var(--panel);border:1px solid transparent;border-radius:18px;padding:36px 38px;background:linear-gradient(#11151f,#11151f) padding-box,linear-gradient(135deg,#6c8cff,#8f6cff) border-box}
.cover{text-align:center;padding:26px 0 10px}
.cover h1{font-size:26px;margin:0 0 4px}
.cover .role{color:var(--muted);font-size:14px}
.cover .sub{color:var(--accent);font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin-top:14px}
.topic{border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-top:16px}
.topic.picked{border-color:rgba(110,231,160,.5);background:rgba(74,222,128,.05)}
.thead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.thead b{font-size:16.5px}
.why{color:var(--muted);font-size:13px;margin-top:4px}
ul{padding-left:20px;margin:10px 0 0} li{margin:10px 0;font-size:15px;color:#ccd5e4}
.bring{margin-top:10px;font-size:13.5px;color:var(--accent)}
.pick{background:transparent;border:1px solid var(--line);color:var(--accent);border-radius:999px;padding:6px 14px;font-size:12.5px;cursor:pointer;font-family:inherit;font-weight:600}
.pick:hover{border-color:var(--accent)}
.picked-tag{color:#6ee7a0;font-size:12.5px;font-weight:600}
.foot{margin-top:34px;font-size:12px;color:var(--muted);border-top:1px dashed var(--line);padding-top:16px;text-align:center}
</style></head><body><div class="wrap">
<div class="card">
  <div class="cover">
    ${theirImg}
    <h1>${esc(row.name)}</h1>
    <div class="role">${esc(row.track.role || '')}</div>
    <div class="sub">Talk track — for our next conversation</div>
    ${from.name ? `<div style="color:var(--muted);font-size:12.5px;margin-top:6px">prepared by ${esc(from.name)}${from.role ? ' · ' + esc(from.role) : ''}</div>` : ''}
    ${fromImg}
  </div>
  <div style="font-size:14px;color:#ccd5e4;margin-top:18px">A few topics worth digging into, and the questions I'd love to ask. Mark where you'd like to start — we'll take it from there.</div>
  ${topicsHtml}
  <div class="foot">Shared deliberately — this page is the talk track only. Private notes stay private.</div>
</div></div>
<script>
function pick(i){
  fetch('/api/talk/${id}/pick', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picked_topic: i }) })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(() => location.reload())
    .catch(() => alert('Could not record your pick — please try again.'));
}
</script>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ---- next steps: instant draft email + LinkedIn message via Exa (user sends everything themselves) ----
    if (p === '/api/nextsteps' && req.method === 'POST') {
      const { relationship_id, name, context } = await readBody(req);
      if (!name) return json(res, 400, { error: 'name required' });
      const s = await getSettings();
      if (!s.exa_key) return json(res, 400, { error: 'an Exa key is required — add it in Settings to draft next steps' });
      const ctx = context || {};
      const theirCard = ctx.profile_card || {};
      const you = ctx.user_profile || {};
      const grounding = `Recipient: ${JSON.stringify({ name, headline: theirCard.headline, role: theirCard.role, company: theirCard.company })}
Sender: ${JSON.stringify({ name: you.name, role: you.role, offer: you.offer, looking: you.looking })}
How they met / conversation: ${(ctx.note || '').slice(0, 400)} ${ctx.met_context || ''}
What the sender wants: ${(ctx.contact && ctx.contact.want) || ''}`;
      try {
        const r = await fetch('https://api.exa.ai/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({
            query: `Draft a follow-up email and a short LinkedIn message from ${you.name || 'the sender'} to ${name} after their first meeting.`,
            systemPrompt: `${grounding}\nUse only the provided data. Warm, concrete, short — no fluff, no invented facts. Email body max 120 words. LinkedIn message max 60 words, casual-professional. Sign with the sender's name.`,
            model: 'exa-fast',
            outputSchema: {
              type: 'object',
              properties: {
                email_subject: { type: 'string' },
                email_body: { type: 'string' },
                linkedin_message: { type: 'string' }
              },
              required: ['email_subject', 'email_body', 'linkedin_message']
            }
          })
        });
        if (!r.ok) return json(res, 502, { error: 'exa answer failed: ' + (await r.text()).slice(0, 150) });
        const d = await r.json();
        let a = d.answer;
        if (typeof a === 'string') { const m = a.match(/\{[\s\S]*\}/); a = m ? JSON.parse(m[0]) : null; }
        if (!a || !a.email_body) return json(res, 502, { error: 'exa returned no drafts' });
        return json(res, 200, { email_subject: a.email_subject || '', email_body: a.email_body, linkedin_message: a.linkedin_message || '' });
      } catch (e) { return json(res, 500, { error: 'drafting failed: ' + e.message }); }
    }

    // ---- research jobs (queued for the QwenWork agent to run real web searches) ----
    if (p === '/api/research' && req.method === 'GET') {
      const rows = await sb('GET', 'research_jobs', {
        query: { status: 'eq.queued', select: 'id,relationship_id,name,context,created_at', order: 'created_at.asc' }
      });
      return json(res, 200, rows);
    }
    if (p === '/api/research' && req.method === 'POST') {
      const { relationship_id, name, context, profile_card, user_profile } = await readBody(req);
      if (!name) return json(res, 400, { error: 'name required' });
      // the agent gets the full picture: note context + their profile card + your profile
      const ctx = [context || '',
        profile_card && `Their profile card: ${JSON.stringify(profile_card)}`,
        user_profile && `User's own profile: ${JSON.stringify(user_profile)}`].filter(Boolean).join('\n');
      const rows = await sb('POST', 'research_jobs', { body: { relationship_id: relationship_id || null, name, context: ctx } });
      return json(res, 201, { id: rows[0].id, status: rows[0].status });
    }
    const rj = p.match(/^\/api\/research\/([0-9a-f-]{36})$/i);
    if (rj) {
      const id = rj[1];
      if (req.method === 'GET') {
        const rows = await sb('GET', 'research_jobs', { query: { id: `eq.${id}`, select: 'id,status,findings,assessment,relationship_id,name,context' } });
        return json(res, 200, rows[0] || { error: 'not found' });
      }
      if (req.method === 'PUT') {
        // agent write-back: store findings + assessment and attach both to the relationship
        const { findings, assessment, status } = await readBody(req);
        const rows = await sb('PATCH', 'research_jobs', { query: { id: `eq.${id}` }, body: { findings: findings || null, assessment: assessment || null, status: status || 'done' } });
        const job = rows[0];
        if (job?.relationship_id && (findings || assessment)) {
          const patch = {};
          if (findings) patch.research = findings;
          if (assessment) patch.assessment = assessment;
          await sb('PATCH', 'relationships', { query: { id: `eq.${job.relationship_id}` }, body: patch });
        }
        return json(res, 200, job);
      }
    }

    // /api/relationships/:id/...
    const m = p.match(/^\/api\/relationships\/([0-9a-f-]{36})(\/(brief|card|interaction|next_action|transcription))?$/i);
    if (m) {
      const id = m[1];
      const action = m[3];

      // fetch one relationship (used after an agent write-back to refresh the view)
      if (req.method === 'GET' && !action) {
        const rows = await sb('GET', 'relationships', { query: { id: `eq.${id}`, select: '*' } });
        if (!rows[0]) return json(res, 404, { error: 'not found' });
        return json(res, 200, rows[0]);
      }

      // delete a relationship (and its card) entirely
      if (req.method === 'DELETE' && !action) {
        await sb('DELETE', 'relationships', { query: { id: `eq.${id}` } });
        return json(res, 200, { deleted: true });
      }

      // delete the stored insight card only
      if (req.method === 'DELETE' && action === 'card') {
        const rows = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body: { card: null } });
        return json(res, 200, rows[0]);
      }

      if (req.method === 'PATCH' && !action) {
        const input = await readBody(req);
        const body = {};
        for (const k of REL_PATCH_FIELDS) if (k in input) body[k] = input[k];
        const rejected = Object.keys(input).filter(k => !REL_PATCH_FIELDS.includes(k));
        if (rejected.length) return json(res, 400, { error: `field(s) not editable: ${rejected.join(', ')}` });
        if (!Object.keys(body).length) return json(res, 400, { error: 'nothing to update' });
        if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) return json(res, 400, { error: 'name must be a non-empty string' });
        const rows = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body });
        if (!rows[0]) return json(res, 404, { error: 'not found' });
        return json(res, 200, rows[0]);
      }

      if (req.method === 'PUT' && action === 'brief') {
        const { brief } = await readBody(req);
        const rows = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body: { brief } });
        return json(res, 200, rows[0]);
      }

      if (req.method === 'PUT' && action === 'card') {
        const { card } = await readBody(req);
        const rows = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body: { card } });
        return json(res, 200, rows[0]);
      }

      if (req.method === 'PUT' && action === 'next_action') {
        const { next_action } = await readBody(req);
        const rows = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body: { next_action } });
        return json(res, 200, rows[0]);
      }

      // agent write-back: set transcript text on interaction {index}
      if (req.method === 'PUT' && action === 'transcription') {
        const { index, text } = await readBody(req);
        const rows = await sb('GET', 'relationships', { query: { id: `eq.${id}`, select: 'interactions' } });
        const list = (rows[0]?.interactions) || [];
        if (typeof index !== 'number' || !list[index]) return json(res, 404, { error: 'interaction not found' });
        list[index].text = text;
        list[index].transcribed_by = 'qwenwork-agent';
        const updated = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body: { interactions: list } });
        return json(res, 200, updated[0]);
      }

      // append interaction (text comment or voice note) to the jsonb array
      if (req.method === 'POST' && action === 'interaction') {
        const { author, text, audio, duration } = await readBody(req);
        if (!text && !audio) return json(res, 400, { error: 'text or audio required' });
        if (audio && audio.length > 1_500_000) return json(res, 413, { error: 'audio clip too large' });
        const rows = await sb('GET', 'relationships', { query: { id: `eq.${id}`, select: 'interactions' } });
        const list = (rows[0]?.interactions) || [];
        const entry = { author: author || 'You', at: new Date().toISOString() };
        if (text) entry.text = text;
        if (audio) { entry.audio = audio; entry.duration = duration || null; }
        list.push(entry);
        const updated = await sb('PATCH', 'relationships', { query: { id: `eq.${id}` }, body: { interactions: list } });
        return json(res, 200, updated[0]);
      }
    }

    // public shareable insight card: /share/:id — only the card, never the private brief
    const sh = p.match(/^\/share\/([0-9a-f-]{36})$/i);
    if (sh && req.method === 'GET') {
      const rows = await sb('GET', 'relationships', { query: { id: `eq.${sh[1]}`, select: 'name,card' } });
      const row = rows[0];
      if (!row || !row.card) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif">Card not found or not shared yet.</h2>');
      }
      const prof = await sb('GET', 'profiles', { query: { id: 'eq.me', select: 'name' } }).catch(() => []);
      const owner = prof[0]?.name || 'the sender';
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(row.card.title || 'Insight card')}</title>
<style>
body{background:#0b0e14;color:#e8ecf4;font-family:system-ui,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.card{max-width:520px;width:100%;background:#151a26;border:1px solid transparent;border-radius:18px;padding:30px 32px;background:linear-gradient(#11151f,#11151f) padding-box,linear-gradient(135deg,#6c8cff,#8f6cff) border-box}
h1{font-size:20px;margin:0 0 16px}
pre{white-space:pre-wrap;font:inherit;font-size:15px;line-height:1.65;color:#ccd5e4;margin:0}
.foot{margin-top:20px;font-size:12px;color:#8b95a7;border-top:1px dashed #232b3d;padding-top:14px}
</style></head><body><div class="card"><h1>${esc(row.card.title || 'Insight card')}</h1><pre>${esc(row.card.content || '')}</pre>
<div class="foot">Shared by ${esc(owner)} · via the OPC Relationship Workspace — only this card is shared, private notes stay private.</div></div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ---- live transcription jobs (audio segments queued for the QwenWork agent) ----
    if (p === '/api/transcribe' && req.method === 'GET') {
      const rows = await sb('GET', 'transcribe_jobs', {
        query: { status: 'eq.queued', select: 'id,status,text,created_at', order: 'created_at.asc' }
      });
      return json(res, 200, rows);
    }
    if (p === '/api/transcribe' && req.method === 'POST') {
      const { audio } = await readBody(req);
      if (!audio) return json(res, 400, { error: 'audio required' });
      if (audio.length > 6_000_000) return json(res, 413, { error: 'audio too large' });
      const rows = await sb('POST', 'transcribe_jobs', { body: { audio } });
      return json(res, 201, { id: rows[0].id, status: rows[0].status });
    }
    const tr = p.match(/^\/api\/transcribe\/([0-9a-f-]{36})(\/audio)?$/i);
    if (tr) {
      const id = tr[1];
      if (req.method === 'GET' && tr[2] === '/audio') {
        const rows = await sb('GET', 'transcribe_jobs', { query: { id: `eq.${id}`, select: 'audio' } });
        if (!rows[0]) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ audio: rows[0].audio }));
      }
      if (req.method === 'GET') {
        const rows = await sb('GET', 'transcribe_jobs', { query: { id: `eq.${id}`, select: 'id,status,text,created_at' } });
        return json(res, 200, rows[0] || { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const { text, status } = await readBody(req);
        const rows = await sb('PATCH', 'transcribe_jobs', { query: { id: `eq.${id}` }, body: { text: text ?? null, status: status || 'done' } });
        return json(res, 200, rows[0]);
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error(err.message);
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader('Connection', 'close');
      return json(res, err.status, { error: err.message });
    }
    // only the signed-in owner sees the underlying cause (e.g. a Supabase error); public pages get a generic 500
    json(res, 500, authed || err.expose ? { error: 'server error', detail: err.message } : { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => console.log(`OPC relationship workspace listening on ${HOST}:${PORT}`));
