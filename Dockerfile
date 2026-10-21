# syntax=docker/dockerfile:1
FROM node:22-slim

WORKDIR /app

# تثبيت أدوات البناء المطلوبة لـ better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# نسخ ملفات الاعتماديات أولاً (للاستفادة من التخزين المؤقت)
COPY package*.json ./

# تثبيت الاعتماديات فقط للإنتاج
RUN npm ci --only=production

# نسخ باقي كود التطبيق
COPY . .

# إنشاء مجلد البيانات
RUN mkdir -p data

# المنفذ الذي سيستمع عليه التطبيق
EXPOSE 8080

# تشغيل التطبيق
CMD ["npm", "start"]
