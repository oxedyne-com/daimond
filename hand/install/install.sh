#!/usr/bin/env bash
#
# Registers Daimond's machine hand with the browsers on this machine, and does
# the two small setup steps that used to be typed by hand.
#
# This one small file in one per-browser directory is the whole cost of the
# design. A web page cannot create a process, so the capability lives in a
# program outside the page, and Chrome will only connect that program to an
# extension the program itself names. Naming it is what this script does. There
# is no port, no daemon and no secret -- and the price of having none of those
# is that a file has to be written by hand, once, per browser.
#
# It writes JSON. It builds nothing, downloads nothing, starts nothing, and
# needs no root for the per-user directories it uses.
#
#	./install.sh                       # find the built binary, register it
#	./install.sh --workspace ~/work    # ...and grant that folder, in the same run
#	./install.sh --remote              # ...and set up the ssh a Terminal may use
#	./install.sh --check               # diagnose an install, changing nothing
#	./install.sh /path/to/daimond-hand # register a particular binary
#	./install.sh --dir /some/profile/NativeMessagingHosts /path/to/binary
#	./install.sh --list                # say what it would write, and where
#	./install.sh --selftest            # run this script's own tests
#
# --workspace does what step 2 of install/README.md used to ask you to type: it
# creates the journal directory at mode 700 and writes the granted folder into
# `root.txt` beside it. Which folder to grant is still yours to choose, and so
# is the approval in the browser -- those are decisions and stay explicit.
#
# The extension id is pinned by the public key in ext/manifest.json, so it is
# the same in every browser and on every machine. Override it with
# DAIMOND_HAND_EXT_ID only if you are loading a build whose key you changed.

set -euo pipefail

HOST='com.oxedyne.daimond.hand'
EXT_ID="${DAIMOND_HAND_EXT_ID:-mpliijponglmmffjnonahhignkpkhmij}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# ── Where each browser looks ─────────────────────────────────────────
#
# LINUX (implemented). Per user, under the browser's own configuration root,
# which is also its default user-data-dir. A browser started with an explicit
# --user-data-dir reads <that dir>/NativeMessagingHosts instead, which is what
# --dir is for.
#
# System-wide equivalents, for a machine where every account should have it:
#	/etc/opt/chrome/native-messaging-hosts/
#	/etc/chromium/native-messaging-hosts/
#	/etc/opt/edge/native-messaging-hosts/
#	/etc/brave/native-messaging-hosts/
# Note the different spelling: system directories are lower case and hyphenated,
# per-user ones are CamelCase. That is Chrome's own inconsistency, not ours.
#
# MACOS (not implemented yet; the paths are here so they are not rediscovered).
#	~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
#	~/Library/Application Support/Chromium/NativeMessagingHosts/
#	~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/
#	~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/
#	system-wide: /Library/Google/Chrome/NativeMessagingHosts/
# The file format is identical; only the directory differs. macOS also requires
# the binary to be signed and notarised before Gatekeeper will run it from a
# browser, which is a packaging job, not a path.
#
# WINDOWS (not implemented yet). There is no directory: the manifest is found
# through the registry, and the manifest file itself may live anywhere.
#	HKCU\Software\Google\Chrome\NativeMessagingHosts\com.oxedyne.daimond.hand
#	HKCU\Software\Chromium\NativeMessagingHosts\com.oxedyne.daimond.hand
#	HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.oxedyne.daimond.hand
#	HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.oxedyne.daimond.hand
# The key's DEFAULT value is the absolute path to the .json file. Use HKLM for a
# machine-wide install. "path" inside the manifest must then be either absolute
# or relative to the manifest's own directory.

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
SNAP="$HOME/snap"
FLAT="$HOME/.var/app"

# Label, packaging, then the browser's profile root. The native messaging
# directory is that root with NativeMessagingHosts on the end.
#
# The packaging field is the reason this table grew. A snap or a flatpak browser
# is CONFINED, and the confinement reaches the programs it starts: the hand
# inherits it, and cannot open the hidden directories in $HOME where it keeps
# its record. Registering the host in such a profile succeeds and then produces
# a hand that exits before it can say why -- so these entries exist to be found
# and refused, not to be written into.
#
# Snap arranges itself two ways and both are here. The chromium snap sets its
# own --user-data-dir under `common`; the others get a remapped HOME, so their
# profile is the ordinary path with ~/snap/<pkg>/current in front of it.
# Flatpak redirects XDG_CONFIG_HOME to ~/.var/app/<id>/config, so a flatpak
# profile is the ordinary path with that in front of it.
BROWSERS=(
	"Google Chrome|deb|$CONFIG/google-chrome"
	"Google Chrome Beta|deb|$CONFIG/google-chrome-beta"
	"Google Chrome Dev|deb|$CONFIG/google-chrome-unstable"
	"Chromium|deb|$CONFIG/chromium"
	"Brave|deb|$CONFIG/BraveSoftware/Brave-Browser"
	"Brave Beta|deb|$CONFIG/BraveSoftware/Brave-Browser-Beta"
	"Microsoft Edge|deb|$CONFIG/microsoft-edge"
	"Vivaldi|deb|$CONFIG/vivaldi"
	"Opera|deb|$CONFIG/opera"

	"Chromium (snap)|snap|$SNAP/chromium/common/chromium"
	"Chromium (snap)|snap|$SNAP/chromium/current/.config/chromium"
	"Brave (snap)|snap|$SNAP/brave/current/.config/BraveSoftware/Brave-Browser"
	"Vivaldi (snap)|snap|$SNAP/vivaldi/current/.config/vivaldi"
	"Opera (snap)|snap|$SNAP/opera/current/.config/opera"
	"Chromium (snap)|snap|$SNAP/chromium-mir-kiosk/common/chromium"

	"Chromium (flatpak)|flatpak|$FLAT/org.chromium.Chromium/config/chromium"
	"Google Chrome (flatpak)|flatpak|$FLAT/com.google.Chrome/config/google-chrome"
	"Brave (flatpak)|flatpak|$FLAT/com.brave.Browser/config/BraveSoftware/Brave-Browser"
	"Microsoft Edge (flatpak)|flatpak|$FLAT/com.microsoft.Edge/config/microsoft-edge"
	"Vivaldi (flatpak)|flatpak|$FLAT/com.vivaldi.Vivaldi/config/vivaldi"
	"Opera (flatpak)|flatpak|$FLAT/com.opera.Opera/config/opera"
	"Ungoogled Chromium (flatpak)|flatpak|$FLAT/io.github.ungoogled_software.ungoogled_chromium/config/chromium"
)

# Where the hand keeps its record, spelled exactly as `journal::default_dir`
# spells it. If these two ever disagree, the script writes `root.txt` somewhere
# the hand will not look, which is a silent failure -- so this line is the one
# to change when that one changes.
JDIR="${DAIMOND_HAND_JOURNAL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/daimond/hand/journal}"

# ── Arguments ────────────────────────────────────────────────────────

ONLY_DIR=''
LIST_ONLY=0
CHECK_ONLY=0
PATHS_ONLY=0
WORKSPACE=''
BINARY=''
REMOTE=0

while [ $# -gt 0 ]; do
	case "$1" in
	--dir)	ONLY_DIR="${2:?--dir needs a directory}"; shift 2 ;;
	--workspace|-w)
		WORKSPACE="${2:?--workspace needs a folder}"; shift 2 ;;
	--list)	LIST_ONLY=1; shift ;;
	--check) CHECK_ONLY=1; shift ;;
	# Daimond's own ssh key, its own host list, and the wrapper that puts both on
	# an `ssh` command line without the user typing them. See "The Remote
	# toolchain" below for what it writes and what it deliberately does not.
	--remote) REMOTE=1; shift ;;
	# Every native messaging directory this script knows about, one per line,
	# found or not. `uninstall.sh` reads it, so the table of browsers lives in
	# exactly one file rather than in two that drift.
	--paths) PATHS_ONLY=1; shift ;;
	--selftest) SELFTEST=1; shift ;;
	-h|--help)
		# The leading comment block, and not a line past it. A fixed line count
		# printed seven lines of shell after the last comment the day the block
		# grew shorter than the number; the block's own end is the only marker
		# that stays right.
		awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
		exit 0 ;;
	-*)	echo "install.sh: unknown option $1" >&2; exit 2 ;;
	*)	BINARY="$1"; shift ;;
	esac
done

if [ "$PATHS_ONLY" = 1 ]; then
	for entry in "${BROWSERS[@]}"; do
		printf '%s/NativeMessagingHosts\n' "${entry##*|}"
	done
	exit 0
fi

# ── Small helpers ────────────────────────────────────────────────────

# Whether a directory belongs to a confined browser, judged by its path. Used
# for --dir, where there is no table entry to consult.
confined_path() {
	case "$1" in
	"$SNAP"/*|*/snap/*/common/*|*/snap/*/current/*)	echo snap ;;
	"$FLAT"/*|*/.var/app/*)							echo flatpak ;;
	*)												echo '' ;;
	esac
}

# The sentence that saves the hour. Printed wherever a confined browser is
# found, and never suppressed -- a snap browser that installs quietly is the
# whole of the failure this script exists to prevent. It says what happens
# rather than that this is unsupported, because "unsupported" invites a
# workaround and there is not one.
say_confined() {
	cat >&2 <<EOF

A $1 browser cannot run Machine Operations. Its confinement extends to the
programs it starts, so the hand can only see the files in \$HOME that are not
hidden -- and its journal is at $JDIR,
behind one that is. The hand exits before it can open the journal it would have
used to say so, and the browser reports only "Native host has exited".

Fix: a Chromium-family browser installed from a .deb. Moving the journal will
not help, because the browser gives the hand its own environment, so
DAIMOND_HAND_JOURNAL_DIR never reaches it.
EOF
}

# ── Selftest ─────────────────────────────────────────────────────────
#
# Run before anything reads the filesystem for real, so a test run never touches
# the invoking user's browsers. Each case builds a throwaway home directory that
# looks like one arrangement, runs THIS script against it with HOME redirected,
# and asserts the exit status and what was said. `dev/publish.mjs --selftest` is
# the same technique in JavaScript.
selftest() {
	local pass=0 fail=0

	# Not /tmp: it is a tmpfs, and the fleet has been OOM-killed off it three
	# times. ~/.cache is a real filesystem.
	mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
	BASE="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/daimond-install-selftest.XXXXXX")"
	trap 'rm -rf "$BASE"' EXIT

	local out status
	check() {
		local name="$1" ok="$2" detail="${3:-}"
		if [ "$ok" = 1 ]; then
			pass=$((pass + 1)); printf '  ok    %s\n' "$name"
		else
			fail=$((fail + 1)); printf '  FAIL  %s%s\n' "$name" "${detail:+  -- $detail}"
		fi
	}

	# A home directory with the given profile directories in it, and a
	# stand-in binary for the script to register.
	fixture() {
		local name="$1"; shift
		local h="$BASE/$name"
		mkdir -p "$h"
		printf '#!/bin/sh\necho "daimond-hand 0.0.0-fixture"\n' > "$h/daimond-hand"
		chmod 755 "$h/daimond-hand"
		local d
		for d in "$@"; do mkdir -p "$h/$d"; done
		echo "$h"
	}

	# Run this script with HOME pointed at a fixture, capturing both streams.
	run_in() {
		local h="$1"; shift
		set +e
		out="$(HOME="$h" XDG_CONFIG_HOME= XDG_DATA_HOME= XDG_CACHE_HOME= \
			DAIMOND_HAND_JOURNAL_DIR= \
			bash "${BASH_SOURCE[0]}" "$@" 2>&1)"
		status=$?
		set -e
	}

	echo "install.sh --selftest"

	# 1. A snap profile is found, named, and refused.
	local h
	h="$(fixture snap "snap/chromium/common/chromium")"
	run_in "$h" "$h/daimond-hand"
	check 'a snap chromium profile is refused' \
		"$( [ "$status" = 3 ] && grep -qi 'snap browser cannot run' <<<"$out" && echo 1 || echo 0 )" \
		"exit $status"
	check 'and the refusal names the .deb fix' \
		"$( grep -q '\.deb' <<<"$out" && echo 1 || echo 0 )"
	check 'and nothing was written into the snap profile' \
		"$( [ ! -e "$h/snap/chromium/common/chromium/NativeMessagingHosts/$HOST.json" ] && echo 1 || echo 0 )"

	# 2. A flatpak profile, the same.
	h="$(fixture flatpak ".var/app/org.chromium.Chromium/config/chromium")"
	run_in "$h" "$h/daimond-hand"
	check 'a flatpak chromium profile is refused' \
		"$( [ "$status" = 3 ] && grep -qi 'flatpak browser cannot run' <<<"$out" && echo 1 || echo 0 )" \
		"exit $status"
	check 'and nothing was written into the flatpak profile' \
		"$( [ ! -e "$h/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts/$HOST.json" ] && echo 1 || echo 0 )"

	# 3. A .deb profile is installed into, and says so.
	h="$(fixture deb ".config/google-chrome")"
	run_in "$h" "$h/daimond-hand"
	check 'a .deb chrome profile is registered' \
		"$( [ "$status" = 0 ] && [ -f "$h/.config/google-chrome/NativeMessagingHosts/$HOST.json" ] && echo 1 || echo 0 )" \
		"exit $status"
	check 'and the manifest names the binary it was given' \
		"$( grep -qF "$h/daimond-hand" "$h/.config/google-chrome/NativeMessagingHosts/$HOST.json" && echo 1 || echo 0 )"
	check 'and it prints where to load the extension from' \
		"$( grep -qF "$REPO/ext" <<<"$out" && echo 1 || echo 0 )"

	# 4. Nothing at all: the likeliest reason is named, which is the other
	#    thing an hour was lost to.
	h="$(fixture none)"
	run_in "$h" "$h/daimond-hand"
	check 'no profile at all is a refusal' \
		"$( [ "$status" = 1 ] && echo 1 || echo 0 )" "exit $status"
	check 'and it says the profile appears only after a first run' \
		"$( grep -qi 'run it once' <<<"$out" && echo 1 || echo 0 )" \
		"$(head -1 <<<"$out")"
	check 'and it lists snap and flatpak among the places it looked' \
		"$( grep -q 'snap/chromium' <<<"$out" && grep -q '\.var/app' <<<"$out" && echo 1 || echo 0 )"

	# 5. Both kinds present: the usable one is used and the other is named.
	h="$(fixture both ".config/chromium" "snap/chromium/common/chromium")"
	run_in "$h" "$h/daimond-hand"
	check 'a usable browser beside a confined one still installs' \
		"$( [ "$status" = 0 ] && [ -f "$h/.config/chromium/NativeMessagingHosts/$HOST.json" ] && echo 1 || echo 0 )" \
		"exit $status"
	check 'and the confined one is named as skipped' \
		"$( grep -qi 'skipped' <<<"$out" && grep -q 'snap' <<<"$out" && echo 1 || echo 0 )"

	# 6. --dir stays an escape hatch, and warns when it is pointed at a snap.
	h="$(fixture dirsnap "snap/chromium/common/chromium")"
	run_in "$h" --dir "$h/snap/chromium/common/chromium/NativeMessagingHosts" "$h/daimond-hand"
	check '--dir into a snap profile writes, and warns' \
		"$( [ "$status" = 0 ] \
			&& [ -f "$h/snap/chromium/common/chromium/NativeMessagingHosts/$HOST.json" ] \
			&& grep -qi 'snap browser cannot run' <<<"$out" && echo 1 || echo 0 )" \
		"exit $status"

	h="$(fixture dirplain)"
	run_in "$h" --dir "$h/profile/NativeMessagingHosts" "$h/daimond-hand"
	check '--dir into an ordinary profile writes, and does not warn' \
		"$( [ "$status" = 0 ] \
			&& [ -f "$h/profile/NativeMessagingHosts/$HOST.json" ] \
			&& ! grep -qi 'cannot run Machine Operations' <<<"$out" && echo 1 || echo 0 )" \
		"exit $status"

	# 7. --workspace does the two steps that used to be typed.
	h="$(fixture ws ".config/chromium")"
	mkdir -p "$h/work"
	run_in "$h" --workspace "$h/work" "$h/daimond-hand"
	check '--workspace writes root.txt beside the journal' \
		"$( [ "$status" = 0 ] && grep -qxF "$(cd "$h/work" && pwd -P)" "$h/.local/share/daimond/hand/journal/root.txt" && echo 1 || echo 0 )" \
		"exit $status"
	check 'and creates the journal directory at 0700' \
		"$( [ "$(stat -c %a "$h/.local/share/daimond/hand/journal")" = 700 ] && echo 1 || echo 0 )" \
		"$(stat -c %a "$h/.local/share/daimond/hand/journal" 2>/dev/null || echo absent)"

	# 8. ...and refuses the two folders that would be wrong.
	# On the message, not only the status: the home directory also contains the
	# journal, so a status check alone passes on the wrong guard.
	h="$(fixture wshome ".config/chromium")"
	run_in "$h" --workspace "$h" "$h/daimond-hand"
	check '--workspace refuses the home directory itself' \
		"$( [ "$status" = 2 ] && grep -q 'bounds everything' <<<"$out" && echo 1 || echo 0 )" \
		"exit $status"

	h="$(fixture wsmissing ".config/chromium")"
	run_in "$h" --workspace "$h/nope" "$h/daimond-hand"
	check '--workspace refuses a folder that is not there' \
		"$( [ "$status" = 2 ] && grep -qi 'does not exist' <<<"$out" && echo 1 || echo 0 )" "exit $status"

	h="$(fixture wsinside ".config/chromium")"
	mkdir -p "$h/.local/share"
	run_in "$h" --workspace "$h/.local/share" "$h/daimond-hand"
	check '--workspace refuses a folder containing the journal' \
		"$( [ "$status" = 2 ] && grep -qi 'journal' <<<"$out" && echo 1 || echo 0 )" "exit $status"

	# 9. --check fails on an install that is not done, and says which line.
	h="$(fixture chk ".config/chromium")"
	run_in "$h" --check "$h/daimond-hand"
	check '--check fails before anything is set up' \
		"$( [ "$status" = 1 ] && echo 1 || echo 0 )" "exit $status"
	# The FAIL line for root.txt specifically, not merely a FAIL somewhere and
	# the words root.txt somewhere else.
	check 'and names root.txt as the missing piece' \
		"$( grep -qE '^  FAIL  root\.txt' <<<"$out" && echo 1 || echo 0 )"

	# 10. ...and passes on one that is.
	h="$(fixture chkok ".config/chromium")"
	mkdir -p "$h/work"
	run_in "$h" --workspace "$h/work" "$h/daimond-hand"
	run_in "$h" --check "$h/daimond-hand"
	check '--check passes on an install this script just made' \
		"$( [ "$status" = 0 ] && ! grep -q 'FAIL' <<<"$out" && echo 1 || echo 0 )" \
		"$(grep FAIL <<<"$out" | head -2 | tr '\n' ' ')"

	# 10b. A confined browser beside a usable one is a note, not a failure --
	#      but it must be said, because using that one makes every other line
	#      pass while nothing works.
	h="$(fixture chkboth ".config/chromium" "snap/chromium/common/chromium")"
	mkdir -p "$h/work"
	run_in "$h" --workspace "$h/work" "$h/daimond-hand"
	run_in "$h" --check "$h/daimond-hand"
	check '--check names a confined browser found beside a usable one' \
		"$( [ "$status" = 0 ] && grep -qE '^  note  browser.*snap' <<<"$out" && echo 1 || echo 0 )" \
		"exit $status"

	# 11. ...and fails again the moment the journal directory is opened up,
	#     which is the mode the hand itself refuses to start on.
	chmod 755 "$h/.local/share/daimond/hand/journal"
	run_in "$h" --check "$h/daimond-hand"
	check '--check catches a journal directory that is not 0700' \
		"$( [ "$status" = 1 ] && grep -q '700' <<<"$out" && echo 1 || echo 0 )" "exit $status"

	# 12. --check catches a registration pointing at a binary that has gone.
	h="$(fixture chkstale ".config/chromium")"
	mkdir -p "$h/work"
	run_in "$h" --workspace "$h/work" "$h/daimond-hand"
	rm -f "$h/daimond-hand"
	run_in "$h" --check
	check '--check catches a registration whose binary has gone' \
		"$( [ "$status" = 1 ] && echo 1 || echo 0 )" "exit $status"

	# 13. --paths, which uninstall.sh reads, covers all three packagings.
	h="$(fixture paths)"
	run_in "$h" --paths
	check '--paths lists deb, snap and flatpak directories' \
		"$( grep -q "$h/.config/chromium/NativeMessagingHosts" <<<"$out" \
			&& grep -q "$h/snap/chromium/common/chromium/NativeMessagingHosts" <<<"$out" \
			&& grep -q "$h/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts" <<<"$out" \
			&& echo 1 || echo 0 )"

	echo
	echo "  $pass passed, $fail failed"
	[ "$fail" = 0 ]
}

if [ "${SELFTEST:-0}" = 1 ]; then
	if selftest; then exit 0; else exit 1; fi
fi

# ── The binary ───────────────────────────────────────────────────────
#
# A release build first, because that is what anyone running this for real will
# have; a debug build second, because that is what a developer has to hand. The
# path is written into the manifest verbatim, so it must be absolute -- a
# relative path would be resolved against the manifest's directory, which is not
# where anybody's build output lives.

if [ -z "$BINARY" ]; then
	for cand in "$REPO/hand/target/release/daimond-hand" "$REPO/hand/target/debug/daimond-hand"; do
		if [ -x "$cand" ]; then BINARY="$cand"; break; fi
	done
fi

if [ -z "$BINARY" ] && [ "$CHECK_ONLY" = 0 ]; then
	cat >&2 <<EOF
install.sh: no daimond-hand binary found.

Build it first, from $REPO:

    cargo build --release --manifest-path hand/Cargo.toml

then run this again. To register something else -- a mock host, or a binary you
keep elsewhere -- pass its path:

    ./install.sh /path/to/daimond-hand
EOF
	exit 1
fi

if [ -n "$BINARY" ]; then
	BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"
	if [ ! -x "$BINARY" ] && [ "$CHECK_ONLY" = 0 ]; then
		echo "install.sh: $BINARY is not executable. Chrome will not run it." >&2
		exit 1
	fi
fi

# ── Finding the browsers ─────────────────────────────────────────────
#
# Only browsers that are actually installed. Writing into a directory for a
# browser nobody has is harmless but dishonest: the report would claim work that
# means nothing.

USABLE=()	# label|dir, for browsers whose hand can reach its own journal
CONFINED=()	# label|dir|kind, for the ones whose hand cannot

for entry in "${BROWSERS[@]}"; do
	label="${entry%%|*}"
	rest="${entry#*|}"
	kind="${rest%%|*}"
	prof="${rest#*|}"
	[ -d "$prof" ] || continue
	if [ "$kind" = deb ]; then
		USABLE+=("$label|$prof/NativeMessagingHosts")
	else
		CONFINED+=("$label|$prof/NativeMessagingHosts|$kind")
	fi
done

# ── The manifest ─────────────────────────────────────────────────────
#
# Written from here rather than copied from the template beside this script, so
# there is exactly one place the path and the extension id are decided. The
# template is kept for reading, and for anyone registering the host by hand on a
# platform this script does not cover yet.

manifest() {
	cat <<EOF
{
	"name": "$HOST",
	"description": "Daimond's machine hand: runs commands for the Daimond Hands extension.",
	"path": "$BINARY",
	"type": "stdio",
	"allowed_origins": [
		"chrome-extension://$EXT_ID/"
	]
}
EOF
}

write_to() {
	local label="$1" dir="$2"
	if [ "$LIST_ONLY" = 1 ]; then
		printf '  %-24s %s/%s.json\n' "$label" "$dir" "$HOST"
		return 0
	fi
	mkdir -p "$dir"
	manifest > "$dir/$HOST.json"
	chmod 644 "$dir/$HOST.json"
	printf '  %-24s %s/%s.json\n' "$label" "$dir" "$HOST"
}

# ── Checking, which changes nothing ──────────────────────────────────

CHECK_FAILED=0

# A passing line is a name and a value, because nothing has to be explained
# about something that works; a failing one carries the fix on the line below
# it. Prose on every line would bury the one line that matters.
pass() { printf '  ok    %-14s %s\n' "$1" "$2"; }
bad()  { printf '  FAIL  %-14s %s\n' "$1" "$2"; printf '        %-14s %s\n' 'fix' "$3"; CHECK_FAILED=1; }
note() { printf '  note  %-14s %s\n' "$1" "$2"; }

# The one command to run when anything goes wrong.
run_check() {
	echo "Daimond's machine hand -- checking this install"
	echo

	# 1. A browser whose hand could reach its own files.
	if [ "${#USABLE[@]}" -gt 0 ]; then
		for u in "${USABLE[@]}"; do
			pass 'browser' "${u%%|*}  $(dirname "${u#*|}")"
		done
		# Not a failure -- there is a usable browser -- but if the one being
		# used is the confined one, every line below passes and nothing works.
		for c in ${CONFINED[@]+"${CONFINED[@]}"}; do
			note 'browser' "${c%%|*} is also installed and cannot run the hand: confined. Use the browser above."
		done
	elif [ "${#CONFINED[@]}" -gt 0 ]; then
		for c in "${CONFINED[@]}"; do
			local clabel="${c%%|*}" ckind="${c##*|}"
			bad 'browser' "$clabel is a $ckind package: confined, so the hand cannot reach its journal in a hidden directory" \
				'install a Chromium-family browser from a .deb'
		done
	else
		bad 'browser' 'no browser profile found' \
			'the profile appears the first time a browser runs -- install a .deb Chromium-family browser and run it once'
	fi

	# 2. The registration, in each profile that could use it.
	local seen=0 dir f mpath morigin
	for u in "${USABLE[@]}" ${CONFINED[@]+"${CONFINED[@]}"}; do
		dir="$(echo "$u" | cut -d'|' -f2)"
		f="$dir/$HOST.json"
		[ -f "$f" ] || continue
		seen=$((seen + 1))
		mpath="$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
		morigin="$(sed -n 's|.*chrome-extension://\([^/]*\)/.*|\1|p' "$f" | head -1)"
		if [ ! -x "$mpath" ]; then
			bad 'registration' "$f names '$mpath', which will not run: the browser can start nothing" \
				'rebuild the hand, then run install.sh again'
		elif [ "$morigin" != "$EXT_ID" ]; then
			bad 'registration' "$f names extension $morigin, so this build of the extension is refused" \
				'DAIMOND_HAND_EXT_ID=<the id at chrome://extensions> install.sh'
		else
			pass 'registration' "$f"
		fi
	done
	if [ "$seen" = 0 ]; then
		bad 'registration' "no $HOST.json anywhere: the browser has nothing naming the hand" \
			'run install.sh with no arguments'
	fi

	# 3. The binary, actually run rather than merely present.
	if [ -z "$BINARY" ]; then
		bad 'binary' 'not built' \
			'cargo build --release --manifest-path hand/Cargo.toml'
	elif [ ! -x "$BINARY" ]; then
		bad 'binary' "$BINARY is not executable" 'chmod +x it, or rebuild'
	else
		local v
		if v="$("$BINARY" --version 2>&1)"; then
			pass 'binary' "$BINARY  ($v)"
		else
			bad 'binary' "$BINARY will not run: $v" \
				'rebuild on this machine -- a binary from another distribution may want a newer glibc'
		fi
	fi

	# 4. The journal directory: present, private, and writable.
	if [ ! -d "$JDIR" ]; then
		bad 'journal' "$JDIR is not there, and the hand serves nothing it cannot record" \
			'install.sh --workspace <the folder you want Daimond to work in>'
	else
		local mode
		mode="$(stat -c %a "$JDIR")"
		if [ "$mode" != 700 ]; then
			bad 'journal' "$JDIR is mode $mode: the record of every command would be readable by other users, so the hand refuses it" \
				"chmod 700 '$JDIR'"
		elif ! touch "$JDIR/.write-probe" 2>/dev/null; then
			bad 'journal' "$JDIR cannot be written, so the hand will exit at startup" \
				'check who owns it, and that the browser is not a snap or flatpak'
		else
			rm -f "$JDIR/.write-probe"
			pass 'journal' "$JDIR"
		fi
	fi

	# 5. The granted folder.
	local root=''
	if [ -f "$JDIR/root.txt" ]; then
		root="$(grep -v '^[[:space:]]*#' "$JDIR/root.txt" | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]')"
	fi
	if [ -z "$root" ]; then
		bad 'root.txt' 'missing: the hand is not told which folder it may work in, and never guesses' \
			'install.sh --workspace <the folder you want Daimond to work in>'
	elif [ "${root:0:1}" != / ]; then
		bad 'root.txt' "'$root' is relative, so it would resolve against wherever the browser was started" \
			'write the full path, starting at /'
	elif [ ! -d "$root" ]; then
		bad 'root.txt' "'$root' does not exist" \
			'create it, or grant a different folder'
	else
		pass 'root.txt' "$root"
	fi

	# 6. The record must not live inside the folder a command may write to, or
	#    every command is refused.
	if [ -n "$root" ] && [ -d "$root" ]; then
		case "$(cd "$JDIR" 2>/dev/null && pwd -P || echo "$JDIR")/" in
		"$(cd "$root" && pwd -P)"/*)
			bad 'fence' 'the journal is inside the granted folder, so a command could rewrite the record -- every command is refused' \
				'grant a folder that does not contain the journal' ;;
		*)	pass 'fence' 'journal outside the grant' ;;
		esac
	fi

	# 7. The extension, which the browser has to be pointed at by hand.
	if [ -f "$REPO/ext/manifest.json" ]; then
		pass 'extension' "$REPO/ext"
	else
		bad 'extension' "$REPO/ext/manifest.json is not there, so there is nothing to load" \
			'run this script from inside a Daimond checkout'
	fi

	echo
	if [ "$CHECK_FAILED" = 0 ]; then
		echo "All good. If Daimond still says the hand disconnected, restart the browser:"
		echo "it reads the registration only at startup."
	else
		echo "Fix from the top -- a later line often fails only because an earlier one did."
	fi
	return "$CHECK_FAILED"
}

if [ "$CHECK_ONLY" = 1 ]; then
	if run_check; then exit 0; else exit 1; fi
fi

# ── The workspace, and the journal directory beside it ───────────────
#
# The two steps install/README.md used to ask for by hand. Which folder is a
# decision and stays an argument; creating the directory at the right mode and
# writing the file are not decisions, and are done here.

if [ -n "$WORKSPACE" ]; then
	if [ ! -d "$WORKSPACE" ]; then
		echo "install.sh: '$WORKSPACE' does not exist, and the hand will not fence a folder" >&2
		echo "it cannot resolve. Create it, then run this again." >&2
		exit 2
	fi
	WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"
	if [ "$WORKSPACE" = "$(cd "$HOME" && pwd -P)" ] || [ "$WORKSPACE" = / ]; then
		echo "install.sh: refusing '$WORKSPACE'. The granted folder bounds everything any" >&2
		echo "command can read or write, so granting your whole account grants everything." >&2
		echo "Make a folder for the work." >&2
		exit 2
	fi
	# The record must be outside the fence, or the hand refuses every command
	# rather than write the journal where a command could edit it.
	case "$JDIR/" in
	"$WORKSPACE"/*)
		echo "install.sh: the journal at '$JDIR' is inside '$WORKSPACE', so a command could" >&2
		echo "rewrite the record of itself. The hand refuses every command in that shape." >&2
		echo "Grant a folder that does not contain the journal." >&2
		exit 2 ;;
	esac

	if [ -d "$JDIR" ]; then
		# Only the journal's own furniture, and the file this script writes, may
		# be in a directory it will chmod. DAIMOND_HAND_JOURNAL_DIR can name
		# anything, and re-permissioning somebody's data to 700 because they
		# pointed it at the wrong place is not this script's to do.
		for n in "$JDIR"/* "$JDIR"/.*; do
			[ -e "$n" ] || continue
			case "$(basename "$n")" in
			.|..|root.txt|lock|head.json|head.json.new|hand-*.jsonl|foreign-*) ;;
			*)
				echo "install.sh: '$JDIR' holds '$(basename "$n")', which the journal did not write." >&2
				echo "Tightening it to 700 would re-permission your files, so it is left alone." >&2
				echo "Empty it, or point DAIMOND_HAND_JOURNAL_DIR at a directory of its own." >&2
				exit 2 ;;
			esac
		done
	fi
	mkdir -p "$JDIR"
	chmod 700 "$JDIR"
	printf '# The one folder Daimond'"'"'s machine hand may work in.\n%s\n' "$WORKSPACE" > "$JDIR/root.txt"
	chmod 600 "$JDIR/root.txt"
fi

# ── The Remote toolchain: an ssh key that is Daimond's own ───────────
#
# The owner asked for one sentence: an ssh to another machine, from a Terminal
# in Daimond, with a session that survives a network dropout.  Three refusals
# stood in the way, and the first was `~/.ssh/known_hosts: Permission denied`.
#
# The tempting repair is to lend `~/.ssh`.  It is the wrong one: that directory
# holds the keys the rest of a person's life runs on.  So Daimond gets a key of
# its OWN, here, and a host list of its own beside it -- and revoking Daimond's
# reach to any machine is then one line removed from that machine's
# `authorized_keys`, which is not true of a grant of the user's own key.
#
# THE WRAPPER IS WHY `ssh argonaut` WORKS TYPED EXACTLY LIKE THAT.  OpenSSH takes
# the home directory from the passwd entry and not from `HOME`, so there is no
# environment variable that could point it at another key or another host list --
# the flags have to be on the command line, and something has to put them there.
# The Remote toolkit puts this directory first on a Terminal's `PATH`, read-only,
# so nothing a fenced command does can add a second program to it.
#
# NOTHING HERE INSTALLS THE KEY ANYWHERE.  Which machines Daimond may reach is a
# decision, and it stays one: the public key is printed, with the line to add and
# the `restrict,pty` in front of it that says a shell and nothing else.

if [ "$REMOTE" = 1 ]; then
	RDIR="$HOME/.config/oxedyne/daimond-hand"
	SSH_BIN="$(command -v ssh || true)"
	if [ -z "$SSH_BIN" ]; then
		echo "install.sh: there is no ssh on this machine, so there is nothing for the" >&2
		echo "Remote toolchain to wrap. Install openssh-client and run this again." >&2
		exit 2
	fi
	mkdir -p "$RDIR/ssh" "$RDIR/bin"
	chmod 700 "$HOME/.config/oxedyne" "$RDIR" "$RDIR/ssh"
	chmod 755 "$RDIR/bin"
	if [ ! -f "$RDIR/ssh/id_daimond" ]; then
		# No passphrase: nothing can type one into a fenced terminal, and a key
		# that cannot be used is not a safer key but an unused one. What bounds
		# it is `restrict,pty` at the far end and the fence at this one.
		ssh-keygen -q -t ed25519 -N '' -C "daimond@$(hostname)" -f "$RDIR/ssh/id_daimond"
	fi
	chmod 600 "$RDIR/ssh/id_daimond"
	chmod 644 "$RDIR/ssh/id_daimond.pub"
	# Daimond's own, and never the user's: a `known_hosts` has to be WRITTEN to
	# learn a host, and a writable `~/.ssh` is a way to add an authorized key.
	[ -f "$RDIR/known_hosts" ] || : > "$RDIR/known_hosts"
	chmod 600 "$RDIR/known_hosts"

	cat > "$RDIR/bin/ssh" <<WRAPPER
#!/bin/sh
# Daimond's ssh. Written by hand/install/install.sh; edit that, not this.
#
# The paths are absolute because a fenced terminal has no HOME unless something
# granted it one, and because OpenSSH would not read HOME anyway.
#
# With ONE argument -- \`ssh argonaut\` -- the far end is a tmux attached if it is
# already there and started if it is not. That is what survives a network
# dropout: the programs keep running on the other machine, and the next
# \`ssh argonaut\` walks back into them mid-sentence. Anything else is passed
# straight through, so \`ssh argonaut uptime\` is still one line and one answer.
set -eu
KEY='$RDIR/ssh/id_daimond'
KH='$RDIR/known_hosts'
OPT_ID='-oIdentitiesOnly=yes'
OPT_KH="-oUserKnownHostsFile=\$KH"
OPT_SHK='-oStrictHostKeyChecking=accept-new'
FAR='if command -v tmux >/dev/null 2>&1; then exec tmux new -A -s daimond; else exec "\${SHELL:-/bin/sh}" -l; fi'
if [ \$# -eq 1 ]; then
	exec '$SSH_BIN' -i "\$KEY" "\$OPT_ID" "\$OPT_KH" "\$OPT_SHK" -t "\$1" "\$FAR"
fi
exec '$SSH_BIN' -i "\$KEY" "\$OPT_ID" "\$OPT_KH" "\$OPT_SHK" "\$@"
WRAPPER
	chmod 755 "$RDIR/bin/ssh"

	echo "Daimond's ssh"
	echo "  key                    $RDIR/ssh/id_daimond"
	echo "  host list              $RDIR/known_hosts"
	echo "  wrapper                $RDIR/bin/ssh -> $SSH_BIN"
	echo
	echo "On every machine Daimond may reach, add this one line to ~/.ssh/authorized_keys."
	echo "'restrict,pty' is a shell and nothing else: no port forwarding, no agent, no X11."
	echo
	echo "  restrict,pty $(cat "$RDIR/ssh/id_daimond.pub")"
	echo
	echo "Then grant the Remote toolchain to a Diamond, and open its Terminal. A Diamond"
	echo "without it cannot reach the key, and neither can any command -- the grant is"
	echo "lent to a terminal you opened by hand and to nothing a daimon can ask for."
	echo
fi

# ── Writing ──────────────────────────────────────────────────────────

echo "Daimond's machine hand"
echo "  binary                 $BINARY"
echo "  extension              chrome-extension://$EXT_ID/"
if [ -n "$WORKSPACE" ]; then
	echo "  granted folder         $WORKSPACE"
	echo "  journal                $JDIR"
fi
echo

# What is left, and only what is left. The two decisions -- which folder, and
# the approval -- are named as decisions; the rest is mechanism this script has
# already done.
next_steps() {
	echo
	echo "Next:"
	if [ -z "$WORKSPACE" ] && [ ! -f "$JDIR/root.txt" ]; then
		cat <<EOF
  - Grant a folder. It bounds everything any command can read or write, so pick
    one for the work rather than your home directory; until then the hand
    refuses to serve a page at all.
        $HERE/install.sh --workspace ~/work
EOF
	fi
	cat <<EOF
  - Load $REPO/ext at chrome://extensions
    (Developer mode, "Load unpacked").
  - Restart the browser -- it reads the file above only at startup.
  - In Daimond, open the folder you granted. The first command opens a window
    asking you to allow this; nothing runs until you do, and the Daimond Hands
    toolbar icon takes it back.

If anything does not work:  $HERE/install.sh --check
EOF
}

if [ -n "$ONLY_DIR" ]; then
	write_to "(given)" "$ONLY_DIR"
	kind="$(confined_path "$ONLY_DIR")"
	if [ -n "$kind" ]; then
		say_confined "$kind"
		echo >&2
		echo "Written anyway: --dir means you know better. If the hand disconnects on the" >&2
		echo "first command, this is why." >&2
	fi
	next_steps
	exit 0
fi

if [ "${#USABLE[@]}" = 0 ]; then
	if [ "${#CONFINED[@]}" -gt 0 ]; then
		echo "Found, and NOT installed into:" >&2
		for c in "${CONFINED[@]}"; do
			printf '  %-24s %s\n' "${c%%|*}" "$(dirname "$(echo "$c" | cut -d'|' -f2)")" >&2
		done
		say_confined "$(echo "${CONFINED[0]}" | cut -d'|' -f3)"
		echo >&2
		echo "To write there anyway, if you know better:" >&2
		echo "    $HERE/install.sh --dir <profile>/NativeMessagingHosts '$BINARY'" >&2
		exit 3
	fi
	cat >&2 <<EOF
No browser profile found. The likeliest reason is that the browser has never
been started -- the profile appears on first run, not when the package is
installed. Install a .deb Chromium-family browser, run it once, and try again.

Looked for:
$(for entry in "${BROWSERS[@]}"; do printf '  %-8s %s\n' "$(echo "$entry" | cut -d'|' -f2)" "${entry##*|}"; done)

If your browser keeps its profile elsewhere, name that directory with
NativeMessagingHosts on the end:

    $HERE/install.sh --dir /path/to/profile/NativeMessagingHosts '$BINARY'
EOF
	exit 1
fi

for u in "${USABLE[@]}"; do
	write_to "${u%%|*}" "${u#*|}"
done

if [ "$LIST_ONLY" = 1 ]; then
	if [ "${#CONFINED[@]}" -gt 0 ]; then
		echo
		echo "Skipped, because a confined browser cannot run the hand:"
		for c in "${CONFINED[@]}"; do
			printf '  %-24s %s\n' "${c%%|*}" "$(dirname "$(echo "$c" | cut -d'|' -f2)")"
		done
	fi
	echo
	echo "Nothing was written. That is what --list is for; run it without --list to install."
	exit 0
fi

if [ "${#CONFINED[@]}" -gt 0 ]; then
	echo
	echo "Skipped, because a confined browser cannot run the hand:"
	for c in "${CONFINED[@]}"; do
		printf '  %-24s %s\n' "${c%%|*}" "$(dirname "$(echo "$c" | cut -d'|' -f2)")"
	done
	say_confined "$(echo "${CONFINED[0]}" | cut -d'|' -f3)"
fi

next_steps
