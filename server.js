require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DOCKER_SOCKET = '/var/run/docker.sock';

app.use(express.static(path.join(__dirname, 'public')));

function loadLabels() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'labels.json'), 'utf-8'));
  } catch { return {}; }
}

function getContainers() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: '/containers/json?all=true', method: 'GET', headers: { Host: 'localhost' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

app.get('/api/services', async (req, res) => {
  try {
    const containers = await getContainers();
    const labels = loadLabels();
    const services = [];

    for (const c of containers) {
      const rawName = (c.Names?.[0] || '').replace(/^\//, '');
      const label = labels[rawName] || {};

      if (label.exclude) continue;

      // 중복 제거: 같은 포트가 IPv4/IPv6 두 번 뜨는 거 Set으로 제거
      const ports = [...new Set(
        (c.Ports || []).filter(p => p.PublicPort).map(p => p.PublicPort)
      )].sort((a, b) => a - b);

      if (ports.length === 0) continue;

      services.push({
        name:    label.name || rawName,
        icon:    label.icon || '🔧',
        port:    ports[0],           // 대표 포트 하나만
        running: c.State === 'running',
      });
    }

    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
