// verify_conformance.mjs — does the live Oregami forge answer the Improve-panel
// contract, on the repository the product actually names?
//
// THE AUTHORITY IS NOT THIS FILE. It is
//   ~/usr/complement/projects/oxedyne/projects/ore/doc/design/improve_panel_contract.md
// and where the two disagree, the contract is right and this file is a bug. Every
// check below carries the sentence it rests on, printed beside it when it fails and
// listed in full by `--cites`.
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────────
//
// A conformance run against the live forge was performed on 2026-08-13 and reported
// "31 passed, 0 failed". THE SCRIPT WAS NEVER COMMITTED. It is in no tree, so the
// number has been quoted forward through three handovers as though a standing
// instrument produced it, and nobody since has been able to re-run it, read what it
// asserted, or point at what it was aimed at. A result nobody can reproduce is a
// claim, not evidence. This file is the instrument those numbers claimed.
//
// It is also the instrument the same day proved was needed. Contract §3.3: the panel
// had never worked in production, the forge held three repositories and the panel's
// was not one of them, every route answered `absent` correctly, and thirty-one checks
// stayed green — because they were pointed somewhere else.
//
// ── THE SUBJECT RULE, §3.3, WHICH IS WHY THIS FILE IS SHAPED AS IT IS ────────────
//
//   "So the rule: the suite takes its subject from the client's own configured
//    constant, and pointing it anywhere else is an explicit act. A subject supplied
//    on the command line will be pointed at whatever passes, and it will be pointed
//    there by the person with the most reason to want a green result."
//
// So THERE IS NO `--account` AND NO `--repo`. The subject is read out of
// `www/js/improve.js`, from the same two lines the browser reads it from, and if
// those lines cannot be found this file exits 2 rather than guessing. Rename the
// constant in the client and this instrument stops, loudly, instead of quietly
// measuring something else.
//
// ── THE SPLIT, ruled by the Oregami session 2026-08-15 (§3.3) ────────────────────
//
//   "Reads take the constant; writes take a sandbox derived from it. ... the read
//    checks resolve the client's constant and assert it answers; the success paths of
//    the write checks go to a sandbox; and the write checks aimed at the product's
//    repository are the refusal paths, which resolve the route and the credential
//    rule and change no state. The sandbox is a second compiled-in constant and never
//    a command-line argument, for the reason the subject is not one."
//
//   READ checks           -> the client's constant. A read leaves nothing behind, and
//                            SOME check has to ask about the repository the product
//                            actually names. That is the check the 31 never made.
//   WRITE checks that pass -> `oxedyne/conformance`, the sandbox. A second compiled-in
//                            constant, below, for the same reason the subject is not
//                            an argument.
//   WRITE checks aimed at  -> the REFUSAL paths only: bad credential, credential in
//   the client's constant     the body, absent `d`, wrong role. They resolve the route
//                            and exercise the credential rule against the real target
//                            and change no state.
//
// The reason for the split, and it is worth keeping in view: a proposal is a file
// beside the repository rather than an Ore operation (§8), so a probe write COULD be
// removed afterwards — and a backlog that has been tidied is worse evidence than one
// that was never polluted.
//
// The refusal probes are still writes, and a forge that wrongly accepted one would
// leave a record. So every probe body this file sends to the subject says so in its
// own title: if one ever appears in the backlog, it names the fault that put it
// there rather than looking like a tester's report.
//
// ── WHAT IT TALKS TO ─────────────────────────────────────────────────────────────
//
// THE FORGE, DIRECTLY, over loopback — not `/api/improve`. §3's routes are the
// forge's, and the gateway in front of them answers 401 to anything without a
// Daimond session (§3, "A public read needs no voice, but it does need a Daimond
// session"), which would stand between this instrument and its subject. So this file
// says NOTHING about the gateway half of the path; that is `dev/verify_improve.mjs`'s
// lane, and neither run substitutes for the other.
//
// Every request is built and read by hand over a socket (`node:net` / `node:tls`)
// rather than through `fetch`. Not fussiness: undici NORMALISES header values, so a
// credential of three spaces reaches the wire as an empty one, and three of §3.1's
// credential spellings would silently become one probe repeated. An instrument that
// cannot put the bytes on the wire must not report as though it did. The same client
// is what lets `?format=json&x=%zz` be sent literally, which §3.2's raw-query rule
// cannot be tested without.
//
// ── WHAT THE ORCHESTRATOR MUST SUPPLY ────────────────────────────────────────────
//
//   ORE_FORGE          Base URL of the forge, e.g. `http://127.0.0.1:8430`. Optional:
//                      without it the default is read from `gateway/app.jdat`'s
//                      `forge_host` and `forge_port`, which is where the gateway
//                      itself reads the forge's address from.
//   ORE_VOICE          A secret for a voice provisioned on the SUBJECT repository with
//                      at least `pull`. Read-only in effect: it is used for the voiced
//                      READ checks and for refusal probes whose ordering is only
//                      defined once the credential is good. It never makes a write to
//                      the subject that could succeed.
//   ORE_VOICE_READER   A secret for a voice on the SUBJECT repository whose role is
//                      BELOW `pull`. Without it `unpermitted` cannot be provoked and
//                      that check is skipped rather than faked.
//   ORE_VOICE_SANDBOX  A secret for a voice with at least `pull` on the SANDBOX
//                      repository. Without it every write-success check is skipped.
//
// A secret may instead sit in a file, one `NAME=value` per line, `#` starting a
// comment, passed as `--voices <path>`; the environment wins over the file. NO
// CREDENTIAL IS WRITTEN IN THIS FILE, as a default or otherwise (CLAUDE.md, and the
// leak of 2026-07-10). Nothing this file prints carries a secret either: every line
// of output goes through `redact()`.
//
// Each supplied voice is CHECKED FOR RECOGNITION before it is relied on, by a read
// that must not answer `unknown`. A credential the forge does not know would turn
// every check that used it red for a reason that is not the forge's — which §3.3
// names as the failure that cost fourteen checks in one run.
//
//   ORE_FORGE=http://127.0.0.1:8430 ORE_VOICE=... node dev/verify_conformance.mjs
//   node dev/verify_conformance.mjs --voices /run/ore/voices.env
//   node dev/verify_conformance.mjs --cites        # every check and its sentence
//   node dev/verify_conformance.mjs --why-not      # the reason it cannot run, or silence
//
// ── STANDING ONE UP LOCALLY, WHICH IS WRITTEN DOWN BECAUSE IT WAS NOT ────────────
//
// Run with nothing prepared, this file dies at A1 on `ECONNREFUSED 127.0.0.1:8430`,
// and three sessions in a row read that as "unrunnable". It is not: it is a forge
// that is not up, and the whole of §3.3's argument is that a result nobody can
// reproduce is a claim rather than evidence. So, once, in full. `oregami` is at
// `~/usr/code/web/apps/oxedyne/oregami`; `$B` is its binary.
//
//   ./server start                                  # the forge, on :8430
//   ./server stop                                   # `voice` and `create` will not
//                                                   # run while `serve` holds the
//                                                   # records, and say so
//   $ORE init                                       # anywhere; prints a signing key
//   $B create oxedyne/daimond --owner <key> --public --app .
//   $B voice oxedyne/daimond    <person> pull --app .   # -> ORE_VOICE
//   $B voice oxedyne/conformance <person> pull --app .  # -> ORE_VOICE_SANDBOX
//   ./server start
//
// `oxedyne/daimond` is NAMED in the forge's `app.jdat` and is not on disk until
// somebody creates it, which is the 2026-08-14 fault in miniature: the panel names
// a repository the forge does not serve, A1 says so, and every check aimed
// elsewhere still passes. A1 going red on a bare local forge is this file working.
//
// THE SUBJECT MUST THEN HOLD A FEW PROPOSALS or a dozen read checks skip and B4
// fails on nothing to read: `POST /oxedyne/daimond/proposals` with the subject
// voice, three times, is enough. Those are LOCAL FIXTURE proposals in a LOCAL
// repository; the §3.3 rule against writing to the subject is about the product's
// real backlog on the live forge, and nothing here may be run against that.
//
// Measured on 2026-08-17 with exactly the above: 59 passed, 0 failed, 12 skipped.
//
// ORE_VOICE_READER CANNOT BE PROVISIONED ON THIS FORGE, so E13 is a permanent skip
// rather than a fixture somebody should go and build. It wants a voice the forge
// recognises whose role is BELOW `pull`, and oregami's ladder is Pull, Push, Admin
// (`oregami/src/voice.rs`, `Role::covers`) -- `pull` IS the floor, so there is no
// such role to grant. Provoking `unpermitted` needs the forge to grow one, or a
// route with a higher floor than the vote's. Said here so the next reader does not
// spend an afternoon looking for the flag.
//
// G6 READ BY EYE, once, since a throttle finally arrived: the sentence is "Too many
// requests from this voice. Wait, then try again." It names the voice and does not
// name which allowance was spent, which is what §3.1 requires. Recorded rather than
// turned into a check, because the check would have to invent the word list it
// searched for -- §3.3's third and worst shape.
//
// ── EVERY CHECK IS PROVED RED, AND THE MEANS SHIPS IN THIS FILE ──────────────────
//
//   A CHECK THAT WILL NOT GO RED IS A FINDING, NOT A FIXTURE PROBLEM.
//
// Chase it until it is explained. A break that stays green usually means a different
// rule is quietly holding the property and the check under test never ran at all.
//
// A suite that cites a sentence per check and never reddens is indistinguishable from
// a suite that works, which is the failure one level above the one this file exists to
// fix: "31 passed" was a true sentence about the wrong repository and nobody could
// tell. So `--break <name>` corrupts THE ANSWER between the socket and the assertions
// — the response, not the source, because the forge is not ours to damage and the
// thing under test here is what this file does with what it is handed.
//
//   node dev/verify_conformance.mjs --break wrongstatus   # -> G3
//   node dev/verify_conformance.mjs --break nokey         # -> A2
//   node dev/verify_conformance.mjs --break novotes       # -> A7  (and A8 becomes a skip)
//   node dev/verify_conformance.mjs --break nullvotes     # -> A8
//   node dev/verify_conformance.mjs --break leak403       # -> D5 AND D6, on purpose
//   node dev/verify_conformance.mjs --break bodyvoice     # -> E9
//   node dev/verify_conformance.mjs --break trimmed       # -> E2 AND A10, on purpose
//   node dev/verify_conformance.mjs --break mineleak      # -> A9
//   node dev/verify_conformance.mjs --break emptyceiling  # -> B4
//   node dev/verify_conformance.mjs --break charset       # -> G1
//   node dev/verify_conformance.mjs --break noncanonical  # -> G5
//   node dev/verify_conformance.mjs --break clamped       # -> B6 AND B7, on purpose
//
// A run with `--break` EXPECTS to fail: it exits 0 when something reddened and 1 when
// nothing did, so "the break changed nothing" is itself a failing run.
//
// EACH BREAK IS SCOPED TO SURVIVE EVERY CHECK BUT THE ONE IT PROVES, and the sharper
// form of that rule is the one that bit this file in the writing: A BREAK CAUGHT BY AN
// EARLIER, CHEAPER CHECK PROVES NOTHING ABOUT THE LATER ONE. `wrongstatus` is the
// worked example. Every refusal check first read BOTH the token and the status, so a
// broken status turned fifteen checks red and said nothing about the one that owns the
// property. The fix was not a cleverer break, it was to split the property: a local
// check now asserts the TOKEN alone, and §3.1's token-to-status table is asserted once,
// centrally, over every refusal the run saw (G3). One property, one check, one break.
//
// The same reasoning shapes the rest. `nokey` drops a field and re-canonicalises the
// bytes, so G5 stays green and only A2 moves; had it left the text alone, G5 would have
// reddened too and A2 would have been credited with catching something it never saw.
// `novotes` and `nullvotes` are a pair for the same reason: A7 asks whether the key is
// there and A8 asks what it holds, so removing the key must not be the same break as
// emptying it. `mineleak` adds `mine` only where NO voice header was sent at all, so
// A10 — which sends a header of spaces — stays green and A9 alone moves.
//
// THREE BREAKS ARE DELIBERATELY NOT ISOLATED, and each is one forge behaviour that
// violates two sentences, so no cleverer break could separate them:
//
//   `clamped`  reddens B6 and B7. B6 says a limit outside 1..200 is refused and B7 says
//              it is not served clamped.
//   `leak403`  reddens D5 and D6. D5 is the privacy rule to an unvoiced caller and D6
//              is the same rule to one holding a voice; §3 requires `absent` to EVERY
//              caller, so a 403 breaks both halves at once. D6 only reddens when
//              `ORE_VOICE` is supplied -- without it D6 is a skip and D5 moves alone,
//              which is what this line said until 2026-08-17, when a run with a voice
//              was made for the first time.
//   `trimmed`  reddens E2 and A10. §3.1's whitespace rule has a read half (A10) and a
//              write half (E2), and a header of spaces read as a credential breaks the
//              two together. `mineleak` is the break that leaves A10 green, on purpose.
//
// Written down rather than tidied away, because a break whose reach is not stated is a
// break whose reach is not known -- and an UNDERSTATED reach is worse than a wide one,
// since the extra check it reddens gets silent credit for catching something else.
//
// ── SKIPS ARE PRINTED AT THE SAME WEIGHT AS PASSES ───────────────────────────────
//
// "37 passed" with four silent skips reads as coverage, and a silent skip is the next
// absence nobody can see — §3.3's own defect class, one level up. So every skip names
// the clause it could not test, the summary line carries them, and a run with skips
// cannot be mistaken for a full pass at a glance. The exit code still turns on failures
// alone; the reading of the run turns on both.
//
// ── THE TEST FOR EVERY CHECK BELOW, WHICH IS MECHANICAL (§3.3) ───────────────────
//
//   A CONFORMANCE CHECK MAY NOT ASSERT A DISTINCTION THE CONTRACT DOES NOT DEFINE.
//   IF YOU CANNOT CITE THE SENTENCE, YOU INVENTED THE RULE.
//
// A clause that NAMES a category without DEFINING one does not count. On meeting an
// undefined clause the move is to report the gap and skip the check, never to guess:
// a guess in a conformance suite is indistinguishable from a requirement by the time
// anyone reads it, which is how a regular expression in a mock came to arbitrate a
// question the contract had never answered. Every skip taken for that reason is
// printed, counted, and listed again under GAPS at the end.
//
// ── TWO TOKENS THIS FILE DOES NOT PROVOKE, AND SAYS SO RATHER THAN FAKING ────────
//
//   `unsupported` (405). §3.1: "unsupported is unreachable from any honest client, and
//   it is not dead vocabulary to be deleted." The token answers a verb this surface
//   documents nowhere, and the panel sends no such verb; a probe would be asserting
//   the door's behaviour rather than the surface's. §3.1 already records the fact from
//   the forge's side (`serve.rs:153`), and warns that "a reader who finds no test
//   naturally reaching this token will conclude it can go". This paragraph is that
//   reader's answer. If the orchestrator wants the row covered anyway, a `DELETE` on
//   any route provokes it and changes nothing; it is left out on purpose, not missed.
//
//   `internal` (500). A fault inside the forge, which cannot be induced from outside
//   without breaking the forge, and breaking a live forge to see it say so is not a
//   conformance check.
//
//   `throttled` (429) is not PROVOKED either, and that is §2's requirement rather than
//   shyness: earning one on purpose takes a flood, and §2.1 puts a global failure
//   backstop behind exactly that. Its SHAPE is still checked — a throttle that arrives
//   for any reason is read by G1..G4 like any other refusal.
//
//   IT DOES ARRIVE. This suite writes two records per run under one voice, and oregami's
//   allowance is twenty writes a voice a minute (`oregami/src/limit.rs`, `VOICE_CAP`), so
//   several runs in quick succession spend it. On 2026-08-17 the fourth consecutive run
//   reported `FAIL F1 ... 429 error=throttled`: a red check whose cause was the forge
//   obeying §2, which is the opposite of what a red line there means. Two things were
//   wrong and both are fixed below — the F-series now SKIPS on a throttle and names the
//   allowance, and `keep()` files a refused write in the refusal ledger, which it did not
//   do, so the sentence above about G1..G4 reading it was false for exactly the answer
//   most likely to need it.

import fs   from 'node:fs';
import net  from 'node:net';
import path from 'node:path';
import tls  from 'node:tls';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ THE SUBJECT — the client's own constant, and nothing else                     │
// └───────────────────────────────────────────────────────────────────────────────┘

/// Where the panel names its repository. Read here so that the suite and the browser
/// are reading the same two lines.
const CLIENT = path.join(ROOT, 'www', 'js', 'improve.js');

/// Pull one `var NAME = '...';` out of the client, or stop.
///
/// Exactly one match is required. A missing constant means the client has been
/// changed underneath this file, and a second match means the file no longer has one
/// place where the repository is named -- both are reasons to stop rather than pick.
function constantOf(src, name) {
	const re = new RegExp("^\\s*var\\s+" + name + "\\s*=\\s*'([^']*)'\\s*;", 'gm');
	const hits = [...src.matchAll(re)];
	if (hits.length !== 1) {
		console.error(`www/js/improve.js holds ${hits.length} definitions of ${name}, and this `
			+ 'suite takes its subject from exactly one. §3.3: the subject is the client\'s own '
			+ 'configured constant, so a suite that cannot read it must stop rather than guess.');
		process.exit(2);
	}
	return hits[0][1];
}

const CLIENT_SRC = (() => {
	try { return fs.readFileSync(CLIENT, 'utf8'); }
	catch (e) {
		console.error(`Could not read ${CLIENT}: ${e && e.message}. The subject lives there and `
			+ 'nowhere else, so there is nothing to run against.');
		process.exit(2);
	}
})();

/// The repository the product names. §3.3: never an argument.
const SUBJECT = {
	account: constantOf(CLIENT_SRC, 'ACCOUNT'),
	repo:    constantOf(CLIENT_SRC, 'REPO'),
};

/// Where the write checks that are expected to SUCCEED go. §3.3: "The sandbox is a
/// second compiled-in constant and never a command-line argument, for the reason the
/// subject is not one." Change it here, in a commit somebody reviews, or not at all.
const SANDBOX = { account: 'oxedyne', repo: 'conformance' };

/// The header a voice travels in. §4 names it. A literal, not an import: a rename on
/// either side must fail this suite rather than travel through it.
const HDR = 'x-ore-voice';

/// §3.1's nine tokens and their statuses, transcribed from the table and from nothing
/// else. A tenth token, or a status that disagrees with this map, is a finding.
const TABLE = {
	absent:      404,
	unvoiced:    401,
	unknown:     401,
	unpermitted: 403,
	throttled:   429,
	malformed:   400,
	no_proposal: 404,
	unsupported: 405,
	internal:    500,
};

/// The three reasons §3.1 admits on a `throttled`, and the only refusal that carries
/// `because` at all.
const BECAUSE = ['address', 'voice', 'failing'];

/// §3's four spellings of `state`.
const STATES = ['open', 'accepted', 'declined', 'done'];

/// §3's fields on every proposal record, from the listing example. §9 adds `votes`,
/// and `mine` when a voice was carried; those are asserted separately, because a forge
/// that has not shipped §9 must still pass everything §3 asks for.
const FIELDS = ['number', 'title', 'state', 'author', 'comments', 'opened', 'changed',
	'mark', 'build'];

/// What a refusal must be served as. §3.2: "A refusal is served as `application/json`,
/// no `charset`".
const JSON_CT = 'application/json';

/// The largest listing §3 admits, and the size of one when nothing says.
const CEILING = 200;
const DEFAULT_PAGE = 50;

/// A title that names itself, on every probe body sent to the SUBJECT. Every one of
/// those probes is expected to be refused; if the forge ever accepts one, the record
/// it leaves says what it is instead of reading like a tester's report.
const PROBE_TITLE = 'conformance probe — this request should have been REFUSED';
const PROBE_BODY  = 'Sent by dev/verify_conformance.mjs to check a refusal path. If you '
	+ 'are reading this in the backlog, the forge accepted a request the contract says it '
	+ 'must refuse, and the check that sent it will have gone red in the same run.';


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ ARGUMENTS — none of which is a subject                                        │
// └───────────────────────────────────────────────────────────────────────────────┘

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt  = (n, d) => {
	const i = argv.indexOf('--' + n);
	if (i < 0 || i + 1 >= argv.length) return d;
	const v = String(argv[i + 1]);
	return v.startsWith('--') ? d : v;
};

for (const a of argv) {
	if (a === '--account' || a === '--repo') {
		console.error(`${a} does not exist here, deliberately. §3.3: the subject is the `
			+ 'client\'s own configured constant, because "a subject supplied on the command '
			+ 'line will be pointed at whatever passes, and it will be pointed there by the '
			+ 'person with the most reason to want a green result." Edit www/js/improve.js if '
			+ 'the product\'s repository has changed.');
		process.exit(2);
	}
}

/// Which deliberate corruption is in force, if any.
const BREAK = String(opt('break', ''));

/// Secrets from a file, one `NAME=value` per line. The environment wins over it, and
/// nothing here is ever printed.
function voicesFrom(file) {
	const out = {};
	let text = '';
	try { text = fs.readFileSync(file, 'utf8'); }
	catch (e) {
		console.error(`--voices ${file} could not be read: ${e && e.message}`);
		process.exit(2);
	}
	for (const line of text.split(/\r?\n/)) {
		const s = line.trim();
		if (!s || s.startsWith('#')) continue;
		const i = s.indexOf('=');
		if (i < 0) continue;
		out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
	}
	return out;
}

const FILE_VOICES = opt('voices', '') ? voicesFrom(opt('voices', '')) : {};
const secretOf = (name) => String(process.env[name] || FILE_VOICES[name] || '');

/// The three voices, each one a secret and each one optional. What is missing costs
/// checks, and those checks are skipped by name.
const V = {
	subject: secretOf('ORE_VOICE'),
	reader:  secretOf('ORE_VOICE_READER'),
	sandbox: secretOf('ORE_VOICE_SANDBOX'),
};

/// Nothing printed by this file carries a secret, whatever a check puts in its detail
/// string. Cheaper than remembering, and the rule it keeps is CLAUDE.md's.
const SECRETS = Object.values(V).filter(s => s.length > 0);
function redact(s) {
	let out = String(s == null ? '' : s);
	for (const sec of SECRETS) {
		if (sec) out = out.split(sec).join('«voice»');
	}
	return out;
}

/// Where the forge is. The address is not the subject -- it names WHERE to ask, not
/// WHAT to ask about -- so it may come from the environment. It is printed at the top
/// of every run and in the summary, so the evidence carries what it was pointed at.
function forgeBase() {
	const env = String(process.env.ORE_FORGE || '').trim();
	if (env) return { url: env.replace(/\/$/, ''), from: 'ORE_FORGE' };
	try {
		const jdat = fs.readFileSync(path.join(ROOT, 'gateway', 'app.jdat'), 'utf8');
		const host = /"forge_host"\s*:\s*"([^"]+)"/.exec(jdat);
		const port = /"forge_port"\s*:\s*"([^"]+)"/.exec(jdat);
		if (host && port) {
			return { url: `http://${host[1]}:${port[1]}`, from: 'gateway/app.jdat' };
		}
	} catch (e) { /* fall through to the failure below */ }
	console.error('No ORE_FORGE, and gateway/app.jdat names no forge_host and forge_port. '
		+ 'There is nothing to ask.');
	process.exit(2);
}

const BASE = forgeBase();
const URLB = new URL(BASE.url);
const PREFIX = URLB.pathname.replace(/\/$/, '');
const IS_TLS = URLB.protocol === 'https:';
const PORT = Number(URLB.port || (IS_TLS ? 443 : 80));

// `--why-not`: can this run be made at all, and if not, in one sentence, why.
//
// A SKIP IS NOT A PASS AND A FAILURE TO CONNECT IS NOT A CONFORMANCE RESULT. On the
// 2026-08-17 gate this file appeared among fifty-six reds, indistinguishable from a
// forge that had answered wrongly, when what had happened was that no forge was
// running -- and its own output said so at length and better than the summary line
// that quoted it. `dev/run_all.sh` asks this question before running anything, on
// the same principle every other derivation in that file follows: ask the verifier,
// never a list somebody has to remember to edit. The address is resolved here, by
// the code that will do the asking, so the two can never disagree about where the
// forge was meant to be.
//
// Silence means it can run. Anything printed is the reason it cannot, and the suite
// prints that as a SKIP naming the absent thing.
if (flag('why-not')) {
	const reachable = await new Promise((res) => {
		const sock = net.connect({ host: URLB.hostname, port: PORT });
		const done = (v) => { sock.destroy(); res(v); };
		sock.setTimeout(3000);
		sock.on('connect', () => done(true));
		sock.on('timeout', () => done(false));
		sock.on('error',   () => done(false));
	});
	if (!reachable) {
		console.log(`no Oregami forge answering at ${BASE.url} (${BASE.from}) — this run would `
			+ 'say NOTHING about the repository the product names, which is the whole reason '
			+ 'the file exists (§3.3). Stand one up as its header sets out, or point ORE_FORGE '
			+ 'at one. It is NOT a pass.');
	}
	process.exit(0);
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ THE CLIENT — one request, built by hand, so the bytes are the bytes            │
// └───────────────────────────────────────────────────────────────────────────────┘

/// How long one exchange may take before the run gives up on it.
const TIMEOUT_MS = 20000;

/// Send one request and read the whole answer.
///
/// # Arguments
/// * `method` - The verb, written literally into the request line.
/// * `target` - The request-target, INCLUDING the query, exactly as it should appear
///   on the wire. Nothing here re-encodes it: §3.2's raw-query rule cannot be tested
///   through a client that tidies the query up.
/// * `opts` - `headers` as `[name, value]` pairs written verbatim, and `body` as a
///   string.
function ask(method, target, opts = {}) {
	const headers = opts.headers || [];
	const body = opts.body == null ? null : String(opts.body);
	const host = URLB.port ? `${URLB.hostname}:${URLB.port}` : URLB.hostname;
	let head = `${method} ${PREFIX}${target} HTTP/1.1\r\n`
		+ `Host: ${host}\r\n`
		+ 'User-Agent: daimond-conformance/1\r\n'
		+ 'Connection: close\r\n';
	for (const [n, v] of headers) head += `${n}: ${v}\r\n`;
	if (body != null) head += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
	head += '\r\n';

	return new Promise((resolve, reject) => {
		const chunks = [];
		const sock = IS_TLS
			? tls.connect({ host: URLB.hostname, port: PORT, servername: URLB.hostname })
			: net.connect({ host: URLB.hostname, port: PORT });
		sock.setTimeout(TIMEOUT_MS);
		// Once, and on the right event: a TLS socket emits both `connect` and
		// `secureConnect`, and writing on each would send the request twice.
		sock.once(IS_TLS ? 'secureConnect' : 'connect',
			() => sock.write(head + (body == null ? '' : body)));
		sock.on('data', (d) => chunks.push(d));
		sock.on('timeout', () => { sock.destroy(); reject(new Error('the forge did not answer in time')); });
		sock.on('error', (e) => reject(e));
		sock.on('close', () => {
			try {
				// The one place a break may touch anything: the answer, on its way in,
				// before the first assertion reads it.
				const voiced = headers.find(([n]) => n.toLowerCase() === HDR);
				resolve(damage({
					method, target, body,
					voice: voiced ? voiced[1] : null,
					r: parse(Buffer.concat(chunks)),
				}));
			} catch (e) { reject(e); }
		});
	});
}

/// Split a raw HTTP/1.1 answer into its status, its headers and its body.
function parse(raw) {
	const cut = raw.indexOf('\r\n\r\n');
	if (cut < 0) throw new Error('the answer had no header block');
	const head = raw.slice(0, cut).toString('latin1');
	let rest = raw.slice(cut + 4);
	const lines = head.split('\r\n');
	const status = Number((/^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0]) || [])[1] || 0);
	const headers = {};
	for (const line of lines.slice(1)) {
		const i = line.indexOf(':');
		if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
	}
	if (/chunked/i.test(headers['transfer-encoding'] || '')) rest = dechunk(rest);
	const len = headers['content-length'] ? Number(headers['content-length']) : null;
	const bytes = (len != null && len <= rest.length) ? rest.slice(0, len) : rest;
	const text = bytes.toString('utf8');
	let json = null;
	try { json = JSON.parse(text); } catch (e) { /* not JSON, which is sometimes the finding */ }
	return { status, headers, type: headers['content-type'] || '', bytes, text, json };
}

/// Undo chunked transfer coding.
function dechunk(buf) {
	const out = [];
	let i = 0;
	for (;;) {
		const nl = buf.indexOf('\r\n', i);
		if (nl < 0) break;
		const n = parseInt(buf.slice(i, nl).toString('latin1').split(';')[0], 16);
		if (!Number.isFinite(n) || n === 0) break;
		out.push(buf.slice(nl + 2, nl + 2 + n));
		i = nl + 2 + n + 2;
	}
	return Buffer.concat(out);
}

/// A form-encoded body, which is what every write on this surface carries (§9: "The
/// body is form-encoded, like every other write on this surface.").
const form = (o) => new URLSearchParams(o).toString();
const FORM_CT = ['Content-Type', 'application/x-www-form-urlencoded'];

/// A GET, optionally carrying a voice. `secret` of `null` sends NO header at all,
/// which is a different request from one sending an empty header (§3.1).
const get = (target, secret = null) =>
	ask('GET', target, { headers: secret === null ? [] : [[HDR, secret]] });

/// A POST with a form body, optionally carrying a voice.
const post = (target, body, secret = null) =>
	ask('POST', target, {
		headers: secret === null ? [FORM_CT] : [FORM_CT, [HDR, secret]],
		body:    typeof body === 'string' ? body : form(body),
	});

/// The two routes, for a repository.
const listOf = (r) => `/${r.account}/${r.repo}/proposals`;


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ CANONICAL JSON — written here, not imported from anything under test           │
// └───────────────────────────────────────────────────────────────────────────────┘

/// RFC 8785 canonical form of a parsed value.
///
/// Keys sort by UTF-16 code unit, which is what JavaScript's own string ordering is
/// and what §3.2 says `json_canonical` does. Numbers go through `JSON.stringify`,
/// which agrees with RFC 8785 over the integers this data holds -- §3 records that the
/// encoder refuses floats, byte strings, non-string keys and integers beyond 2^53 - 1,
/// so nothing on this wire reaches the cases where the two could part.
function canon(v) {
	if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) throw new Error('a non-finite number is not canonical');
		return JSON.stringify(v);
	}
	if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
	return '{' + Object.keys(v).sort()
		.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ THE BREAKS — a check that will not go red is a finding, not a fixture problem   │
// └───────────────────────────────────────────────────────────────────────────────┘
//
// Each one corrupts THE ANSWER on its way in, between `parse` and the first assertion
// that reads it. The forge is not ours to damage and it is not what is under test
// here: what is under test is whether these checks would notice.
//
// Each is scoped to redden exactly one check. Where it cannot be, the reach is written
// beside it. Where a break turns a neighbour into a SKIP rather than a failure that is
// written down too, because a check that quietly stops running is the absence this
// whole suite is about.

/// Re-emit a mutated body as canonical bytes, so that a break aimed at a field does not
/// trip the canonical-bytes check instead and take the credit.
function recanon(r) {
	r.text = canon(r.json);
	r.bytes = Buffer.from(r.text, 'utf8');
}

/// Is this the subject's full listing — the one A1, A2, A7, A8 and A9 all read?
///
/// The `from=` exclusion is not tidiness: B4 asks for the same limit with a ceiling on
/// it, and a break that also corrupted THAT answer would be reaching a second check for
/// no reason. Proved by driving each break over a set of representative answers rather
/// than by reading the predicate, which is how the reach was found in the first place.
const bigList = (c) => c.method === 'GET'
	&& c.target.startsWith(`/${SUBJECT.account}/${SUBJECT.repo}/proposals?`)
	&& c.target.includes(`limit=${CEILING}`)
	&& !c.target.includes('from=');

const BREAKS = {
	/// A token and its status put out of step. §3.1's table is asserted once, centrally,
	/// so this must move G3 and nothing else -- which is the only reason the local checks
	/// read the token alone.
	wrongstatus: (c) => {
		// ONE refusal, not every `malformed` one: the smallest corruption that can move
		// the check under test is the one that says most about it.
		if (c.target.includes('from=0') && c.r.json && c.r.json.error === 'malformed') {
			c.r.status = 422;
		}
	},

	/// A field missing from the listing record, with the bytes re-canonicalised behind it.
	nokey: (c) => {
		if (bigList(c) && c.r.json && Array.isArray(c.r.json.proposals)) {
			for (const p of c.r.json.proposals) delete p.mark;
			recanon(c.r);
		}
	},

	/// `votes` absent where §9 guarantees the zero object. A8 has nothing left to read and
	/// SKIPS, which is written here rather than discovered.
	novotes: (c) => {
		if (bigList(c) && c.r.json && Array.isArray(c.r.json.proposals)) {
			for (const p of c.r.json.proposals) delete p.votes;
			recanon(c.r);
		}
	},

	/// A zero tally emitted as null. The key is still there, so A7 stays green and only
	/// A8 -- which is the check that owns "never null" -- moves.
	nullvotes: (c) => {
		if (bigList(c) && c.r.json && Array.isArray(c.r.json.proposals)) {
			for (const p of c.r.json.proposals) {
				if (p.votes && p.votes.for === 0 && p.votes.against === 0) p.votes = null;
			}
			recanon(c.r);
		}
	},

	/// 403 where `absent` is required. The token moves with the status, so G3 stays green
	/// and D5 -- the privacy check -- is the only one that can catch this.
	leak403: (c) => {
		if (c.target.includes('no-such-repository')) {
			c.r.status = 403;
			c.r.json = { error: 'unpermitted', said: 'That voice may not see this repository.' };
			recanon(c.r);
		}
	},

	/// A credential in the body accepted where §4 requires `malformed`. Only where NO
	/// header was sent, so E10 -- both doors at once -- is untouched.
	bodyvoice: (c) => {
		if (c.method === 'POST' && c.voice === null && (c.body || '').includes('voice=')) {
			c.r.status = 200;
			c.r.json = {
				number: 0, title: 'accepted', state: 'open', author: 'nobody', body: '',
				comments: 0, opened: 0, changed: 0, mark: null, build: null,
				discussion: [], votes: { for: 0, against: 0 }, mine: null,
			};
			recanon(c.r);
		}
	},

	/// A header of spaces read as a credential. Spaces only, so E3's tabs and E4's empty
	/// header stay exactly right and E2 alone moves.
	trimmed: (c) => {
		if (typeof c.voice === 'string' && c.voice.length > 0 && /^ +$/.test(c.voice)) {
			c.r.status = 401;
			c.r.json = { error: 'unknown', said: 'That voice is not recognised here.' };
			recanon(c.r);
		}
	},

	/// `mine` on a read that carried no voice. Only where the header was ABSENT, so A10 --
	/// which sends a header of spaces -- stays green.
	mineleak: (c) => {
		if (bigList(c) && c.voice === null && c.r.json && Array.isArray(c.r.json.proposals)) {
			for (const p of c.r.json.proposals) p.mine = null;
			recanon(c.r);
		}
	},

	/// A `from` above the highest answered with an empty page instead of the newest one.
	emptyceiling: (c) => {
		const m = /[?&]from=(\d+)/.exec(c.target);
		if (m && Number(m[1]) >= 1000 && c.r.json && Array.isArray(c.r.json.proposals)) {
			c.r.json.proposals = [];
			recanon(c.r);
		}
	},

	/// A charset on a refusal's media type. The type before the semicolon is untouched, so
	/// C2 -- which reads that -- stays green and G1 alone moves.
	charset: (c) => {
		if (c.r.json && typeof c.r.json.error === 'string') {
			c.r.type = c.r.type.split(';')[0] + '; charset=utf-8';
		}
	},

	/// The right values in the wrong bytes. `json` is left exactly as it was, so every
	/// check that reads a value stays green and G5 alone moves.
	noncanonical: (c) => {
		if (bigList(c) && c.r.json) c.r.text = JSON.stringify(c.r.json, null, 1);
	},

	/// An over-large limit served instead of refused. REACH: B6 and B7 together, and it
	/// cannot be otherwise -- one behaviour violates both sentences.
	clamped: (c) => {
		if (c.target.includes(`limit=${CEILING + 1}`)) {
			c.r.status = 200;
			c.r.json = { total: 0, proposals: [] };
			recanon(c.r);
		}
	},
};

if (BREAK && !(BREAK in BREAKS)) {
	console.error(`--break ${BREAK} is not one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Apply the break in force, if any, to one answer.
function damage(ctx) {
	if (BREAK) BREAKS[BREAK](ctx);
	return ctx.r;
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ BOOKKEEPING — a skip is a hole in the evidence and has to look like one        │
// └───────────────────────────────────────────────────────────────────────────────┘

const ok = [], bad = [], skipped = [];
/// Every check's citation, by id, so `--cites` can print the map and a failure can
/// print the sentence it rests on.
const CITES = {};
/// Every JSON refusal this run has seen, whatever provoked it. The F-series reads them
/// all at the end: the shape of a refusal is one property, not fifteen.
const refusals = [];
/// Every JSON body carrying a record, for the canonical-bytes check.
const bodies = [];
/// Contract gaps met on the way, each one a check not made.
const GAPS = [];

/// Record one check.
///
/// # Arguments
/// * `id` - Its short name, stable so a handover can refer to one.
/// * `cite` - The sentence from the authority that requires it. Not decoration: §3.3's
///   rule is that a check which cannot cite one has invented its rule.
/// * `name` - What is being asserted, in words.
/// * `pass` - Whether it held.
/// * `detail` - What was actually seen.
function check(id, cite, name, pass, detail) {
	CITES[id] = cite;
	(pass ? ok : bad).push(id);
	console.log((pass ? '  ok   ' : '  FAIL ') + id + ' ' + name
		+ (detail ? ' — ' + redact(detail) : ''));
	if (!pass) console.log('        ' + cite);
}

/// A check that could not run, and why.
///
/// Counted, printed at the same weight as a pass, and NAMED IN THE SUMMARY. §3.3's
/// whole subject is evidence that is not there looking like evidence that is, and
/// "37 passed" beside four silent skips is that defect one level up. Every skip
/// therefore carries `clause`: the thing this run says nothing about, in a few words,
/// so the summary line can say it without anybody opening the file.
function skip(id, clause, why, cite) {
	if (cite) CITES[id] = cite;
	skipped.push({ id, clause, why, undefined_: false });
	console.log('  skip ' + id + ' [' + clause + '] — ' + redact(why));
}

/// A clause the authority does not define. Recorded as a GAP, and the check it would
/// have carried is skipped rather than guessed: §3.3, "on meeting an undefined clause
/// the move is to report the gap and skip the check, never to guess".
function gap(id, clause, what) {
	GAPS.push({ id, clause, what });
	skipped.push({ id, clause, why: what, undefined_: true });
	console.log('  skip ' + id + ' [UNDEFINED: ' + clause + '] — ' + redact(what));
}

/// Keep a refusal for the F-series, and hand it back for a local assertion.
function note(where, r) {
	if (r.json && typeof r.json === 'object' && typeof r.json.error === 'string') {
		refusals.push({ where, r });
	}
	return r;
}

/// Keep a record-bearing body for the canonical-bytes check, and a refused one for the
/// refusal ledger as well.
///
/// A write CAN be refused — a throttle is the refusal that actually happens — and until
/// 2026-08-17 an answer arriving here went into `bodies` alone, so G1..G4 never read the
/// one refusal a run was most likely to meet while a comment above claimed they did.
/// G5 reads the two ledgers by identity, so an answer in both is still read once.
function keep(where, r) {
	if (r.json && typeof r.json === 'object') bodies.push({ where, r });
	return note(where, r);
}

/// Whether an answer is the refusal it should be — THE TOKEN, AND NOT THE STATUS.
///
/// The status is §3.1's table's property and it is asserted once, over every refusal
/// the run saw, by G3. That split is not tidiness. When these two were read together,
/// a single wrong status turned fifteen checks red and said nothing at all about the
/// check that owns the table -- a break caught by an earlier, cheaper check leaves the
/// later one still untested.
const refused = (r, token) => !!(r.json && r.json.error === token);
/// What an answer actually was, for a detail string.
const shown = (r) => `${r.status} ${r.type || '(no type)'} ${r.json && r.json.error
	? `error=${r.json.error}` : r.text.slice(0, 70).replace(/\s+/g, ' ')}`;


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ THE RUN                                                                        │
// └───────────────────────────────────────────────────────────────────────────────┘

console.log(`subject  ${SUBJECT.account}/${SUBJECT.repo}   `
	+ `read from www/js/improve.js — the client's own constant, §3.3`);
console.log(`sandbox  ${SANDBOX.account}/${SANDBOX.repo}   `
	+ 'compiled into dev/verify_conformance.mjs, never an argument, §3.3');
console.log(`forge    ${BASE.url}   (${BASE.from})`);
console.log(`voices   subject:${V.subject ? 'yes' : 'NO'}  `
	+ `reader:${V.reader ? 'yes' : 'NO'}  sandbox:${V.sandbox ? 'yes' : 'NO'}`);
if (BREAK) {
	console.log(`BROKEN   --break ${BREAK}: the answers are being corrupted on the way in, and `
		+ 'this run is EXPECTED to fail. Nothing red here is the forge\'s.');
}
console.log('');

const R = listOf(SUBJECT);
const S = listOf(SANDBOX);

/// Whether the read lane ran at all. Without it a green summary would mean nothing,
/// so it decides the exit code as much as the failures do.
let readLane = false;

try {
	await reads();
	await writeRefusals();
	await sandboxWrites();
	await refusalShapes();
} catch (e) {
	check('RUN', 'The run must complete; a suite that stopped early has measured nothing '
		+ 'below the point it stopped.', 'the run completed', false,
		String((e && e.stack) || e));
}

finish();


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ A. READS — against the client's own constant, which is the point               │
// └───────────────────────────────────────────────────────────────────────────────┘

async function reads() {
	// ── A1: the subject answers. This is the check the thirty-one never made. §3.3:
	//    "the read checks resolve the client's constant and assert it answers".
	let list;
	try {
		list = keep('A1', await get(`${R}?format=json&limit=${CEILING}`));
	} catch (e) {
		check('A1', '§3.3: "the read checks resolve the client\'s constant and assert it '
			+ 'answers".', `${SUBJECT.account}/${SUBJECT.repo} answers a listing`, false,
			String(e && e.message));
		skip('A2..D7', 'every read, path and privacy rule',
			'the subject did not answer at all — the socket failed, so not one of the read '
			+ 'checks below was made');
		return;
	}
	const alive = list.status === 200 && list.json && Array.isArray(list.json.proposals)
		&& typeof list.json.total === 'number';
	check('A1', '§3.3: "the read checks resolve the client\'s constant and assert it answers"; '
		+ '§3: "GET /<account>/<repo>/proposals?format=json".',
		`${SUBJECT.account}/${SUBJECT.repo} answers a listing`, alive, shown(list));
	if (!alive) {
		note('A1', list);
		skip('A2..C3', 'the subject\'s records, selectors and surface rules',
			'the subject did not answer a listing, so no record, no selector and no '
			+ 'surface rule can be measured on it. THIS IS THE 2026-08-14 FAULT: the panel names '
			+ 'a repository the forge does not serve, and every check aimed elsewhere still passes.');
		// The path and privacy rules do not need the subject's contents, so they still run:
		// they are the checks that say WHICH kind of nothing this is.
		await paths(null);
		return;
	}
	readLane = true;

	const props = list.json.proposals;
	const nums = props.map(p => p && p.number).filter(n => typeof n === 'number');
	const top = nums.length ? Math.max(...nums) : 0;
	const total = list.json.total;

	// ── A2: the record's fields. §3's listing example.
	if (!props.length) {
		skip('A2', 'the record\'s fields',
			'the subject holds no proposals, so there is no record to read');
	} else {
		const missing = [];
		for (const p of props) {
			for (const f of FIELDS) if (!(f in p)) missing.push(`#${p.number}:${f}`);
		}
		check('A2', '§3: the listing example carries number, title, state, author, comments, '
			+ 'opened, changed, mark and build on every record.',
			'every listing record carries §3\'s fields', missing.length === 0,
			missing.slice(0, 6).join(' '));
	}

	// ── A3: `comments` is a count, on both routes. §3's own heading.
	const detail = props.length
		? keep('A3', await get(`${R}/${top}?format=json`))
		: null;
	if (!detail) {
		skip('A3', '`comments` on the detail route',
			'the subject holds no proposals, so the detail route has nothing to read');
		skip('A4', 'the detail shape',
			'the subject holds no proposals, so the detail route has nothing to read');
	} else {
		const listNum = props.every(p => typeof p.comments === 'number');
		const oneNum = detail.json && typeof detail.json.comments === 'number';
		check('A3', '§3: "`comments` is a count everywhere ... One key, one type, on every '
			+ 'route."', '`comments` is a number on the listing and on the detail route',
			listNum && oneNum,
			`listing ${listNum}, detail ${detail.json ? typeof detail.json.comments : 'no body'}`);

		// ── A4: the detail shape adds `body` and the discussion. §3's second example.
		const d = detail.json || {};
		const shape = typeof d.body === 'string' && Array.isArray(d.discussion);
		check('A4', '§3, "One proposal": the detail record is the listing record "plus `body` '
			+ 'and the discussion".', 'the detail route adds `body` and `discussion`', shape,
			shown(detail));

		// ── A5: a discussion entry's keys, `when` and not `at`. §3.2 names the divergence.
		const entry = (Array.isArray(d.discussion) ? d.discussion : []).find(Boolean);
		if (!entry) {
			skip('A5', 'a discussion entry\'s keys',
				'no proposal read here carries a discussion entry, so its keys cannot be '
				+ 'read. Nothing is asserted about a shape that was not seen.');
		} else {
			check('A5', '§3: a discussion entry is {"author":..,"said":..,"when":..}; §3.2: "The '
				+ 'discussion entry\'s timestamp key is `when` on the wire and `at` on disk."',
				'a discussion entry carries author, said and when',
				typeof entry.author === 'string' && typeof entry.said === 'string'
				&& typeof entry.when === 'number', Object.keys(entry).join(','));
		}
	}

	// ── A6: `state` is one of four. §3.
	if (props.length) {
		const rogue = props.filter(p => !STATES.includes(p.state)).map(p => `#${p.number}=${p.state}`);
		check('A6', '§3: "`state` is one of `open`, `accepted`, `declined`, `done`."',
			'every record\'s state is one of the four', rogue.length === 0, rogue.slice(0, 5).join(' '));
	} else {
		skip('A6', 'the state vocabulary', 'the subject holds no proposals');
	}

	// ── A7/A8: §9's tally. The panel keys on the KEY's presence to know whether the vote
	//    route has shipped, so its absence is a fact worth reporting exactly.
	//
	//    A7 asks whether the KEY is there and A8 asks what it HOLDS, deliberately split:
	//    "never absent" and "never null" are two sentences and one check could not be
	//    proved red against both without a break that reddened it twice over.
	const votesPresent = props.length > 0 && props.every(p => 'votes' in p);
	if (!props.length) {
		skip('A7', '`votes` on every record', 'the subject holds no proposals');
		skip('A8', 'the zero object', 'the subject holds no proposals');
	} else {
		check('A7', '§9: "`votes` appears on both the listing and the detail route, same key, '
			+ 'same shape"; "the zero object, never null and never absent". The panel keys on '
			+ 'this key\'s presence to know whether the vote route has shipped.',
			'`votes` is on every record', votesPresent,
			votesPresent ? JSON.stringify(props[0].votes)
				: 'ABSENT — §9\'s vote route has not shipped on this forge');
		if (!votesPresent) {
			skip('A8', 'the zero object',
				'no record carried a `votes` key at all, so what it holds cannot be read. '
				+ 'A7 is the check that says so.');
		} else {
			const shapes = props.filter(p => !(p.votes && typeof p.votes === 'object'
				&& typeof p.votes.for === 'number' && typeof p.votes.against === 'number'))
				.map(p => `#${p.number}=${JSON.stringify(p.votes)}`);
			const zero = props.find(p => p.votes && p.votes.for === 0 && p.votes.against === 0);
			check('A8', '§9: "`votes` on a proposal nobody has voted on is {"for":0,"against":0}" '
				+ '-- the zero object, never null and never absent. A client forced to test for '
				+ 'the key before drawing a control would draw nothing on the record that most '
				+ 'needs one."',
				'and it is a {for,against} object — the zero object when nobody has voted',
				shapes.length === 0 && (!zero || canon(zero.votes) === '{"against":0,"for":0}'),
				shapes.length ? shapes.slice(0, 4).join(' ')
					: (zero ? JSON.stringify(zero.votes) : 'no unvoted proposal here to read'));
		}
	}

	// ── A9: `mine` is ABSENT when the read carried no voice. §9.
	if (!props.length) {
		skip('A9', '`mine` absent when unvoiced', 'the subject holds no proposals');
	} else {
		const present = props.filter(p => 'mine' in p).map(p => `#${p.number}`);
		check('A9', '§9: "When the request carries no voice, `mine` is absent rather than null, '
			+ 'so \'has not voted\' and \'was not asked\' cannot be confused."',
			'`mine` is absent from an unvoiced read', present.length === 0, present.slice(0, 5).join(' '));
	}

	// ── A10: a header holding only whitespace IS the headerless case, so the read is
	//    served and `mine` stays absent. Two sentences, composed: §3.1's trim rule says
	//    such a header presented no credential, and §3.1 says a headerless GET of a
	//    public repository is a 200.
	const spaced = keep('A10', await get(`${R}?format=json&limit=1`, '   '));
	check('A10', '§3.1: "A credential is *not presented* when the header is absent, or when it '
		+ 'carries nothing once whitespace is stripped." with "a public read needs no voice, so '
		+ 'a headerless GET is a 200".',
		'a whitespace-only voice header reads as no header at all',
		spaced.status === 200 && !!spaced.json
		&& (spaced.json.proposals || []).every(p => !('mine' in p)), shown(spaced));

	// ── A11: a wrong credential on a READ is `unknown`, not a public read. §3.2.
	const badRead = note('A11', await get(`${R}?format=json&limit=1`, '.'));
	check('A11', '§3.2: "A read carrying a wrong credential is `unknown`, not a public read."; '
		+ '§3.1: "\'.\' unknown <- one character is a credential".',
		'a read carrying a wrong credential is `unknown`',
		refused(badRead, 'unknown'), shown(badRead));

	// ── A12: `mine` when the read IS voiced, on BOTH routes. Needs a recognised voice.
	const known = V.subject ? await recognised(R, V.subject) : null;
	if (!V.subject) {
		skip('A12', '`mine` on a voiced read',
			'no ORE_VOICE supplied, so no read can carry a voice');
	} else if (known !== true) {
		skip('A12', '`mine` on a voiced read',
			'the ORE_VOICE supplied is not recognised on the subject (the forge answered '
			+ '`unknown`), so a check using it would fail for a reason that is not the forge\'s');
	} else if (!props.length) {
		skip('A12', '`mine` on a voiced read', 'the subject holds no proposals');
	} else {
		const vl = keep('A12', await get(`${R}?format=json&limit=${CEILING}`, V.subject));
		const vd = keep('A12', await get(`${R}/${top}?format=json`, V.subject));
		const okMine = (p) => 'mine' in p && (p.mine === 1 || p.mine === -1 || p.mine === null);
		const listMine = !!vl.json && (vl.json.proposals || []).length > 0
			&& (vl.json.proposals || []).every(okMine);
		const detailMine = !!vd.json && okMine(vd.json);
		check('A12', '§9: "When the request carries a voice, the record also carries `mine`, one '
			+ 'of `1`, `-1` or `null` -- on the listing exactly as on the detail route."',
			'`mine` is present on both routes when the read is voiced',
			listMine && detailMine, `listing ${listMine}, detail ${detailMine}`);
	}

	// ── B1: order is newest first. §3.2.
	if (nums.length < 2) {
		skip('B1', 'newest first',
			'fewer than two proposals, so an order cannot be read off one record');
	} else {
		let desc = true;
		for (let i = 1; i < nums.length; i++) if (nums[i] >= nums[i - 1]) desc = false;
		check('B1', '§3.2: "Order is newest first. Descending by number".',
			'the listing runs newest first', desc, nums.slice(0, 6).join(','));
	}

	// ── B2: absent `from` starts at the newest. §3.2.
	if (!nums.length) {
		skip('B2', 'the newest page by default', 'the subject holds no proposals');
	} else {
		const first = props[0] && props[0].number;
		check('B2', '§3.2: "`from` absent means no ceiling: start at the newest."',
			'an unbounded listing starts at the highest number', first === top,
			`first ${first}, highest ${top}`);
	}

	// ── B3: `from` is a ceiling that counts down. §3.2.
	if (nums.length < 2) {
		skip('B3', '`from` as a ceiling',
			'fewer than two proposals, so a ceiling cannot be told from an offset');
	} else {
		const mid = nums.slice().sort((a, b) => b - a)[1];		// the second highest
		const r = keep('B3', await get(`${R}?format=json&from=${mid}&limit=${CEILING}`));
		const got = r.json && Array.isArray(r.json.proposals)
			? r.json.proposals.map(p => p.number) : [];
		check('B3', '§3.2: "`from` is the number to *start at and count down from*"; "Say `from` '
			+ 'is a ceiling, and that no ceiling is the newest."',
			'`from` is a ceiling and nothing above it comes back',
			got.length > 0 && got.every(n => n <= mid) && got[0] === mid,
			`from=${mid} gave ${got.slice(0, 6).join(',')}`);
	}

	// ── B4: a `from` above the highest is the newest page, not an empty one. §3.2.
	{
		const r = keep('B4', await get(`${R}?format=json&from=${top + 1000}&limit=${CEILING}`));
		const got = r.json && Array.isArray(r.json.proposals) ? r.json.proposals : [];
		check('B4', '§3.2: "A `from` above the highest number is the newest page, not an empty '
			+ 'one. It is a ceiling; nothing is above it."',
			'a `from` above the highest is the newest page', got.length > 0 && got[0].number === top,
			`${got.length} records, first ${got[0] && got[0].number}, highest ${top}`);
	}

	// ── B5: `from=0` is malformed and is NOT the newest page. §3.2's reversal, and the
	//    reason it matters is that the alias makes a paging client loop for ever.
	{
		const r = note('B5', await get(`${R}?format=json&from=0`));
		check('B5', '§3.2: "`from=0` is `malformed`, for exactly the reason `limit=0` is." The '
			+ 'alias to "newest" was withdrawn because it makes the parameter non-monotonic at '
			+ 'its own boundary and the obvious paging loop never terminates.',
			'`from=0` is `malformed`', refused(r, 'malformed'), shown(r));
	}

	// ── B6/B7: the limit's two ends, refused and not clamped. §3.2.
	{
		const zero = note('B6', await get(`${R}?format=json&limit=0`));
		const over = note('B6', await get(`${R}?format=json&limit=${CEILING + 1}`));
		const neg  = note('B6', await get(`${R}?format=json&limit=-1`));
		check('B6', '§3.2: "`limit` must be 1 to 200, and anything else is `malformed`. It is not '
			+ 'clamped."', 'a limit outside 1..200 is `malformed`',
			refused(zero, 'malformed') && refused(over, 'malformed') && refused(neg, 'malformed'),
			`limit=0 ${shown(zero)}; limit=201 ${shown(over)}; limit=-1 ${shown(neg)}`);
		check('B7', '§3.2: "Clamping looks kinder and is worse: a client asking for 500 silently '
			+ 'receives 200 for ever and never learns it asked wrongly."',
			'an over-large limit is refused rather than served clamped',
			!(over.status === 200), shown(over));
	}

	// ── B8: the ends that are IN range are served. §3.
	{
		const one = keep('B8', await get(`${R}?format=json&limit=1`));
		const max = keep('B8', await get(`${R}?format=json&limit=${CEILING}`));
		const n1 = one.json && Array.isArray(one.json.proposals) ? one.json.proposals.length : -1;
		check('B8', '§3: "?limit=<n> how many, default 50, maximum 200".',
			'limit=1 and limit=200 are both served', one.status === 200 && max.status === 200
			&& n1 <= 1, `limit=1 gave ${n1} record(s), limit=200 ${max.status}`);
	}

	// ── B9: the default page is fifty. Only visible on a repository holding more.
	if (total <= DEFAULT_PAGE) {
		skip('B9', 'the default page of fifty',
			`the subject holds ${total} proposals, which is not more than the default page `
			+ `of ${DEFAULT_PAGE}, so a default cannot be told from "everything there is"`);
	} else {
		const r = keep('B9', await get(`${R}?format=json`));
		const n = r.json && Array.isArray(r.json.proposals) ? r.json.proposals.length : -1;
		check('B9', '§3: "?limit=<n> how many, default 50, maximum 200".',
			'a listing with no limit carries fifty', n === DEFAULT_PAGE, `${n} records`);
	}

	// ── B10: `total` is after `state` and before `from` and `limit`. §3.
	{
		const one = keep('B10', await get(`${R}?format=json&limit=1`));
		const same = one.json && one.json.total === total;
		check('B10', '§3: "The response carries `total` -- the count *after* `state` is applied '
			+ 'and before `from` and `limit`".',
			'`total` ignores `limit`', !!same, `unbounded ${total}, limit=1 ${one.json && one.json.total}`);
	}

	// ── B11: `state=` empty means all. §3.2.
	{
		const r = keep('B11', await get(`${R}?format=json&state=&limit=${CEILING}`));
		check('B11', '§3.2: "`state=` with an empty value means all, which is what a form\'s '
			+ '\'any\' option sends."', 'an empty `state` means all',
			r.status === 200 && !!r.json && r.json.total === total,
			`${r.status}, total ${r.json && r.json.total} against ${total}`);
	}

	// ── B12: `state=open` selects. §3.
	{
		const r = keep('B12', await get(`${R}?format=json&state=open&limit=${CEILING}`));
		const got = r.json && Array.isArray(r.json.proposals) ? r.json.proposals : null;
		check('B12', '§3: "?state=open one of open, accepted, declined, done; omit for all".',
			'`state=open` returns only open proposals and a total no larger than all',
			!!got && got.every(p => p.state === 'open') && r.json.total <= total,
			`${got ? got.length : '-'} records, total ${r.json && r.json.total} of ${total}`);
	}

	// ── B13: an out-of-vocabulary state. NOT ASSERTED.
	gap('B13', 'an out-of-vocabulary `state` value',
		'the authority says `state` is "one of open, accepted, declined, done" and never says '
		+ 'what a value outside that set does — refuse it as `malformed`, ignore it, or return '
		+ 'nothing. A mock asserts a closed vocabulary; the contract does not define one.');

	// ── C1: a `format` that is not exactly `json` is NOT refused. §3.2.
	{
		const r = await get(`${R}?format=jsonn`);
		const isRefusal = !!(r.json && typeof r.json.error === 'string');
		check('C1', '§3.2: "A `format` value that is not exactly `json` falls through to the HTML '
			+ 'answer and is not refused."', 'format=jsonn is not refused', !isRefusal,
			shown(r));
	}

	// ── C2: the RAW QUERY decides the surface, even when the query will not parse. §3.2.
	{
		const r = note('C2', await get(`${R}?format=json&x=%zz`));
		const isJson = !!r.json && typeof r.json.error === 'string'
			&& r.type.split(';')[0].trim() === JSON_CT;
		check('C2', '§3.2: "THE RAW QUERY DECIDES THE SURFACE, and it decides it even when the '
			+ 'query will not parse. ... the first `format` parameter, compared against `json` '
			+ 'without decoding. A client that wrote it plainly is answered in JSON whatever else '
			+ 'is wrong with the request."',
			'an undecodable query holding a legible format=json is refused IN JSON', isJson,
			shown(r));
		check('C2b', '§3.1 table: "`malformed` 400 The request itself did not parse."',
			'and that refusal is `malformed`', refused(r, 'malformed'), shown(r));
	}

	// ── C3: a query fault refuses only the surface that asked for it. §3.2.
	{
		const r = await get(`${R}?limit=999`);
		const isRefusal = !!(r.json && typeof r.json.error === 'string');
		check('C3', '§3.2: "A query fault refuses only the surface that asked for it. A page asked '
			+ 'for with `?limit=999` and no `format` is still a page."',
			'a bad parameter with no `format` is not a JSON refusal', !isRefusal, shown(r));
	}

	await paths(top);
}

/// The path rules and the privacy rule. Split out because they do not need the
/// subject's contents and must still run when the subject answers nothing.
async function paths(top) {
	// ── D1..D4: §3.2's four-line table, verbatim.
	const wat = note('D1', await get(`${R}/wat?format=json`));
	check('D1', '§3.2: "proposals/wat  no_proposal".',
		'`proposals/wat` is `no_proposal`', refused(wat, 'no_proposal'), shown(wat));

	const watVote = note('D2', await get(`${R}/wat/vote?format=json`));
	check('D2', '§3.2: "proposals/wat/vote  no_proposal" — "being non-numeric, is `no_proposal` '
		+ 'on the number before the tail is considered".',
		'`proposals/wat/vote` is `no_proposal`', refused(watVote, 'no_proposal'), shown(watVote));

	const watDeep = note('D3', await get(`${R}/wat/deeper?format=json`));
	check('D3', '§3.2: "proposals/wat/deeper  no_proposal  <- the number, not the tail". "The '
		+ 'number is judged before the tail ALWAYS, and not only when the tail is `/vote`."',
		'`proposals/wat/deeper` is `no_proposal` — the number is judged first',
		refused(watDeep, 'no_proposal'), shown(watDeep));

	const n = top || 1;
	const numDeep = note('D4', await get(`${R}/${n}/deeper?format=json`));
	check('D4', '§3.2: "proposals/1/deeper  absent  <- the number is fine; the route is not". '
		+ '"`absent` means you asked for a route this surface does not have."',
		`\`proposals/${n}/deeper\` is \`absent\` — the route, not the number`,
		refused(numDeep, 'absent'), shown(numDeep));

	// ── D5/D6: privacy. 404 `absent`, never 403, to every caller.
	const nowhere = `/${SUBJECT.account}/no-such-repository-${Date.now().toString(36)}/proposals`;
	const gone = note('D5', await get(`${nowhere}?format=json`));
	check('D5', '§3.1 table: "`absent` 404 No repository here that you may see."; "Privacy is '
		+ 'unchanged and must stay unchanged: A private repository answers 404 on the JSON routes '
		+ 'exactly as on the HTML ones, never 403."',
		'a repository that is not there is `absent`, and never a 403',
		refused(gone, 'absent') && gone.status !== 403, shown(gone));

	if (!V.subject) {
		skip('D6', 'privacy to a caller holding a voice',
			'no ORE_VOICE supplied, so the voiced half of the privacy rule cannot be asked');
	} else {
		const voiced = note('D6', await get(`${nowhere}?format=json`, V.subject));
		check('D6', '§3: "a repository the web does not publish answers `absent` to **every** '
			+ 'caller, including one holding a provisioned voice with `pull` on it. That is '
			+ 'intended."',
			'and it is `absent` to a caller holding a voice too',
			refused(voiced, 'absent') && voiced.status !== 403, shown(voiced));
	}

	// ── D7: private vs absent, which cannot be probed from here.
	gap('D7', 'a private repository against one that is not there',
		'the authority requires the two to be indistinguishable (§3.1, §3, §9). Telling them '
		+ 'apart from outside is precisely what the rule forbids, so a check would need the NAME '
		+ 'of a private repository handed to it — and a subject supplied from outside is what '
		+ '§3.3 forbids. The property is verified on the forge\'s side by reading `Found::find`, '
		+ 'not here.');
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ E. WRITE REFUSALS — aimed at the subject, and they change no state             │
// └───────────────────────────────────────────────────────────────────────────────┘

/// Is this secret one the forge knows on this repository? Established separately
/// rather than inferred, per §3.3: "when you cannot tell absence from presence, stop
/// trying to compare and go and establish existence separately."
async function recognised(route, secret) {
	const r = await get(`${route}?format=json&limit=1`, secret);
	if (r.json && r.json.error === 'unknown') return false;
	if (r.status === 200) return true;
	return null;		// something else is wrong; the caller skips rather than guesses
}

async function writeRefusals() {
	// A repository that does not resolve is `absent` before a credential is looked at
	// (§9, "Privacy is decided before the credential"), so every probe below would earn
	// `absent` and report A1's failure a second time under thirteen other names.
	if (!readLane) {
		skip('E1..E13', 'the credential rule on the subject',
			'the subject did not answer, and a repository that does not resolve is refused '
			+ '`absent` before a credential is looked at (§9), so every credential probe would '
			+ 'be reporting A1\'s failure again under another name');
		return;
	}

	const probe = form({ title: PROBE_TITLE, body: PROBE_BODY });

	// ── E1..E4: the four spellings that are NO credential. §3.1's trim table. Sent over a
	//    socket this file writes itself, because a client library normalises header values
	//    and would collapse three of these into one probe.
	const spellings = [
		['E1', null,     'an absent header',            '§3.1: "absent header  unvoiced".'],
		['E2', '   ',    'a header of spaces',          '§3.1: "header of spaces  unvoiced".'],
		['E3', '\t\t',   'a header of tabs',            '§3.1: "header of tabs  unvoiced".'],
		['E4', '',       'an explicitly empty header',  '§3.1: "header explicitly empty  unvoiced".'],
	];
	for (const [id, secret, what, cite] of spellings) {
		const r = note(id, await post(`${R}?format=json`, probe, secret));
		check(id, cite + ' "The rule is a trim, and nothing more. A credential is *not presented* '
			+ 'when the header is absent, or when it carries nothing once whitespace is stripped."',
			`a write with ${what} is \`unvoiced\``, refused(r, 'unvoiced'), shown(r));
	}

	// ── E5..E7: present, unrecognised, and therefore `unknown` — including the single
	//    character, which is the distinction §3.1 says no ordinary test would find.
	const junk = [
		['E5', '.',                'a single full stop',
			'§3.1: "\\".\\"  unknown  <- one character is a credential"; "A single non-whitespace '
			+ 'character is a credential. The test is emptiness after trimming and nothing else -- '
			+ 'not plausibility, not a length floor, not a character class."'],
		['E6', '%%%',              'three percent signs',
			'§3.1: "\\"%%%\\", \\"café-voice\\"  unknown".'],
		['E7', 'not a credential', 'a sentence',
			'§3.1: "\\"not a credential\\"  unknown".'],
	];
	for (const [id, secret, what, cite] of junk) {
		const r = note(id, await post(`${R}?format=json`, probe, secret));
		check(id, cite, `a write carrying ${what} is \`unknown\``,
			refused(r, 'unknown'), shown(r));
	}

	// ── E8: the non-ASCII spelling §3.1's table names. Sent as UTF-8 bytes in the header,
	//    which is outside RFC 9110's field-value character set; if the forge cannot read it
	//    the check is SKIPPED rather than counted, because the probe would be asserting the
	//    transport rather than the rule.
	{
		const r = note('E8', await post(`${R}?format=json`, probe, 'café-voice'));
		if (r.json && r.json.error === 'unknown') {
			check('E8', '§3.1: "\\"%%%\\", \\"café-voice\\"  unknown".',
				'a non-ASCII credential is `unknown`', refused(r, 'unknown'), shown(r));
		} else if (r.json && r.json.error === 'malformed') {
			skip('E8', 'a non-ASCII credential',
				'the forge answered `malformed` to a header carrying UTF-8 bytes. That is a '
				+ 'statement about the transport, which §3.1\'s table does not legislate, so this '
				+ 'probe is not counted either way. ' + shown(r));
		} else {
			check('E8', '§3.1: "\\"%%%\\", \\"café-voice\\"  unknown".',
				'a non-ASCII credential is `unknown`', false, shown(r));
		}
	}

	// ── E9: THE TWO DOORS, and the precedence. §4 and §3.2. The FORM field spelling, which
	//    is the one the HTML pages read and therefore the one a body can actually carry in.
	{
		const body = form({ title: PROBE_TITLE, body: PROBE_BODY, voice: 'a-secret-in-the-body' });
		const r = note('E9', await post(`${R}?format=json`, body, null));
		check('E9', '§4: "The rule is about the FORM field ... Under `?format=json` the header is '
			+ 'authoritative, and a `voice` field in the body is refused -- `malformed`, not '
			+ 'ignored."; §3.2: "Precedence: the two-doors check runs BEFORE the credential is '
			+ 'looked up. A body carrying a `voice` field with no header is `malformed`, not '
			+ '`unvoiced`."',
			'a `voice` FORM field with no header is `malformed`, not `unvoiced`',
			refused(r, 'malformed'), shown(r));
	}

	// ── E10: both doors at once, with a credential the forge knows.
	const knownSubject = V.subject ? await recognised(R, V.subject) : null;
	if (!V.subject) {
		skip('E10', 'both doors on one request',
			'no ORE_VOICE supplied, so "both doors on one request" cannot be sent with a '
			+ 'header the forge would otherwise accept');
	} else if (knownSubject !== true) {
		skip('E10', 'both doors on one request',
			'the ORE_VOICE supplied is not recognised on the subject, so a refusal here '
			+ 'could not be told from the refusal a wrong credential earns anyway');
	} else {
		const body = form({ title: PROBE_TITLE, body: PROBE_BODY, voice: 'a-secret-in-the-body' });
		const r = note('E10', await post(`${R}?format=json`, body, V.subject));
		check('E10', '§4: "So: form field on the HTML surface, header on the machine surface, '
			+ 'never both on one request." "Refusing rather than ignoring keeps the confusion '
			+ 'loud."',
			'a good header AND a `voice` form field is still `malformed`',
			refused(r, 'malformed'), shown(r));
	}

	// ── E11/E12: §9's `d`. Sent with a recognised voice, because the contract fixes the
	//    precedence of the two-doors check and of privacy, and fixes NO ordering between a
	//    malformed body and an unrecognised credential — so an unvoiced probe here could be
	//    answered either way honestly and the check would be asserting an undefined rule.
	//
	//    The number is one that EXISTS, for the same reason: the authority does not say
	//    whether a malformed body or an unknown proposal number is reported first, so a
	//    probe at a made-up number could be answered `no_proposal` perfectly honestly.
	const canVote = knownSubject === true && await voteRouteExists();
	const head = await get(`${R}?format=json&limit=1`);
	const someN = (head.json && Array.isArray(head.json.proposals) && head.json.proposals[0])
		? head.json.proposals[0].number : null;
	if (someN === null) {
		skip('E11', 'a vote with no `d`',
			'the subject holds no proposal to vote on, and a vote at '
			+ 'a number that does not exist could be answered `no_proposal` rather than '
			+ '`malformed` without contradicting anything the authority says');
		skip('E12', 'a vote of `d=2`', 'the subject holds no proposal to vote on');
	} else if (!V.subject || knownSubject !== true) {
		skip('E11', 'a vote with no `d`',
			'needs a recognised ORE_VOICE: with a bad credential the contract does not say '
			+ 'whether `malformed` or the credential refusal comes first (GAP, below)');
		skip('E12', 'a vote of `d=2`',
			'needs a recognised ORE_VOICE, for the same reason as E11');
	} else if (!canVote) {
		skip('E11', 'a vote with no `d`',
			'§9\'s vote route does not answer on this forge, so a vote cannot be sent');
		skip('E12', 'a vote of `d=2`',
			'§9\'s vote route does not answer on this forge, so a vote cannot be sent');
	} else {
		const nowt = note('E11', await post(`${R}/${someN}/vote?format=json`, '', V.subject));
		check('E11', '§9: "A vote with no `d` at all is `malformed`, never a withdrawal: treating a '
			+ 'lost field as an instruction to delete would turn a dropped parameter into silent '
			+ 'data loss."', 'a vote with no `d` is `malformed`',
			refused(nowt, 'malformed'), shown(nowt));

		const two = note('E12', await post(`${R}/${someN}/vote?format=json`, 'd=2', V.subject));
		check('E12', '§9: "Any `d` that is not `1`, `-1` or `0` is `malformed` too."',
			'a vote of `d=2` is `malformed`', refused(two, 'malformed'), shown(two));
	}

	// ── E13: the wrong role. `unpermitted` is the one refusal that needs a voice the forge
	//    knows and a role it will not accept, so it needs a second credential or nothing.
	const knownReader = V.reader ? await recognised(R, V.reader) : null;
	if (!V.reader) {
		skip('E13', 'the role floor, `unpermitted`',
			'no ORE_VOICE_READER supplied, so `unpermitted` cannot be provoked. It needs a '
			+ 'voice the forge RECOGNISES whose role is below `pull`; anything else earns '
			+ '`unknown` and would prove nothing');
	} else if (knownReader !== true) {
		skip('E13', 'the role floor, `unpermitted`',
			'the ORE_VOICE_READER supplied is not recognised on the subject, so a 403 could '
			+ 'not be told from the 401 an unknown credential earns');
	} else if (!canVote || someN === null) {
		skip('E13', 'the role floor, `unpermitted`', '§9\'s vote route does not answer on this '
			+ 'forge, or there is no proposal to vote on. A vote is the one write whose body the '
			+ 'authority defines, so without it the role floor cannot be probed without inventing '
			+ 'a body shape (see the E16 gap)');
	} else {
		const r = note('E13', await post(`${R}/${someN}/vote?format=json`, 'd=1', V.reader));
		check('E13', '§9: "Voting needs the `pull` role — the same floor as opening a proposal and '
			+ 'commenting on one."; §3.1 table: "`unpermitted` 403 Recognised, but this role may '
			+ 'not do this."',
			'a voice below `pull` voting is `unpermitted`', refused(r, 'unpermitted'), shown(r));
	}

	// ── E14: a JSON-encoded write body. NOT ASSERTED.
	gap('E14', 'a JSON-encoded write body',
		'§9 says "The body is form-encoded, like every other write on this surface", which states '
		+ 'what a client sends and not what the forge does with anything else. Nothing in the '
		+ 'authority says a JSON body is refused. A mock asserts `malformed`; that is the '
		+ 'invented-rule shape §3.3 warns about, so this file does not send the probe.');

	// ── E15: the ordering gap E11 and E12 lean on, recorded whether or not they ran.
	gap('E15', 'precedence between a malformed body and the credential',
		'the authority fixes two precedences — the two-doors check before the credential (§3.2) '
		+ 'and privacy before the credential (§9) — and fixes no others. Whether a malformed body '
		+ 'or an unrecognised credential is reported first is undefined, so every malformed-body '
		+ 'probe here carries a credential the forge knows.');

	// ── E16: the write body's own field names, which the authority never gives.
	gap('E16', 'the write body\'s field names',
		'§4 and §9 give the write ROUTES and, for a vote, the field `d`. Neither names the fields '
		+ 'that open a proposal or add a comment. `title`, `body`, `build` and `said` are read out '
		+ 'of www/js/improve.js and gateway/src/handlers/improve.rs, which is what the product '
		+ 'sends, so the F-series asserts that the forge accepts THAT — not that the authority '
		+ 'requires it. If the forge ever renames one, this suite reports a failure the contract '
		+ 'cannot adjudicate.');
}

/// Whether §9's vote route answers at all on this forge. Established from the panel's
/// own tell: §9 records that "the absence of the key means the forge has not got there
/// yet, and the zero object means it has and nobody has voted".
async function voteRouteExists() {
	const r = await get(`${R}?format=json&limit=1`);
	const p = r.json && Array.isArray(r.json.proposals) ? r.json.proposals[0] : null;
	return !!(p && 'votes' in p);
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ F. WRITES THAT SHOULD SUCCEED — into the sandbox, never the product's backlog  │
// └───────────────────────────────────────────────────────────────────────────────┘

async function sandboxWrites() {
	if (!V.sandbox) {
		skip('F1..F9', 'every write that should succeed',
			`no ORE_VOICE_SANDBOX supplied, so nothing is written to `
			+ `${SANDBOX.account}/${SANDBOX.repo} and every write-success check is unmade. `
			+ 'THE SUBJECT IS NOT A FALLBACK: a probe proposal in the product\'s own backlog is '
			+ 'exactly what the sandbox exists to prevent (§3.3).');
		return;
	}

	// Listed WITH the sandbox voice, because F9 needs to know which proposals this voice
	// has already voted on and `mine` is absent from an unvoiced read (§9).
	let list;
	try { list = await get(`${S}?format=json&limit=${CEILING}`, V.sandbox); }
	catch (e) {
		skip('F1..F9', 'every write that should succeed',
			`the sandbox ${SANDBOX.account}/${SANDBOX.repo} could not be reached: `
			+ String(e && e.message));
		return;
	}
	if (!(list.status === 200 && list.json && Array.isArray(list.json.proposals))) {
		skip('F1..F9', 'every write that should succeed',
			`the sandbox ${SANDBOX.account}/${SANDBOX.repo} does not answer a listing `
			+ `(${shown(list)}). Create it on the forge, public, with the ORE_VOICE_SANDBOX voice `
			+ 'provisioned at `pull` or better. Nothing is written to the subject instead.');
		return;
	}
	if (await recognised(S, V.sandbox) !== true) {
		skip('F1..F9', 'every write that should succeed',
			'the ORE_VOICE_SANDBOX supplied is not recognised on the sandbox, so every '
			+ 'write below would be refused for a reason that is not the forge\'s');
		return;
	}

	// ── F1: opening one. §9's "What a write returns".
	//
	// The FIELD NAMES here are the client's (`www/js/improve.js`: title, body, build) and
	// NOT the authority's, which names no write-body fields anywhere. That is a real gap
	// and it is recorded below; what this check therefore asserts is that the forge
	// accepts what the client actually sends, which is the property the product needs.
	const opened = keep('F1', await post(`${S}?format=json`,
		form({
			title: `conformance run ${new Date().toISOString()}`,
			body:  'Opened by dev/verify_conformance.mjs against the sandbox. Safe to delete.',
			build: 'daimond-conformance',
		}), V.sandbox));
	// A throttle here is the forge spending this voice's allowance, not a forge that fails
	// the contract, so F1 is not asserted at all. `throttled` is checked BEFORE the shape,
	// because a red F1 reading "429 error=throttled" says the opposite of what it means.
	if (refused(opened, 'throttled')) {
		skip('F1..F9', 'every write that should succeed',
			'the sandbox voice\'s write allowance is spent, so the forge answered `throttled` '
			+ 'and NOTHING below was written. That is §2\'s throttle working: oregami allows '
			+ 'twenty writes a voice a minute and this suite spends two a run, so several runs '
			+ 'in quick succession earn one. It recovers on its own — wait a minute and run '
			+ 'again. The throttle\'s shape was read by G1..G4 like any other refusal.');
		return;
	}
	const rec = opened.json;
	const isDetail = !!rec && !rec.error && typeof rec.number === 'number'
		&& typeof rec.body === 'string' && Array.isArray(rec.discussion)
		&& FIELDS.every(f => f in rec);
	check('F1', '§9, "What a write returns": "Every write under `?format=json` returns the detail '
		+ 'shape of the record it changed — a new proposal, a comment, a decision and a vote '
		+ 'alike."; §3, "One proposal", for what that shape is.',
		'opening a proposal answers with the detail shape', isDetail, shown(opened));
	if (!isDetail) {
		skip('F2..F9', 'everything after the sandbox write',
			'the sandbox write did not answer a record, so nothing below it can be measured. '
			+ 'If the answer was `malformed`, read gap E16: the authority names no write-body '
			+ 'field names and these are the client\'s.');
		return;
	}
	const n = rec.number;

	// ── F2/F3: what a brand-new proposal carries. §9.
	check('F2', '§9: "`votes` on a proposal nobody has voted on is {"for":0,"against":0}" -- the '
		+ 'zero object, never null and never absent."',
		'a proposal nobody has voted on carries the zero object',
		!!rec.votes && canon(rec.votes) === '{"against":0,"for":0}', JSON.stringify(rec.votes));
	check('F3', '§9: "When the request carries a voice, the record also carries `mine`, one of '
		+ '`1`, `-1` or `null`."', 'and `mine`, present and null, on a write that carried a voice',
		'mine' in rec && rec.mine === null, `mine=${JSON.stringify(rec.mine)}`);

	// ── F4: commenting. The `said` field is the client's spelling; same gap as F1.
	const said = `A comment from the conformance run at ${new Date().toISOString()}.`;
	const commented = keep('F4', await post(`${S}/${n}?format=json`, form({ said }), V.sandbox));
	// The allowance counts proposals and comments together, so it can run out BETWEEN the
	// two writes of one run. Seen once, as a red F4 under an unrelated `--break`, which is
	// how a throttle gets credited to whichever break happened to be in force.
	if (refused(commented, 'throttled')) {
		skip('F4..F9', 'commenting, and every write after it',
			'the sandbox voice\'s write allowance ran out between the proposal and the comment '
			+ '— oregami counts the two against one allowance of twenty a minute — so the '
			+ 'comment was refused `throttled` and nothing after it was driven. Not a '
			+ 'conformance failure; wait a minute and run again.');
		return;
	}
	const cr = commented.json;
	check('F4', '§9: "Every write under `?format=json` returns the detail shape of the record it '
		+ 'changed"; §3: "`comments` is a count everywhere; the discussion is `discussion`."',
		'a comment answers the detail shape, with the count up by one and the entry in the discussion',
		!!cr && !cr.error && cr.comments === rec.comments + 1
		&& Array.isArray(cr.discussion) && cr.discussion.some(d => d && d.said === said),
		shown(commented));

	// ── F5..F8: §9's votes, in the one order that tells them apart.
	if (!(rec.votes && await voteRouteOn(S))) {
		skip('F5..F8', 'casting, repeating, moving and withdrawing a vote',
			'§9\'s vote route does not answer on this forge, so casting, repeating, '
			+ 'moving and withdrawing cannot be driven. §9 itself records that a forge without it '
			+ 'carries no `votes` key.');
	} else {
		const cast = keep('F5', await post(`${S}/${n}/vote?format=json`, 'd=1', V.sandbox));
		// Votes have their own, far larger allowance — two hundred a minute against the
		// twenty for proposals and comments — so this is the unlikely one. Guarded anyway,
		// because the cost of not guarding it is a red line blaming the forge for §2.
		if (refused(cast, 'throttled')) {
			skip('F5..F9', 'casting, repeating, moving and withdrawing a vote, and the '
				+ '`changed` bump',
				'the sandbox voice\'s VOTE allowance is spent, so the first vote was refused '
				+ '`throttled`. Not a conformance failure; wait a minute and run again.');
			return;
		}
		check('F5', '§9: "A vote\'s answer therefore carries the new `votes` and the caller\'s own '
			+ '`mine`, so a panel needs no second request to redraw the control the tester just '
			+ 'tapped."',
			'a vote answers the record with the new tally and the caller\'s own `mine`',
			!!cast.json && cast.json.votes && cast.json.votes.for === 1
			&& cast.json.votes.against === 0 && cast.json.mine === 1, shown(cast));

		const again = keep('F6', await post(`${S}/${n}/vote?format=json`, 'd=1', V.sandbox));
		check('F6', '§9: "A second `POST` carrying the same `d` is idempotent and not an '
			+ 'increment."', 'the same vote again does not increment',
			!!again.json && again.json.votes && again.json.votes.for === 1
			&& again.json.mine === 1, shown(again));

		const moved = keep('F7', await post(`${S}/${n}/vote?format=json`, 'd=-1', V.sandbox));
		check('F7', '§9: "the opposite `d` moves the vote."',
			'the opposite vote moves rather than adds',
			!!moved.json && moved.json.votes && moved.json.votes.for === 0
			&& moved.json.votes.against === 1 && moved.json.mine === -1, shown(moved));

		const drop = keep('F8', await post(`${S}/${n}/vote?format=json`, 'd=0', V.sandbox));
		check('F8', '§9: "`0` withdraws"; "A withdrawal by a voice that never voted is a 200 no-op '
			+ 'with `mine` null. It asked for a state and that state is what it gets."',
			'a withdrawal empties the tally and leaves `mine` null',
			!!drop.json && drop.json.votes && canon(drop.json.votes) === '{"against":0,"for":0}'
			&& drop.json.mine === null, shown(drop));

		const again0 = keep('F8b', await post(`${S}/${n}/vote?format=json`, 'd=0', V.sandbox));
		check('F8b', '§9: "A withdrawal by a voice that never voted is a 200 no-op with `mine` '
			+ 'null."', 'and withdrawing when nothing is held is a no-op, not a refusal',
			!!again0.json && !again0.json.error && again0.json.mine === null, shown(again0));

		// ── F9: a vote bumps `changed`. Only visible on a record that was not written in
		//    this run: on a proposal opened seconds ago, a forge that never touched
		//    `changed` would be indistinguishable from one that did. §3.3's own shape.
		//    It must also be one this voice has NOT voted on, or an idempotent repeat is
		//    what gets sent and the authority does not say whether a vote that changed
		//    nothing still bumps `changed`.
		const old = (list.json.proposals || []).find(p =>
			typeof p.changed === 'number'
			&& p.changed < Math.floor(Date.now() / 1000) - 300
			&& p.mine === null);
		if (!old) {
			skip('F9', '`changed` bumped by a vote',
				'the sandbox holds no proposal older than five minutes that this voice has '
				+ 'not voted on, and a `changed` bump on a record written seconds ago cannot be '
				+ 'told from one that was never touched. A later run will have one.');
		} else {
			const before = old.changed;
			const bumped = keep('F9', await post(`${S}/${old.number}/vote?format=json`, 'd=1',
				V.sandbox));
			check('F9', '§9: "A vote bumps `changed`. The record changed."',
				'a vote on an older proposal bumps `changed`',
				!!bumped.json && typeof bumped.json.changed === 'number'
				&& bumped.json.changed > before, `${before} -> ${bumped.json && bumped.json.changed}`);
			// Leave the tally as it was found. `changed` stays bumped, which is what the
			// check just proved and is the sandbox's business.
			await post(`${S}/${old.number}/vote?format=json`, 'd=0', V.sandbox);
		}
	}
}

/// Whether the sandbox's records carry §9's tally, read the same way as the subject's.
async function voteRouteOn(route) {
	const r = await get(`${route}?format=json&limit=1`);
	const p = r.json && Array.isArray(r.json.proposals) ? r.json.proposals[0] : null;
	return !!(p && 'votes' in p);
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ G. THE SHAPE OF EVERY REFUSAL SEEN — one property, read over the whole run     │
// └───────────────────────────────────────────────────────────────────────────────┘

async function refusalShapes() {
	if (!refusals.length) {
		skip('G1..G4', 'the shape of a refusal',
			'no refusal was seen in this run at all, which means the probes above did '
			+ 'not reach the forge — read their failures rather than this line');
		return;
	}

	// ── G1: the media type, with no charset parameter. §3.2.
	{
		const wrong = refusals.filter(({ r }) => {
			const parts = r.type.split(';').map(s => s.trim());
			return parts[0].toLowerCase() !== JSON_CT || parts.length > 1;
		}).map(({ where, r }) => `${where}:${r.type || '(none)'}`);
		check('G1', '§3.2: "A refusal is served as `application/json`, no `charset` — JSON is UTF-8 '
			+ 'by definition and the media type has no such parameter."',
			`all ${refusals.length} refusals are application/json with no charset`,
			wrong.length === 0, wrong.slice(0, 5).join(' '));
	}

	// ── G2: the token is one of the nine, and `said` is there for a person to read. §3.1.
	{
		const wrong = refusals.filter(({ r }) =>
			!(r.json.error in TABLE) || typeof r.json.said !== 'string' || !r.json.said.trim())
			.map(({ where, r }) => `${where}:${r.json.error}`);
		check('G2', '§3.1: "`error` is the stable token a client branches on; `said` is the '
			+ 'sentence a person reads"; the table lists nine tokens and "nine tokens are emitted '
			+ 'and nine are now listed."',
			'every refusal names one of the nine tokens and carries a sentence',
			wrong.length === 0, wrong.slice(0, 5).join(' '));
	}

	// ── G3: token and status agree with §3.1's table.
	{
		const wrong = refusals.filter(({ r }) => TABLE[r.json.error] !== r.status)
			.map(({ where, r }) => `${where}:${r.json.error}=${r.status}, expected ${TABLE[r.json.error]}`);
		check('G3', '§3.1\'s table: absent 404, unvoiced 401, unknown 401, unpermitted 403, '
			+ 'throttled 429, malformed 400, no_proposal 404, unsupported 405, internal 500.',
			'every refusal\'s status is the one its token carries in the table',
			wrong.length === 0, wrong.slice(0, 4).join('; '));
	}

	// ── G4: `because` appears only on `throttled`. §3.1.
	{
		const wrong = refusals.filter(({ r }) =>
			('because' in r.json) && (r.json.error !== 'throttled'
				|| !BECAUSE.includes(r.json.because)))
			.map(({ where, r }) => `${where}:${r.json.error}/${r.json.because}`);
		check('G4', '§3.1: "`because` appears only on `throttled`." and the table: "`throttled` 429 '
			+ '`because` is `address`, `voice` or `failing`."',
			'`because` appears only on `throttled`, and only as one of its three reasons',
			wrong.length === 0, wrong.slice(0, 5).join(' '));
	}

	// ── G5: canonical bytes, over every JSON body this run received.
	{
		// One answer may sit in both ledgers -- a refusal is a body too -- so it is read
		// once, by identity, rather than counted twice in the total this check reports.
		const seen = new Map();
		for (const b of bodies.concat(refusals)) if (!seen.has(b.r)) seen.set(b.r, b);
		const all = [...seen.values()];
		const wrong = [];
		for (const { where, r } of all) {
			let want = null;
			try { want = canon(r.json); } catch (e) { wrong.push(`${where}:${e.message}`); continue; }
			if (want !== r.text) wrong.push(`${where}:${r.text.slice(0, 40)}`);
		}
		check('G5', '§3: "The body is RFC 8785 canonical JSON, produced by `Dat::json_canonical()`"; '
			+ '§3.2: "`json_canonical` sorts keys by UTF-16 code unit"; §3.1: "Under `?format=json` '
			+ 'every answer is JSON, refusals included."; §9: a write "returns the detail shape of '
			+ 'the record it changed" — the same representation through the same encoder.',
			`all ${all.length} JSON bodies are canonical bytes`, wrong.length === 0,
			wrong.slice(0, 3).join(' | '));
	}

	// ── G6: the throttle sentence. NOT ASSERTED.
	gap('G6', 'what the throttle sentence may not name',
		'§3.1 requires that "The throttle sentence must not name which allowance was spent", and '
		+ 'the authority names no allowances for the forge — so a mechanical check would have to '
		+ 'invent the word list it searches for, which is §3.3\'s third and worst shape. Read the '
		+ 'sentence by eye when a throttle is next seen.');
	skip('G7', '`unsupported`',
		'`unsupported` (405) is not provoked: §3.1 records that it "is unreachable from any '
		+ 'honest client", and a probe would assert the door\'s verb guard rather than this '
		+ 'surface. It is NOT dead vocabulary — §3.1 says so explicitly — and this line is why no '
		+ 'check reaches it.');
	skip('G8', '`internal`',
		'`internal` (500) is not provoked: a fault inside the forge cannot be induced from '
		+ 'outside, and breaking a live forge to watch it say so is not a conformance check.');
	// A throttle is never provoked on purpose, but one CAN arrive — spending a voice's write
	// allowance over several quick runs is enough — and a line saying none was seen when one
	// was is the stale report this file exists to avoid. So say which it was.
	const throttles = refusals.filter(({ r }) => r.json.error === 'throttled');
	skip('G9', '`throttled`', throttles.length
		? `${throttles.length} throttle(s) arrived unasked — at ${throttles.map(t => t.where)
			.join(', ')} — and G1..G4 read their shape like any other refusal. NO CHECK `
			+ 'PROVOKES one: earning it on purpose takes a flood, §2 shows what a flood on this '
			+ 'path costs everybody, and §2.1 puts a failure backstop behind it. What is unmade '
			+ 'is the write series the throttle stopped, named on its own line above.'
		: '`throttled` (429) is not provoked: earning one takes a flood, §2 shows what a '
			+ 'flood on this path costs everybody, and §2.1 puts a failure backstop behind it. '
			+ 'Its shape is still read by G1..G4 if one arrives.');
}


// ┌───────────────────────────────────────────────────────────────────────────────┐
// │ THE REPORT                                                                     │
// └───────────────────────────────────────────────────────────────────────────────┘

/// One line naming a set of clauses, folded so the same clause twice reads once.
///
/// A DECLARATION rather than a `const` arrow, because `finish()` is called at module
/// top level well above this point. As an arrow it sat in the temporal dead zone and
/// threw on every run that had anything to skip -- the instrument crashing precisely
/// when it had gaps to report.
function named(list) {
	return [...new Set(list.map(s => s.clause))].join('; ');
}

function finish() {
	const undef = skipped.filter(s => s.undefined_);
	const unasked = skipped.filter(s => !s.undefined_);

	// THE SUMMARY LINE NAMES WHAT WAS NOT ASKED. "37 passed" beside four silent skips
	// reads as coverage, and a skipped surface reads as a clean one -- which is §3.3's
	// own defect class arriving one level up, in the instrument rather than the subject.
	console.log(`\n${ok.length} passed, ${bad.length} failed, ${skipped.length} skipped`
		+ (undef.length ? ` (undefined: ${named(undef)})` : '')
		+ (unasked.length ? ` (unasked: ${named(unasked)})` : ''));

	if (unasked.length) {
		console.log('\nNOT ASKED — each of these is a surface this run says nothing about:');
		for (const s of unasked) console.log(`  ${s.id}  ${s.clause} — ${redact(s.why)}`);
	}
	if (GAPS.length) {
		console.log('\nUNDEFINED IN THE AUTHORITY — reported rather than guessed (§3.3):');
		for (const g of GAPS) console.log(`  ${g.id}  ${g.clause}\n      ${redact(g.what)}`);
	}
	if (flag('cites')) {
		console.log('\nEvery check and the sentence it rests on:');
		for (const id of Object.keys(CITES).sort()) console.log(`  ${id}  ${CITES[id]}`);
	}

	console.log(`\nsubject ${SUBJECT.account}/${SUBJECT.repo} at ${BASE.url}`
		+ `   sandbox ${SANDBOX.account}/${SANDBOX.repo}`);
	if (!readLane) {
		console.log('THE SUBJECT DID NOT ANSWER. Whatever passed above, this run says nothing '
			+ 'about the repository the product names — which is the whole reason this file '
			+ 'exists (§3.3).');
	}

	// A break EXPECTS a failure. A break that changed nothing is a finding about the
	// check it was aimed at, not a clean run, so it exits non-zero and says which.
	if (BREAK) {
		console.log(bad.length
			? `\nbreak '${BREAK}' turned red: ${bad.join(', ')}`
			: `\nBREAK '${BREAK}' CHANGED NOTHING. The check it targets did not run, or a `
				+ 'different rule is quietly holding the property. That is a finding, not a '
				+ 'fixture problem — chase it until it is explained.');
		process.exit(bad.length ? 0 : 1);
	}

	// A run that failed nothing because it asked nothing is the failure this suite is
	// named after, so an unanswered subject is an exit code and not a remark.
	process.exit(bad.length || !readLane ? 1 : 0);
}
