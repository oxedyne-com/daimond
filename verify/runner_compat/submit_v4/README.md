# submit_v4: the submission manifest and card vectors (SUBMIT-ROUTE SR1, WP-GATE)

`vectors.json` holds two cases, each with the card's fields and bytes
(`card_hex`), `card_sha256`, the submit manifest's fields and bytes
(`manifest_hex`) and the WebAuthn `challenge` = SHA-256(manifest).

- `gen_vectors.py` encodes them independently of the Rust codec; the Rust test
  `kimberlite/tests/submit_manifest.rs` (`test_submit_v4_vectors_agree`) and the
  approve page's WebCrypto check must both agree byte for byte.
- Codes: artefact kind 1 runner, 2 page bundle; check `who` 1 fenced build
  ("this commit's tests, run in a fence"), 2 daimon-reported ("the daimon says");
  result 0 failed, 1 passed, 2 skipped.  `nets` is empty for production, or one
  name (`test`).  Object ids are full: 40 or 64 lower-case hex.
- Never edit a set to make a check green; a layout change is a new `submit_vN`.
- v2 (WP-GATE, 06 Nov) adds the write-path gate: the card's `write_paths` and
  `review`, the manifest's `write_path` byte and `failing_first` hash (zero
  unless `write_path`).  v1 was never live and is retired.
- v3 (WP-GATE 15 ruling 2) puts every pinned tree's pin in the manifest, in
  place of fe2o3's alone: `u8 p` then `p` × (name, pin), fe2o3 first, then the
  gateway's `fe2o3-gw` where the config pins it.  The card stays `card/v2`.
  v2 was never live; a v2 manifest is refused, not read.
- v4 (his D-20261106-09) moves the card to `card/v3`: a `u8 page_code` (0 no,
  1 yes) after the write paths, so the card says "touches page code that can
  reach your data" for every change to a script, document or manifest the page
  runs.  The manifest stays `submit/v3`.  v3 was never live and is retired.
- The page artefact (daimond-a's rule, WP-GATE 16): its `sha256` is SHA-256 of
  the bundle's `files.sha256` and its `size` is that file's byte size.
  `page_bundle` in `vectors.json` holds the sample `files.sha256` the page case's
  values are made from (`<sha256>  <relative path>` lines, sorted, as
  `dk ship-bundle` checks them).
