import { describe, it, expect } from 'vitest';
import { resolveRequestedModel, validateModelAccess, normalizeModelPolicy, hasModelQuotaRemaining, selectBestModelForRequest, rankModelsForRequest, isModelAllowed } from '../routing-policy.js';

describe('Model Policy', () => {
  it('should fall back to default model when request is auto and key restricts models', () => {
    const client = {
      allowed_models: ['groq/llama-3.3-70b-versatile', 'gemini/gemini-3.5-flash-lite'],
      default_model: 'groq/llama-3.3-70b-versatile',
      routing_strategy: 'balanced',
      model_quotas: {
        'groq/llama-3.3-70b-versatile': { rpm: 10 },
        'gemini/gemini-3.5-flash-lite': { rpm: 5 }
      }
    };

    expect(resolveRequestedModel('auto', client)).toBe('groq/llama-3.3-70b-versatile');
  });

  it('should reject model not allowed for the key', () => {
    const client = {
      allowed_models: ['groq/llama-3.3-70b-versatile'],
      default_model: 'groq/llama-3.3-70b-versatile',
      routing_strategy: 'balanced'
    };

    const result = validateModelAccess(client, 'gemini/gemini-3.8-flash');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('model_not_allowed');
  });

  it('should require model and provider allowlists to both permit a model', () => {
    const client = {
      allowed_models: ['groq/llama'],
      allowed_providers: ['groq']
    };

    expect(isModelAllowed(client, 'groq/llama')).toBe(true);
    expect(isModelAllowed(client, 'groq/other')).toBe(false);
    expect(isModelAllowed(client, 'gemini/flash')).toBe(false);
  });

  it('should reject when a model quota is exhausted', () => {
    const client = {
      model_quotas: {
        'gemini/gemini-3.5-flash-lite': { rpm: 2, tpm: 100, rpd: 3 }
      }
    };

    const result = hasModelQuotaRemaining(client, 'gemini/gemini-3.5-flash-lite', {
      rpm: 2,
      tpm: 100,
      rpd: 3
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('model_rpm_exceeded');
  });

  it('should allow remaining quota within limits', () => {
    const client = {
      model_quotas: {
        'gemini/gemini-3.5-flash-lite': { rpm: 5, tpm: 500, rpd: 10 }
      }
    };

    const result = hasModelQuotaRemaining(client, 'gemini/gemini-3.5-flash-lite', {
      rpm: 2,
      tpm: 150,
      rpd: 4
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining.rpm).toBe(3);
    expect(result.remaining.tpm).toBe(350);
    expect(result.remaining.rpd).toBe(6);
  });

  it('should pick a non-exhausted allowed model for auto routing', () => {
    const client = {
      allowed_models: ['groq/llama-3.3-70b-versatile', 'gemini/gemini-3.5-flash-lite'],
      default_model: 'groq/llama-3.3-70b-versatile',
      routing_strategy: 'balanced',
      model_quotas: {
        'groq/llama-3.3-70b-versatile': { rpm: 1, tpm: 1000, rpd: 1 },
        'gemini/gemini-3.5-flash-lite': { rpm: 10, tpm: 5000, rpd: 10 }
      }
    };

    const result = selectBestModelForRequest(client, client.allowed_models, {
      usage: {
        'groq/llama-3.3-70b-versatile': { rpm: 1, tpm: 1000, rpd: 1 },
        'gemini/gemini-3.5-flash-lite': { rpm: 2, tpm: 300, rpd: 2 }
      },
      metrics: {
        'groq/llama-3.3-70b-versatile': { score: 0.85, avg_latency_ms: 800, cost_per_1k_input: 0.2, success_rate: 0.98 },
        'gemini/gemini-3.5-flash-lite': { score: 0.78, avg_latency_ms: 300, cost_per_1k_input: 0.05, success_rate: 0.96 }
      }
    });

    expect(result).toBe('gemini/gemini-3.5-flash-lite');
  });

  it('should produce a fallback chain that excludes exhausted and disallowed models', () => {
    const client = {
      allowed_models: ['gemini/flash', 'groq/llama', 'openrouter/other'],
      allowed_providers: ['gemini', 'groq'],
      routing_strategy: 'best_quality',
      model_quotas: { 'gemini/flash': { rpm: 1 } }
    };

    const ranked = rankModelsForRequest(client, client.allowed_models, {
      usage: { 'gemini/flash': { rpm: 1 } },
      metrics: {
        'gemini/flash': { success_rate: 0.99, score: 0.99 },
        'groq/llama': { success_rate: 0.8, score: 0.8 },
        'openrouter/other': { success_rate: 1, score: 1 }
      }
    });

    expect(ranked).toEqual(['groq/llama']);
  });

  it('should return no candidates when all allowed model quotas are exhausted', () => {
    const client = {
      allowed_models: ['gemini/flash'],
      default_model: 'gemini/flash',
      model_quotas: { 'gemini/flash': { rpm: 1 } }
    };

    expect(rankModelsForRequest(client, ['gemini/flash'], {
      usage: { 'gemini/flash': { rpm: 1 } }
    })).toEqual([]);
    expect(resolveRequestedModel('auto', client, {
      usage: { 'gemini/flash': { rpm: 1 } }
    })).toBe('auto');
  });

  it('should choose the cheapest model for background priority', () => {
    const client = {
      allowed_models: ['groq/llama', 'deepseek/coder'],
      routing_strategy: 'best_quality'
    };

    const result = selectBestModelForRequest(client, client.allowed_models, {
      priority: 'background',
      taskType: 'code',
      metrics: {
        'groq/llama': { score: 0.4, success_rate: 0.4, cost_per_1k_input: 0.001, cost_per_1k_output: 0.02 },
        'deepseek/coder': { score: 0.99, success_rate: 0.99, cost_per_1k_input: 0.01, cost_per_1k_output: 0.001 }
      }
    });

    expect(result).toBe('deepseek/coder');
  });

  it('should prefer reasoning models for coding tasks', () => {
    const client = {
      allowed_models: ['groq/llama-3.3-70b-versatile', 'deepseek/deepseek-r1-distill-llama-70b'],
      default_model: 'groq/llama-3.3-70b-versatile',
      routing_strategy: 'balanced',
      model_quotas: {
        'groq/llama-3.3-70b-versatile': { rpm: 10, tpm: 2000, rpd: 20 },
        'deepseek/deepseek-r1-distill-llama-70b': { rpm: 10, tpm: 2000, rpd: 20 }
      }
    };

    const result = selectBestModelForRequest(client, client.allowed_models, {
      taskType: 'code',
      usage: {
        'groq/llama-3.3-70b-versatile': { rpm: 1, tpm: 200, rpd: 2 },
        'deepseek/deepseek-r1-distill-llama-70b': { rpm: 3, tpm: 250, rpd: 4 }
      },
      metrics: {
        'groq/llama-3.3-70b-versatile': { score: 0.8, avg_latency_ms: 600, cost_per_1k_input: 0.08, success_rate: 0.96 },
        'deepseek/deepseek-r1-distill-llama-70b': { score: 0.88, avg_latency_ms: 900, cost_per_1k_input: 0.1, success_rate: 0.97 }
      }
    });

    expect(result).toBe('deepseek/deepseek-r1-distill-llama-70b');
  });

  it('should accept nested routing_policy config object', () => {
    const policy = normalizeModelPolicy({
      routing_policy: {
        allowed_models: ['groq/llama-3.3-70b-versatile', 'gemini/gemini-3.5-flash-lite'],
        default_model: 'gemini/gemini-3.5-flash-lite',
        routing_strategy: 'fastest',
        model_quotas: {
          'gemini/gemini-3.5-flash-lite': { rpm: 5, tpm: 400, rpd: 8 }
        }
      }
    });

    expect(policy.allowed_models).toEqual(['groq/llama-3.3-70b-versatile', 'gemini/gemini-3.5-flash-lite']);
    expect(policy.default_model).toBe('gemini/gemini-3.5-flash-lite');
    expect(policy.routing_strategy).toBe('fastest');
    expect(policy.model_quotas['gemini/gemini-3.5-flash-lite'].rpm).toBe(5);
  });

  it('should normalize model policy values', () => {
    const policy = normalizeModelPolicy({
      allowed_models: 'groq/llama-3.3-70b-versatile,gemini/gemini-3.5-flash-lite',
      default_model: ' gemini/gemini-3.5-flash-lite ',
      routing_strategy: ' FASTEST '
    });

    expect(policy.allowed_models).toEqual([
      'groq/llama-3.3-70b-versatile',
      'gemini/gemini-3.5-flash-lite'
    ]);
    expect(policy.default_model).toBe('gemini/gemini-3.5-flash-lite');
    expect(policy.routing_strategy).toBe('fastest');
  });

  it('should parse JSON-serialized allowlists returned by SQLite', () => {
    const policy = normalizeModelPolicy({
      allowedModels: JSON.stringify(['groq/llama', 'gemini/flash']),
      allowedProviders: JSON.stringify(['groq', 'gemini'])
    });

    expect(policy.allowed_models).toEqual(['groq/llama', 'gemini/flash']);
    expect(policy.allowed_providers).toEqual(['groq', 'gemini']);
    expect(isModelAllowed({
      allowedModels: JSON.stringify(['groq/llama']),
      allowedProviders: JSON.stringify(['groq'])
    }, 'groq/llama')).toBe(true);
  });
});

describe('Rate Limiting', () => {
  it('should check RPM limit correctly', () => {
    const client = { id: 'test-client', rpmLimit: 10, tpmLimit: 0 };
    const rateLimit = new Map();

    // Simulate rate limit check function
    function checkRateLimit(client, estimatedTokens = 0) {
      const now = Date.now();
      const minute = Math.floor(now / 60000);

      if (!rateLimit.has(client.id)) {
        rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 } });
      }

      const limits = rateLimit.get(client.id);

      if (client.rpmLimit > 0) {
        if (limits.rpm.timestamp !== minute) {
          limits.rpm = { timestamp: minute, count: 0 };
        }
        if (limits.rpm.count >= client.rpmLimit) {
          return { allowed: false, reason: 'rpm_limit' };
        }
      }

      return { allowed: true };
    }

    function incrementRateLimit(client) {
      const now = Date.now();
      const minute = Math.floor(now / 60000);

      if (!rateLimit.has(client.id)) {
        rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 } });
      }

      const limits = rateLimit.get(client.id);

      if (limits.rpm.timestamp !== minute) {
        limits.rpm = { timestamp: minute, count: 0 };
      }
      limits.rpm.count++;
    }

    // First 10 requests should be allowed
    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit(client);
      expect(result.allowed).toBe(true);
      incrementRateLimit(client);
    }

    // 11th request should be blocked
    const result = checkRateLimit(client);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('rpm_limit');
  });

  it('should check TPM limit correctly', () => {
    const client = { id: 'test-client', rpmLimit: 0, tpmLimit: 1000 };
    const rateLimit = new Map();

    function checkRateLimit(client, estimatedTokens = 0) {
      const now = Date.now();
      const minute = Math.floor(now / 60000);

      if (!rateLimit.has(client.id)) {
        rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 } });
      }

      const limits = rateLimit.get(client.id);

      if (client.tpmLimit > 0) {
        if (limits.tpm.timestamp !== minute) {
          limits.tpm = { timestamp: minute, count: 0 };
        }
        if (limits.tpm.count + estimatedTokens > client.tpmLimit) {
          return { allowed: false, reason: 'tpm_limit' };
        }
      }

      return { allowed: true };
    }

    function incrementRateLimit(client, actualTokens = 0) {
      const now = Date.now();
      const minute = Math.floor(now / 60000);

      if (!rateLimit.has(client.id)) {
        rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 } });
      }

      const limits = rateLimit.get(client.id);

      if (limits.tpm.timestamp !== minute) {
        limits.tpm = { timestamp: minute, count: 0 };
      }
      limits.tpm.count += actualTokens;
    }

    // Request with 500 tokens should be allowed
    const result1 = checkRateLimit(client, 500);
    expect(result1.allowed).toBe(true);
    incrementRateLimit(client, 500);

    // Request with 600 tokens should be blocked (500 + 600 > 1000)
    const result2 = checkRateLimit(client, 600);
    expect(result2.allowed).toBe(false);
    expect(result2.reason).toBe('tpm_limit');
  });

  it('should allow unlimited when limits are 0', () => {
    const client = { id: 'test-client', rpmLimit: 0, tpmLimit: 0 };
    const rateLimit = new Map();

    function checkRateLimit(client, estimatedTokens = 0) {
      const now = Date.now();
      const minute = Math.floor(now / 60000);

      if (!rateLimit.has(client.id)) {
        rateLimit.set(client.id, { rpm: { timestamp: minute, count: 0 }, tpm: { timestamp: minute, count: 0 } });
      }

      const limits = rateLimit.get(client.id);

      if (client.rpmLimit > 0) {
        if (limits.rpm.timestamp !== minute) {
          limits.rpm = { timestamp: minute, count: 0 };
        }
        if (limits.rpm.count >= client.rpmLimit) {
          return { allowed: false, reason: 'rpm_limit' };
        }
      }

      if (client.tpmLimit > 0) {
        if (limits.tpm.timestamp !== minute) {
          limits.tpm = { timestamp: minute, count: 0 };
        }
        if (limits.tpm.count + estimatedTokens > client.tpmLimit) {
          return { allowed: false, reason: 'tpm_limit' };
        }
      }

      return { allowed: true };
    }

    // Many requests should be allowed
    for (let i = 0; i < 1000; i++) {
      const result = checkRateLimit(client, 1000);
      expect(result.allowed).toBe(true);
    }
  });
});
