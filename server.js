import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';

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

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
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
        if (!r.ok) return json(res, 200, { ok: false, error: `Exa responded ${r.status}: ${(d.detail || r.statusText || '').slice ? String(d.detail || r.statusText).slice(0, 120) : ''}` });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }

    // ---- Exa.ai direct: ask for a structured JSON overview of the person, grounded on their LinkedIn URL ----
    async function exaProfileCard(linkedinUrl, name) {
      const s = await getSettings();
      if (!s.exa_key) return { error: 'no exa key configured' };
      try {
        const r = await fetch('https://api.exa.ai/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': s.exa_key },
          body: JSON.stringify({
            query: `Give me a JSON object (no prose, no markdown) with keys: name, headline, role, location, about, company. Describe the person named ${name || 'on this profile'} briefly (about: max 2 sentences). Base it only on their LinkedIn profile.`,
            text: [{ value: linkedinUrl }]
          })
        });
        if (!r.ok) return { error: `exa answer failed (${r.status}): ${(await r.text()).slice(0, 200)}` };
        const d = await r.json();
        const answer = d.answer || d.text || '';
        const m = String(answer).match(/\{[\s\S]*\}/);
        if (!m) return { error: 'exa returned no JSON' };
        const c = JSON.parse(m[0]);
        const pick = k => (typeof c[k] === 'string' && c[k].trim()) ? c[k].trim() : null;
        const card = {
          name: pick('name') || name || null,
          headline: pick('headline'),
          role: pick('role') || pick('headline'),
          location: pick('location'),
          about: pick('about'),
          company: pick('company'),
          photo: null,
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
      if (!linkedin_url || !/linkedin\.com/i.test(linkedin_url)) return json(res, 400, { error: 'a linkedin.com URL is required' });
      // Exa first — instant JSON that builds the profile card; agent queue as fallback
      const s = await getSettings();
      if (s.exa_key) {
        const result = await exaProfileCard(linkedin_url, name || null);
        if (result.card) {
          const card = { ...result.card, source: 'exa: exa.ai/answer' };
          const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url, name: name || card.name || null, status: 'done', card } });
          return json(res, 201, { id: rows[0].id, status: 'done', card, mode: 'exa' });
        }
        // Exa failed — fall through to the agent queue so nothing silently breaks
        const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url, name: name || null, note: 'exa: ' + (result.error || 'no card') } });
        return json(res, 201, { id: rows[0].id, status: 'queued', error: result.error, mode: 'agent-fallback' });
      }
      const rows = await sb('POST', 'profile_jobs', { body: { linkedin_url, name: name || null } });
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

    // ---- insight deck jobs (queued for the QwenWork agent to generate a PDF intro deck) ----
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
      const rows = await sb('POST', 'deck_jobs', { body: { relationship_id: relationship_id || null, name, context: context || null } });
      return json(res, 201, { id: rows[0].id, status: rows[0].status });
    }
    const dk = p.match(/^\/api\/deck\/([0-9a-f-]{36})(\/pdf|\/accept)?$/i);
    if (dk) {
      const id = dk[1];
      if (req.method === 'GET' && dk[2] === '/pdf') {
        const rows = await sb('GET', 'deck_jobs', { query: { id: `eq.${id}`, select: 'pdf,status' } });
        const row = rows[0];
        if (!row?.pdf) return json(res, 404, { error: 'deck not ready' });
        const b64 = row.pdf.includes(',') ? row.pdf.split(',', 1)[1] : row.pdf;
        const buf = Buffer.from(b64, 'base64');
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
      const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const id = dsh[1];
      if (!row || (!row.deck && !row.pdf)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif">Insight deck not found or not generated yet.</h2>');
      }
      // PDF-only fallback (no structured deck written)
      if (!row.deck) {
        const b64 = row.pdf.includes(',') ? row.pdf.split(',', 1)[1] : row.pdf;
        const buf = Buffer.from(b64, 'base64');
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
    const m = p.match(/^\/api\/relationships\/([0-9a-f-]{36})(\/(brief|card|interaction|next_action))?$/i);
    if (m) {
      const id = m[1];
      const action = m[3];

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
        const body = await readBody(req);
        const rows = await sb('PATCH', 'relationships', {
          query: { id: `eq.${id}` },
          body
        });
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
      const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
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

    // isolated speech-recognition test page (diagnostics)
    if (p === '/stt-test' && req.method === 'GET') {
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>STT test</title>
<style>body{font-family:system-ui;background:#0b0e14;color:#e8ecf4;padding:30px;max-width:640px;margin:auto}
button{padding:12px 22px;font-size:15px;border-radius:10px;border:0;background:#6c8cff;color:#fff;cursor:pointer}
#log div{padding:6px 0;border-bottom:1px dashed #232b3d;font-size:13px} .t{color:#8b95a7;font-size:11px}
#txt{margin-top:14px;font-size:16px;min-height:60px}</style></head><body>
<h2>Speech recognition test (no recorder)</h2>
<button onclick="start()">Start recognition</button>
<div id="txt"></div><div id="log"></div>
<script>
const log = m => { const d=document.createElement('div'); d.innerHTML='<span class="t">'+new Date().toLocaleTimeString()+'</span> '+m; document.getElementById('log').prepend(d); };
function start(){
  const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ log('SpeechRecognition NOT supported in this browser'); return; }
  const r = new SR(); r.continuous=true; r.interimResults=true; r.lang='en-SG';
  r.onstart=()=>log('onstart — listening');
  r.onerror=e=>log('<b style="color:#ff5470">onerror: '+e.error+'</b>');
  r.onend=()=>log('onend — recognizer stopped');
  r.onresult=e=>{
    let final='',interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){const x=e.results[i]; if(x.isFinal)final+=x[0].transcript; else interim+=x[0].transcript;}
    log('onresult — final: "'+final+'" interim: "'+interim+'"');
    document.getElementById('txt').textContent += final;
  };
  r.start(); log('start() called');
}
</script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error(err.message);
    json(res, 500, { error: 'server error', detail: err.message });  }
});

server.listen(PORT, HOST, () => console.log(`OPC relationship workspace listening on ${HOST}:${PORT}`));
