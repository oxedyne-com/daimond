// gateway: live
// verify_handoff_fault.mjs — UNBLOCK-7 F2-F4 fault seed, in real browsers on the
// real gateway: a phone (WebKit, iPhone UA, touch) hands a turn to its nominated runner
// (Chromium desktop), and the runner's web tool fails mid-turn. A mock `@tool web_open`
// reaches the runner's `DaimondWeb.open`, stubbed to
//
//   CASE T (throw). Throw a plain JS Error: the 14 Oct crash's shape. Before F1 the binding
//   had no `catch`, so the throw unwound through the engine's frame and poisoned it. With F1
//   merged (fire/webwedge, every import `catch`) it is a failed tool: the turn FINISHES, the
//   tile shows `web_open · failed` with no Interrupted, and the engine is not poisoned.
//   CASE N (never). Return a promise that never settles. Nothing traps; only the
//   errand's deadline ends the run. The runner ages errands and leases on the RELAY's
//   clock (`learnRelayNow`, re-learnt from every presence and collect answer), so a
//   Playwright `page.clock` jump is undone by the next answer; instead the relay's `now`
//   is moved on the runner's own wire, past the deadline, until the run has ended.
//   The killed engine call is still unsettled, so 5 s on the runner poisons itself with
//   `hung: deadline` and reloads (check_final G1: before export_session stopped panicking on
//   the held session, a stray panic from the run's end poisoned it first, by accident).
//   CASE D (daimon). Case N on a Diamond's daimon turn, steered from P, a Chromium phone
//   (WebKit WPE has no OPFS, so it cannot hold a Diamond). A daimon never runs captureSession,
//   so only the hung check can poison it.
//
// Each case asserts, from what a person sees and what the runner did:
//   I4  the phone's tile reads Interrupted with a Retry control (case T: the failed tool, finished);
//   I9  it names the runner by its true name (case T: the runner's engine is not poisoned);
//   I14 within one beat the runner is not busy (its own beat says busy 0), a sync push
//       of its lands, and the next errand addressed to it runs there;
//   RULE the dead turn is never run again: not on the phone, not on the runner (after its
//       reload), and not on a second, idle desktop C beside them.
// On dbb39bd3 the throw wedges the runner: the tile keeps "sent to your other device".
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs. FAULT_ONLY=T|N|D runs one case.
// Red at 64c6ef52 by design of the check (check_f234.md): see the commit that adds this.

import { open, signInAs, newChat, connectMock, checker, steerDiamond } from './harness.mjs';
import { settle, until, nominateRunner, ROUTED_SW } from './handoffpair.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { guardRan } from './verdict.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const GW_DIR    = new URL('../gateway', import.meta.url).pathname;
const ANSWER_MS = 60000;	// a handed-off answer reaches the phone within this
const RELOAD_MS = 10000;	// a poisoned page reloads itself within this of the poison
const FAULT_MS  = 120000;	// the phone reads the interruption within this of the fault
const BEAT_MS   = 50000;	// one presence beat (45 s) and a margin
const PAST_DEADLINE = 16 * 60 * 1000;	// case N: the runner's relay clock is moved this far, past the 15 min deadline

const { ok, bad, check } = checker();
const tag = Date.now().toString(36).slice(-6);
const ACCT = 'hfx' + tag;
const ONLY = process.env.FAULT_ONLY || '';

// ── what a person sees ──────────────────────────────────────────────────────────────

const switchOn = (pg) => pg.evaluate(() => {
	const r = document.getElementById('seat-runner');
	if (r && r.getClientRects().length && r.getAttribute('aria-pressed') === 'true') return 'runner';
	return '';
}).catch(() => '');

/// The hand-off tile's footer as drawn: its words and whether a Retry is offered.
const tileState = (pg) => pg.evaluate(() => {
	const out = document.getElementById('chat-output');
	if (!out) return { text: '', retry: false, sent: false };
	const rts = Array.from(out.querySelectorAll('.ti-continue')).filter((b) => b.getClientRects().length);
	return { text: out.innerText.replace(/\s+/g, ' ').slice(-600), retry: rts.length > 0,
		sent: /sent to your other/i.test(out.innerText) };
}).catch(() => ({ text: '', retry: false, sent: false }));

async function sendPhone(pg, text) {
	await pg.setViewportSize({ width: 420, height: 860 });
	await pg.waitForTimeout(300);
	await pg.fill('#chat-input', text);
	await pg.click('#chat-send');
}

// ── what each device did ────────────────────────────────────────────────────────────

/// Every model request a page sends, every sync push it landed, and every load.
function watchWire(s) {
	s.model = []; s.pushes = []; s.loads = []; s.errors = [];
	s.page.on('request', (req) => {
		if (/\/chat\/completions/.test(req.url())) s.model.push({ at: Date.now(), raw: req.postData() || '' });
	});
	s.page.on('response', (r) => {
		const q = r.request();
		if (/\/api\/sync/.test(r.url()) && q.method() !== 'GET' && r.status() < 300) s.pushes.push(Date.now());
	});
	s.page.on('load', () => s.loads.push(Date.now()));
	s.page.on('pageerror', (e) => s.errors.push({ at: Date.now(), msg: String(e && e.message || e).slice(0, 160) }));
}
const modelCarrying = (s, words) => s.model.filter((r) => r.raw.includes(words));

async function gateUp(s) {
	await s.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 90000 }).catch(() => {});
}
const authed = (pg) => pg.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
	&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 30000 }).catch(() => {});

async function joinDesk(a, mate, phone = false) {
	const s = await open({ name: mate, signIn: false, connect: false, serviceWorkers: ROUTED_SW, browser: 'chromium',
		...(phone ? { touch: true, ua: IPHONE } : {}) });
	s.account = ACCT; s.name = mate;
	watchWire(s);
	await s.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await s.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(s);
	await signInAs(s, ACCT);
	await authed(s.page);
	await s.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true));
	await makePagePro(s.page, GW_DIR, GW_URL);
	await connectMock(s);
	await s.page.setViewportSize(phone ? { width: 420, height: 860 } : { width: 1280, height: 900 });
	await s.page.waitForTimeout(2000);
	await settle(s.page);
	await until(s.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } }, null, 10000);
	await s.page.evaluate((n) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n), mate);
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	return s;
}

/// Create a Diamond through its real dialog and answer its id (verify_daimon_handoff's makeDiamond).
async function makeDiamond(pg, name) {
	await pg.evaluate(() => document.getElementById('new-diamond-btn').click());
	await pg.waitForSelector('.dlg-card', { timeout: 8000 });
	await pg.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	for (let i = 0; i < 30; i++) {
		const id = await pg.evaluate(() => { const c = window.DaimondDiamond.current(); return c ? c.id : ''; });
		if (id) return id;
		await pg.waitForTimeout(300);
	}
	return '';
}

/// Case D's dispatcher: a Chromium phone (A is WebKit, whose WPE build has no OPFS and so
/// cannot hold a Diamond), joined to the account, with B nominated and a Diamond made here
/// and synced to B, as verify_daimon_handoff seeds it.
async function joinDaimonPhone(a, b, idB) {
	const NAME_P = 'hfxdia' + tag;
	const p = await joinDesk(a, NAME_P, true);
	p.touch = true;
	await p.page.evaluate((id) => window.DaimondCore.roster.nominate(id), idB);
	await p.page.waitForSelector('#new-diamond-btn', { state: 'attached', timeout: 10000 }).catch(() => {});
	const diaId = await makeDiamond(p.page, 'FaultDia' + tag);
	check('D-setup a Diamond is made on the daimon phone P', !!diaId, 'id=' + diaId);
	await settle(p.page);
	await p.page.evaluate(() => window.DaimondSync && window.DaimondSync.push && window.DaimondSync.push());
	await p.page.waitForTimeout(600);
	await b.page.evaluate(() => window.DaimondSync && window.DaimondSync.pull && window.DaimondSync.pull(true));
	const onB = await until(b.page, (did) => { try { return !!window.DaimondDiamond.conversation(did); } catch (e) { return false; } }, diaId, 30000);
	check('D-setup the Diamond synced to the runner B', onB, 'id=' + diaId);
	// P routes to B only once its own election reads B genuine (a beat AND a fresh serviced_at);
	// a fresh page's first snapshot often carries B's beat without it (run fault_g1_d1: D0 ran
	// on P). So refresh B's beat and P's presence until it does, as verify_daimon_handoff's
	// `rerefresh`, with P's step-away posture on as that verifier arms it. B's beat carries what
	// presenceTick sends -- a bare `beatPresence(id, name)` says servicing:false, which the
	// gateway stores as `serviced_at: 0` and so marks B stale.
	await p.page.evaluate(() => { try { localStorage.setItem('daimond-handoff-when-away', '1'); } catch (e) {} });
	const pSeesB = () => p.page.evaluate((id) => {
		try {
			const rec = window.DaimondPresence.snapshot()[id];
			return !!(rec && window.DaimondPeer.recGenuine(rec, Date.now(), window.DaimondPeer.DISPATCH_FRESH_MS));
		} catch (e) { return false; }
	}, idB).catch(() => false);
	let genuine = false, bSvc = null;
	for (let i = 0; i < 60 && !genuine; i++) {
		bSvc = await b.page.evaluate((n) => {
			let svc = false, run = false;
			try { svc = !!window.DaimondPost.servicing(window.DaimondPeer.DISPATCH_FRESH_MS); } catch (e) {}
			try { run = !!window.DaimondRunner.on(); } catch (e) {}
			window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n, true, svc, run, false);
			return svc;
		}, b.name).catch(() => null);
		await p.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await p.page.waitForTimeout(1000);
		genuine = await pSeesB();
	}
	const posture = await p.page.evaluate(() => { try { return localStorage.getItem('daimond-handoff-when-away'); } catch (e) { return null; } });
	check('D-setup P\'s election reads the nominee B genuine (dispatch=YES), posture on', genuine && posture === '1',
		'genuine=' + genuine + ' posture=' + posture + ' B servicing=' + bSvc);
	return { p, diaId };
}

async function untilScreen(a, pred, ms, step = 1000) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await pred(); } catch (e) { v = false; }
		if (v || Date.now() - t0 > ms) return v;
		await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await a.page.waitForTimeout(step);
	}
}

/// The runner's own view of itself: engine busy, its beat's busy depth, the runner armed.
const runnerState = (b) => b.page.evaluate(() => {
	const r = { core: null, beat: null, armed: null, poisoned: null };
	try { r.core = !!window.DaimondCore.busy(); } catch (e) { /* not booted */ }
	try { const me = window.DaimondPresence.snapshot()[window.DaimondIdentity.deviceId()]; r.beat = me ? me.busy : null; } catch (e) {}
	try { r.armed = !!window.DaimondRunner.on(); } catch (e) {}
	return r;
}).catch(() => ({ core: null, beat: null, armed: null }));

/// Stub the runner's web driver: the fault the case seeds. Re-armed after any reload.
const seedFault = (b, kind) => b.page.evaluate((k) => {
	window.__opens = 0;
	window.DaimondWeb.open = function () {
		window.__opens++;
		if (k === 'T') throw new Error('UNBLOCK-7 seed: DaimondWeb.open threw');
		return new Promise(function () { /* never settles */ });
	};
	// What reached the page's own last-resort listeners, kept across a reload.
	const note = (ev, x) => {
		try {
			const l = JSON.parse(sessionStorage.getItem('__faultSeen') || '[]');
			l.push({ ev, rt: !!(x && typeof WebAssembly !== 'undefined' && x instanceof WebAssembly.RuntimeError),
				msg: String((x && x.message) || x).slice(0, 120) });
			sessionStorage.setItem('__faultSeen', JSON.stringify(l));
		} catch (e) { /* storage refused */ }
	};
	window.addEventListener('error', (e) => note('error', e.error || e.message));
	window.addEventListener('unhandledrejection', (e) => note('rejection', e.reason));
	// What the page did on its way out, for a reload that never came.
	const trace = (what) => {
		try {
			const l = JSON.parse(sessionStorage.getItem('__leave') || '[]');
			l.push(Date.now() % 1000000 + ' ' + what); sessionStorage.setItem('__leave', JSON.stringify(l.slice(-30)));
		} catch (e) { /* storage refused */ }
	};
	if (!window.__leaveWatch) {
		window.__leaveWatch = 1;
		window.addEventListener('beforeunload', (e) => trace('beforeunload prevented=' + e.defaultPrevented));
		window.addEventListener('pagehide', (e) => trace('pagehide persisted=' + e.persisted));
	}
	// When this page's engine was poisoned, kept across the reload the poison makes.
	// The poison's own diag row, newer than this seed, dated by the ring (a count of rows
	// cannot tell: the ring is capped, and keeps an earlier case's rows until a reload).
	window.__seedAt = Date.now();
	if (!window.__poisonWatch) window.__poisonWatch = setInterval(() => {
		try {
			const r = DaimondDiag.rows().filter((x) => /POISONED/.test(x.tag) && x.ts >= window.__seedAt).pop();
			if (r && +sessionStorage.getItem('__poisonAt') !== r.ts) sessionStorage.setItem('__poisonAt', String(r.ts));
		} catch (e) { /* storage refused, or no ring */ }
	}, 200);
}, kind);

/// Move the relay's clock on the runner's own wire: every JSON answer of the gateway's
/// that carries the server's `now` reads `by` ms later. Returns the route to remove.
const API = (u) => /\/api\//.test(u.pathname);
async function shiftRelay(b, by) {
	const h = async (route) => {
		let r;
		try { r = await route.fetch(); } catch (e) { return route.continue().catch(() => {}); }
		let body = null;
		try { body = await r.json(); } catch (e) { body = null; }
		if (!body || typeof body.now !== 'number') return route.fulfill({ response: r });
		body.now += by;
		return route.fulfill({ response: r, json: body });
	};
	await b.page.route(API, h);
	return h;
}

const faultSeen = (b) => b.page.evaluate(() => {
	let l = []; try { l = JSON.parse(sessionStorage.getItem('__faultSeen') || '[]'); } catch (e) {}
	let d = []; try { d = (window.DaimondDiag ? DaimondDiag.rows() : []).filter((r) => /POISON|DEAD/i.test(r.tag)).map((r) => r.tag + ' ' + String(r.data || '').slice(0, 80)); } catch (e) {}
	let lv = []; try { lv = JSON.parse(sessionStorage.getItem('__leave') || '[]'); } catch (e) {}
	// The poison's time: the watcher's note (it outlives the reload), or the ring's own row
	// when the poison fell inside the watcher's poll.
	let pa = +sessionStorage.getItem('__poisonAt') || 0;
	try { const r = DaimondDiag.rows().filter((x) => /POISONED/.test(x.tag) && x.ts >= (window.__seedAt || 0)).pop(); if (r) pa = Math.max(pa, r.ts); } catch (e) {}
	return { seen: l, diag: d, leave: lv, poisonAt: pa };
}).catch(() => ({ seen: [], diag: [], poisonAt: 0 }));

async function dumpDiag(s, what) {
	const rows = await s.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : [])
		.filter((r) => /dispatch|hand|collect|errand|lease|POISON|DEAD|report/i.test(r.tag)).slice(-14)).catch(() => []);
	for (const r of rows) console.log('  ..    diag ' + what + ': ' + r.tag + ' ' + String(r.data || '').slice(0, 200));
}

let a, b, c, p = null, diaId = '';
try {
	a = await open({ name: ACCT, browser: 'webkit', touch: true, ua: IPHONE, signIn: false, connect: false,
		serviceWorkers: ROUTED_SW });
	a.account = ACCT; a.name = ACCT; a.touch = true;
	watchWire(a);
	await gateUp(a);
	await signInAs(a, ACCT);
	await authed(a.page);
	await a.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true));
	const pro = await makePagePro(a.page, GW_DIR, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await a.page.setViewportSize({ width: 1280, height: 900 });
	await newChat(a);
	const SEED = 'SEED' + tag + ' ready';
	await sendPhone(a.page, '@text ' + SEED);
	await until(a.page, (w) => document.getElementById('chat-output').innerText.split(w).length > 2, SEED, 30000);
	await settle(a.page);

	const NAME_B = 'hfxrun' + tag;
	b = await joinDesk(a, NAME_B);
	const idB = await nominateRunner(check, a, b, NAME_B);
	const label = await a.page.evaluate((id) => {
		try { return (window.DaimondPresence.snapshot()[id] || {}).name || ''; } catch (e) { return ''; }
	}, idB);
	console.log('  ..    runner B is ' + JSON.stringify(label || NAME_B));
	// C: a second desktop, awake and idle, never nominated. It must never take the dead turn.
	c = await joinDesk(a, 'hfxidle' + tag);

	for (const kind of ['T', 'N', 'D']) {
		if (ONLY && ONLY !== kind) continue;
		const what = kind === 'T' ? 'throws' : 'never settles';
		console.log('\n— case ' + kind + ': the runner\'s DaimondWeb.open ' + what + ' mid-turn'
			+ (kind === 'D' ? ', on a daimon turn' : '') + ' —');
		// The dispatcher: A, or for the daimon case P, a Chromium phone that can hold a Diamond.
		if (kind === 'D' && !p) ({ p, diaId } = await joinDaimonPhone(a, b, idB));
		const s = kind === 'D' ? p : a;
		const hang = kind !== 'T';		// N and D: the call never settles, the deadline ends the run
		// A daimon is steered in its Diamond's chat face; a chat from the phone's composer.
		const send = (text) => kind === 'D' ? steerDiamond(p, text) : sendPhone(s.page, text);
		if (kind !== 'D') {
			await s.page.setViewportSize({ width: 1280, height: 900 });	// the rail's New Chat is drawn at a desk's width
			await newChat(a);
			await s.page.setViewportSize({ width: 420, height: 860 });
		}
		// A daimon is handed off by the nomination alone (it has no seat switch of its own).
		const onRunner = kind === 'D' || await untilScreen(s, async () => (await switchOn(s.page)) === 'runner', 30000);
		await seedFault(b, kind);
		const loads0 = b.loads.length;
		const diag0 = (await faultSeen(b)).diag.length;	// B's POISON/DEAD rows before this case
		const url = 'https://example.com/fault-' + kind.toLowerCase() + tag;
		await send('@tool web_open ' + JSON.stringify({ url }));
		const opened = await until(b.page, () => (window.__opens || 0) > 0, null, ANSWER_MS);
		const ranOnB = modelCarrying(b, url).length, ranOnA = modelCarrying(s, url).length;
		check(kind + '0 the turn runs on the runner and reaches its web_open',
			onRunner && opened && ranOnB >= 1 && ranOnA === 0,
			'switch on runner ' + onRunner + ', open called ' + opened + ', model requests B ' + ranOnB + ' / A ' + ranOnA);
		const tFault = Date.now();
		const ranB0 = modelCarrying(b, url).length;
		let shifted = null;
		if (hang) {
			// Nothing traps: only the errand's own deadline ends the run. The relay's clock
			// is moved past it on B's wire, and B re-reads it at once.
			await b.page.waitForTimeout(3000);
			shifted = await shiftRelay(b, PAST_DEADLINE);
			await b.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		}

		// I4 + I9: the phone reads Interrupted, names the runner as the phone names it, and offers Retry.
		const trueName = await s.page.evaluate((id) => { try { return window.DaimondPresence.name(id) || ''; } catch (e) { return ''; } }, idB);
		const want = 'Interrupted on ' + (trueName || label || NAME_B);
		let firstInt = 0;
		// F1: a caught throw is a failed tool and a finished turn, never an Interrupted one.
		const caught = (st) => !st.sent && /web_open · failed/.test(st.text) && !/Interrupted/.test(st.text);
		const shown = await untilScreen(s, async () => {
			const st = await tileState(s.page);
			if (kind === 'T') { if (!firstInt && caught(st)) firstInt = Date.now(); return caught(st); }
			if (!firstInt && st.retry && /Interrupted/.test(st.text)) firstInt = Date.now();
			return st.retry && st.text.includes(want);
		}, FAULT_MS, 2000);
		const tShown = firstInt || Date.now();
		if (shifted) { await b.page.unroute(API, shifted).catch(() => {}); shifted = null; }
		await b.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		const st = await tileState(s.page);
		const seen = await faultSeen(b);
		console.log('  ..    B after the fault: reloads ' + (b.loads.length - loads0) + ', page errors '
			+ JSON.stringify(b.errors.filter((e) => e.at >= tFault - 60000).map((e) => e.msg))
			+ ', listeners heard ' + JSON.stringify(seen.seen) + ', diag ' + JSON.stringify(seen.diag));
		if (kind === 'T') {
			const newRows = seen.diag.slice(diag0).join(' | ');
			check('Ta (F1) the throw is caught: the tile shows web_open failed and the turn finished, not Interrupted',
				shown || caught(st),
				(firstInt ? 'first at ' + Math.round((firstInt - tFault) / 1000) + ' s' : 'not within ' + Math.round(FAULT_MS / 1000) + ' s')
				+ '; sent ' + st.sent + ', tail ' + JSON.stringify(st.text.slice(-160)));
			check('Tb (F1) the runner\'s engine is not poisoned by the throw, and its page does not reload',
				!/POISONED/.test(newRows) && b.loads.length === loads0,
				'reloads ' + (b.loads.length - loads0) + ', diag ' + JSON.stringify(newRows.slice(0, 200)));
		} else {
		check(kind + 'a (I4) the phone\'s tile reads Interrupted, with Retry',
			shown || (st.retry && /Interrupted/.test(st.text)),
			(firstInt ? 'first at ' + Math.round((firstInt - tFault) / 1000) + ' s' : 'not within ' + Math.round(FAULT_MS / 1000) + ' s') + '; retry ' + st.retry + ', placeholder "sent" ' + st.sent
			+ ', tail ' + JSON.stringify(st.text.slice(-160)));
		check(kind + 'b (I9) it names the runner by its true name', st.text.includes(want),
			'wants ' + JSON.stringify(want));
		}
		if (!shown) { await dumpDiag(s, 'A ' + kind); await dumpDiag(b, 'B ' + kind); }

		// I14: within one beat the runner is free, its push lands, and it takes the next errand.
		const pushes0 = b.pushes.filter((t) => t >= tFault).length;
		let rs = await runnerState(b);
		const freeAt = Date.now();
		const free = await (async () => {
			for (;;) {
				rs = await runnerState(b);
				if (rs.core === false && rs.beat === 0) return true;
				if (Date.now() - freeAt > BEAT_MS) return false;
				await b.page.waitForTimeout(1000);
			}
		})();
		// What ended the run on B, from its own decision log (rows new in this case).
		const ended = (await faultSeen(b)).diag.slice(diag0).join(' | ');
		if (hang) check(kind + '-dead the run ended at the errand\'s deadline, not by a trap',
			/why=deadline/.test(ended), 'B: ' + JSON.stringify(ended));
		check(kind + 'c (I14) within one beat the runner is not busy: engine idle, its beat busy 0',
			free, 'state ' + JSON.stringify(rs) + ' after ' + Math.round((Date.now() - tShown) / 1000) + ' s');
		const pushed = await (async () => {
			for (let i = 0; i < BEAT_MS / 1000; i++) {
				if (b.pushes.filter((t) => t >= tFault).length > 0) return true;
				await b.page.waitForTimeout(1000);
			}
			return false;
		})();
		check(kind + 'd (I14) a sync push of the runner\'s lands after the fault', pushed,
			'pushes since the fault ' + b.pushes.filter((t) => t >= tFault).length + ' (at the tile ' + pushes0 + ')');

		// A run of the dead turn is a model request carrying its url that is not a later
		// turn's: the next turn in this chat carries the dead one as its history.
		const NEXT = 'NEXT' + kind + tag + ' after the fault';
		const runsOf = (s) => s.model.filter((r) => r.raw.includes(url) && !r.raw.includes(NEXT)).length;
		const rerun = () => ({ A: runsOf(a) + (p ? runsOf(p) : 0), B: runsOf(b) - ranB0, C: runsOf(c) });
		const rr1 = rerun();
		check(kind + 'f (RULE) the dead turn is not run again, here, on the runner or on C',
			rr1.A === 0 && rr1.B === 0 && rr1.C === 0, 'model requests for it since the fault ' + JSON.stringify(rr1));

		// The poison, wherever it fell in the case, is seen through before the next errand.
		let seen2 = await faultSeen(b);
		// A hung case's poison comes ENGINE_HUNG_MS (5 s) after the DEAD row, which the checks
		// above can beat by seconds (run fault_u7_n2: read at DEAD + 2 s). Wait for it, 15 s at most.
		for (const t1 = Date.now(); hang && seen2.poisonAt < tFault && Date.now() - t1 < 15000; seen2 = await faultSeen(b))
			await b.page.waitForTimeout(250).catch(() => {});
		const poisonAt = seen2.poisonAt;
		const poisoned = /POISONED/.test(ended) || poisonAt >= tFault;
		if (hang) {
			// check_final G1: with export_session no longer panicking on the held session, what
			// ends the hung engine is fix 3's poison -- the killed call still unsettled 5 s on.
			const rows = seen2.diag.slice(diag0).join(' | ');
			check(kind + 'p (G1) the hung engine is poisoned by the 5 s hung check, not a stray panic',
				/POISONED hung: /.test(rows) && !/panic/i.test(rows), 'B: ' + JSON.stringify(rows.slice(0, 240)));
			if (!/POISONED hung: /.test(rows)) {
				const tail = await b.page.evaluate((t) => (window.DaimondDiag ? DaimondDiag.rows() : [])
					.filter((r) => r.ts >= t && !/presence|beat|sync pull|park/i.test(r.tag)).slice(-24)
					.map((r) => ((r.ts - t) / 1000).toFixed(1) + 's ' + r.tag + ' ' + String(r.data || '').slice(0, 140)), tFault).catch(() => []);
				for (const r of tail) console.log('  ..    B diag: ' + r);
			}
		}
		// Unconditional for a hung case: it must poison, so a missing reload is a failure, never a skip.
		if (poisoned || hang) {
			// A poisoned engine can run nothing more: the page reloads itself (POISON_RELOAD_MS)
			// within 10 s of the poison. Nothing here reloads it (check_f234 fix 4).
			const t0 = poisonAt || tFault;
			while (!b.loads.some((t) => t > t0) && Date.now() - t0 < RELOAD_MS) await b.page.waitForTimeout(250);
			const at = b.loads.find((t) => t > t0);
			check(kind + 'h (I14) the poisoned runner\'s page reloads by itself within 10 s of the poison', !!at && at - t0 <= RELOAD_MS,
				(at ? 'reloaded ' + ((at - t0) / 1000).toFixed(1) + ' s after' : 'no reload ' + Math.round((Date.now() - t0) / 1000) + ' s after')
				+ (poisonAt ? ' the poison' : ' the fault (poison time unseen)') + '; B: ' + JSON.stringify(ended.slice(0, 160)));
			if (at) { await gateUp(b); await authed(b.page); }
			else console.log('  ..    B on its way out: ' + JSON.stringify((await faultSeen(b)).leave) + ' now ' + Date.now() % 1000000 + ' poisonAt ' + poisonAt % 1000000);
		}
		const onRunner2 = kind === 'D' || await untilScreen(s, async () => (await switchOn(s.page)) === 'runner', 60000);
		await send('@text ' + NEXT);
		const done = await until(s.page, (w) => {
			const out = document.getElementById('chat-output');
			if (!out) return false;
			return out.innerText.split(w).length > 2;
		}, NEXT, ANSWER_MS);
		const nB = modelCarrying(b, NEXT).length, nA = modelCarrying(s, NEXT).length;
		check(kind + 'e (I14) the next errand addressed to the runner runs there and is drawn on the phone',
			onRunner2 && done && nB >= 1 && nA === 0,
			'switch on runner ' + onRunner2 + ', drawn ' + done + ', model requests B ' + nB + ' / A ' + nA);
		if (!(done && nB >= 1 && nA === 0)) {
			const scr = await s.page.evaluate(() => ((document.getElementById('chat-output') || {}).innerText || '').replace(/\s+/g, ' ').slice(-500)).catch(() => '');
			console.log('  ..    A screen: ' + JSON.stringify(scr));
			await dumpDiag(s, 'A next ' + kind); await dumpDiag(b, 'B next ' + kind);
		}
		await settle(s.page);
		const rr2 = rerun();
		check(kind + 'g (RULE) still not run again at the end of the case',
			rr2.A === 0 && rr2.B === 0 && rr2.C === 0, 'model requests for it since the fault ' + JSON.stringify(rr2)
			+ ' over ' + Math.round((Date.now() - tFault) / 1000) + ' s');
	}

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	for (const s of [a, b, c, p]) { try { await s?.close(); } catch (e) { /* closing */ } }
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
