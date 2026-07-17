# Daimond Verify (browser extension)

The trustworthy, always-on form of "check the code your browser is running".

The in-page check at `/verify.html` is convenient but weak: a tampered server
could serve a tampered checker. This extension cannot be tampered with that way,
because **it is installed from source, not served by the site**. On every load
of a Daimond origin it re-checks the served build against the site's own bytes
and the transparency log on GitHub — an origin the site does not control — and
colours the toolbar badge:

- **✓ green** — the code just loaded is the published source, and that build is a
  sealed entry in the public log.
- **✗ red** — it is not. Something is wrong; do not enter anything sensitive.
- **? amber** — could not be sure (usually offline, so the public log was
  unreachable).

Click the badge for the detail: which checks passed, the build id, the bundle
hash.

## What it checks

Exactly what `verify/check.mjs` checks, with the same algorithm
(`fingerprint.js` is a deliberate copy of `verify/lib.mjs`, and
`verify/verify.test.mjs` asserts they agree):

1. the served `manifest.json` is internally consistent;
2. its bundle hash is a **sealed entry in the public transparency chain** — the
   check that counts, made against GitHub;
3. every file the site served hashes to what the manifest says.

## Install (unpacked)

Chromium: `chrome://extensions` → Developer mode → *Load unpacked* → this
directory. It vouches for `daimond.oxedyne.com` (and `localhost:8777` for local
development) and nothing else, so the badge stays meaningful.

The public transparency log defaults to
`raw.githubusercontent.com/oxedyne-com/daimond/main/verify/transparency.jsonl`.
Set `chrome.storage.local` `logUrl` to point a fork or mirror at its own.

## Status

Dev/unpacked. A published build would pin a `key` (a stable id) and ship through
the browsers' stores; the checking logic is complete and tested
(`dev/verify_ext.mjs`).
