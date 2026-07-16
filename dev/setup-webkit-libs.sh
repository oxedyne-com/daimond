#!/usr/bin/env bash
# setup-webkit-libs.sh — make Playwright's WebKit runnable on an unsupported host.
#
# Playwright's WebKit binary (webkit-2311) is built for Ubuntu 24.04 (ICU 74),
# but this host is Ubuntu 25.10 (ICU 76), so `playwright install-deps webkit`
# fails on package names that no longer exist. We do NOT need root: we fetch the
# four genuinely-missing libraries from the 24.04 pool, extract just their .so
# files, and drop them into WebKit's own runtime lib dirs. libjxl/libwpe are
# already bundled by WebKit; only these four are missing on 25.10.
#
# Re-run this after any `playwright install webkit` (a reinstall wipes the copies).
# Then run the WebKit suite: node dev/verify_webkit.mjs
set -euo pipefail

WKROOT="$HOME/.cache/ms-playwright/webkit-2311"
STAGE="$HOME/webkit-libs"
POOL="http://archive.ubuntu.com/ubuntu/pool"

if [ ! -d "$WKROOT" ]; then
	echo "webkit-2311 not found — run: node ~/.red-pw/node_modules/playwright-core/cli.js install webkit"
	exit 1
fi

rm -rf "$STAGE/dl" "$STAGE/x" "$STAGE/lib"
mkdir -p "$STAGE/dl" "$STAGE/x" "$STAGE/lib"
cd "$STAGE/dl"

grab() {  # component pooldir debprefix
	local base="$POOL/$1/$2/"
	local deb
	deb=$(curl -s "$base" | grep -oE "${3}_[^\"]*_amd64\.deb" | sort -V | tail -1)
	[ -n "$deb" ] || { echo "  !! not found: $3"; return 1; }
	echo "  $deb"
	curl -s -O "$base$deb"
}

echo "Fetching the four libs 25.10 is missing (ICU 74, libxml2, libmanette, libwoff)…"
grab main     i/icu           libicu74
grab main     libx/libxml2    libxml2
grab universe libm/libmanette libmanette-0.2-0
grab main     w/woff2         libwoff1

for d in *.deb; do dpkg-deb -x "$d" "$STAGE/x/"; done
find "$STAGE/x" -name "*.so*" -exec cp -av {} "$STAGE/lib/" \; >/dev/null

echo "Placing libs into WebKit's runtime dirs…"
for d in minibrowser-wpe/lib minibrowser-wpe/sys/lib minibrowser-gtk/lib minibrowser-gtk/sys/lib; do
	[ -d "$WKROOT/$d" ] && cp -f "$STAGE"/lib/*.so* "$WKROOT/$d/"
done

echo "Done. WebKit needs PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 (verify_webkit.mjs sets it)."
