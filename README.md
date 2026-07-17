# Daimond

The browser-first agentic workspace. A chat interface and a coworker in one
tab: it talks to any OpenAI-compatible model with your own key, keeps your
chats and files on your device, and can act through a small set of tools.
Live at [daimond.app](https://daimond.app).

This repository is the **Daimond client**: the exact code that runs in your
browser. It is published so that the privacy claim can be *checked* rather than
merely trusted.

## Why this is open

Everyone can say "private". The only version of that claim a competitor cannot
neutralise by saying the same words is one you can verify for yourself. So the
part of Daimond that decides what leaves your device is open, readable, and
buildable from source.

The client encrypts your work before anything is sent, holds your keys on your
device, and talks to your chosen model provider directly with your own key. The
server, by design, only ever receives ciphertext. That is what makes "we cannot
read your work, we do not have the key" true, and this repository is the
evidence for it.

## What you can verify, and what you cannot

Being honest about the boundary is the whole point, so:

**You can verify (client-side, from this repository):**

- Your work is encrypted on your device before it is sent.
- Your encryption key is never transmitted.
- With your own provider key, requests go straight to the provider; the
  gateway is not in that path.
- Only ciphertext crosses the wire to Daimond's gateway. Read the code, build
  it, and watch your browser's network panel to confirm it.

**You cannot verify (and nobody can, of anyone's server):**

- What a remote server actually does internally. No published source proves
  what code a server is running.
- The brokered services, web fetch, mail, and metered credit inference,
  genuinely transit the gateway in a form it can act on. Those are a matter of
  published policy and audit, not cryptographic proof.

So "nothing ever leaves your device" would be an overclaim. The accurate strong
claim is: **with your own key, your chats and files never leave in the clear,
and you can watch only ciphertext leave.**

## What is here, and what is not

This repository is the client only:

- `src/` — the Rust client. The same crate compiles to the browser via
  WebAssembly (`wasm32`) and to a native library. The wasm build is the code
  that runs in your browser.
- `www/` — the served front end: HTML, CSS, JavaScript, and the built wasm.
- `ext/` — the browser extension that checks the running page against this
  source (the delivery-integrity check).
- `dev/` — the headless test and verification harness, so you can reproduce the
  checks rather than take them on faith.
- `examples/` — a native smoke test of the agent loop.

The **gateway (the server) is deliberately not here.** It is the commercial
layer (metering, checkout, licensing), and, more importantly, opening it would
add nothing to what you can verify: you do not trust the server, you verify the
client never hands it anything readable. A verifiable client that emits only
ciphertext makes the server untrusted by design.

## Licence

Daimond is released under the **Functional Source License, version 1.1, with an
Apache 2.0 future grant (`FSL-1.1-Apache-2.0`)**. In short:

- You may read, build, run, modify, and share the code freely.
- You may not use it to ship a competing commercial product.
- Two years after each version is published, that version converts to the
  Apache License 2.0.

The full text is in [`LICENSE`](LICENSE). The intent is to give complete
verifiability without handing a copycat a ready-made competitor.

## Build from source

Prerequisites:

- A recent stable Rust toolchain (`rustup`).
- The WebAssembly target: `rustup target add wasm32-unknown-unknown`.
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

The client depends on the [Hematite (fe2o3) library](https://github.com/oxedyne-com/fe2o3),
which is pulled in automatically as a git dependency pinned to a fixed revision,
so the same source always yields the same build. You do not need to clone fe2o3
separately.

Build the browser bundle:

```bash
wasm-pack build --target web --out-dir www/pkg
```

Build and check the native library (validates the non-browser half of the
crate):

```bash
cargo build
```

## Run it locally

`www/` is a static bundle. Serve it over a secure context (needed for the
on-device filesystem) with the bundled launcher:

```bash
node dev/serve.mjs      # serves www/ on http://localhost:8777
```

The browser-only tiers (chat with your own key, on-device storage) work with no
server at all. The gateway-backed features (metered credits, mail, web fetch)
call an `/api` endpoint; without a gateway running, those calls simply fail and
the rest carries on.

## Verifying the running site

The claim "the code my browser runs is the source in this repository" is
checkable, not asked on trust. The build is byte-reproducible: rebuild the wasm
and it matches, hash for hash.

    wasm-pack build --target web --out-dir www/pkg
    node verify/check.mjs --url https://daimond.oxedyne.com

Green means every file the site served hashes to `www/manifest.json`, and that
bundle is a sealed entry in the append-only, hash-chained
`verify/transparency.jsonl` — so a build cannot be slipped to one person without
appearing in the public record. `node verify/check.mjs --dir www` checks a local
build instead; `/verify.html` runs the check in the browser; and the
`verify/ext/` extension does it automatically on every load, from installed code
the server cannot tamper with. (`ext/`, separately, is Daimond Hands, the
extension that lets the agent drive a real page.) The fingerprint is defined once
in `verify/lib.mjs`, and `node verify/verify.test.mjs` proves the three
implementations agree. See `verify/README.md`.

An independent third-party audit is the remaining step.

## About

Daimond is built by [Oxedyne](https://oxedyne.com) on the open-source
[Hematite (fe2o3)](https://github.com/oxedyne-com/fe2o3) library. It is bought
once and improves forever; there is no consumer subscription.
