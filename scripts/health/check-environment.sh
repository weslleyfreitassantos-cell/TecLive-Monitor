#!/usr/bin/env bash
set -Eeuo pipefail

MODE="human"
QUIET=0
SELF_TEST=0
for arg in "$@"; do
  case "$arg" in
    --json) MODE="json" ;;
    --human) MODE="human" ;;
    --quiet) QUIET=1 ;;
    --self-test) SELF_TEST=1 ;;
    *) echo "Uso: $0 [--json|--human] [--quiet] [--self-test]" >&2; exit 2 ;;
  esac
done

PROJECT_PATH="${HEALTH_PROJECT_PATH:-/var/www/livemonitor}"
PM2_PROCESS="${HEALTH_PM2_PROCESS:-youtube-monitor-v3}"
TEST_URL="${HEALTH_TEST_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"

RESULTS=()

add_result() {
  local name="$1" status="$2" detail="$3" fields="${4:-}"
  if [[ -z "$fields" ]]; then
    fields="{}"
  fi
  RESULTS+=("$name|$status|$detail|$fields")
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

parse_pm2_jlist_file() {
  local process_name="$1" json_file="$2"
  node - "$process_name" "$json_file" <<'NODE'
const fs = require('fs');
const [processName, jsonFile] = process.argv.slice(2);

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function emit(status, detail, fields) {
  console.log(status);
  console.log(detail);
  console.log(JSON.stringify(fields));
}

let raw;
try {
  raw = fs.readFileSync(jsonFile, 'utf8');
} catch (error) {
  emit('fail', 'pm2 jlist falhou', {
    classification: 'jlist_failed',
    processName,
    error: error.message,
  });
  process.exit(0);
}

let list;
try {
  list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('pm2 jlist nao retornou uma lista');
} catch (error) {
  emit('fail', 'pm2 jlist JSON invalido', {
    classification: 'invalid_json',
    processName,
    error: error.message,
  });
  process.exit(0);
}

const proc = list.find((item) => item && item.name === processName);
if (!proc) {
  emit('fail', `${processName} nao encontrado`, {
    classification: 'not_found',
    processName,
    pm2Status: null,
    pid: null,
    uptime: null,
    cwd: null,
    scriptPath: null,
  });
  process.exit(0);
}

const env = proc.pm2_env || {};
const pm2Status = typeof env.status === 'string' ? env.status : 'unknown';
const pid = Number.isFinite(Number(proc.pid)) && Number(proc.pid) > 0 ? Number(proc.pid) : null;
const pmUptime = Number.isFinite(Number(env.pm_uptime)) ? Number(env.pm_uptime) : null;
const uptime = pmUptime ? formatUptime(Date.now() - pmUptime) : null;
const cwd = typeof env.pm_cwd === 'string' && env.pm_cwd ? env.pm_cwd : null;
const scriptPath = typeof env.pm_exec_path === 'string' && env.pm_exec_path ? env.pm_exec_path : null;
const classification = pm2Status === 'online'
  ? 'online'
  : (pm2Status === 'stopped' || pm2Status === 'errored' ? pm2Status : 'not_online');
const detailParts = [`${processName} ${pm2Status}`];
if (pid !== null) detailParts.push(`pid=${pid}`);
if (uptime) detailParts.push(`uptime=${uptime}`);
if (cwd) detailParts.push(`cwd=${cwd}`);
if (scriptPath) detailParts.push(`script=${scriptPath}`);

emit(pm2Status === 'online' ? 'ok' : 'fail', detailParts.join(' '), {
  classification,
  processName,
  pm2Status,
  pid,
  uptime,
  cwd,
  scriptPath,
});
NODE
}

check_pm2_process() {
  if ! has_cmd pm2; then
    add_result "pm2-process" "fail" "pm2 ausente" \
      "{\"classification\":\"pm2_missing\",\"processName\":\"$PM2_PROCESS\"}"
    return
  fi

  local jlist_file err_file code parsed_output
  jlist_file="$(mktemp)"
  err_file="$(mktemp)"
  set +e
  pm2 jlist >"$jlist_file" 2>"$err_file"
  code=$?
  set -e

  if (( code != 0 )); then
    rm -f -- "$jlist_file" "$err_file"
    add_result "pm2-process" "fail" "pm2 jlist falhou" \
      "{\"classification\":\"jlist_failed\",\"processName\":\"$PM2_PROCESS\",\"exitCode\":$code}"
    return
  fi

  parsed_output="$(parse_pm2_jlist_file "$PM2_PROCESS" "$jlist_file")"
  rm -f -- "$jlist_file" "$err_file"

  local parsed_lines=()
  mapfile -t parsed_lines <<<"$parsed_output"
  local parsed_fields="${parsed_lines[2]:-}"
  if [[ -z "$parsed_fields" ]]; then
    parsed_fields="{\"classification\":\"invalid_json\",\"processName\":\"$PM2_PROCESS\"}"
  fi
  add_result "pm2-process" "${parsed_lines[0]:-fail}" "${parsed_lines[1]:-pm2 jlist JSON invalido}" "$parsed_fields"
}

run_pm2_mock_tests() {
  local tmp expected_status expected_text output lines=()
  tmp="$(mktemp)"

  run_case() {
    local name="$1" json="$2" want_status="$3" want_text="$4"
    printf '%s' "$json" >"$tmp"
    output="$(parse_pm2_jlist_file "$PM2_PROCESS" "$tmp")"
    mapfile -t lines <<<"$output"
    if [[ "${lines[0]:-}" != "$want_status" || "${lines[1]:-}" != *"$want_text"* ]]; then
      echo "Mock PM2 falhou: $name" >&2
      echo "Esperado: $want_status / $want_text" >&2
      echo "Obtido: ${lines[0]:-} / ${lines[1]:-}" >&2
      rm -f -- "$tmp"
      exit 1
    fi
  }

  run_case "online" '[{"name":"youtube-monitor-v3","pid":1590219,"pm2_env":{"status":"online","pm_uptime":1000,"pm_cwd":"/var/www/livemonitor","pm_exec_path":"/var/www/livemonitor/app.js"}}]' "ok" "youtube-monitor-v3 online"
  run_case "stopped" '[{"name":"youtube-monitor-v3","pid":0,"pm2_env":{"status":"stopped","pm_cwd":"/var/www/livemonitor","pm_exec_path":"/var/www/livemonitor/app.js"}}]' "fail" "youtube-monitor-v3 stopped"
  run_case "errored" '[{"name":"youtube-monitor-v3","pid":0,"pm2_env":{"status":"errored","pm_cwd":"/var/www/livemonitor","pm_exec_path":"/var/www/livemonitor/app.js"}}]' "fail" "youtube-monitor-v3 errored"
  run_case "ausente" '[{"name":"outro-processo","pm2_env":{"status":"online"}}]' "fail" "youtube-monitor-v3 nao encontrado"
  run_case "json-invalido" '{invalid json' "fail" "pm2 jlist JSON invalido"

  rm -f -- "$tmp"
  echo "PM2 health mock tests OK"
}

if (( SELF_TEST )); then
  run_pm2_mock_tests
  exit 0
fi

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

check_pm2_process

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
    IFS='|' read -r name status detail fields <<<"$row"
    (( first )) || printf ','
    first=0
    printf '{"name":'
    json_string "$name"
    printf ',"status":'
    json_string "$status"
    printf ',"detail":'
    json_string "$detail"
    if [[ -z "${fields:-}" ]]; then
      fields="{}"
    fi
    printf ',"fields":%s' "$fields"
    printf '}'
  done
  printf ']\n'
else
  if (( ! QUIET )); then
    for row in "${RESULTS[@]}"; do
      IFS='|' read -r name status detail _ <<<"$row"
      printf '%-24s %-6s %s\n' "$name" "$status" "$detail"
    done
  fi
fi

for row in "${RESULTS[@]}"; do
  IFS='|' read -r _ status _ _ <<<"$row"
  if [[ "$status" == "fail" ]]; then
    exit 1
  fi
done
exit 0
