#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_PATH="${YTDLP_PROJECT_PATH:-/var/www/livemonitor}"

if (( EUID != 0 )); then
  echo "Execute como root." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "Projeto nao encontrado: $PROJECT_PATH" >&2
  exit 1
fi

missing=()
for cmd in node yt-dlp pm2 flock timeout sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  missing+=("curl ou wget")
fi

if (( ${#missing[@]} > 0 )); then
  echo "Dependencias ausentes: ${missing[*]}" >&2
  echo "Instale manualmente antes de usar o manager." >&2
  exit 1
fi

mkdir -p "$PROJECT_PATH/logs/yt-dlp-manager" "$PROJECT_PATH/scripts/yt-dlp-manager/backups"
chmod 700 "$PROJECT_PATH/logs/yt-dlp-manager" "$PROJECT_PATH/scripts/yt-dlp-manager/backups"
chmod +x \
  "$PROJECT_PATH/scripts/yt-dlp-manager/check-ytdlp-update.sh" \
  "$PROJECT_PATH/scripts/yt-dlp-manager/update-ytdlp-safe.sh"

echo "yt-dlp manager instalado sem agendamentos e sem alterar PM2."
