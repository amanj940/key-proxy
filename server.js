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
import { validateModelAccess, normalizeModelPolicy, hasModelQuotaRemaining, isModelAllowed, rankModelsForRequest as rankPolicyModels } from './routing-policy.js';
import { calculateUsageCost, estimatePromptTokens, extractUsage } from './usage-meter.js';

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

function rankModelsForRequest(models, strategy, client, options = {}) {
  if (!models?.length || !client) return [];

  const modelByName = new Map();
  const metrics = {};
  const usage = {};
  for (const model of models) {
    const provider = model.provider || model.name;
    const modelId = model.id;
    if (!provider || !modelId) continue;
    const fullModelId = `${provider}/${modelId}`;
    modelByName.set(fullModelId, { provider, id: modelId, name: provider });
    metrics[fullModelId] = getModelMetrics(modelId, provider) || {};
    const snapshot = getModelUsageSnapshot(client, fullModelId);
    usage[fullModelId] = {
      rpm: snapshot.rpm_used,
      tpm: snapshot.tpm_used,
      rpd: snapshot.rpd_used
    };
  }

  return rankPolicyModels(client, [...modelByName.keys()], {
    strategy,
    metrics,
    usage,
    taskType: options.taskType || options.task_type || 'chat',
    priority: options.priority || options.routing_priority || 'medium'
  }).map((modelId) => modelByName.get(modelId));
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
  const minuteStart = Math.floor(now / 60000) * 60000;
  const parsedModelQuotas = normalizeModelPolicy(client).model_quotas;

  // Check monthly budget
  if (client.monthly_budget && client.spend >= client.monthly_budget) {
    return { allowed: false, reason: 'monthly_budget_exceeded' };
  }

  // Check daily budget
  if (client.daily_budget) {
    const dailySpend = getAggregatedMetrics({ clientId: client.id, from: dayStart })
      .reduce((sum, m) => sum + Number(m.total_cost || 0), 0);
    if (dailySpend >= client.daily_budget) {
      return { allowed: false, reason: 'daily_budget_exceeded' };
    }
  }

  // Check hourly budget
  if (client.hourly_budget) {
    const hourlySpend = getAggregatedMetrics({ clientId: client.id, from: hourStart })
      .reduce((sum, m) => sum + Number(m.total_cost || 0), 0);
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
  if (model && parsedModelQuotas && Object.keys(parsedModelQuotas).length > 0) {
    const quota = parsedModelQuotas[model] || parsedModelQuotas[model.replace(/^\w+\//, '')] || null;
    if (quota) {
      const minuteMetrics = getAggregatedMetrics({ clientId: client.id, model, from: minuteStart });
      const dayMetrics = getAggregatedMetrics({ clientId: client.id, model, from: dayStart });
      const minuteRequests = minuteMetrics.reduce((sum, m) => sum + Number(m.total_requests || 0), 0);
      const minuteTokens = minuteMetrics.reduce((sum, m) => sum + Number(m.total_tokens || 0), 0);
      const dayRequests = dayMetrics.reduce((sum, m) => sum + Number(m.total_requests || 0), 0);

      const quotaCheck = hasModelQuotaRemaining(client, model, {
        rpm: minuteRequests,
        tpm: minuteTokens,
        rpd: dayRequests
      });

      if (!quotaCheck.allowed) {
        return { allowed: false, reason: quotaCheck.reason };
      }
    }
  }

  return { allowed: true };
}

function checkRateLimit(client, estimatedTokens = 0) {
  const now = Date.now();
  const minuteStart = Math.floor(now / 60000) * 60000;
  const metrics = getAggregatedMetrics({ clientId: client.id, from: minuteStart });
  const requestCount = metrics.reduce((sum, item) => sum + Number(item.total_requests || 0), 0);
  const tokenCount = metrics.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0);

  if (client.rpmLimit > 0) {
    if (requestCount >= client.rpmLimit) {
      return { allowed: false, reason: 'rpm_limit', resetAt: minuteStart + 60000 };
    }
  }

  if (client.tpmLimit > 0) {
    if (tokenCount + estimatedTokens > client.tpmLimit) {
      return { allowed: false, reason: 'tpm_limit', resetAt: minuteStart + 60000 };
    }
  }

  return { allowed: true };
}

function getModelUsageSnapshot(client, modelName) {
  if (!client || !client.id || !modelName) {
    return { rpm_used: 0, tpm_used: 0, rpd_used: 0 };
  }

  const now = Date.now();
  const minuteStart = Math.floor(now / 60000) * 60000;
  const dayStart = Math.floor(now / 86400000) * 86400000;

  const minuteMetrics = getAggregatedMetrics({ clientId: client.id, model: modelName, from: minuteStart });
  const dayMetrics = getAggregatedMetrics({ clientId: client.id, model: modelName, from: dayStart });

  return {
    rpm_used: minuteMetrics.reduce((sum, m) => sum + Number(m.total_requests || 0), 0),
    tpm_used: minuteMetrics.reduce((sum, m) => sum + Number(m.total_tokens || 0), 0),
    rpd_used: dayMetrics.reduce((sum, m) => sum + Number(m.total_requests || 0), 0)
  };
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
  // السماح بتحميل الصفحة بدون token - التحقق يتم في JavaScript
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
app.get('/language.js', (_, res) => {
  res.sendFile(fileURLToPath(new URL('./public/language.js', import.meta.url)));
});

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
      default_model: req.body?.default_model,
      allowed_models: req.body?.allowed_models,
      allowed_providers: req.body?.allowed_providers,
      routing_strategy: req.body?.routing_strategy,
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
  const { budget, rpmLimit, tpmLimit, default_model, allowed_models, allowed_providers, routing_strategy, model_quotas, allowed_hours } = req.body || {};
  const stmt = db_sqlite.prepare(`
    UPDATE clients
    SET budget = ?, rpm_limit = ?, tpm_limit = ?,
        default_model = ?, allowed_models = ?, allowed_providers = ?, routing_strategy = ?,
        model_quotas = ?, allowed_hours = ?
    WHERE id = ?
  `);
  stmt.run(
    budget !== undefined ? budget : null,
    rpmLimit !== undefined ? rpmLimit : 0,
    tpmLimit !== undefined ? tpmLimit : 0,
    default_model !== undefined ? default_model : null,
    allowed_models ? JSON.stringify(allowed_models) : null,
    allowed_providers ? JSON.stringify(allowed_providers) : null,
    routing_strategy || 'balanced',
    model_quotas ? JSON.stringify(model_quotas) : null,
    allowed_hours ? JSON.stringify(allowed_hours) : null,
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
  const c = getClientByHash(sha(String(t)));
  if (!c) return res.status(401).json(err('invalid api key'));

  const requestedModel = req.body?.model || 'auto';
  const isAutoRequest = requestedModel === 'auto';
  const accessCheck = isAutoRequest ? { allowed: true, model: 'auto' } : validateModelAccess(c, requestedModel);
  if (!accessCheck.allowed) {
    return res.status(403).json(err(`model access denied: ${accessCheck.reason}`));
  }

  req.body = { ...(req.body || {}), model: accessCheck.model };

  if (c.budget > 0 && c.spend >= c.budget) {
    return res.status(429).json(err('budget exceeded'));
  }

  const quotaCheck = checkQuotas(c, isAutoRequest ? null : accessCheck.model);
  if (!quotaCheck.allowed) {
    return res.status(429).json(err(`quota exceeded: ${quotaCheck.reason}`));
  }

  const rateCheck = checkRateLimit(c, estimatePromptTokens(req.body || {}));
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
  const strategy = req.headers['x-routing-strategy'] || req.query.strategy || normalizeModelPolicy(getClientByHash(sha(String((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '')))||{}).routing_strategy || 'balanced';
  const priority = String(body.priority || body.routing_priority || 'medium').toLowerCase();
  const effectiveStrategy = priority === 'background' ? 'cheapest' : strategy;

  const i = m.indexOf('/');
  const named = i > 0 ? db.providers[m.slice(0, i)] : null;
  let chain;
  if (named) chain = [[m.slice(0, i), named, m.slice(i + 1)]];
  else if (needPrefix) return res.status(400).json(err('model must be "provider/model"'));
  else chain = Object.entries(db.providers).flatMap(([n, p]) => autoModels(p).map((m) => [n, p, m]));

  // Rank all policy-eligible models so exhausted quotas fall through to the next candidate.
  if (m === 'auto') {
    const modelsWithProviders = chain.map(([n, p, model]) => ({ id: model, provider: n, name: p.name }));
    const client = getClientByHash(sha(String((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '')));
    const rankedModels = rankModelsForRequest(modelsWithProviders, effectiveStrategy, client, {
      taskType: body.task_type || body.taskType || 'chat',
      priority: body.priority || body.routing_priority || 'medium'
    });
    chain = rankedModels.map(({ provider, id }) => [provider, db.providers[provider], id]);
    if (!chain.length) return res.status(429).json(err('no allowed models with quota remaining'));
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  let last = null, lastName = '', lastModel = '';
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
    if (r.ok) { last?.body?.cancel(); last = r; lastName = n; lastModel = model; break; }
    last?.body?.cancel(); last = r; lastName = n; lastModel = model;
  }
  if (!last) return res.status(503).json(err('all providers/keys exhausted'));

  const latency = Date.now() - startTime;
  res.status(last.status);
  res.setHeader('Content-Type', last.headers.get('content-type') || 'application/json');
  res.setHeader('x-proxy-provider', lastName);
  res.setHeader('x-routing-strategy', effectiveStrategy);

  // Persist provider-reported usage after the response has been consumed.
  const client = getClientByHash(sha(String((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '')));
  if (client) {
    const requestTokenEstimate = estimatePromptTokens(body);
    const modelName = String(lastModel || body.model || '');
    const modelId = modelName.startsWith(`${lastName}/`) ? modelName.slice(lastName.length + 1) : modelName;
    const metrics = getModelMetrics(modelId, lastName) || {};
    const usagePromise = last.clone().text().then(extractUsage).catch(() => null);

    void usagePromise.then((usage) => {
      const tokens = usage?.totalTokens ?? requestTokenEstimate;
      const cost = calculateUsageCost(usage, metrics);
      const status = last.ok ? 'success' : 'error';

      if (cost !== null) {
        updateClientSpend(client.id, cost);
        logSpend({ clientId: client.id, provider: lastName, model: modelName, cost, tokens, latency, status });
      }

      logMetric({
        clientId: client.id,
        model: modelName,
        providerName: lastName,
        tokens,
        usageKnown: Boolean(usage),
        cost: cost ?? 0,
        costKnown: cost !== null,
        latencyMs: latency,
        status
      });
      incrementModelRequest(modelId, lastName, latency, last.ok);

      if (latency > 2000) {
        console.warn(`⚠️ High latency: ${latency}ms for model ${modelName} via ${lastName}`);
      }
    }).catch((error) => console.error('Failed to persist usage metrics:', error.message));
  }

  Readable.fromWeb(last.body).on('error', () => res.end()).pipe(res);
}

app.post('/v1/chat/completions', (req, res) => proxy(req, res, '/chat/completions', false));
app.post('/v1/embeddings', (req, res) => proxy(req, res, '/embeddings', true));
app.get('/v1/models', (req, res) => {
  loadToLegacy();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const client = token ? getClientByHash(sha(String(token))) : null;

  const providers = {};
  for (const p of getProviders()) {
    providers[p.name] = p;
  }

  const policy = client ? normalizeModelPolicy(client) : { model_quotas: {} };

  const data = [{
    id: 'auto',
    object: 'model',
    provider: 'auto',
    type: 'chat',
    default: !!(client && policy.default_model),
    quota: null,
    rpm_limit: null,
    rpm_remaining: null,
    tpm_limit: null,
    tpm_remaining: null,
    rpd_limit: null,
    rpd_remaining: null
  }];

  for (const [providerName, provider] of Object.entries(providers)) {
    if (!provider.keys.some((k) => !k.disabled && k.status !== 'nocredit' && k.status !== 'invalid')) continue;

    const modelIds = Object.keys(provider.models || {}).length
      ? Object.entries(provider.models).filter(([, m]) => m.ok === true && m.enabled !== false).map(([id]) => id)
      : provider.defaultModel ? [provider.defaultModel] : [];

    for (const modelId of modelIds) {
      const fullModelId = `${providerName}/${modelId}`;
      if (client && !isModelAllowed(client, fullModelId)) continue;
      const quotaKey = policy.model_quotas && (policy.model_quotas[fullModelId] || policy.model_quotas[modelId]);
      const usage = client ? getModelUsageSnapshot(client, fullModelId) : { rpm_used: 0, tpm_used: 0, rpd_used: 0 };
      const quotaRemaining = quotaKey
        ? {
            rpm_limit: Number(quotaKey.rpm || 0),
            rpm_remaining: Math.max(0, Number(quotaKey.rpm || 0) - Number(usage.rpm_used || 0)),
            tpm_limit: Number(quotaKey.tpm || 0),
            tpm_remaining: Math.max(0, Number(quotaKey.tpm || 0) - Number(usage.tpm_used || 0)),
            rpd_limit: Number(quotaKey.rpd || 0),
            rpd_remaining: Math.max(0, Number(quotaKey.rpd || 0) - Number(usage.rpd_used || 0))
          }
        : {
            rpm_limit: null,
            rpm_remaining: null,
            tpm_limit: null,
            tpm_remaining: null,
            rpd_limit: null,
            rpd_remaining: null
          };

      const metrics = getModelMetrics(modelId, providerName) || {};
      data.push({
        id: fullModelId,
        object: 'model',
        provider: providerName,
        type: provider.models?.[modelId]?.type || 'chat',
        context_length: Number(metrics.context_length || 4096),
        supports_vision: !!metrics.supports_vision,
        supports_tools: !!metrics.supports_tools,
        cost_per_1k_input: Number(metrics.cost_per_1k_input || 0),
        cost_per_1k_output: Number(metrics.cost_per_1k_output || 0),
        avg_latency_ms: Number(metrics.avg_latency_ms || 0),
        success_rate: Number(metrics.success_rate || 1),
        score: Number(metrics.score || 0.5),
        default: !!(client && policy.default_model === fullModelId),
        quota: quotaKey || null,
        ...quotaRemaining,
        rpm_used: usage.rpm_used,
        tpm_used: usage.tpm_used,
        rpd_used: usage.rpd_used
      });
    }
  }

  res.json({ object: 'list', data });
});

const port = process.env.PORT || 8787;
const host = process.env.HOST || '127.0.0.1';

app.listen(port, host, (e) => {
  if (e) { console.error('listen failed:', e.message); process.exit(1); }
  console.log(`kos-proxy: http://${host}:${port}/admin`);
  console.log(`Login: http://${host}:${port}/login.html`);
  console.log(`Register: http://${host}:${port}/register.html`);
});
startAuto(classify);
