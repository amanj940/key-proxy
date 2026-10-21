function tokenCount(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens, NaN);
  const outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens, NaN);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;

  const normalizedInput = Number.isFinite(inputTokens) ? inputTokens : 0;
  const normalizedOutput = Number.isFinite(outputTokens) ? outputTokens : 0;
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: tokenCount(usage.total_tokens, normalizedInput + normalizedOutput)
  };
}

export function extractUsage(responseBody) {
  if (typeof responseBody === 'string') {
    const text = responseBody.trim();
    if (!text) return null;

    try {
      const usage = normalizeUsage(JSON.parse(text)?.usage);
      if (usage) return usage;
    } catch {}

    let lastUsage = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        lastUsage = normalizeUsage(JSON.parse(payload)?.usage) || lastUsage;
      } catch {}
    }
    return lastUsage;
  }

  return normalizeUsage(responseBody?.usage);
}

export function calculateUsageCost(usage, pricing = {}) {
  if (!usage) return null;
  const inputRate = Number(pricing.cost_per_1k_input);
  const outputRate = Number(pricing.cost_per_1k_output);
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate < 0 || outputRate < 0) return null;
  if (inputRate === 0 && outputRate === 0) return null;

  return (usage.inputTokens / 1000) * inputRate + (usage.outputTokens / 1000) * outputRate;
}

export function estimatePromptTokens(requestBody = {}) {
  const text = [];
  const collect = (value, key = '') => {
    if (typeof value === 'string') {
      if (!['role', 'type'].includes(key)) text.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) collect(childValue, childKey);
    }
  };

  collect(requestBody.messages);
  collect(requestBody.input);
  collect(requestBody.prompt);
  collect(requestBody.instructions);
  collect(requestBody.tools);
  const characters = text.join('').length;
  return characters ? Math.ceil(characters / 4) : 0;
}