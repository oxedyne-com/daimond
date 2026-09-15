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
#   bash dev/repro-check.sh --static-only   # the www-only FAST path (no wasm rebuild)
#   bash dev/repro-check.sh --check-pin MANIFEST   # the pin assertion alone, on a fixture
#
# WHICH fe2o3, as well as which release. A deploy settles the revision once, in step
# 0f, and hands it down in `DAIMOND_FE2O3_REV`; this checks that the clone it is
# about to build is pinned exactly there. The clone is a fresh checkout of whatever
# the mirror last committed, and a carve run by hand in between -- against an fe2o3
# that had moved -- would put a different revision in it, so the release that shipped
# and the release that was reproduced would be built from two different libraries
# while both reported green. Set nothing and the check is skipped, which is what an
# ordinary hand-run of this script wants.
#
# `--static-only` is for `deploy.sh`'s www-only fast path. The wasm is UNCHANGED
# and was reproduced by an outsider when it first shipped -- deploy.sh's
# discriminator has re-proven the inputs are still byte-identical -- so this does
# NOT recompile it. It clones the committed mirror, drops the reused pkg (the exact
# bytes deploy.sh already verified against the seal) into the clone, and runs
# `verify/check.mjs` with no build. Every covered file is then verified either as a
# previously-reproduced wasm byte or as a static byte, against the release's own
# sealed manifest and chain. The hand is source-checked but not rebuilt (a www-only
# release does not touch it). It proves the new bundle matches its seal; it does
# NOT re-prove the wasm is outsider-reproducible, because that was proven when the
# wasm first shipped and nothing about it has changed.
#
# Slow and disk-hungry by nature, so it is not part of `run_all.sh`. Run it at
# release, which is the only time its answer can change.
set -e

# Every fe2o3 revision a manifest pins, one per line, however many crates name it.
manifest_revs() {
	grep -E '^[[:space:]]*oxedyne_fe2o3_[a-z_]+[[:space:]]*=' "$1" 2>/dev/null \
		| sed -n 's/.*\brev[[:space:]]*=[[:space:]]*"\([0-9a-f]*\)".*/\1/p' | sort -u
}

# Refuse a manifest pinned anywhere but where this run said. A no-op when the run
# recorded nothing, so a hand-run of this script behaves exactly as it always did.
pin_matches_or_die() {
	local what="$1" man="$2" revs n
	[ -n "${DAIMOND_FE2O3_REV:-}" ] || return 0
	[ -f "$man" ] || { echo "FAILED — $what has no Cargo.toml at $man to check the fe2o3 pin in."; exit 1; }
	revs="$(manifest_revs "$man")"
	n=$(printf '%s\n' "$revs" | grep -c '[0-9a-f]' || true)
	if [ "$n" = 0 ]; then
		echo "FAILED — $what pins no fe2o3 revision at all ($man)."
		echo "   This run pins ${DAIMOND_FE2O3_REV:0:12}, and the thing about to be built names nothing."
		exit 1
	fi
	if [ "$revs" != "$DAIMOND_FE2O3_REV" ]; then
		echo "FAILED — $what is pinned to a different fe2o3 than this run."
		echo "   this run pins:   $DAIMOND_FE2O3_REV"
		printf '   the clone pins:  %s\n' $revs
		echo
		echo "   The release that ships and the release that is reproduced would be built from"
		echo "   two different libraries, both of them reporting green. Carve again with this"
		echo "   run's revision, commit the mirror, then check."
		exit 1
	fi
	echo "   $what pins fe2o3 ${DAIMOND_FE2O3_REV:0:12}, as this run settled in step 0f"
}

STATIC_ONLY=0
case "${1:-}" in
	--static-only) STATIC_ONLY=1 ;;
	# The assertion alone, against a manifest a test wrote, so `dev/verify_deploy.mjs`
	# proves this code and not a copy of it.
	--check-pin) pin_matches_or_die "the fixture" "${2:?repro-check: --check-pin wants a manifest path}"; exit 0 ;;
	'') ;;
	*) echo "repro-check: unknown argument '$1'" >&2; exit 2 ;;
esac

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
# --no-local: a path clone copies loose objects one by one, and the commit that
# step 3b just made runs `gc --auto` detached in the mirror, which packs and
# deletes those objects mid-copy (2026-09-12: "failed to copy file ... objects/91/…").
# The pack transport reads a consistent snapshot.
git clone -q --no-local "$MIRROR" "$WORK/a/deeper/nested/clone"
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

# …and WHICH fe2o3 the clone is pinned to, when the run has settled one. The hand's
# manifest is the one the carve derives, so it is the one that can have been carved
# against a moved HEAD; the root manifest is the mirror's own hand-maintained file
# and is reported rather than refused, since it is the wasm's pin and moves on a
# human's say-so.
pin_matches_or_die "the clone's hand" hand/Cargo.toml
if [ -n "${DAIMOND_FE2O3_REV:-}" ]; then
	printf '   the clone'"'"'s root Cargo.toml pins: %s\n' $(manifest_revs Cargo.toml)
fi
if [ "$STATIC_ONLY" = 1 ]; then
	# The www-only fast path: reuse the wasm rather than rebuild it. The clone is a
	# fresh checkout of the committed mirror, so it carries the new static www and
	# manifest but not www/pkg (gitignored). Drop in the reused pkg -- the exact
	# bytes deploy.sh already verified against the recorded provenance AND the sealed
	# manifest -- so check.mjs sees the whole covered surface.
	echo "── static-only: reusing the wasm (no rebuild), dropping in the reused pkg"
	mkdir -p www/pkg
	cp -a "$DEV/www/pkg/." www/pkg/
else
	echo "── building as an outsider would"
	rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
	bash dev/build-wasm.sh >"$WORK/build.log" 2>&1 || {
		echo "FAILED — the public mirror does not build. Last lines:"
		tail -20 "$WORK/build.log"
		exit 1
	}
fi

echo "── comparing the bundle against the sealed manifest and chain"
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

if [ "$STATIC_ONLY" = 1 ]; then
	# A www-only release does not touch the hand, so its source seal is checked
	# above but its (expensive, non-byte-compared) native build is not repeated.
	echo "── the machine hand: build skipped (static-only; hand source unchanged)"
	exit 0
fi

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
