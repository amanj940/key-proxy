# Key Proxy

A smart AI gateway for managing multiple LLM provider keys in one place with OpenAI-compatible interface, automatic key rotation, cost tracking, and rate limiting.

## Features

### 🔐 Security
- AES-256-GCM encryption for all provider keys
- Independent project keys for each application
- Decryption only in temporary memory

### 🚀 Auto Detection
- Auto-detect provider from key prefix (gsk_, sk-or-, AIza, etc.)
- Verify each key before saving
- Auto-scan available models for each provider

### 🔄 Smart Rotation
- Automatic key rotation on failure
- Retry support with cooldown periods
- Fallback between providers

### 💰 Cost Management
- Budget tracking per project
- Cost calculation per request
- Alerts when budget exceeded

### ⚡ Rate Limiting
- RPM (Requests Per Minute)
- TPM (Tokens Per Minute)
- Customizable limits per project

### 📊 Monitoring
- Detailed logs for each request
- Usage and performance tracking
- Integrated admin interface

## Documentation

- [Project overview and architecture](docs/PROJECT_DOCUMENTATION.md)
- [Implemented updates, verification, deployment, and known limitations](docs/IMPLEMENTED_UPDATES.md)
- [Planned upgrades](docs/REQUIRED_UPGRADES.md)

## Installation

### Requirements
- Node.js 18 or later
- npm or yarn

### Steps

1. Clone the repository:
```bash
git clone https://github.com/amanj940/key-proxy.git
cd key-proxy
```

2. Install dependencies:
```bash
npm install
```

3. Generate encryption key:
```bash
openssl rand -hex 32
```

4. Create `.env` file:
```bash
MASTER_KEY=<64-char-hex-key-from-step-3>
DB_PATH=./data/key-proxy.db
PORT=8787
HOST=127.0.0.1
```

5. Start the server:
```bash
npm start
```

Or:
```bash
node server.js
```

## Usage

### Admin Panel

Open your browser at:
```
http://127.0.0.1:8787/admin
```

### Adding Provider Keys

1. In the admin panel, paste provider keys in the "Add Provider Keys" section
2. The system will auto-detect the provider and verify the key
3. You can paste a complete `.env` file or multiple keys

### Creating a Project Key

1. Enter project name
2. (Optional) Set budget in USD
3. (Optional) Set RPM and TPM limits
4. Click "Create Key"
5. Copy the key immediately (it won't appear again)

### Using in Applications

```bash
# Set environment variables
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sk-kp-<your-project-key>
```

### Example with OpenAI SDK

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'sk-kp-<your-project-key>'
});

const response = await client.chat.completions.create({
  model: 'auto',  // Will auto-select best model
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Selecting a Specific Model

```javascript
const response = await client.chat.completions.create({
  model: 'groq/llama-3.3-70b-versatile',  // provider/model
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## Supported Providers

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

## Budget and Limits

### Budget Tracking

```javascript
// When creating a project key
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

### Project Management

```bash
# Create project key
POST /admin/api/clients
Body: { name, budget?, rpmLimit?, tpmLimit? }

# Delete project key
DELETE /admin/api/clients/:id

# Update limits
PUT /admin/api/clients/:id
Body: { budget?, rpmLimit?, tpmLimit? }

# View spend logs
GET /admin/api/clients/:id/spend?limit=100&offset=0
```

### Provider Management

```bash
# Add provider
PUT /admin/api/providers/:name
Body: { baseUrl, defaultModel? }

# Delete provider
DELETE /admin/api/providers/:name

# Add keys
POST /admin/api/providers/:name/keys
Body: { keys: "key1,key2,key3" }

# Scan models
POST /admin/api/providers/:name/rescan
```

## Database

The project uses SQLite for the database:

- Location: `./data/key-proxy.db`
- Tables:
  - `providers`: Provider information
  - `keys`: Provider keys (encrypted)
  - `models`: Available models
  - `clients`: Project keys
  - `spend_logs`: Usage logs

### Backup

```bash
# Backup database
cp data/key-proxy.db data/key-proxy-backup-$(date +%Y%m%d).db
```

## Testing

```bash
# Run tests
npm test

# Run without watch mode
npm run test:run
```

## Production

### Recommendations

1. Use a reverse proxy (nginx, Apache)
2. Enable HTTPS
3. Set a strong MASTER_KEY
4. Use regular database backups
5. Monitor usage logs

### Nginx Example

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

## Troubleshooting

### MASTER_KEY error
```bash
Error: MASTER_KEY must be 64 hex chars
```
Solution: Make sure you generated a 64 hex char key:
```bash
openssl rand -hex 32
```

### Port already in use
```bash
Error: listen EADDRINUSE: address already in use
```
Solution:
```bash
# Find the process
lsof -ti:8787

# Kill it
kill <pid>
```

### Database locked
If you encounter database errors:
```bash
# Stop the server
# Remove WAL files
rm data/key-proxy.db-wal data/key-proxy.db-shm
# Restart
```

## License

MIT

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## Support

For support and questions, open an issue on GitHub.
