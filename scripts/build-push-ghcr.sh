#!/usr/bin/env bash
# Build and push the ExamGuard images to GHCR from your own machine.
#
# Use this when GitHub Actions is unavailable (for example, a locked billing
# account). It produces the same images the workflow would:
#
#   ghcr.io/<owner>/exam-guard-api:latest
#   ghcr.io/<owner>/exam-guard-web:latest
#
# Usage:
#   GHCR_OWNER=heda312 GHCR_TOKEN=<PAT with write:packages> ./scripts/build-push-ghcr.sh
#   IMAGE_TAG=sha-abc1234 ./scripts/build-push-ghcr.sh     # custom tag
#   PLATFORMS=linux/amd64  ./scripts/build-push-ghcr.sh    # single arch (faster)
set -euo pipefail

OWNER="${GHCR_OWNER:-}"
TOKEN="${GHCR_TOKEN:-}"
TAG="${IMAGE_TAG:-latest}"
REGISTRY="${REGISTRY:-ghcr.io}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

fail() { echo "[FAIL] $*" >&2; exit 1; }

[ -n "$OWNER" ] || fail "GHCR_OWNER belum diset (contoh: GHCR_OWNER=heda312)"
[ -n "$TOKEN" ] || fail "GHCR_TOKEN belum diset (PAT dengan scope write:packages)"
command -v docker >/dev/null 2>&1 || fail "docker tidak ditemukan di PATH"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Login ke $REGISTRY sebagai $OWNER"
echo "$TOKEN" | docker login "$REGISTRY" -u "$OWNER" --password-stdin

API_IMAGE="$REGISTRY/$OWNER/exam-guard-api:$TAG"
WEB_IMAGE="$REGISTRY/$OWNER/exam-guard-web:$TAG"

docker buildx create --name examguard-builder --use >/dev/null 2>&1 || true
docker buildx inspect --bootstrap >/dev/null

echo "==> Build & push $API_IMAGE ($PLATFORMS)"
docker buildx build \
  --platform "$PLATFORMS" \
  --file Dockerfile \
  --tag "$API_IMAGE" \
  --push \
  .

echo "==> Build & push $WEB_IMAGE ($PLATFORMS)"
docker buildx build \
  --platform "$PLATFORMS" \
  --file web.Dockerfile \
  --tag "$WEB_IMAGE" \
  --push \
  .

echo
echo "[PASS] Image ter-push:"
echo "  $API_IMAGE"
echo "  $WEB_IMAGE"
echo
echo "Langkah berikutnya:"
echo "  1. GitHub -> Packages -> pilih package -> Package settings"
echo "     -> Change visibility (public) ATAU tambahkan credential di Portainer."
echo "  2. Portainer: Stacks -> Add stack -> paste deploy/portainer-stack.yml"
echo "     dengan IMAGE_TAG=$TAG"
