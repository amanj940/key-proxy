import crypto from 'node:crypto';
import { db_legacy as db, enc, dec, sha, save, getKeys, addKey, updateKey, saveProvider, addClient, deleteClient, getClients, loadToLegacy } from './store.js';
import { autoScan } from './auto.js';
import { classify } from './models-api.js';

const RULES = [
  [/^gsk_/, 'groq'],
  [/^sk-or-/, 'openrouter'],
  [/^AQ\.[\w.\-]{20,}$/, 'gemini'],
  [/^AIza[\w-]{30,}$/, 'gemini'],
  [/^csk-/, 'cerebras'],
  [/^nvapi-/, 'nvidia'],
  [/^xai-/, 'xai'],
  [/^fw_/, 'fireworks'],
  [/^hf_/, 'huggingface'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'sambanova'],
];
const EXTRA = {
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  huggingface: 'https://router.huggingface.co/v1',
};
// نقاط نهاية تتطلب مفتاحاً فعلاً (قائمة /models عند OpenRouter عامة)
const VERIFY = { openrouter: '/auth/key' };
const pub = new Map();

async function status(p, key, path) {
  try {
    const r = await fetch(p.baseUrl + path, {
      headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(12000),
    });
    r.body?.cancel();
    return r.status;
  } catch { return 0; }
}

export async function verify(name, p, key) {
  const path = VERIFY[name] || '/models';
  const s = await status(p, key, path);
  if ([400, 401, 403].includes(s)) return { state: 'invalid', code: s };
  if (s >= 200 && s < 300) {
    if (VERIFY[name]) return { state: 'valid', code: s };
    if (!pub.has(name)) pub.set(name, (await status(p, 'invalid-' + crypto.randomBytes(8).toString('hex'), path)) < 300);
    return pub.get(name) ? { state: 'public', code: s } : { state: 'valid', code: s };
  }
  return { state: 'unsure', code: s };
}

async function handle(key, hint, keepInvalid) {
  const hash = sha(key), tail = key.slice(-4);
  for (const [n, p] of Object.entries(db.providers)) {
    const keys = getKeys(n);
    if (keys.some((k) => k.h === hash)) return { status: 'duplicate', provider: n, tail };
  }

  const byPrefix = RULES.find(([re]) => re.test(key))?.[1];
  let name = byPrefix || hint || null;
  if (name && !db.providers[name]) {
    if (EXTRA[name]) {
      saveProvider(name, { baseUrl: EXTRA[name], defaultModel: '', defaultLocked: false });
      db.providers[name] = { baseUrl: EXTRA[name], defaultModel: '', keys: [] };
    }
    else name = null;
  }
  let v = name ? await verify(name, db.providers[name], key) : null;
  if (!name || (v.state === 'invalid' && !byPrefix)) {
    const cands = Object.entries(db.providers).filter(([n, p]) => p.baseUrl && n !== name);
    const rs = await Promise.all(cands.map(async ([n, p]) => [n, await verify(n, p, key)]));
    const hit = rs.find(([, r]) => r.state === 'valid');
    if (hit) { name = hit[0]; v = hit[1]; }
    else if (!name) return { status: 'unknown', tail };
  }
  const entry = { id: crypto.randomUUID(), h: hash, enc: enc(key), tail, used: 0, errors: 0 };
  if (v.state === 'invalid') {
    if (keepInvalid) {
      addKey(name, { ...entry, disabled: true, status: 'invalid' });
    }
    return { status: 'invalid', provider: name, tail, code: v.code };
  }
  entry.status = v.state === 'valid' ? 'valid' : 'unverified';
  addKey(name, entry);
  loadToLegacy();
  return { status: 'added', provider: name, tail, verified: v.state === 'valid' };
}

export async function reclassifyAll() {
  const items = [];
  for (const [orig, p] of Object.entries(db.providers)) {
    const keys = getKeys(orig);
    for (const k of keys) items.push({ key: dec(k.enc), orig, obj: k });
  }
  const out = [];
  for (const it of items) {
    const r = await handle(it.key, null, true);
    if (r.status === 'unknown') {
      addKey(it.orig, { ...it.obj, disabled: true, status: 'unverified' });
    }
    out.push({ ...r, was: it.orig });
  }
  for (const [name, p] of Object.entries(db.providers)) {
    const keys = getKeys(name);
    if (!keys.length) {
      p.models = {};
      saveModels(name, {});
    }
  }
  loadToLegacy();
  save(true);
  return out;
}

export function mountSmart(app, A) {
  app.post(A + '/keys/smart', async (req, res) => {
    const items = [], seen = new Set();
    for (const raw of String(req.body?.text || '').split(/[\s,;]+/)) {
      let t = raw.trim().replace(/^["']|["']$/g, '');
      let hint = null;
      const m = t.match(/^([A-Za-z][A-Za-z0-9_]*)=(.+)$/);
      if (m) {
        const nm = m[1].toLowerCase();
        hint = Object.keys(db.providers).find((n) => nm.includes(n)) || null;
        t = m[2].replace(/^["']|["']$/g, '');
      }
      if (!/^[\w.\-]{16,}$/.test(t) || seen.has(t)) continue;
      seen.add(t); items.push([t, hint]);
    }
    if (!items.length) return res.json({ error: 'لم أجد أي مفتاح في النص' });
    const results = [];
    for (let i = 0; i < items.length; i += 6)
      results.push(...await Promise.all(items.slice(i, i + 6).map(([k, h]) => handle(k, h, false))));
    save(true);
    for (const n of new Set(results.filter((r) => r.status === 'added').map((r) => r.provider))) { if (db.providers[n]) db.providers[n].scannedAt = 0; autoScan(n, classify).catch(() => {}); }
    res.json({ results });
  });

  app.post(A + '/providers/:n/verify', async (req, res) => {
    const n = req.params.n, p = db.providers[n];
    if (!p) return res.status(404).json({ error: 'no provider' });
    const ks = getKeys(n).filter((k) => !req.body?.id || k.id === req.body.id);
    const results = await Promise.all(ks.map(async (k) => {
      const v = await verify(n, p, dec(k.enc));
      if (v.state === 'valid') {
        updateKey(n, k.id, { status: 'valid' });
      }
      else if (v.state === 'invalid') {
        updateKey(n, k.id, { status: 'invalid', disabled: true });
      }
      else {
        updateKey(n, k.id, { status: 'unverified' });
      }
      return { tail: k.tail, state: v.state, code: v.code };
    }));
    loadToLegacy();
    save(true);
    res.json({ results });
  });
}
