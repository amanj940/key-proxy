import { describe, it, expect } from 'vitest';

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
