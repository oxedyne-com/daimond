#!/bin/bash
# repro-check.sh -- prove that somebody else could reproduce the sealed bundle.
#
# The published claim is that a stranger can clone the public repository, build
# it, and get the bytes the site serves. That is only ever true by accident
# unless it is checked the way a stranger would experience it, so this does
# exactly that and nothing cheaper:
#
#   * a FRESH CLONE of the public mirror, not the working tree, because the
#     working tree carries generated files and uncommitted fixes that a cloner
#     will not have -- that is how the mirror's Cargo.toml sat broken with path
#     dependencies from 2026-07-21 to 2026-07-27, unbuildable by anyone outside
#     while every local build kept working;
#   * a SEPARATE cargo home and a DIFFERENT directory depth, because build paths
#     get baked into the binary. Rebuilding where it was sealed proves nothing:
#     it is the one arrangement guaranteed to agree with itself.
#
# It then compares the rebuild against the SEALED MANIFEST, so the thing under
# test is the released bundle rather than another copy of itself.
#
#   bash dev/repro-check.sh          # ~5 minutes, mostly a cold dependency build
#
# Slow and disk-hungry by nature, so it is not part of `run_all.sh`. Run it at
# release, which is the only time its answer can change.
set -e
cd "$(dirname "$0")/.."
DEV=$(pwd -P)
MIRROR=${MIRROR:-$DEV/../daimond-oss}
WORK=${WORK:-$HOME/.cache/daimond-repro-check}

# Never under /tmp: it is a tmpfs, so a cargo target directory there is held in
# RAM and charged to whoever wrote it.
rm -rf "$WORK"
mkdir -p "$WORK/a/deeper/nested"
export CARGO_HOME="$WORK/cargo-home"
mkdir -p "$CARGO_HOME"

echo "── cloning the public mirror into a path of its own"
git clone -q "$MIRROR" "$WORK/a/deeper/nested/clone"
cd "$WORK/a/deeper/nested/clone"

# The sealed manifest names the pkg files, so the clone must carry the manifest
# of the release being checked. It is committed, so a clone already has it.
echo "── building as an outsider would"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
bash dev/build-wasm.sh >"$WORK/build.log" 2>&1 || {
	echo "FAILED — the public mirror does not build. Last lines:"
	tail -20 "$WORK/build.log"
	exit 1
}

echo "── comparing the rebuild against the sealed manifest"
node verify/check.mjs --dir www
