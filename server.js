require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DOCKER_SOCKET = '/var/run/docker.sock';
const LABELS_PATH = path.join(__dirname, 'labels.json');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function loadLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveLabels(labels) {
  fs.writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2));
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

function deleteContainer(id) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `/containers/${id}?v=true&force=true`,
        method: 'DELETE',
        headers: { Host: 'localhost' }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Docker API Error (${res.statusCode}): ${data || res.statusMessage}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// 서비스 목록
app.get('/api/services', async (req, res) => {
  try {
    const containers = await getContainers();
    const labels = loadLabels();
    const services = [];

    for (const c of containers) {
      const rawName = (c.Names?.[0] || '').replace(/^\//, '');
      const label = labels[rawName];

      if (label?.exclude) continue;

      const ports = [...new Set(
        (c.Ports || []).filter(p => p.PublicPort).map(p => p.PublicPort)
      )].sort((a, b) => a - b);

      if (ports.length === 0) continue;

      const configured = !!(label?.icon && label?.name);

      services.push({
        id:           c.Id.substring(0, 12),
        rawName,
        name:         label?.name || rawName,
        icon:         label?.icon || '❓',
        port:         ports[0],
        running:      c.State === 'running',
        configured,   // false면 프론트에서 설정 유도
      });
    }

    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 컨테이너 종료 및 삭제
app.delete('/api/containers/:id', async (req, res) => {
  const { id } = req.params;
  const { rawName } = req.query;
  try {
    await deleteContainer(id);

    if (rawName) {
      const labels = loadLabels();
      if (labels[rawName]) {
        delete labels[rawName];
        saveLabels(labels);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 라벨 저장 (이름/이모지/제외)
app.post('/api/labels', (req, res) => {
  const { rawName, icon, name, exclude } = req.body;
  if (!rawName) return res.status(400).json({ error: 'rawName required' });

  const labels = loadLabels();
  if (exclude) {
    labels[rawName] = { exclude: true };
  } else {
    labels[rawName] = { icon, name };
  }
  saveLabels(labels);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));

