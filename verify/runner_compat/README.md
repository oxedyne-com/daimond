# runner_compat: the runner relay's golden exchanges

- **`relay_v3/`** is the contract the gateway serves and the gate replays: the
  gateway test `runner_relay::tests::the_relay_v3_golden_exchanges_replay`, under
  the relay route's config in `gateway/app.jdat`, and `dev/runner_n1_check.sh`
  (step 2). It is relay_v2 with `ship_repost_secs` and `ship_skew_secs` in the
  `?install=` listing (UNBLOCK-160 RL1 r2), which no runner reads.
- **`relay_v2/`** is still served, to a route with no ship config, and still
  replayed by `runner_relay::tests::the_relay_v2_golden_exchanges_replay`. Its
  files are kept untouched.
- **`relay_v1/`** is history. Its files are kept untouched, but its replay has
  left the gate and the gateway no longer serves it: relay_v1 let anyone answer
  or alarm an entry (QA-B 2), and no runner was ever approved under it, so there
  is no runner one approved version back that speaks it (lead ruling, 2026-10-23).

From relay_v2 on, the rule in each set's README holds: never edit a set to make a
check green; a change a runner at that version would not understand is a new
`relay_vN` directory, served beside the old one until no approved runner speaks it.
