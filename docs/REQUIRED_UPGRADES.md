# التطويرات اللازمة والضرورية لتطوير Key Proxy

## 1. الهدف

هذا الملف يوضح ما الذي يحتاج إلى تطوير أو تحسين لإدخال مفهوم “اختيار النموذج حسب الحصة والسياسة” إلى المشروع، بحيث يصبح التطبيق المرتبط قادرًا على:

- اكتشاف النماذج المتاحة
- رؤية الحصص المتبقية لكل نموذج
- اختيار نموذج محدد أو auto حسب المهمة
- استخدام key-proxy كـ gateway ذكي لا مجرد proxy بسيط

---

## 2. ما الذي موجود فعليًا

المشروع الحالي لديه بالفعل:

- إدارة أكثر من مزود
- إدارة مفاتيح مزود المشفرة
- routing ذكي وتحليل للنماذج
- limits على client
- client budget
- model metrics
- admin panel
- OpenAI-compatible proxy

لكن ما يفتقده هو بشكل أساسي:

1. model quotas per app/project
2. allowed_models per key
3. policy-aware automatic selection
4. richer model discovery metadata
5. quota enforcement at request time
6. weighted routing by task priority

---

## 3. التعديلات الأساسية اللازمة

### 3.1 إضافة allowed_models لكل client/project
كل مفتاح أو client يجب أن يحمل:

- allowed_models: list
- default_model: string
- allowed_providers: list
- routing_strategy: enum

المثال:

```json
{
  "allowed_models": [
    "groq/llama-3.3-70b-versatile",
    "gemini/gemini-3.5-flash-lite",
    "gemini/gemini-3.8-flash"
  ],
  "default_model": "groq/llama-3.3-70b-versatile",
  "allowed_providers": ["groq", "gemini"],
  "routing_strategy": "balanced"
}
```

### لماذا مهم؟
لأن التطبيق لا يجب أن يرسل أي نموذج، بل يجب أن يرسل فقط ما يسمح به المفتاح.

### التعديل المطلوب في الكود
- إضافة حقول إلى جدول `clients`
- قراءة هذه الحقول في middleware
- التحقق من النموذج قبل التنفيذ

---

### 3.2 إضافة model_quotas لكل client/project
كل نموذج يحتاج quota خاص:

```json
{
  "model_quotas": {
    "gemini/gemini-3.8-flash": { "rpm": 5, "tpm": 250000, "rpd": 20 },
    "groq/llama-3.3-70b-versatile": { "rpm": 100, "tpm": 500000, "rpd": 500 },
    "gemini/gemini-3.5-flash-lite": { "rpm": 30, "tpm": 300000, "rpd": 500 }
  }
}
```

### لماذا مهم؟
لأن بعض النماذج قوية جدًا لكنها لديها quota صغير جدًا. هذا يفرض أن يختار التطبيق النموذج الصحيح وفق المهمة، وليس من خلال auto raw فقط.

### التعديل المطلوب
- توسيع `clients.model_quotas`
- validation عند كل request
- حساب remaining quota قبل routing

---

### 3.3 تحسين /v1/models
الـ endpoint الحالي موجود، لكنه يجب أن يكون أكثر فائدة:

يجب أن يعرّف كل نموذج بمعلمات مثل:

- id
- provider
- cost_per_1k
- context_length
- supports_vision
- supports_tools
- rpm_limit
- rpm_used
- rpm_remaining
- tpm_limit
- tpm_used
- tpm_remaining
- tier
- recommended_for

الفكرة:

```json
{
  "id": "gemini/gemini-3.8-flash",
  "provider": "gemini",
  "rpm_limit": 5,
  "rpm_used": 2,
  "rpm_remaining": 3,
  "tpm_limit": 250000,
  "tpm_used": 7000,
  "tpm_remaining": 243000,
  "tier": "high_quality",
  "recommended_for": "critical_task"
}
```

### لماذا مهم؟
لأن التطبيق يحتاج أن يرى النماذج المتاحة مع الحصص بدلًا من مجرد قائمة أسماء.

---

### 3.4 دعم priority/task-based routing
أضف حقولًا في الطلب مثل:

```json
{
  "model": "auto",
  "priority": "high",
  "routing_policy": "balanced"
}
```

أو:

```json
{
  "model": "auto",
  "task_type": "research",
  "routing_policy": "quality_first"
}
```

### لماذا مهم؟
لأن بعض الطلبات تحتاج قوة أعلى، وبعضها يحتاج أقل تكلفة أو أوسع quota.

### التعديل المطلوب
- إضافة parsing للـ priority/task_type
- تحسين `selectModelForRequest()`
- جعل الاختيار يحترم quota + allowed models + cost

---

### 3.5 دعم `auto` مع awareness على الحصة
الـ auto الحالي يقوم غالبًا على latency/cost/quality العام. هذا لا يكفي.

الـ auto الجديد يجب أن يعمل على هذا النمط:

1. فلترة النماذج حسب allowed_models
2. فلترة النماذج حسب remaining quota
3. ترتيب النماذج بحسب priority و policy
4. استخدام أفضل نموذج متاح

### مثال منطق:

```javascript
const allowed = models.filter(m => client.allowed_models.includes(m.id));
const quotaOk = allowed.filter(m => hasRemainingQuota(client, m.id));
const selected = chooseBestByPolicy(quotaOk, client.routing_strategy);
```

---

## 4. التعديلات الفنية المطلوبة في المشروع

### 4.1 تعديل `clients` schema
أضف هذه الحقول إن لم تكن موجودة:

- allowed_models TEXT
- default_model TEXT
- allowed_providers TEXT
- routing_strategy TEXT
- model_quotas TEXT

### 4.2 تحديث `checkQuotas()`
المنطق الحالي يتعامل مع budget و limits بشكل عام، لكنه لا يميز نموذجًا عن آخر بشكل كامل. يجب تحسينه ليعمل على:

- per model rpm count
- per model tpm count
- per model remaining quota
- per model deny/allow based on client policy

### 4.3 تحديث `selectModelForRequest()`
المنطق الحالي يستند إلى score عام. يجب أن يضيف:

- quota remaining
- priority
- allowed model list
- provider health
- policy mapping

### 4.4 تحديث middleware auth
قبل التوجيه، يجب التحقق من:

- requested model exists in client.allowed_models
- requested provider allowed
- model quota not exceeded
- default model fallback

---

## 5. واجهة الإدارة المطلوبة

### 5.1 إدارة permissions لكل project
في واجهة admin يجب إضافة:

- قائمة النماذج المسموح بها
- default model
- allowed providers
- routing strategy
- quota لكل نموذج

### 5.2 إعدادات per app
اختيار من الخيارات:

- auto
- balanced
- cheapest
- fastest
- quality_first

### 5.3 عرض quota remaining
عرض عدد الطلبات المتبقية لكل نموذج في الوقت الفعلي

---

## 6. أولويات التطوير

### الأولوية 1: الأساسية
- allowed_models
- default_model
- model_quotas
- validate model on request
- enrich /v1/models

### الأولوية 2: التوجيه الذكي
- priority-aware routing
- quota-aware auto selector
- fallback-between-models

### الأولوية 3: الإدارة
- admin UI للـ model permissions
- dashboards للـ remaining quota
- per model usage charts

### الأولوية 4: الإنتاج
- audit logs
- alerts
- webhook eventing
- multi-tenant permissions

---

## 7. ما الذي سيجعل المشروع جاهزًا حقًا؟

المشروع يصبح جاهزًا عندما تكون هذه القيم موجودة فعليًا:

- كل مفتاح يحمل سياسة
- كل مفتاح يعرف النماذج المسموح بها
- كل نموذج لديه خطر/حصة/ميزانية
- التطبيق يختار النموذج بحسب المهمة
- key-proxy يكون gateway policy-aware وليس مجرد proxy

---

## 8. الخلاصة

المشروع الحالي جيد جدًا في أساسياته، لكنه يحتاج إلى انطلاق حقيقي نحو “quota-aware intelligent routing”.

التعديلات الضرورية هي:

1. allowed models per key
2. model quotas per key
3. default model policy
4. routing policy
5. richer /v1/models
6. validation before request execution
7. quota-aware auto selection

هذه هي التعديلات التي ستجعله قادرًا على أن ينفذ ما تريد بالضبط: "التطبيق يختار النموذج أو يتركه لـ key-proxy حسب الحصة والسياسة".

