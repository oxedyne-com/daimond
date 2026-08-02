#!/usr/bin/env bash
#
# Unregisters Daimond's machine hand.
#
# Withdrawing the grant in the browser stops Daimond using the hand; this
# removes the browser's ability to start it at all. Both are worth having: the
# first is a decision, the second is a removal.
#
#	./uninstall.sh              # every browser found
#	./uninstall.sh --dir DIR    # one directory
#
# It removes the JSON manifests only. The binary is left where it is -- this
# script did not put it there and does not know what else uses it.

set -euo pipefail

HOST='com.oxedyne.daimond.hand'
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

DIRS=(
	"$CONFIG/google-chrome/NativeMessagingHosts"
	"$CONFIG/google-chrome-beta/NativeMessagingHosts"
	"$CONFIG/google-chrome-unstable/NativeMessagingHosts"
	"$CONFIG/chromium/NativeMessagingHosts"
	"$CONFIG/BraveSoftware/Brave-Browser/NativeMessagingHosts"
	"$CONFIG/BraveSoftware/Brave-Browser-Beta/NativeMessagingHosts"
	"$CONFIG/microsoft-edge/NativeMessagingHosts"
	"$CONFIG/vivaldi/NativeMessagingHosts"
)

if [ "${1:-}" = '--dir' ]; then
	DIRS=("${2:?--dir needs a directory}")
fi

gone=0
for dir in "${DIRS[@]}"; do
	f="$dir/$HOST.json"
	if [ -f "$f" ]; then
		rm -f "$f"
		echo "  removed $f"
		gone=$((gone + 1))
	fi
done

if [ "$gone" = 0 ]; then
	echo "Nothing to remove: $HOST is not registered with any browser found here."
else
	echo
	echo "Removed from $gone browser(s). Restart the browser to be sure."
fi
