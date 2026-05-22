/* ─── State ────────────────────────────────────────────────────────────────── */
let state = {
  systemPorts: [],
  dockerContainers: [],
  allDockerPorts: [],
  activeTab: 'all',       // 'all' | 'docker' | 'system'
  activeProto: 'all',     // 'all' | 'TCP' | 'UDP'
  searchQuery: '',
  sortKey: 'port',
  sortAsc: true,
  eventCount: 0,
};

/* ─── Init ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  generateParticles();
  loadData();
  connectSSE();
  // Auto-refresh every 30s
  setInterval(loadData, 30000);
});

/* ─── Background Particles ─────────────────────────────────────────────────── */
function generateParticles() {
  const container = document.getElementById('bgParticles');
  for (let i = 0; i < 6; i++) {
    const dot = document.createElement('div');
    dot.style.cssText = `
      position: absolute;
      width: ${Math.random() * 3 + 1}px;
      height: ${Math.random() * 3 + 1}px;
      background: rgba(99,102,241,${Math.random() * 0.4 + 0.1});
      border-radius: 50%;
      top: ${Math.random() * 100}%;
      left: ${Math.random() * 100}%;
      animation: float${i} ${Math.random() * 20 + 15}s ease-in-out infinite;
    `;
    container.appendChild(dot);
  }
}

/* ─── Fetch Data ───────────────────────────────────────────────────────────── */
async function loadData() {
  try {
    setConnectionStatus('connecting');
    const res = await fetch('/api/ports');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.systemPorts = data.systemPorts || [];
    state.dockerContainers = data.dockerContainers || [];
    state.allDockerPorts = data.allDockerPorts || [];

    updateStats();
    renderTable();
    renderContainers();
    updateLastUpdated(data.lastUpdated);

    if (data.connectionStatus === 'connected') {
      setConnectionStatus('connected');
    } else if (data.connectionStatus === 'error') {
      setConnectionStatus('error', data.error);
    }
  } catch (err) {
    setConnectionStatus('error', err.message);
    showToast('NAS 연결 오류: ' + err.message, 'error');
  }
}

async function manualRefresh() {
  const icon = document.getElementById('refreshIcon');
  icon.classList.add('spinning');
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
    showToast('데이터 새로고침 완료', 'success');
  } finally {
    icon.classList.remove('spinning');
  }
}

/* ─── SSE - Docker Events ──────────────────────────────────────────────────── */
function connectSSE() {
  const es = new EventSource('/api/events');

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === 'connected') return;
      addEventToFeed(event);
      state.eventCount++;
      document.getElementById('statEventCount').textContent = state.eventCount;
    } catch (_) {}
  };

  es.onerror = () => {
    console.warn('[SSE] Connection lost, will retry...');
    setTimeout(() => connectSSE(), 5000);
    es.close();
  };
}

function addEventToFeed(event) {
  const feed = document.getElementById('eventFeed');
  const empty = feed.querySelector('.event-empty');
  if (empty) empty.remove();

  const actionClass = getActionClass(event.action);
  const time = event.time ? new Date(event.time * 1000).toLocaleTimeString('ko-KR') : new Date().toLocaleTimeString('ko-KR');

  const item = document.createElement('div');
  item.className = 'event-item';
  item.innerHTML = `
    <span class="event-action-badge ${actionClass}">${(event.action || 'event').toUpperCase()}</span>
    <div class="event-info">
      <div class="event-actor">${escHtml(event.actor || 'unknown')}</div>
      <div class="event-time">${time}</div>
    </div>
  `;

  feed.insertBefore(item, feed.firstChild);

  // Keep max 50 events
  const items = feed.querySelectorAll('.event-item');
  if (items.length > 50) items[items.length - 1].remove();
}

function getActionClass(action) {
  const map = { start: 'start', stop: 'stop', die: 'die', create: 'create', destroy: 'destroy', pause: 'pause', unpause: 'unpause' };
  return map[action] || 'default';
}

/* ─── Stats ────────────────────────────────────────────────────────────────── */
function updateStats() {
  animateNumber('statSystemCount', state.systemPorts.length);
  animateNumber('statDockerCount', state.dockerContainers.length);
  animateNumber('statPortCount', state.allDockerPorts.filter(p => p.hostPort).length + state.systemPorts.length);
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  const start = parseInt(el.textContent) || 0;
  const diff = target - start;
  const steps = 20;
  let step = 0;
  const timer = setInterval(() => {
    step++;
    el.textContent = Math.round(start + (diff * step / steps));
    if (step >= steps) clearInterval(timer);
  }, 16);
}

/* ─── Filter & Sort ────────────────────────────────────────────────────────── */
function setTab(tab) {
  state.activeTab = tab;
  ['tabAll', 'tabDocker', 'tabSystem'].forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
  document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
  renderTable();
}

function setProto(proto) {
  state.activeProto = proto;
  ['chipAll', 'chipTcp', 'chipUdp'].forEach(id => {
    document.getElementById(id).classList.remove('active');
  });
  const map = { all: 'chipAll', TCP: 'chipTcp', UDP: 'chipUdp' };
  document.getElementById(map[proto]).classList.add('active');
  renderTable();
}

function applyFilters() {
  state.searchQuery = document.getElementById('searchInput').value.toLowerCase();
  renderTable();
}

function sortTable(key) {
  if (state.sortKey === key) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortKey = key;
    state.sortAsc = true;
  }
  renderTable();
}

function getFilteredRows() {
  const allRows = [];

  if (state.activeTab !== 'docker') {
    for (const p of state.systemPorts) {
      allRows.push({
        port: p.port,
        proto: p.proto,
        service: p.service,
        type: 'system',
        name: p.process,
        host: p.host,
        status: 'active',
        _raw: p,
      });
    }
  }

  if (state.activeTab !== 'system') {
    for (const p of state.allDockerPorts) {
      allRows.push({
        port: p.hostPort ?? p.containerPort,
        proto: p.proto,
        service: p.service,
        type: p.type === 'docker-exposed' ? 'exposed' : 'docker',
        name: p.container,
        host: p.host || '-',
        hostPort: p.hostPort,
        containerPort: p.containerPort,
        status: p.status,
        containerStatus: p.containerStatus || '',
        _raw: p,
      });
    }
  }

  // Proto filter
  let rows = state.activeProto === 'all' ? allRows : allRows.filter(r => r.proto === state.activeProto);

  // Search filter
  if (state.searchQuery) {
    const q = state.searchQuery;
    rows = rows.filter(r =>
      String(r.port).includes(q) ||
      (r.service || '').toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.host || '').toLowerCase().includes(q) ||
      (r.proto || '').toLowerCase().includes(q)
    );
  }

  // Sort
  rows.sort((a, b) => {
    let av = a[state.sortKey];
    let bv = b[state.sortKey];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return state.sortAsc ? -1 : 1;
    if (av > bv) return state.sortAsc ? 1 : -1;
    return 0;
  });

  return rows;
}

/* ─── Render Table ─────────────────────────────────────────────────────────── */
function renderTable() {
  const rows = getFilteredRows();
  const tbody = document.getElementById('portTableBody');
  document.getElementById('tableCount').textContent = rows.length;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style="opacity:0.3;margin:auto">
        <circle cx="20" cy="20" r="18" stroke="#6366f1" stroke-width="2"/>
        <path d="M14 20h12M20 14v12" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <p>검색 결과가 없습니다</p>
    </td></tr>`;
    return;
  }

  const html = rows.map(r => renderRow(r)).join('');
  tbody.innerHTML = html;
}

function renderRow(r) {
  const portDisplay = r.type === 'docker' && r.containerPort
    ? `<div class="port-number">${r.hostPort ?? '?'}</div><div class="port-host">→ :${r.containerPort}</div>`
    : `<div class="port-number">${r.port}</div><div class="port-host">${r.host}</div>`;

  const protoBadge = `<span class="proto-badge proto-badge--${(r.proto || 'tcp').toLowerCase()}">${r.proto || '?'}</span>`;

  const typeLabel = { docker: 'Docker', system: 'System', exposed: 'Exposed' };
  const typeClass = { docker: 'type-badge--docker', system: 'type-badge--system', exposed: 'type-badge--exposed' };
  const typeBadge = `<span class="type-badge ${typeClass[r.type] || ''}">${typeLabel[r.type] || r.type}</span>`;

  const statusText = r.status === 'active' ? 'Active' : r.status === 'exposed-only' ? 'Exposed' : 'Inactive';
  const statusClass = r.status === 'active' ? 'status-pill--active' : r.status === 'exposed-only' ? 'status-pill--exposed' : 'status-pill--inactive';
  const statusPill = `<span class="status-pill ${statusClass}">${statusText}</span>`;

  return `<tr>
    <td>${portDisplay}</td>
    <td>${protoBadge}</td>
    <td><span class="service-name">${escHtml(r.service || '-')}</span></td>
    <td>${typeBadge}</td>
    <td><span class="process-name">${escHtml(r.name || '-')}</span></td>
    <td>${statusPill}</td>
  </tr>`;
}

/* ─── Render Containers ────────────────────────────────────────────────────── */
function renderContainers() {
  const list = document.getElementById('containerList');
  document.getElementById('containerCount').textContent = state.dockerContainers.length;

  if (!state.dockerContainers.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:20px;font-size:0.8rem;">컨테이너 없음</div>';
    return;
  }

  list.innerHTML = state.dockerContainers.map(c => {
    const statusLower = (c.status || '').toLowerCase();
    let dotClass = 'stopped';
    if (statusLower.includes('up')) dotClass = 'running';
    else if (statusLower.includes('pause')) dotClass = 'paused';

    const ports = c.ports.filter(p => p.hostPort);
    const portTags = ports.length
      ? ports.map(p => `<span class="port-tag">${p.hostPort}→${p.containerPort}</span>`).join('')
      : `<span class="port-tag port-tag--none">포트 없음</span>`;

    return `<div class="container-item">
      <div class="container-header">
        <div class="container-status-dot ${dotClass}"></div>
        <div class="container-name" title="${escHtml(c.name)}">${escHtml(c.name)}</div>
      </div>
      <div class="container-image">${escHtml(c.image)}</div>
      <div class="container-ports">${portTags}</div>
    </div>`;
  }).join('');
}

/* ─── UI Helpers ───────────────────────────────────────────────────────────── */
function setConnectionStatus(status, msg) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'status-dot ' + status;
  const labels = { connected: '연결됨', error: '연결 오류', connecting: '연결 중...' };
  text.textContent = labels[status] || status;
  if (status === 'error' && msg) {
    console.error('Connection error:', msg);
  }
}

function updateLastUpdated(iso) {
  const el = document.getElementById('lastUpdated');
  if (!iso) { el.textContent = '--'; return; }
  const d = new Date(iso);
  el.textContent = '업데이트: ' + d.toLocaleTimeString('ko-KR');
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
