import { getClientByHash, verifyToken, createUser, verifyUser } from './store.js';
import express from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { db_legacy as db, db_sqlite, save, enc, dec, sha, getKeys, getModels, getClients, getProviders, saveProvider, deleteProvider, addKey, updateKey, deleteKey, addClient, deleteClient, updateClientUsage, updateClientSpend, logSpend, saveModels, updateProviderModels, loadToLegacy, getModelMetrics, incrementModelRequest, updateKeyHealth, getKeyHealth, logMetric, getAggregatedMetrics } from './store.js';
import { mountModels, autoModels } from './models-api.js';
import { mountSmart } from './smart.js';
import { startAuto } from './auto.js';
import { classify } from './models-api.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

const cool = new Map();   // keyId -> وقت انتهاء الإيقاف المؤقت
const plain = new Map();  // keyId -> المفتاح بعد فك التشفير (في الذاكرة فقط)
const rr = {};
const secret = (k) => { let v = plain.get(k.id); if (!v) { v = dec(k.enc); plain.set(k.id, v); } return v; };
const err = (message) => ({ error: { message, type: 'invalid_request_error' } });
const eq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));

// Routing strategies
const ROUTING_STRATEGIES = {
  fastest: 'select model with lowest avg_latency_ms',
  cheapest: 'select model with lowest cost_per_1k',
  best_quality: 'select model with highest score',
  balanced: 'select model with highest score considering cost',
  fallback: 'use as backup'
};

// Key selection strategies
const KEY_SELECTION = {
  round_robin: 'equal distribution',
  least_loaded: 'least used key',
  healthiest: 'highest success_rate',
  fastest: 'fastest response',
  geographic: 'based on location'
};

// Calculate model score
function calculateModelScore(metrics) {
  if (!metrics) return 0.5;

  const latencyScore = metrics.avg_latency_ms > 0 ? Math.max(0, 1 - (metrics.avg_latency_ms / 2000)) : 0.5;
  const costScore = metrics.cost_per_1k_input > 0 ? Math.max(0, 1 - (metrics.cost_per_1k_input / 0.01)) : 0.5;
  const qualityScore = metrics.success_rate || 0.5;
  const reliabilityScore = qualityScore;

  // Weighted scoring: speed (30%), cost (30%), quality (25%), reliability (15%)
  return (latencyScore * 0.3) + (costScore * 0.3) + (qualityScore * 0.25) + (reliabilityScore * 0.15);
}

// Select model based on strategy
function selectModelForRequest(models, strategy = 'balanced') {
  if (!models || models.length === 0) return null;

  const modelsWithMetrics = models.map(model => {
    const metrics = getModelMetrics(model.id, model.provider || model.name);
    const score = calculateModelScore(metrics);
    return { ...model, metrics, score };
  });

  switch (strategy) {
    case 'fastest':
      return modelsWithMetrics.sort((a, b) => (a.metrics?.avg_latency_ms || 9999) - (b.metrics?.avg_latency_ms || 9999))[0];
    case 'cheapest':
      return modelsWithMetrics.sort((a, b) => (a.metrics?.cost_per_1k_input || 999) - (b.metrics?.cost_per_1k_input || 999))[0];
    case 'best_quality':
      return modelsWithMetrics.sort((a, b) => (b.metrics?.success_rate || 0) - (a.metrics?.success_rate || 0))[0];
    case 'balanced':
    default:
      return modelsWithMetrics.sort((a, b) => b.score - a.score)[0];
  }
}

// Select key based on health
function selectKeyForRequest(keys, modelName = null) {
  const now = Date.now();
  const availableKeys = keys.filter(k => {
    if (k.disabled) return false;
    if (k.cooldown_until && k.cooldown_until > now) return false;

    // Check allowed models
    if (k.allowed_models) {
      const allowed = JSON.parse(k.allowed_models);
      if (allowed.length > 0 && !allowed.includes(modelName)) return false;
    }

    return true;
  });

  if (availableKeys.length === 0) return null;

  // Select healthiest key (highest success_rate)
  return availableKeys.sort((a, b) => (b.success_rate || 1.0) - (a.success_rate || 1.0))[0];
}

// Update key health after request
function updateKeyAfterRequest(providerName, keyId, success, error = null) {
  const key = getKeyHealth(providerName, keyId);
  if (!key) return;

  const errorCount = success ? 0 : ((key.error_count || 0) + 1);
  const totalRequests = (key.used || 0) + 1;
  const successCount = totalRequests - errorCount;
  const successRate = successCount / totalRequests;

  // Circuit breaker: if 5 consecutive errors, cooldown for 60 seconds
  let cooldownUntil = key.cooldown_until || 0;
  if (!success && errorCount >= 5) {
    cooldownUntil = Date.now() + 60000;
  }

  // Try to update with error_count, fallback if column doesn't exist
  try {
    updateKeyHealth(providerName, keyId, {
      success_rate: successRate,
      error_count: errorCount,
      last_error: error,
      cooldown_until: cooldownUntil
    });
  } catch (e) {
    // Fallback without error_count
    updateKeyHealth(providerName, keyId, {
      success_rate: successRate,
      last_error: error,
      cooldown_until: cooldownUntil
    });
  }
}

// Check quotas for client
function checkQuotas(client, model = null) {
  const now = Date.now();
  const dayStart = Math.floor(now / 86400000) * 86400000;
  const hourStart = Math.floor(now / 3600000) * 3600000;

  // Check monthly budget
  if (client.monthly_budget && client.spend >= client.monthly_budget) {
    return { allowed: false, reason: 'monthly_budget_exceeded' };
  }

  // Check daily budget
  if (client.daily_budget) {
    const dailySpend = getAggregatedMetrics({ clientId: client.id, from: dayStart })
      .reduce((sum, m) => sum + m.total_cost, 0);
    if (dailySpend >= client.daily_budget) {
      return { allowed: false, reason: 'daily_budget_exceeded' };
    }
  }

  // Check hourly budget
  if (client.hourly_budget) {
    const hourlySpend = getAggregatedMetrics({ clientId: client.id, from: hourStart })
      .reduce((sum, m) => sum + m.total_cost, 0);
    if (hourlySpend >= client.hourly_budget) {
      return { allowed: false, reason: 'hourly_budget_exceeded' };
    }
  }

  // Check allowed hours
  if (client.allowed_hours) {
    const allowedHours = JSON.parse(client.allowed_hours);
    const currentHour = new Date().getHours();
    if (!allowedHours.includes(currentHour)) {
      return { allowed: false, reason: 'outside_allowed_hours' };
    }
  }

  // Check model-specific quotas
  if (client.model_quotas && model) {
    const modelQuotas = JSON.parse(client.model_quotas);
    if (modelQuotas[model]) {
      const quota = modelQuotas[model];
      const modelMetrics = getAggregatedMetrics({ clientId: client.id });
      const modelUsage = modelMetrics.filter(m => m.model === model).reduce((sum, m) => sum + m.total_requests, 0);

      if (quota.rpm && modelUsage >= quota.rpm) {
        return { allowed: false, reason: 'model_rpm_exceeded' };
      }
    }
  }

  return { allowed: true };
}

// Rate limiting counters
const rateLimit = new Map(); // clientId -> { rpm: { timestamp, count }, tpm: { timestamp, count }, tpd: { timestamp, count } }

function checkRateLimit(client, estimatedTokens = 0) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const day = Math.floor(now / 86400000);

  if (!rateLimit.has(client.id)) {
    rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 }, tpd: { timestamp: day, count: 0 } });
  }

  const limits = rateLimit.get(client.id);

  // Check RPM
  if (client.rpmLimit > 0) {
    if (limits.rpm.timestamp !== minute) {
      limits.rpm = { timestamp: minute, count: 0 };
    }
    if (limits.rpm.count >= client.rpmLimit) {
      return { allowed: false, reason: 'rpm_limit', resetAt: (minute + 1) * 60000 };
    }
  }

  // Check TPM
  if (client.tpmLimit > 0) {
    if (limits.tpm.timestamp !== minute) {
      limits.tpm = { timestamp: minute, count: 0 };
    }
    if (limits.tpm.count + estimatedTokens > client.tpmLimit) {
      return { allowed: false, reason: 'tpm_limit', resetAt: (minute + 1) * 60000 };
    }
  }

  return { allowed: true };
}

function incrementRateLimit(client, actualTokens = 0) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const day = Math.floor(now / 86400000);

  if (!rateLimit.has(client.id)) {
    rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 }, tpd: { timestamp: day, count: 0 } });
  }

  const limits = rateLimit.get(client.id);

  // Increment RPM
  if (limits.rpm.timestamp !== minute) {
    limits.rpm = { timestamp: minute, count: 0 };
  }
  limits.rpm.count++;

  // Increment TPM
  if (limits.tpm.timestamp !== minute) {
    limits.tpm = { timestamp: minute, count: 0 };
  }
  limits.tpm.count += actualTokens;

  // Increment TPD
  if (limits.tpd.timestamp !== day) {
    limits.tpd = { timestamp: day, count: 0 };
  }
  limits.tpd.count += actualTokens;
}

/* ---------- نظام المصادقة ---------- */
function authMiddleware(req, res, next) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  
  // السماح بالوصول إذا كان HOST محلياً
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return next();
  }
  
  // التحقق من JWT token
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const verification = verifyToken(token);
  if (!verification.success) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.user = verification.user;
  next();
}

// API routes for authentication
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }
  
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }
  
  try {
    const user = createUser(username, password, true); // First user is admin
    const authResult = verifyUser(username, password);
    res.json({ success: true, token: authResult.token, user: authResult.user });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, message: 'Username already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }
  
  const result = verifyUser(username, password);
  res.json(result);
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  // JWT is stateless, just return success
  res.json({ success: true, message: 'Logged out' });
});

/* ---------- لوحة الإدارة ---------- */
const A = '/admin/api';
app.use(A, (req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const adminToken = process.env.ADMIN_TOKEN || '';
  const providedToken = req.query.token || req.headers['x-admin-token'] || '';

  // السماح بالوصول إذا كان HOST محلياً
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return next();
  }
  
  // التحقق من JWT token (طريقة جديدة)
  const authHeader = req.headers.authorization;
  const jwtToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (jwtToken) {
    const verification = verifyToken(jwtToken);
    if (verification.success) {
      req.user = verification.user;
      const o = req.headers.origin;
      if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'forbidden origin' });
      return next();
    }
  }
  
  // التحقق من ADMIN_TOKEN (طريقة قديمة للتوافق)
  if (!adminToken || providedToken !== adminToken) {
    return res.status(403).json({ error: 'forbidden host - requires valid admin token' });
  }
  const o = req.headers.origin;
  if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'forbidden origin' });
  next();
});
app.use('/admin', (req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const adminToken = process.env.ADMIN_TOKEN || '';
  const providedToken = req.query.token || req.headers['x-admin-token'] || '';

  // السماح بالوصول إذا كان HOST محلياً
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return next();
  }
  
  // التحقق من JWT token (طريقة جديدة)
  const authHeader = req.headers.authorization;
  const jwtToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (jwtToken) {
    const verification = verifyToken(jwtToken);
    if (verification.success) {
      req.user = verification.user;
      return next();
    }
  }
  
  // التحقق من ADMIN_TOKEN (طريقة قديمة للتوافق)
  if (!adminToken || providedToken !== adminToken) {
    return res.status(403).json({ error: 'forbidden host - requires valid admin token' });
  }
  next();
}, express.static(fileURLToPath(new URL('./public', import.meta.url)), { index: 'admin.html' }));

// الصفحة الرئيسية - إضافة مفاتيح
app.get('/', (req, res) => {
  res.sendFile(fileURLToPath(new URL('./public/index.html', import.meta.url)));
});

// صفحة تسجيل الدخول
app.get('/login.html', (req, res) => {
  res.sendFile(fileURLToPath(new URL('./public/login.html', import.meta.url)));
});

// صفحة إنشاء حساب
app.get('/register.html', (req, res) => {
  res.sendFile(fileURLToPath(new URL('./public/register.html', import.meta.url)));
});
app.use('/locales', express.static(fileURLToPath(new URL('./locales', import.meta.url))));

mountModels(app, A);
mountSmart(app, A);
app.get(A + '/state', (_, res) => {
  loadToLegacy();
  const providers = {};
  for (const p of getProviders()) {
    providers[p.name] = p;
  }
  res.json({
    providers: Object.entries(providers).map(([name, p]) => ({
      name, baseUrl: p.baseUrl, defaultModel: p.defaultModel, models: p.models || {}, scanning: !!p.scanning, note: p.note || '', locked: !!p.defaultLocked, scannedAt: p.scannedAt || 0,
      keys: p.keys.map((k) => ({
        id: k.id, tail: k.tail, status: k.status || '', disabled: !!k.disabled, used: k.used || 0, errors: k.errors || 0,
        cooldown: Math.max(0, Math.ceil(((cool.get(k.id) || 0) - Date.now()) / 1000)),
      })),
    })),
    clients: getClients().map(({ hash, ...c }) => c),
  });
});

app.put(A + '/providers/:n', (req, res) => {
  const n = req.params.n;
  if (!/^[a-z0-9_-]{1,30}$/.test(n)) return res.status(400).json({ error: 'bad name' });
  const { baseUrl, defaultModel } = req.body || {};
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) return res.status(400).json({ error: 'bad url' });
  const p = db.providers[n] || { keys: [] };
  if (baseUrl) p.baseUrl = String(baseUrl).replace(/\/+$/, '');
  if (defaultModel !== undefined) { p.defaultModel = String(defaultModel); p.defaultLocked = !!defaultModel; }
  saveProvider(n, { baseUrl: p.baseUrl, defaultModel: p.defaultModel, defaultLocked: p.defaultLocked });
  db.providers[n] = p;
  save(true); res.json({ ok: true });
});
app.delete(A + '/providers/:n', (req, res) => {
  deleteProvider(req.params.n);
  delete db.providers[req.params.n];
  save(true); res.json({ ok: true });
});

app.post(A + '/providers/:n/keys', (req, res) => {
  const n = req.params.n;
  const p = db.providers[n];
  if (!p) return res.status(404).json({ error: 'no provider' });
  let added = 0;
  for (const k of String(req.body?.keys || '').split(/[\s,;]+/).filter((x) => x.length >= 8)) {
    const h = sha(k);
    const existingKeys = getKeys(n);
    if (existingKeys.some((x) => x.h === h)) continue;
    addKey(n, { id: crypto.randomUUID(), h, enc: enc(k), tail: k.slice(-4), used: 0, errors: 0 });
    added++;
  }
  p.keys = getKeys(n);
  save(true); res.json({ added });
});
app.post(A + '/providers/:n/keys/:id/toggle', (req, res) => {
  const n = req.params.n;
  const k = getKeys(n).find((x) => x.id === req.params.id);
  if (!k) return res.status(404).json({ error: 'no key' });
  updateKey(n, k.id, { disabled: !k.disabled });
  db.providers[n].keys = getKeys(n);
  save(true); res.json({ ok: true });
});
app.delete(A + '/providers/:n/keys/:id', (req, res) => {
  const n = req.params.n;
  deleteKey(n, req.params.id);
  db.providers[n].keys = getKeys(n);
  save(true); res.json({ ok: true });
});

app.post(A + '/clients', (req, res) => {
  const key = 'sk-kp-' + crypto.randomBytes(24).toString('hex');
  const result = addClient(
    String(req.body?.name || 'unnamed').slice(0, 60),
    key,
    sha(key),
    key.slice(0, 10) + '…' + key.slice(-4),
    {
      monthly_budget: req.body?.monthly_budget,
      daily_budget: req.body?.daily_budget,
      hourly_budget: req.body?.hourly_budget,
      tier: req.body?.tier,
      model_quotas: req.body?.model_quotas,
      allowed_hours: req.body?.allowed_hours
    }
  );

  // Set budget and rate limits if provided
  if (req.body?.budget !== undefined || req.body?.rpmLimit !== undefined || req.body?.tpmLimit !== undefined) {
    const stmt = db_sqlite.prepare(`
      UPDATE clients
      SET budget = ?, rpm_limit = ?, tpm_limit = ?
      WHERE id = ?
    `);
    stmt.run(
      req.body?.budget || null,
      req.body?.rpmLimit || 0,
      req.body?.tpmLimit || 0,
      result.id
    );
  }

  loadToLegacy();
  save(true); res.json({ key });
});
app.delete(A + '/clients/:id', (req, res) => {
  deleteClient(req.params.id);
  loadToLegacy();
  save(true); res.json({ ok: true });
});

app.put(A + '/clients/:id', (req, res) => {
  const { budget, rpmLimit, tpmLimit } = req.body || {};
  const stmt = db_sqlite.prepare(`
    UPDATE clients
    SET budget = ?, rpm_limit = ?, tpm_limit = ?
    WHERE id = ?
  `);
  stmt.run(
    budget !== undefined ? budget : null,
    rpmLimit !== undefined ? rpmLimit : 0,
    tpmLimit !== undefined ? tpmLimit : 0,
    req.params.id
  );
  loadToLegacy();
  save(true); res.json({ ok: true });
});

app.get(A + '/clients/:id/spend', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const stmt = db_sqlite.prepare(`
    SELECT * FROM spend_logs
    WHERE client_id = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `);
  const logs = stmt.all(req.params.id, limit, offset);
  res.json({ logs, total: logs.length });
});

app.get(A + '/spend', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  const stmt = db_sqlite.prepare(`
    SELECT * FROM spend_logs
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `);
  const logs = stmt.all(limit, offset);
  res.json({ logs, total: logs.length });
});

app.get(A + '/metrics', (req, res) => {
  const filters = {};
  if (req.query.client_id) filters.clientId = req.query.client_id;
  if (req.query.model) filters.model = req.query.model;
  if (req.query.provider) filters.providerName = req.query.provider;
  if (req.query.from) filters.from = parseInt(req.query.from);
  if (req.query.to) filters.to = parseInt(req.query.to);

  const aggregated = getAggregatedMetrics(filters);
  res.json({ metrics: aggregated });
});

/* ---------- البروكسي (متوافق مع OpenAI) ---------- */
app.get('/health', (_, res) => res.json({ ok: true }));

app.use('/v1', (req, res, next) => {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const clients = getClients();
  const c = getClientByHash(sha(String(t)));
  if (!c) return res.status(401).json(err('invalid api key'));

  // Check budget
  if (c.budget > 0 && c.spend >= c.budget) {
    return res.status(429).json(err('budget exceeded'));
  }

  // Check advanced quotas
  const quotaCheck = checkQuotas(c, req.body?.model);
  if (!quotaCheck.allowed) {
    return res.status(429).json(err(`quota exceeded: ${quotaCheck.reason}`));
  }

  // Check rate limits (without token estimation for now)
  const rateCheck = checkRateLimit(c);
  if (!rateCheck.allowed) {
    return res.status(429).json(err(`rate limit exceeded: ${rateCheck.reason}`));
  }

  updateClientUsage(c.id);
  loadToLegacy();
  next();
});

async function callProvider(name, p, path, body, signal, modelName = null) {
  const keys = getKeys(name).filter((k) => !k.disabled && k.status !== 'nocredit' && k.status !== 'invalid');

  // Select key based on health
  const selectedKey = selectKeyForRequest(keys, modelName);
  if (!selectedKey) return null;

  const startTime = Date.now();
  let r;
  try {
    r = await fetch(p.baseUrl + path, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret(selectedKey) },
      body: JSON.stringify(body),
    });
  } catch (error) {
    updateKeyAfterRequest(name, selectedKey.id, false, error.message);
    if (signal.aborted) return null;
    cool.set(selectedKey.id, Date.now() + 10_000);
    return null;
  }

  const latency = Date.now() - startTime;
  updateKey(name, selectedKey.id, { used: (selectedKey.used || 0) + 1 });

  if (r.ok) {
    updateKeyAfterRequest(name, selectedKey.id, true);
    return r;
  }

  updateKey(name, selectedKey.id, { errors: (selectedKey.errors || 0) + 1 });
  updateKeyAfterRequest(name, selectedKey.id, false, `HTTP ${r.status}`);

  if (r.status === 429) {
    cool.set(selectedKey.id, Date.now() + Math.min(Number(r.headers.get('retry-after')) || 60, 3600) * 1000);
    r.body?.cancel();
  }
  if (r.status === 401 || r.status === 403) {
    cool.set(selectedKey.id, Date.now() + 3_600_000);
    r.body?.cancel();
  }
  if (r.status >= 500) {
    cool.set(selectedKey.id, Date.now() + 10_000);
    r.body?.cancel();
  }

  return r;
}

async function proxy(req, res, path, needPrefix) {
  const body = req.body || {};
  const m = String(body.model || 'auto');
  const strategy = req.headers['x-routing-strategy'] || req.query.strategy || 'balanced';

  const i = m.indexOf('/');
  const named = i > 0 ? db.providers[m.slice(0, i)] : null;
  let chain;
  if (named) chain = [[m.slice(0, i), named, m.slice(i + 1)]];
  else if (needPrefix) return res.status(400).json(err('model must be "provider/model"'));
  else chain = Object.entries(db.providers).flatMap(([n, p]) => autoModels(p).map((m) => [n, p, m]));

  // Apply smart routing if strategy is specified and model is 'auto'
  if (m === 'auto' && strategy !== 'fallback') {
    const modelsWithProviders = chain.map(([n, p, model]) => ({ id: model, provider: n, name: p.name }));
    const selected = selectModelForRequest(modelsWithProviders, strategy);
    if (selected) {
      chain = [[selected.provider, db.providers[selected.provider], selected.id]];
    }
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let last = null, lastName = '';
  const startTime = Date.now();

  for (const [n, p, model] of chain) {
    const r = await callProvider(n, p, path, { ...body, model }, ac.signal, model);
    if (ac.signal.aborted) return;
    if (!r) continue;
    if (!r.ok && r.status === 404 && p.models?.[model]) {
      p.models[model].ok = false;
      p.models[model].err = '404 at runtime';
      saveModels(n, p.models);
      save();
    }
    if (r.ok) { last?.body?.cancel(); last = r; lastName = n; break; }
    last?.body?.cancel(); last = r; lastName = n;
  }
  if (!last) return res.status(503).json(err('all providers/keys exhausted'));

  const latency = Date.now() - startTime;
  res.status(last.status);
  res.setHeader('Content-Type', last.headers.get('content-type') || 'application/json');
  res.setHeader('x-proxy-provider', lastName);
  res.setHeader('x-routing-strategy', strategy);

  // Log the request after completion
  const clients = getClients();
  const client = getClientByHash(sha(String((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '')));
  if (client) {
    // Estimate cost (simplified - would need pricing data for accurate calculation)
    const estimatedCost = 0.001; // Placeholder
    updateClientSpend(client.id, estimatedCost);
    incrementRateLimit(client, 1000); // Estimate 1000 tokens

    logSpend({
      clientId: client.id,
      provider: lastName,
      model: body.model,
      cost: estimatedCost,
      tokens: 1000, // Placeholder
      latency,
      status: 'success'
    });

    // Log to metrics table
    logMetric({
      clientId: client.id,
      model: body.model,
      providerName: lastName,
      tokens: 1000,
      cost: estimatedCost,
      latencyMs: latency,
      status: 'success'
    });

    // Update model metrics
    incrementModelRequest(body.model, lastName, latency, true);

    // Alert if latency is high
    if (latency > 2000) {
      console.warn(`⚠️ High latency: ${latency}ms for model ${body.model} via ${lastName}`);
    }
  }

  Readable.fromWeb(last.body).on('error', () => res.end()).pipe(res);
}

app.post('/v1/chat/completions', (req, res) => proxy(req, res, '/chat/completions', false));
app.post('/v1/embeddings', (req, res) => proxy(req, res, '/embeddings', true));
app.get('/v1/models', (_, res) => {
  loadToLegacy();
  const providers = {};
  for (const p of getProviders()) {
    providers[p.name] = p;
  }
  res.json({
    object: 'list',
    data: [{ id: 'auto', object: 'model' },
      ...Object.entries(providers).filter(([, p]) => p.keys.some((k) => !k.disabled && k.status !== 'nocredit' && k.status !== 'invalid'))
        .flatMap(([n, p]) => (Object.keys(p.models || {}).length
          ? Object.entries(p.models).filter(([, m]) => m.ok === true && m.enabled !== false).map(([id]) => id)
          : p.defaultModel ? [p.defaultModel] : [])
          .map((id) => ({ id: `${n}/${id}`, object: 'model' })))],
  });
});

const port = process.env.PORT || 8787;
const host = process.env.HOST || '127.0.0.1';
const adminToken = process.env.ADMIN_TOKEN || '';

// التحقق: إذا كان HOST عاماً، يجب وجود ADMIN_TOKEN
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  if (!adminToken || adminToken.length < 32) {
    console.error('❌ خطأ: HOST=' + host + ' يتطلب ADMIN_TOKEN (32+ حرف).');
    process.exit(1);
  }
  console.log('✅ HOST=' + host + ' مع ADMIN_TOKEN (الوضع العام).');
}
app.listen(port, host, (e) => {
  if (e) { console.error('listen failed:', e.message); process.exit(1); }
  console.log(`key-proxy: http://${host}:${port}/admin`);
});
startAuto(classify);
