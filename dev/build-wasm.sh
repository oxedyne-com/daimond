#!/bin/bash
# build-wasm.sh -- build the browser bundle so that the bytes are the same
# wherever it is built.
#
# This is THE build command for Daimond's wasm. Use it rather than calling
# wasm-pack directly, and use it for a rebuild you intend to compare against the
# published bundle: a plain `wasm-pack build` does NOT produce the sealed bytes.
#
# Why it exists. Rust bakes the path of every source file into the binary --
# `file!()` is expanded by the `err!` and panic macros throughout fe2o3, and the
# expansion is the path as rustc saw it. Built plainly, the wasm therefore
# carries the absolute paths of the machine that built it, somewhere under
# `/home/<whoever>/.cargo/git/checkouts/...`. Two people building byte-identical
# source get different wasm, and the difference is only their home directory.
#
# That quietly voided the whole verifiability claim. "Rebuild it and compare the
# hash" is addressed to a stranger, and no stranger could ever have matched it;
# it only ever succeeded for someone rebuilding on the machine that sealed it,
# which is not evidence of anything. It also meant every visitor was served the
# author's directory layout inside the wasm.
#
# The fix is to remap those prefixes to fixed stand-ins before they are baked
# in. Cargo's own `trim-paths` profile option would do this, but it is still
# nightly-only in Cargo 1.90 (the pinned toolchain), so the equivalent is done
# here with the stable `--remap-path-prefix` flag. Each builder maps THEIR
# paths to the SAME stand-ins, so the output stops depending on where they keep
# their files.
#
#   bash dev/build-wasm.sh            # the sealed build
#   bash dev/build-wasm.sh --dev      # anything else is passed to wasm-pack
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd -P)

# Where cargo unpacks dependency sources. Everything under it becomes /cargo.
CARGO_DIR=$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)

# The two prefixes that vary from machine to machine. rustc already remaps its
# own standard library to /rustc/<hash>, so those two are the whole story.
export RUSTFLAGS="--remap-path-prefix=$CARGO_DIR=/cargo --remap-path-prefix=$ROOT=/build ${RUSTFLAGS:-}"

wasm-pack build --target web --out-dir www/pkg "$@"

# ── Say what it was built from ──────────────────────────────────────────
#
# `dev/staleguard.mjs` is what decides whether a verifier is measuring THIS
# tree's engine, and with nothing to go on it can only compare clocks. An mtime
# answers a different question from the one being asked -- "was the bundle
# written after the source was?" rather than "was it built FROM this source?" --
# and the two part company whenever files are rewritten without being changed. A
# `git stash` and its `pop` restore byte-identical sources with new timestamps,
# and every wasm-guarded verifier then refuses a bundle that is in fact this
# source's. That cost a lane a rebuild it did not need on 2026-08-12.
#
# So the bundle now carries `www/pkg/source.json`: a SHA-256 per engine source
# file, plus one over the wasm itself. Two properties keep it from becoming a
# second thing to go stale. The guard REHASHES the tree in front of it rather
# than believing the note, so an edit made afterwards is caught exactly as it
# always was; and the note names the bundle it is about, so a bundle rebuilt by
# any other means stops matching and the clock takes over. It can only ever
# prevent a false refusal. It can never launder a stale bundle.
#
# It does NOT make rebuilds rare. A comment added to a Rust file moves that
# file's hash just as a changed fence does, and nothing short of compiling can
# tell those apart. What stops costing a build is source that never changed.
#
# The other half of this lives in `verify/lib.mjs`: `pkg/source.json` is in
# EXCLUDE, so the note never enters a sealed manifest. It records where and when
# a build happened, both of which differ for every honest rebuild, and sealing it
# would make "clone it, build it, compare the hash" false for every reader.
# Neither half is any use alone. `dev/repro-check.sh` proves the pair.
#
# Not fatal when it cannot be written -- an older mirror has no staleguard to
# call, and the bundle above is built and good either way. What is lost is a
# shortcut. Said out loud rather than swallowed, because a build that quietly
# stopped certifying would look exactly like one that never started.
#
# `2>&1 >/dev/null` keeps the REASON: the hash on stdout is noise here, and the
# reason is on stderr, and a failure reported without one is a second thing to
# go and find out.
if WHY=$(node dev/staleguard.mjs certify www/pkg "$ROOT" dev/build-wasm.sh 2>&1 >/dev/null); then
	echo
	echo "build-wasm: certified — www/pkg/source.json records the source this was built from,"
	echo "  so a verifier compares content rather than timestamps."
else
	echo
	echo "build-wasm: NOT CERTIFIED — no source record could be written beside the bundle, so"
	echo "  verifiers fall back to comparing mtimes. The bundle itself is built and fine."
	echo "${WHY:-  (no reason given)}" | sed 's/^/  /'
fi

# ── Say which kind of bundle this is ────────────────────────────────────
#
# The two prefixes above are the whole story ONLY in the mirror, where
# `Cargo.toml` pins fe2o3 by git revision so its sources come from under
# $CARGO_DIR. The DEV tree links fe2o3 by path, at ~/usr/code/rust/fe2o3, which is
# outside both remapped prefixes -- so every `err!` and every panic in fe2o3
# bakes this machine's home directory into the bundle, and a build made here can
# never be reproduced by a stranger.
#
# That is fine for testing and fatal for sealing, and the difference is invisible
# unless somebody thinks to look. It was NOT looked at for two releases: seq 66
# and 67 were sealed from a dev build, so for three days the transparency log
# named a bundle nobody outside this machine could produce. The check costs
# nothing, so it runs every time rather than being remembered.
#
# It greps for THIS BUILDER'S home directory, not for `/home/` generally. The
# broader pattern also matches `/home/you/project/src/main.rs`, which is a
# deliberate literal in `src/tools.rs` -- the file tools' own description, telling
# a model that an absolute path is refused rather than followed. A correct,
# reproducible mirror build therefore reported "DEV BUILD - 1 line" and would have
# been withheld from a release for a documentation example. A check that cries
# wolf on a good build gets ignored on a bad one, which is the failure this check
# exists to prevent.
BAKED=$(grep -ac "$HOME" www/pkg/oxedyne_daimond_bg.wasm || true)
echo
if [ "$BAKED" -eq 0 ]; then
	echo "build-wasm: REPRODUCIBLE — no home directory in the bundle. Safe to seal."
else
	echo "build-wasm: DEV BUILD — $BAKED line(s) of this machine's home directory are in"
	echo "  the bundle, because fe2o3 is linked by PATH here and only the mirror pins it"
	echo "  by revision. Fine to test with. DO NOT SEAL IT: build in the mirror instead,"
	echo "  per \"Deploying\" in ~/usr/SYSTEM.md, and let repro-check.sh confirm it."
fi
