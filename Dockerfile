FROM node:20-alpine

# iproute2 = ss 명령어 (시스템 포트 조회용)
RUN apk add --no-cache iproute2

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
