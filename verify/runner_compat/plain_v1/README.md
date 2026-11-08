# plain_v1: the plain route's card

The card Kimberlite posts for a daimon's change on the plain route (D-20261106-13 (1)), whose
SHA-256 is the challenge his passkey signs on the approve page:

    "kimberlite/plain/v1\0" || seq u64 BE || s16 repo || s16 branch || s16 commit
    || s16 summary || s16 chat || s16 diamond || u8 page_code || u8 runner_code || u8 n
    || n x (s16 name || u8 result (1 passed, 2 failed) || u32 BE runs)

`s16` is a u16 BE byte length then UTF-8; `runner_code` is 1 when the change touches Kimberlite's
own code. Layout from kimb/plainroute 64c4dd46c (v1 amended in place, unreleased); `vectors.json`
is its copy, sha256 41c2530e2617258ef43b08fc05aa33b3519d7a2b95194052ce3224f5b288af6c. `gen_vectors.py` writes `vectors.json`; Kimberlite's encoder (trust.rs) and the page's
(`www-kimberlite/kimberlite/runner.js` `plainCardBytes`) must both reproduce every `card_hex`.
