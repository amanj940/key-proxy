import { db_legacy as db, dec, save, getKeys, getModels, saveModels, updateProviderModels, updateKey, loadToLegacy } from './store.js';

const SKIP = /deep-research|computer-use|live|realtime|robotics|antigravity|nano-banana|lyria|veo|imagen|aqa|omni|tts|transcri|learnlm|custom-?tools|translate|-exp$/i;
const PRIORITY = /llama|qwen|gpt-oss|gemma|deepseek|mistral|codestral|glm|kimi|minimax|gemini|nemotron|large|pro/i;
const MAX_PROBE = 40;
export const REPROBE_MS = 6 * 3600e3;
const running = new Set();

async function once(p, id, type, key) {
  const emb = type === 'embedding';
  try {
    const r = await fetch(p.baseUrl + (emb ? '/embeddings' : '/chat/completions'), {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(emb ? { model: id, input: 'hi' } : { model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    });
    if (r.ok) { r.body?.cancel(); return { ok: true }; }
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 140);
    if (r.status === 402) return { ok: null, credit: true, err: '402 no credit' };
    if (r.status === 429) return { ok: null, err: '429 rate limited' };
    if (r.status === 401 || r.status === 403) return { ok: null, err: r.status + ' key rejected' };
    return { ok: false, err: r.status + ' ' + t };
  } catch { return { ok: null, err: 'timeout/network' }; }
}

async function probeRetry(p, id, type, key) {
  let r;
  for (let i = 0; i < 2; i++) {
    r = await once(p, id, type, key);
    if (r.ok !== null || r.credit || !/429|timeout/.test(r.err || '')) return r;
    await new Promise((s) => setTimeout(s, 15000));
  }
  return r;
}

async function listIds(p, keys) {
  for (const k of keys) {
    try {
      const r = await fetch(p.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + dec(k.enc) }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

export const usable = (k) => !k.disabled && k.status !== 'nocredit' && k.status !== 'invalid';

export async function autoScan(name, classify) {
  const p = db.providers[name];
  if (!p || running.has(name)) return;
  const cand = p.keys.filter((k) => !k.disabled && k.status !== 'invalid');
  if (!cand.length) return;
  running.add(name); p.scanning = true; p.note = '';
  try {
    const j = await listIds(p, cand);
    if (!j) { p.note = 'Failed to fetch model list from provider'; return; }
    const list = [];
    for (const m of j.data || j.models || []) {
      const id = String(m.id || m.name || '').replace(/^models\//, '');
      if (!id || SKIP.test(id)) continue;
      if (name === 'openrouter' && !(id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0))) continue;
      const type = classify(id);
      if (type === 'chat' || type === 'embedding') list.push([id, type]);
    }
    list.sort((a, b) => (PRIORITY.test(b[0]) - PRIORITY.test(a[0])) || a[0].localeCompare(b[0]));
    const found = {};
    for (const [id, type] of list.slice(0, MAX_PROBE)) found[id] = p.models?.[id] || { type, ok: null, enabled: true };
    p.models = found; saveModels(name, found); loadToLegacy(); save(true);
    const ids = Object.keys(found);
    const ping = ids.find((id) => found[id].type === 'chat') || ids[0];
    if (!ping) { p.note = 'Provider does not show chat models'; return; }

    // Check credit for each key
    const ok = [];
    for (const k of cand) {
      const r = await once(p, ping, found[ping].type, dec(k.enc));
      if (r.credit) {
        k.status = 'nocredit';
        updateKey(name, k.id, { status: 'nocredit' });
      }
      else {
        if (k.status === 'nocredit' || r.ok === true) {
          k.status = 'valid';
          updateKey(name, k.id, { status: 'valid' });
        }
        ok.push(k);
      }
    }
    if (!ok.length) {
      p.models = {}; p.note = 'All keys for this provider have no credit (402). Add a payment method or credit there, and it will return automatically on next scan';
      saveModels(name, {});
      updateProviderModels(name, {}, p.note, false, null);
      loadToLegacy();
      return;
    }
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const n = i++, id = ids[n], m = found[id], k = ok[n % ok.length];
        const r = await probeRetry(p, id, m.type, dec(k.enc));
        if (r.credit) {
          k.status = 'nocredit';
          m.err = r.err;
          updateKey(name, k.id, { status: 'nocredit' });
        }
        else if (r.ok === true) {
          m.ok = true;
          m.err = '';
          k.status = 'valid';
          updateKey(name, k.id, { status: 'valid' });
        }
        else if (r.ok === false) {
          m.ok = false;
          m.err = r.err;
        }
        else m.err = r.err;
        m.at = Date.now();
        if (n % 4 === 0) save();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const id of ids) if (found[id].ok === false) delete found[id];
    p.scannedAt = Date.now();
    const good = Object.entries(found).filter(([, m]) => m.type === 'chat' && m.ok === true).map(([id]) => id);
    if (!good.length) p.note = 'No model succeeded in the scan. Check failure reasons next to each model';
    if (!p.defaultLocked && good.length && !good.includes(p.defaultModel)) p.defaultModel = good[0];
    saveModels(name, found);
    updateProviderModels(name, found, p.note, false, p.scannedAt);
    loadToLegacy();
    save(true);
  } finally { p.scanning = false; running.delete(name); updateProviderModels(name, p.models, p.note, false, p.scannedAt); loadToLegacy(); save(true); }
}

export function startAuto(classify) {
  const tick = () => {
    for (const [n, p] of Object.entries(db.providers))
      if (p.keys.some((k) => !k.disabled) && (!p.scannedAt || Date.now() - p.scannedAt > REPROBE_MS)) autoScan(n, classify).catch(() => {});
  };
  setTimeout(tick, 3000);
  setInterval(tick, 30 * 60e3);
}
