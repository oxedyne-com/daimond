#!/usr/bin/env bash
#
# Registers Daimond's machine hand with the browsers on this machine.
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
#	./install.sh /path/to/daimond-hand # register a particular binary
#	./install.sh --dir /some/profile/NativeMessagingHosts /path/to/binary
#	./install.sh --list                # say what it would write, and where
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

# Browser label, then its per-user native messaging directory.
BROWSERS=(
	"Google Chrome|$CONFIG/google-chrome/NativeMessagingHosts"
	"Google Chrome Beta|$CONFIG/google-chrome-beta/NativeMessagingHosts"
	"Google Chrome Dev|$CONFIG/google-chrome-unstable/NativeMessagingHosts"
	"Chromium|$CONFIG/chromium/NativeMessagingHosts"
	"Brave|$CONFIG/BraveSoftware/Brave-Browser/NativeMessagingHosts"
	"Brave Beta|$CONFIG/BraveSoftware/Brave-Browser-Beta/NativeMessagingHosts"
	"Microsoft Edge|$CONFIG/microsoft-edge/NativeMessagingHosts"
	"Vivaldi|$CONFIG/vivaldi/NativeMessagingHosts"
)

# ── Arguments ────────────────────────────────────────────────────────

ONLY_DIR=''
LIST_ONLY=0
BINARY=''

while [ $# -gt 0 ]; do
	case "$1" in
	--dir)	ONLY_DIR="${2:-}"; shift 2 ;;
	--list)	LIST_ONLY=1; shift ;;
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

if [ -z "$BINARY" ]; then
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

BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"

if [ ! -x "$BINARY" ]; then
	echo "install.sh: $BINARY is not executable. Chrome will not run it." >&2
	exit 1
fi

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
		printf '  %-20s %s/%s.json\n' "$label" "$dir" "$HOST"
		return 0
	fi
	mkdir -p "$dir"
	manifest > "$dir/$HOST.json"
	chmod 644 "$dir/$HOST.json"
	printf '  %-20s %s/%s.json\n' "$label" "$dir" "$HOST"
}

echo "Daimond's machine hand"
echo "  binary               $BINARY"
echo "  extension            chrome-extension://$EXT_ID/"
echo

if [ -n "$ONLY_DIR" ]; then
	write_to "(given)" "$ONLY_DIR"
	echo
	echo "Done. Reload the Daimond page; the hand is asked for the first time a"
	echo "command is run, and you have to allow it in the window that opens."
	exit 0
fi

# Only browsers that are actually installed. Writing into a directory for a
# browser nobody has is harmless but dishonest: the report would claim work that
# means nothing.
found=0
for entry in "${BROWSERS[@]}"; do
	label="${entry%%|*}"
	dir="${entry#*|}"
	root="$(dirname "$dir")"
	if [ -d "$root" ]; then
		write_to "$label" "$dir"
		found=$((found + 1))
	fi
done

if [ "$found" = 0 ]; then
	cat >&2 <<EOF

No supported browser was found under $CONFIG.

Looked for:
$(for entry in "${BROWSERS[@]}"; do echo "  $(dirname "${entry#*|}")"; done)

If your browser keeps its profile somewhere else, point this at the directory
yourself -- it is the profile directory with NativeMessagingHosts on the end:

    ./install.sh --dir /path/to/profile/NativeMessagingHosts "$BINARY"
EOF
	exit 1
fi

if [ "$LIST_ONLY" = 1 ]; then
	echo
	echo "Nothing was written. That is what --list is for; run it without --list to install."
	exit 0
fi

echo
echo "Done, for $found browser(s). Restart the browser if it is already running:"
echo "it reads these directories at startup."
echo
echo "The hand is asked for the first time Daimond wants to run something, and a"
echo "window opens asking you to allow it. You can take that back at any time"
echo "from the Daimond Hands toolbar icon."
