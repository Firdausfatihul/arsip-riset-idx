#!/bin/sh
# Every test in one command: python3 -B -m unittest, node --test tests/*.mjs and each DOM test tests/*.cjs.
# The site and Worker assets are built from needtobeindexed/ into a temp folder first (ARSIP_TEST_SITE /
# ARSIP_TEST_ASSETS), so a stale site/ or worker/.assets in the repo is never tested. The pinned DOM libraries are
# installed once into ARSIP_TEST_DEPS (default ~/.cache/arsip-test-deps). No secrets, network calls only for that install.
# Exit status is non-zero when anything fails.
set -u
cd "$(dirname "$0")/.." || exit 1
tmp=$(mktemp -d "${TMPDIR:-/tmp}/arsip-test.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT
deps=${ARSIP_TEST_DEPS:-$HOME/.cache/arsip-test-deps}
libs="jsdom@26.1.0 marked@15.0.7 dompurify@3.4.15"
# shellcheck disable=SC2086
npm ls --prefix "$deps" $libs >/dev/null 2>&1 ||
  npm install --prefix "$deps" --no-audit --no-fund --silent $libs || exit 1

echo "== build site + Worker assets -> $tmp"
CHAT_API_URL=/api/chat BASE_URL='' python3 -B build.py --out "$tmp/site" >"$tmp/build.log" 2>&1 &&
  python3 -B tools/build_worker.py --directory "$tmp/site" --out "$tmp/assets" >>"$tmp/build.log" 2>&1 ||
  { cat "$tmp/build.log"; exit 1; }
export ARSIP_TEST_SITE="$tmp/site" ARSIP_TEST_ASSETS="$tmp/assets" NODE_PATH="$deps/node_modules"

status=0
echo "== python"
python3 -B -m unittest discover -s tests -p 'test_*.py' || status=1
echo "== node --test"
node --test --test-reporter=dot tests/*.mjs || status=1
echo "== DOM"
for t in tests/*.cjs; do
  # Cloudflare runtime test (Miniflare); not part of the supported stack.
  [ "$t" = tests/worker_runtime.cjs ] && continue
  if node "$t" >"$tmp/dom.log" 2>&1; then echo "ok   $t"; else cat "$tmp/dom.log"; echo "FAIL $t"; status=1; fi
done
[ $status = 0 ] && echo "== all tests passed" || echo "== FAILED"
exit $status
