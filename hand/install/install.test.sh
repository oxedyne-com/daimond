#!/usr/bin/env bash
#
# A bats-free check of install.sh's --dir / --profile / --check seam, run with
# plain bash. It is not install.sh's own --selftest (which covers the browser
# table and the workspace/journal machinery in general): this file exists
# because that seam broke in one specific, real shape -- a profile moved for
# CDP driving, whose directory the built-in BROWSERS table has no line for,
# and a binary installed with --dir somewhere other than hand/target/release
# -- and `install.sh --check` reported FAIL registration and FAIL binary on an
# install that was, in fact, correct. A regression there should fail here on
# its own, in well under a second, rather than waiting to be noticed by a
# person running --check for real.
#
# Builds a throwaway $HOME per case and points HOME at it for every install.sh
# invocation; nothing under the real $HOME is touched.
#
#	bash hand/install/install.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/install.sh"
HOST='com.oxedyne.daimond.hand'

# ~/.cache, not /tmp: /tmp is a tmpfs charged to whatever cgroup wrote it, and
# the fleet has been OOM-killed off it before.
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
BASE="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/daimond-hand-install-test.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

pass=0 fail=0 out='' status=0
check() {
	local name="$1" ok="$2" detail="${3:-}"
	if [ "$ok" = 1 ]; then
		pass=$((pass + 1)); printf '  ok    %s\n' "$name"
	else
		fail=$((fail + 1)); printf '  FAIL  %s%s\n' "$name" "${detail:+  -- $detail}"
	fi
}

# A throwaway $HOME holding a browser profile named the way a moved,
# CDP-driven profile is (see reference_argonaut_chrome_cdp_drive), which the
# BROWSERS table has no line for, and a "built" binary living somewhere other
# than hand/target -- the shape a --dir install actually leaves on disk.
fixture() {
	local name="$1"
	local h="$BASE/$name"
	mkdir -p "$h/.config/test-browser-cdp" "$h/.local/share/daimond/hand/bin" "$h/work"
	printf '#!/bin/sh\necho "daimond-hand 0.0.0-fixture"\n' \
		> "$h/.local/share/daimond/hand/bin/daimond-hand"
	chmod 755 "$h/.local/share/daimond/hand/bin/daimond-hand"
	echo "$h"
}

# Runs install.sh against a fixture's $HOME, with the other XDG variables and
# DAIMOND_HAND_JOURNAL_DIR cleared so nothing falls back to the real ones.
# Sets $out and $status rather than returning them, so a call reads like a
# statement: run_in "$h" --check ...; check '...' "$( ... "$out" ... )".
run_in() {
	local h="$1"; shift
	set +e
	out="$(HOME="$h" XDG_CONFIG_HOME= XDG_DATA_HOME= XDG_CACHE_HOME= \
		DAIMOND_HAND_JOURNAL_DIR= bash "$INSTALL" "$@" 2>&1)"
	status=$?
	set -e
}

echo "install.test.sh"

# ── --dir: install by naming the NativeMessagingHosts directory itself ──
h="$(fixture dir)"
BIN="$h/.local/share/daimond/hand/bin/daimond-hand"
NMH="$h/.config/test-browser-cdp/NativeMessagingHosts"

run_in "$h" --workspace "$h/work" --dir "$NMH" "$BIN"
check '--dir installs into a profile the table has no line for' \
	"$( [ "$status" = 0 ] && [ -f "$NMH/$HOST.json" ] && echo 1 || echo 0 )" \
	"exit $status"

run_in "$h" --check --dir "$NMH"
check '--check --dir passes on that install' \
	"$( [ "$status" = 0 ] && ! grep -q FAIL <<<"$out" && echo 1 || echo 0 )" \
	"$(grep FAIL <<<"$out" | tr '\n' ' ')"
check '--check --dir names the actual binary, not a guess under hand/target' \
	"$( grep -qF "$BIN" <<<"$out" && echo 1 || echo 0 )"

# ── --profile: install by naming the profile root, one level up ─────────
h="$(fixture profile)"
BIN="$h/.local/share/daimond/hand/bin/daimond-hand"
PROFILE="$h/.config/test-browser-cdp"

run_in "$h" --workspace "$h/work" --profile "$PROFILE" "$BIN"
check '--profile installs, given the profile root rather than NativeMessagingHosts' \
	"$( [ "$status" = 0 ] && [ -f "$PROFILE/NativeMessagingHosts/$HOST.json" ] && echo 1 || echo 0 )" \
	"exit $status"

run_in "$h" --check --profile "$PROFILE"
check '--check --profile passes on that install' \
	"$( [ "$status" = 0 ] && ! grep -q FAIL <<<"$out" && echo 1 || echo 0 )" \
	"$(grep FAIL <<<"$out" | tr '\n' ' ')"
check '--check --profile names the actual binary too' \
	"$( grep -qF "$BIN" <<<"$out" && echo 1 || echo 0 )"

# ── the bug this file guards against ─────────────────────────────────────
# A plain --check, not told where the profile moved to, cannot see it -- that
# was always true and stays true. What was wrong is that a --check told WHERE
# to look still failed; the two checks above are the ones that matter.
run_in "$h" --check
check 'a plain --check, not pointed at the moved profile, fails honestly rather than passing by accident' \
	"$( [ "$status" = 1 ] && grep -qE '^  FAIL  (browser|registration)' <<<"$out" && echo 1 || echo 0 )" \
	"exit $status"

echo
echo "  $pass passed, $fail failed"
[ "$fail" = 0 ]
