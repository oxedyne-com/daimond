# relay_v2: the runner relay's golden exchanges (QA-B 2)

relay_v2 closes relay_v1's open answer and alarm paths. Every install request
carries `alarm_hash` (SHA-256 of a key only the runner holds), and a release also
its `challenge` (its manifest's). An enrolment carries no challenge: the relay
checks each enrol answer by recomputing SHA-256(ENROL_DOMAIN ‖ 0x01 ‖ install ‖
SHA-256(spki)) from the entry's install and the answer's own spki. A request
missing a required field is refused by the field's name. An entry keeps up to 4
answers over its challenge, one a source, under `answers`; an alarm needs the key;
the `?install=` listing shows each entry's nonce and flags alone.

- `exchanges.txt`: one exchange a line, replayed in order against a fresh relay:
  `name op method dt status query`. `op` is `main` (`/api/runner/relay`),
  `answer` (`…/answer`) or `alarm` (`…/alarm`); `dt` is seconds after the first
  exchange; `query` is `-` for none.
- `NAME.req.json`: the request body, as the runner (`kimberlite/src/relay.rs`,
  `kimberlite/src/enrol.rs`) or the pages (`www-kimberlite/kimberlite/runner.js`)
  send it. Empty for a GET.
- `NAME.rsp.json`: the response body: every field name, type and value (not the spacing).
- `trust.jdat`: the install the runner's `swap-request` reads (the same file as relay_v1's).

Fixture values: the install is 0x22 × 16 and the enrol spki the bytes 0..=0x5a,
the KS-g1 vector (`kimberlite/tests/data/enrol_v1_vector.json`), so
`13_enrol_answer`'s challenge is that vector's `proof_hex`. The release challenge
is an arbitrary 32 bytes: the relay matches it, it does not rebuild it. The alarm
key is `relay-v2-fixture-alarm-key`.

Two checks replay them: the gateway test
`runner_relay::tests::the_relay_v2_golden_exchanges_replay` (in-process, field for
field), and `dev/runner_n1_check.sh` (over HTTP to a real gateway, `expires_in` set
aside, then the previous approved runner's own `swap-request`), which `dev/deploy.sh`
runs before every gateway or www release.

**Never edit these to make a check green.** A relay change a v2 runner would not
understand is a `relay_v3` directory and a gateway serving both, until no approved
runner speaks v2.
