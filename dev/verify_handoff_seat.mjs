// gateway: live
// verify_handoff_seat.mjs — the person chooses where the next turn runs: "Here | <runner>"
// (owner, D-20261009-23).
//
// WHAT WAS WRONG. A read-only line under the composer ("Next turn: argonaut") said where
// the next turn would go, the person could not change it, a healthy hand-off still drew
// "Take back", and on 9 Oct the line named argonaut while gilgamesh ran the turn.
//
// THE PROPERTIES, on two real paired devices (A sends at a phone's width, B is the
// nominated runner):
//
//   (1) THE SWITCH SHOWS AND SETS. By A's input box, where the old line sat, it reads
//       "Here | <B>" with B pressed; the line is gone and the top bar holds no switch
//       (owner, 2026-10-11: "down near the input box where the users eyes are").
//   (2) HERE NEVER HANDS OFF. With Here pressed a turn runs on A: no dispatched
//       placeholder, B never claims it; the choice is sticky for the chat.
//   (3) THE LABEL IS THE DEVICE THAT RAN IT. With B pressed the turn is handed to B,
//       the lease holder is the device the switch named, and the tile names it.
//   (4) NO TAKE BACK, ANYWHERE. Nothing on A's tile offers a control while B takes
//       and runs the turn, no state of the table offers one, and the app no longer
//       carries the words; "Run here" is drawn only on failure.
//   (5) NO RUNNER, ONLY HERE. When B is no longer reachable the switch is plain "Here";
//       a turn sent after B dropped (B still pressed) runs Here, and the tile says so
//       in one line.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_seat.mjs                 (A WebKit, the iPhone's engine)
//   SEAT_A=chromium node dev/verify_handoff_seat.mjs (A Chromium)

import {
	checker,
	pair,
	until,
	storedMsgs,
	placeholders,
	modelSaw,
	send,
	freshChat,
	untilListening
} from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const SEAT_A    = (process.env.SEAT_A || 'webkit').toLowerCase();
const CLAIM_MS  = 30000;		// B claims a handed turn this soon
const ANSWER_MS = 30000;		// an answer reaches A's store this soon
const BEAT_MS   = 15000;		// the switch redraws within this
const { ok, bad, check } = checker();

/// The switch as A draws it: visibility, the segments' words, which is pressed, and B's id.
const seatView = (a) => a.page.evaluate(() => {
	const box = document.getElementById('seat-switch');
	const line = document.getElementById('seat-line');
	const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none'
		&& el.getBoundingClientRect().width > 0;
	const here = document.getElementById('seat-here');
	const run  = document.getElementById('seat-runner');
	const head = document.querySelector('#panel-ai .chead');
	const bar  = document.querySelector('#panel-ai .chat-input-bar');
	// By the input box: the switch follows the composer's row, inside the AI panel.
	const near = !!(box && bar && vis(box) && (() => {
		const r = box.getBoundingClientRect(), q = bar.getBoundingClientRect();
		return Math.abs(r.top - q.bottom) < 48 || Math.abs(q.top - r.bottom) < 48;
	})());
	return {
		shown:      vis(box),
		inTop:      !!(box && head && head.contains(box)),
		near:       near,
		lineGone:   !line || !vis(line),
		here:       here ? here.textContent.trim() : '',
		herePress:  here ? here.getAttribute('aria-pressed') : '',
		runShown:   vis(run),
		run:        run ? run.textContent.trim() : '',
		runPress:   run ? run.getAttribute('aria-pressed') : '',
		runDevice:  run ? (run.dataset.device || '') : '',
	};
}).catch((e) => ({ err: String(e) }));

/// Does A hold a non-empty answer after the user message `prompt`?
const answered = (a, prompt) => a.page.evaluate(async (p) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		const ms = (got && got.messages) || [];
		const at = ms.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(p));
		if (at < 0) continue;
		return ms.slice(at + 1).some((m) => m && m.role === 'assistant' && !m.interrupted
			&& String(m.content || '').trim());
	}
	return false;
}, prompt).catch(() => false);

const waitAnswer = async (a, prompt, ms = ANSWER_MS) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
		if (await answered(a, prompt)) return true;
		await a.page.waitForTimeout(400);
	}
	return false;
};

/// Every turn B has claimed, as `{ turn, by }` (the diag row names the turn id, never
/// the prompt, so a claim is matched on the placeholder's turn id).
const bClaims = (b) => b.page.evaluate(() => {
	try {
		return window.DaimondDiag.rows().filter((r) => r.tag === 'collect CLAIMED').map((r) => {
			const d = String(r.data || '');
			const t = /turn=(\S+)/.exec(d), by = /by (\S+)/.exec(d);
			return { turn: t ? t[1] : '', by: by ? by[1] : '' };
		});
	} catch (e) { return []; }
}).catch(() => []);

/// Press a segment of the switch as a finger would, and say what stood in the way if
/// the press could not land.
const press = async (a, sel) => {
	try { await a.page.click(sel, { timeout: 4000 }); return ''; }
	catch (e) {
		const top = await a.page.evaluate((s) => {
			const el = document.querySelector(s); if (!el) return 'no ' + s;
			const r = el.getBoundingClientRect();
			const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return JSON.stringify({ r: [r.left, r.top, r.width, r.height], at: at ? (at.id || at.className || at.tagName) : null });
		}, sel).catch((x) => String(x));
		return String(e && e.message || e).split('\n')[0].slice(0, 160) + ' ' + top;
	}
};

/// Every control a dispatched tile on A offers right now, by its words.
const tileControls = (a) => a.page.evaluate(() => Array.from(document.querySelectorAll('.ti-continue'))
	.filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.textContent.trim())).catch(() => []);

let a, b;
try {
	// Two engines (owner rule, two-device features): A is the phone, WebKit by default
	// (SEAT_A=chromium for the other arm); B is the Chromium desktop runner.
	({ a, b } = await pair(check, 'seatlead', 'seatmate', { openA: { browser: SEAT_A } }));
	const uaA = await a.page.evaluate(() => navigator.userAgent);
	const uaB = await b.page.evaluate(() => navigator.userAgent);
	const isWk = (ua) => /WebKit/.test(ua) && !/Chrome\//.test(ua);
	check('A runs ' + SEAT_A + ', B runs chromium', (SEAT_A === 'webkit' ? isWk(uaA) : /Chrome\//.test(uaA))
		&& /Chrome\//.test(uaB), uaA.slice(0, 60) + ' | ' + uaB.slice(0, 60));
	for (const s of [a, b]) {
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'seat'); } catch (e) { /* none */ } });
	}
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	for (const s of [a, b]) await s.page.evaluate((id) => window.DaimondCore.roster.nominate(id), idB);
	await untilListening(a, b, idB, 120000, 'seatmate');
	const tag = Math.random().toString(36).slice(2, 8);
	await freshChat(a);

	// ── (1) The switch shows and sets ──────────────────────────
	console.log('\n(1) the switch shows "Here | <runner>" by the input box');
	await a.page.setViewportSize({ width: 420, height: 860 });
	let v = null;
	for (const t0 = Date.now(); Date.now() - t0 < BEAT_MS; ) {
		v = await seatView(a);
		if (v.shown && v.runShown) break;
		await a.page.evaluate(() => window.dispatchEvent(new Event('daimond:presence'))).catch(() => {});
		await a.page.waitForTimeout(500);
	}
	check('(1) the switch is drawn', !!(v && v.shown), JSON.stringify(v));
	check('(1) it sits by the input box', !!(v && v.near && !v.inTop), JSON.stringify(v));
	check('(1) the line under the composer is gone', !!(v && v.lineGone));
	check('(1) it reads Here | <runner>', !!(v && v.here && v.runShown && v.run), JSON.stringify(v));
	check('(1) the runner segment is B', !!(v && v.runDevice === idB), v && v.runDevice);
	check('(1) B is pressed by default', !!(v && v.runPress === 'true' && v.herePress === 'false'));
	const pressHere = await press(a, '#seat-here');
	v = await seatView(a);
	check('(1) pressing Here sets Here', !!(v && v.herePress === 'true' && v.runPress === 'false'), pressHere + ' ' + JSON.stringify(v));

	// ── (2) Here never hands off ───────────────────────────────
	console.log('\n(2) a turn sent with Here pressed runs here');
	const pHere = 'seat here turn ' + tag;
	const claims0 = (await bClaims(b)).length;
	await send(a.page, pHere);
	const gotHere = await waitAnswer(a, pHere);
	check('(2) the Here turn was answered', gotHere);
	const phHere = placeholders(await storedMsgs(a)).filter((m) => String(m.itext || '').includes(pHere));
	check('(2) it was never handed off', phHere.length === 0, phHere.length + ' placeholder(s)');
	check('(2) B never claimed it', (await bClaims(b)).length === claims0);
	check('(2) it reached the model once', modelSaw(pHere) === 1, 'seen ' + modelSaw(pHere));
	await a.page.evaluate(() => window.dispatchEvent(new Event('daimond:view'))).catch(() => {});
	v = await seatView(a);
	check('(2) Here stays pressed for this chat', !!(v && v.herePress === 'true'), JSON.stringify(v));

	// ── (3)+(4) The runner runs it; no Take back ───────────────
	console.log('\n(3) a turn sent with B pressed is handed to B, and nothing offers to take it back');
	const pressRun = await press(a, '#seat-runner');
	v = await seatView(a);
	check('(3) pressing B sets B', !!(v && v.runPress === 'true' && v.herePress === 'false'), pressRun + ' ' + JSON.stringify(v));
	const named = v ? v.runDevice : '';
	const pRun = 'seat runner turn ' + tag;
	await send(a.page, pRun);
	const seenCtl = new Set();
	let ph = null, claim = null;
	const t3 = Date.now();
	while (Date.now() - t3 < CLAIM_MS + ANSWER_MS) {
		for (const c of await tileControls(a)) seenCtl.add(c);
		if (!ph) ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(pRun)) || null;
		if (ph && !claim) claim = (await bClaims(b)).find((c) => c.turn === String(ph.iturn)) || null;
		if (claim && await answered(a, pRun)) break;
		await a.page.waitForTimeout(200);
	}
	const tid = ph ? String(ph.iturn) : '';
	check('(3) A handed the turn off', !!tid);
	check('(3) B claimed it', !!claim, claim ? JSON.stringify(claim) : 'no claim of ' + tid);
	// The lease is released when the turn ends, so the device that ran it is read off
	// the claim B wrote, which names its own id.
	const holder = claim ? claim.by : '';
	check('(3) the device that ran it is the one the switch named', !!named && !!holder && named.startsWith(holder),
		'named ' + named.slice(0, 8) + ' ran ' + holder.slice(0, 8));
	check('(3) the answer reached A', await answered(a, pRun));
	check('(4) no control was drawn on the healthy hand-off', seenCtl.size === 0, JSON.stringify([...seenCtl]));
	const table = await a.page.evaluate(() => ['dispatched', 'claimed', 'running', 'failed', 'no-peer-awake']
		.map((s) => window.DaimondPeer.dispatchControl(s, { itext: 'x' })));
	check('(4) the table offers nothing before a claim', table[0] === '' && table[1] === '' && table[2] === '', JSON.stringify(table));
	check('(4) Run here is offered only on failure', table[3] === 'runhere' && table[4] === 'runhere', JSON.stringify(table));
	const tb = await a.page.evaluate(() => {
		const st = ['dispatched', 'claimed', 'running', 'awaiting-consent', 'blocked', 'failed', 'no-peer-awake', 'parked', 'done'];
		const any = st.some((s) => window.DaimondPeer.dispatchControl(s, { itext: 'x' }) === 'takeback');
		const I = window.DaimondI18n;
		const words = !!(I && I.has && (I.has('turn.peer_takeback') || I.has('turn.peer_takingback')));
		return { any, words, i18n: !!(I && I.has) };
	}).catch((e) => ({ err: String(e) }));
	check('(4) no state offers Take back, and the app has no such words', !!tb && tb.i18n && !tb.any && !tb.words, JSON.stringify(tb));

	// ── (5) No reachable runner: only Here ─────────────────────
	console.log('\n(5) B drops: the switch is plain Here, and a turn sent on B runs here and says so');
	// B drops AFTER the person pressed B: A's view of the fleet loses B, as a beat
	// gap past the freshness window would.
	v = await seatView(a);
	check('(5) B is still pressed before it drops', !!(v && v.runPress === 'true'));
	const shownName = v ? v.run : '';
	await a.page.evaluate((id) => {
		const P = window.DaimondPresence, snap = P.snapshot.bind(P);
		P.snapshot = function () { const m = Object.assign({}, snap() || {}); delete m[id]; return m; };
		if (window.DaimondSync) window.DaimondSync.refreshPresence = function () { return Promise.resolve(); };
	}, idB);
	const pDrop = 'seat dropped turn ' + tag;
	const claims1 = (await bClaims(b)).length;
	await send(a.page, pDrop);
	const gotDrop = await waitAnswer(a, pDrop);
	check('(5) the turn sent after B dropped was answered', gotDrop);
	const phDrop = placeholders(await storedMsgs(a)).filter((m) => String(m.itext || '').includes(pDrop));
	check('(5) it ran here, not handed anywhere', phDrop.length === 0 && (await bClaims(b)).length === claims1, phDrop.length + ' placeholder(s)');
	const note = await a.page.evaluate(() => Array.from(document.querySelectorAll('.seat-note'))
		.map((el) => el.textContent.trim()).filter(Boolean)).catch(() => []);
	// One name everywhere: the line names the runner by the words the switch showed.
	check('(5) the tile says it ran here, naming the runner as the switch did', !!shownName && note.length >= 1
		&& note.some((s) => s.includes(shownName)), 'switch ' + JSON.stringify(shownName) + ' tile ' + JSON.stringify(note));
	await a.page.evaluate(() => window.dispatchEvent(new Event('daimond:presence'))).catch(() => {});
	v = await seatView(a);
	check('(5) the switch is plain Here', !!(v && v.shown && !v.runShown && v.here), JSON.stringify(v));
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
