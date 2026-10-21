# توثيق مشروع Key Proxy

> للحصول على سجل تفصيلي للتغييرات المنفذة في السياسات والتوجيه والقياس والواجهة واللغة والنشر، راجع [سجل التطويرات المنفذة](IMPLEMENTED_UPDATES.md).

## 1. نظرة عامة

Key Proxy هو gateway مركزي لإدارة مفاتيح مزودي الذكاء الاصطناعي (LLM providers) عبر واجهة OpenAI-compatible. يهدف المشروع إلى:

- جمع مفاتيح متعددة من مزودين مختلفين في مكان واحد
- توزيع الطلبات تلقائيًا بين المزودين
- إدارة المفاتيح وقيود الاستخدام
- تنظيم أذونات المشاريع والعملاء
- تسجيل الأداء والميزانية ومقاييس الاستخدام
- توفير واجهة إدارية لتتبع الحالة والتشغيل

يمثل هذا المشروع حلًا وسيطًا بين:
- استخدام مفاتيح كل مزود بشكل مباشر داخل كل تطبيق
- بناء نظام مركزي لإدارة مفاتيح AI وقيودها

---

## 2. ما الذي يفعله المشروع فعليًا

### 2.1 إدارة المزودين
يستطيع المشروع:

- إضافة مزود جديد مثل Groq أو OpenRouter أو Gemini أو Mistral
- حفظ Base URL لكل مزود
- حفظ model default لكل مزود
- فحص النماذج المتاحة
- اختبار المفاتيح والتحقق من صحتها
- تمكين أو تعطيل النموذج أو المفتاح
- إعادة فحص المزود للبحث عن النماذج وتحديثها

### 2.2 إدارة المفاتيح
للمزود نفسه يمكن:

- إضافة مفاتيح متعددة
- تخزينها مشفرة باستخدام AES-256-GCM
- تعيين حالة المفتاح: valid/invalid/nocredit
- تعطيل المفتاح مؤقتًا في حالة فشل مستمر
- استخدام cooldown وقتي بعد فشل طلبات متعددة
- التحقق من allowed models لكل مفتاح
- تطبيق حدود RPM / TPM على المفتاح نفسه

### 2.3 التوجيه الذكي
لـ proxy هناك دعم لتحديد كيفية اختيار النموذج أو المزود وفق استراتيجية معينة:

- fastest
- cheapest
- best_quality
- balanced
- fallback

المنطق موجود في [server.js](../server.js) ويختار النموذج بناءً على:

- متوسط latency
- cost per 1k input
- success rate
- score مدمج

### 2.4 التحقق من صلاحيات العميل
الـ client أو project key يمر عبر middleware للتحقق من:

- وجود المفتاح الصحيح
- تجاوز budget
- تجاوز daily/hourly/monthly budget
- تجاوز rate limits
- النطاق الزمني المسموح (allowed_hours)
- quota model-specific

### 2.5 تسجيل المقياس والميزانية
يسجل المشروع:

- requests count
- latency
- status success/failure
- tokens
- cost estimations
- model metrics
- provider metrics
- aggregated metrics

هذا موجود في قاعدة البيانات ضمن الجداول:

- clients
- spend_logs
- metrics
- model_metrics

---

## 3. بنية المشروع

### 3.1 الملفات الأساسية

- [server.js](../server.js): نقطة الدخول الرئيسية، جميع routes وlogic routing
- [store.js](../store.js): طبقة قاعدة البيانات، التشفير، CRUD، metrics، clients
- [models-api.js](../models-api.js): اكتشاف النماذج، فحصها، إعداد model metadata
- [auto.js](../auto.js): فحص تلقائي للمزودين والنماذج
- [smart.js](../smart.js): منطق التحقق والتحليل الذكي للـ provider keys
- [README.md](../README.md): دليل الاستخدام العام
- [public/admin.html](../public/admin.html): واجهة إدارة المشرف
- [public/index.html](../public/index.html): واجهة عامة
- [tests/rate-limit.test.js](../tests/rate-limit.test.js): اختبار حدود الاستخدام

### 3.2 مجلدات أساسية

- data/: مكان ملف SQLite
- locales/: ملفات الترجمة
- public/: ملفات الواجهات

---

## 4. تدفق التشغيل

### 4.1 التشغيل عند بدء المشروع

عند بدء التطبيق:

1. يتم تهيئة قاعدة بيانات SQLite
2. يتم إنشاء الجداول اللازمة
3. يتم إنشاء preset providers الأساسية
4. يتم تحميل legacy database data إلى الذاكرة
5. يتم تشغيل auto scan للأمزجة والمزودين عبر `startAuto()`

### 4.2 عند استقبال طلب إلى API

عند طلب `/v1/chat/completions` أو `/v1/embeddings`:

1. يتم التحقق من المفتاح (Authorization / x-api-key)
2. إذا المفتاح غير موجود → 401
3. يتم التحقق من الـ budget والlimits
4. يتم التحقق من quota model-specific
5. يتم اختيار النموذج أو المزود
6. يتم اختيار مفتاح صالح من المزود
7. يتم استدعاء المزود الخارجي
8. يتم تسجيل الmetrics وcost وlatency
9. يتم إعادة النتيجة إلى العميل

---

## 5. قاعدة البيانات

### 5.1 الجداول الأساسية

#### providers
تخزن بيانات كل مزود:

- name
- base_url
- default_model
- default_locked
- note
- scanning
- scanned_at

#### keys
تخزن مفاتيح المزود داخل كل مزود:

- id
- provider_name
- h (hash)
- enc (encrypted value)
- tail
- status
- disabled
- used
- errors
- success_rate
- last_error
- cooldown_until
- allowed_models
- rpm_limit
- tpm_limit

#### models
تخزن بيانات النماذج التي اكتشفها المزود:

- provider_name
- model_id
- type
- ok
- enabled
- err
- at

#### clients
تخزن مشاريع/عملاء الذين يستخدمون المفتاح العام:

- id
- name
- hash
- prefix
- created_at
- used
- last_used
- budget
- spend
- rpm_limit
- tpm_limit
- monthly_budget
- daily_budget
- hourly_budget
- tier
- model_quotas
- allowed_hours

#### spend_logs
تخزين تفاصيل كل spend/request:

- timestamp
- client_id
- provider_name
- model
- cost
- tokens
- latency
- status

#### model_metrics
تخزين مقاييس النماذج:

- avg_latency_ms
- success_rate
- cost_per_1k_input
- cost_per_1k_output
- context_length
- supports_vision
- supports_tools
- total_requests
- score

---

## 6. نظام الأمان

### 6.1 التشفير
كل مفتاح مزود يتم تخزينه مشفّرًا باستخدام AES-256-GCM.

- التشفير موجود في [store.js](../store.js)
- يعمل عبر `enc()` و `dec()`
- يتم فك تشفير المفتاح فقط مؤقتًا في الذاكرة عند الاستخدام

### 6.2 JWT / auth
المشروع يدعم:

- تسجيل مستخدم جديد
- تسجيل دخول مستخدم
- JWT token
- auth middleware

### 6.3 project key / client key
المشروع يتيح إنشاء key خاص لكل مشروع أو عميل، ومن ثم يطلب الطلب عبر هذا المفتاح بدلًا من مفتاح المزود نفسه.

---

## 7. واجهة المستخدم

### 7.1 واجهة الإدارة
المشرف يمكن من خلالها:

- إضافة مزودين
- إضافة مفاتيح مزود
- فحص المفاتيح
- تمكين / تعطيل المفاتيح
- فحص النماذج
- تعيين default model
- مسح المفتاح
- إدارة العملاء

### 7.2 لوحة المشاريع
واجهة المشرف تسمح أيضًا بإدارة:

- المشاريع
- حدود الاستخدام
- ميزانية المشروع
- limit RPM/TPM

---

## 8. API الحالية

### 8.1 مسارات المشروع العامة

- `/health`
- `/v1/chat/completions`
- `/v1/embeddings`
- `/v1/models`

### 8.2 مسارات الإدارة
توجد إدارة داخل server.js للأشياء مثل:

- PUT /admin/api/providers/:name
- DELETE /admin/api/providers/:name
- POST /admin/api/providers/:name/keys
- POST /admin/api/providers/:name/verify
- POST /admin/api/providers/:name/rescan
- POST /admin/api/clients
- DELETE /admin/api/clients/:id
- PUT /admin/api/clients/:id

---

## 9. نقاط القوة الحالية

### نقطة القوة الأساسية
المشروع يملك بالفعل معظم بنية infrastructure الأساسية:

- إدارة مزودين متعددة
- إدارة مفاتيح مشفرة
- routing ذكي
- rate limiting
- budget control
- model discovery
- monitoring metrics
- admin control panel

### ما يجعل المشروع فعليًا قيمة
هذا المشروع ليس مجرد proxy، بل يمكن أن يصبح gateway كامل لإدارة AI لعدة تطبيقات ومشاريع في نفس الوقت.

---

## 10. ما الذي ينقص الآن

على الرغم من أن المشروع قوي في أساسياته، إلا أنه ما زال يحتاج إلى تحسينات حاسمة حتى يصبح جاهزًا لفهمك المتقدم: “اختيار النماذج حسب الحصة والسياق”.

### الأكثر أهمية:

1. model quotas per project/app
2. allowed models per key
3. richer /v1/models metadata
4. app-level routing policy
5. task priority support
6. better quota enforcement logic
7. default model policy per client
8. per-model usage tracking per key
9. discovery-based selection documentation
10. admin UI لإدارة permissions

---

## 11. الخلاصة

Key Proxy مشروع جيد جدًا في بنيته الأساسية. هو بالفعل أكثر من proxy عادي، لكنه ما زال في مرحلة “gateway functional” وليس “gateway policy-aware fully managed”.

لو أردنا تطويره إلى مستوى الإنتاج الحقيقي، فنحن بحاجة إلى:

- تقييد النماذج حسب المفتاح
- إدارة الحصص لكل نموذج
- تعيين priorities و policies لكل تطبيق
- إضافة اكتشاف النماذج بشكل أكثر شمولاً
- جعل routing يعتمد على quota + cost + quality + task type

---

## 12. التوصية العامة

التطوير القادم يجب أن يركز على 3 محاور رئيسية:

1. permissions
2. quotas
3. policy-based model selection

هذه الثلاثة هي التي ستجعل المشروع قادرًا على أن يختار نماذج مختلفة تلقائيًا حسب المشروع والطلب والحصة، بدلًا من مجرد `model = auto` بدون سياسة واقعية.

