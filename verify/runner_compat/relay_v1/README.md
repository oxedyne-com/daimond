# relay_v1: the runner relay's golden exchanges (I6)

A runner release waits for the owner's tap while the gateway and web app deploy on
their own (release-key design §3.6, version skew), so the gateway must keep
serving the runner one approved version back. These files are the relay contract
that runner speaks, frozen.

- `exchanges.txt`: one exchange a line, replayed in order against a fresh relay:
  `name op method dt status query`. `op` is `main` (`/api/runner/relay`),
  `answer` (`…/answer`) or `alarm` (`…/alarm`); `dt` is seconds after the first
  exchange; `query` is `-` for none.
- `NAME.req.json`: the request body, as the runner (`hand/src/relay.rs`) or the
  pages (`www-kimberlite/kimberlite/runner.js`) send it. Empty for a GET.
- `NAME.rsp.json`: the response body: every field name, type and value (not the spacing).
- `trust.jdat`: the install the runner's `swap-request` reads (`hand/tests/data/trust_install_v2.jdat`).

Two checks replay them: the gateway test
`runner_relay::tests::the_relay_v1_golden_exchanges_still_replay` (in-process, field for
field), and `dev/runner_n1_check.sh` (over HTTP to a real gateway, `expires_in` set
aside, then the previous approved runner's own `swap-request`), which `dev/deploy.sh`
runs before every gateway or www release.

**Never edit these to make a check green.** A relay change a v1 runner would not
understand is a `relay_v2` directory and a gateway serving both, until no approved
runner speaks v1.
