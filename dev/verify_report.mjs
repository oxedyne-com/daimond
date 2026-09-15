// dev/verify_report.mjs -- reporting a GROUP message, end to end, through a
// running gateway and into the operator's queue.
//
// WHY THIS FILE EXISTS. `/api/report` had five checks and the fifth required the
// payload's signed `to` to be the reporter's own registered key. A message to a
// group carries the GROUP'S id there -- thirty-two bytes that are not a public
// key and are nobody's registered key -- so the comparison could never match and
// the one kind of message with an audience was the one kind nobody could report.
// The control was drawn on every group row and every press ended in a refusal.
//
// Nothing in the tree measured it. `verify_group.mjs` and `verify_post.mjs` both
// run with NO GATEWAY at all, which is right for what they prove and is exactly
// why this was invisible: the refusal is the gateway's, and the gateway was
// never in the path. `verify_relay_e2e.mjs` puts one there but never files a
// report. So the property here is the JOIN: a member's browser, a real relay, a
// real filing, and an operator reading it.
//
// What each section settles:
//
//   0. THE SEAMS ARE IN THE APP. index.html carries group.js and report.js, and
//      /api through this run's front door reaches this run's gateway.
//   1. A GROUP EXISTS AND A MEMBER HOLDS ITS MESSAGE, carried by the relay.
//   2. THE ROSTER IS WHAT CARRIES THE REPORT. The same bytes are refused with no
//      roster and filed with one, from the same account, seconds apart -- so
//      what is measured is the roster and not some other change to the route.
//   3. A NON-MEMBER HOLDING EVERY BYTE IS STILL REFUSED. C is handed the
//      artefact, the envelope, the content key AND the roster, and the gateway
//      refuses because C is not named in it.
//   4. IT REACHES THE OPERATOR, in the console's own queue, with the words that
//      were signed and the group it was sent to.
//
// WHAT THIS FILE DOES NOT PROVE. Nothing about the seal -- `verify_post.mjs` §1
// owns that with no server in the path. Nothing about who may decide a report:
// that is `verify_admin.mjs`. This is loopback with the beta opened, which is
// what `dev/gwbin.mjs` builds for every gateway-driving verifier here.
//
//   node dev/verify_report.mjs
//   DAIMOND_REPORT_PORT=8960 DAIMOND_REPORT_GW_PORT=9900 node dev/verify_report.mjs
//
// A fault injected on purpose, so a check can be shown going red. Each break
// names the checks it MUST redden; a run where those stayed green fails.
//
//   --break=noroster   the report is filed without the roster   -> §2 one check
//   --break=anyone     C's refusal is read as an acceptance     -> §3 one check

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, GWBIN, GWDIR, openBeta, procLog,
	stopGatewayCleanly } from './gwbin.mjs';

// `harness.mjs` reads the app's URL into a module CONST at import time, so it is
// imported BELOW, dynamically, after the environment it reads is set. See the
// same note in dev/verify_relay_e2e.mjs, which is where this cost an afternoon.
let open, errors;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// ITS OWN KNOBS, never `DAIMOND_PORT` or `DAIMOND_GW_PORT`. This file starts a
// dev server of its own pointed at a gateway of its own, and a suite run has
// already exported those for the server everything else shares -- so reading
// them makes this verifier try to seize the suite's port, find it held, and
// refuse every time. 8960 + N and 9900 + N, BOTH READ OFF THE REGISTER at the
// top of `dev/world.sh` and both written into it: the first draft took 8940 + N,
// which is `verify_terminal`'s demo server, and the two would have met the day
// somebody ran them side by side. `dev/gate.sh` derives both from the world
// number, on the same rule as verify_redeem's and verify_relay_e2e's.
const GW_PORT  = Number(process.env.DAIMOND_REPORT_GW_PORT || 9900);
const GW_URL   = `http://127.0.0.1:${GW_PORT}`;
const APP_PORT = Number(process.env.DAIMOND_REPORT_PORT || 8960);
const APP_URL  = `http://localhost:${APP_PORT}`;
const SCRATCH  = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK     = path.join(SCRATCH, 'verify_report-gw');
const GW_LOG   = procLog('verify_report');
const SRV_LOG  = procLog('verify_report', 'server');

const BREAK = (process.argv.find(a => a.startsWith('--break=')) || '').slice(8);
/// What each break must turn red, by the leading words of the check's name.
const AIMS = {
	noroster: ['the same message, with the roster, is filed'],
	anyone:   ['a non-member holding every byte is refused'],
};
if (BREAK && !(BREAK in AIMS)) {
	console.log(`  --break=${BREAK} is not one of: ${Object.keys(AIMS).join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail, why) => {
	(pass ? ok : bad).push(name);
	const tail = pass ? (detail ? ' — ' + detail : '')
		: ' — ' + [why, detail].filter(Boolean).join(' · ');
	console.log((pass ? '  ok   ' : '  FAIL ') + name + tail);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Poll until `fn` answers true, or give up. Returns whether it did.
async function waitFor(fn, ms = 12000, gap = 150) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) { /* not up yet */ }
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

/// Is anything listening on a loopback port?
async function held(port) {
	return await waitFor(async () => {
		const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
		return !!r;
	}, 600, 200);
}


// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THIS RUN'S OWN GATEWAY AND ITS OWN FRONT DOOR                             │
// └───────────────────────────────────────────────────────────────────────────┘

/// Build the gateway's working directory: the deployed config with the port
/// changed and the beta opened, the real signing keys symlinked in, and an EMPTY
/// store.
///
/// The database key is NOT symlinked, for the reason `verify_relay_e2e.mjs`
/// gives: the store here is new, so its at-rest key must be new too, and
/// pointing a fresh store at the live key either fails or -- far worse --
/// succeeds against the live store.
function buildWorkDir() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, 'keys'), { recursive: true });
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(WORK, 'keys', k));
	}
	let cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${GW_PORT})`);
	if (!cfg.includes(`(u16|${GW_PORT})`)) {
		console.log('  FAIL could not set the listen port in the copied app.jdat — '
			+ 'has its shape changed? A gateway left on the deployed port would be '
			+ 'measured instead of this one.');
		process.exit(1);
	}
	cfg = openBeta(cfg, 'verify_report');
	fs.writeFileSync(path.join(WORK, 'app.jdat'), cfg);
	return WORK;
}

let gw = null, srv = null;

function cleanup() {
	for (const p of [gw, srv]) { try { if (p) p.kill(); } catch (e) { /* already gone */ } }
	gw = null; srv = null;
	for (const n of ['report-a', 'report-b', 'report-c']) {
		try { fs.rmSync(path.join(SCRATCH, 'pw', `${n}-${process.pid}`), { recursive: true, force: true }); }
		catch (e) { /* never made, or already gone */ }
	}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });


// ┌───────────────────────────────────────────────────────────────────────────┐
// │ A DEVICE                                                                  │
// └───────────────────────────────────────────────────────────────────────────┘

/// One browser on its own profile, signed in, with an identity, a sealing key, a
/// card and an account on THIS run's gateway. Nothing is injected: §0 asserts
/// the script tags and the page is taken as the browser assembled it.
async function device(name) {
	const s = await open({ name, signIn: true, connect: false });
	await s.page.waitForFunction(
		() => !!window.DaimondPost && !!window.DaimondTrust && !!window.DaimondGroup
			&& !!window.DaimondReport && !!window.DaimondIdentity && !!window.DaimondGateway,
		null, { timeout: 20000 },
	).catch(() => { throw new Error(
		`${name}: the page did not assemble — post.js, trust.js, group.js or report.js `
		+ 'is missing from www/index.html. Nothing here injects them; see §0.'); });
	await s.page.evaluate(async () => {
		await window.DaimondIdentity.ensureSealingKey();
		await window.DaimondIdentity.mintCard();
	});
	const got = await s.page.evaluate(async () => {
		try { await window.DaimondGateway.bootstrap(); } catch (e) { /* read the state */ }
		const st = window.DaimondGateway.state();
		return { authed: st.authed === true, acct: String(st.accountId || '') };
	});
	s.authed = got.authed;
	s.acct   = got.acct;
	// BOTH SPELLINGS, because the app uses both and they are not interchangeable:
	// `DaimondPost.send({to})` takes base64url, `DaimondGroup.create` takes hex.
	s.pub = await s.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	s.hex = await s.page.evaluate(async () => {
		const raw = await window.DaimondIdentity.publicKeyRaw();
		return Array.from(raw).map(b => (b + 256).toString(16).slice(1)).join('');
	});
	return s;
}

/// The one place the reported words are chosen, so §2 and §4 cannot drift.
const WORDS = 'you are all a disgrace ' + Math.random().toString(36).slice(2, 10);


(async () => {
	requireFreshGateway();

	if (await held(GW_PORT)) {
		console.log(`  FAIL something is already answering on :${GW_PORT}. This run needs its `
			+ 'OWN gateway with an EMPTY store — it counts rows in an operator queue, and '
			+ 'counting them in somebody else\'s store would measure their afternoon. Set '
			+ 'DAIMOND_REPORT_GW_PORT to a free port.');
		process.exit(1);
	}
	if (await held(APP_PORT)) {
		console.log(`  FAIL something is already serving on :${APP_PORT}. This run starts its own `
			+ `dev server so it can point /api at :${GW_PORT}; a server started by `
			+ 'dev/world.sh proxies to that world\'s OWN gateway instead, and the browsers '
			+ 'would then be talking to a gateway this file did not start. Set '
			+ 'DAIMOND_REPORT_PORT to a free port.');
		process.exit(1);
	}

	const cwd = buildWorkDir();
	gw = spawn(GWBIN, [], { cwd, env: { ...process.env, APP_MODE: 'sandbox' }, stdio: GW_LOG.stdio });
	const gwUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
	check('this run\'s own gateway is up, on an empty store', gwUp, `${GW_URL} — ${cwd}`);
	if (!gwUp) { GW_LOG.report(); cleanup(); process.exit(1); }

	srv = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
		cwd: ROOT,
		env: { ...process.env, DAIMOND_PORT: String(APP_PORT), DAIMOND_GW_PORT: String(GW_PORT) },
		stdio: SRV_LOG.stdio,
	});
	const srvUp = await waitFor(async () => (await fetch(`${APP_URL}/index.html`)).ok);
	check('and its own front door, proxying /api to it', srvUp, `${APP_URL} → :${GW_PORT}`);
	if (!srvUp) { SRV_LOG.report(); cleanup(); process.exit(1); }

	process.env.DAIMOND_APP = APP_URL;
	({ open, errors } = await import('./harness.mjs'));

	let A = null, B = null, C = null;
	try {
		// ── 0. The seams are in the app ────────────────────────────────
		console.log('\n0. the client is the shipped one, and the relay is this run\'s');
		const html = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
		for (const f of ['post', 'trust', 'group', 'report']) {
			check(`www/index.html carries a script tag for js/${f}.js`,
				new RegExp('<script[^>]+src=["\']js/' + f + '\\.js["\']').test(html),
				'', 'nothing here injects it, so every section below would be untestable');
		}
		const viaDoor = await fetch(`${APP_URL}/api/health`);
		const direct  = await fetch(`${GW_URL}/api/health`);
		check('/api through the front door reaches this run\'s gateway',
			viaDoor.ok && direct.ok && (await viaDoor.text()) === (await direct.text()),
			`door ${viaDoor.status}, direct ${direct.status}`);

		A = await device('report-a');		// the creator, and the sender
		B = await device('report-b');		// the member who reports
		C = await device('report-c');		// in no group, and the operator later
		check('three devices, three identities, three accounts on ONE relay',
			A.authed && B.authed && C.authed && !!C.acct,
			`A ${A.authed} B ${B.authed} C ${C.authed}`,
			'a device with no gateway session cannot send, collect or report');

		// ── 1. A group, and a message in it ────────────────────────────
		console.log('\n1. a group message reaches a member through the relay');
		// The cards cross through this file, which is what a camera does across a
		// table. A roster can only name somebody this device holds a card for.
		const cardOf  = s => s.page.evaluate(() => window.DaimondTrust.cardText());
		const readCard = (s, text) => s.page.evaluate(async (t) => {
			const card = window.DaimondTrust.parse(t);
			if (!card) return false;
			await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.QR);
			await window.DaimondPost.refreshPeople();
			return true;
		}, text);
		const [aCard, bCard] = [await cardOf(A), await cardOf(B)];
		check('A and B hold each other\'s cards', await readCard(A, bCard) && await readCard(B, aCard));

		await B.page.evaluate(() => { try { window.DaimondPost.parkStop(); } catch (e) {} });

		const made = await A.page.evaluate(async (keys) => {
			const r = await window.DaimondGroup.create('the reading group', keys);
			return { ok: r.ok === true, gid: r.gid || '', sent: r.sent | 0,
				members: r.members | 0, why: r.why || '' };
		}, [B.hex]);
		check('A makes a group naming B, and the roster reaches B',
			made.ok && !!made.gid && made.members === 2 && made.sent === 1,
			`members=${made.members} sent=${made.sent}`, made.why);

		const gsent = made.gid ? await A.page.evaluate(async ({ gid, body }) => {
			const r = await window.DaimondPost.send({ group: gid, body });
			return { ok: r.ok === true, sent: r.sent | 0, why: r.why || '' };
		}, { gid: made.gid, body: WORDS }) : { ok: false, why: 'no group' };
		check('A writes to it, and the relay carries it', gsent.ok && gsent.sent >= 1,
			`sent=${gsent.sent}`, gsent.why);

		// B takes the roster and then the message off the relay, in the order the
		// relay delivered them, through the client's own collect.
		//
		// BOTH LISTS, because a group B has been invited to and has not joined
		// puts its messages in the TRAY: the roster is the consent, and until B
		// presses Join the relay's per-pair flag stands (post.js, where `tray` is
		// set). report.js's own `find` searches the same union, so a row it can
		// report is a row that is in one of these two -- and nothing here presses
		// Join, because whether a member has joined is not what this file is
		// about and a test that joins for the app is a test measuring its own
		// repair.
		const mine = await B.page.evaluate(async (gid) => {
			await window.DaimondPost.collect();
			const all = [].concat(window.DaimondPost.list() || [],
				window.DaimondPost.tray() || []);
			const m = all.find(x => x.gid === gid && x.dir === 'in');
			return m ? {
				addr: m.addr, body: m.body, gid: m.gid,
				can:  !!(window.DaimondReport.canReport && window.DaimondReport.canReport(m)),
				roster: await window.DaimondGroup.rosterArt(gid),
			} : null;
		}, made.gid);
		check('B opens it, filed as the group\'s', !!mine && mine.body === WORDS && mine.gid === made.gid,
			mine ? String(mine.body).slice(0, 40) : 'nothing was filed',
			'the group message did not survive the relay');
		check('the Report control is offered on it', !!mine && mine.can, '',
			'a group row with no Report control cannot reach this route at all');
		check('and B holds the signed roster that says B is in the group',
			!!mine && typeof mine.roster === 'string' && mine.roster.length > 0,
			mine ? `${(mine.roster || '').length} chars of base64` : '',
			'group.js did not keep the roster artefact, so no report can prove membership');

		// ── 2. The roster is what carries the report ───────────────────
		console.log('\n2. the roster is what lets a member report it');
		// THE SAME BYTES, TWICE, FROM THE SAME ACCOUNT. First as a one-to-one
		// report would be sent -- no roster, nothing to say B is in the group --
		// and then as report.js sends one. A route that had been loosened rather
		// than taught about rosters would file both.
		const bare = mine ? await B.page.evaluate(async (addr) => {
			const m = [].concat(window.DaimondPost.list() || [], window.DaimondPost.tray() || [])
				.find(x => x.addr === addr);
			const parts = window.DaimondReport.partsOf(m);
			if (parts.why) return { filed: false, why: parts.why };
			delete parts.gid;					// the pre-group shape, exactly
			try {
				const r = await window.DaimondReport.send(parts, 'harassment');
				return { filed: r.ok === true };
			} catch (e) { return { filed: false, why: String((e && e.message) || e) }; }
		}, mine.addr) : { filed: false, why: 'no message' };
		// THE REASON, NOT JUST THE REFUSAL. This read `bare.filed !== true` alone
		// and went green on a run where §1 had found no message at all -- a check
		// that passes when there is nothing to test is worse than no check, and
		// it passed exactly once before this line was written.
		check('with no roster, the gateway refuses it',
			bare.filed !== true && /not addressed to this account/i.test(String(bare.why || '')),
			String(bare.why || 'nothing was attempted').slice(0, 110),
			'a group message was filed with nothing to show the reporter is in the group');

		const filedRaw = mine ? await B.page.evaluate(async (addr) => {
			const m = [].concat(window.DaimondPost.list() || [], window.DaimondPost.tray() || [])
				.find(x => x.addr === addr);
			const parts = window.DaimondReport.partsOf(m);
			if (parts.why) return { filed: false, why: parts.why, parts: null };
			try {
				const r = await window.DaimondReport.send(parts, 'harassment');
				return { filed: r.ok === true, fresh: r.fresh === true, parts: parts,
					roster: await window.DaimondGroup.rosterArt(m.gid) };
			} catch (e) { return { filed: false, why: String((e && e.message) || e), parts: parts }; }
		}, mine.addr) : { filed: false, why: 'no message', parts: null };
		const filed = BREAK === 'noroster' ? { ...filedRaw, filed: false } : filedRaw;
		check('the same message, with the roster, is filed', filed.filed === true,
			filed.filed ? `fresh=${filed.fresh}` : String(filed.why || '').slice(0, 140),
			'a member of a group still cannot report a message sent to it');

		// ── 3. A non-member holding every byte ─────────────────────────
		console.log('\n3. holding the bytes is not being in the group');
		// C is handed the artefact, the envelope, the content key AND the roster
		// -- everything B sent -- and is refused because the roster does not name
		// C. This is the check that is NOT the signature: every signature step
		// passes on these bytes, because they are B's.
		const byCRaw = (filed.parts && filed.roster) ? await C.page.evaluate(async (send) => {
			const r = await fetch('/api/report', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json',
					'x-daimond-api': String(window.DaimondGateway.clientApi()) },
				body: JSON.stringify({
					artefact: send.parts.art, envelope: send.parts.env, ckey: send.parts.ck,
					reason: 'harassment', roster: send.roster,
				}),
			});
			let j = null; try { j = await r.json(); } catch (e) { j = null; }
			return { status: r.status, error: (j && j.error) || '' };
		}, { parts: filed.parts, roster: filed.roster }) : { status: 0, error: 'nothing to send' };
		const byC = BREAK === 'anyone' ? { status: 200, error: '' } : byCRaw;
		check('a non-member holding every byte is refused', byC.status === 403,
			`status ${byC.status} · ` + String(byC.error).slice(0, 90),
			'anybody who can get hold of a group message can report it as though they were in the group');

		// ── 4. The operator's queue ────────────────────────────────────
		console.log('\n4. it reaches the operator, named as a group message');
		// An owner is named in configuration by account id, which is not known
		// until an account exists, so the gateway is restarted with C's -- the one
		// device that has filed nothing. `verify_admin.mjs` does the same and for
		// the same reason. Stopped cleanly, so the store closes before it reopens.
		const note = await stopGatewayCleanly(gw, `${GW_URL}/api/health`);
		if (note) console.log(note);
		gw = spawn(GWBIN, [], {
			cwd, env: { ...process.env, APP_MODE: 'sandbox', DAIMOND_OWNER_ACCOUNTS: C.acct },
			stdio: GW_LOG.stdio,
		});
		check('the gateway restarts with C as its owner',
			await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok, 20000));
		const who = await C.page.evaluate(async () => {
			const r = await fetch('/api/admin?view=whoami', { credentials: 'same-origin' });
			return await r.json().catch(() => null);
		});
		check('and C reads as the owner, so the queue below is this gateway\'s',
			!!who && who.role === 'owner', 'role ' + (who && who.role));

		const queue = await C.page.evaluate(async () => {
			const r = await fetch('/api/admin?view=reports&build=1', { credentials: 'same-origin' });
			const j = await r.json().catch(() => null);
			return { status: r.status, total: (j && j.total) | 0, rows: (j && j.reports) || [] };
		});
		const row = queue.rows[0] || null;
		check('the operator\'s queue holds exactly one report',
			queue.status === 200 && queue.rows.length === 1,
			`status=${queue.status} rows=${queue.rows.length} total=${queue.total}`,
			'the filing did not reach the console, or a refusal was filed beside it');
		check('and it carries the words that were signed',
			!!row && row.body === WORDS, row ? String(row.body).slice(0, 40) : '',
			'the operator is reading something other than the reported message');
		check('named as the group it was sent to, not as private mail',
			!!row && row.group === made.gid, row ? String(row.group).slice(0, 16) : '',
			'an operator deciding about words with an audience is told they were one-to-one');
		check('filed by B, about A\'s key',
			!!row && row.reporter === B.acct && row.author_pub === A.pub,
			row ? `${String(row.reporter).slice(0, 10)}… / ${String(row.author_pub).slice(0, 10)}…` : '');

		for (const s of [A, B, C]) {
			const thrown = errors(s).filter(e => !/Failed to load resource/.test(e));
			check(`${s.name} threw nothing`, thrown.length === 0, thrown.slice(0, 2).join(' | '));
		}
	} catch (e) {
		check('the run completed', false, String((e && e.stack) || e));
	} finally {
		for (const s of [A, B, C]) { try { if (s) await s.close(); } catch (e) { /* gone */ } }
	}

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) { GW_LOG.report(); SRV_LOG.report(8); }
	cleanup();
	// A `--break` run EXPECTS to fail: it exits 0 when the checks it aims at
	// reddened and 1 when they did not, so "the break changed nothing" is itself
	// a failing run.
	if (BREAK) {
		const missed = AIMS[BREAK].filter(a => !bad.some(n => n.startsWith(a)));
		console.log(missed.length
			? `\n--break=${BREAK}: these stayed GREEN and should not have — ${missed.join('; ')}. `
				+ 'The check aimed at is not testing what it claims.'
			: `\n--break=${BREAK}: every check it aims at went red, which is the point.`);
		process.exit(missed.length ? 1 : 0);
	}
	process.exit(bad.length ? 1 : 0);
})();
