# ship_v1: a ship state signed by a runner's device key (UNBLOCK-160 RL1, RL2, PS4)

`vectors.json` is `{v: 1, repost_secs, skew_secs, cases: [...], refusals: [...]}`.
`repost_secs` (420, Kimberlite's re-post interval, the gateway's `ship_repost_secs`) and
`skew_secs` (120, `SIGNED_SKEW_SECS`) give the window: a post `at` further than their sum from
`now`, either way, is refused by the gateway and dropped by the page.

Every case and refusal carries the clock its replayer pins, `now` (unix seconds) and
`now_rfc3339` (most are 1762696800, 2025-11-09T14:00:00Z), and what the page does with it at that
clock: `expect` (`kept` or `dropped`) and `reason`.

Each case holds `name`, a fixed test key (`seed_hex`, `pubkey` base64url 32 bytes, never a real
device's), `device`, `install`, `nonce`, `at` (post time, unix seconds), a `body`, the exact
signed bytes `signed_hex` = `kimberlite/device/v1\0` ‖ `ship-state\0` ‖
`kimberlite-ship:v1:<device>:<install>:<nonce>:<at>:<body>` and `sig` (base64url 64 bytes).
Each body is a §5 ship state: `id` (32 hex, as `plain.rs` makes a submission id), `commit`
(40 hex), `state`, `at` (RFC 3339 UTC) and `stall_secs`; `unicode_and_escapes` adds a note with
`"`, `\` and non-ASCII.

Every entry holds `device_state` (`paired`, `pending` or `removed`). The cases are `kept`, one
(`shipping`) 400 s after its post and one (`stopped_at_window`) at the window's edge. The
refusals are `dropped`: a wrong purpose tag, another device's key, a pending or removed device, a
`:` or NUL moved, a post `at` just outside the window either side of `now`, and `aged_out`, a good
post the page still holds one second past the window.

- `gen_vectors.py` makes it with Python's `cryptography`, apart from the Rust and page code.
- Replayed by the gateway (`runner_relay.rs` `the_ship_v1_vector_verifies`, at each `now`),
  Kimberlite's keeper test (RL2) and the page's noble verify (PS4); each must agree byte for byte.
  Ed25519 is deterministic, so a signer given the seed reproduces `sig` exactly.
