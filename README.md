# NAS Port Dashboard 🚀

NAS에서 돌아가는 도커로, **주소 하나만 기억하면** 모든 서비스 포트를 한눈에 볼 수 있는 대시보드.

- Docker 소켓 직접 연결 → SSH 불필요
- `network_mode: host` → NAS 시스템 포트까지 전부 표시
- Docker 이벤트 실시간 감지 → 컨테이너 추가/삭제 자동 반영

---

## 🚀 NAS에 올리는 방법 (GitHub 추천)

### 방법 A: GitHub 경유 (추천)
```bash
# 1. NAS SSH 접속
ssh admin@192.168.1.x

# 2. 폴더 만들고 클론
mkdir -p /volume1/docker
cd /volume1/docker
git clone https://github.com/내계정/nas-port-dashboard.git
cd nas-port-dashboard

# 3. 바로 실행
docker compose up -d --build
```

이후 업데이트할 때:
```bash
cd /volume1/docker/nas-port-dashboard
git pull
docker compose up -d --build
```

### 방법 B: SCP로 직접 복사
```bash
# 맥에서 실행
scp -r /Users/jaewon/.gemini/antigravity/scratch/nas-port-dashboard \
    admin@192.168.1.x:/volume1/docker/

# NAS SSH 접속 후
cd /volume1/docker/nas-port-dashboard
docker compose up -d --build
```

---

## ⚙️ 포트 설정

`docker-compose.yml`에서 포트 번호만 바꾸면 됩니다:
```yaml
environment:
  - PORT=3001   # ← 이 숫자만 원하는 포트로
```

그러면 `http://NAS_IP:3001` 로 접속하면 끝.

---

## 🏗️ 작동 원리

```
NAS 위에서 Docker 컨테이너로 실행
│
├── /var/run/docker.sock (마운트)
│   └── Docker API → 컨테이너 목록 + 포트 + 실시간 이벤트
│
└── network_mode: host
    └── ss -tulpn → NAS 시스템 포트 전부 조회
```

SSH 없음. NAS 비밀번호 없음. `.env` 파일 없음.

---

## 📁 파일 구조

```
nas-port-dashboard/
├── Dockerfile
├── docker-compose.yml   ← 이것만 건드리면 됨
├── server.js
├── package.json
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

---

## 🔍 시놀로지 NAS 경로 참고

| 용도 | 경로 |
|------|------|
| Docker 파일 저장 | `/volume1/docker/` |
| Docker 소켓 | `/var/run/docker.sock` |
| SSH 접속 | `ssh admin@NAS_IP` |
