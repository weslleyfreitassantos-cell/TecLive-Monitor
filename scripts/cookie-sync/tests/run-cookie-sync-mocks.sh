#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/cookie-sync/validate-and-promote-cookie.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

assert_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "Esperava falha: $*" >&2
    exit 1
  fi
}

mkdir -p "$TMP/project/cookies/incoming" "$TMP/project/cookies/archive" "$TMP/project/cookies/rejected" "$TMP/project/logs/cookie-sync" "$TMP/bin"

cat >"$TMP/bin/yt-dlp" <<'MOCK'
#!/usr/bin/env bash
url="${!#}"
if [[ "$url" == *"ended"* ]]; then
  echo "ERROR: This live event has ended." >&2
  exit 1
fi
echo '{"id":"mock"}'
exit 0
MOCK
chmod +x "$TMP/bin/yt-dlp"

cat >"$TMP/bin/pm2" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == "reload" ]]; then exit 0; fi
if [[ "$1" == "jlist" ]]; then
  echo '[{"name":"youtube-monitor-v3","pm2_env":{"status":"online"}}]'
  exit 0
fi
exit 0
MOCK
chmod +x "$TMP/bin/pm2"

cat >"$TMP/bin/flock" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$TMP/bin/flock"

cat >"$TMP/bin/node" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$TMP/bin/node"

export PATH="$TMP/bin:$PATH"
export COOKIE_SYNC_PROJECT_PATH="$TMP/project"
export COOKIE_SYNC_MIN_SIZE=10

cat >"$TMP/project/cookies/cookieStatus.json" <<'JSON'
{
  "cookie1.txt": { "state": "valid", "failCount": 0 }
}
JSON

cat >"$TMP/project/cookies/cookie1.txt" <<'COOKIE'
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	2147483647	old	value
COOKIE

cat >"$TMP/project/cookies/incoming/good.txt" <<'COOKIE'
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	2147483647	new	value
COOKIE

assert_fail "$SCRIPT" "bad.txt" "$TMP/project/cookies/incoming/good.txt"
assert_fail "$SCRIPT" "cookie1.txt" "../escape.txt"

ln -s "$TMP/project/cookies/incoming/good.txt" "$TMP/project/cookies/incoming/link.txt"
if [[ -L "$TMP/project/cookies/incoming/link.txt" ]]; then
  assert_fail "$SCRIPT" "cookie1.txt" "$TMP/project/cookies/incoming/link.txt"
else
  echo "Symlink real indisponivel neste ambiente; caso de symlink ignorado."
fi

cat >"$TMP/project/cookies/incoming/ended-only.txt" <<'COOKIE'
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	2147483647	new	value
COOKIE

export COOKIE_SYNC_TEST_URLS="https://example.invalid/ended"
if "$SCRIPT" "cookie1.txt" "$TMP/project/cookies/incoming/ended-only.txt" >/dev/null 2>&1; then
  echo "Validacao deveria falhar quando todas as URLs sao inadequadas" >&2
  exit 1
fi
grep -q 'Nenhuma URL de teste adequada disponível' "$TMP/project/logs/cookie-sync/cookie-sync.log"

cat >"$TMP/project/cookies/incoming/good.txt" <<'COOKIE'
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	2147483647	new	value
COOKIE

export COOKIE_SYNC_TEST_URLS="https://example.invalid/ended,https://example.invalid/good"
"$SCRIPT" "cookie1.txt" "$TMP/project/cookies/incoming/good.txt" >/dev/null

grep -q 'new' "$TMP/project/cookies/cookie1.txt"
find "$TMP/project/cookies/archive" -type f -name 'cookie1.txt.*.bak' | grep -q .
grep -q 'URL rejeitada (url_encerrada): https://example.invalid/ended' "$TMP/project/logs/cookie-sync/cookie-sync.log"
grep -q 'URL efetivamente usada na validacao: https://example.invalid/good' "$TMP/project/logs/cookie-sync/cookie-sync.log"

echo "Cookie Sync Bash mock tests OK"
