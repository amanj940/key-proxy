# Key Proxy

بوابة ذكية لإدارة مفاتيح مزودي الذكاء الاصطناعي في مكان واحد، مع واجهة متوافقة مع OpenAI ودعم للتدوير التلقائي، تتبع التكاليف، وحدود المعدل.

## الميزات

### 🔐 الأمان
- تشفير AES-256-GCM لجميع مفاتيح المزودين
- مفاتيح مشاريع مستقلة لكل تطبيق
- فك التشفير فقط في الذاكرة المؤقتة

### 🚀 الكشف التلقائي
- كشف المزود تلقائياً من بادئة المفتاح (gsk_, sk-or-, AIza, إلخ)
- التحقق الفعلي من كل مفتاح قبل حفظه
- فحص تلقائي للنماذج المتاحة لكل مزود

### 🔄 التدوير الذكي
- تدوير تلقائي للمفاتيح عند التعطل
- دعم إعادة المحاولة مع cooldown periods
- fallback بين المزودين

### 💰 إدارة التكاليف
- تتبع الميزانية لكل مشروع
- حساب التكاليف لكل طلب
- تنبيهات عند تجاوز الميزانية

### ⚡ Rate Limiting
- RPM (Requests Per Minute)
- TPM (Tokens Per Minute)
- حدود قابلة للتخصيص لكل مشروع

### 📊 المراقبة
- سجلات مفصلة لكل طلب
- تتبع الاستهلاك والأداء
- واجهة إدارة متكاملة

## التثبيت

### المتطلبات
- Node.js 18 أو أحدث
- npm أو yarn

### الخطوات

1. استنساخ المشروع:
```bash
git clone <repository-url>
cd key-proxy
```

2. تثبيت الاعتماديات:
```bash
npm install
```

3. إنشاء مفتاح التشفير:
```bash
openssl rand -hex 32
```

4. إنشاء ملف `.env`:
```bash
MASTER_KEY=<64-char-hex-key-from-step-3>
DB_PATH=./data/key-proxy.db
PORT=8787
HOST=127.0.0.1
```

5. تشغيل السيرفر:
```bash
npm start
```

أو:
```bash
node server.js
```

## الاستخدام

### لوحة الإدارة

افتح المتصفح على:
```
http://127.0.0.1:8787/admin
```

### إضافة مفاتيح المزودين

1. في لوحة الإدارة، الصق مفاتيح المزودين في خانة "إضافة مفاتيح المزودين"
2. النظام سيكتشف المزود تلقائياً ويتحقق من المفتاح
3. يمكن لصق ملف `.env` كامل أو مفاتيح متعددة

### إنشاء مفتاح مشروع

1. أدخل اسم المشروع
2. (اختياري) حدد الميزانية بالدولار
3. (اختياري) حدد RPM و TPM
4. انقر "إنشاء مفتاح"
5. انسخ المفتاح فوراً (لن يظهر مرة أخرى)

### استخدام في التطبيقات

```bash
# تعيين متغيرات البيئة
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sk-kp-<your-project-key>
```

### مثال مع OpenAI SDK

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'sk-kp-<your-project-key>'
});

const response = await client.chat.completions.create({
  model: 'auto',  // سيختار أفضل نموذج تلقائياً
  messages: [{ role: 'user', content: 'مرحباً!' }]
});
```

### اختيار نموذج محدد

```javascript
const response = await client.chat.completions.create({
  model: 'groq/llama-3.3-70b-versatile',  // مزود/نموذج
  messages: [{ role: 'user', content: 'مرحباً!' }]
});
```

## المزودون المدعومون

- Groq
- OpenRouter
- Google Gemini
- Cerebras
- Mistral
- SambaNova
- NVIDIA
- XAI
- Fireworks
- HuggingFace

## الميزانية والحدود

### Budget Tracking

```javascript
// عند إنشاء مفتاح مشروع
await fetch('http://127.0.0.1:8787/admin/api/clients', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'my-project',
    budget: 100.00  // $100 max spend
  })
});
```

### Rate Limiting

```javascript
await fetch('http://127.0.0.1:8787/admin/api/clients', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'my-project',
    rpmLimit: 100,   // 100 requests per minute
    tpmLimit: 10000  // 10000 tokens per minute
  })
});
```

## API Endpoints

### إدارة المشاريع

```bash
# إنشاء مفتاح مشروع
POST /admin/api/clients
Body: { name, budget?, rpmLimit?, tpmLimit? }

# حذف مفتاح مشروع
DELETE /admin/api/clients/:id

# تحديث الحدود
PUT /admin/api/clients/:id
Body: { budget?, rpmLimit?, tpmLimit? }

# عرض سجلات الاستهلاك
GET /admin/api/clients/:id/spend?limit=100&offset=0
```

### إدارة المزودين

```bash
# إضافة مزود
PUT /admin/api/providers/:name
Body: { baseUrl, defaultModel? }

# حذف مزود
DELETE /admin/api/providers/:name

# إضافة مفاتيح
POST /admin/api/providers/:name/keys
Body: { keys: "key1,key2,key3" }

# فحص النماذج
POST /admin/api/providers/:name/rescan
```

## قاعدة البيانات

يستخدم المشروع SQLite لقاعدة البيانات:

- الموقع: `./data/key-proxy.db`
- الجداول:
  - `providers`: معلومات المزودين
  - `keys`: مفاتيح المزودين (مشفرة)
  - `models`: النماذج المتاحة
  - `clients`: مفاتيح المشاريع
  - `spend_logs`: سجلات الاستهلاك

### النسخ الاحتياطي

```bash
# نسخ قاعدة البيانات
cp data/key-proxy.db data/key-proxy-backup-$(date +%Y%m%d).db
```

## الاختبارات

```bash
# تشغيل الاختبارات
npm test

# تشغيل بدون وضع المراقبة
npm run test:run
```

## الإنتاج

### التوصيات

1. استخدم Reverse Proxy (nginx, Apache)
2. فعّل HTTPS
3. حدد MASTER_KEY قوي
4. استخدم database backup دوري
5. راقب logs الاستهلاك

### مثال Nginx

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## استكشاف الأخطاء

### MASTER_KEY error
```bash
Error: MASTER_KEY must be 64 hex chars
```
الحل: تأكد من إنشاء مفتاح 64 hex char:
```bash
openssl rand -hex 32
```

### Port already in use
```bash
Error: listen EADDRINUSE: address already in use
```
الحل:
```bash
# ابحث عن العملية
lsof -ti:8787

# أوقفها
kill <pid>
```

### Database locked
إذا واجهت أخطاء في قاعدة البيانات:
```bash
# أوقف السيرفر
# احذف ملفات WAL
rm data/key-proxy.db-wal data/key-proxy.db-shm
# أعد التشغيل
```

## الترخيص

ISC

## المساهمة

المساهمات مرحب بها! الرجاء:
1. Fork المشروع
2. إنشاء branch للميزة
3. Commit التغييرات
4. Push إلى Branch
5. فتح Pull Request

## الدعم

للدعم والأسئلة، افتح issue في GitHub.
