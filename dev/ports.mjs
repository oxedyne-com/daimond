// ports.mjs — the bindings that used to be fixed for the whole machine, read
// from the world that owns them.
//
// `dev/world.sh` holds the port register and says why it exists. Three of its
// rows were, until 2026-08-25, in a paragraph headed "fixed, and shared by every
// world": the gateway, the IMAP fixture and the submission stand-in. Nineteen
// files in `dev/` held the literal `http://127.0.0.1:9002` between them, each
// having decided for itself that the gateway is at a fixed address.
//
// It is not, and the cost was measured in lane-afternoons rather than in calls.
// `dev/serve.mjs` proxied EVERY world's `/api` to 9002, so which gateway a
// verifier read was whichever lane happened to have one up: `verify_attachfocus`
// and `verify_chatworkspace` went red four runs out of six on a tree nobody had
// changed, and both answered it by excluding 401 from their console check --
// a remedy per file, which is how four files came to have one and two did not.
// `dev/pro.mjs` posted a signed Pro webhook at a stranger's gateway the same day,
// which answered 500: the suite read that as "entitled accounts ready: no" and
// skipped two verifiers, and the stranger was sent a licence event for an account
// it had never heard of.
//
// So this is the one place that answers "where is it". A twentieth file cannot
// decide the question differently again without deleting this line.
//
// THE FALLBACKS ARE THE HISTORICAL PORTS AND THAT IS NOT AN OVERSIGHT: a server
// started by hand in no world should still find a fixture started by hand in no
// world. Under a world every one of these variables is set, and the gateway's is
// never set to 9002 -- see `dev/world.sh`, which explains why that port belongs
// to nobody.

/// The port this world's gateway listens on, or would if it had one.
export const GW_PORT = Number(process.env.DAIMOND_GW_PORT || 9002);

/// The gateway's base URL — no trailing slash, so `${GW_URL}/api/health` reads
/// the way every call site already wrote it.
export const GW_URL = `http://127.0.0.1:${GW_PORT}`;

/// fe2o3's `imap_test_server`, which takes its port as its first argument.
export const IMAP_PORT = Number(process.env.DAIMOND_IMAP_PORT || 1143);

/// `dev/smtpd.mjs`, the submission stand-in that catches what is sent.
export const SMTP_PORT = Number(process.env.SMTPD_PORT || 1587);
