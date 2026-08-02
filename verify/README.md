# Verifying Daimond

Daimond's privacy claim is meant to be **checked, not trusted**. The client is
open source, it rebuilds byte-for-byte from that source, and every shipped build
is sealed in a public, tamper-evident log. So you can confirm three things
yourself, with no need to take anyone's word:

1. **The source is public** — read it.
2. **The running site is that source** — build it and compare the hashes.
3. **That build was really published** — check it is a sealed entry in the log.

This directory is the machinery for (2) and (3).

The **machine hand** — the program outside the page that runs commands on your
computer — is published too, and is sealed by a weaker check that is set out in
full under [The machine hand](#the-machine-hand). Read that section before
building and installing it. Nothing on this page claims the hand's binary is
reproducible, because it is not.

## Check the running site (the honest way)

```sh
git clone https://github.com/oxedyne-com/daimond
cd daimond
rustup target add wasm32-unknown-unknown
bash dev/build-wasm.sh                           # rebuilds the wasm from source
node verify/check.mjs --url https://daimond.oxedyne.com
```

Use `dev/build-wasm.sh`, not `wasm-pack` directly. Rust bakes the path of every
source file into the binary, so a plain build stamps your own home directory
into the wasm and the hashes then cannot match anyone else's. The script maps
those paths to fixed stand-ins first, which is what makes your rebuild and the
published build comparable at all. It is a two-line script -- read it.

Green means: every file the site served hashes to what the manifest says, the
manifest's bundle hash is the hash of its own file list, and that bundle is a
sealed entry in an unbroken chain in `verify/transparency.jsonl`. Red names
exactly what differs. The verifier trusts nothing the server says beyond the
bytes it serves — the authority is the source you cloned and the log in this
repo.

Being in the chain proves a bundle was published at some point, not that it is
the one meant to be live now — so a server could serve an older, still-sealed,
still-green build (a roll-back). By default that is reported as a warning; add
`--latest` to fail unless the served build is the chain's tip, or `--expect
<bundlehash>` to fail unless it is exactly the build you name.

You can also check a local build directly (`node verify/check.mjs --dir www`),
and there is an in-browser check at `/verify.html` on the running site — handy,
but weaker, because a tampered server could tamper with that page too. Its one
load-bearing check is against the public log on GitHub, an origin the site does
not control.

## How a build is fingerprinted

- **File hash** — SHA-256 of the file's bytes.
- **Manifest** (`www/manifest.json`) — a file hash for every served file of
  Daimond's own code (JS, CSS, HTML, and the `pkg/` wasm), plus one **bundle
  hash** over them all. `vendor/` (the third-party Typst tooling) is excluded:
  it is not built from Daimond's source and carries its own integrity story.
- **Transparency log** (`verify/transparency.jsonl`) — an append-only chain, one
  entry per release, each `entry` hash covering the entry before it. Rewriting
  any past release breaks every entry after it, and the file's git history is
  public, so the history is tamper-evident.

`verify/lib.mjs` is the single definition of this algorithm; the browser's
`www/js/verify.js` recomputes the identical fingerprint with Web Crypto, and
`verify/verify.test.mjs` asserts the two agree.

## The machine hand

Daimond can run a real command on your computer — `cargo test`, a build, a
script. A web page cannot start a program, so that capability lives in a small
separate program, the **hand**, which your browser starts on the extension's
behalf and which runs each command inside a kernel fence. It is the most
dangerous thing Daimond does, and until 2026-08-02 it was the one component that
was not published, so it was also the only one you could not check. It is
published now: `hand/` in this repository.

Check your copy is the one that was sealed:

```sh
node verify/check.mjs --hand
```

**What that proves.** Every file under `hand/` hashes to what `verify/hand.json`
records, and that seal is committed to this repository, so its history is public
in the same way the transparency log's is. The seal also names the toolchain
(`rust-toolchain.toml`) and the exact command that turns the source into the
binary. Together: *the source you are about to build is the source the maintainer
sealed for this release, and this is how it is built.*

**What it does not prove, and will not.**

- **Nothing about a binary.** No hand binary is published, signed or hashed. You
  build your own from the source you just checked, with `cargo build --release
  --manifest-path hand/Cargo.toml`. If somebody hands you a `daimond-hand`
  binary, nothing here says anything whatever about it.
- **Not reproducible.** A Rust release binary is not byte-identical across
  toolchain versions, and this project has not demonstrated that it is identical
  even within one. The wasm bundle's reproducibility was *measured* — two builds,
  two directories, two cargo homes, compared — and until it has been measured for
  the hand there is no such claim to make. Building the same source twice on the
  same machine and getting the same bytes would prove nothing anyway: that is the
  one arrangement guaranteed to agree with itself.
- **`hand.json` is not chained.** The transparency log chains its entries, so a
  rewritten past release breaks every entry after it. `hand.json` has no such
  chain: it is one file per release, and what protects it is this repository's
  public history and nothing more. That is weaker, and it is stated rather than
  blurred by putting a hash into the chained log where a reader would assume the
  chain covered it.
- **Not a security review.** That the source is genuine says nothing about
  whether the fence in it holds. The hand's own `README.md` sets out what it does
  and does not guarantee; read it before installing.

The release check (`dev/repro-check.sh`) also **builds** the published hand from
a fresh clone. That is not a reproducibility check — it is the check that the
published source compiles at all for somebody who is not the author, which is
exactly what a `path` dependency into the author's home directory silently broke
for the wasm between 2026-07-21 and 2026-07-27. The hand's `Cargo.toml` pins
fe2o3 by git revision for the same reason, and `dev/publish.mjs` refuses to carve
a revision that has not been pushed.

## Sealing a build (maintainers, at deploy time)

Run after building the wasm and before the files leave for the server:

```sh
node dev/publish.mjs          # carve the public mirror, hand/ included
bash dev/build-wasm.sh        # in the PUBLIC tree — see below
node dev/stamp-build.mjs      # www/build.json  — the staleness id + a note
node verify/hand.mjs          # seal the carved hand → verify/hand.json
node dev/publish.mjs          # carry hand.json across (one file)
node verify/manifest.mjs      # www/manifest.json + a transparency-log entry
# commit verify/transparency.jsonl, verify/hand.json and www/manifest.json,
# then deploy www/
```

The carve runs twice, and that is not a slip. `verify/hand.mjs` seals **the
public tree's** hand, because that is the one a stranger builds — this tree's
`hand/Cargo.toml` depends on fe2o3 by path, into a working copy that exists on no
machine but the author's, and sealing it would seal a manifest nobody outside can
build. So the seal has to come after a carve, and its output has to be carried
across by another. `verify/hand.mjs` also regenerates the mirror's
`hand/Cargo.lock` against the mirror's own git pin, which is why that lock is one
of the files the mirror owns.

**Seal the build a stranger can reproduce, which is the one built in the public
tree.** Development builds fe2o3 as a path dependency out of a neighbouring
working copy; the public tree pins it by git revision. The two are different
builds of the same source and they do not agree hash for hash, so a bundle
sealed from a development build is one that nobody outside can ever match. Build
the wasm in the public tree, copy `www/pkg/` from there, and seal that.

`manifest.json` is a pure function of the bundle (no timestamps), so an
identical build seals identically; redeploying an unchanged bundle does not add
a duplicate log entry. Commit the log — it is the public record the whole claim
rests on.

## What this does and does not prove

It proves the bytes a site served are a published, unmodified Daimond release,
and (because the build is reproducible) that those bytes are the public source.
It does **not** vouch for a remote server's internals: web fetch, mail and
metered-credit inference genuinely transit the gateway, which is a matter of
published policy and audit, not of this cryptographic check. "With your own key,
your chats and files never leave in the clear, and you can watch only ciphertext
leave" is the client-side claim this makes checkable.

## What reproducibility here does and does not cover

Verified, by building the same source twice in two different directories with
two different cargo homes and comparing: **the output does not depend on where
it is built, or by whom.** That is the property the claim needs, and until
2026-07-27 it did not hold -- absolute build paths went into the wasm, so the
hashes only ever matched for someone rebuilding on the machine that sealed them.
Anyone else who checked would have seen a mismatch and had no way to tell it
from a tampered server.

Not covered: **different toolchain versions.** Byte-identical output is
established only within one rustc and wasm-pack version, so build with the ones
`rust-toolchain.toml` and the `README` pin before concluding that a mismatch
means anything. Making the build stable across toolchain versions is a further
step, and is not claimed.

Also not covered: **the machine hand.** Everything in this section is about the
wasm bundle the browser runs. The hand is a native binary and none of it applies
to one — see [The machine hand](#the-machine-hand) for what is claimed there
instead, which is less.
