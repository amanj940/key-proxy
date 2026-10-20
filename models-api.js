import { db_legacy as db, dec, save, getKeys, getModels, saveModels, updateKey, deleteKey, saveProvider, deleteProvider, loadToLegacy } from './store.js';

export const classify = (id) => {
  const s = id.toLowerCase();
  if (/whisper|tts|orpheus|speech|transcri|audio/.test(s)) return 'audio';
  if (/guard|safeguard|moderation|shield/.test(s)) return 'guard';
  if (/embed|rerank|bge-|e5-/.test(s)) return 'embedding';
  if (/dall|image|diffusion|flux|sdxl|stable-|imagen|veo|video/.test(s)) return 'image';
  return 'chat';
};

export function autoModels(p) {
  if (!p.keys.some((k) => !k.disabled && k.status !== 'nocredit' && k.status !== 'invalid')) return [];
  const all = p.models || {};
  const ms = Object.entries(all)
    .filter(([, m]) => m.type === 'chat' && m.ok === true && m.enabled !== false)
    .map(([id]) => id);
  const d = p.defaultModel;
  const list = d && (!Object.keys(all).length || ms.includes(d)) ? [d, ...ms.filter((x) => x !== d)] : ms;
  return list.slice(0, 3);
}

async function listModels(p) {
  let last = 'no keys';
  const keys = getKeys(p.name);
  for (const k of keys.filter((k) => !k.disabled)) {
    try {
      const r = await fetch(p.baseUrl + '/models', {
        headers: { Authorization: 'Bearer ' + dec(k.enc) }, signal: AbortSignal.timeout(20000),
      });
      if (r.ok) return await r.json();
      last = 'HTTP ' + r.status;
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}

async function probe(p, id, type, key) {
  const emb = type === 'embedding';
  const body = emb ? { model: id, input: 'hi' }
    : { model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  try {
    const r = await fetch(p.baseUrl + (emb ? '/embeddings' : '/chat/completions'), {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    if (r.ok) { r.body?.cancel(); return { ok: true }; }
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
    if (r.status === 402) return { ok: null, err: '402 no credit' };
    if (r.status === 429) return { ok: null, err: '429 rate limited' };
    if (r.status === 401) return { ok: null, err: '401 key rejected' };
    return { ok: false, err: r.status + ' ' + t };
  } catch { return { ok: null, err: 'timeout/network' }; }
}

import { autoScan } from './auto.js';
export function mountModels(app, A) {
  app.post(A + '/providers/:n/rescan', (req, res) => {
    if (!db.providers[req.params.n]) return res.status(404).json({ error: 'no provider' });
    autoScan(req.params.n, classify).catch(() => {});
    res.json({ started: true });
  });
  app.post(A + '/providers/:n/discover', async (req, res) => {
    const n = req.params.n, p = db.providers[n];
    if (!p) return res.status(404).json({ error: 'no provider' });
    try {
      const j = await listModels(p);
      const found = {};
      for (const m of j.data || j.models || []) {
        const id = String(m.id || m.name || '').replace(/^models\//, '');
        if (!id) continue;
        if (n === 'openrouter') {
          const free = id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);
          if (!free) continue;
        }
        found[id] = p.models?.[id] || { type: classify(id), ok: null, enabled: true };
      }
      p.models = found; saveModels(n, found); loadToLegacy(); save(true);
      res.json({ count: Object.keys(found).length });
    } catch (e) { res.status(502).json({ error: 'Failed to fetch models: ' + e.message }); }
  });

  app.post(A + '/providers/:n/probe', async (req, res) => {
    const n = req.params.n;
    const p = db.providers[n];
    if (!p) return res.status(404).json({ error: 'no provider' });
    const keys = getKeys(n).filter((k) => !k.disabled);
    if (!keys.length) return res.status(400).json({ error: 'No enabled keys' });
    const all = p.models || {};
    let ids = Array.isArray(req.body?.ids) ? req.body.ids : Object.keys(all);
    ids = ids.filter((id) => all[id] && (all[id].type === 'chat' || all[id].type === 'embedding')).slice(0, 100);
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const nIdx = i++, id = ids[nIdx], m = all[id];
        const r = await probe(p, id, m.type, dec(keys[nIdx % keys.length].enc));
        if (r.ok !== null) m.ok = r.ok;
        if (r.ok === true) {
          updateKey(n, keys[nIdx % keys.length].id, { status: 'valid' });
        }
        if (r.err && r.err.startsWith('401')) {
          updateKey(n, keys[nIdx % keys.length].id, { status: 'invalid', disabled: true });
        }
        m.err = r.err || ''; m.at = Date.now();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    saveModels(n, all);
    loadToLegacy();
    save(true);
    res.json({ probed: ids.length, working: ids.filter((id) => all[id].ok === true).length });
  });

  app.post(A + '/providers/:n/models/set', (req, res) => {
    const m = db.providers[req.params.n]?.models?.[req.body?.id];
    if (!m) return res.status(404).json({ error: 'no model' });
    m.enabled = !!req.body.enabled; save(true); res.json({ ok: true });
  });
}
