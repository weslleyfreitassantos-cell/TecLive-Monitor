#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_PATH="${COOKIE_SYNC_PROJECT_PATH:-/var/www/livemonitor}"
ENV_FILE="$PROJECT_PATH/scripts/cookie-sync/cookie-sync.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  . "$ENV_FILE"
fi

DEFAULT_TEST_URLS=(
  "https://www.youtube.com/watch?v=jNQXAC9IVRw"
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  "https://www.youtube.com/watch?v=M7lc1UVf-VE"
)
TEST_URLS=()
MIN_SIZE="${COOKIE_SYNC_MIN_SIZE:-1000}"
TIMEOUT_SECONDS="${COOKIE_SYNC_TIMEOUT:-60}"
PM2_PROCESS="${COOKIE_SYNC_PM2_PROCESS:-youtube-monitor-v3}"
KEEP_BACKUPS="${COOKIE_SYNC_KEEP_BACKUPS:-10}"
RELOAD_PM2="${COOKIE_SYNC_RELOAD_PM2:-0}"

COOKIES_DIR="$PROJECT_PATH/cookies"
INCOMING_DIR="$COOKIES_DIR/incoming"
ARCHIVE_DIR="$COOKIES_DIR/archive"
REJECTED_DIR="$COOKIES_DIR/rejected"
LOG_DIR="$PROJECT_PATH/logs/cookie-sync"
LOG_FILE="$LOG_DIR/cookie-sync.log"
LOCK_FILE="$LOG_DIR/cookie-sync.lock"

TARGET_COOKIE="${1:-}"
INCOMING_ARG="${2:-}"
INCOMING_REAL=""
BACKUP_PATH=""
PROMOTED_PATH=""

mkdir -p "$INCOMING_DIR" "$ARCHIVE_DIR" "$REJECTED_DIR" "$LOG_DIR"
touch "$LOG_FILE"
chmod 700 "$INCOMING_DIR" "$ARCHIVE_DIR" "$REJECTED_DIR" "$LOG_DIR"
chmod 600 "$LOG_FILE"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "cookie-sync: outra execucao esta em andamento" >&2
  exit 75
fi

log() {
  local msg="$1"
  printf '%s %s\n' "$(date -Is)" "$msg" | tee -a "$LOG_FILE"
}

die() {
  local msg="$1"
  log "ERRO: $msg"
  exit 1
}

safe_tail() {
  local file="$1"
  if [[ -f "$file" ]]; then
    tail -n 5 "$file" | sed -E 's/[[:space:]]+/ /g' | cut -c1-240 | tee -a "$LOG_FILE" || true
  fi
}

load_test_urls() {
  local source="${COOKIE_SYNC_TEST_URLS:-}"
  if [[ -z "$source" && -n "${COOKIE_SYNC_TEST_URL:-}" ]]; then
    source="$COOKIE_SYNC_TEST_URL"
  fi

  if [[ -z "$source" ]]; then
    TEST_URLS=("${DEFAULT_TEST_URLS[@]}")
  else
    IFS=',' read -r -a TEST_URLS <<<"$source"
  fi

  local cleaned=() url trimmed
  for url in "${TEST_URLS[@]}"; do
    trimmed="$(printf '%s' "$url" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    [[ -n "$trimmed" ]] && cleaned+=("$trimmed")
  done
  TEST_URLS=("${cleaned[@]}")

  if (( ${#TEST_URLS[@]} == 0 )); then
    die "Nenhuma URL de teste configurada"
  fi
}

classify_ytdlp_error() {
  local code="$1" combined_file="$2" text
  text="$(tr '\n' ' ' <"$combined_file" | tr '[:upper:]' '[:lower:]')"

  if (( code == 124 )) || [[ "$text" == *timeout* || "$text" == *"timed out"* ]]; then
    echo "timeout"
  elif [[ "$text" == *"private video"* || "$text" == *"this video is private"* || "$text" == *"video is private"* ]]; then
    echo "video_privado"
  elif [[ "$text" == *"has been removed"* || "$text" == *"removed by the uploader"* || "$text" == *"copyright claim"* || "$text" == *"copyright grounds"* || "$text" == *"copyright infringement"* ]]; then
    echo "video_removido"
  elif [[ "$text" == *"live event has ended"* || "$text" == *"this live event has ended"* || "$text" == *"not currently live"* || "$text" == *"premiere will begin"* || "$text" == *"premieres in"* || "$text" == *"post_live"* || "$text" == *"was_live"* ]]; then
    echo "url_encerrada"
  elif [[ "$text" == *"video unavailable"* || "$text" == *"this video is unavailable"* || "$text" == *"unavailable video"* || "$text" == *"not available in your country"* || "$text" == *"not available"* || "$text" == *"no video formats found"* || "$text" == *"requested format is not available"* ]]; then
    echo "video_indisponivel"
  elif [[ "$text" == *econnreset* || "$text" == *etimedout* || "$text" == *enotfound* || "$text" == *eai_again* || "$text" == *"socket hang up"* || "$text" == *"network is unreachable"* || "$text" == *"connection reset"* || "$text" == *"connection refused"* || "$text" == *"temporary failure"* || "$text" == *"tls connection"* || "$text" == *"http error 500"* || "$text" == *"http error 502"* || "$text" == *"http error 503"* || "$text" == *"http error 504"* ]]; then
    echo "rede"
  elif [[ "$text" == *"cookies are no longer valid"* || "$text" == *"cookie file is invalid"* || "$text" == *"invalid cookie"* || "$text" == *"invalid cookies"* || "$text" == *"use --cookies"* || "$text" == *"pass cookies"* || "$text" == *"login required"* || "$text" == *"authentication required"* || "$text" == *"requires authentication"* || "$text" == *"sign in to confirm"* || "$text" == *"sign in to verify"* || "$text" == *"not a bot"* || "$text" == *"protect our community"* || "$text" == *"confirm you're not a bot"* ]]; then
    echo "autenticacao_cookie"
  else
    echo "desconhecido"
  fi
}

is_unsuitable_url() {
  case "$1" in
    url_encerrada|video_privado|video_removido|video_indisponivel) return 0 ;;
    *) return 1 ;;
  esac
}

reject_incoming() {
  local reason="$1"
  if [[ -n "${INCOMING_REAL:-}" && -f "$INCOMING_REAL" ]]; then
    local base ts dest
    base="$(basename -- "$INCOMING_REAL")"
    ts="$(date +%Y%m%d-%H%M%S)"
    dest="$REJECTED_DIR/$ts-$base.rejected"
    mv -- "$INCOMING_REAL" "$dest" || true
    chmod 600 "$dest" 2>/dev/null || true
    log "Arquivo recebido movido para rejected: $(basename -- "$dest") ($reason)"
  fi
}

rollback() {
  local reason="$1"
  log "Rollback solicitado: $reason"
  if [[ -n "$BACKUP_PATH" && -f "$BACKUP_PATH" ]]; then
    cp -p -- "$BACKUP_PATH" "$PROMOTED_PATH"
    chmod 600 "$PROMOTED_PATH"
    log "Backup restaurado: $(basename -- "$BACKUP_PATH")"
  elif [[ -n "$PROMOTED_PATH" && -f "$PROMOTED_PATH" ]]; then
    rm -f -- "$PROMOTED_PATH"
    log "Cookie promovido removido porque nao havia backup anterior."
  fi
}

validate_target() {
  case "$TARGET_COOKIE" in
    cookie1.txt|cookie2.txt|cookie3.txt) ;;
    *) die "TARGET_COOKIE invalido: use cookie1.txt, cookie2.txt ou cookie3.txt" ;;
  esac
  if [[ "$TARGET_COOKIE" == *"/"* || "$TARGET_COOKIE" == *".."* || "$TARGET_COOKIE" = /* ]]; then
    die "TARGET_COOKIE rejeitado por seguranca"
  fi
}

resolve_incoming() {
  [[ -n "$INCOMING_ARG" ]] || die "INCOMING_FILE ausente"
  [[ "$INCOMING_ARG" != *".."* ]] || die "INCOMING_FILE rejeitado por path traversal"

  local candidate
  if [[ "$INCOMING_ARG" = /* ]]; then
    candidate="$INCOMING_ARG"
  else
    candidate="$INCOMING_DIR/$INCOMING_ARG"
  fi

  [[ -e "$candidate" ]] || die "Arquivo incoming inexistente"
  [[ ! -L "$candidate" ]] || die "Arquivo incoming e symlink; rejeitado"

  local incoming_root
  incoming_root="$(readlink -f -- "$INCOMING_DIR")"
  INCOMING_REAL="$(readlink -f -- "$candidate")"
  case "$INCOMING_REAL" in
    "$incoming_root"/*) ;;
    *) die "Arquivo incoming fora do diretorio permitido" ;;
  esac
}

validate_cookie_file() {
  local file="$1"
  [[ -f "$file" ]] || die "Cookie nao e arquivo regular"
  [[ ! -L "$file" ]] || die "Cookie e symlink; rejeitado"

  local size
  size="$(stat -c '%s' -- "$file")"
  [[ "$size" =~ ^[0-9]+$ ]] || die "Tamanho do cookie invalido"
  (( size >= MIN_SIZE )) || die "Cookie pequeno demais: ${size} bytes"

  head -n 1 -- "$file" | grep -q 'Netscape' || die "Cookie sem cabecalho Netscape"
  grep -Eq 'youtube\.com|google\.com' -- "$file" || die "Cookie sem dominio youtube.com ou google.com"
  chmod 600 "$file"
}

run_ytdlp_test() {
  local cookie_file="$1"
  local stderr_file stdout_file combined_file code test_url classification
  local total=0 unsuitable=0 auth=0 net_or_timeout=0 unknown=0

  for test_url in "${TEST_URLS[@]}"; do
    total=$((total + 1))
    stderr_file="$(mktemp)"
    stdout_file="$(mktemp)"
    combined_file="$(mktemp)"
    set +e
    timeout "$TIMEOUT_SECONDS" yt-dlp \
      --cookies "$cookie_file" \
      --simulate \
      --dump-json \
      --flat-playlist \
      --playlist-end 1 \
      "$test_url" >"$stdout_file" 2>"$stderr_file"
    code=$?
    set -e

    if (( code == 0 )); then
      rm -f -- "$stdout_file" "$stderr_file" "$combined_file"
      log "URL efetivamente usada na validacao: $test_url"
      return 0
    fi

    cat "$stderr_file" "$stdout_file" >"$combined_file"
    classification="$(classify_ytdlp_error "$code" "$combined_file")"
    log "URL rejeitada ($classification): $test_url"
    safe_tail "$stderr_file"

    if is_unsuitable_url "$classification"; then
      unsuitable=$((unsuitable + 1))
    elif [[ "$classification" == "autenticacao_cookie" ]]; then
      auth=1
    elif [[ "$classification" == "rede" || "$classification" == "timeout" ]]; then
      net_or_timeout=1
    else
      unknown=1
    fi

    rm -f -- "$stdout_file" "$stderr_file" "$combined_file"
  done

  if (( total > 0 && unsuitable == total )); then
    log "Nenhuma URL de teste adequada disponível"
    return 86
  fi
  if (( auth )); then
    log "Falha classificada como autenticacao/cookie."
    return 87
  fi
  if (( net_or_timeout )); then
    log "Falha nao relacionada a cookie: rede ou timeout."
    return 88
  fi
  if (( unknown )); then
    log "Falha desconhecida durante validacao por yt-dlp."
    return 89
  fi
  log "Nenhuma URL de teste adequada disponível"
  return 86
}

create_backup() {
  local target_path="$1"
  if [[ -f "$target_path" ]]; then
    local ts
    ts="$(date +%Y%m%d-%H%M%S)"
    BACKUP_PATH="$ARCHIVE_DIR/$TARGET_COOKIE.$ts.bak"
    cp -p -- "$target_path" "$BACKUP_PATH"
    chmod 600 "$BACKUP_PATH"
    log "Backup criado: $(basename -- "$BACKUP_PATH")"
  else
    BACKUP_PATH=""
    log "Cookie atual nao existe; nenhum backup criado."
  fi

  find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "$TARGET_COOKIE.*.bak" -printf '%T@ %p\n' \
    | sort -rn \
    | awk -v keep="$KEEP_BACKUPS" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
    | while IFS= read -r old_backup; do
        rm -f -- "$old_backup"
      done
}

promote_cookie() {
  PROMOTED_PATH="$COOKIES_DIR/$TARGET_COOKIE"
  local tmp_path owner_group
  tmp_path="$COOKIES_DIR/.$TARGET_COOKIE.promote.$$"

  if [[ -f "$PROMOTED_PATH" ]]; then
    owner_group="$(stat -c '%u:%g' -- "$PROMOTED_PATH")"
  else
    owner_group="$(id -u):$(id -g)"
  fi

  create_backup "$PROMOTED_PATH"
  cp -- "$INCOMING_REAL" "$tmp_path"
  chmod 600 "$tmp_path"
  chown "$owner_group" "$tmp_path"
  mv -f -- "$tmp_path" "$PROMOTED_PATH"
  log "Cookie promovido atomicamente para $TARGET_COOKIE"
}

pm2_reload_and_check() {
  pm2 reload "$PM2_PROCESS" --update-env >>"$LOG_FILE" 2>&1 || return 1
  sleep 5
  node - "$PM2_PROCESS" <<'NODE'
const processName = process.argv[2];
const { execFileSync } = require('child_process');
const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8' }));
const proc = list.find((item) => item.name === processName);
if (!proc || !proc.pm2_env || proc.pm2_env.status !== 'online') process.exit(1);
NODE
}

should_reload_pm2() {
  case "$(printf '%s' "$RELOAD_PM2" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|sim) return 0 ;;
    *) return 1 ;;
  esac
}

mark_cookie_status_promoted() {
  local status_file="$COOKIES_DIR/cookieStatus.json"
  node - "$status_file" "$TARGET_COOKIE" <<'NODE'
const fs = require('fs');
const path = require('path');
const [statusFile, targetCookie] = process.argv.slice(2);
let data = {};
try {
  if (fs.existsSync(statusFile)) {
    data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  }
} catch (_) {
  data = {};
}

const now = new Date().toISOString();
const current = data[targetCookie] && typeof data[targetCookie] === 'object'
  ? data[targetCookie]
  : {};

data[targetCookie] = {
  ...current,
  state: 'valid',
  authValid: true,
  extractionValid: true,
  streamValid: true,
  failCount: 0,
  lastFailure: null,
  lastSuccess: now,
  lastExtractionCheck: now,
  lastExtractionFailure: null,
  lastProbeAt: now,
  lastProbeVideoId: current.lastProbeVideoId || null,
  consecutiveStreamFailures: 0,
  streamFailureVideoIds: [],
  metadataValid: true,
  formatsValid: null,
  hlsValid: false,
  streamProbeStatus: 'inconclusive',
  extractionClassification: null,
  reason: null,
  alertActive: false
};

const dir = path.dirname(statusFile);
fs.mkdirSync(dir, { recursive: true });
const tmp = path.join(dir, `.${path.basename(statusFile)}.${process.pid}.${Date.now()}.tmp`);
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
fs.renameSync(tmp, statusFile);
NODE
}

cookie_status_ok() {
  local status_file="$COOKIES_DIR/cookieStatus.json"
  [[ -f "$status_file" ]] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg key "$TARGET_COOKIE" '.[$key].state == "valid" and (.[$key].failCount // 0) == 0' "$status_file" >/dev/null
  else
    node - "$status_file" "$TARGET_COOKIE" <<'NODE'
const fs = require('fs');
const [file, key] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!data[key] || data[key].state !== 'valid' || Number(data[key].failCount || 0) !== 0) process.exit(1);
NODE
  fi
}

wait_for_cookie_status() {
  local i
  for i in $(seq 1 30); do
    if cookie_status_ok; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if (( $# != 2 )); then
  die "Uso: validate-and-promote-cookie.sh TARGET_COOKIE INCOMING_FILE"
fi

validate_target
resolve_incoming
validate_cookie_file "$INCOMING_REAL"
load_test_urls

log "Iniciando validacao de $TARGET_COOKIE recebido em incoming."
if ! run_ytdlp_test "$INCOMING_REAL"; then
  reject_incoming "validacao inicial falhou"
  exit 1
fi

promote_cookie
if ! run_ytdlp_test "$PROMOTED_PATH"; then
  rollback "teste final do cookie promovido falhou"
  reject_incoming "teste final falhou"
  exit 1
fi

rm -f -- "$INCOMING_REAL"
mark_cookie_status_promoted

PM2_RESULT="nao_recarregado"
if should_reload_pm2; then
  if ! pm2_reload_and_check; then
    rollback "PM2 nao retornou online"
    pm2 reload "$PM2_PROCESS" --update-env >>"$LOG_FILE" 2>&1 || true
    exit 1
  fi
  PM2_RESULT="$PM2_PROCESS"
  log "PM2 online: $PM2_PROCESS"
else
  log "PM2 reload ignorado (COOKIE_SYNC_RELOAD_PM2=${RELOAD_PM2}); cookie sera usado sem reiniciar o app."
fi

if ! wait_for_cookie_status; then
  log "cookieStatus.json nao voltou para valid/failCount=0 dentro de 30s. Logs resumidos:"
  safe_tail "$LOG_FILE"
  rollback "cookieStatus.json nao confirmou revalidacao"
  if should_reload_pm2; then
    pm2 reload "$PM2_PROCESS" --update-env >>"$LOG_FILE" 2>&1 || true
  fi
  exit 1
fi

log "Cookie promovido: $TARGET_COOKIE"
log "Backup criado: ${BACKUP_PATH:-nenhum}"
log "Status persistido: valid, failCount=0, streamProbeStatus=inconclusive"

printf 'cookie=%s\nbackup=%s\npm2=%s\nstatus=valid failCount=0\n' \
  "$TARGET_COOKIE" "${BACKUP_PATH:-nenhum}" "$PM2_RESULT"
