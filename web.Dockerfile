# ---------- Frontend build ----------
FROM node:20-alpine AS frontend-build

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

# ---------- Runtime (nginx) ----------
FROM nginx:1.27-alpine

RUN apk add --no-cache curl gettext

# The config is a template rendered by nginx's docker-entrypoint using
# API_HOST / API_PORT, so no rebuild is needed when the API port changes.
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/proxy_common.inc /etc/nginx/conf.d/proxy_common.inc
COPY --from=frontend-build /web/dist /usr/share/nginx/html

ENV API_HOST=api \
    API_PORT=8000

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1/healthz || exit 1

# The base image's entrypoint renders /etc/nginx/templates/*.template into
# /etc/nginx/conf.d/ using envsubst, then execs nginx.
CMD ["nginx", "-g", "daemon off;"]
