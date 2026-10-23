// gateway: live
// verify_stoppeer.mjs -- Send turns into Stop for a turn that runs on another device, on
// BOTH devices, and that Stop ends it (D-20261011-21 / D3, unit U3 STOP-ON-PEER).
//
// The owner: "the arrow enter button to send input did not turn into a stop button on
// either device". `turnPhase` read only `current._generating`, which three turns never set:
// the sender's turn a peer holds (a `dispatched` placeholder), the runner's run (on a
// DETACHED reconstructed chat, never `current`), and the sender's own reclaimed run (the
// same detached run, through `recoverOneLocally`).
//
//   (1) A hands a turn to B and B runs it: A's button reads Stop; B, opening the same
//       chat from its rail, reads Stop too.
//   (2) Stop on A ends it: A and B are back to Send within STOP_S s, the lease record is
//       settled, and the model is not asked again (no re-run) for RERUN_S s more.
//   (3) Stop on the runner, B: B back to Send within STOP_S s, and A's button with it.
//   (4) A's hand-off is refused, so A runs the turn here at once (the reclaimed run): A's
//       button reads Stop while it runs, and Stop ends it within STOP_S s.
//
// Each turn is a mock `@slow 40000`, far longer than any window here, so a button that
// goes back to Send by the turn ending of its own accord cannot pass.
//
//   node dev/verify_stoppeer.mjs [--webkit]
import './predeploy_guard.mjs';	// first: deploy first, refuses (41) this suite on code that is not live (D-20261023-04)
import { pair, send, sendDesk, until, storedMsgs, placeholders, checker, settle, modelSaw } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const ENGINE = process.argv.includes('--webkit') || process.env.DAIMOND_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const STOP_S  = 8;							// a Stop must land within this many seconds
const RERUN_S = 10;							// and nothing may run the turn again for this long
const SLOW    = 40000;						// each turn's mock delay, ms
const { ok, bad, check } = checker();
let a = null, b = null;

/// What the composer button is saying: 'stop', 'stopping', 'send' or '' (no button).
const btnOf = (pg) => pg.evaluate(() => {
	const el = document.getElementById('chat-send');
	if (!el) return '';
	if (el.classList.contains('stop')) return 'stop';
	if (el.getAttribute('aria-busy') === 'true' && !el.classList.contains('sending')) return 'stopping';
	return 'send';
}).catch(() => '');

/// Wait until `pg`'s button reads one of `want`; answer { hit, ms, last }.
async function btnWithin(pg, want, ms) {
	const t0 = Date.now();
	let last = '';
	while (Date.now() - t0 < ms) {
		last = await btnOf(pg);
		if (want.includes(last)) return { hit: true, ms: Date.now() - t0, last };
		await pg.waitForTimeout(100);
	}
	return { hit: false, ms: Date.now() - t0, last };
}

/// The lease record for `tid` as this device reads it.
const leaseOf = (pg, tid) => pg.evaluate((t) => {
	try { return window.DaimondLease.record(t) || null; } catch (e) { return { err: String(e) }; }
}, tid).catch(() => null);

/// The id of the chat holding turn `tid`'s placeholder, read through the chat store.
const chatOfTurn = (s, tid) => s.page.evaluate(async (t) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		if (((got && got.messages) || []).some((m) => m && String(m.iturn) === t)) return sum.id;
	}
	return '';
}, tid).catch(() => '');

/// Send `prompt` from A at a phone's width and answer the new placeholder's turn id.
async function dispatchOne(prompt, seen) {
	await send(a.page, prompt);
	for (let i = 0; i < 80; i++) {
		const ph = placeholders(await storedMsgs(a)).map((m) => String(m.iturn)).filter((t) => !seen.has(t));
		if (ph[0]) { seen.add(ph[0]); return ph[0]; }
		await a.page.waitForTimeout(250);
	}
	return '';
}

/// Wait until B holds `tid`'s lease in mode running, as A reads it.
async function runningOnB(tid, idB) {
	return until(a.page, ([t, id]) => {
		try {
			const r = window.DaimondLease.record(t);
			return !!r && r.holder === id && r.mode === 'running';
		} catch (e) { return false; }
	}, [tid, idB], 60000, 250);
}

/// Open chat `cid` on B through its rail tile, as the person would, at a desktop's width.
async function openOnB(cid) {
	await b.page.setViewportSize({ width: 1280, height: 900 });
	const sel = '.session-box.chat-box[data-id="' + cid + '"] .tile-label';
	for (let i = 0; i < 40; i++) {
		if (await b.page.$(sel)) break;
		await b.page.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull()).catch(() => {});
		await b.page.waitForTimeout(500);
	}
	const there = !!(await b.page.$(sel));
	if (there) await b.page.click(sel, { force: true });
	await b.page.waitForTimeout(500);
	return there;
}

try {
	({ a, b } = await pair(check, 'sp-a-' + ENGINE, 'sp-b-' + ENGINE,
		{ openA: { browser: ENGINE, serviceWorkers: 'block' }, openB: { browser: ENGINE } }));
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	const seen = new Set(placeholders(await storedMsgs(a)).map((m) => String(m.iturn)));
	await settle(a.page);

	// ── (1) Stop on both devices while B runs A's turn ───────────────────────
	const p1 = '@slow ' + SLOW + ' STOPPEER-1';
	const t1 = await dispatchOne(p1, seen);
	check('(0) A handed turn one off', !!t1);
	const run1 = t1 && await runningOnB(t1, idB);
	check('(0) B holds turn one, running', !!run1, JSON.stringify(t1 ? await leaseOf(a.page, t1) : null));
	const a1 = await btnWithin(a.page, ['stop'], 3000);
	check('(1) A\'s button reads Stop while B runs its turn', a1.hit, 'reads ' + a1.last);
	const cid1 = t1 ? await chatOfTurn(a, t1) : '';
	const open1 = cid1 && await openOnB(cid1);
	check('(0) B opens the chat from its rail', !!open1, 'chat ' + cid1);
	const b1 = await btnWithin(b.page, ['stop'], 3000);
	check('(1) B\'s button reads Stop while it runs the turn', b1.hit, 'reads ' + b1.last);

	// ── (2) Stop on A ends it, on both, with no re-run ───────────────────────
	const saw1 = modelSaw('STOPPEER-1');
	await a.page.click('#chat-send', { force: true });
	const a2 = await btnWithin(a.page, ['send'], STOP_S * 1000);
	check('(2) A is back to Send within ' + STOP_S + ' s of its Stop', a2.hit, 'after ' + a2.ms + ' ms reads ' + a2.last);
	const b2 = await btnWithin(b.page, ['send'], STOP_S * 1000);
	check('(2) B is back to Send within ' + STOP_S + ' s of A\'s Stop', b2.hit, 'after ' + b2.ms + ' ms reads ' + b2.last);
	const l2 = t1 ? await leaseOf(a.page, t1) : null;
	check('(2) the lease record is settled', !!l2 && !!l2.settled, JSON.stringify(l2));
	await a.page.waitForTimeout(RERUN_S * 1000);
	const again = modelSaw('STOPPEER-1') - saw1;
	check('(2) nothing ran turn one again in ' + RERUN_S + ' s', again === 0, 'model asked ' + again + ' more time(s)');
	await settle(a.page);
	await settle(b.page);

	// ── (3) Stop on the runner ───────────────────────────────────────────────
	const t3 = await dispatchOne('@slow ' + SLOW + ' STOPPEER-3', seen);
	const run3 = t3 && await runningOnB(t3, idB);
	check('(0) B holds turn three, running', !!run3, JSON.stringify(t3 ? await leaseOf(a.page, t3) : null));
	const cid3 = t3 ? await chatOfTurn(a, t3) : '';
	if (cid3 && cid3 !== cid1) await openOnB(cid3);
	const b3 = await btnWithin(b.page, ['stop'], 3000);
	check('(3) B\'s button reads Stop on the turn it runs', b3.hit, 'reads ' + b3.last);
	if (b3.hit) await b.page.click('#chat-send', { force: true });
	const b3s = await btnWithin(b.page, ['send'], STOP_S * 1000);
	check('(3) B is back to Send within ' + STOP_S + ' s of its Stop', b3.hit && b3s.hit, 'after ' + b3s.ms + ' ms reads ' + b3s.last);
	const a3 = await btnWithin(a.page, ['send'], STOP_S * 1000);
	check('(3) A is back to Send within ' + STOP_S + ' s of B\'s Stop', b3.hit && a3.hit, 'after ' + a3.ms + ' ms reads ' + a3.last);
	await settle(a.page);
	await settle(b.page);

	// ── (4) the reclaimed run on A ───────────────────────────────────────────
	// The relay refuses A's errand, so A runs the turn here at once (`recoverOneLocally`).
	const refuse = (route) => route.request().method() === 'POST' && /\/api\/post$/.test(route.request().url())
		? route.fulfill({ status: 413, contentType: 'application/json', body: '{"ok":false,"error":"too large"}' })
		: route.continue();
	await a.page.route('**/api/post*', refuse);
	const saw4 = modelSaw('STOPPEER-4');
	const t4 = await dispatchOne('@slow ' + SLOW + ' STOPPEER-4', seen);
	check('(0) A dispatched turn four', !!t4);
	const ran4 = await (async () => {
		for (let i = 0; i < 60; i++) { if (modelSaw('STOPPEER-4') > saw4) return true; await a.page.waitForTimeout(250); }
		return false;
	})();
	check('(0) A runs turn four here after the refusal', ran4);
	await a.page.unroute('**/api/post*', refuse);
	const a4 = await btnWithin(a.page, ['stop'], 3000);
	check('(4) A\'s button reads Stop while it runs its reclaimed turn', a4.hit, 'reads ' + a4.last);
	if (a4.hit) await a.page.click('#chat-send', { force: true });
	const a4s = await btnWithin(a.page, ['send'], STOP_S * 1000);
	check('(4) A is back to Send within ' + STOP_S + ' s of its Stop', a4.hit && a4s.hit, 'after ' + a4s.ms + ' ms reads ' + a4s.last);

	console.log(`\n${ENGINE}: ${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
