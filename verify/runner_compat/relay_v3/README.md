# relay_v3: the runner relay's golden exchanges (UNBLOCK-160 RL1 r2)

relay_v3 is relay_v2 replayed against the relay route as `gateway/app.jdat` sets
it, ship config included. One response differs: the `?install=` listing
(`11_install_list`) also carries `ship_repost_secs` (the route's) and
`ship_skew_secs` (`SIGNED_SKEW_SECS`), the window by which the page drops a ship
entry. Every request, status and other response is relay_v2's, byte for byte.

A v2 runner is still served: Kimberlite never reads the listing (its one relay
GET is `?nonce=`, `kimberlite/src/relay.rs`), and the page reads only its `ok` and
`entries` (`www/js/page/pending.js`, `runnerRead`).

The files, the fixture values and the replay are relay_v2's (see its README),
with these differences:

- the gateway test `runner_relay::tests::the_relay_v3_golden_exchanges_replay`
  replays them under the `/api/runner/relay` route's config read from
  `gateway/app.jdat`, as `dev/runner_n1_check.sh` (step 2) does over HTTP;
- `11_install_list.rsp.json`'s two ship keys hold `app.jdat`'s
  `ship_repost_secs` and the gateway's `SIGNED_SKEW_SECS`, so a change to either
  is a change to this contract.

**Never edit these to make a check green.** A relay change a v3 runner would not
understand is a `relay_v4` directory and a gateway serving both, until no approved
runner speaks v3.
