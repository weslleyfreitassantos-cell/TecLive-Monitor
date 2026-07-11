#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECK="$REPO_ROOT/scripts/yt-dlp-manager/check-ytdlp-update.sh"
UPDATE="$REPO_ROOT/scripts/yt-dlp-manager/update-ytdlp-safe.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/project/scripts/yt-dlp-manager" "$TMP/project/logs/yt-dlp-manager" "$TMP/bin"
cp "$CHECK" "$TMP/project/scripts/yt-dlp-manager/check-ytdlp-update.sh"
chmod +x "$TMP/project/scripts/yt-dlp-manager/check-ytdlp-update.sh"

if PATH="$TMP/bin" "$CHECK" --quiet >/dev/null 2>&1; then
  echo "check deveria falhar sem yt-dlp" >&2
  exit 1
fi

cat >"$TMP/bin/yt-dlp" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "2026.07.04"; exit 0; fi
echo '{"id":"mock"}'
exit 0
MOCK
chmod +x "$TMP/bin/yt-dlp"

cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
echo '{"tag_name":"2026.07.04"}'
MOCK
chmod +x "$TMP/bin/curl"

cat >"$TMP/bin/pm2" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "jlist" ]]; then echo '[{"name":"youtube-monitor-v3","pm2_env":{"status":"online"}}]'; else exit 0; fi
MOCK
chmod +x "$TMP/bin/pm2"

cat >"$TMP/bin/flock" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$TMP/bin/flock"

PATH="$TMP/bin:$PATH" "$CHECK" --quiet
YTDLP_PROJECT_PATH="$TMP/project" PATH="$TMP/bin:$PATH" "$UPDATE" --dry-run >/dev/null
grep -q 'YTDLP_TEST_URLS' "$UPDATE"
grep -q 'Nenhuma URL de teste adequada disponível' "$UPDATE"
grep -q 'url_encerrada' "$UPDATE"

echo "yt-dlp manager Bash mock tests OK"
