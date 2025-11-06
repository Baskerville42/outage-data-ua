#!/usr/bin/env bash
# Fetch upstream HTML for all regions (or a single region) using curl with browser-like headers.
# Mirrors the logic used in .github/workflows/scheduled.yml so you can test locally.
#
# Requirements:
#   - bash, curl
#   - jq (for JSON parsing)
#   - .env file in project root that defines REGION_SOURCES_JSON='{"region": "url", ...}'
#
# Usage:
#   scripts/fetch_regions.sh                # process all regions from REGION_SOURCES_JSON
#   scripts/fetch_regions.sh kyiv           # process only the 'kyiv' region
#   REGION=kyiv scripts/fetch_regions.sh    # same as above, using env var
#
# Exit code: always 0 (per-region failures are allowed and skipped)

set -u

PROJECT_ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$PROJECT_ROOT_DIR" || exit 1

# Ensure jq exists
if ! command -v jq >/dev/null 2>&1; then
  echo "[INFO] jq not found. Please install jq (e.g., brew install jq | apt-get install jq)" >&2
  exit 1
fi

# Load .env if present to populate REGION_SOURCES_JSON (and optionally REGION)
if [ -f .env ]; then
  # export variables defined in .env (supports multiline single-quoted JSON)
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

REGION_SOURCES_JSON=${REGION_SOURCES_JSON:-}
if [ -z "$REGION_SOURCES_JSON" ]; then
  echo "[ERROR] REGION_SOURCES_JSON is not set. Define it in .env or export it in your shell." >&2
  exit 1
fi

mkdir -p outputs

# Determine region selection
CLI_REGION=${1:-}
REGION=${REGION:-}
if [ -n "$CLI_REGION" ]; then
  REGIONS="$CLI_REGION"
elif [ -n "$REGION" ]; then
  REGIONS="$REGION"
else
  # list keys from the JSON map
  REGIONS=$(echo "$REGION_SOURCES_JSON" | jq -r 'keys[]')
fi

start_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[INFO] Started at $start_ts (UTC)"

total=0
ok=0

for r in $REGIONS; do
  total=$((total+1))
  url=$(echo "$REGION_SOURCES_JSON" | jq -r --arg r "$r" '.[$r] // empty')
  if [ -z "$url" ] || [ "$url" = "null" ]; then
    echo "[WARN] No URL configured for region '$r' — skipping"
    continue
  fi

  outfile="outputs/${r}.html"
  tmpfile="${outfile}.tmp"
  echo "[INFO] Fetching region='$r' url=$url"

  UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  CJ='outputs/cookies.txt'

  # Optional warm-up request to set initial cookies on the root domain
  domain=$(echo "$url" | sed -E 's#https?://([^/]+)/.*#\1#')
  if [ -n "$domain" ]; then
    curl --http2 --compressed --tlsv1.2 \
      -A "$UA" \
      -e 'https://www.google.com/' \
      -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' \
      -H 'Accept-Language: uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7' \
      -H 'Sec-CH-UA: "Google Chrome";v="128", "Chromium";v="128", ";Not A Brand";v="24"' \
      -H 'Sec-CH-UA-Mobile: ?0' \
      -H 'Sec-CH-UA-Platform: "Windows"' \
      -H 'Sec-Fetch-Dest: document' \
      -H 'Sec-Fetch-Mode: navigate' \
      -H 'Sec-Fetch-Site: none' \
      -H 'Sec-Fetch-User: ?1' \
      -H 'Upgrade-Insecure-Requests: 1' \
      -b "$CJ" -c "$CJ" \
      --silent --show-error --fail --location --max-time 60 \
      -o /dev/null "https://$domain" || true
  fi

  if curl --http2 --compressed --tlsv1.2 \
    --ciphers 'ECDHE+AESGCM:ECDHE+CHACHA20:HIGH:!aNULL:!MD5:!RC4' \
    -A "$UA" \
    -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' \
    -H 'Accept-Encoding: gzip, deflate, br, zstd' \
    -H 'Accept-Language: uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7' \
    -H 'Cache-Control: no-cache' \
    -H 'Pragma: no-cache' \
    -H 'Sec-CH-UA: "Google Chrome";v="128", "Chromium";v="128", ";Not A Brand";v="24"' \
    -H 'Sec-CH-UA-Mobile: ?0' \
    -H 'Sec-CH-UA-Platform: "Windows"' \
    -H 'Sec-Fetch-Dest: document' \
    -H 'Sec-Fetch-Mode: navigate' \
    -H 'Sec-Fetch-Site: none' \
    -H 'Sec-Fetch-User: ?1' \
    -H 'Upgrade-Insecure-Requests: 1' \
    -e 'https://www.google.com/' \
    --location \
    --silent --show-error --fail \
    --retry 3 --retry-connrefused --retry-delay 2 \
    --max-time 90 \
    -b "$CJ" -c "$CJ" \
    -D "${outfile}.headers" \
    -o "$tmpfile" \
    "$url"; then
    if [ -s "$tmpfile" ]; then
      # Quick WAF detection heuristics
      if grep -Eiq '(incapsula|imperva|_Incapsula_|cf-chl-|attention required|access denied)' "$tmpfile"; then
        echo "[WARN] Likely WAF/anti-bot page detected for '$r' — content may be unusable"
      fi
      mv -f "$tmpfile" "$outfile"
      echo "[OK] Saved $outfile ($(wc -c < "$outfile") bytes)"
      ok=$((ok+1))
    else
      echo "[WARN] Empty response for region '$r' — skipping"
      rm -f "$tmpfile"
    fi
  else
    code=$?
    echo "[WARN] curl failed for region '$r' (exit $code) — skipping"
    rm -f "$tmpfile" 2>/dev/null || true
    continue
  fi

done

echo "[INFO] Done. Regions processed: $total, successful: $ok, skipped: $((total-ok))"
# Always succeed overall; per-region failures are allowed.
exit 0
