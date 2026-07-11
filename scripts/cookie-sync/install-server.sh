#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_PATH="${COOKIE_SYNC_PROJECT_PATH:-/var/www/livemonitor}"
REQUIRED_COMMANDS=(node yt-dlp pm2 flock timeout sha256sum)

if (( EUID != 0 )); then
  echo "Execute como root." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "Projeto nao encontrado: $PROJECT_PATH" >&2
  exit 1
fi

missing=()
for cmd in "${REQUIRED_COMMANDS[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  missing+=("curl ou wget")
fi

if (( ${#missing[@]} > 0 )); then
  echo "Dependencias ausentes: ${missing[*]}" >&2
  echo "Instale manualmente. Sugestoes:" >&2
  echo "  apt update" >&2
  echo "  apt install -y nodejs npm curl util-linux coreutils" >&2
  echo "  npm install -g pm2" >&2
  echo "  instale yt-dlp pelo metodo escolhido e revise o caminho" >&2
  exit 1
fi

mkdir -p \
  "$PROJECT_PATH/cookies/incoming" \
  "$PROJECT_PATH/cookies/archive" \
  "$PROJECT_PATH/cookies/rejected" \
  "$PROJECT_PATH/logs/cookie-sync"

chmod 700 \
  "$PROJECT_PATH/cookies/incoming" \
  "$PROJECT_PATH/cookies/archive" \
  "$PROJECT_PATH/cookies/rejected" \
  "$PROJECT_PATH/logs/cookie-sync"

chmod +x "$PROJECT_PATH/scripts/cookie-sync/validate-and-promote-cookie.sh"

echo "Instalacao controlada concluida."
echo "Nenhum firewall, SSH, Nginx, PM2, cron ou systemd foi alterado."
