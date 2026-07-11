#!/usr/bin/env bash
set -Eeuo pipefail

JSON=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --quiet) QUIET=1 ;;
    *) echo "Uso: $0 [--json] [--quiet]" >&2; exit 2 ;;
  esac
done

detect_path() {
  command -v yt-dlp 2>/dev/null || true
}

detect_method() {
  local bin="$1"
  if [[ -z "$bin" ]]; then
    echo "absent"
  elif command -v pipx >/dev/null 2>&1 && pipx list 2>/dev/null | grep -q 'package yt-dlp'; then
    echo "pipx"
  elif command -v python3 >/dev/null 2>&1 && python3 -m pip show yt-dlp >/dev/null 2>&1; then
    echo "pip"
  elif command -v dpkg >/dev/null 2>&1 && dpkg -S "$bin" >/dev/null 2>&1; then
    echo "apt"
  elif [[ -x "$bin" ]]; then
    echo "standalone"
  else
    echo "other"
  fi
}

latest_version() {
  local url="https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
  local body
  if command -v curl >/dev/null 2>&1; then
    body="$(curl -fsSL "$url")"
  elif command -v wget >/dev/null 2>&1; then
    body="$(wget -qO- "$url")"
  else
    echo ""
    return 1
  fi
  printf '%s' "$body" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1
}

YTDLP_PATH="$(detect_path)"
if [[ -z "$YTDLP_PATH" ]]; then
  if (( JSON )); then
    printf '{"ok":false,"error":"yt-dlp ausente"}\n'
  else
    echo "yt-dlp ausente" >&2
  fi
  exit 3
fi

INSTALLED_VERSION="$(yt-dlp --version 2>/dev/null || true)"
METHOD="$(detect_method "$YTDLP_PATH")"
AVAILABLE_VERSION="$(latest_version || true)"
if [[ -z "$AVAILABLE_VERSION" ]]; then
  if (( JSON )); then
    printf '{"ok":false,"path":"%s","installed":"%s","method":"%s","error":"nao foi possivel consultar versao disponivel"}\n' "$YTDLP_PATH" "$INSTALLED_VERSION" "$METHOD"
  else
    echo "Erro: nao foi possivel consultar versao disponivel." >&2
  fi
  exit 4
fi

UPDATE_AVAILABLE=0
if [[ "$INSTALLED_VERSION" != "$AVAILABLE_VERSION" ]]; then
  UPDATE_AVAILABLE=1
fi

if (( JSON )); then
  printf '{"ok":true,"path":"%s","installed":"%s","available":"%s","method":"%s","updateAvailable":%s}\n' \
    "$YTDLP_PATH" "$INSTALLED_VERSION" "$AVAILABLE_VERSION" "$METHOD" \
    "$(if (( UPDATE_AVAILABLE )); then echo true; else echo false; fi)"
elif (( ! QUIET )); then
  printf 'caminho=%s\nversao_instalada=%s\nversao_disponivel=%s\nmetodo=%s\natualizacao_disponivel=%s\n' \
    "$YTDLP_PATH" "$INSTALLED_VERSION" "$AVAILABLE_VERSION" "$METHOD" \
    "$(if (( UPDATE_AVAILABLE )); then echo sim; else echo nao; fi)"
fi

if (( UPDATE_AVAILABLE )); then
  exit 10
fi
exit 0
