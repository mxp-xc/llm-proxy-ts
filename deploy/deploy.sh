#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_DIR="${LLM_PROXY_REPO_DIR:-/srv/projects/github.com/mxp-xc/llm-proxy-ts}"
readonly BUN_BIN="${LLM_PROXY_BUN_BIN:-/root/.bun/bin/bun}"
readonly SERVICE_NAME="${LLM_PROXY_SERVICE_NAME:-llm-proxy.service}"
readonly HEALTH_URL="${LLM_PROXY_HEALTH_URL:-http://127.0.0.1:8056/health}"

log_error() {
  local status=$1
  local line=$2
  local command=$3
  printf 'deployment error: status=%s line=%s command=%q\n' \
    "$status" "$line" "$command" >&2
  return "$status"
}
trap 'log_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

cd "$REPO_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  printf 'tracked server files are modified; refusing to deploy\n' >&2
  exit 1
fi

timeout 120 git fetch origin
git switch main
timeout 120 git pull --ff-only origin main

"$BUN_BIN" install --frozen-lockfile

systemctl restart "$SERVICE_NAME"

for ((attempt = 1; attempt <= 60; attempt += 1)); do
  if systemctl is-active --quiet "$SERVICE_NAME" \
    && curl \
      --fail \
      --silent \
      --show-error \
      --max-time 3 \
      "$HEALTH_URL" \
      >/dev/null; then
    printf 'llm-proxy deployment healthy\n'
    exit 0
  fi
  sleep 2
done

printf 'llm-proxy health check timed out: %s\n' "$HEALTH_URL" >&2
systemctl status "$SERVICE_NAME" --no-pager >&2 || true
journalctl -u "$SERVICE_NAME" -n 100 --no-pager >&2 || true
exit 1
