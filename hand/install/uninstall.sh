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
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# From `install.sh --paths`, not from a copy of its table. A second list here
# would drift, and the browsers it forgot would keep a registration nobody could
# find -- snap and flatpak profiles are exactly the entries a stale copy misses.
mapfile -t DIRS < <(bash "$HERE/install.sh" --paths)

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
