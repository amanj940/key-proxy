function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeList(value, transform = (item) => String(item).trim()) {
  if (Array.isArray(value)) return value.map(transform).filter(Boolean);
  if (typeof value !== 'string') return [];

  const parsed = safeJsonParse(value, null);
  if (Array.isArray(parsed)) return parsed.map(transform).filter(Boolean);
  return value.split(',').map(transform).filter(Boolean);
}

export function normalizeModelPolicy(policy = {}) {
  const rootPolicy = typeof policy === 'string' ? safeJsonParse(policy, {}) : policy || {};
  const nestedPolicy = rootPolicy.routing_policy ?? rootPolicy.routingPolicy ?? rootPolicy.policy ?? rootPolicy.model_policy ?? rootPolicy.modelPolicy ?? {};
  const effectivePolicy = typeof nestedPolicy === 'string' ? safeJsonParse(nestedPolicy, {}) : nestedPolicy || {};

  const allowedModelsValue = rootPolicy.allowed_models ?? rootPolicy.allowedModels ?? effectivePolicy.allowed_models ?? effectivePolicy.allowedModels ?? [];
  const allowedModels = normalizeList(allowedModelsValue);

  const defaultModelValue = rootPolicy.default_model ?? rootPolicy.defaultModel ?? effectivePolicy.default_model ?? effectivePolicy.defaultModel ?? '';
  const defaultModel = typeof defaultModelValue === 'string' ? defaultModelValue.trim() : '';

  const routingStrategyValue = rootPolicy.routing_strategy ?? rootPolicy.routingStrategy ?? effectivePolicy.routing_strategy ?? effectivePolicy.routingStrategy ?? 'balanced';
  const routingStrategy = typeof routingStrategyValue === 'string'
    ? routingStrategyValue.trim().toLowerCase()
    : 'balanced';

  const allowedProvidersValue = rootPolicy.allowed_providers ?? rootPolicy.allowedProviders ?? effectivePolicy.allowed_providers ?? effectivePolicy.allowedProviders ?? [];
  const allowedProviders = normalizeList(allowedProvidersValue, (provider) => String(provider).trim().toLowerCase());

  const modelQuotasValue = rootPolicy.model_quotas ?? rootPolicy.modelQuotas ?? effectivePolicy.model_quotas ?? effectivePolicy.modelQuotas ?? {};

  return {
    allowed_models: allowedModels,
    default_model: defaultModel,
    allowed_providers: allowedProviders,
    routing_strategy: routingStrategy,
    model_quotas: safeJsonParse(modelQuotasValue, {})
  };
}

function normalizeTaskType(taskType) {
  const type = String(taskType || '').trim().toLowerCase().replace(/[_\-\s]+/g, '_');
  const aliases = {
    general: 'chat',
    chat: 'chat',
    text: 'chat',
    code: 'code',
    coding: 'code',
    programming: 'code',
    reasoning: 'reasoning',
    analysis: 'reasoning',
    thought: 'reasoning',
    embed: 'embedding',
    embedding: 'embedding',
    image: 'image',
    vision: 'vision',
    audio: 'audio',
    speech: 'audio',
    tools: 'tool'
  };

  return aliases[type] || type || 'chat';
}

function getTaskPriorityWeight(priority) {
  const value = String(priority || '').trim().toLowerCase();
  if (['critical', 'urgent'].includes(value)) return 1.2;
  if (['high'].includes(value)) return 0.8;
  if (['medium', 'normal', 'default'].includes(value)) return 0.4;
  if (['low'].includes(value)) return 0.1;
  if (value === 'background') return 0;
  return 0.4;
}

function getTaskModelBoost(modelName, taskType) {
  const normalized = String(modelName || '').toLowerCase();
  const type = normalizeTaskType(taskType);

  const boosts = {
    chat: /(llama|gemini|mistral|qwen|claude|gpt|deepseek|groq)/i,
    code: /(deepseek|qwen|codestral|claude|gpt-oss|gemma|code|coder)/i,
    reasoning: /(deepseek|qwen|o1|o3|gemini|claude|gpt-oss|reasoner|r1)/i,
    vision: /(vision|pixtral|gemini|gpt-4o|claude|llava|qwen.*vision)/i,
    image: /(image|flux|sdxl|dall|recraft|imagen|veo|video)/i,
    embedding: /(embed|bge|e5|gte|nomic)/i,
    audio: /(whisper|tts|speech|audio|sonnet)/i,
    tool: /(tool|function|assistant)/i
  };

  const taskPattern = boosts[type] || boosts.chat;
  if (!taskPattern) return 0;
  return taskPattern.test(normalized) ? 1 : 0;
}

export function isModelAllowed(client = {}, modelName) {
  const normalized = normalizeModelPolicy(client);
  const model = typeof modelName === 'string' ? modelName.trim() : '';
  if (!model) return false;
  if (normalized.allowed_models.length > 0 && !normalized.allowed_models.includes(model)) return false;

  const provider = model.split('/')[0]?.toLowerCase();
  return !normalized.allowed_providers.length || normalized.allowed_providers.includes(provider);
}

export function rankModelsForRequest(client = {}, candidateModels = [], options = {}) {
  const normalized = normalizeModelPolicy(client);
  const priorityLevel = String(options.priority || options.routing_priority || 'medium').trim().toLowerCase();
  const strategy = priorityLevel === 'background'
    ? 'cheapest'
    : options.strategy || normalized.routing_strategy || 'balanced';
  const metrics = options.metrics || {};
  const usage = options.usage || {};
  const taskType = normalizeTaskType(options.taskType || options.task_type || 'chat');
  const priorityWeight = getTaskPriorityWeight(priorityLevel);

  const modelList = Array.isArray(candidateModels) && candidateModels.length > 0
    ? candidateModels
    : normalized.allowed_models.length > 0
      ? normalized.allowed_models
      : normalized.default_model
        ? [normalized.default_model]
        : [];

  const candidates = modelList
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .filter((model) => isModelAllowed(client, model));

  if (!candidates.length) {
    return [];
  }

  const ranked = candidates
    .map((model) => {
      const metric = metrics[model] || {};
      const quotaStatus = hasModelQuotaRemaining(client, model, usage);
      const successRate = Number(metric.success_rate || metric.score || 0.5);
      const latency = Number(metric.avg_latency_ms || 999999);
      const inputCost = Number(metric.cost_per_1k_input || 0);
      const outputCost = Number(metric.cost_per_1k_output || 0);
      const cost = inputCost + outputCost;
      const qualityScore = Number(metric.score || successRate || 0.5);
      const taskBoost = getTaskModelBoost(model, taskType) * (1 + priorityWeight);
      let priority = qualityScore;

      if (strategy === 'cheapest') priority = -cost;
      if (strategy === 'fastest') priority = -latency;
      if (strategy === 'best_quality') priority = successRate * 10 + qualityScore;
      if (strategy === 'balanced') {
        priority = qualityScore + (1 - Math.min(latency / 2000, 1)) * 0.4 - Math.min(cost / 0.01, 1) * 0.2;
      }

      if (priorityLevel !== 'background') priority += taskBoost * 1.5;

      if (priorityLevel !== 'background' && normalized.default_model === model) {
        priority += 0.15;
      }

      return {
        model,
        priority,
        originalIndex: candidates.indexOf(model),
        allowed: quotaStatus.allowed,
      };
    })
    .filter((item) => item.allowed);

  if (strategy === 'fallback') ranked.sort((a, b) => a.originalIndex - b.originalIndex);
  else ranked.sort((a, b) => b.priority - a.priority || a.originalIndex - b.originalIndex);
  return ranked.map((item) => item.model);
}

export function selectBestModelForRequest(client = {}, candidateModels = [], options = {}) {
  return rankModelsForRequest(client, candidateModels, options)[0] || null;
}

export function resolveRequestedModel(requestedModel, client = {}, options = {}) {
  const normalized = normalizeModelPolicy(client);
  const raw = typeof requestedModel === 'string' ? requestedModel.trim() : '';

  if (!raw || raw === 'auto') {
    const candidates = normalized.allowed_models.length > 0
      ? normalized.allowed_models
      : normalized.default_model
        ? [normalized.default_model]
        : [];

    return selectBestModelForRequest(client, candidates, options) || 'auto';
  }

  return raw;
}

export function validateModelAccess(client = {}, modelName) {
  const normalized = normalizeModelPolicy(client);
  const rawModel = typeof modelName === 'string' ? modelName.trim() : '';

  if (!rawModel || rawModel === 'auto') {
    const effective = resolveRequestedModel(rawModel, client);
    return {
      allowed: true,
      model: effective,
      reason: null,
      effectiveModel: effective
    };
  }

  if (normalized.allowed_models.length > 0 && !normalized.allowed_models.includes(rawModel)) {
    return {
      allowed: false,
      model: rawModel,
      reason: 'model_not_allowed',
      effectiveModel: normalized.default_model || 'auto'
    };
  }

  const provider = rawModel.split('/')[0];
  if (normalized.allowed_providers.length > 0 && !normalized.allowed_providers.includes(provider.toLowerCase())) {
    return {
      allowed: false,
      model: rawModel,
      reason: 'provider_not_allowed',
      effectiveModel: normalized.default_model || 'auto'
    };
  }

  return {
    allowed: true,
    model: rawModel,
    reason: null,
    effectiveModel: rawModel
  };
}

export function hasModelQuotaRemaining(client = {}, modelName, usage = {}) {
  const normalized = normalizeModelPolicy(client);
  const rawModel = typeof modelName === 'string' ? modelName.trim() : '';
  const quotas = normalized.model_quotas || {};

  if (!rawModel || rawModel === 'auto') {
    return { allowed: true, remaining: null, reason: null };
  }

  const normalizedModelKey = rawModel.replace(/^\w+\//, '');
  const quota = quotas[rawModel] || quotas[normalizedModelKey] || quotas[modelName] || null;
  if (!quota) {
    return { allowed: true, remaining: null, reason: null };
  }

  const usageByModel = usage?.[rawModel] ?? usage?.[normalizedModelKey] ?? usage?.[modelName] ?? {};
  const directUsage = typeof usage === 'object' && usage !== null && !Array.isArray(usage)
    && ('rpm' in usage || 'tpm' in usage || 'rpd' in usage)
    ? usage
    : (typeof usageByModel === 'object' && usageByModel !== null ? usageByModel : {});

  const rpmUsed = Number(directUsage.rpm || 0);
  const tpmUsed = Number(directUsage.tpm || 0);
  const rpdUsed = Number(directUsage.rpd || 0);

  const rpmLimit = Number(quota.rpm || 0);
  const tpmLimit = Number(quota.tpm || 0);
  const rpdLimit = Number(quota.rpd || 0);

  if (rpmLimit > 0 && rpmUsed >= rpmLimit) {
    return { allowed: false, remaining: { rpm: 0 }, reason: 'model_rpm_exceeded' };
  }

  if (tpmLimit > 0 && tpmUsed >= tpmLimit) {
    return { allowed: false, remaining: { tpm: 0 }, reason: 'model_tpm_exceeded' };
  }

  if (rpdLimit > 0 && rpdUsed >= rpdLimit) {
    return { allowed: false, remaining: { rpd: 0 }, reason: 'model_rpd_exceeded' };
  }

  return {
    allowed: true,
    remaining: {
      rpm: rpmLimit > 0 ? Math.max(0, rpmLimit - rpmUsed) : null,
      tpm: tpmLimit > 0 ? Math.max(0, tpmLimit - tpmUsed) : null,
      rpd: rpdLimit > 0 ? Math.max(0, rpdLimit - rpdUsed) : null
    },
    reason: null
  };
}
