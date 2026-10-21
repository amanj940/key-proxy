import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DB_PATH = process.env.DB_PATH || './data/key-proxy.db';
const MK = Buffer.from(process.env.MASTER_KEY || '', 'hex');
if (MK.length !== 32) throw new Error('MASTER_KEY must be 64 hex chars (openssl rand -hex 32)');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
if (JWT_SECRET === 'change-this-secret-in-production') {
  console.warn('⚠️  WARNING: Using default JWT_SECRET. Set JWT_SECRET environment variable in production!');
}

// Initialize SQLite
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    name TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    default_model TEXT,
    default_locked INTEGER DEFAULT 0,
    note TEXT,
    scanning INTEGER DEFAULT 0,
    scanned_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL,
    h TEXT NOT NULL,
    enc TEXT NOT NULL,
    tail TEXT NOT NULL,
    status TEXT DEFAULT 'unverified',
    disabled INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 1.0,
    last_error TEXT,
    cooldown_until INTEGER DEFAULT 0,
    allowed_models TEXT,
    rpm_limit INTEGER DEFAULT 0,
    tpm_limit INTEGER DEFAULT 0,
    FOREIGN KEY (provider_name) REFERENCES providers(name) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS models (
    provider_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    type TEXT NOT NULL,
    ok INTEGER,
    enabled INTEGER DEFAULT 1,
    err TEXT,
    at INTEGER,
    PRIMARY KEY (provider_name, model_id),
    FOREIGN KEY (provider_name) REFERENCES providers(name) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    last_used INTEGER,
    budget REAL,
    spend REAL DEFAULT 0,
    rpm_limit INTEGER DEFAULT 0,
    tpm_limit INTEGER DEFAULT 0,
    monthly_budget REAL,
    daily_budget REAL,
    hourly_budget REAL,
    tier TEXT DEFAULT 'free',
    default_model TEXT,
    allowed_models TEXT,
    allowed_providers TEXT,
    routing_strategy TEXT DEFAULT 'balanced',
    model_quotas TEXT,
    allowed_hours TEXT
  );

  CREATE TABLE IF NOT EXISTS spend_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    model TEXT NOT NULL,
    cost REAL NOT NULL,
    tokens INTEGER NOT NULL,
    latency INTEGER NOT NULL,
    status TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS model_metrics (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    avg_latency_ms REAL DEFAULT 0,
    success_rate REAL DEFAULT 1.0,
    cost_per_1k_input REAL DEFAULT 0,
    cost_per_1k_output REAL DEFAULT 0,
    context_length INTEGER DEFAULT 4096,
    supports_vision INTEGER DEFAULT 0,
    supports_tools INTEGER DEFAULT 0,
    total_requests INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    score REAL DEFAULT 0.5,
    updated_at INTEGER DEFAULT 0,
    UNIQUE(model_id, provider_name)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    usage_known INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL,
    cost_known INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE INDEX IF NOT EXISTS idx_keys_provider ON keys(provider_name);
  CREATE INDEX IF NOT EXISTS idx_keys_status ON keys(status);
  CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_name);
  CREATE INDEX IF NOT EXISTS idx_clients_hash ON clients(hash);
  CREATE INDEX IF NOT EXISTS idx_spend_logs_client ON spend_logs(client_id);
  CREATE INDEX IF NOT EXISTS idx_spend_logs_timestamp ON spend_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_model_metrics_model ON model_metrics(model_id);
  CREATE INDEX IF NOT EXISTS idx_metrics_client ON metrics(client_id);
  CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
`);

try {
  db.exec('ALTER TABLE metrics ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  if (!String(e.message).includes('duplicate column name')) throw e;
}
try {
  db.exec('ALTER TABLE metrics ADD COLUMN usage_known INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  if (!String(e.message).includes('duplicate column name')) throw e;
}

// Users table for authentication
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_admin INTEGER DEFAULT 0
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// Migration: Add users table if it doesn't exist
try {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  console.log('✅ Users table exists with', userCount.count, 'users');
} catch (error) {
  if (error.message.includes('no such table')) {
    console.log('⚠️  Users table missing, creating...');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        is_admin INTEGER DEFAULT 0
      );
    `);
    db.exec('CREATE INDEX idx_users_username ON users(username)');
    console.log('✅ Users table created');
  } else {
    console.error('❌ Error checking users table:', error.message);
  }
}

// Migration: Add new columns if they don't exist
try {
  db.exec(`ALTER TABLE keys ADD COLUMN success_rate REAL DEFAULT 1.0`);
} catch (e) { console.log('Migration: success_rate column exists or failed'); }
try {
  db.exec(`ALTER TABLE keys ADD COLUMN last_error TEXT`);
} catch (e) { console.log('Migration: last_error column exists or failed'); }
try {
  db.exec(`ALTER TABLE keys ADD COLUMN cooldown_until INTEGER DEFAULT 0`);
} catch (e) { console.log('Migration: cooldown_until column exists or failed'); }
try {
  db.exec(`ALTER TABLE keys ADD COLUMN allowed_models TEXT`);
} catch (e) { console.log('Migration: allowed_models column exists or failed'); }
try {
  db.exec(`ALTER TABLE keys ADD COLUMN rpm_limit INTEGER DEFAULT 0`);
} catch (e) { console.log('Migration: rpm_limit column exists or failed'); }
try {
  db.exec(`ALTER TABLE keys ADD COLUMN tpm_limit INTEGER DEFAULT 0`);
} catch (e) { console.log('Migration: tpm_limit column exists or failed'); }
try {
  db.exec(`ALTER TABLE keys ADD COLUMN error_count INTEGER DEFAULT 0`);
} catch (e) { console.log('Migration: error_count column exists or failed'); }

try {
  db.exec(`ALTER TABLE clients ADD COLUMN monthly_budget REAL`);
} catch (e) { console.log('Migration: monthly_budget column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN daily_budget REAL`);
} catch (e) { console.log('Migration: daily_budget column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN hourly_budget REAL`);
} catch (e) { console.log('Migration: hourly_budget column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN tier TEXT DEFAULT 'free'`);
} catch (e) { console.log('Migration: tier column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN default_model TEXT`);
} catch (e) { console.log('Migration: default_model column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN allowed_models TEXT`);
} catch (e) { console.log('Migration: allowed_models column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN allowed_providers TEXT`);
} catch (e) { console.log('Migration: allowed_providers column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN routing_strategy TEXT DEFAULT 'balanced'`);
} catch (e) { console.log('Migration: routing_strategy column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN model_quotas TEXT`);
} catch (e) { console.log('Migration: model_quotas column exists or failed'); }
try {
  db.exec(`ALTER TABLE clients ADD COLUMN allowed_hours TEXT`);
} catch (e) { console.log('Migration: allowed_hours column exists or failed'); }

export const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MK, iv);
  const e = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
};
export const dec = (s) => {
  const b = Buffer.from(s, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', MK, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
export const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

const PRESETS = {
  groq: ['https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
  openrouter: ['https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct:free'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash'],
  cerebras: ['https://api.cerebras.ai/v1', 'llama-3.3-70b'],
  mistral: ['https://api.mistral.ai/v1', 'mistral-small-latest'],
  sambanova: ['https://api.sambanova.ai/v1', 'Meta-Llama-3.3-70B-Instruct'],
  nvidia: ['https://integrate.api.nvidia.com/v1', 'meta/llama-3.3-70b-instruct'],
};

// Initialize presets
for (const [name, [baseUrl, defaultModel]] of Object.entries(PRESETS)) {
  const stmt = db.prepare('INSERT OR IGNORE INTO providers (name, base_url, default_model) VALUES (?, ?, ?)');
  stmt.run(name, baseUrl, defaultModel);
}

// Helper functions
export function getProviders() {
  const stmt = db.prepare(`
    SELECT name, base_url as baseUrl, default_model as defaultModel,
           default_locked as defaultLocked, note, scanning as scanning,
           scanned_at as scannedAt
    FROM providers
  `);
  const providers = stmt.all();

  for (const p of providers) {
    p.keys = getKeys(p.name);
    p.models = getModels(p.name);
  }

  return providers;
}

export function getKeys(providerName) {
  const stmt = db.prepare('SELECT * FROM keys WHERE provider_name = ?');
  const keys = stmt.all(providerName);
  // Ensure error_count exists on all keys for compatibility
  return keys.map(k => ({
    ...k,
    error_count: k.error_count || 0,
    success_rate: k.success_rate || 1.0,
    cooldown_until: k.cooldown_until || 0
  }));
}

export function getModels(providerName) {
  const stmt = db.prepare('SELECT model_id as id, type, ok, enabled, err, at FROM models WHERE provider_name = ?');
  const models = stmt.all(providerName);
  const result = {};
  for (const m of models) {
    result[m.id] = {
      type: m.type,
      ok: m.ok === 1,
      enabled: m.enabled === 1,
      err: m.err,
      at: m.at
    };
  }
  return result;
}

export function getClients() {
  const stmt = db.prepare(`
    SELECT id, name, prefix, created_at as created, used, last_used as last,
           budget, spend, rpm_limit as rpmLimit, tpm_limit as tpmLimit,
           monthly_budget, daily_budget, hourly_budget, tier,
           default_model as defaultModel,
           allowed_models as allowedModels,
           allowed_providers as allowedProviders,
           routing_strategy as routingStrategy,
           model_quotas, allowed_hours
    FROM clients
  `);
  return stmt.all();
}

export function saveProvider(name, data) {
  const stmt = db.prepare(`
    INSERT INTO providers (name, base_url, default_model, default_locked)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      base_url = excluded.base_url,
      default_model = excluded.default_model,
      default_locked = excluded.default_locked
  `);
  stmt.run(name, data.baseUrl, data.defaultModel, data.defaultLocked ? 1 : 0);
}

export function deleteProvider(name) {
  db.prepare('DELETE FROM providers WHERE name = ?').run(name);
}

export function addKey(providerName, keyData) {
  const stmt = db.prepare(`
    INSERT INTO keys (id, provider_name, h, enc, tail, status, disabled, used, errors, success_rate, last_error, cooldown_until, allowed_models, rpm_limit, tpm_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    keyData.id,
    providerName,
    keyData.h,
    keyData.enc,
    keyData.tail,
    keyData.status || 'unverified',
    keyData.disabled ? 1 : 0,
    keyData.used || 0,
    keyData.errors || 0,
    keyData.success_rate || 1.0,
    keyData.last_error || null,
    keyData.cooldown_until || 0,
    keyData.allowed_models ? JSON.stringify(keyData.allowed_models) : null,
    keyData.rpm_limit || 0,
    keyData.tpm_limit || 0
  );
}

export function updateKey(providerName, keyId, updates) {
  const setClauses = [];
  const params = [];

  if (updates.disabled !== undefined) {
    setClauses.push('disabled = ?');
    params.push(updates.disabled ? 1 : 0);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.used !== undefined) {
    setClauses.push('used = ?');
    params.push(updates.used);
  }
  if (updates.errors !== undefined) {
    setClauses.push('errors = ?');
    params.push(updates.errors);
  }

  if (setClauses.length === 0) return;

  params.push(providerName, keyId);
  const stmt = db.prepare(`
    UPDATE keys SET ${setClauses.join(', ')}
    WHERE provider_name = ? AND id = ?
  `);
  stmt.run(...params);
}

export function deleteKey(providerName, keyId) {
  db.prepare('DELETE FROM keys WHERE provider_name = ? AND id = ?').run(providerName, keyId);
}

export function saveModels(providerName, models) {
  db.prepare('DELETE FROM models WHERE provider_name = ?').run(providerName);

  const stmt = db.prepare(`
    INSERT INTO models (provider_name, model_id, type, ok, enabled, err, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [id, m] of Object.entries(models)) {
    stmt.run(
      providerName,
      id,
      m.type,
      m.ok === true ? 1 : (m.ok === false ? 0 : null),
      m.enabled === false ? 0 : 1,
      m.err || null,
      m.at || null
    );
  }
}

export function addClient(name, key, hash, prefix, options = {}) {
  const id = crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO clients (
      id, name, hash, prefix, created_at,
      monthly_budget, daily_budget, hourly_budget,
      tier, default_model, allowed_models, allowed_providers, routing_strategy,
      model_quotas, allowed_hours
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    name,
    hash,
    prefix,
    Date.now(),
    options.monthly_budget || null,
    options.daily_budget || null,
    options.hourly_budget || null,
    options.tier || 'free',
    options.default_model || null,
    options.allowed_models ? JSON.stringify(options.allowed_models) : null,
    options.allowed_providers ? JSON.stringify(options.allowed_providers) : null,
    options.routing_strategy || 'balanced',
    options.model_quotas ? JSON.stringify(options.model_quotas) : null,
    options.allowed_hours ? JSON.stringify(options.allowed_hours) : null
  );
  return { id, key };
}

export function deleteClient(id) {
  // Delete spend_logs first due to foreign key constraint
  db.prepare('DELETE FROM spend_logs WHERE client_id = ?').run(id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

export function updateClientUsage(id) {
  const stmt = db.prepare(`
    UPDATE clients
    SET used = used + 1, last_used = ?
    WHERE id = ?
  `);
  stmt.run(Date.now(), id);
}

export function updateClientSpend(id, cost) {
  const stmt = db.prepare(`
    UPDATE clients
    SET spend = spend + ?
    WHERE id = ?
  `);
  stmt.run(cost, id);
}

export function logSpend(data) {
  const stmt = db.prepare(`
    INSERT INTO spend_logs (id, timestamp, client_id, provider_name, model, cost, tokens, latency, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    crypto.randomUUID(),
    Date.now(),
    data.clientId,
    data.provider,
    data.model,
    data.cost,
    data.tokens,
    data.latency,
    data.status
  );
}

export function updateProviderModels(providerName, models, note, scanning, scannedAt) {
  const stmt = db.prepare(`
    UPDATE providers
    SET note = ?, scanning = ?, scanned_at = ?
    WHERE name = ?
  `);
  stmt.run(note || null, scanning ? 1 : 0, scannedAt || 0, providerName);
  saveModels(providerName, models);
}

// Compatibility layer for existing code
export let db_legacy = {
  providers: {},
  clients: []
};

// Load data on startup
function loadToLegacy() {
  const providers = getProviders();
  db_legacy.providers = {};
  for (const p of providers) {
    db_legacy.providers[p.name] = p;
  }
  db_legacy.clients = getClients();
}

loadToLegacy();

// Save function that syncs to SQLite
export function save(now = false) {
  if (now) {
    loadToLegacy();
  }
}

// Backup function
export function backup(path) {
  fs.copyFileSync(DB_PATH, path);
}

export default db;
export { db as db_sqlite, loadToLegacy };

export function getClientByHash(hash) {
  // Query directly from SQLite to ensure up-to-date data
  const stmt = db.prepare(`
    SELECT id, name, hash, prefix, created_at as created, used, last_used as last,
           budget, spend, rpm_limit as rpmLimit, tpm_limit as tpmLimit,
           monthly_budget, daily_budget, hourly_budget, tier,
           default_model as defaultModel,
           allowed_models as allowedModels,
           allowed_providers as allowedProviders,
           routing_strategy as routingStrategy,
           model_quotas, allowed_hours
    FROM clients WHERE hash = ?
  `);
  return stmt.get(hash);
}

// User authentication functions
export function createUser(username, password, isAdmin = false) {
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const stmt = db.prepare(`
    INSERT INTO users (id, username, password_hash, created_at, is_admin)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, username, passwordHash, Date.now(), isAdmin ? 1 : 0);
  return { id, username, isAdmin };
}

export function verifyUser(username, password) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(username);
  
  if (!user) {
    return { success: false, message: 'User not found' };
  }
  
  const isValid = bcrypt.compareSync(password, user.password_hash);
  
  if (!isValid) {
    return { success: false, message: 'Invalid password' };
  }
  
  const token = jwt.sign(
    { userId: user.id, username: user.username, isAdmin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  return { 
    success: true, 
    token, 
    user: { 
      id: user.id, 
      username: user.username, 
      isAdmin: user.is_admin === 1 
    } 
  };
}

export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { success: true, user: decoded };
  } catch (error) {
    return { success: false, message: 'Invalid token' };
  }
}

export function getUserById(userId) {
  const stmt = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?');
  return stmt.get(userId);
}

// Model Metrics functions
export function getModelMetrics(modelId, providerName) {
  const stmt = db.prepare('SELECT * FROM model_metrics WHERE model_id = ? AND provider_name = ?');
  return stmt.get(modelId, providerName);
}

export function getAllModelMetrics() {
  const stmt = db.prepare('SELECT * FROM model_metrics');
  return stmt.all();
}

export function updateModelMetrics(modelId, providerName, data) {
  const stmt = db.prepare(`
    INSERT INTO model_metrics (id, model_id, provider_name, avg_latency_ms, success_rate, cost_per_1k_input, cost_per_1k_output, context_length, supports_vision, supports_tools, total_requests, total_errors, score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_id, provider_name) DO UPDATE SET
      avg_latency_ms = excluded.avg_latency_ms,
      success_rate = excluded.success_rate,
      cost_per_1k_input = excluded.cost_per_1k_input,
      cost_per_1k_output = excluded.cost_per_1k_output,
      context_length = excluded.context_length,
      supports_vision = excluded.supports_vision,
      supports_tools = excluded.supports_tools,
      total_requests = excluded.total_requests,
      total_errors = excluded.total_errors,
      score = excluded.score,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    crypto.randomUUID(),
    modelId,
    providerName,
    data.avg_latency_ms || 0,
    data.success_rate || 1.0,
    data.cost_per_1k_input || 0,
    data.cost_per_1k_output || 0,
    data.context_length || 4096,
    data.supports_vision ? 1 : 0,
    data.supports_tools ? 1 : 0,
    data.total_requests || 0,
    data.total_errors || 0,
    data.score || 0.5,
    Date.now()
  );
}

export function incrementModelRequest(modelId, providerName, latency, success) {
  const current = getModelMetrics(modelId, providerName) || {
    total_requests: 0,
    total_errors: 0,
    avg_latency_ms: 0,
    success_rate: 1.0
  };

  const newTotal = (current.total_requests || 0) + 1;
  const newErrors = (current.total_errors || 0) + (success ? 0 : 1);
  const newSuccessRate = (newTotal - newErrors) / newTotal;
  const newAvgLatency = current.avg_latency_ms * 0.9 + latency * 0.1;

  updateModelMetrics(modelId, providerName, {
    total_requests: newTotal,
    total_errors: newErrors,
    avg_latency_ms: newAvgLatency,
    success_rate: newSuccessRate
  });
}

// Key Health functions
export function updateKeyHealth(providerName, keyId, data) {
  // Try-catch for migration compatibility
  try {
    const stmt = db.prepare(`
      UPDATE keys
      SET success_rate = ?, error_count = ?, last_error = ?, cooldown_until = ?, allowed_models = ?, rpm_limit = ?, tpm_limit = ?
      WHERE id = ? AND provider_name = ?
    `);
    stmt.run(
      data.success_rate !== undefined ? data.success_rate : 1.0,
      data.error_count !== undefined ? data.error_count : 0,
      data.last_error || null,
      data.cooldown_until || 0,
      data.allowed_models ? JSON.stringify(data.allowed_models) : null,
      data.rpm_limit || 0,
      data.tpm_limit || 0,
      keyId,
      providerName
    );
  } catch (e) {
    // Fallback for old schema without new columns
    try {
      const stmt = db.prepare(`
        UPDATE keys
        SET success_rate = ?, last_error = ?, cooldown_until = ?, allowed_models = ?, rpm_limit = ?, tpm_limit = ?
        WHERE id = ? AND provider_name = ?
      `);
      stmt.run(
        data.success_rate !== undefined ? data.success_rate : 1.0,
        data.last_error || null,
        data.cooldown_until || 0,
        data.allowed_models ? JSON.stringify(data.allowed_models) : null,
        data.rpm_limit || 0,
        data.tpm_limit || 0,
        keyId,
        providerName
      );
    } catch (e2) {
      // Final fallback - update only existing columns
      const stmt = db.prepare(`
        UPDATE keys
        SET success_rate = ?, last_error = ?, cooldown_until = ?
        WHERE id = ? AND provider_name = ?
      `);
      stmt.run(
        data.success_rate !== undefined ? data.success_rate : 1.0,
        data.last_error || null,
        data.cooldown_until || 0,
        keyId,
        providerName
      );
    }
  }
}

export function getKeyHealth(providerName, keyId) {
  const stmt = db.prepare('SELECT * FROM keys WHERE id = ? AND provider_name = ?');
  return stmt.get(keyId, providerName);
}

// Metrics logging
export function logMetric(data) {
  const stmt = db.prepare(`
    INSERT INTO metrics (id, timestamp, client_id, model, provider_name, tokens, usage_known, cost, cost_known, latency_ms, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    crypto.randomUUID(),
    Date.now(),
    data.clientId,
    data.model,
    data.providerName,
    data.tokens,
    data.usageKnown ? 1 : 0,
    data.cost,
    data.costKnown ? 1 : 0,
    data.latencyMs,
    data.status
  );
}

export function getMetrics(filters = {}) {
  let query = 'SELECT * FROM metrics WHERE 1=1';
  const params = [];

  if (filters.clientId) {
    query += ' AND client_id = ?';
    params.push(filters.clientId);
  }
  if (filters.model) {
    query += ' AND model = ?';
    params.push(filters.model);
  }
  if (filters.providerName) {
    query += ' AND provider_name = ?';
    params.push(filters.providerName);
  }
  if (filters.from) {
    query += ' AND timestamp >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    query += ' AND timestamp <= ?';
    params.push(filters.to);
  }

  query += ' ORDER BY timestamp DESC LIMIT 1000';

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

export function getAggregatedMetrics(filters = {}) {
  let query = `
    SELECT
      model,
      provider_name,
      COUNT(*) as total_requests,
      SUM(tokens) as total_tokens,
      SUM(usage_known) as usage_known_requests,
      SUM(CASE WHEN cost_known = 1 THEN cost ELSE 0 END) as total_cost,
      SUM(cost_known) as cost_known_requests,
      AVG(latency_ms) as avg_latency,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as error_count
    FROM metrics WHERE 1=1
  `;
  const params = [];

  if (filters.clientId) {
    query += ' AND client_id = ?';
    params.push(filters.clientId);
  }
  if (filters.from) {
    query += ' AND timestamp >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    query += ' AND timestamp <= ?';
    params.push(filters.to);
  }

  query += ' GROUP BY model, provider_name';

  const stmt = db.prepare(query);
  return stmt.all(...params);
}
