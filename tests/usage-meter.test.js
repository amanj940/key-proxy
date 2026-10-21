import { describe, expect, it } from 'vitest';
import { calculateUsageCost, extractUsage, estimatePromptTokens } from '../usage-meter.js';

describe('Usage metering', () => {
  it('normalizes OpenAI chat usage fields', () => {
    expect(extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20
    });
  });

  it('normalizes Responses API usage fields', () => {
    expect(extractUsage({ usage: { input_tokens: 14, output_tokens: 6, total_tokens: 20 } })).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      totalTokens: 20
    });
  });

  it('reads usage from server-sent event chunks', () => {
    const body = [
      'data: {"choices":[]}',
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":10,"total_tokens":40}}',
      'data: [DONE]'
    ].join('\n\n');

    expect(extractUsage(body)).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
  });

  it('calculates input and output cost from per-million token prices', () => {
    expect(calculateUsageCost(
      { inputTokens: 500_000, outputTokens: 100_000, totalTokens: 600_000 },
      { cost_per_1k_input: 0.002, cost_per_1k_output: 0.006 }
    )).toBeCloseTo(1.6);
  });

  it('does not invent usage or price when the provider omits them', () => {
    expect(extractUsage({ choices: [] })).toBeNull();
    expect(calculateUsageCost({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }, {})).toBeNull();
  });

  it('estimates prompt tokens for preflight limits', () => {
    expect(estimatePromptTokens({ messages: [{ role: 'user', content: 'abcdefgh' }] })).toBe(2);
  });
});
