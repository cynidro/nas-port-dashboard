require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { execSync, exec } = require('child_process');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 30000;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

// ─── Docker Socket API ─────────────────────────────────────────────────────
function dockerRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: 'GET', headers: { Host: 'localhost' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Docker API parse error: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Local exec helper ─────────────────────────────────────────────────────
function localExec(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// ─── Parse Docker API container list ──────────────────────────────────────
function parseDockerContainers(apiContainers) {
  return apiContainers.map((c) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    const image = c.Image || '';
    const status = c.Status || '';
    const state = c.State || '';

    const ports = [];
    for (const p of c.Ports || []) {
      if (p.PublicPort) {
        ports.push({
          id: `docker-${name}-${p.PublicPort}`,
          type: 'docker',
          proto: (p.Type || 'tcp').toUpperCase(),
          hostPort: p.PublicPort,
          containerPort: p.PrivatePort,
          host: p.IP || '0.0.0.0',
          container: name,
          service: guessService(p.PublicPort, name),
          status: state === 'running' ? 'active' : 'inactive',
        });
      } else if (p.PrivatePort) {
        ports.push({
          id: `docker-exposed-${name}-${p.PrivatePort}`,
          type: 'docker-exposed',
          proto: (p.Type || 'tcp').toUpperCase(),
          hostPort: null,
          containerPort: p.PrivatePort,
          container: name,
          service: guessService(p.PrivatePort, name),
          status: 'exposed-only',
        });
      }
    }

    return { id: c.Id?.slice(0, 12), name, image, status, state, ports };
  });
}

// ─── Parse ss output ──────────────────────────────────────────────────────
function parseSsOutput(raw) {
  const lines = (raw || '').trim().split('\n').slice(1);
  const ports = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;

    const proto = parts[0];
    const localAddr = parts[4];
    const processInfo = parts.slice(6).join(' ');

    const colonIdx = localAddr.lastIndexOf(':');
    const host = localAddr.substring(0, colonIdx);
    const portNum = localAddr.substring(colonIdx + 1);

    if (!portNum || isNaN(parseInt(portNum))) continue;

    let processName = 'unknown';
    const nameMatch = processInfo.match(/\(\("([^"]+)"/);
    if (nameMatch) processName = nameMatch[1];

    ports.push({
      id: `sys-${proto}-${portNum}`,
      type: 'system',
      proto: proto.toUpperCase(),
      port: parseInt(portNum),
      host: host === '*' ? '0.0.0.0' : host,
      process: processName,
      service: guessService(parseInt(portNum), processName),
      status: 'active',
    });
  }

  return ports;
}

// ─── Service guesser ──────────────────────────────────────────────────────
const KNOWN_PORTS = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 443: 'HTTPS', 3306: 'MySQL', 5432: 'PostgreSQL',
  6379: 'Redis', 27017: 'MongoDB', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt',
  9000: 'Portainer / PHP-FPM', 9090: 'Prometheus', 3000: 'Grafana / Node',
  8888: 'Jupyter', 51820: 'WireGuard', 32400: 'Plex', 8096: 'Jellyfin',
  8920: 'Jellyfin-HTTPS', 7474: 'Neo4j', 9200: 'Elasticsearch',
  5601: 'Kibana', 2375: 'Docker', 2376: 'Docker-TLS', 4533: 'Navidrome',
  8989: 'Sonarr', 7878: 'Radarr', 9117: 'Jackett', 8112: 'Deluge',
  6881: 'BitTorrent', 1194: 'OpenVPN', 5000: 'Synology DSM / Flask',
  5001: 'Synology DSM HTTPS', 5800: 'VNC Web', 5900: 'VNC',
  1900: 'DLNA/SSDP', 7000: 'AirPlay', 8200: 'Vault', 4646: 'Nomad',
  8500: 'Consul', 2181: 'Zookeeper', 9092: 'Kafka', 15672: 'RabbitMQ',
  5672: 'RabbitMQ-AMQP', 6443: 'Kubernetes API',
};

function guessService(port, name) {
  if (KNOWN_PORTS[port]) return KNOWN_PORTS[port];
  const n = (name || '').toLowerCase();
  if (n.includes('nginx') || n.includes('apache')) return 'Web Server';
  if (n.includes('mysql') || n.includes('mariadb')) return 'Database';
  if (n.includes('postgres')) return 'Database';
  if (n.includes('redis')) return 'Cache';
  if (n.includes('mongo')) return 'Database';
  if (n.includes('grafana')) return 'Grafana';
  if (n.includes('plex')) return 'Plex Media';
  if (n.includes('jellyfin')) return 'Jellyfin';
  if (n.includes('nextcloud')) return 'Nextcloud';
  if (n.includes('home') && n.includes('assistant')) return 'Home Assistant';
  if (n.includes('portainer')) return 'Portainer';
  if (n.includes('traefik')) return 'Traefik';
  if (n.includes('caddy')) return 'Caddy';
  if (n.includes('adguard')) return 'AdGuard';
  if (n.includes('pihole')) return 'Pi-hole';
  if (n.includes('vaultwarden') || n.includes('bitwarden')) return 'Vaultwarden';
  return 'Service';
}

// ─── Cache ─────────────────────────────────────────────────────────────────
let cache = {
  systemPorts: [],
  dockerContainers: [],
  lastUpdated: null,
  error: null,
  connectionStatus: 'disconnected',
};

async function refreshData() {
  try {
    // 1. Docker containers via socket API
    const apiContainers = await dockerRequest('/containers/json?all=true');
    cache.dockerContainers = parseDockerContainers(apiContainers);

    // 2. System ports via ss (runs inside container with host network)
    const ssResult = await localExec('ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null');
    cache.systemPorts = parseSsOutput(ssResult.stdout);

    cache.lastUpdated = new Date().toISOString();
    cache.error = null;
    cache.connectionStatus = 'connected';
    console.log(`[${new Date().toLocaleTimeString()}] Refreshed: ${cache.systemPorts.length} system ports, ${cache.dockerContainers.length} containers`);
  } catch (err) {
    cache.error = err.message;
    cache.connectionStatus = 'error';
    console.error('Refresh error:', err.message);
  }
}

// ─── SSE clients for Docker Events ────────────────────────────────────────
const sseClients = new Set();
let eventReq = null;

function startDockerEventStream() {
  if (eventReq) return;

  const req = http.request(
    {
      socketPath: DOCKER_SOCKET,
      path: '/events?filters=' + encodeURIComponent(JSON.stringify({ type: ['container'] })),
      method: 'GET',
      headers: { Host: 'localhost' },
    },
    (res) => {
      console.log('[Docker Events] Stream connected');
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const payload = {
              time: event.time,
              action: event.Action,
              actor: event.Actor?.Attributes?.name || event.Actor?.ID?.slice(0, 12),
              image: event.Actor?.Attributes?.image,
            };

            console.log('[Docker Event]', payload.action, payload.actor);

            const msg = `data: ${JSON.stringify(payload)}\n\n`;
            for (const client of sseClients) client.write(msg);

            const important = ['start', 'stop', 'die', 'create', 'destroy', 'pause', 'unpause'];
            if (important.includes(payload.action)) setTimeout(refreshData, 1500);
          } catch (_) {}
        }
      });

      res.on('end', () => {
        console.log('[Docker Events] Stream ended, reconnecting in 5s...');
        eventReq = null;
        setTimeout(startDockerEventStream, 5000);
      });

      res.on('error', (err) => {
        console.error('[Docker Events] Stream error:', err.message);
        eventReq = null;
        setTimeout(startDockerEventStream, 5000);
      });
    }
  );

  req.on('error', (err) => {
    console.error('[Docker Events] Request error:', err.message);
    eventReq = null;
    setTimeout(startDockerEventStream, 10000);
  });

  req.end();
  eventReq = req;
}

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    connectionStatus: cache.connectionStatus,
    lastUpdated: cache.lastUpdated,
    error: cache.error,
    systemPortCount: cache.systemPorts.length,
    containerCount: cache.dockerContainers.length,
  });
});

app.get('/api/ports', (req, res) => {
  const allDockerPorts = cache.dockerContainers.flatMap((c) =>
    c.ports.map((p) => ({ ...p, containerName: c.name, containerStatus: c.status }))
  );
  res.json({
    systemPorts: cache.systemPorts,
    dockerContainers: cache.dockerContainers,
    allDockerPorts,
    lastUpdated: cache.lastUpdated,
    connectionStatus: cache.connectionStatus,
    error: cache.error,
  });
});

app.post('/api/refresh', async (req, res) => {
  await refreshData();
  res.json({ success: true, lastUpdated: cache.lastUpdated });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 30000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 NAS Port Dashboard → http://localhost:${PORT}`);
  console.log(`🐳 Docker socket: ${DOCKER_SOCKET}\n`);
  await refreshData();
  startDockerEventStream();
  setInterval(refreshData, POLL_INTERVAL);
});
