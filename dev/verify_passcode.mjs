// verify_passcode.mjs — the beta passcode, proved at the network rather than in
// the source.
//
// What this file is defending is a one-time credential that gifts a five-year
// Pro licence -- the same term a bought one runs for -- and opens the only
// endpoint on this gateway that receives anything about how a user behaves.
// Every one of those words is a property somebody could get wrong quietly:
//
//   * "one-time"  — a code that redeems twice gives the beta away.
//   * "one-time under concurrency" — a check-then-write with no lock is TWO
//     redemptions being told yes, and it only shows up under load.
//   * "beta only"  — telemetry from an account nobody let in is telemetry
//     nobody consented to.
//   * "capped"     — this is the first unauthenticated write on a box holding a
//     live Stripe key, and there is no other rate limiting in the gateway.
//
// ── How each check is shown red ─────────────────────────────────────
//
// Two of them are shown red IN THIS RUN, by driving the gateway's own settings
// rather than by editing anything:
//
//   * the attempt cap is proved to refuse at N, and then the SAME sequence is
//     proved NOT to refuse with the cap set to 0 — so a green "it refused"
//     cannot have come from something else refusing.
//   * the beta gate on telemetry is exercised from both sides with two real
//     accounts in the same run: one that redeemed and one that did not.
//
// The rest were shown red against deliberately broken source, each break one
// line, and what each one takes down is recorded here so nobody has to guess:
//
//   delete the `is_redeemed` check in `Store::redeem_passcode`
//      -> six checks here fail, including both halves of the race.
//   stop writing the beta status in the same function
//      -> the three telemetry checks fail and nothing else does.
//   delete `lock_mutex!(self.writes)` from the same function
//      -> NOTHING here fails. See the race section for why, and for which test
//         does catch it.
//   write the account before the code is checked
//      -> caught by `schema::tests::test_a_refused_code_leaves_no_account_behind`.
//   take the FIRST `X-Forwarded-For` instead of the last
//      -> caught by `handlers::passcode::tests::
//         test_the_last_forwarded_address_is_the_one_counted`.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	cd gateway && env -u CARGO_TARGET_DIR cargo build --release
//	node dev/verify_passcode.mjs
//
// No browser: every call here is a plain HTTP request with a cookie this file
// carries itself, so there is no compositor, no DISPLAY and no page to wait on.
// It starts a gateway of its own on a port of its own, so it does not have to
// wait for whoever is holding :9002 -- see `buildWorkDir` below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, procLog, GWDIR, GWBIN } from './gwbin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// ── A gateway of its own, on a port of its own ──────────────────────
//
// Six lanes are building this app at once and the gateway takes a single
// exclusive hold on `:9002` and on `gateway/o3db`. A verifier that insisted on
// both would be a verifier that can only run when nobody else is working, and
// the last time that was the arrangement the answer was to kill whatever held
// the port — which is somebody else's half-finished run.
//
// So this builds a working directory of its own: the deployed `app.jdat` with
// one number changed, the real signing keys symlinked in (a gifted Pro licence
// has to be signed with the same key a bought one is, or this proves nothing),
// and an EMPTY store. The store being empty is not only politeness: the checks
// below count passcodes, and counting them in a store somebody else has been
// writing to would measure their afternoon.
// 9402, deliberately clear of everything the harness already numbers: the dev
// servers run at 8777+N and the mock providers at 9099+N, so a "spare" port in
// the nine-thousand-one-hundreds is somebody's world, and picking one answers a
// health probe with a mock LLM's 404 rather than with nothing.
const PORT    = Number(process.env.DAIMOND_GW_PORT || 9402);
const GW      = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK    = path.join(SCRATCH, 'verify_passcode-gw');
const LOG     = procLog('verify_passcode');
/// A fault injected on purpose, so a guard can be shown going red:
///
///   --break=knob   the knob is never written, only read back
const BREAK   = (process.argv.find(a => a.startsWith('--break=')) || '').slice(8);

/// Build the working directory, and hand back its path.
function buildWorkDir() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, 'keys'), { recursive: true });
	// Every key EXCEPT the database's: the store is new, so its at-rest key must
	// be new too, and pointing a fresh store at the live key would either fail
	// or -- worse -- succeed against the live store.
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(WORK, 'keys', k));
	}
	const cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${PORT})`);
	if (!cfg.includes(`(u16|${PORT})`)) {
		console.log('  FAIL could not set the listen port in the copied app.jdat — '
			+ 'has its shape changed?');
		process.exit(1);
	}
	fs.writeFileSync(path.join(WORK, 'app.jdat'), cfg);
	return WORK;
}

const ok = [], bad = [];
/// Record a check. `detail` is the evidence, printed either way; `why` is what
/// went wrong and is printed only when it did -- so a passing line cannot read
/// like a failure, which the first draft of this file managed twice.
const check = (name, pass, detail, why) => {
	(pass ? ok : bad).push(name);
	const tail = pass ? (detail ? ' — ' + detail : '')
		: ' — ' + [why, detail].filter(Boolean).join(' · ');
	console.log((pass ? '  ok   ' : '  FAIL ') + name + tail);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The guard's ring is eight requests long and its rate ceiling is two a
// second, so eight requests spanning less than 3.5 s read as a flood. Every
// phase below is separated by more than that, on purpose: a 429 arriving in the
// middle of a functional check would be the cap doing its job and would still
// look exactly like the check failing. The one phase that WANTS a flood is last.
const PHASE_GAP = 1400;

// ── Device identities, exactly as the app builds them ───────────────

/// A fresh device keypair, and the two things the gateway asks of it.
function device() {
	const kp = crypto.generateKeyPairSync('ed25519');
	// The raw 32 bytes, which is what WebCrypto's `exportKey('raw')` gives and
	// what the gateway decodes: the last 32 of the 44-byte SPKI wrapper.
	const raw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
	const b64url = b => b.toString('base64')
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return {
		pub:  b64url(raw),
		alg:  'Ed25519',
		sign: s => crypto.sign(null, Buffer.from(s, 'utf8'), kp.privateKey).toString('base64'),
	};
}

/// The binding proof `/api/account` and `/api/passcode/redeem` both demand.
function binding(dev) {
	const ts = Math.floor(Date.now() / 1000);
	return { pubkey: dev.pub, alg: dev.alg, ts, sig: dev.sign(`daimond-gw-account:v1:${dev.pub}:${ts}`) };
}

/// One HTTP call, carrying a cookie jar this file owns.
///
/// Node's fetch keeps no cookies, so the session is moved by hand. That is a
/// feature here: it makes it impossible to accidentally reuse one account's
/// session for another's request, which two accounts in one browser context
/// would do silently.
async function call(jar, method, url, body, xff) {
	const headers = { 'x-daimond-api': '1' };
	if (jar && jar.cookie) headers.cookie = jar.cookie;
	if (body !== undefined) headers['content-type'] = 'application/json';
	// Talking to the gateway directly, as development does, there is no Steel in
	// front to append one -- so every request otherwise shares the single
	// "unknown" bucket and twenty at once read as a flood. Naming an address
	// puts a racer in a bucket of its own, which is what lets the race be about
	// the store rather than about the rate limit.
	if (xff) headers['x-forwarded-for'] = xff;
	const r = await fetch(GW + url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
	if (jar && set.length) {
		jar.cookie = set.map(c => c.split(';')[0]).join('; ');
	}
	let j = null;
	try { j = await r.json(); } catch (e) {}
	return { status: r.status, j };
}

/// Register a device the ordinary way and take a session on it. This is the
/// account a stranger gets today, and the one telemetry must refuse.
async function plainAccount() {
	const dev = device();
	const jar = {};
	const acct = await call(jar, 'POST', '/api/account', binding(dev));
	await session(jar, dev);
	return { dev, jar, id: acct.j && acct.j.account_id };
}

/// Prove possession of the key and take a session cookie.
async function session(jar, dev) {
	const ch = await call(jar, 'POST', '/api/auth/challenge', { pubkey: dev.pub, alg: dev.alg });
	if (!ch.j || !ch.j.challenge) return false;
	const v = await call(jar, 'POST', '/api/auth/verify', {
		challenge_id: ch.j.challenge_id,
		sig: dev.sign(ch.j.challenge),
	});
	return v.status === 200;
}

/// One telemetry batch, in the shape the endpoint accepts. Seven integer fields
/// and one event, because the point of the call is WHO may make it, not what it
/// carries.
///
/// `t` is SECONDS, matching `pack()` in `www/js/telemetry.js`. Milliseconds
/// exceed the endpoint's ceiling on any integer and the batch is refused for
/// being out of range -- a 400 that looks exactly like the beta gate having
/// nothing to do with it, and did, for the first run of this file.
function batch(wave) {
	return {
		v: 1, b: 0, l: 1, w: wave,
		t: Math.floor(Date.now() / 1000),
		d: 0,
		e: [[1, 12, 340]],
	};
}

const procs = [];
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }
/// Start the gateway in the working directory, and wait for it to serve.
///
/// The wait is generous because it is not waiting on the gateway: an empty
/// o3db spends twenty-odd seconds initialising its zones before anything
/// listens, and a wait sized for a warm store reports "the gateway did not
/// start" about a gateway that was starting perfectly well -- which is exactly
/// the misdiagnosis this file is meant not to produce.
async function startGateway(cwd, ownerAccount) {
	const gw = spawn(GWBIN, [], {
		cwd,
		env: {
			...process.env,
			APP_MODE: 'sandbox',
			...(ownerAccount ? { DAIMOND_OWNER_ACCOUNTS: ownerAccount } : {}),
		},
		stdio: LOG.stdio,
	});
	procs.push(gw);
	const up = await waitFor(async () => (await fetch(`${GW}/api/health`)).ok, 120000);
	return { gw, up };
}

/// Stop it, and wait for the PORT to be free rather than for the process to be
/// signalled. A second gateway started on the strength of a `kill` returning
/// meets `AddrInUse` and dies, and the run that follows measures nothing.
async function stopGateway(gw) {
	try { gw.kill('SIGKILL'); } catch (e) {}
	await waitFor(async () => {
		try { await fetch(`${GW}/api/health`); return false; }
		catch (e) { return true; }
	}, 30000, 200);
	await sleep(500);
}

async function waitFor(fn, ms = 20000, gap = 250) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

(async () => {
	requireFreshGateway();

	let stray = false;
	try { stray = (await fetch(`${GW}/api/health`)).ok; } catch (e) {}
	if (stray) {
		console.log(`  FAIL something is already answering on :${PORT}. This suite `
			+ 'pins an owner in configuration and must start its own gateway; set '
			+ 'DAIMOND_GW_PORT to a free port.');
		process.exit(1);
	}
	const cwd = buildWorkDir();

	// The owner has to exist before the gateway that pins them, so the first
	// gateway is started with nobody pinned, an account is made, and the second
	// is started naming it. Exactly what verify_operators does, and for the same
	// reason.
	let started = await startGateway(cwd, null);
	check('gateway starts', started.up);
	if (!started.up) { LOG.report(); cleanup(); process.exit(1); }

	const boss = await plainAccount();
	check('an account to be the owner', !!boss.id, boss.id);

	// An owner is pinned in CONFIGURATION, which is what makes a console lockout
	// impossible -- so the account has to exist before the process that names it.
	await stopGateway(started.gw);
	started = await startGateway(cwd, boss.id);
	check('gateway restarts with that account pinned as owner', started.up);
	if (!started.up) { LOG.report(); cleanup(); process.exit(1); }
	// The session was taken against the first process, and the store is the
	// same one, so it survives the restart. Re-taken anyway, because a session
	// that did not survive would fail every console call below with a 401 that
	// says nothing about passcodes.
	await session(boss.jar, boss.dev);
	const who = await call(boss.jar, 'GET', '/api/admin?view=whoami');
	check('the console recognises the owner', who.j && who.j.role === 'owner',
		JSON.stringify(who.j));

	/// Mint a passcode from the console, as the operator does.
	async function mint(label, wave) {
		const r = await call(boss.jar, 'POST', '/api/admin?view=passcodes',
			{ label, wave: wave || 1 });
		return r;
	}
	/// Set one of the gateway's own knobs, which is how the cap is driven.
	///
	/// AND CONFIRM IT READS BACK, because the alternative to confirming is
	/// measuring the wrong number without being told. `settings::str` answers a
	/// store read that returns nothing exactly as it answers one that errors:
	/// it falls through to what `app.jdat` declares. So a knob that has been
	/// POSTed but is not yet readable leaves the handler running the CONFIGURED
	/// value -- `redeem_max_fails` = 10 rather than the 3 this drives it to --
	/// and the run then measures a cap that was never in force while reporting
	/// on the one it thought it set. That is a silent mis-measurement, and it is
	/// one of the two mechanisms that could explain the single unreproduced
	/// failure of "the fourth is refused by the cap" in the 5a0bcbf gate (the
	/// other is the lost-count path `passcode.rs::note` documents). This does not
	/// decide which it was; it removes this one from the field for good, and
	/// turns it into a named failure if it ever does happen.
	///
	/// The read goes through `view=settings`, which reads `store.get_setting` --
	/// the same store read the handler's own `settings::str` makes.
	async function setKnob(route, key, value) {
		const r = BREAK === 'knob' ? { status: 0, j: null }
			: await call(boss.jar, 'POST', '/api/admin?view=settings',
				{ route, key, value: String(value) });
		for (let i = 0; i < 10; i++) {
			const seen = await call(boss.jar, 'GET', '/api/admin?view=settings');
			const grp  = ((seen.j && seen.j.groups) || []).find(g => g.route === route);
			const knob = ((grp && grp.knobs) || []).find(k => k.key === key);
			if (knob && String(knob.value) === String(value)) return r;
			await sleep(200);
		}
		check(`the ${key} knob was set and reads back`, false,
			'it did not, so everything below it would have measured the configured '
			+ 'value instead of the one this set');
		return r;
	}
	/// Redeem, from a device that has never been seen here.
	async function redeem(dev, code, xff) {
		return await call(null, 'POST', '/api/passcode/redeem',
			Object.assign({ code }, binding(dev)), xff);
	}

	// ── Minting ─────────────────────────────────────────────────

	const noLabel = await mint('   ', 1);
	check('a passcode with nothing to say whose it is refused',
		noLabel.status === 400, 'status ' + noLabel.status);

	const minted = await mint('Sam, Perth meetup', 2);
	const code = minted.j && minted.j.passcode && minted.j.passcode.code;
	check('an owner mints a labelled passcode',
		minted.status === 200 && !!code, 'status ' + minted.status + ' · ' + code);
	check('the code comes back grouped for somebody to type',
		typeof code === 'string' && code.includes('-'), code);
	check('the label the operator typed is what comes back',
		!!minted.j && minted.j.passcode.label === 'Sam, Perth meetup',
		JSON.stringify(minted.j && minted.j.passcode));

	// The cap must not be the thing that decides any functional check below, so
	// it is opened wide first and closed deliberately at the end.
	const wideOpen = await setKnob('/api/passcode/redeem', 'redeem_max_fails', 1000);
	check('the attempt cap is a knob the owner can move',
		wideOpen.status === 200, 'status ' + wideOpen.status);

	// ── Redemption ──────────────────────────────────────────────

	await sleep(PHASE_GAP);
	const sam = device();
	const first = await redeem(sam, code);
	check('a fresh device redeems the code', first.status === 200 && first.j && first.j.ok === true,
		'status ' + first.status + ' · ' + JSON.stringify(first.j));
	check('redemption created the account rather than needing one first',
		!!first.j && first.j.created === true);
	check('redemption answers the wave the passcode was minted into',
		!!first.j && first.j.wave === 2, JSON.stringify(first.j && first.j.wave));
	check('redemption gifted Pro', !!first.j && first.j.pro === true);
	check('the new account was given a public handle',
		!!first.j && typeof first.j.handle === 'string' && first.j.handle.length > 0,
		first.j && first.j.handle);

	// The licence, asked for the way the client asks for it: a gifted Pro must
	// be the same signed artefact a bought one is, or the client would need a
	// second way to believe in it.
	const samJar = {};
	await session(samJar, sam);
	const lic = await call(samJar, 'GET', '/api/licence');
	check('the client is served a real signed Pro licence',
		lic.status === 200 && !!lic.j && lic.j.held === true
			&& !!lic.j.licence && typeof lic.j.licence.sig === 'string'
			&& lic.j.licence.sig.length > 40,
		'status ' + lic.status + ' · held ' + (lic.j && lic.j.held));

	// ── Telemetry: the gate, from both sides, in one run ────────

	await sleep(PHASE_GAP);
	const stranger = await plainAccount();
	const strangerTel = await call(stranger.jar, 'POST', '/api/telemetry', batch(2));
	check('an account that redeemed nothing cannot reach telemetry',
		strangerTel.status === 403, 'status ' + strangerTel.status);

	const samTel = await call(samJar, 'POST', '/api/telemetry', batch(2));
	check('the redeemed account can', samTel.status === 200 && !!samTel.j && samTel.j.stored === 1,
		'status ' + samTel.status + ' · ' + JSON.stringify(samTel.j));
	// Both sides in one run is what makes the pair worth anything: a 403 for
	// everybody would pass the first check on its own, and a 200 for everybody
	// would pass the second.
	check('so the beta status is what decides it, not the endpoint being open or shut',
		strangerTel.status === 403 && samTel.status === 200);

	// ── Single use ──────────────────────────────────────────────

	await sleep(PHASE_GAP);
	const gatecrasher = device();
	const second = await redeem(gatecrasher, code);
	check('the same code cannot be redeemed twice',
		second.status === 409 && !!second.j && second.j.reason === 'spent',
		'status ' + second.status + ' · ' + JSON.stringify(second.j));

	// And the refusal has to mean something: the second device must be OUT. A
	// 409 that nonetheless wrote the beta status would pass the check above.
	const crashJar = {};
	const crashHasAccount = await session(crashJar, gatecrasher);
	check('a refused redemption left no account behind for that device',
		crashHasAccount === false, null,
		'the device took a session, so an account was written for it anyway');

	// ── The race ────────────────────────────────────────────────

	await sleep(PHASE_GAP);
	const raceMint = await mint('Race, six devices at once', 1);
	const raceCode = raceMint.j && raceMint.j.passcode && raceMint.j.passcode.code;
	check('a second passcode for the race', raceMint.status === 200 && !!raceCode);

	// Each racer arrives from an address of its own, so all of them reach the
	// store: the rate limit is per address, and twenty-four from one would be a
	// flood and would be refused as one — correct behaviour, and it would make
	// this measure the cap instead of the critical section.
	//
	// WHAT THIS CHECK DOES AND DOES NOT PROVE, because a check nobody has shown
	// red is a check nobody should trust:
	//
	// It catches a MISSING SINGLE-USE RULE outright — a build with the
	// `is_redeemed` guard deleted answers twenty-four 200s and this line fails
	// loudly. It does NOT catch a missing LOCK: a build with
	// `lock_mutex!(self.writes)` taken out of `Store::redeem_passcode` passes
	// this file thirty-five out of thirty-five, at six racers and again at
	// twenty-four. The window a missing lock opens is the microseconds between
	// the store read and the store write, and requests arriving over separate
	// sockets do not land inside it however many of them there are.
	//
	// The lock is proved red by `schema::tests::
	// test_two_racing_redemptions_produce_exactly_one_winner`, which holds eight
	// threads on a barrier and hits the store directly: that one fails 8-of-8 on
	// an unlocked build, three runs out of three, with no artificial widening.
	// So this line is the end-to-end smoke check and that one is the authority.
	// Do not delete that test on the strength of this one passing.
	const RACERS = 24;
	const racers = Array.from({ length: RACERS }, () => device());
	const results = await Promise.all(racers.map(
		(d, i) => redeem(d, raceCode, `198.51.100.${100 + i}`)));
	const won = results.filter(r => r.status === 200);
	const spent = results.filter(r => r.status === 409);
	check(`exactly one of ${RACERS} simultaneous redemptions wins`,
		won.length === 1, won.length + ' won, ' + spent.length + ' told the code was spent',
		'statuses ' + results.map(r => r.status).join(','));
	check('the rest were refused by the code being spent, not by the cap',
		spent.length === RACERS - 1, null, results.map(r => r.status).join(','));

	// Asserted through the gateway as well as through the replies: five 409s
	// and six beta accounts would pass the count above and still have given the
	// beta away six times.
	let inBeta = 0;
	for (const d of racers) {
		const jar = {};
		if (!(await session(jar, d))) continue;
		const t = await call(jar, 'POST', '/api/telemetry', batch(1));
		if (t.status === 200) inBeta += 1;
	}
	check('and exactly one of them is actually in the beta', inBeta === 1,
		inBeta + ' of ' + RACERS + ' reached the telemetry endpoint');

	// ── What the console shows afterwards ───────────────────────

	await sleep(PHASE_GAP);
	const listed = await call(boss.jar, 'GET', '/api/admin?view=passcodes');
	const rows = (listed.j && listed.j.passcodes) || [];
	const sams = rows.find(p => p.label === 'Sam, Perth meetup');
	check('the console lists the passcodes', listed.status === 200 && rows.length >= 2,
		'status ' + listed.status + ' · ' + rows.length + ' rows');
	check('a spent code is no longer shown', !!sams && sams.code === '',
		JSON.stringify(sams && sams.code));
	check('but its label survives it, which is what a telemetry row is traced back to',
		!!sams && sams.label === 'Sam, Perth meetup' && !!sams.redeemed_by,
		JSON.stringify(sams));
	check('and the account it names is the one that redeemed it',
		!!sams && sams.redeemed_by === first.j.account_id,
		(sams && sams.redeemed_by) + ' vs ' + (first.j && first.j.account_id));
	check('the console counts what is still to be used',
		listed.j && listed.j.redeemed >= 2 && listed.j.minted >= 2,
		JSON.stringify({ minted: listed.j && listed.j.minted, unused: listed.j && listed.j.unused }));
	// The panel that hands out codes says whether the door they gate is shut.
	check('the console says registration is still open on a gateway nobody closed',
		listed.j && listed.j.closed === false, JSON.stringify(listed.j && listed.j.closed));

	// ── The attempt cap ─────────────────────────────────────────
	//
	// Proved from both sides in this run. A successful redemption clears the
	// address's failure count, so the sequence below starts from zero however
	// many refusals came before it.

	await sleep(PHASE_GAP);
	const resetMint = await mint('Cap, resetting the count', 1);
	const resetCode = resetMint.j && resetMint.j.passcode && resetMint.j.passcode.code;
	const reset = await redeem(device(), resetCode);
	check('a success clears the failures counted before it', reset.status === 200,
		'status ' + reset.status);

	await setKnob('/api/passcode/redeem', 'redeem_max_fails', 3);
	const capped = [];
	for (let i = 0; i < 4; i++) {
		capped.push(await redeem(device(), 'zzzz-zzzz-zzz' + i));
		await sleep(600);	// under the rate ceiling, so only the ATTEMPT cap can refuse.
	}
	check('three wrong codes are admitted and answered honestly',
		capped.slice(0, 3).every(r => r.status === 404),
		capped.map(r => r.status).join(','));
	check('the fourth is refused by the cap',
		capped[3].status === 429 && !!capped[3].j && capped[3].j.reason === 'throttled',
		'status ' + capped[3].status + ' · ' + JSON.stringify(capped[3].j));

	// THE RED PROOF, in this run and against this gateway: with the cap turned
	// off the very same request is answered rather than refused. Without this a
	// green "the fourth is refused" could have come from anything at all
	// refusing — a bad body, a dead route, a signature the gateway disliked.
	await setKnob('/api/passcode/redeem', 'redeem_max_fails', 0);
	await sleep(600);
	const uncapped = await redeem(device(), 'zzzz-zzzz-zzz9');
	check('with the cap set to zero the same attempt is answered, not refused',
		uncapped.status === 404, 'status ' + uncapped.status + ' · ' + JSON.stringify(uncapped.j));

	// ── The rate limit, which is the other half of the cap ──────
	//
	// Last, because a throttled address stays throttled for a couple of minutes
	// and everything above would then measure the throttle instead of itself.

	await sleep(PHASE_GAP);
	const flood = await Promise.all(Array.from({ length: 16 },
		() => redeem(device(), 'yyyy-yyyy-yyyy')));
	check('a flood is throttled even with the attempt cap turned off',
		flood.some(r => r.status === 429),
		'statuses ' + flood.map(r => r.status).join(','));

	if (bad.length) LOG.report();
	cleanup();
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(async (e) => {
	console.log('  FAIL the run threw — ' + (e && e.stack || e));
	LOG.report();
	cleanup();
	process.exit(1);
});
