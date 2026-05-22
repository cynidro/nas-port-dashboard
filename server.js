require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Load services ─────────────────────────────────────────────────────────
function loadServices() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'services.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('services.json 읽기 실패:', e.message);
    return [];
  }
}

// ─── Health check ──────────────────────────────────────────────────────────
function checkService(service) {
  return new Promise((resolve) => {
    const url = new URL(service.url);
    const lib = url.protocol === 'https:' ? https : http;
    const start = Date.now();

    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname || '/', method: 'GET', timeout: 4000 },
      (res) => {
        const ms = Date.now() - start;
        req.destroy();
        resolve({ ...service, status: 'up', ms });
      }
    );

    req.on('timeout', () => { req.destroy(); resolve({ ...service, status: 'down', ms: null }); });
    req.on('error', () => resolve({ ...service, status: 'down', ms: null }));
    req.end();
  });
}

// ─── API ────────────────────────────────────────────────────────────────────
app.get('/api/services', async (req, res) => {
  const services = loadServices();
  const results = await Promise.all(services.map(checkService));
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Dashboard → http://localhost:${PORT}\n`);
});
