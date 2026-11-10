# ---------- Frontend build ----------
FROM node:20-alpine AS frontend-build

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# ---------- Runtime (nginx) ----------
FROM nginx:1.27-alpine

RUN apk add --no-cache curl

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/proxy_common.inc /etc/nginx/conf.d/proxy_common.inc
COPY --from=frontend-build /web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
