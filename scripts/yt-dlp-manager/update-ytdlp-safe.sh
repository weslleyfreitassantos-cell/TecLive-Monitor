#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_PATH="${YTDLP_PROJECT_PATH:-/var/www/livemonitor}"
ENV_FILE="$PROJECT_PATH/scripts/yt-dlp-manager/yt-dlp-manager.env"
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
PM2_PROCESS="${YTDLP_PM2_PROCESS:-youtube-monitor-v3}"
TIMEOUT_SECONDS="${YTDLP_TIMEOUT:-90}"
KEEP_BACKUPS="${YTDLP_KEEP_BACKUPS:-5}"
COOKIE_PATH="${YTDLP_COOKIE_PATH:-$PROJECT_PATH/cookies/cookie1.txt}"
LOG_DIR="$PROJECT_PATH/logs/yt-dlp-manager"
LOG_FILE="$LOG_DIR/update.log"
LOCK_FILE="$LOG_DIR/update.lock"
BACKUP_DIR="$PROJECT_PATH/scripts/yt-dlp-manager/backups"

CHECK_ONLY=0
DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    *) echo "Uso: $0 [--check-only] [--dry-run] [--force]" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR" "$BACKUP_DIR"
touch "$LOG_FILE"
chmod 700 "$LOG_DIR" "$BACKUP_DIR"
chmod 600 "$LOG_FILE"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "yt-dlp-manager: outra execucao esta em andamento" >&2
  exit 75
fi

log() {
  printf '%s %s\n' "$(date -Is)" "$1" | tee -a "$LOG_FILE"
}

die() {
  log "ERRO: $1"
  exit 1
}

load_test_urls() {
  local source="${YTDLP_TEST_URLS:-}"
  if [[ -z "$source" && -n "${YTDLP_TEST_URL:-}" ]]; then
    source="$YTDLP_TEST_URL"
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

detect_path() {
  command -v yt-dlp 2>/dev/null || true
}

detect_method() {
  local bin="$1"
  if command -v pipx >/dev/null 2>&1 && pipx list 2>/dev/null | grep -q 'package yt-dlp'; then
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

download_latest_standalone() {
  local dest="$1"
  local url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$dest" "$url"
  else
    return 1
  fi
}

run_functional_test() {
  local bin="$1"
  local base_args=(--simulate --dump-json --flat-playlist --playlist-end 1)
  if [[ -f "$COOKIE_PATH" ]]; then
    base_args=(--cookies "$COOKIE_PATH" "${base_args[@]}")
  fi

  local stderr_file stdout_file combined_file code test_url classification
  local total=0 unsuitable=0 auth=0 net_or_timeout=0 unknown=0
  for test_url in "${TEST_URLS[@]}"; do
    total=$((total + 1))
    stderr_file="$(mktemp)"
    stdout_file="$(mktemp)"
    combined_file="$(mktemp)"
    set +e
    timeout "$TIMEOUT_SECONDS" "$bin" "${base_args[@]}" "$test_url" >"$stdout_file" 2>"$stderr_file"
    code=$?
    set -e

    if (( code == 0 )); then
      rm -f -- "$stdout_file" "$stderr_file" "$combined_file"
      log "URL efetivamente usada no teste funcional: $test_url"
      return 0
    fi

    cat "$stderr_file" "$stdout_file" >"$combined_file"
    classification="$(classify_ytdlp_error "$code" "$combined_file")"
    log "URL rejeitada ($classification): $test_url"

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
    log "Falha desconhecida durante teste funcional."
    return 89
  fi
  log "Nenhuma URL de teste adequada disponível"
  return 86
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

rotate_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'yt-dlp.*.bak' -printf '%T@ %p\n' \
    | sort -rn \
    | awk -v keep="$KEEP_BACKUPS" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
    | while IFS= read -r old_backup; do
        rm -f -- "$old_backup"
      done
}

CHECK_SCRIPT="$PROJECT_PATH/scripts/yt-dlp-manager/check-ytdlp-update.sh"
load_test_urls
if [[ -x "$CHECK_SCRIPT" ]]; then
  "$CHECK_SCRIPT" || check_code=$?
  check_code="${check_code:-0}"
  if (( CHECK_ONLY )); then
    exit "$check_code"
  fi
else
  (( CHECK_ONLY )) && die "check-ytdlp-update.sh nao encontrado ou nao executavel"
fi

YTDLP_PATH="$(detect_path)"
[[ -n "$YTDLP_PATH" ]] || die "yt-dlp ausente"
INSTALLED_VERSION="$(yt-dlp --version)"
METHOD="$(detect_method "$YTDLP_PATH")"

if pgrep -x yt-dlp >/dev/null 2>&1 && (( ! FORCE )); then
  die "Ha processos yt-dlp ativos. Use --force apenas apos revisar a captura em andamento."
fi

log "Versao atual: $INSTALLED_VERSION"
log "Caminho: $YTDLP_PATH"
log "Metodo detectado: $METHOD"

if (( DRY_RUN )); then
  log "Dry-run: nenhuma alteracao sera feita."
  exit 0
fi

case "$METHOD" in
  standalone)
    tmp_new="$(mktemp)"
    backup="$BACKUP_DIR/yt-dlp.$(date +%Y%m%d-%H%M%S).bak"
    download_latest_standalone "$tmp_new" || die "Download da nova versao falhou"
    [[ -s "$tmp_new" ]] || die "Download incompleto"
    chmod +x "$tmp_new"
    "$tmp_new" --version >/dev/null || die "Novo binario nao executa"
    run_functional_test "$tmp_new" || die "Teste funcional com novo binario falhou"
    cp -p -- "$YTDLP_PATH" "$backup"
    sha256sum "$backup" >>"$LOG_FILE"
    mv -f -- "$tmp_new" "$YTDLP_PATH"
    chmod +x "$YTDLP_PATH"
    rotate_backups
    if ! run_functional_test "$YTDLP_PATH"; then
      cp -p -- "$backup" "$YTDLP_PATH"
      die "Teste pos-atualizacao falhou; backup restaurado"
    fi
    ;;
  pip)
    log "Comando de atualizacao pip: python3 -m pip install -U yt-dlp"
    python3 -m pip install -U yt-dlp >>"$LOG_FILE" 2>&1 || die "Atualizacao via pip falhou"
    ;;
  pipx)
    pipx upgrade yt-dlp >>"$LOG_FILE" 2>&1 || die "Atualizacao via pipx falhou"
    ;;
  apt)
    die "Instalacao via apt detectada. Atualizacao automatica por apt nao sera feita; revise manualmente."
    ;;
  *)
    die "Metodo de instalacao desconhecido; atualizacao recusada."
    ;;
esac

yt-dlp --version | tee -a "$LOG_FILE"
run_functional_test "$(detect_path)" || die "Teste final do yt-dlp falhou"

if ! pm2_reload_and_check; then
  if [[ -n "${backup:-}" && -f "$backup" ]]; then
    cp -p -- "$backup" "$YTDLP_PATH"
    pm2 reload "$PM2_PROCESS" --update-env >>"$LOG_FILE" 2>&1 || true
  fi
  die "PM2 nao voltou online apos atualizacao"
fi

log "Atualizacao segura concluida."
