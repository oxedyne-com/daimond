// verify_redeem.mjs — the beta passcode, from the browser, against a real
// gateway with the beta really shut.
//
// WHAT THIS DEFENDS. The gateway has had `/api/passcode/redeem` and the
// registration gate in front of `/api/account` for some time, and until now
// nothing in the browser called either. A stranger was refused and told nothing
// -- `bootstrap()` wrapped the whole registration in a try/catch and turned a
// deliberate 403 into `offline`, so a refused person landed in BYOK-only mode
// believing the app was broken -- and a person HOLDING a code had nowhere to
// type it. Four properties come out of that, and each one is a way for this to
// go quietly wrong again:
//
//   1. A REFUSAL IS NOT SILENCE. The gate answers with a machine-readable
//      `reason`; the browser must read it and say which refusal it was. A
//      client that reports a 403 as "the account service is unreachable" points
//      the user at their own network for a decision the server took on purpose.
//   2. THERE IS A DOOR, AND IT IS REACHABLE FROM THE REFUSAL. Not a screen
//      somewhere that a refused person would have to go looking for.
//   3. AND IT IS STILL THERE LATER. The code usually arrives after the refusal,
//      not with it, so the way in has to survive the dialog being dismissed.
//   4. A REFUSED CODE SAYS WHICH REFUSAL IT WAS. The gateway distinguishes a
//      code it never issued from one already spent from one that has run out,
//      because those send a person to three different places. A client that
//      collapses them into one friendly sentence throws that away, and the
//      throwing-away is invisible -- everything still "works".
//
// And the decisive one, which is the author's own case end to end: a fresh
// device, a closed gateway, a valid code, and the app ends up SIGNED IN WITH
// PRO -- the same state an ordinary registration reaches, not a second one.
//
// ── The gateway is real, and closed the way production is ───────────
//
// The critical section that spends a code IS the thing being relied on, so a
// stubbed `/api/passcode/redeem` would prove nothing about it. This starts its
// own gateway on :9412 with an empty store of its own, and closes the beta by
// setting `beta_only` in the COPIED `app.jdat`'s route configuration -- which is
// how jarrah is closed as of today, and a different path through
// `settings::try_bool` from the console override the gateway's own tests drive.
// Both paths deserve to be exercised and only one of them was.
//
// It does NOT touch :9002. Nothing here may go near the shipped gateway.
//
// ── How each check is shown red ─────────────────────────────────────
//
// `--break <name>` serves a deliberately damaged copy of a source file to the
// real page, through `page.route`, so the browser loads it as it loads any other
// script. A break whose anchor does not appear exactly once aborts the run: a
// check proved against code that was never broken is not proved at all.
//
//   node dev/verify_redeem.mjs --break blind      # the `reason` is not read: the
//                                                 # refusal reads as offline and
//                                                 # nothing is drawn (1, 2, 3)
//   node dev/verify_redeem.mjs --break offline    # the reason IS read and still
//                                                 # reported as offline (1)
//   node dev/verify_redeem.mjs --break onewording # every refused code gets one
//                                                 # sentence (4)
//   node dev/verify_redeem.mjs --break nosignin   # the code is spent and the app
//                                                 # never signs in (the decisive one)
//   node dev/verify_redeem.mjs --break drawalways # a passcode field is offered to
//                                                 # a device that already has an
//                                                 # account (the "no control that
//                                                 # would refuse" checks)
//   node dev/verify_redeem.mjs --break nohook     # the Credits drawer's entry is
//                                                 # gone (3)
//   node dev/verify_redeem.mjs                    # and then, clean
//
// ── Running it ──────────────────────────────────────────────────────
//
//	cd gateway && env -u CARGO_TARGET_DIR cargo build --release
//	node dev/verify_redeem.mjs
//
// It owns world 9 (the app on :8786) and :9412, and starts both itself: the dev
// server has to be pointed at THIS gateway rather than at :9002, which
// `dev/world.sh` does not do. Headless, with DISPLAY dropped by the harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, procLog, GWDIR, GWBIN } from './gwbin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WWW  = path.join(ROOT, 'www');

// ── The world, fixed before anything reads it ───────────────────────
//
// harness.mjs reads these at import time, so they are set here and the harness
// is imported below with `await import`. World 9, deliberately: 3, 5, 7, 11 and
// 13 are other lanes'.
//
// DELIBERATELY NOT `DAIMOND_PORT`. This file starts a dev server of its own,
// pointed at its own gateway, and `dev/run_all.sh` is run inside a world that
// has already exported `DAIMOND_PORT` for the server everything else shares.
// Reading that would make this verifier try to seize the suite's own port,
// find it held, and refuse -- so the two knobs it honours are its own, and
// the world it is run in cannot reach in and move them.
const APP_PORT = Number(process.env.DAIMOND_REDEEM_PORT || 8786);
const GW_PORT  = Number(process.env.DAIMOND_REDEEM_GW_PORT || 9412);
const SCRATCH  = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond/w9');
process.env.DAIMOND_PORT    = String(APP_PORT);
process.env.DAIMOND_APP     = `http://localhost:${APP_PORT}`;
process.env.DAIMOND_GW_PORT = String(GW_PORT);
process.env.DAIMOND_SCRATCH = SCRATCH;

const GW   = `http://127.0.0.1:${GW_PORT}`;
const APP  = process.env.DAIMOND_APP;
const WORK = path.join(SCRATCH, 'verify_redeem-gw');
const LOG  = procLog('verify_redeem');
const SRV  = procLog('verify_redeem', 'server');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	if (i > 0) return String(process.argv[i + 1] || '');
	const eq = process.argv.find(a => a.startsWith('--break='));
	return eq ? eq.slice(8) : '';
})();

const ok = [], bad = [];
/// Record a check. `detail` is the evidence and is printed either way; `why` is
/// what went wrong and is printed only when it did.
const check = (name, pass, detail, why) => {
	(pass ? ok : bad).push(name);
	const tail = pass ? (detail ? ' — ' + detail : '')
		: ' — ' + [why, detail].filter(Boolean).join(' · ');
	console.log((pass ? '  ok   ' : '  FAIL ') + name + tail);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────
//
// Real edits to real files, served in place of them. Several edits may name the
// same file; they are applied together, so a break needing two lines is still
// one damaged copy rather than two routes fighting over one URL.

const BREAKS = {
	// The `reason` field is never read, which is exactly the state the client
	// shipped in: every refusal reduces to "offline" and the app says nothing
	// anybody can act on.
	blind: [{
		file: 'js/gateway.js',
		find: "\t\t\treason: (j && j.reason) || '',",
		with: "\t\t\treason: '',",
	}],
	// The reason IS read, and the refusal is still reported as a gateway that
	// could not be reached. Only the half of check 1 that is about `offline`
	// should fall; the dialog still appears, so this isolates it.
	offline: [{
		file: 'js/gateway.js',
		find: '\t\t\t\t\tstate.offline = false;\n\t\t\t\t\tstate.refused = reg.reason;',
		with: '\t\t\t\t\tstate.offline = true;\n\t\t\t\t\tstate.refused = reg.reason;',
	}],
	// One friendly sentence for every refused code. The redemption still fails
	// correctly and the user is still told no; what is lost is WHICH no, which
	// is the whole reason the gateway tells them apart.
	onewording: [{
		file: 'js/gateway.js',
		find: "\t\t\tcase 'spent':     return t('beta.err_spent');",
		with: "\t\t\tcase 'spent':     return t('beta.err_unknown');",
	}],
	// The code is spent and the app never takes the account it just bought. The
	// redemption returns 200, the dialog says "you are in", and the app is not.
	nosignin: [{
		file: 'js/gateway.js',
		find: '\t\tvar authed = await bootstrap();',
		with: '\t\tvar authed = false;',
	}],
	// A passcode field wherever the block is drawn, account or no account.
	drawalways: [{
		file: 'js/passcode.js',
		find: '\t\tif (s.authed) return;',
		with: '\t\tif (s.authed && false) return;',
	}],
	// The Credits drawer's entry, and only that. The hook daimond.js calls is
	// removed AND the standing redraws are, so nothing but the drawer could
	// fill the block -- and nothing does. The dialog is untouched, so the
	// refusal checks stay green and check 3 falls alone.
	// It CASCADES, and that is worth saying rather than leaving to be
	// discovered: with the drawer's entry gone the dialog cannot be reopened
	// from it, so the code-typing checks that drive through it have nothing to
	// type into and fall behind it. What the break isolates is which check falls
	// FIRST -- the drawer entry -- and that the refusal itself is untouched:
	// checks 1 and 2 stay green, so the dialog is demonstrably still working
	// when the drawer stops carrying it.
	nohook: [
		{
			file: 'js/passcode.js',
			find: '\twindow.DaimondCredits = { render: render };',
			with: '\twindow.DaimondCredits = null;',
		},
		{
			file: 'js/passcode.js',
			find: "\t\twindow.addEventListener('daimond:authed',  refresh);",
			with: "\t\tvoid 0;",
		},
		{
			file: 'js/passcode.js',
			find: '\t\trefresh();\n\t}\n\n\t// ── Public surface',
			with: '\t}\n\n\t// ── Public surface',
		},
		{
			file: 'js/passcode.js',
			find: '\t\trefresh();\n\t\tif (!reason || !canSign()) return;',
			with: '\t\tif (!reason || !canSign()) return;',
		},
		{
			file: 'js/passcode.js',
			find: '\t\t\tsetTimeout(refresh, 0);',
			with: '\t\t\tvoid 0;',
		},
	],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Every file a break touches, each with all of its edits applied, or a hard
/// stop. An anchor that does not appear exactly once means nothing was broken
/// and the run below would prove the opposite of what it claims.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of BREAKS[BREAK]) {
		if (!byFile.has(spec.file)) byFile.set(spec.file, fs.readFileSync(path.join(WWW, spec.file), 'utf8'));
		const src = byFile.get(spec.file);
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': an anchor appears ${n} times in ${spec.file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

// ── A gateway of its own, closed the way production is ───────────────

/// Build the working directory, and hand back its path.
///
/// `closed` writes `beta_only` into the `/api/account` route's configuration --
/// the same place jarrah's `app.jdat` now carries it. The gateway's own tests
/// close the beta through a console override in the store; this exercises the
/// other half of `settings::try_bool`, which is the half production runs on.
function buildWorkDir(closed) {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, 'keys'), { recursive: true });
	// Every key EXCEPT the database's: the store is new, so its at-rest key must
	// be new too. The licence key matters here -- a gifted Pro has to be signed
	// with the same key a bought one is, or the client would be believing
	// something this run invented.
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(WORK, 'keys', k));
	}
	writeConfig(closed);
	return WORK;
}

/// Write `app.jdat` into the working directory with the port moved and the beta
/// open or shut. Called twice: the owner account has to be minted while the door
/// is open, because a closed gateway refuses it too.
function writeConfig(closed) {
	let cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${GW_PORT})`);
	if (!cfg.includes(`(u16|${GW_PORT})`)) {
		console.log('  FAIL could not set the listen port in the copied app.jdat — '
			+ 'has its shape changed?');
		process.exit(1);
	}
	// Asserted on the KEY being there, not on the text changing. The open pass
	// writes the value the shipped file already carries, so "nothing moved" is
	// the correct outcome there and treating it as a failure stopped the first
	// run of this file before it had started.
	const key = /"beta_only":\s*"(true|false)"/g;
	const found = (cfg.match(key) || []).length;
	if (found !== 1) {
		console.log(`  FAIL the /api/account route in app.jdat carries beta_only ${found} times, `
			+ 'so this run could not close the beta. The gate is the whole subject of this file '
			+ 'and a run that could not set it would measure nothing.');
		process.exit(1);
	}
	const want = `"beta_only": "${closed ? 'true' : 'false'}"`;
	const next = cfg.replace(/"beta_only":\s*"(true|false)"/, want);
	if (!next.includes(want)) {
		console.log('  FAIL could not set beta_only in the copied app.jdat.');
		process.exit(1);
	}
	fs.writeFileSync(path.join(WORK, 'app.jdat'), next);
}

// ── Device identities, exactly as the app builds them ───────────────

/// A fresh device keypair, and the two things the gateway asks of it. Used for
/// the owner account and the gatecrasher; the DEVICE UNDER TEST is the browser's
/// own, minted by identity.js.
function device() {
	const kp = crypto.generateKeyPairSync('ed25519');
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

/// One HTTP call to the gateway, carrying a cookie jar this file owns.
async function call(jar, method, url, body, xff) {
	const headers = { 'x-daimond-api': '1' };
	if (jar && jar.cookie) headers.cookie = jar.cookie;
	if (body !== undefined) headers['content-type'] = 'application/json';
	// Talking to the gateway directly there is no Steel in front to append one,
	// so every unnamed request shares the single "unknown" bucket -- which is
	// the bucket the BROWSER is in, through the dev server's proxy. Anything
	// here that could be refused names an address of its own, so it cannot spend
	// the browser's attempts.
	if (xff) headers['x-forwarded-for'] = xff;
	const r = await fetch(GW + url, {
		method, headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
	if (jar && set.length) jar.cookie = set.map(c => c.split(';')[0]).join('; ');
	let j = null;
	try { j = await r.json(); } catch (e) {}
	return { status: r.status, j };
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

const procs = [];
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }

async function waitFor(fn, ms = 20000, gap = 250) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

/// Start the gateway in the working directory, and wait for it to serve.
///
/// Generous, because an empty o3db spends twenty-odd seconds initialising its
/// zones before anything listens.
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
/// signalled: a second gateway started on the strength of a `kill` returning
/// meets `AddrInUse` and dies, and the run that follows measures nothing.
async function stopGateway(gw) {
	try { gw.kill('SIGKILL'); } catch (e) {}
	await waitFor(async () => {
		try { await fetch(`${GW}/api/health`); return false; }
		catch (e) { return true; }
	}, 30000, 200);
	await sleep(500);
}

/// The dev server, pointed at THIS gateway rather than at :9002.
async function startServer() {
	const srv = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
		cwd: ROOT,
		env: { ...process.env, DAIMOND_PORT: String(APP_PORT), DAIMOND_GW_PORT: String(GW_PORT) },
		stdio: SRV.stdio,
	});
	procs.push(srv);
	return await waitFor(async () => (await fetch(APP + '/index.html')).ok, 20000);
}

(async () => {
	requireFreshGateway();

	for (const [what, url] of [['gateway', `${GW}/api/health`], ['app server', APP + '/index.html']]) {
		let stray = false;
		try { stray = (await fetch(url)).ok; } catch (e) {}
		if (stray) {
			console.log(`  FAIL something is already answering as the ${what} on ${url}. This `
				+ 'suite starts both itself, pins an owner and closes the beta in configuration, '
				+ 'so it cannot share either. Free the port, or set DAIMOND_REDEEM_PORT / '
				+ 'DAIMOND_REDEEM_GW_PORT.');
			process.exit(1);
		}
	}

	// ── The gateway: open, then shut ────────────────────────────
	//
	// The owner has to exist before the process that pins them, and before the
	// door closes -- a closed gateway refuses the owner's own registration just
	// as it refuses everyone else's. So: open, mint the owner, close, restart.
	const cwd = buildWorkDir(false);
	let started = await startGateway(cwd, null);
	check('gateway starts', started.up);
	if (!started.up) { LOG.report(); cleanup(); process.exit(1); }

	const bossDev = device();
	const boss = { dev: bossDev, jar: {} };
	const made = await call(boss.jar, 'POST', '/api/account', binding(bossDev));
	boss.id = made.j && made.j.account_id;
	check('an account to be the owner, made while the beta is still open', !!boss.id, boss.id);
	if (!boss.id) { LOG.report(); cleanup(); process.exit(1); }

	await stopGateway(started.gw);
	writeConfig(true);
	started = await startGateway(cwd, boss.id);
	check('gateway restarts with the beta CLOSED in app.jdat and that account as owner',
		started.up);
	if (!started.up) { LOG.report(); cleanup(); process.exit(1); }
	await session(boss.jar, bossDev);
	const who = await call(boss.jar, 'GET', '/api/admin?view=whoami');
	check('the console recognises the owner', who.j && who.j.role === 'owner',
		JSON.stringify(who.j));

	// The gate bites before a browser is anywhere near it. Asserted here as well
	// as through the app, because a client-side check that passed against a
	// gateway which was never shut would be the worst kind of green.
	const outsider = await call(null, 'POST', '/api/account', binding(device()), '198.51.100.201');
	check('THE GATE BITES: a fresh device with a real signature is refused an account',
		outsider.status === 403 && !!outsider.j && outsider.j.reason === 'beta_only',
		'status ' + outsider.status + ' · ' + JSON.stringify(outsider.j && outsider.j.reason),
		'the beta is configured closed and a stranger was still registered');

	/// Mint a passcode from the console, as the operator does.
	///
	/// `pro` is the tier the panel's own pulldown sends. Since 2026-08-17 a code
	/// grants the FREE tier unless somebody asks for Pro, so the author's code
	/// below asks for it deliberately: the decisive check further down is about
	/// the GATE and the sign-in, and a free code would have turned it red for a
	/// reason that has nothing to do with either. The free tier gets a device and
	/// a phase of its own at the end.
	async function mint(label, pro) {
		const r = await call(boss.jar, 'POST', '/api/admin?view=passcodes',
			{ label, wave: 1, pro: pro === true });
		return (r.j && r.j.passcode && r.j.passcode.code) || '';
	}

	const spentCode = await mint('Spent before the browser saw it');
	const goodCode  = await mint('The author, on a fresh device', true);
	const freeCode  = await mint('A free tester, on a fresh device');
	check('three passcodes minted from the console',
		!!spentCode && !!goodCode && !!freeCode,
		spentCode + ' / ' + goodCode + ' / ' + freeCode);
	if (!spentCode || !goodCode || !freeCode) { LOG.report(); cleanup(); process.exit(1); }

	// One of them is spent by somebody else, from an address of its own, so the
	// browser meets a code that is genuinely gone rather than one this file
	// merely calls spent.
	const crasher = device();
	const took = await call(null, 'POST', '/api/passcode/redeem',
		Object.assign({ code: spentCode }, binding(crasher)), '198.51.100.202');
	check('one of them is spent by another device first', took.status === 200,
		'status ' + took.status);

	// ── The app ─────────────────────────────────────────────────

	const up = await startServer();
	check('the dev server is up and proxying to this gateway', up, APP);
	if (!up) { SRV.report(); cleanup(); process.exit(1); }

	const { open, shot, signInAs, errors } = await import('./harness.mjs');
	const PROFILE = path.join(SCRATCH, 'pw', 'redeem' + (BREAK ? '-' + BREAK : ''));
	fs.rmSync(PROFILE, { recursive: true, force: true });

	const damaged = BREAK ? damagedFiles() : new Map();
	const s = await open({
		name:     'redeem',
		profile:  PROFILE,
		signIn:   false,		// the gate itself is the subject; sign in below, watching
		connect:  false,
		defaults: false,
		route:    async (page) => {
			for (const [file, body] of damaged) {
				await page.route('**/' + file, r => r.fulfill({
					status: 200, contentType: 'application/javascript', body,
				}));
			}
		},
	});
	const { page } = s;

	/// The gateway's answer to the registration round, as the browser saw it.
	const registrations = [];
	page.on('response', async (r) => {
		if (!/\/api\/account(\?|$)/.test(r.url()) || r.request().method() !== 'POST') return;
		let j = null;
		try { j = await r.json(); } catch (e) {}
		registrations.push({ status: r.status(), reason: (j && j.reason) || '' });
	});

	/// What the gateway module holds about this device.
	const gwState = () => page.evaluate(() => {
		try { return window.DaimondGateway.state(); } catch (e) { return {}; }
	});
	/// The text of an element, or '' when it is not there.
	const textOf = (sel) => page.evaluate((q) => {
		const n = document.querySelector(q);
		return n ? (n.textContent || '').trim() : '';
	}, sel);
	/// A catalogue sentence, so a check can compare what is on screen against
	/// what the app is supposed to be saying rather than against a copy of it
	/// pasted in here -- which would go stale silently.
	const says = (key) => page.evaluate(k => window.DaimondI18n.t(k), key);

	try {
		// ── Nothing is offered where nothing could work ──────
		//
		// Before there is an identity there is no key to sign a redemption with,
		// so a passcode field would be a control that refuses the moment it is
		// used. Asked before sign-in, which is the only moment this state exists.
		const beforeAny = await page.evaluate(() => {
			try { window.DaimondPasscode.render(); } catch (e) { return 'threw: ' + e.message; }
			const h = document.getElementById('credits-beta');
			return h ? h.innerHTML.trim() : 'missing';
		});
		check('no passcode field before there is a key to sign one with',
			beforeAny === '', JSON.stringify(beforeAny),
			'a control was drawn that could only have refused');

		// ── The refusal ─────────────────────────────────────
		await signInAs(s, 'redeem');
		await page.waitForTimeout(3000);		// the bootstrap, and the dialog behind it

		const reg = registrations[registrations.length - 1] || {};
		check('the app\'s own registration round is refused by the closed beta',
			reg.status === 403 && reg.reason === 'beta_only',
			'status ' + reg.status + ' · reason ' + JSON.stringify(reg.reason));

		let st = await gwState();
		check('1. the app knows it was REFUSED, and says which refusal',
			st.refused === 'beta_only', 'refused ' + JSON.stringify(st.refused),
			'the reason came back on the wire and nothing in the client read it');
		check('1. and does not report it as being offline',
			st.offline === false && st.authed === false,
			'offline ' + st.offline + ' · authed ' + st.authed,
			'a deliberate refusal was reported as a gateway that could not be reached, '
			+ 'which sends the user to look at their own network');

		// The rail's account row. It must not be claiming the service is
		// unreachable, because it is not: it answered.
		const unreachable = await says('astat.service_unreachable');
		const accountRow  = await textOf('#astat-account');
		check('1. and the status row does not claim the service is unreachable',
			!!accountRow && accountRow.indexOf(unreachable) < 0,
			JSON.stringify(accountRow), 'the row is telling the user the wrong thing');

		// ── 2. The refusal carries the way in ───────────────
		const dialog = await page.$('.beta-scrim');
		check('2. the refusal puts itself on screen', !!dialog, null,
			'the user was dropped into browser-only mode and told nothing at all');
		const dialogText = await textOf('.beta-box');
		// Asserted by MEANING: the sentence the gateway itself insists on -- that
		// only the account is closed and the app works without one -- has to
		// survive into what the user reads, in whatever words the catalogue uses.
		const honesty = await says('beta.lead_beta_only');
		check('2. and says only the ACCOUNT is closed, not the app',
			dialogText.indexOf(honesty) >= 0 && honesty.indexOf('no account at all') >= 0,
			null, 'the refusal reads as the app being shut');
		const hasField = await page.$('#beta-code-input');
		const hasGo    = await page.evaluate(() => {
			const b = [].slice.call(document.querySelectorAll('.beta-box .beta-btn'));
			return b.some(x => x.textContent.trim() === window.DaimondI18n.t('beta.redeem'));
		});
		check('2. and carries the code field and the button, from the refusal itself',
			!!hasField && hasGo, 'field ' + !!hasField + ' · button ' + hasGo);
		await shot(s, 'redeem-refusal');

		// ── 3. And it is still findable afterwards ──────────
		//
		// Dismissed, the way somebody without a code in hand dismisses it. The
		// code arrives days later, and the way in has to be somewhere they would
		// look: the Credits drawer, which is where this app answers "what account
		// have I got". Reached through the SAME call the status row makes.
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		check('3. the dialog can be dismissed', !(await page.$('.beta-scrim')));
		// The two calls the status row makes, in its order: the rail, then the
		// Credits view. Driven through the app's own entry points so this is the
		// path a user takes and not a private one.
		await page.evaluate(() => {
			try { window.DaimondPanels.show('rail'); } catch (e) { /* narrow window */ }
			window.DaimondAdmin.credits('');
		});
		await page.waitForTimeout(500);
		const drawerBtn = await page.$('#beta-open');
		check('3. the Credits drawer carries the way in afterwards', !!drawerBtn, null,
			'somebody who gets a code after being refused has nowhere to type it');
		await shot(s, 'redeem-drawer');
		// A direct DOM click, as the harness does elsewhere: the drawer animates,
		// and Playwright's stability check waits for a second frame that a card
		// mid-transition has not produced yet.
		await page.evaluate(() => {
			const b = document.getElementById('beta-open');
			if (b) b.click();
		});
		await page.waitForTimeout(500);
		check('3. and it opens the same screen', !!(await page.$('#beta-code-input')));

		/// Type a code into the open dialog and press Redeem. Returns the error
		/// line, or '' when it was accepted.
		///
		/// WAITS FOR AN OUTCOME rather than for a fixed interval. A redemption
		/// that is accepted goes on to a whole registration round -- register,
		/// challenge, verify, balance, licence -- and a fixed sleep short of that
		/// would read an empty error line as a success while the request was
		/// still in the air, which is the same green whatever happens next.
		async function tryCode(code) {
			// The value is set on the element and the button clicked in the DOM,
			// for the reason the harness gives about forced clicks: a card that
			// is animating has not produced the second frame Playwright's
			// stability check waits for. Nothing in this dialog listens for an
			// `input` event -- the submit reads `input.value` -- so a plain
			// assignment is the same thing a person's typing leaves behind.
			await page.evaluate((c) => {
				const i = document.getElementById('beta-code-input');
				if (i) i.value = c;
				const b = [].slice.call(document.querySelectorAll('.beta-box .beta-btn'));
				const go = b.filter(x => !x.classList.contains('ghost')).pop();
				if (go) go.click();
			}, code);
			const settled = await waitFor(async () => await page.evaluate(() => {
				const box = document.querySelector('.beta-box');
				if (!box) return true;					// dismissed under us
				const err = box.querySelector('.beta-err');
				if (err && err.textContent.trim()) return true;		// refused, and said so
				return !err;						// the confirmation replaced the form
			}), 30000, 200);
			if (!settled) return '(the dialog never answered)';
			return await textOf('.beta-err');
		}

		// ── 4. Which refusal it was ─────────────────────────
		const mistyped = await tryCode('zzzz-zzzz-zzz7');
		const wantMis  = await says('beta.err_unknown');
		check('4. a mistyped code is told it was not one we issued',
			!!mistyped && mistyped === wantMis, JSON.stringify(mistyped),
			'a typo was reported as something else, or as nothing');

		await sleep(800);					// under the rate ceiling
		const spent     = await tryCode(spentCode);
		const wantSpent = await says('beta.err_spent');
		check('4. a spent code is told it was already used',
			!!spent && spent === wantSpent, JSON.stringify(spent));
		check('4. and the two are DIFFERENT sentences, so a tester can tell which happened',
			!!mistyped && !!spent && mistyped !== spent, null,
			'both refusals said the same thing, which hides the one fact the person needs');

		// ── The decisive one ────────────────────────────────
		//
		// A fresh device, a closed gateway, a valid code -- and the app ends up
		// signed in with Pro. The same key the gate refused a minute ago, so the
		// 403 above cannot have been anything but the gate.
		await sleep(800);
		const accepted = await tryCode(goodCode);
		check('a valid code is accepted', accepted === '', JSON.stringify(accepted));
		await page.waitForTimeout(2500);
		const doneTitle = await says('beta.done_title');
		const boxText   = await textOf('.beta-box');
		check('and the screen says so', boxText.indexOf(doneTitle) >= 0, JSON.stringify(boxText.slice(0, 80)));
		await shot(s, 'redeem-done');

		st = await gwState();
		check('THE APP IS SIGNED IN', st.authed === true,
			'authed ' + st.authed + ' · offline ' + st.offline,
			'the code was spent and the app never took the account it bought');
		check('with Pro on it', st.pro === true, 'pro ' + JSON.stringify(st.pro),
			'the beta grant is a five-year Pro licence and the client is not seeing it');
		check('and the refusal is forgotten', !st.refused && st.offline === false,
			'refused ' + JSON.stringify(st.refused) + ' · offline ' + st.offline);

		// The oracle: the CONSOLE says which account spent the code, and the
		// browser says which account it holds a session on. Neither is derived
		// from the other.
		const mine = await page.evaluate(() => fetch('/api/account', {
			credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
		}).then(r => r.json()).catch(() => ({})));
		const listed = await call(boss.jar, 'GET', '/api/admin?view=passcodes');
		const row = ((listed.j && listed.j.passcodes) || [])
			.find(p => p.label === 'The author, on a fresh device');
		check('the account the browser holds is the one the console says redeemed the code',
			!!row && !!mine.account_id && row.redeemed_by === mine.account_id,
			(row && row.redeemed_by) + ' vs ' + mine.account_id);
		check('and the console no longer shows a spent code', !!row && row.code === '',
			JSON.stringify(row && row.code));

		// ── Nothing that would refuse ───────────────────────
		await page.evaluate(() => {
			const c = document.querySelector('.beta-scrim');
			if (c) c.remove();
			window.DaimondAdmin.credits('');
		});
		await page.waitForTimeout(600);
		// THE SUBJECT IS THE OFFER, NOT THE CONTAINER. This read `textOf('#credits-beta')
		// === ''` until 2026-08-15 and went red the day the telemetry consent card
		// started drawing in that host -- which is not an offer of a passcode, and is
		// where withdrawal deliberately lives (`passcode.js:475-483`). It was also
		// vacuous in the other direction: `textOf` answers '' for a node that is
		// MISSING exactly as for one that is empty, so a host that vanished would have
		// passed it. So: assert the host EXISTS, then assert that neither thing which
		// offers a code is inside it.
		const after = await page.evaluate(() => {
			const h = document.getElementById('credits-beta');
			if (!h) return { host: false };
			return {
				host:  true,
				open:  !!h.querySelector('#beta-open'),
				field: !!h.querySelector('#beta-code-input'),
				text:  (h.textContent || '').trim().slice(0, 120),
			};
		});
		check('the Credits beta block is still on the page to be judged',
			after.host === true, JSON.stringify(after),
			'the host went missing, which the old emptiness test would have called a pass');
		check('nothing offers a passcode to a device that now has an account',
			after.host === true && !after.open && !after.field, JSON.stringify(after),
			'a way to enter a code was left on screen for a device with nothing left to redeem');

		// Uncaught exceptions only. Console errors are not the signal here: a
		// closed gateway refuses several routes on purpose and the modules that
		// meet those refusals say so on the console, which is correct behaviour
		// and would make this line red for the very state the file is testing.
		const errs = errors(s).filter(e => /^pageerror:/.test(e));
		check('nothing on the page threw', errs.length === 0, errs.slice(0, 3).join(' | '));
	} finally {
		await s.close().catch(() => {});
	}

	// ── The free tier, on a device of its own ───────────────────
	//
	// The most-read screen in the beta, and until 2026-08-17 nobody had ever seen
	// it: every code gifted Pro, so `beta.done_plain` was drawn in the source and
	// unreachable in fact. A free code now reaches it, which makes what it SAYS a
	// property worth holding -- so this redeems one and reads the screen.
	//
	// A second browser, after the first has closed, because the redemption is
	// bound to a device key and the device above has spent its code. Sequential
	// rather than side by side: two Chromiums at once on this box is memory
	// nobody needs to spend on a phase this short.
	const FREEPROF = path.join(SCRATCH, 'pw', 'redeemfree' + (BREAK ? '-' + BREAK : ''));
	fs.rmSync(FREEPROF, { recursive: true, force: true });
	const f = await open({
		name:     'redeemfree',
		profile:  FREEPROF,
		signIn:   false,
		connect:  false,
		defaults: false,
	});
	try {
		const fpage = f.page;
		const fsays = (key) => fpage.evaluate(k => window.DaimondI18n.t(k), key);
		const ftext = (sel) => fpage.evaluate((q) => {
			const n = document.querySelector(q);
			return n ? (n.textContent || '').trim() : '';
		}, sel);
		await signInAs(f, 'redeemfree');
		await fpage.waitForTimeout(3000);		// the bootstrap, and the refusal behind it
		const gate = await fpage.$('.beta-scrim');
		check('the free device meets the same closed door', !!gate);

		await fpage.evaluate((c) => {
			const i = document.getElementById('beta-code-input');
			if (i) i.value = c;
			const b = [].slice.call(document.querySelectorAll('.beta-box .beta-btn'));
			const go = b.filter(x => !x.classList.contains('ghost')).pop();
			if (go) go.click();
		}, freeCode);
		const settled = await waitFor(async () => await fpage.evaluate(() => {
			const box = document.querySelector('.beta-box');
			if (!box) return true;
			const err = box.querySelector('.beta-err');
			if (err && err.textContent.trim()) return true;
			return !err;
		}), 30000, 200);
		check('a free code is accepted', settled && (await ftext('.beta-err')) === '',
			JSON.stringify(await ftext('.beta-err')));
		await fpage.waitForTimeout(2500);

		const fst = await fpage.evaluate(() => {
			try { return window.DaimondGateway.state(); } catch (e) { return {}; }
		});
		check('THE FREE APP IS SIGNED IN TOO', fst.authed === true,
			'authed ' + fst.authed + ' · offline ' + fst.offline,
			'a free code spent itself and the app never took the account it made');
		check('and holds no Pro, which is what free means',
			fst.pro === false, 'pro ' + JSON.stringify(fst.pro),
			'a free code granted the licence anyway, so the free tier has no testers again');

		// The SENTENCE, asserted by meaning: the screen must be the plain one and
		// must not be the Pro one. Both halves, because a panel that drew neither
		// would pass the first on its own -- and `done_plain` said almost nothing
		// until today, which is the defect this half exists to keep fixed.
		const box   = await ftext('.beta-box');
		const plain = await fsays('beta.done_plain');
		const proly = await fsays('beta.done_pro');
		check('the confirmation is the free sentence, not the Pro one',
			box.indexOf(plain) >= 0 && box.indexOf(proly) < 0,
			JSON.stringify(box.slice(0, 160)));
		// And that the sentence is worth reading. A free tester has to be told
		// which tier they are on and what the other one adds, so the sentence must
		// NAME Pro -- the one word every locale keeps untranslated, which is why
		// this holds in all eight rather than only in English. Asserted on the
		// catalogue and not on the screen for the same reason.
		check('and it names the tier the reader has not got, rather than stopping at "you have an account"',
			plain.indexOf('Pro') >= 0, JSON.stringify(plain.slice(0, 120)),
			'the free confirmation says only that an account exists, which is the '
			+ 'screen nobody had ever seen and tells a tester nothing about what they hold');
		await shot(f, 'redeem-done-free');

		const ferrs = errors(f).filter(e => /^pageerror:/.test(e));
		check('nothing on the free page threw', ferrs.length === 0, ferrs.slice(0, 3).join(' | '));
	} finally {
		await f.close().catch(() => {});
	}

	if (bad.length) { LOG.report(); SRV.report(); }
	cleanup();
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(async (e) => {
	console.log('  FAIL the run threw — ' + (e && e.stack || e));
	LOG.report();
	SRV.report();
	cleanup();
	process.exit(1);
});
