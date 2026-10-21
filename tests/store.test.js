import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { enc, dec, sha, addClient, db_sqlite, getAggregatedMetrics, logMetric } from '../store.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

describe('Store Security Functions', () => {
  const originalKey = process.env.MASTER_KEY;

  beforeEach(() => {
    process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  });

  afterEach(() => {
    process.env.MASTER_KEY = originalKey;
  });

  describe('Encryption/Decryption', () => {
    it('should encrypt and decrypt correctly', () => {
      const key = 'sk-test123456789012345678901234567890';
      const encrypted = enc(key);
      const decrypted = dec(encrypted);
      expect(decrypted).toBe(key);
    });

    it('should produce different encrypted values for same input', () => {
      const key = 'sk-test123456789012345678901234567890';
      const encrypted1 = enc(key);
      const encrypted2 = enc(key);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle special characters', () => {
      const key = 'sk-test!@#$%^&*()_+-=[]{}|;:,.<>?';
      const encrypted = enc(key);
      const decrypted = dec(encrypted);
      expect(decrypted).toBe(key);
    });

    it('should handle empty string', () => {
      const key = '';
      const encrypted = enc(key);
      const decrypted = dec(encrypted);
      expect(decrypted).toBe(key);
    });

    it('should handle long strings', () => {
      const key = 'sk-' + 'a'.repeat(1000);
      const encrypted = enc(key);
      const decrypted = dec(encrypted);
      expect(decrypted).toBe(key);
    });
  });

  describe('SHA256 Hashing', () => {
    it('should produce consistent hash for same input', () => {
      const key = 'sk-test123456789012345678901234567890';
      const hash1 = sha(key);
      const hash2 = sha(key);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = sha('key1');
      const hash2 = sha('key2');
      expect(hash1).not.toBe(hash2);
    });

    it('should be case-sensitive', () => {
      const hash1 = sha('Key');
      const hash2 = sha('key');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce fixed-length hash', () => {
      const hash = sha('any string');
      expect(hash).toHaveLength(64);
    });
  });
});

describe('Persistent usage metrics', () => {
  let clientId;

  beforeEach(() => {
    const key = crypto.randomUUID();
    clientId = addClient('usage-test', key, sha(key), key.slice(0, 10)).id;
  });

  afterEach(() => {
    db_sqlite.prepare('DELETE FROM metrics WHERE client_id = ?').run(clientId);
    db_sqlite.prepare('DELETE FROM spend_logs WHERE client_id = ?').run(clientId);
    db_sqlite.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
  });

  it('aggregates durable token usage while excluding unpriced requests from cost totals', () => {
    const now = Date.now();
    logMetric({
      clientId,
      model: 'provider/model-a',
      providerName: 'provider',
      tokens: 40,
      usageKnown: true,
      cost: 0.25,
      costKnown: true,
      latencyMs: 120,
      status: 'success'
    });
    logMetric({
      clientId,
      model: 'provider/model-a',
      providerName: 'provider',
      tokens: 12,
      usageKnown: false,
      cost: 0,
      costKnown: false,
      latencyMs: 150,
      status: 'success'
    });

    const [metrics] = getAggregatedMetrics({ clientId, from: now - 1000 });
    expect(metrics.total_requests).toBe(2);
    expect(metrics.total_tokens).toBe(52);
    expect(metrics.usage_known_requests).toBe(1);
    expect(metrics.total_cost).toBeCloseTo(0.25);
    expect(metrics.cost_known_requests).toBe(1);
  });
});
