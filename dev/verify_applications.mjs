// verify_applications.mjs — the Applications panel, against a real gateway.
//
// `/api/admin?view=applications` has been served since the beta form was
// written, GET and POST, and until now NOTHING CALLED IT. The deployed gateway
// runs `beta_only` with the form open, so that form is the only route into the
// product, and every application it took landed in a store no console could
// read — accumulating towards `apply_max_total`, after which applicants are
// refused without being told why. So the properties worth proving are not
// "there is a tab" but these:
//
//   * an application filed at the public endpoint REACHES the list;
//   * a legal decision changes the status THE GATEWAY REPORTS, and the panel
//     shows what the gateway holds rather than what was clicked;
//   * the one decision the gateway refuses -- inviting somebody whose code has
//     been redeemed -- is NOT OFFERED, and the refusal is real: the same post
//     is made over the wire and answered 409;
//   * an operator who is not the owner is offered no control, and the same
//     post from their session is answered 403;
//   * an empty queue SAYS SO, including whether the form is still taking any;
//   * inviting somebody MINTS a code AND SENDS IT to the address on their
//     application — measured at the mail server the gateway submitted to, not at
//     a field the gateway set about itself;
//   * a send that FAILED is visible as a failure rather than as silence, with
//     the mail server's own words and a way to try again;
//   * a resend sends the SAME code and mints no second one;
//   * declining, and putting a row back to pending, send nothing at all.
//
// Every one of those is measured against the gateway this repository builds:
// applications are filed through `/api/beta/apply`, decisions are read back
// through `view=applications`, and the passcode a decision mints is REDEEMED
// through `/api/passcode/redeem` — so "the code is real" is proved by using it
// rather than by its shape. Nothing here is stubbed.
//
// It also covers the `choice` knob repair made alongside the panel: the console
// never read the `options` every knob carries, so a `Kind::Choice` knob drawn
// by `knobEditor` got a number field. The only choice knob today is promoted to
// the Providers card, so it is reached here through the console's own
// `__provBreak=twice`, which is what puts it back in the Settings card.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	eval "$(bash dev/world.sh 12 --env)"   # only to number its own two ports
//	node dev/verify_applications.mjs
//	node dev/verify_applications.mjs --break drop        # the list ignores what it fetched
//	node dev/verify_applications.mjs --break empty       # an empty queue draws nothing
//	node dev/verify_applications.mjs --break illegal     # Invite offered on a redeemed row
//	node dev/verify_applications.mjs --break owner       # controls drawn for a non-owner
//	node dev/verify_applications.mjs --break stale       # the panel is not re-read after a decision
//	node dev/verify_applications.mjs --break keepcode    # a spent code goes on being shown
//	node dev/verify_applications.mjs --break field       # a field the gateway never sent is read
//	node dev/verify_applications.mjs --break choice      # the choice knob falls back to a number
//	node dev/verify_applications.mjs --break ceiling     # a full queue is not reported
//	node dev/verify_applications.mjs --break nomail      # the gateway is started with no
//	                                                       invitation mailbox, so inviting
//	                                                       mints and sends nothing
//	node dev/verify_applications.mjs --break mute        # the row says nothing about the send
//	node dev/verify_applications.mjs --break sentok      # a failed send is drawn as a success
//	node dev/verify_applications.mjs --break noresend    # no way to try a failed send again
//	node dev/verify_applications.mjs --break resendmints # a resend mints a second live code
//	node dev/verify_applications.mjs --break declinesends # declining sends the applicant a code
//	node dev/verify_applications.mjs --break nocode      # the message goes out without the code
//	node dev/verify_applications.mjs --break bland       # the message never says it is single-use
//	node dev/verify_applications.mjs --stale-ok          # measure a binary older than some
//	                                                       source anyway; the staleness is
//	                                                       still counted as a failure
//
// Each --break is a defect the checks below are supposed to catch. If a break
// runs green, the check for it is worthless and should be rewritten.
//
// ── Sending, and what the seam here does NOT prove ──────────────────
//
// Inviting somebody now emails them their code (gateway/src/handlers/invite.rs).
// A verifier must not put real mail on the wire, so this run stands up an SMTP
// server of its own on loopback and points the gateway at it: the gateway opens
// a genuine submission conversation, authenticates, and posts a genuine RFC 5322
// document, and every assertion below about the message reads the bytes that
// server received. Nothing about the send is stubbed inside the gateway — there
// is no test hook in that path and this file adds none.
//
// WHAT THAT DOES NOT PROVE, and it is worth being blunt about it:
//
//   * The fixture speaks in the clear. A deployed gateway speaks STARTTLS to
//     Steel and refuses to send the mailbox password to a server that will not
//     upgrade, and that refusal is exercised here only as a unit test of the
//     configuration reader, never against a real server.
//   * The fixture accepts any AUTH PLAIN. It therefore says nothing about
//     whether the configured credential is one Steel will accept.
//   * Nothing here is DELIVERED. Steel signs DKIM, queues and delivers; this
//     server accepts and forgets. Whether an invitation reaches an inbox rather
//     than a spam folder is not measured by anything in this file.
//
// So a green run here means "the gateway composes the right message and hands it
// to the mail server it was pointed at". The first invitation sent through a
// real deployment still has to be watched arriving.
//
// It starts a gateway AND a dev server of its own, in a working directory of
// its own, with an EMPTY store — the empty-queue check counts on that, and
// counting rows in a store somebody else has been writing to would measure
// their afternoon. Both ports are numbered off the world, so several lanes can
// run this at once; neither is :9002, which is a single binding six lanes
// compete for and which this run could not share in any case.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { staleSources, procLog, GWDIR, GWBIN } from './gwbin.mjs';
import { signInFresh } from './session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// A gateway AND a dev server of their own, both numbered off the world.
//
// The console needs a server that proxies `/api` to a gateway, and the world's
// own dev server proxies to :9002 -- which is a single exclusive binding that
// six lanes are competing for. This run pins an owner in configuration and
// counts rows in an empty store, so it cannot share a gateway with anybody; and
// waiting for :9002 to be free means running only when nobody else is working,
// which is how somebody ends up killing another lane's half-finished run. So it
// numbers both ports off the world it was given and starts both itself.
const WORLD    = Math.max(0, Number(process.env.DAIMOND_PORT || 8777) - 8777);
const PORT     = Number(process.env.DAIMOND_GW_PORT || (9400 + WORLD));
const APP_PORT = Number(process.env.DAIMOND_APP_PORT || (8500 + WORLD));
// The loopback SMTP server this run points the gateway at. Numbered off the
// world like the other two, and deliberately NOT 587 or 465 — a gateway will
// only dial an odd port with `invite_dev_insecure` set, and this run proves that
// switch is doing something by needing it.
const MAIL_PORT = Number(process.env.DAIMOND_MAIL_PORT || (9600 + WORLD));
const GW       = `http://127.0.0.1:${PORT}`;
const APP      = `http://localhost:${APP_PORT}`;
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK    = path.join(SCRATCH, 'verify_applications-gw');
const GW_LOG  = procLog('verify_applications');
const SRV_LOG = procLog('verify_applications', 'serve');

// The binary under test. `DAIMOND_GW_BIN` exists because the release build is
// left behind whenever anybody builds with CARGO_TARGET_DIR pointed at their
// own slot -- see gwbin.mjs -- and a lane that may not run cargo still has to
// be able to name the build it is measuring. Whichever is used, it is REFUSED
// if it is older than the sources, for the reason that file gives: a gate that
// measures the wrong artefact passes things it never examined.
const BIN = process.env.DAIMOND_GW_BIN || GWBIN;

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

/// Whether a stale binary may be measured anyway. See where it is used: it does
/// not silence the check, it only lets the rest of the run happen.
const STALE_OK = process.argv.includes('--stale-ok');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	const eq = process.argv.find(a => a.startsWith('--break='));
	if (eq) return eq.slice(8);
	return i >= 0 ? (process.argv[i + 1] || '') : null;
})();

const ok = [], bad = [];
/// Record a check. `detail` is the evidence and is printed either way, so a
/// passing line still says what it saw.
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const procs = [];
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }
function saidWhat() { GW_LOG.report(); SRV_LOG.report(); }
async function waitFor(fn, ms = 20000, gap = 250) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}
/// Stop and report, so a failure never leaves a gateway holding :9002.
function die(msg) {
	console.log('  FAIL ' + msg);
	saidWhat();
	cleanup();
	console.log('');
	console.log(`passed ${ok.length}, failed ${bad.length + 1}`);
	process.exit(1);
}

// ── A mail server of its own ────────────────────────────────────────
//
// The capture seam, and the header note above says what it does and does not
// prove. It speaks enough SMTP for a submission conversation — banner, EHLO with
// an AUTH advertisement, AUTH PLAIN, MAIL/RCPT/DATA, QUIT — and records what it
// was given. The gateway's side of that conversation is the real one: the real
// SMTP client, the real composer, real bytes on a real socket.
//
// It refuses any recipient in `refuse`, with a 5xx, which is how the FAILED path
// below is exercised. A mail server saying no to one address is the ordinary
// case a beta will meet — a typo'd domain, a mailbox that has gone — and a code
// minted for somebody nobody could write to is exactly the silence the send
// record exists to end.

/// The address inside an SMTP `MAIL FROM:<…>` or `RCPT TO:<…>`.
function addrOf(line) {
	const m = line.match(/<([^>]*)>/);
	return m ? m[1].trim().toLowerCase() : '';
}

/// What the fixture records of one message, after the breaks have had their way
/// with it.
///
/// `--break nocode` blanks the passcode out of the body and `--break bland`
/// strips the sentence saying it is single-use. Both are breaks of the CAPTURE
/// rather than of the gateway, and they prove exactly one thing: that the two
/// body checks below read the message rather than infer it from the envelope.
/// What holds the composer itself is the unit tests in `invite.rs`.
function recorded(body) {
	let b = body;
	if (BREAK === 'nocode') b = b.replace(/\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/g, 'REDACTED');
	if (BREAK === 'bland') {
		b = b.replace(/works once/g, 'exists')
			.replace(/one account on one device/g, 'an account');
	}
	return b;
}

function startMailFixture() {
	const box = { messages: [], auth: [], refuse: new Set(), server: null };
	box.server = net.createServer(sock => {
		let buf = '', inData = false, data = [], from = '', rcpt = [];
		const say = s => { try { sock.write(s + '\r\n'); } catch (e) {} };
		say('220 fixture.invalid ESMTP verify_applications');
		sock.on('data', chunk => {
			buf += chunk.toString('utf8');
			for (;;) {
				const i = buf.indexOf('\r\n');
				if (i < 0) break;
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (inData) {
					if (line === '.') {
						inData = false;
						box.messages.push({
							from,
							rcpt: rcpt.slice(),
							body: recorded(data.join('\r\n')),
							at:   Date.now(),
						});
						data = [];
						say('250 2.0.0 Ok: queued as FIXTURE' + box.messages.length);
					} else {
						// Undo the dot-stuffing the client applied on the way out.
						data.push(line.startsWith('..') ? line.slice(1) : line);
					}
					continue;
				}
				const up = line.toUpperCase();
				if (up.startsWith('EHLO') || up.startsWith('HELO')) {
					// Multi-line, with the last line separated by a space: the
					// client reads AUTH off the extension list and will not send a
					// password to a server that advertises no mechanism.
					say('250-fixture.invalid');
					say('250 AUTH PLAIN LOGIN');
				} else if (up.startsWith('AUTH ')) {
					box.auth.push(line.split(/\s+/)[1] || '');
					say('235 2.7.0 Authentication successful');
				} else if (up.startsWith('MAIL FROM')) {
					from = addrOf(line); rcpt = [];
					say('250 2.1.0 Ok');
				} else if (up.startsWith('RCPT TO')) {
					const a = addrOf(line);
					if (box.refuse.has(a)) {
						say('550 5.1.1 <' + a + '>: no mailbox by that name here');
					} else {
						rcpt.push(a);
						say('250 2.1.5 Ok');
					}
				} else if (up === 'DATA') {
					inData = true; data = [];
					say('354 End data with <CR><LF>.<CR><LF>');
				} else if (up === 'QUIT') {
					say('221 2.0.0 Bye');
					sock.end();
				} else if (up === 'RSET' || up.startsWith('NOOP')) {
					say('250 2.0.0 Ok');
				} else {
					say('502 5.5.2 Command not implemented');
				}
			}
		});
		// A client that hangs up mid-conversation — which is what the SMTP
		// client does after a refused recipient — is not an error here.
		sock.on('error', () => {});
	});
	box.server.on('error', () => {});
	return box;
}

/// The credential the fixture is given. Generated per run rather than written
/// down: it proves nothing to have a constant here, and a constant that looks
/// like a password in a repository is a thing somebody eventually reuses.
const MAIL_PW = 'fixture-' + crypto.randomBytes(9).toString('hex');
/// The mailbox the gateway is configured to send invitations from.
const MAIL_FROM = 'beta@daimond.test';
/// Where the message tells an applicant to put their code.
const MAIL_URL  = 'https://daimond.test/';

/// The invitation configuration handed to the gateway's environment.
///
/// Empty under `--break nomail`, which is a deployment nobody finished setting
/// up: it mints, it marks the row invited, and it writes to nobody.
function mailEnv() {
	if (BREAK === 'nomail') return {};
	return {
		DAIMOND_INVITE_FROM:     MAIL_FROM,
		DAIMOND_INVITE_HOST:     '127.0.0.1',
		DAIMOND_INVITE_PORT:     String(MAIL_PORT),
		DAIMOND_INVITE_SECURITY: 'plain',
		DAIMOND_INVITE_USER:     MAIL_FROM,
		DAIMOND_INVITE_PASSWORD: MAIL_PW,
		DAIMOND_INVITE_SIGNOFF:  'Jason',
		DAIMOND_INVITE_APP_URL:  MAIL_URL,
	};
}

// ── A gateway of its own, on an empty store ─────────────────────────
//
// The deployed `app.jdat` with the port set and nothing else changed, the
// signing keys symlinked in (a code minted here has to be the same artefact a
// real one is), and no store at all: the first check below counts an EMPTY
// queue, which is only meaningful in a store nobody else has written to.
function buildWorkDir() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, 'keys'), { recursive: true });
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(WORK, 'keys', k));
	}
	let cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${PORT})`);
	if (!cfg.includes(`(u16|${PORT})`)) {
		die('could not set the listen port in the copied app.jdat — has its shape changed?');
	}
	// TWO changes and no more, both about getting to the panel rather than about
	// the panel. `beta_only` shuts /api/account, and the two accounts this run
	// needs -- an owner and one lesser role -- are ordinary accounts; there is
	// no passcode to let them in with until an owner exists to mint one. The
	// door they come through is `verify_passcode`'s subject, not this file's.
	const shut = cfg;
	cfg = cfg.replace(/"beta_only":\s*"true"/, '"beta_only": "false"');
	if (cfg === shut) {
		die('could not open registration in the copied app.jdat — has "beta_only" moved? '
			+ 'Without it no account can be made and nothing below could be reached.');
	}
	// A THIRD change, and it is the one that lets a loopback mail server be
	// reached at all. `invite_dev_insecure` relaxes exactly three things — a host
	// that is not public, a port that is not 587 or 465, and a conversation with
	// no TLS — and it is ABSENT from the shipped config, so a deployed gateway
	// refuses all three. It is a route setting rather than an environment
	// variable precisely so a stray shell variable cannot turn it on, which is
	// why this run has to write it into its own copy of the file. Everything else
	// about the mailbox arrives through `mailEnv`.
	const shipped = cfg;
	cfg = cfg.replace(/("handler":\s*"admin",\s*"config":\s*\{)/,
		'$1\n            "invite_dev_insecure": "true",');
	if (cfg === shipped) {
		die('could not set "invite_dev_insecure" on the admin route in the copied '
			+ 'app.jdat — has the route\'s shape changed? Without it the gateway '
			+ 'refuses to dial the loopback mail server, and every send check below '
			+ 'would be measuring a configuration failure rather than the send path.');
	}
	fs.writeFileSync(path.join(WORK, 'app.jdat'), cfg);
	return WORK;
}

let gw = null;
async function startGateway(ownerAccount) {
	gw = spawn(BIN, [], {
		cwd: WORK,
		env: {
			...process.env,
			APP_MODE: 'sandbox',
			// The invitation mailbox, pointed at this run's own SMTP server.
			// Empty under `--break nomail`, which is a gateway nobody finished
			// configuring — it still mints, and it writes to nobody.
			...mailEnv(),
			...(ownerAccount ? { DAIMOND_OWNER_ACCOUNTS: ownerAccount } : {}),
		},
		stdio: GW_LOG.stdio,
	});
	procs.push(gw);
	// Generous: an empty o3db spends twenty-odd seconds building its zones
	// before anything listens, and a wait sized for a warm store reports "the
	// gateway did not start" about one that was starting perfectly well.
	return await waitFor(async () => (await fetch(`${GW}/api/health`)).ok, 120000);
}
async function stopGateway() {
	if (!gw) return;
	try { gw.kill('SIGKILL'); } catch (e) {}
	await waitFor(async () => {
		try { await fetch(`${GW}/api/health`); return false; } catch (e) { return true; }
	}, 30000, 200);
	await sleep(500);
	gw = null;
}

// ── Talking to the gateway directly ─────────────────────────────────
//
// Node keeps no cookie jar, so sessions are moved by hand. That is a feature
// here: it makes it impossible to use one account's session for another's
// request, which is exactly the mistake a role check must not make.
async function call(jar, method, url, body, xff) {
	const headers = { 'x-daimond-api': '1' };
	if (jar && jar.cookie) headers.cookie = jar.cookie;
	if (body !== undefined) headers['content-type'] = 'application/json';
	// There is no Steel in front of a development gateway, so every request
	// otherwise shares one "unknown" bucket and a handful at once reads as a
	// flood. Naming a source puts each applicant in a bucket of its own, which
	// is what the per-source cap counts.
	if (xff) headers['x-forwarded-for'] = xff;
	const r = await fetch(GW + url, {
		method, headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let j = null;
	try { j = await r.json(); } catch (e) {}
	return { status: r.status, j };
}

/// A fresh device keypair and the two things the gateway asks of it.
function device() {
	const kp = crypto.generateKeyPairSync('ed25519');
	const raw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
	const b64url = b => b.toString('base64')
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return {
		pub: b64url(raw),
		alg: 'Ed25519',
		sign: s => crypto.sign(null, Buffer.from(s, 'utf8'), kp.privateKey).toString('base64'),
	};
}
function binding(dev) {
	const ts = Math.floor(Date.now() / 1000);
	return { pubkey: dev.pub, alg: dev.alg, ts,
		sig: dev.sign(`daimond-gw-account:v1:${dev.pub}:${ts}`) };
}

/// One application, filed exactly as the public form files one.
let applicant = 0;
async function apply(email, name, note, intent) {
	applicant++;
	const body = { email, name, note };
	if (intent) body.intent = intent;
	// A source per applicant: the endpoint admits five submissions an hour from
	// one, and a run refused by its own rate limiter would look exactly like the
	// endpoint being broken.
	return await call(null, 'POST', '/api/beta/apply', body, `203.0.113.${applicant}`);
}

// ── The page ────────────────────────────────────────────────────────

/// What the Applications panel is showing, read out of the DOM.
///
/// Read from the rendered page rather than from the console's own state: the
/// question every check below asks is what an operator can see and press, and
/// an internal array agreeing with the gateway proves nothing about that.
async function panel(page) {
	return await page.evaluate(() => {
		const host = document.getElementById('admin-ap-list');
		const rows = Array.from(host ? host.querySelectorAll('.admin-rel-row') : []);
		return {
			tab:    !!(document.getElementById('tab-applications')
				&& !document.getElementById('tab-applications').hidden),
			hint:   (document.getElementById('admin-ap-hint') || {}).textContent || '',
			gate:   (document.getElementById('admin-ap-gate') || {}).textContent || '',
			status: (document.getElementById('admin-ap-status') || {}).textContent || '',
			// The standing warning that this gateway cannot send at all. Read
			// only when it is SHOWN: the element is in the page either way, and
			// its text is what a hidden one is still carrying.
			mail:   (() => {
				const b = document.getElementById('admin-ap-mail');
				return b && !b.hidden ? b.textContent : '';
			})(),
			note:   (() => {
				const n = document.getElementById('admin-ap-note');
				return n && !n.hidden ? n.textContent : '';
			})(),
			empty:  Array.from(host ? host.querySelectorAll('.admin-rel-empty') : [])
				.map(e => e.textContent).join(' '),
			html:   host ? host.textContent : '',
			read:   Array.from(window.__apRead || []),
			rows: rows.map(r => ({
				id:     r.dataset.appId,
				status: r.dataset.status,
				text:   r.textContent,
				moves:  Array.from(r.querySelectorAll('[data-move]')).map(b => b.dataset.move),
				code:   Array.from(r.querySelectorAll('.admin-ap-code .admin-op-id'))
					.map(e => e.textContent),
				// What the row says became of the message carrying that code,
				// and whether it offers to try again. `data-resend` and not
				// `data-move` because a resend moves nothing: the row is
				// already invited and stays invited.
				sent:   (r.querySelector('.admin-ap-sent') || {}).textContent || '',
				resend: !!r.querySelector('[data-resend]'),
			})),
		};
	});
}

/// The row for an address, or null.
const rowFor = (p, email) => p.rows.find(r => r.text.includes(email)) || null;

/// Press one decision on one row, and wait for the panel to settle.
async function pressMove(page, email, move) {
	const sel = await page.evaluate(a => {
		const rows = Array.from(document.querySelectorAll('#admin-ap-list .admin-rel-row'));
		const row = rows.find(r => r.textContent.includes(a.email));
		if (!row) return 'no row';
		const b = row.querySelector('[data-move="' + a.move + '"]');
		if (!b) return 'no control';
		b.click();
		return 'clicked';
	}, { email, move });
	await settled(page);
	return sel;
}

/// Press Resend on one row, and wait for the panel to settle.
///
/// Separate from `pressMove` because it is a separate control: the row is
/// already invited, so it is offered no Invite button, and `data-resend` is
/// deliberately not one of the three moves.
async function pressResend(page, email) {
	const sel = await page.evaluate(a => {
		const rows = Array.from(document.querySelectorAll('#admin-ap-list .admin-rel-row'));
		const row = rows.find(r => r.textContent.includes(a.email));
		if (!row) return 'no row';
		const b = row.querySelector('[data-resend]');
		if (!b) return 'no control';
		b.click();
		return 'clicked';
	}, { email });
	await settled(page);
	return sel;
}

/// Wait for the panel's status line to stop saying it is working.
///
/// A decision posts and then re-reads the whole queue, and a send adds an SMTP
/// conversation in the middle of that — all round trips to real servers, so this
/// waits for the line to settle rather than guessing a delay.
async function settled(page) {
	return await waitFor(async () => {
		const s = await page.evaluate(() =>
			(document.getElementById('admin-ap-status') || {}).textContent || '');
		return s !== '' && s !== 'Saving…' && s !== 'Sending…';
	}, 25000, 150);
}

/// Open the console in its own context, signing in a fresh account.
///
/// The account is made in the browser, so the session is the browser's own --
/// which is the only way the role checks below mean anything.
async function openConsole(browser) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
	const page = await ctx.newPage();
	// The recorder for "which fields did the console read". Every row the
	// gateway sends is wrapped in a Proxy that notes each property taken off it,
	// so a console reading a field nobody sent is caught by observation rather
	// than by grepping the source for a shape.
	await page.addInitScript(() => {
		window.__apRead = new Set();
		const orig = Response.prototype.json;
		Response.prototype.json = async function () {
			const j = await orig.call(this);
			if (j && Array.isArray(j.applications)) {
				j.applications = j.applications.map(row => new Proxy(row, {
					get(t, k) {
						if (typeof k === 'string') window.__apRead.add(k);
						return t[k];
					},
				}));
			}
			return j;
		};
	});
	if (BREAK) await page.addInitScript(m => { window.__appBreak = m; }, BREAK);
	const account = await signInFresh(page, APP);
	return { ctx, page, account };
}

/// Load the console and wait for the queue to have been drawn once.
async function enterConsole(page) {
	await page.goto(APP + '/console/#applications', { waitUntil: 'domcontentloaded' });
	const up = await page.waitForSelector('#admin-app:not([hidden])', { timeout: 20000 })
		.then(() => true).catch(() => false);
	if (!up) return false;
	// `refreshAll` fetches eleven views; the queue is loaded late in that
	// sequence, so waiting for the app to appear is not waiting for this panel.
	await waitFor(async () => await page.evaluate(() => {
		const h = document.getElementById('admin-ap-hint');
		const l = document.getElementById('admin-ap-list');
		return !!(l && (l.children.length || (h && h.textContent)));
	}), 25000, 200);
	await sleep(250);
	return true;
}

// ── The run ─────────────────────────────────────────────────────────

(async () => {
	const stale = staleSources(BIN);
	if (stale === null) die('the gateway binary is not there — ' + BIN);
	if (stale.length && !STALE_OK) {
		die('the gateway binary is older than ' + stale.length + ' of its sources, so this '
			+ 'would measure a build nobody is shipping: ' + stale.slice(0, 4).join(', ')
			+ '. Rebuild it, name a current one in DAIMOND_GW_BIN, or -- if you have read '
			+ 'that list and none of it is what this file measures -- pass --stale-ok, '
			+ 'which runs everything and still records this as a failure.');
	}
	// Recorded either way, and RECORDED AS A FAILURE when it is stale. A run
	// against a build nobody is shipping must not be able to print an all-green
	// summary, whatever the runner believed about which sources mattered.
	check('the gateway binary is current with every source it is built from',
		stale.length === 0,
		stale.length ? stale.length + ' newer: ' + stale.slice(0, 4).join(', ') : BIN);
	console.log('  measuring ' + BIN);

	let stray = false;
	try { stray = (await fetch(`${GW}/api/health`)).ok; } catch (e) {}
	if (stray) {
		die(`something is already answering on :${PORT}. This run pins an owner in `
			+ 'configuration and counts an empty store, so it cannot share a gateway; '
			+ 'set DAIMOND_GW_PORT to a free port, or run it in a world of its own.');
	}
	try { stray = (await fetch(`${APP}/console/`)).ok; } catch (e) { stray = false; }
	if (stray) {
		die(`something is already serving on :${APP_PORT}, and it will be proxying to a `
			+ 'gateway that is not this one. Set DAIMOND_APP_PORT to a free port.');
	}
	buildWorkDir();

	// The mail server this run points the gateway at, up BEFORE the gateway, so
	// there is never a window in which an invitation could be composed and find
	// nothing listening.
	const mail = startMailFixture();
	// riley@example.org is the address this run makes the mail server refuse.
	// Every deployment meets one: a typo'd domain, a mailbox that has gone. It
	// is what produces the FAILED row below, and a code minted for somebody
	// nobody could write to is precisely the silence the send record ends.
	mail.refuse.add('riley@example.org');
	const mailUp = await new Promise(r => {
		mail.server.listen(MAIL_PORT, '127.0.0.1', () => r(true));
		mail.server.on('error', () => r(false));
	});
	procs.push({ kill: () => { try { mail.server.close(); } catch (e) {} } });
	check('a mail server for the gateway to submit invitations to',
		mailUp, `127.0.0.1:${MAIL_PORT}`);
	if (!mailUp) die(`nothing could listen on :${MAIL_PORT} — set DAIMOND_MAIL_PORT`);
	/// How many messages the mail server has taken. The oracle for every "did
	/// this send" and every "did this send NOTHING" below.
	const posted = () => mail.messages.length;

	// The dev server that serves the console, pointed at THIS gateway. Started
	// rather than borrowed: a world's server proxies to :9002, and the whole
	// reason this run is on a port of its own is that :9002 belongs to whoever
	// got there first.
	procs.push(spawn('node', ['dev/serve.mjs'], {
		cwd: ROOT,
		env: { ...process.env, DAIMOND_PORT: String(APP_PORT), DAIMOND_GW_PORT: String(PORT) },
		stdio: SRV_LOG.stdio,
	}));
	check('the dev server serves the console',
		await waitFor(async () => (await fetch(`${APP}/console/`)).ok, 15000), APP);

	if (!await startGateway(null)) { check('the gateway starts', false); die('no gateway'); }
	check('the gateway starts', true, BIN);

	const { chromium } = await import(pathToFileURL(PW).href);
	// DISPLAY is dropped: this session's is an X display forwarded over SSH, a
	// headless Chrome still consults it, and when nothing answers no frame is
	// ever produced -- so every rAF-based wait expires over a page that was
	// ready half a minute earlier. dev/harness.mjs drops it for the same reason.
	const env = { ...process.env };
	delete env.DISPLAY;
	const browser = await chromium.launch({
		executablePath: CHROME, headless: true, args: ['--no-sandbox'], env });

	try {
		// The owner has to exist before the gateway that pins them, so an account
		// is made against this process and the next one is told about it.
		const boss = await openConsole(browser);
		check('an account to be the owner', !!boss.account, boss.account);
		const hand = await openConsole(browser);		// the second console role
		check('a second account, to hold a lesser role', !!hand.account, hand.account);

		await stopGateway();
		check('the gateway restarts with that account pinned as owner',
			await startGateway(boss.account));

		// The owner's session, borrowed from the browser so the oracles below can
		// post AS THE OWNER without going through the page. The same cookie, so
		// a check made here and a control drawn there cannot be about two
		// different accounts.
		const jar = { cookie: (await boss.ctx.cookies(APP))
			.map(c => `${c.name}=${c.value}`).join('; ') };
		const who = await call(jar, 'GET', '/api/admin?view=whoami');
		check('the gateway calls that account the owner',
			!!who.j && who.j.role === 'owner', JSON.stringify(who.j));
		if (!who.j || who.j.role !== 'owner') die('the owner session did not survive the restart');

		/// The queue as the GATEWAY reports it. The oracle for everything the
		/// panel claims: a console agreeing with itself proves nothing.
		const served = async () => (await call(jar, 'GET', '/api/admin?view=applications')).j;

		// ── An empty queue ──────────────────────────────────────
		{
			const s = await served();
			check('the gateway starts this run with an empty queue',
				!!s && s.total === 0, JSON.stringify(s && s.total));

			const up = await enterConsole(boss.page);
			check('the console loads for the owner', up);
			const p = await panel(boss.page);
			check('an owner is given the Applications tab', p.tab);
			check('an empty queue says it is empty rather than drawing nothing',
				/no applications yet/i.test(p.empty), JSON.stringify(p.empty.slice(0, 90)));
			// Which is the difference between "nobody has written in" and "nobody
			// can": the form's own state, from the same reply.
			check('the empty queue says whether the form is still taking applications',
				/taking them|form is shut/i.test(p.empty), JSON.stringify(p.empty.slice(0, 120)));
			check('and the panel says so in its own right, from the gateway\'s knob',
				/form is open/i.test(p.gate) === (s.open === true),
				`open=${s && s.open} · ${JSON.stringify(p.gate.slice(0, 60))}`);
		}

		// ── Applications filed at the public endpoint ───────────
		const SAM  = 'sam@example.com';
		const RILEY = 'riley@example.org';
		const JO   = 'jo@example.net';
		{
			const a = await apply(SAM, 'Sam Rivers',
				'I run a small legal practice and want client notes off a cloud.', 'test');
			check('the public form takes an application',
				a.status === 200 && !!a.j && a.j.ok === true,
				'status ' + a.status + ' · ' + JSON.stringify(a.j));
			// A second apart, because `created_ts` is in SECONDS and the sort is
			// on it: three applications filed inside one second are three equal
			// keys, and "newest first" would then be whatever order the store
			// happened to scan them in — which is not a property the list can be
			// held to. See the note in the report about that tie.
			await sleep(1100);
			await apply(RILEY, 'Riley', 'Happy to test on an old iPad.', 'test');
			await sleep(1100);
			await apply(JO, '', 'Tell me when it ships.', 'waitlist');

			const s = await served();
			check('the gateway holds all three', !!s && s.total === 3, 'total ' + (s && s.total));

			await boss.page.click('#admin-refresh', { force: true });
			await sleep(1500);
			await waitFor(async () => (await panel(boss.page)).rows.length >= 3, 20000, 200);
			const p = await panel(boss.page);
			check('an application filed at the form reaches the list',
				!!rowFor(p, SAM), p.rows.length + ' rows drawn');
			check('all three reach it', p.rows.length === 3,
				p.rows.length + ' rows for ' + (s && s.total) + ' applications');

			// Newest first, which is the order the gateway sorted them into. An
			// operator working a queue reads the top of it, so the top has to be
			// the person who wrote in most recently -- asserted against the
			// timestamps rather than only against the reply's own order, which
			// would agree with any order at all.
			check('the list is drawn in the order the gateway sent',
				p.rows.map(r => r.id).join(',') === (s.applications || []).map(a2 => a2.id).join(','),
				p.rows.map(r => r.id.slice(0, 6)).join(','));
			const stamps = p.rows.map(r =>
				((s.applications || []).find(a2 => a2.id === r.id) || {}).created_ts);
			check('and that order is newest first',
				stamps.every((t, i) => i === 0 || (stamps[i - 1] >= t)) && stamps.length === 3,
				stamps.join(' ≥ '));
			check('the newest application is the one filed last',
				!!p.rows[0] && p.rows[0].text.includes(JO), p.rows[0] && p.rows[0].id.slice(0, 6));

			const sam = rowFor(p, SAM);
			check('a row carries the applicant\'s own words in full',
				!!sam && sam.text.includes('client notes off a cloud'),
				JSON.stringify((sam && sam.text.slice(0, 60)) || ''));
			check('a row carries the name they gave',
				!!sam && sam.text.includes('Sam Rivers'));
			check('a row carries the status the gateway reports',
				!!sam && sam.status === 'pending' && /pending/.test(sam.text), sam && sam.status);
			check('a row says when they wrote in',
				!!sam && /wrote in/.test(sam.text));
			// The two invitations the landing page makes are different queues of
			// work, so a row that could not tell them apart would be a list the
			// operator has to sort by hand.
			const jo = rowFor(p, JO);
			check('a waitlist application is told apart from a test one',
				!!jo && /waitlist/.test(jo.text) && !!sam && /test/.test(sam.text),
				JSON.stringify((jo && jo.text.slice(0, 50)) || ''));

			// The shape, checked by watching what the console took off each row.
			const keys = Object.keys((s.applications || [])[0] || {});
			const invented = p.read.filter(k => !keys.includes(k));
			check('the console reads only fields the gateway actually sends',
				invented.length === 0,
				invented.length ? 'read ' + invented.join(',') + ' — sent ' + keys.join(',')
					: 'read ' + p.read.join(','));
			check('and it reads the ones that carry the decision',
				['email', 'status', 'note', 'intent', 'id'].every(k => p.read.includes(k)),
				p.read.join(','));

			check('the panel counts what the gateway counted',
				/3 applications/.test(p.hint) && /3 still waiting/.test(p.hint),
				JSON.stringify(p.hint));
		}

		// ── A legal decision ────────────────────────────────────
		{
			const before = posted();
			const pressed = await pressMove(boss.page, JO, 'declined');
			check('a pending row offers Decline', pressed === 'clicked', pressed);
			// Only inviting sends. A decline is a decision and nothing else, and
			// a gateway that wrote to somebody it had just turned down would be
			// worse than one that wrote to nobody.
			// verifier: `--break declinesends` posts an INVITE when Decline is
			// pressed, which puts a passcode in a declined applicant's hands.
			check('declining an application sends NOTHING',
				posted() === before,
				`the mail server took ${posted() - before} message(s) on a decline`);
			const s = await served();
			const rec = (s.applications || []).find(a => a.email === JO);
			check('declining changes the status the GATEWAY reports',
				!!rec && rec.status === 'declined', rec && rec.status);
			check('and it records who decided it',
				!!rec && rec.decided_by === boss.account, rec && rec.decided_by);
			const p = await panel(boss.page);
			const row = rowFor(p, JO);
			check('the panel shows the status the gateway holds, not the one clicked',
				!!row && row.status === (rec && rec.status), row && row.status);
			check('a decided row no longer offers the status it holds',
				!!row && !row.moves.includes('declined'), row && row.moves.join(','));
			check('and still offers the ways back',
				!!row && row.moves.includes('pending'), row && row.moves.join(','));
		}

		// ── Inviting, which mints ───────────────────────────────
		let code = '';
		// What the mail server had taken before this invite, so the section
		// after it measures a DELTA. Anything that sent earlier — a break that
		// makes Decline send, say — would otherwise be counted as this invite's.
		let mailBefore = 0;
		{
			const before = await call(jar, 'GET', '/api/admin?view=passcodes');
			mailBefore = posted();
			const pressed = await pressMove(boss.page, SAM, 'invited');
			check('a pending row offers Invite', pressed === 'clicked', pressed);

			const s = await served();
			const rec = (s.applications || []).find(a => a.email === SAM);
			check('inviting changes the status the gateway reports',
				!!rec && rec.status === 'invited', rec && rec.status);
			check('inviting minted a passcode against the row',
				!!rec && typeof rec.code === 'string' && rec.code.length > 0,
				rec ? (rec.code ? 'a code is on the row' : 'none') : 'no row');

			const after = await call(jar, 'GET', '/api/admin?view=passcodes');
			const grew = ((after.j && after.j.passcodes) || []).length
				- ((before.j && before.j.passcodes) || []).length;
			check('the code is a real passcode in the cohort, not a decoration',
				grew === 1, 'the passcode list grew by ' + grew);
			// The label is the coherence the panel exists for: an operator should
			// never have to retype a name into another panel to act on what they
			// just read.
			const mine = ((after.j && after.j.passcodes) || [])
				.find(pc => (pc.label || '').includes(SAM));
			check('the code is labelled with the applicant it was minted for',
				!!mine, mine ? mine.label : 'no passcode carries the address');

			const p = await panel(boss.page);
			const row = rowFor(p, SAM);
			check('the row shows the code, so it can be copied and sent',
				!!row && row.code.length === 1 && row.code[0].length > 0,
				row ? row.code.length + ' codes drawn' : 'no row');
			check('the row says the code is shown until it is used',
				!!row && /shown until it is used/.test(row.text));
			// A credential must not be repeated into a second place on the page.
			check('the status line does not repeat the code',
				!!row && !p.status.includes(row.code[0]), JSON.stringify(p.status));
			code = (row && row.code[0]) || '';
		}

		// ── The invitation actually reaches the applicant ───────
		//
		// The property this whole panel turned out to be missing. Everything
		// above proves a code was minted and drawn; none of it proves anybody
		// received one. Until tonight nothing sent it at all — the console said
		// "copy it and send it", and whether that happened was outside the app.
		//
		// Measured at the mail server the gateway submitted to, so "a send was
		// attempted" is bytes on a socket rather than a field the gateway set
		// about itself.
		let firstMsg = null;
		{
			check('inviting SENT a message', posted() === mailBefore + 1,
				(posted() - mailBefore) + ' message(s) reached the mail server on that invite');
			firstMsg = mail.messages[mailBefore] || null;
			check('addressed to the address on the application',
				!!firstMsg && firstMsg.rcpt.length === 1 && firstMsg.rcpt[0] === SAM,
				firstMsg ? JSON.stringify(firstMsg.rcpt) : 'no message');
			check('from the mailbox the gateway is configured with, not the applicant\'s',
				!!firstMsg && firstMsg.from === MAIL_FROM,
				firstMsg ? firstMsg.from : 'no message');
			check('and the gateway proved itself to the mail server before sending',
				mail.auth.length >= 1 && mail.auth[0] === 'PLAIN',
				JSON.stringify(mail.auth));

			const body = (firstMsg && firstMsg.body) || '';
			// The code, and the code that is on THIS row: a message carrying
			// some other applicant's passcode would satisfy "a code was sent".
			// verifier: `--break nocode` blanks it out of what the mail server
			// records, which is a message that went out with nothing in it.
			check('the message carries the code that is on the row',
				!!code && body.includes(code),
				code ? (body.includes(code) ? 'the row\'s code is in the message'
					: 'the row\'s code is NOT in the message') : 'no code on the row');
			// verifier: `--break bland` strips the sentence, which is an
			// applicant who does not know the code stops working when used.
			check('and says it works once, on one device',
				/works once/.test(body) && /one account on one device/.test(body),
				JSON.stringify(body.slice(body.indexOf('It opens'), body.indexOf('It opens') + 90)));
			check('and says where to put it',
				body.includes(MAIL_URL), MAIL_URL);
			// It opens by acknowledging that they applied. They may have been
			// waiting days, and an unexplained string of characters is not an
			// answer to that.
			check('and it acknowledges the application before it gives the code',
				body.indexOf('You wrote in') > 0
					&& (!code || body.indexOf('You wrote in') < body.indexOf(code)),
				'acknowledgement at ' + body.indexOf('You wrote in')
					+ ', code at ' + body.indexOf(code));
			// Plain text and one part, which is what disposes of the tracking
			// pixel structurally: there is nowhere in a text message to put one.
			check('the message is plain text with no HTML part and no remote image',
				/Content-Type: text\/plain; charset=utf-8/.test(body)
					&& !/text\/html/i.test(body) && !/<img/i.test(body),
				JSON.stringify((body.match(/Content-Type:.*/) || [''])[0]));
			// Exactly one URL, printed in full: no link whose text hides where
			// it goes, because there is no link at all.
			check('and carries exactly one URL, the one it tells you to open',
				(body.match(/https?:\/\//g) || []).length === 1,
				(body.match(/https?:\/\/\S*/g) || []).join(' · '));
			// A message with no Date is not a valid RFC 5322 document and is
			// scored as spam by most of what would receive it.
			check('and it is a message a mail server will accept: Date, From, To, Message-ID',
				/\r\nDate: [A-Z][a-z]{2}, /.test('\r\n' + body)
					&& /(^|\r\n)From: /.test(body)
					&& /(^|\r\n)To: /.test(body)
					&& /(^|\r\n)Message-ID: </.test(body),
				JSON.stringify(body.split('\r\n\r\n')[0].slice(0, 120)));

			// And what the gateway says about it, which is what the operator
			// reads. Silence here is the failure: a row that says "invited" and
			// nothing else is one an operator marks off as done.
			const s = await served();
			const rec = (s.applications || []).find(a => a.email === SAM);
			check('the gateway records the send on the row',
				!!rec && rec.sent === 'sent' && rec.sent_to === SAM && rec.sent_ts > 0,
				rec ? `sent=${rec.sent} to=${rec.sent_to} n=${rec.sent_n}` : 'no row');
			const p = await panel(boss.page);
			const row = rowFor(p, SAM);
			// verifier: `--break mute` draws no send line at all, which is the
			// panel exactly as it was before it could send.
			check('and the panel says the invitation went, and when',
				!!row && /Sent to sam@example\.com/.test(row.sent) && /\d/.test(row.sent),
				JSON.stringify((row && row.sent) || ''));
			check('the status line says it was sent, not that you should send it',
				/sent them their code/.test(p.status), JSON.stringify(p.status));
			// Not vacuous: the standing warning is the thing an unconfigured
			// gateway shows, and this run's gateway is configured.
			// verifier: `--break nomail` starts it with no mailbox at all.
			check('and the panel does not warn that inviting sends nothing',
				p.mail === '' && s.mail_ready === true,
				`mail_ready=${s.mail_ready} · ${JSON.stringify(p.mail.slice(0, 70))}`);
		}

		// ── Resending, which must not mint ──────────────────────
		//
		// The other half of the failure story. A send that failed leaves a live
		// code nobody holds, so there has to be a way to try again — and that
		// way must send the SAME code. Two live codes for one applicant is one
		// credential unaccounted for, and the console has no way to say which of
		// them the person on the row is holding.
		{
			const before = posted();
			const codesBefore = ((await call(jar, 'GET', '/api/admin?view=passcodes')).j
				|| {}).passcodes || [];
			const pressed = await pressResend(boss.page, SAM);
			check('an invited row whose code is still live offers Resend',
				pressed === 'clicked', pressed);

			check('resending sends the message again',
				posted() === before + 1,
				`the mail server took ${posted() - before} further message(s)`);
			const again = mail.messages[mail.messages.length - 1];
			check('and it is the SAME code, not a fresh one',
				!!again && !!code && again.body.includes(code),
				again ? (again.body.includes(code) ? 'the same code'
					: 'a different code went out') : 'no message');
			check('and it went to the same applicant',
				!!again && again.rcpt[0] === SAM, again ? JSON.stringify(again.rcpt) : 'none');

			// The oracle for "mints nothing", measured in the cohort rather than
			// on the row: a second code minted under a different label would not
			// show up on this application at all.
			// verifier: `--break resendmints` mints one on the way past.
			const codesAfter = ((await call(jar, 'GET', '/api/admin?view=passcodes')).j
				|| {}).passcodes || [];
			check('and NO second passcode was minted',
				codesAfter.length === codesBefore.length,
				`the cohort went from ${codesBefore.length} to ${codesAfter.length}`);

			const s = await served();
			const rec = (s.applications || []).find(a => a.email === SAM);
			check('the row counts the attempts, so a chased applicant is visible',
				!!rec && rec.sent_n === 2, rec ? String(rec.sent_n) : 'no row');
			check('and the code on the row is unchanged',
				!!rec && rec.code === code, rec ? (rec.code === code ? 'unchanged' : 'changed')
					: 'no row');
		}

		// ── A send the mail server refuses ──────────────────────
		//
		// THE CASE THE WHOLE DESIGN IS FOR. The mint succeeds, the decision is
		// written, and the message does not go. What must not happen is a row
		// that looks dealt with: the applicant is still waiting, the code exists,
		// and nobody but the store knows.
		{
			const before = posted();
			const pressed = await pressMove(boss.page, RILEY, 'invited');
			check('a pending row can be invited even where the send will fail',
				pressed === 'clicked', pressed);
			check('the mail server refused it, so nothing was accepted',
				posted() === before, `${posted() - before} message(s) were taken`);
			// Read before anything else touches the page: this is what the
			// operator is looking at the moment the press comes back, and it is
			// the one place they will see it if they never scroll to the row.
			check('the status line says the code did NOT go out',
				/did NOT go out/.test((await panel(boss.page)).status),
				JSON.stringify((await panel(boss.page)).status.slice(0, 130)));

			const s = await served();
			const rec = (s.applications || []).find(a => a.email === RILEY);
			check('a refused send is recorded as a FAILURE, not as silence',
				!!rec && rec.sent === 'failed',
				rec ? `sent=${JSON.stringify(rec.sent)}` : 'no row');
			check('and the row carries the reason the mail server gave',
				!!rec && /550|no mailbox/.test(rec.sent_why || ''),
				rec ? JSON.stringify((rec.sent_why || '').slice(0, 90)) : 'no row');
			// The decision stands. Unwinding it would throw away a minted code
			// and leave the operator with nothing to resend.
			check('the decision still stands, so the code is not lost with the send',
				!!rec && rec.status === 'invited' && rec.code.length > 0,
				rec ? `${rec.status} · code ${rec.code ? 'present' : 'gone'}` : 'no row');

			await boss.page.click('#admin-refresh', { force: true });
			await sleep(1800);
			const p = await panel(boss.page);
			const row = rowFor(p, RILEY);
			// verifier: `--break mute` draws no send line at all, and
			// `--break sentok` draws this one as a success.
			check('the panel shows a failed send AS a failure',
				!!row && /SEND FAILED/.test(row.sent),
				JSON.stringify((row && row.sent.slice(0, 90)) || ''));
			check('and says nobody has the code',
				!!row && /Nobody has this code/.test(row.sent),
				JSON.stringify((row && row.sent.slice(-70)) || ''));
			check('and the code is still drawn, so it can be sent by hand',
				!!row && row.code.length === 1,
				row ? row.code.length + ' codes drawn' : 'no row');
			// verifier: `--break noresend` withholds it, which is a failed send
			// with no way to try it again.
			check('and Resend is offered on the failed row',
				!!row && row.resend === true, row ? String(row.resend) : 'no row');
			void p;
		}

		// ── The code works, and then stops being shown ──────────
		{
			const sam = device();
			const r = await call(null, 'POST', '/api/passcode/redeem',
				Object.assign({ code }, binding(sam)), '203.0.113.90');
			check('the code minted from this panel actually opens the door',
				r.status === 200 && !!r.j && r.j.ok === true,
				'status ' + r.status + ' · pro=' + (r.j && r.j.pro));

			const s = await served();
			const rec = (s.applications || []).find(a => a.email === SAM);
			check('the gateway stops sending a spent code',
				!!rec && rec.code === '' && rec.redeemed === true,
				rec ? `code=${JSON.stringify(rec.code)} redeemed=${rec.redeemed}` : 'no row');

			await boss.page.click('#admin-refresh', { force: true });
			await sleep(1800);
			const p = await panel(boss.page);
			const row = rowFor(p, SAM);
			// The count and never the code. This line goes into a log, and a
			// verifier that prints a credential to prove a console did not is
			// not much of an improvement on the console printing it.
			check('a spent code stops being shown, so it cannot be sent twice',
				!!row && row.code.length === 0,
				row ? row.code.length + ' codes still drawn on the row' : 'no row');
			check('and the row says why it is gone',
				!!row && /has been used/.test(row.text),
				JSON.stringify((row && row.text.slice(-80)) || ''));
		}

		// ── The one decision the gateway refuses ────────────────
		//
		// A redeemed applicant put back to pending. The row is pending, so
		// "already invited" is not what makes Invite wrong -- the gateway
		// refuses it because a second code would let somebody else in on their
		// name. Both halves are checked: that the control is absent, and that
		// the post it would have made is genuinely refused.
		{
			const s0 = await served();
			const rec0 = (s0.applications || []).find(a => a.email === SAM);
			const beforeBack = posted();
			const back = await call(jar, 'POST', '/api/admin?view=applications',
				{ id: rec0.id, status: 'pending' });
			check('a decided row can be put back to pending', back.status === 200,
				'status ' + back.status);
			// Undoing a decision is not a decision to write to somebody. Only
			// inviting sends, and this row is already redeemed besides.
			check('putting a row back to pending sends NOTHING',
				posted() === beforeBack,
				`the mail server took ${posted() - beforeBack} message(s) on an undo`);

			await boss.page.click('#admin-refresh', { force: true });
			await sleep(1800);
			const p = await panel(boss.page);
			const row = rowFor(p, SAM);
			check('the row is pending again, and redeemed', !!row && row.status === 'pending',
				row && row.status);
			check('a redeemed applicant is NOT offered Invite',
				!!row && !row.moves.includes('invited'), row && row.moves.join(','));
			// Not vacuous: the row still has controls, so the absence above is a
			// decision rather than a panel that drew nothing.
			check('while the rest of that row\'s decisions are still offered',
				!!row && row.moves.includes('declined'), row && row.moves.join(','));
			check('and the row says why the control is missing',
				!!row && /Already redeemed/.test(row.text),
				JSON.stringify((row && row.text.slice(-90)) || ''));

			// The oracle: the same post, made over the wire.
			const refused = await call(jar, 'POST', '/api/admin?view=applications',
				{ id: rec0.id, status: 'invited' });
			check('the gateway really refuses that invite, so the absence is right',
				refused.status === 409,
				'status ' + refused.status + ' · ' + ((refused.j && refused.j.error) || ''));

			// And the closed set: a spelling the gateway does not know is refused
			// outright, which is why the panel offers three and never four.
			const nonsense = await call(jar, 'POST', '/api/admin?view=applications',
				{ id: rec0.id, status: 'banished' });
			check('a status the gateway does not know is refused, not filed',
				nonsense.status === 400, 'status ' + nonsense.status);
			const offered = new Set(p.rows.flatMap(r => r.moves));
			check('every move the panel offers is one of the gateway\'s three statuses',
				[...offered].every(m => ['pending', 'invited', 'declined'].includes(m)),
				[...offered].join(','));
		}

		// ── The ceiling, which is how this queue shuts the door ──
		//
		// `apply_max_total` refuses a NEW applicant with "Daimond is not taking
		// applications just now" and writes no row. Nothing deletes an
		// application and the counter behind the ceiling never goes down, so a
		// queue that has reached it stays there until the knob moves -- and
		// every panel in the console would otherwise go on saying the form was
		// open. Both halves are checked: that the endpoint really refuses, and
		// that the console says so.
		{
			const k = await call(jar, 'POST', '/api/admin?view=settings',
				{ route: '/api/beta/apply', key: 'apply_max_total', value: '3' });
			check('the ceiling is a knob the owner can move', k.status === 200,
				'status ' + k.status);

			const over = await apply('fourth@example.com', 'Fourth', 'Let me in too.', 'test');
			check('at the ceiling the form REFUSES a new applicant',
				over.status === 503, 'status ' + over.status
					+ ' · ' + ((over.j && over.j.error) || ''));
			const s = await served();
			check('and writes nothing, so the refusal is invisible in the queue',
				!!s && s.total === 3, 'total ' + (s && s.total));

			await boss.page.click('#admin-refresh', { force: true });
			await sleep(2000);
			const said = await boss.page.evaluate(() => {
				const b = document.getElementById('admin-ap-full');
				return (b && !b.hidden) ? b.textContent : '';
			});
			check('the console says the form is refusing applicants',
				/REFUSING NEW APPLICANTS/.test(said), JSON.stringify(said.slice(0, 70)));
			check('and names the knob that is the only way out of it',
				/Applications held/.test(said) && /3/.test(said),
				JSON.stringify(said.slice(-90)));

			// Put it back, so the panel is photographed in its ordinary state
			// and the checks after this are not run against a shut form.
			await call(jar, 'POST', '/api/admin?view=settings',
				{ route: '/api/beta/apply', key: 'apply_max_total', value: '' });
			await boss.page.click('#admin-refresh', { force: true });
			await sleep(2000);
		}

		// A picture of the queue in the state the checks left it: one row
		// redeemed and uninvitable, one invited whose invitation the mail server
		// refused, and one declined. The failed row is the one worth looking at
		// — whether it reads as a thing to go and fix is not something a check
		// can settle. Checks
		// prove properties and say nothing about whether the panel is legible,
		// which is a thing only a person looking at it can settle.
		{
			const shot = path.join(HERE, 'shots', 'applications.png');
			try {
				await boss.page.screenshot({ path: shot, fullPage: true });
				console.log('  shot   ' + shot);
			} catch (e) { console.log('  shot   not taken: ' + e.message); }
			// And at a phone width, where a row of decisions, a strip of
			// filters and a sentence carrying an email address all have to fold
			// rather than push the page sideways. Asserted as well as
			// photographed: a picture nobody opens proves nothing.
			await boss.page.setViewportSize({ width: 430, height: 900 });
			await sleep(400);
			// Named, not merely counted: "the page is too wide" is not something
			// anybody can act on, and the element sticking out is.
			const wide = await boss.page.evaluate(() => {
				const win = window.innerWidth;
				const over = [];
				document.querySelectorAll('#view-applications *').forEach(e => {
					const r = e.getBoundingClientRect();
					if (r.width > 0 && r.right > win + 1) {
						over.push(e.tagName.toLowerCase() + '.' + (e.className || '')
							+ ' → ' + Math.round(r.right));
					}
				});
				return { doc: document.documentElement.scrollWidth, win, over: over.slice(0, 4) };
			});
			check('at 430px nothing in the queue reaches past the window',
				wide.over.length === 0, wide.over.join(' · ')
					|| `the widest of it ends inside ${wide.win}px (document ${wide.doc})`);
			try {
				await boss.page.screenshot({
					path: path.join(HERE, 'shots', 'applications-narrow.png'), fullPage: true });
			} catch (e) {}
			await boss.page.setViewportSize({ width: 1400, height: 1200 });
			await sleep(300);
		}

		// ── The role gate ───────────────────────────────────────
		{
			const g = await call(jar, 'POST', '/api/admin?view=operators',
				{ account_id: hand.account, role: 'operator', note: 'applications lane' });
			check('the owner can grant the second account the operator role',
				g.status === 200, 'status ' + g.status);

			const up = await enterConsole(hand.page);
			check('the console loads for the operator', up);
			const p = await panel(hand.page);
			check('an operator is given the Applications tab', p.tab);
			check('an operator can read the queue', p.rows.length === 3,
				p.rows.length + ' rows');
			check('an operator is offered NO decision control',
				p.rows.every(r => r.moves.length === 0),
				p.rows.map(r => r.moves.join('/')).join(' · '));
			check('and is told why the controls are not there',
				/owner/.test(p.note), JSON.stringify(p.note.slice(0, 80)));

			// The oracle again: the post those controls would have made, from
			// this account's own session.
			const hjar = {};
			const cookies = await hand.ctx.cookies(APP);
			hjar.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
			const mine = (await call(hjar, 'GET', '/api/admin?view=applications')).j;
			check('the gateway serves an operator the list',
				!!mine && Array.isArray(mine.applications) && mine.applications.length === 3,
				mine ? String(mine.total) : 'nothing');
			const tried = await call(hjar, 'POST', '/api/admin?view=applications',
				{ id: (mine.applications[0] || {}).id, status: 'declined' });
			check('the gateway refuses an operator\'s decision, so the absence is right',
				tried.status === 403, 'status ' + tried.status
					+ ' · ' + ((tried.j && tried.j.error) || ''));

			// A viewer is refused the READ, so they must not be given the tab.
			const v = await call(jar, 'POST', '/api/admin?view=operators',
				{ account_id: hand.account, role: 'viewer', note: 'applications lane' });
			check('the owner can drop that account to viewer', v.status === 200,
				'status ' + v.status);
			const vjar = { cookie: hjar.cookie };
			const vsee = await call(vjar, 'GET', '/api/admin?view=applications');
			check('the gateway refuses a viewer the queue', vsee.status === 403,
				'status ' + vsee.status);
			await hand.page.goto(APP + '/console/', { waitUntil: 'domcontentloaded' });
			await sleep(2500);
			const vp = await panel(hand.page);
			check('a viewer is given no Applications tab at all', !vp.tab);
		}

		// ── The choice knob, repaired on the way past ───────────
		//
		// `knobEditor` branched on bool and text and sent everything else to a
		// number field, so a `Kind::Choice` knob -- which carries the spellings
		// it admits precisely so the console can draw them -- got a box that
		// cannot hold a word. The only choice knob today is drawn by the
		// Providers card instead, so it is put back into the Settings card here
		// through the console's own `__provBreak=twice`.
		{
			const st = (await call(jar, 'GET', '/api/admin?view=settings')).j;
			let knob = null, route = '';
			for (const g of (st && st.groups) || []) {
				for (const k of g.knobs || []) {
					if (k.kind === 'choice' && !knob) { knob = k; route = g.route; }
				}
			}
			check('the gateway sends a choice knob with the spellings it admits',
				!!knob && Array.isArray(knob.options) && knob.options.length > 1,
				knob ? knob.key + ' = ' + JSON.stringify(knob.options) : 'no choice knob');

			if (knob) {
				const page = boss.page;
				// An init script, not an `evaluate`: the flag has to be there
				// before admin.js runs, and a navigation would wipe one set
				// after the fact. Through about:blank first, because the page is
				// already on /console/ and a goto that changes only the fragment
				// is a same-document navigation -- no reload, so no init script,
				// and the first run of this measured a console that had never
				// heard of the flag.
				await page.addInitScript(() => { window.__provBreak = 'twice'; });
				await page.goto('about:blank');
				await page.goto(APP + '/console/#settings', { waitUntil: 'domcontentloaded' });
				await page.waitForSelector('#admin-app:not([hidden])', { timeout: 20000 });
				await waitFor(async () => await page.evaluate(() =>
					document.querySelectorAll('#admin-set-groups .admin-set-knob').length > 0),
					20000, 200);
				await sleep(300);

				const ed = await page.evaluate(k => {
					const row = document.querySelector(
						'#admin-set-groups .admin-set-knob[data-knob="' + k.key + '"]');
					if (!row) {
						return { found: false, options: [], tag: 'no row', type: '', value: '',
							rows: document.querySelectorAll('#admin-set-groups .admin-set-knob').length };
					}
					const f = row.querySelector('.admin-set-edit .admin-set-input');
					return {
						found: true,
						tag: f ? f.tagName : 'none',
						type: f ? (f.type || '') : '',
						value: f ? f.value : '',
						options: f && f.tagName === 'SELECT'
							? Array.from(f.options).map(o => o.value).filter(v => v !== '')
							: [],
					};
				}, knob);
				check('the Settings card draws that knob at all', ed.found,
					JSON.stringify(ed));
				check('a choice knob is drawn as a pulldown, not a number field',
					ed.tag === 'SELECT', ed.tag + (ed.type ? '[' + ed.type + ']' : ''));
				check('its options are the gateway\'s own list and no other',
					ed.options.join(',') === knob.options.join(','),
					JSON.stringify(ed.options) + ' vs ' + JSON.stringify(knob.options));
				check('and it shows the value that is actually in force',
					ed.value === String(knob.value),
					JSON.stringify(ed.value) + ' vs ' + JSON.stringify(knob.value));

				// The repair that matters: choosing another and saving must STORE
				// it. Measured at the gateway, not at the row.
				const other = knob.options.find(o => o !== String(knob.value));
				const saved = await page.evaluate(a => {
					const row = document.querySelector(
						'#admin-set-groups .admin-set-knob[data-knob="' + a.key + '"]');
					if (!row) return 'no row';
					const f = row.querySelector('.admin-set-edit .admin-set-input');
					if (!f) return 'no field';
					// Typed the way a person would: the value is put in and the
					// change announced, whichever control it turned out to be.
					f.value = a.other;
					f.dispatchEvent(new Event('input', { bubbles: true }));
					f.dispatchEvent(new Event('change', { bubbles: true }));
					const btns = Array.from(row.querySelectorAll('.admin-set-edit button'));
					const save = btns.find(b => b.textContent === 'Save');
					if (!save) return 'no save';
					save.click();
					// Only a confirm step that is actually SHOWN may be pressed.
					// The buttons are in the page either way, and clicking a
					// hidden one sends whatever the editor was holding -- which
					// on the old number field is nothing at all, and would have
					// been reported here as a save.
					const ask = row.querySelector('.admin-set-confirm');
					if (!ask || ask.hidden) {
						const m = row.querySelector('.admin-set-msg');
						return 'the editor would not send it: ' + ((m && m.textContent) || 'no reason given');
					}
					const yes = Array.from(ask.querySelectorAll('button'))
						.find(b => b.textContent === 'Confirm');
					if (!yes) return 'no confirm';
					yes.click();
					return 'saved';
				}, { key: knob.key, other });
				await sleep(1800);
				const now = (await call(jar, 'GET', '/api/admin?view=settings')).j;
				let after = null;
				for (const g of (now && now.groups) || []) {
					for (const k of g.knobs || []) if (k.key === knob.key) after = k;
				}
				check('saving a choice STORES the chosen value rather than clearing it',
					!!after && String(after.value) === other && after.overridden === true,
					saved + ' · ' + (after ? `${after.value} (overridden ${after.overridden})` : 'gone')
						+ ' · wanted ' + other);
				void route;
			}
		}
	} catch (e) {
		check('the run completed', false, e && e.message);
		saidWhat();
	} finally {
		try { await browser.close(); } catch (e) {}
		cleanup();
	}

	console.log('');
	console.log(`passed ${ok.length}, failed ${bad.length}` + (BREAK ? `   [--break ${BREAK}]` : ''));
	if (bad.length) { console.log('failures:'); bad.forEach(b => console.log('  - ' + b)); }
	process.exit(bad.length ? 1 : 0);
})();
