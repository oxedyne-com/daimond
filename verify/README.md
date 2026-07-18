# Verifying Daimond

Daimond's privacy claim is meant to be **checked, not trusted**. The client is
open source, it rebuilds byte-for-byte from that source, and every shipped build
is sealed in a public, tamper-evident log. So you can confirm three things
yourself, with no need to take anyone's word:

1. **The source is public** — read it.
2. **The running site is that source** — build it and compare the hashes.
3. **That build was really published** — check it is a sealed entry in the log.

This directory is the machinery for (2) and (3).

## Check the running site (the honest way)

```sh
git clone https://github.com/oxedyne-com/daimond
cd daimond
rustup target add wasm32-unknown-unknown
wasm-pack build --target web --out-dir www/pkg   # rebuilds the wasm from source
node verify/check.mjs --url https://daimond.oxedyne.com
```

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

## Sealing a build (maintainers, at deploy time)

Run after building the wasm and before the files leave for the server:

```sh
wasm-pack build --target web --out-dir www/pkg
node dev/stamp-build.mjs      # www/build.json  — the staleness id + a note
node verify/manifest.mjs      # www/manifest.json + a transparency-log entry
# commit verify/transparency.jsonl and www/manifest.json, then deploy www/
```

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

Reproducibility is verified on the pinned toolchain (fe2o3 at a fixed revision).
Byte-identical output across widely different Rust/wasm-pack versions is not
guaranteed and is the next hardening step; today, build with the toolchain the
`README` pins.
