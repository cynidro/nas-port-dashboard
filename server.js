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

function dockerRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, headers: { Host: 'localhost' }, ...options },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function getContainers() {
  return dockerRequest({ path: '/containers/json?all=true', method: 'GET' })
    .then(({ raw }) => JSON.parse(raw.toString()));
}

function deleteContainer(id) {
  return dockerRequest({ path: `/containers/${id}?v=true&force=true`, method: 'DELETE' })
    .then(({ status, raw }) => {
      if (status < 200 || status >= 300) {
        throw new Error(`Docker API Error (${status}): ${raw.toString() || 'unknown'}`);
      }
    });
}

// Docker multiplexed stream demuxer (stdout/stderr 분리)
function demuxDockerStream(buf) {
  let stdout = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];       // 1=stdout, 2=stderr
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;
    const chunk = buf.slice(offset, offset + size).toString('utf-8');
    if (streamType === 1) stdout += chunk;
    offset += size;
  }
  return stdout;
}

async function getGitInfoFromContainer(containerId) {
  try {
    // 1단계: exec 생성
    const execCreateBody = JSON.stringify({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ['sh', '-c',
        // .git/logs/HEAD의 마지막 줄을 파싱 (빠름)
        // 포맷: <old-sha> <new-sha> <author> <timestamp> <tz> \t<message>
        'tail -1 /app/.git/logs/HEAD 2>/dev/null || ' +
        'tail -1 /app/app/.git/logs/HEAD 2>/dev/null || ' +
        'tail -1 /.git/logs/HEAD 2>/dev/null || ' +
        // fallback: git log 명령어
        'git -C /app log --format="%H|%ae|%at|%s" -1 2>/dev/null || ' +
        'git log --format="%H|%ae|%at|%s" -1 2>/dev/null || echo ""'
      ]
    });

    const createRes = await dockerRequest(
      { path: `/containers/${containerId}/exec`, method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(execCreateBody) } },
      execCreateBody
    );
    if (createRes.status !== 201) return null;

    const { Id: execId } = JSON.parse(createRes.raw.toString());

    // 2단계: exec 실행
    const startBody = JSON.stringify({ Detach: false, Tty: false });
    const startRes = await dockerRequest(
      { path: `/exec/${execId}/start`, method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(startBody) } },
      startBody
    );

    const stdout = demuxDockerStream(startRes.raw).trim();
    if (!stdout) return null;

    // git reflog 형식 (tail -1 .git/logs/HEAD 결과) 파싱 시도
    // 형식: <old> <new> Author Name <email> <unixtime> <tz>\t<message>
    const reflogMatch = stdout.match(/^[0-9a-f]+ ([0-9a-f]+) .+? (\d+) [+-]\d+\t(.+)$/);
    if (reflogMatch) {
      const [, hash, unixtime, message] = reflogMatch;
      return {
        hash: hash.substring(0, 7),
        message: message.replace(/^commit: /, '').trim(),
        date: new Date(parseInt(unixtime) * 1000).toISOString(),
      };
    }

    // git log 형식 (pipe-separated) 파싱 시도
    const parts = stdout.split('|');
    if (parts.length >= 4) {
      const [hash, , unixtime, ...msgParts] = parts;
      const message = msgParts.join('|').trim();
      return {
        hash: hash.substring(0, 7),
        message,
        date: new Date(parseInt(unixtime) * 1000).toISOString(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// 서비스 목록
app.get('/api/services', async (req, res) => {
  try {
    const containers = await getContainers();
    const labels = loadLabels();
    const services = [];

    // Git 조회를 병렬로 실행
    const enriched = await Promise.all(containers.map(async (c) => {
      const rawName = (c.Names?.[0] || '').replace(/^\//, '');
      const label = labels[rawName];

      if (label?.exclude) return null;

      const ports = [...new Set(
        (c.Ports || []).filter(p => p.PublicPort).map(p => p.PublicPort)
      )].sort((a, b) => a - b);

      if (ports.length === 0) return null;

      const configured = !!(label?.icon && label?.name);
      const isRunning = c.State === 'running';

      // Git 정보는 실행 중인 컨테이너에서만 시도
      const git = isRunning ? await getGitInfoFromContainer(c.Id) : null;

      return {
        id:         c.Id.substring(0, 12),
        rawName,
        name:       label?.name || rawName,
        icon:       label?.icon || '❓',
        port:       ports[0],
        running:    isRunning,
        configured,
        created:    c.Created ? new Date(c.Created * 1000).toISOString() : null,
        git,        // null 또는 { hash, message, date }
      };
    }));

    res.json(enriched.filter(Boolean));
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
