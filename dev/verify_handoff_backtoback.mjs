// verify_handoff_backtoback.mjs — a desktop that has run one hand-off collects the next.
//
// WHAT HAPPENED (re-check finding E-R4, 2026-09-23). A desktop ran the first turn a phone
// handed it, and then collected nothing more: its park count stopped, its cursor stuck,
// and a `DaimondPost.collect()` forced on it had not returned eight minutes later. The
// phone's second hand-off sat on the relay, and the phone's 95 s backstop handed it to
// the same desktop again before it would run it itself.
//
// THE CAUSE. The park wakes `round()`, which holds the `daimond-post-mailbox` Web Lock
// across `collect()`; `collect()` routed an errand through `takeRow -> absorb` to the
// runner and AWAITED the whole turn; and the runner's ack dep, at the end of that turn,
// called `DaimondPost.settle()` and `DaimondPost.ack()`, which each ask for the same lock.
// A Web Lock is not re-entrant, so the turn waited on the lock and the lock on the turn,
// for ever. See ~/usr/code/ai/claude/specs/daimond_er4_handoff_collect_20260923.md.
//
// THE PROPERTIES, each false of 48aa5913 and of 0c2b8096:
//
//   (1) THE MAILBOX IS FREE AFTER A RUN. Once B has run a hand-off, B holds no
//       `daimond-post-mailbox` lock and has none waiting.
//   (2) B'S LISTENER RUNS ON: it parks again after the run.
//   (3) A COLLECT FORCED ON B RETURNS, inside ten seconds.
//   (4) THE SECOND HAND-OFF, sent at once, is claimed by B inside thirty seconds --
//       well inside A's 95 s backstop, so it is B's collect that took it and not the
//       backstop running it on A -- and its answer reaches A;
//   (5) and each hand-off ran exactly once.
//   (6) A THIRD, to show the second left B free as well.
//   (7) R4b: A DESKTOP THAT DOES NOT COLLECT IS NOT HANDED THE SAME TURN AGAIN. B goes on
//       parking and reads as servicing, but never claims the fourth turn. With no nominee
//       the send advertises no device, and the backstop seeded what it had tried from
//       that advertisement alone, so at ~95 s it handed the turn straight back to B and
//       ran it on A only at the second backstop, ~190 s after the send. Now the elected
//       desktop is recorded as tried at the send: A runs it at the first backstop.
//
// Every lock request on B is tapped with the stack that made it, so a failure names the
// call holding the lock and the call waiting for it.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_backtoback.mjs

import {
	checker,
	pair,
	until,
	settle,
	storedMsgs,
	placeholders,
	answersFor,
	modelSaw,
	send,
	freshChat,
} from './handoffpair.mjs';

const CLAIM_MS   = 30000;		// B must claim a hand-off this soon; A's backstop fires at ~95 s
const ANSWER_MS  = 150000;		// long enough for the backstop to land it when B does not
const FREE_MS    = 15000;		// how long B's mailbox may stay busy after a run
// One whole park round: the gateway holds a park for 45 s (post.js PARK_MS), so a listener
// that parked again before its count was read shows the next park only after that one ends.
const PARK_ROUND_MS = 50000;
const COLLECT_MS = 10000;		// how long a forced collect may take
const LOCK       = 'daimond-post-mailbox';
const { ok, bad, check } = checker();

/// Tap every request this page makes for the mailbox lock: when it was asked for,
/// granted and let go, and the stack that asked. Installed on the prototype, which is
/// where `navigator.locks.request` resolves, so post.js is measured unchanged.
async function tapLocks(page) {
	await page.evaluate((name) => {
		if (window.__lockTap) return;
		const tap = window.__lockTap = [];
		const proto = window.LockManager && window.LockManager.prototype;
		if (!proto || !proto.request) return;
		const orig = proto.request;
		proto.request = function (n, opts, fn) {
			if (typeof opts === 'function') { fn = opts; opts = {}; }
			if (n !== name) return orig.call(this, n, opts, fn);
			const rec = {
				at: Date.now(), granted: 0, released: 0,
				stack: String(new Error().stack || '').split('\n').slice(2, 16)
					.map((s) => s.trim().replace(/\(?https?:\/\/[^/]+\/js\//, '(').replace(/\)$/, ''))
					.join(' < '),
			};
			tap.push(rec);
			return orig.call(this, n, opts, async function (lock) {
				rec.granted = Date.now();
				try { return await fn(lock); } finally { rec.released = Date.now(); }
			});
		};
	}, LOCK);
}

/// The mailbox lock as the browser reports it, and the tapped requests still open.
async function lockState(page) {
	return page.evaluate(async (name) => {
		const q = await navigator.locks.query();
		const now = Date.now();
		const open = (window.__lockTap || []).filter((r) => !r.released).map((r) => ({
			state: r.granted ? 'HELD ' + Math.round((now - r.granted) / 1000) + 's' : 'WAITING '
				+ Math.round((now - r.at) / 1000) + 's',
			by: r.stack,
		}));
		return {
			held:    (q.held || []).filter((l) => l.name === name).length,
			pending: (q.pending || []).filter((l) => l.name === name).length,
			open,
		};
	}, LOCK).catch((e) => ({ held: -1, pending: -1, open: [], err: String(e) }));
}

const parks = (page) => page.evaluate(() => {
	try { return window.DaimondPost.state().park.parks | 0; } catch (e) { return -1; }
}).catch(() => -1);

/// The rows of a page's decision log whose tag matches and which name the turn.
const diagRows = (page, tag, turnId) => page.evaluate(({ tag, turnId }) => {
	try {
		return window.DaimondDiag.rows().filter((r) => String(r.tag) === tag
			&& String(r.data).includes(turnId)).length;
	} catch (e) { return 0; }
}, { tag, turnId }).catch(() => 0);

let a, b;
const note7 = (s) => console.log('  ..    ' + s);

/// Hand one turn from A to B and time the two moments that matter: B's claim, read off
/// B's own decision log, and the answer reaching A's store.
async function handOff(n) {
	const prompt = 'back-to-back hand-off number ' + n + ' ' + Math.random().toString(36).slice(2, 8);
	await freshChat(a);
	const sent = Date.now();
	await send(a.page, prompt);
	let ph = null;
	for (let i = 0; i < 120 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => m.itext === prompt) || null;
		if (!ph) await a.page.waitForTimeout(250);
	}
	const tid = ph ? String(ph.iturn) : '';
	const posted = tid ? await until(a.page, (t) => {
		try { return window.DaimondDiag.rows().some((r) => r.tag === 'dispatch posted' && String(r.data).includes(t)); }
		catch (e) { return false; }
	}, tid, 15000) : false;
	let claimed = 0;
	while (tid && !claimed && Date.now() - sent < CLAIM_MS) {
		if (await diagRows(b.page, 'collect CLAIMED', tid)) claimed = Date.now() - sent;
		else await b.page.waitForTimeout(250);
	}
	let answered = 0;
	while (tid && !answered && Date.now() - sent < ANSWER_MS) {
		if (answersFor(await storedMsgs(a), tid).length) answered = Date.now() - sent;
		else await a.page.waitForTimeout(500);
	}
	return { prompt, tid, posted, claimed, answered };
}

try {
	({ a, b } = await pair(check, 'b2blead', 'b2bmate'));
	for (const s of [a, b]) {
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'back-to-back'); } catch (e) { /* none */ } });
	}
	await tapLocks(b.page);

	// ── The first hand-off ─────────────────────────────────────
	console.log('\n(0) A hands B its first turn');
	const h1 = await handOff(1);
	check('(0) A handed the first turn to B', h1.posted, 'turn ' + (h1.tid || '(no placeholder)'));
	check('(0) B claimed it', h1.claimed > 0, h1.claimed ? 'at +' + h1.claimed + 'ms' : 'no claim in ' + CLAIM_MS + 'ms');
	check('(0) and its answer reached A', h1.answered > 0, h1.answered ? 'at +' + h1.answered + 'ms' : 'none');
	const parksAfter1 = await parks(b.page);

	// ── (1) The mailbox is free once the run is over ───────────
	console.log('\n(1)-(3) B, once its run is over');
	let lk = await lockState(b.page);
	for (const t0 = Date.now(); (lk.held || lk.pending) && Date.now() - t0 < FREE_MS; ) {
		await b.page.waitForTimeout(500);
		lk = await lockState(b.page);
	}
	check('(1) B holds no mailbox lock and has none waiting', lk.held === 0 && lk.pending === 0,
		'held ' + lk.held + ', waiting ' + lk.pending + (lk.err ? ' (' + lk.err + ')' : ''));
	for (const o of lk.open) console.log('  ..    ' + o.state + ' by ' + o.by);

	// ── (2) The listener parks again ───────────────────────────
	const parked = await until(b.page, (was) => {
		try { return (window.DaimondPost.state().park.parks | 0) > was; } catch (e) { return false; }
	}, parksAfter1, PARK_ROUND_MS);
	check('(2) B parks again after the run', parked,
		'parks ' + parksAfter1 + ' -> ' + (await parks(b.page)));

	// ── (3) A forced collect returns ───────────────────────────
	const forced = await b.page.evaluate((ms) => Promise.race([
		window.DaimondPost.collect().then((r) => 'returned ' + JSON.stringify(r)),
		new Promise((r) => setTimeout(() => r('still waiting'), ms)),
	]), COLLECT_MS).catch((e) => 'threw ' + e);
	check('(3) a collect forced on B returns inside ' + (COLLECT_MS / 1000) + ' s', /^returned/.test(forced), forced);

	// ── (4) The second hand-off, at once ───────────────────────
	console.log('\n(4) A hands B a second turn straight away');
	const h2 = await handOff(2);
	check('(4) A handed the second turn to B', h2.posted, 'turn ' + (h2.tid || '(no placeholder)'));
	check('(4) B claimed the second hand-off inside ' + (CLAIM_MS / 1000) + ' s', h2.claimed > 0,
		h2.claimed ? 'at +' + h2.claimed + 'ms' : 'B never collected it; its collect log for the turn: '
		+ (await diagRows(b.page, 'collect errand', h2.tid)) + ' row(s)');
	check('(4) and its answer reached A', h2.answered > 0, h2.answered ? 'at +' + h2.answered + 'ms' : 'none');
	if (!h2.claimed) {
		const l2 = await lockState(b.page);
		for (const o of l2.open) console.log('  ..    B mailbox lock ' + o.state + ' by ' + o.by);
		// And what A did about it: its own decisions on the turn, the backstop's among them.
		const said = await a.page.evaluate((t) => {
			try {
				return window.DaimondDiag.rows().filter((r) => String(r.data).includes(t))
					.slice(-30).map((r) => new Date(r.ts || r.t || 0).toISOString().slice(11, 23)
						+ ' ' + r.tag + ' :: ' + String(r.data).slice(0, 160));
			} catch (e) { return ['(no diagnostics: ' + e + ')']; }
		}, h2.tid).catch(() => []);
		for (const line of said) console.log('  ..    A ' + line);
	}

	// ── (6) A third, only once the second went through ────────
	let h3 = null;
	if (h2.claimed) {
		console.log('\n(6) and a third');
		h3 = await handOff(3);
		check('(6) B claimed the third hand-off inside ' + (CLAIM_MS / 1000) + ' s', h3.claimed > 0,
			h3.claimed ? 'at +' + h3.claimed + 'ms' : 'no claim');
		check('(6) and its answer reached A', h3.answered > 0, h3.answered ? 'at +' + h3.answered + 'ms' : 'none');
	}

	// ── (5) Each ran once ──────────────────────────────────────
	await settle(a.page);
	await a.page.waitForTimeout(2000);
	for (const h of [h1, h2, h3].filter(Boolean)) {
		const n = modelSaw(h.prompt);
		check('(5) hand-off "' + h.prompt.slice(-12) + '" reached the model exactly once', n === 1, n + ' request(s)');
	}
	const last = await lockState(b.page);
	console.log('  ..    B at the end: parks ' + (await parks(b.page)) + ', mailbox lock held ' + last.held
		+ ', waiting ' + last.pending);

	// ── (7) R4b: B does not collect; the first backstop runs it here ──
	console.log('\n(7) B stops claiming: A\'s first backstop runs the turn itself, not back on B');
	// B's listener is left running -- it parks, collects and reads as servicing, as a
	// desktop's did whose collect had stalled -- but its runner is held at the door for
	// this one prompt, so the turn is never claimed there.
	const P7 = 'backstop probe ' + Math.random().toString(36).slice(2, 8);
	await b.page.evaluate((marker) => {
		const P = window.DaimondPeer, run = P.runErrand;
		P.runErrand = function (e) {
			if (e && String(e.prompt || '').indexOf(marker) !== -1) return new Promise(() => {});
			return run.apply(this, arguments);
		};
	}, P7);
	const seen7 = modelSaw(P7);
	await freshChat(a);
	const sent7 = Date.now();
	await send(a.page, P7);
	let ph7 = null;
	for (let i = 0; i < 120 && !ph7; i++) {
		ph7 = placeholders(await storedMsgs(a)).find((m) => m.itext === P7) || null;
		if (!ph7) await a.page.waitForTimeout(250);
	}
	const tid7 = ph7 ? String(ph7.iturn) : '';
	note7('turn ' + (tid7 || '(no placeholder)') + ', tried at the send: ' + JSON.stringify((ph7 && ph7.triedDevices) || []));
	// Past the first backstop (~95 s) and well short of the second (~190 s).
	const R4B_MS = 130000;
	let ranAt = 0;
	while (tid7 && !ranAt && Date.now() - sent7 < R4B_MS) {
		if (await diagRows(a.page, 'collect CLAIMED', tid7)) ranAt = Date.now() - sent7;
		else await a.page.waitForTimeout(1000);
	}
	const retried = tid7 ? await diagRows(a.page, 'dispatch retry', tid7) : -1;
	check('(7) the first backstop did not hand the turn back to B, which had not claimed it', retried === 0,
		retried + ' re-hand(s) of it by A');
	check('(7) A ran it itself at the first backstop, not the second', ranAt > 0 && ranAt < 150000,
		ranAt ? 'claimed on A at +' + ranAt + 'ms' : 'not run on A inside ' + (R4B_MS / 1000) + ' s of the send');
	await a.page.waitForTimeout(3000);
	check('(7) and it reached the model exactly once', modelSaw(P7) - seen7 === 1, (modelSaw(P7) - seen7) + ' request(s)');

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}
process.exit(bad.length ? 1 : 0);
