#!/usr/bin/env bash
# Builds dist/ad-break-mute-<version>.zip from extension/, ready to attach to a GitHub release.
# The zip contains one folder, ad-break-mute/, with manifest.json at its top.
#
# Analytics: if a file named .analytics-url exists at the repo root (it's gitignored), its URL is written into the
# zip's config.js. The copy of config.js in git always stays empty, so the URL never lands in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
out="dist/ad-break-mute-${version}.zip"
rm -rf dist/ad-break-mute "$out"
mkdir -p dist
cp -R extension dist/ad-break-mute

if [[ -f .analytics-url ]]; then
  url=$(tr -d '[:space:]' < .analytics-url)
  if [[ ! "$url" =~ ^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$ ]]; then
    echo "error: .analytics-url doesn't look like an Apps Script web app URL (https://script.google.com/macros/s/…/exec)" >&2
    exit 1
  fi
  python3 - "$url" <<'PY'
import re, sys
p = 'dist/ad-break-mute/config.js'
s = open(p).read()
s, n = re.subn(r"const ANALYTICS_URL = '[^']*';", f"const ANALYTICS_URL = '{sys.argv[1]}';", s)
assert n == 1, 'ANALYTICS_URL line not found in config.js'
open(p, 'w').write(s)
PY
  echo "analytics: on (URL from .analytics-url)"
else
  echo "analytics: off (no .analytics-url file)"
fi

(cd dist && zip -rq "ad-break-mute-${version}.zip" ad-break-mute -x '*.DS_Store')
rm -rf dist/ad-break-mute
echo "$out"
