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
# THE MACHINE HAND IS CHECKED DIFFERENTLY, AND PROVES LESS. The hand is a native
# binary, not wasm: nobody publishes one, everybody builds their own, and a Rust
# release build is not byte-identical across toolchain versions. So there is no
# binary comparison to make and none is attempted. What is checked instead is the
# pair of things that are true: the published source is exactly what was sealed
# (`verify/hand.json`), and the published source BUILDS -- from the clone, with
# the pinned toolchain, using the command the seal names. The second is not a
# formality: the hand pins fe2o3 by git revision, and a revision that was never
# pushed, or that no longer has the API the hand calls, produces a mirror that
# reads fine and compiles for nobody.
#
#   bash dev/repro-check.sh          # ~8 minutes, mostly cold dependency builds
#   SKIP_HAND=1 bash dev/repro-check.sh
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
#
# WHICH RELEASE IS BEING CHECKED, THOUGH. `git clone` takes the mirror's
# COMMITTED state, and `dev/publish.mjs` says in its own header that it neither
# commits nor pushes. So a carve that has not been committed leaves this script
# cloning the PREVIOUS release, rebuilding it faithfully, comparing it against
# its own manifest and reporting OK -- a true statement about a release nobody
# asked about, arriving in the words of the one about to ship. Seq 115 was nearly
# sealed on a check of seq 114 that way, and seq 114 itself very likely on 113.
#
# The build id is what tells them apart, so it is compared rather than trusted.
# This is a MECHANISM where the release runbook had only an ordering: get the
# order wrong and the run stops, instead of congratulating you.
HERE_BUILD=$(node -e 'process.stdout.write(require("'"$DEV"'/www/manifest.json").build||"")' 2>/dev/null || true)
CLONE_BUILD=$(node -e 'process.stdout.write(require("./www/manifest.json").build||"")' 2>/dev/null || true)
if [ -z "$HERE_BUILD" ] || [ -z "$CLONE_BUILD" ]; then
	echo "FAILED — could not read a build id from both manifests:"
	echo "   working tree: ${HERE_BUILD:-<none>}   clone: ${CLONE_BUILD:-<none>}"
	echo "   A repro-check that cannot name the release it checked proves nothing."
	exit 1
fi
if [ "$HERE_BUILD" != "$CLONE_BUILD" ]; then
	echo "FAILED — this would have checked the WRONG RELEASE."
	echo "   the working tree is sealed as:  $HERE_BUILD"
	echo "   the mirror's clone carries:     $CLONE_BUILD"
	echo
	echo "   The carve has not been committed in $MIRROR, so a clone still holds the"
	echo "   previous release. Commit and push the mirror, THEN run this. Nothing is"
	echo "   wrong with the build; the check was about to be aimed at the wrong one."
	exit 1
fi
echo "   both manifests name build $HERE_BUILD"
echo "── building as an outsider would"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
bash dev/build-wasm.sh >"$WORK/build.log" 2>&1 || {
	echo "FAILED — the public mirror does not build. Last lines:"
	tail -20 "$WORK/build.log"
	exit 1
}

echo "── comparing the rebuild against the sealed manifest"
node verify/check.mjs --dir www

if [ "${SKIP_HAND:-0}" = "1" ]; then
	echo "── the machine hand: skipped (SKIP_HAND=1)"
	exit 0
fi

# ── The machine hand ────────────────────────────────────────────────────
#
# Two questions, and neither of them is "are the bytes the same". The hand runs
# programs on the reader's computer, so what they need before they install it is
# that the source in their hands is the sealed source, and that it is a thing
# that actually builds.
echo "── the machine hand: is this the sealed source"
node verify/check.mjs --hand hand

echo "── the machine hand: does the published source build"
# `--manifest-path`, never `-p`: the hand is its own cargo workspace. And a
# target directory of its own under $WORK, because /tmp is a tmpfs and a cargo
# target there is held in RAM.
export CARGO_TARGET_DIR="$WORK/hand-target"
if ! cargo build --release --manifest-path hand/Cargo.toml >"$WORK/hand-build.log" 2>&1; then
	echo "FAILED — the published hand does not build. Last lines:"
	tail -20 "$WORK/hand-build.log"
	exit 1
fi
BIN="$CARGO_TARGET_DIR/release/daimond-hand"
echo "   built $(du -h "$BIN" | cut -f1) at $BIN"
echo
echo "   Not claimed: that this binary is byte-identical to anyone else's. It is not"
echo "   compared with one, because no hand binary is published and a Rust release"
echo "   build is not reproducible across toolchain versions. What is shown is that"
echo "   the published source is the sealed source and that it compiles as written."
