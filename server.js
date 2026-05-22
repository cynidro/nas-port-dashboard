require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DOCKER_SOCKET = '/var/run/docker.sock';

app.use(express.static(path.join(__dirname, 'public')));

// Docker 소켓으로 컨테이너 목록 가져오기
function getContainers() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: '/containers/json?all=true', method: 'GET', headers: { Host: 'localhost' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

app.get('/api/services', async (req, res) => {
  try {
    const containers = await getContainers();
    const services = [];

    for (const c of containers) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const running = c.State === 'running';

      // 호스트에 열린 포트만
      const ports = (c.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => p.PublicPort);

      if (ports.length === 0) continue; // 포트 없으면 표시 안 함

      services.push({
        name,
        image: (c.Image || '').split(':')[0],
        ports,
        state: c.State,
        running,
      });
    }

    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
