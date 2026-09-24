// verify_handoff_staleturn.mjs -- a desktop never starts a handed-off turn older than the
// window, however fresh the errand that carries it, and still starts a fresh one.
//
// WHAT HAPPENED (re-check finding R1, 2026-09-22/23). A tab on the live bundle came back
// to the foreground and re-handed a turn it had sent five days earlier. The re-hand
// carried a fresh `ts` and a fresh `deadline`; the desktop that collected it judged the
// turn by them, claimed it and ran it with nobody there. On 2026-09-22 that class of
// replay deleted about 4,900 of the owner's files.
//
// THE RULE (E-R1): a device starts a handed-off turn only while the turn is younger than
// `DISPATCH_DEADLINE_MS`, aged from its BIRTH (the turn id's base-36 prefix, the seed's
// copy of its user message, the stamps the collector holds itself), never from a
// deadline the sender wrote. The age is read in two spans, each on one clock: birth to
// the errand's stamp on the sender's clock, then the post to now on the relay's.
//
// A is a PHONE on the live bundle (`oldTree`, world `oldWorld`); B is a DESKTOP on this
// tree (world `newWorld`); one account, one gateway (the new world's). Cases:
//
//   a  M3: A leaves a five-day-old hand-off and re-hands it on its return.
//   b  the same, A's clock five days FAST for the whole session -- so a check against
//      B's own clock would pass the turn.
//   c  the same, B's clock five days SLOW -- the same trap from the other side.
//   d  a FRESH hand-off from A with its clock an hour SLOW must run: the deadline A
//      writes is already past on B, which is what B refused it on before.
//   e  a plain fresh hand-off must run.
//
// A stale case asserts, on B: the re-hand reached it and it did not claim it, no model
// request carried the prompt, A collected an `aborted` report, and the relay no longer
// holds the errand. A fresh case asserts B claimed it inside a minute and the model saw
// it once. Each stale case, and case d, fails on 4d164343.
//
// A FIVE-DAY-OLD TURN IS SIMULATED BY MOVING A's CLOCK FOR THE SEND ALONE, as the
// re-check's probe did -- and its ORIGINAL errand is kept off the relay (A's post is
// answered in the page, as accepted). Five days on, that errand would long since have
// been collected or dropped; posted now it is, to any collector, a FRESH turn from a
// device whose clock is five days slow, which the rule must run (case d, larger). Only
// the RE-HAND is the replay, and only the re-hand is posted.
//
// Usage: node dev/verify_handoff_staleturn.mjs <a|b|c|d|e> <oldTree> [newTree] [oldWorld] [newWorld]
// Needs both worlds up, the old one proxying /api to the new world's gateway.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , CASE = 'a', OLDT, NEWT = path.join(HERE, '..'), OLDW = '84', NEWW = '83'] = process.argv;
if (!/^[a-e]$/.test(CASE) || !OLDT) {
	console.log('usage: node dev/verify_handoff_staleturn.mjs <a|b|c|d|e> <oldTree> [newTree] [oldWorld] [newWorld]');
	process.exit(2);
}
const STALE = CASE === 'a' || CASE === 'b' || CASE === 'c';
const DAY = 86400000, MIN = 60000;
// The whole-session clock of each device, as an offset from the true clock.
const SKEW_A = CASE === 'b' ? 5 * DAY : (CASE === 'd' ? -60 * MIN : 0);
const SKEW_B = CASE === 'c' ? -5 * DAY : 0;
const CLAIM_MS  = 60000;		// a fresh hand-off is claimed by B well inside this
const REHAND_MS = 150000;		// A's re-hand: on its return, or at its own backstop
const AFTER_MS  = 105000;		// past A's 95 s backstop after the re-hand

function worldEnv(tree, n) {
	const out = execSync(`bash dev/world.sh ${n} --env`, { cwd: tree, env: process.env }).toString();
	const env = {};
	for (const line of out.split('\n')) {
		const m = line.match(/^export ([A-Z_]+)=(.*)$/);
		if (m) env[m[1]] = m[2];
	}
	return env;
}
const envOld = worldEnv(OLDT, OLDW), envNew = worldEnv(NEWT, NEWW);
envOld.DAIMOND_GW_PORT = envNew.DAIMOND_GW_PORT;	// one gateway for both: the new world's
Object.assign(process.env, envOld);
const HO = await import(pathToFileURL(path.join(OLDT, 'dev/harness.mjs')).href);
Object.assign(process.env, envNew);
const HN = await import(pathToFileURL(path.join(NEWT, 'dev/harness.mjs')).href);
const { makePagePro } = await import(pathToFileURL(path.join(NEWT, 'dev/pro.mjs')).href);
const GW_URL = 'http://127.0.0.1:' + envNew.DAIMOND_GW_PORT;
const GWDIR = path.join(NEWT, 'gateway');
const LOGS = [envOld.DAIMOND_MOCK_LOG, envNew.DAIMOND_MOCK_LOG];

/// How many model requests, across both worlds' mocks, carried `text`. The mock logs
/// the provider URL the chat carries, not the device, so both are read.
function modelSaw(text) {
	let n = 0;
	for (const f of LOGS) {
		let raw = '';
		try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { raw = ''; }
		for (const line of raw.split('\n')) if (line && line.includes(text)) n++;
	}
	return n;
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	if (ok) pass++; else fail++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (s) => console.log('  note ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 30000 }).catch(() => {});
async function until(pg, fn, arg, ms = 60000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return v;
		await pg.waitForTimeout(step);
	}
	return false;
}
const storedMsgs = (s) => s.page.evaluate(async () => {
	const cs = window.DaimondCore.chatStore(), out = [];
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		((got && got.messages) || []).forEach((m) => out.push(Object.assign({ chat: sum.id }, m)));
	}
	return out;
}).catch(() => []);
async function gateUp(s) {
	await s.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 120000 }).catch(() => {});
}
async function authed(s) {
	return s.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 60000 }).then(() => true).catch(() => false);
}
async function send(page, text) {
	await page.setViewportSize({ width: 420, height: 860 });
	await page.waitForTimeout(300);
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
}
/// Move a page's clock to `offset` ms from the true one. Installed once; later calls
/// only move it. `Date.now` is what every stamp here is read from.
///
/// The errand listener is restarted after each move. A park round that straddles a
/// step reads its own length off the wall clock, so a step back of five days makes it
/// sleep five days before it parks again: a device whose clock steps back mid-park stops
/// collecting for the length of the step. That is a defect of its own (it wants a
/// monotonic clock), and not this one; a device whose clock is simply wrong is modelled
/// by a listener that has run on that clock from its start.
async function setClock(page, offset) {
	await page.evaluate((ms) => {
		if (!window.__trueNow) {
			const real = Date.now.bind(Date);
			window.__trueNow = real;
			window.__clockOffset = 0;
			Date.now = () => real() + window.__clockOffset;
		}
		window.__clockOffset = ms;
		try {
			if (window.DaimondPost && DaimondPost.parkStop && DaimondPost.parkStart) {
				DaimondPost.parkStop('');
				DaimondPost.parkStart();
			}
		} catch (e) { /* the next collect still runs */ }
	}, offset);
}
/// Diagnostics rows from a page, newest last, that mention `needle` (the rows are read
/// by content, never by time: a page whose clock is moved stamps them five days away).
const diagRows = (s, needle) => s.page.evaluate((n) => {
	try { return window.DaimondDiag.rows().filter((r) => !n || String(r.data || '').includes(n) || String(r.tag || '').includes(n)); }
	catch (e) { return []; }
}, needle).catch(() => []);
const claims = async (s, tid) => (await diagRows(s, tid)).filter((r) => /collect CLAIMED/.test(r.tag || '')).length;
/// The dispatched placeholder A holds for a prompt, or null.
async function placeholderFor(s, text, ms = 30000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const ph = (await storedMsgs(s)).find((m) => m && m.why === 'dispatched' && m.itext === text);
		if (ph) return ph;
		await s.page.waitForTimeout(250);
	}
	return null;
}
/// Has `text`'s answer reached A's store?
const answerHome = (s, text, ms) => until(s.page, async (t) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		const got = await cs.loadMessages(sum.id).catch(() => null);
		const ms2 = (got && got.messages) || [];
		const u = ms2.find((m) => m.role === 'user' && String(m.content || '').includes(t));
		if (u && ms2.some((m) => m.role === 'assistant' && String(m.iturn || '') === String(u.mid) && m.content && !m.why)) return true;
	}
	return false;
}, text, ms, 1000);

const sessions = [];
try {
	const SCR = envNew.DAIMOND_SCRATCH;
	console.log('\n── case ' + CASE + ': A (phone) on ' + path.basename(OLDT) + ', B (desktop) on ' + path.basename(NEWT)
		+ '; A clock ' + (SKEW_A / 3600000) + ' h, B clock ' + (SKEW_B / 3600000) + ' h');
	const acct = 'stale-' + CASE + '-' + Date.now().toString(36).slice(-4);
	const profA = path.join(SCR, 'pw', 'staleturn-' + CASE + '-a'), profB = path.join(SCR, 'pw', 'staleturn-' + CASE + '-b');
	fs.rmSync(profA, { recursive: true, force: true }); fs.rmSync(profB, { recursive: true, force: true });

	// ── One account, two devices, one gateway ─────────────────
	const a = await HO.open({ name: acct + '-a', touch: true, signIn: false, connect: false, profile: profA,
		route: async (page) => { page.setDefaultNavigationTimeout(120000); } });
	sessions.push(a);
	await gateUp(a);
	await HO.signInAs(a, acct);
	check('A is signed in to the gateway', await authed(a));
	const proA = await makePagePro(a.page, GWDIR, GW_URL);
	check('A holds Pro', proA.pro === true, JSON.stringify(proA));
	await HO.connectMock(a);
	await HO.newChat(a);
	await HO.chat(a, 'seed turn ' + CASE + ' ' + Date.now());
	await settle(a.page);

	const b = await HN.open({ name: acct + '-b', signIn: false, connect: false, profile: profB,
		route: async (page) => { page.setDefaultNavigationTimeout(120000); } });
	sessions.push(b);
	for (const [lab, s] of [['A', a], ['B', b]]) s.page.on('dialog', (d) => { note(lab + ' dialog: ' + d.type() + ' (dismissed)'); d.dismiss().catch(() => {}); });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 120000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	const red = await b.page.evaluate((c) => DaimondPairing.redeem(c).then(() => 'ok', (e) => 'err: ' + e.message), code && code.code);
	check('B paired with A', red === 'ok', red);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(b);
	await HN.signInAs(b, acct);
	check('B is signed in to the gateway', await authed(b));
	await makePagePro(b.page, GWDIR, GW_URL);
	await HN.connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);

	// Presence, both ways, and each device's decisions logged.
	for (const [s, n] of [[b, acct + '-b'], [a, acct + '-a']]) {
		await s.page.evaluate((nm) => window.DaimondSync.beatPresence && window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), nm), n).catch(() => {});
	}
	for (const s of [a, b]) {
		await s.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'staleturn'); } catch (e) { /* none */ } }).catch(() => {});
	}
	await sleep(2000);
	const aSees = await a.page.evaluate(() => (window.DaimondPresence.awake(window.DaimondIdentity.deviceId(), Date.now()) || []).length).catch(() => -1);
	check('presence: A sees B awake', aSees >= 1, 'A sees ' + aSees);

	// ── The clocks, for the rest of the session ───────────────
	if (SKEW_A) await setClock(a.page, SKEW_A);
	if (SKEW_B) await setClock(b.page, SKEW_B);
	if (SKEW_A || SKEW_B) {
		// Each device re-reads the relay's clock through presence with its clock moved.
		for (const s of [a, b]) await s.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		note('clocks moved: A ' + (SKEW_A / 3600000) + ' h, B ' + (SKEW_B / 3600000) + ' h');
	}

	// ── A FRESH hand-off: the case under test for d and e, the warm-up for a-c ──
	await a.page.setViewportSize({ width: 1280, height: 900 });
	await HO.newChat(a);
	const FRESH = 'fresh hand-off ' + CASE + ' ' + Date.now();
	const f0 = modelSaw(FRESH);
	const tSend = Date.now();
	await send(a.page, FRESH);
	// The turn id is the user message's `mid`, which outlives the placeholder (dropped the
	// moment the answer merges, often before a poll could see it).
	const uF = await until(a.page, async (t) => {
		const cs = window.DaimondCore.chatStore();
		for (const sum of cs.stored()) {
			const got = await cs.loadMessages(sum.id).catch(() => null);
			const m = ((got && got.messages) || []).find((x) => x.role === 'user' && x.content === t);
			if (m) return String(m.mid || '');
		}
		return false;
	}, FRESH, 30000, 250);
	const tidF = uF ? String(uF) : '';
	const dispatched = tidF ? (await diagRows(a, tidF)).some((r) => /dispatch (start|posted)/.test(r.tag || '')) : false;
	note('fresh turn ' + (tidF || 'none') + ' (A dispatched it: ' + dispatched + ')');
	let claimedAt = 0;
	for (let i = 0; tidF && i < CLAIM_MS / 500 && !claimedAt; i++) {
		if (await claims(b, tidF) > 0) claimedAt = Date.now() - tSend;
		else await sleep(500);
	}
	const freshHome = claimedAt ? await answerHome(a, FRESH, 60000) : false;
	await sleep(3000);
	const freshRuns = modelSaw(FRESH) - f0;
	const label = STALE ? 'warm-up: ' : '';
	check(label + (CASE === 'd' ? 'B claimed a fresh hand-off from a sender an hour slow, inside a minute'
		: 'B claimed a fresh hand-off, inside a minute'), !!claimedAt, claimedAt ? '+' + claimedAt + 'ms' : 'not claimed');
	check(label + 'the model saw it exactly once, and its answer reached A', freshRuns === 1 && !!freshHome,
		'requests ' + freshRuns + ', home ' + !!freshHome);
	for (const r of (await diagRows(b, tidF.slice(0, 12))).filter((r) => /collect (age|stand|CLAIMED)/.test(r.tag || '')).slice(-4)) {
		note('B diag ' + r.tag + ' :: ' + String(r.data || '').slice(0, 200));
	}

	if (STALE) {
		// ── THE STALE ORPHAN ──────────────────────────────────
		// A sends as if five days ago (its clock moved back five days for the send alone);
		// the errand it posts is answered in the page, so only the re-hand reaches the relay.
		// Taps, before anything is sent: what B's collector is handed, and every report A
		// absorbs (A's own backstop can re-hand before its return does).
		await b.page.evaluate(() => {
			const P = window.DaimondPeer, run = P.runErrand;
			window.__errands = [];
			P.runErrand = function (e, d) {
				try { window.__errands.push({ turnId: e && e.turnId, ts: e && e.ts, deadline: e && e.deadline, rowTs: d && d.rowTs }); } catch (x) { /* record only */ }
				return run.apply(this, arguments);
			};
		});
		await a.page.evaluate(() => {
			const P = window.DaimondPeer, absorb = P.absorb;
			window.__reports = [];
			P.absorb = async function (o) {
				try { if (o && o.t === 'report') window.__reports.push({ turnId: o.turnId, status: o.status, why: String(o.why || '').slice(0, 80) }); } catch (x) { /* record only */ }
				return absorb.apply(this, arguments);
			};
		});

		await settle(a.page); await settle(b.page);
		await sleep(8000);
		await a.page.setViewportSize({ width: 1280, height: 900 });
		await HO.newChat(a);
		const STALE_TXT = 'stale orphan ' + CASE + ' ' + Date.now();
		const kept = [];
		const keepOff = async (route) => {
			const req = route.request();
			if (req.method() === 'POST' && /\/api\/post$/.test(req.url().split('?')[0]) && !/\?/.test(req.url())) {
				kept.push(Date.now());
				return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"accepted":true}' });
			}
			return route.continue();
		};
		await a.page.route('**/api/post*', keepOff);
		await setClock(a.page, SKEW_A - 5 * DAY);
		await send(a.page, STALE_TXT);
		const ph = await placeholderFor(a, STALE_TXT);
		// The errand is sealed and posted just after the placeholder is marked.
		for (let i = 0; ph && !kept.length && i < 40; i++) await sleep(250);
		await setClock(a.page, SKEW_A);
		await a.page.unroute('**/api/post*', keepOff);
		const tid = ph ? String(ph.iturn) : '';
		const bornMs = (() => { try { return parseInt(tid.split('-')[0], 36); } catch (e) { return 0; } })();
		check('(precondition) A left a hand-off born five days before its clock now, its errand kept off the relay',
			!!ph && kept.length >= 1 && Math.abs((Date.now() + SKEW_A - bornMs) - 5 * DAY) < 10 * MIN,
			ph ? 'turn ' + tid + ' born ' + new Date(bornMs).toISOString() + ', posts kept off ' + kept.length : 'none');
		await settle(a.page);
		const bSeen = await until(b.page, async (t) => {
			const cs = window.DaimondCore.chatStore();
			for (const sum of cs.stored()) {
				const got = await cs.loadMessages(sum.id).catch(() => null);
				if (got && (got.messages || []).some((m) => m.why === 'dispatched' && m.itext === t)) return true;
			}
			return false;
		}, STALE_TXT, 60000);
		note('B holds the stale placeholder, synced from A: ' + !!bSeen);
		// A's wake path (the live bundle) re-hands only to a desktop genuinely servicing
		// its errand channel; wait for A to read B that way, as a real awake runner is.
		const bId = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
		let svc = null;
		for (let i = 0; i < 40 && !svc; i++) {
			await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
			svc = await a.page.evaluate((id) => {
				try {
					const r = (window.DaimondPresence.snapshot() || {})[id];
					const sv = r && r.servicedAt ? Number(r.servicedAt) : 0;
					return (sv && Date.now() - sv < 90000) ? Math.round((Date.now() - sv) / 1000) : null;
				} catch (e) { return null; }
			}, bId).catch(() => null);
			if (svc == null) await sleep(3000);
		}
		note('A reads B as servicing: ' + (svc != null ? svc + ' s ago' : 'no'));

		// THE OLD TAB COMES BACK TO THE FOREGROUND, and re-hands the orphan.
		await a.page.evaluate(async () => {
			const set = (v) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
			set('hidden');  document.dispatchEvent(new Event('visibilitychange'));
			await new Promise((r) => setTimeout(r, 300));
			set('visible'); document.dispatchEvent(new Event('visibilitychange'));
		});
		let rehandAt = 0;
		const tComeback = Date.now();
		while (tid && !rehandAt && Date.now() - tComeback < REHAND_MS) {
			if ((await diagRows(a, tid)).some((r) => /dispatch retry/.test(r.tag || '') && String(r.data || '').includes(tid))) rehandAt = Date.now();
			else await sleep(500);
		}
		check('(precondition) A re-handed the five-day-old turn to B', !!rehandAt,
			rehandAt ? '+' + (rehandAt - tComeback) + 'ms after its return' : 'no re-hand in ' + (REHAND_MS / 1000) + ' s');
		while (rehandAt && Date.now() - rehandAt < AFTER_MS) await sleep(1000);

		const handed = (await b.page.evaluate(() => window.__errands || []).catch(() => [])).filter((x) => String(x.turnId) === tid);
		for (const x of handed) note('B was handed ' + x.turnId + ': errand ts ' + (x.ts ? new Date(x.ts).toISOString() : x.ts)
			+ ', deadline ' + (x.deadline ? new Date(x.deadline).toISOString() : x.deadline) + ', relay stamp ' + x.rowTs);
		check('(precondition) the re-hand reached B\'s collector', handed.length >= 1, 'handed ' + handed.length);
		const bClaims = await claims(b, tid);
		check('B did not claim the five-day-old turn', bClaims === 0, 'claims ' + bClaims);
		const refused = (await diagRows(b, tid)).filter((r) => /collect age/.test(r.tag || '') && /REFUSE/.test(String(r.data || '')));
		check('B refused it by its age, in its own decision log', refused.length >= 1,
			refused.length ? String(refused[0].data).slice(0, 160) : 'no refusal logged');
		const runs = modelSaw(STALE_TXT);
		check('no model request carried the stale prompt, on any device', runs === 0, 'requests ' + runs);
		const reps = (await a.page.evaluate(() => window.__reports || []).catch(() => [])).filter((r) => String(r.turnId) === tid);
		check('A collected an `aborted` report for it', reps.some((r) => r.status === 'aborted'), JSON.stringify(reps).slice(0, 200));
		// The relay no longer holds a live errand for the turn: B let the row go.
		const left = await b.page.evaluate(async (t) => {
			const r = await fetch('/api/post?since=0', { credentials: 'same-origin',
				headers: { 'x-daimond-api': String(window.DaimondGateway.clientApi()) } });
			const j = await r.json().catch(() => null);
			let n = 0;
			for (const row of (j && j.rows) || []) {
				if (!row.envelope || row.expired) continue;
				let o = null;
				try { o = await window.DaimondPeer.peek(row.envelope); } catch (e) { o = null; }
				if (o && o.t === 'errand' && String(o.turnId) === t) n++;
			}
			return n;
		}, tid).catch((e) => -1);
		check('the relay no longer holds an errand for it (the row was let go and acked)', left === 0, 'errand rows left ' + left);
		const aClaims = await claims(a, tid);
		check('(holds) A did not run it locally either', aClaims === 0, 'A claims ' + aClaims);
		for (const r of (await diagRows(b, tid.slice(0, 12))).slice(-8)) note('B diag ' + r.tag + ' :: ' + String(r.data || '').slice(0, 200));
		for (const r of (await diagRows(a, tid.slice(0, 12))).slice(-8)) note('A diag ' + r.tag + ' :: ' + String(r.data || '').slice(0, 200));
	}
	for (const [lab, s] of [['A', a], ['B', b]]) {
		const errs = (s.errs || []).filter((e) => !/status of 40[19]|ERR_EMPTY_RESPONSE/.test(e));
		if (errs.length) note(lab + ' console errors: ' + errs.slice(0, 4).map((e) => e.slice(0, 140)).join(' | '));
	}
} catch (e) {
	check('the scenario ran to completion', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* gone */ } }
}
console.log('\ncase ' + CASE + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
