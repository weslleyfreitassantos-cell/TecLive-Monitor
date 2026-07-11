#!/usr/bin/env bash
set -Eeuo pipefail

MODE="human"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --json) MODE="json" ;;
    --human) MODE="human" ;;
    --quiet) QUIET=1 ;;
    *) echo "Uso: $0 [--json|--human] [--quiet]" >&2; exit 2 ;;
  esac
done

PROJECT_PATH="${HEALTH_PROJECT_PATH:-/var/www/livemonitor}"
PM2_PROCESS="${HEALTH_PM2_PROCESS:-youtube-monitor-v3}"
TEST_URL="${HEALTH_TEST_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"

RESULTS=()

add_result() {
  local name="$1" status="$2" detail="$3"
  RESULTS+=("$name|$status|$detail")
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '"%s"' "$value"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

check_cmd() {
  local cmd="$1"
  if has_cmd "$cmd"; then
    add_result "$cmd" "ok" "$(command -v "$cmd")"
  else
    add_result "$cmd" "fail" "ausente"
  fi
}

check_cmd node
check_cmd pm2
check_cmd yt-dlp
check_cmd ffmpeg

if [[ -d "$PROJECT_PATH" ]]; then
  add_result "project" "ok" "$PROJECT_PATH"
else
  add_result "project" "fail" "nao encontrado: $PROJECT_PATH"
fi

for cookie in cookie1.txt cookie2.txt cookie3.txt; do
  file="$PROJECT_PATH/cookies/$cookie"
  if [[ -f "$file" ]]; then
    size="$(stat -c '%s' "$file" 2>/dev/null || echo 0)"
    add_result "$cookie" "ok" "${size} bytes"
  else
    add_result "$cookie" "warn" "ausente"
  fi
done

status_file="$PROJECT_PATH/cookies/cookieStatus.json"
if [[ -f "$status_file" ]]; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$status_file" >/dev/null 2>&1; then
    add_result "cookieStatus.json" "ok" "json valido"
  else
    add_result "cookieStatus.json" "fail" "json invalido"
  fi
else
  add_result "cookieStatus.json" "warn" "ausente"
fi

disk_line="$(df -h "$PROJECT_PATH" 2>/dev/null | awk 'NR==2 {print $4 " livres de " $2}' || true)"
add_result "disk" "ok" "${disk_line:-indisponivel}"

mem_line="$(free -h 2>/dev/null | awk '/^Mem:/ {print $7 " disponivel de " $2}' || true)"
add_result "memory" "ok" "${mem_line:-indisponivel}"

if has_cmd yt-dlp; then
  version="$(yt-dlp --version 2>/dev/null || echo erro)"
  add_result "yt-dlp-version" "ok" "$version"
  if timeout 30 yt-dlp --simulate --dump-json --flat-playlist --playlist-end 1 "$TEST_URL" >/dev/null 2>&1; then
    add_result "youtube-access" "ok" "teste publico passou"
  else
    add_result "youtube-access" "warn" "teste publico falhou"
  fi
fi

if has_cmd pm2; then
  if pm2 jlist 2>/dev/null | node - "$PM2_PROCESS" <<'NODE'
const name = process.argv[2];
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  try {
    const list = JSON.parse(input);
    const proc = list.find((item) => item.name === name);
    process.exit(proc && proc.pm2_env && proc.pm2_env.status === 'online' ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
NODE
  then
    add_result "pm2-process" "ok" "$PM2_PROCESS online"
  else
    add_result "pm2-process" "fail" "$PM2_PROCESS nao esta online"
  fi
fi

if [[ -x "$PROJECT_PATH/scripts/yt-dlp-manager/check-ytdlp-update.sh" ]]; then
  set +e
  "$PROJECT_PATH/scripts/yt-dlp-manager/check-ytdlp-update.sh" --quiet
  code=$?
  set -e
  case "$code" in
    0) add_result "yt-dlp-update" "ok" "sem atualizacao" ;;
    10) add_result "yt-dlp-update" "warn" "atualizacao disponivel" ;;
    *) add_result "yt-dlp-update" "warn" "nao foi possivel verificar" ;;
  esac
else
  add_result "yt-dlp-update" "warn" "manager nao instalado"
fi

if [[ "$MODE" == "json" ]]; then
  printf '['
  first=1
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r name status detail <<<"$row"
    (( first )) || printf ','
    first=0
    printf '{"name":'
    json_string "$name"
    printf ',"status":'
    json_string "$status"
    printf ',"detail":'
    json_string "$detail"
    printf '}'
  done
  printf ']\n'
else
  if (( ! QUIET )); then
    for row in "${RESULTS[@]}"; do
      IFS='|' read -r name status detail <<<"$row"
      printf '%-24s %-6s %s\n' "$name" "$status" "$detail"
    done
  fi
fi

for row in "${RESULTS[@]}"; do
  IFS='|' read -r _ status _ <<<"$row"
  if [[ "$status" == "fail" ]]; then
    exit 1
  fi
done
exit 0
