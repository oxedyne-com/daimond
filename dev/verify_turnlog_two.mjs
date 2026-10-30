// gateway: live
// verify_turnlog_two.mjs -- every turn reaches the OTHER device through the chat log (P2.3, design
// daimond_p2_turnlog_design_20261030 §6 failing-first, [F9]; open point P2.3c1 "a Here lease reads as peer-held").
//
// Two contexts on one account and one real gateway: A is WebKit at a phone's width (touch), B is Chromium,
// the nominated runner. Every action is the composer's own (fill, then a real pointer press on Send) or a
// rail tile pressed; every check reads the device that did NOT run the turn.
//
//   (a) A hands a turn to B: on A, the turn's rows carry the log's seq, in seq order, each mid once (the
//       log's copy and the parcel's are one message), the answer text once, and the state tile is the
//       turn's last message for as long as the log holds no end for it.
//   (b) B runs a Here turn with its gateway unreachable, then reconnects: A reads that turn's rows in the
//       chat's log under the turn's own id (its msg row and its end), and draws them with their seq: it
//       did not arrive by parcel alone.
//   (d) B runs a slow Here turn: A, on the same chat, draws Stop (lead ruling 30 Oct), and A's Stop
//       ends it: one `stopped` end in the log, read by both devices, and both composers read Send.
//   (c) B's tab is killed mid-turn: once A's clock passes the turn's lease deadline, the log holds an
//       `interrupted` end for it and A draws the turn interrupted.
//
// (c) runs last, since it kills B. A's clock is moved past the deadline (the run clock cannot jump, and
// DISPATCH_DEADLINE_MS is 15 min); the gateway takes the end on first-end-wins, which reads no clock.
//
//   node dev/verify_turnlog_two.mjs          (through `dk arms <env> gw:turnlog_two`)
import './predeploy_guard.mjs';	// first: deploy first, refuses (41) this suite on code that is not live (D-20261023-04)
import { pair, send, sendDesk, until, storedMsgs, placeholders, checker, settle, modelSaw, freshChat } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const SLOW_A   = 6000;			// (a) the runner's reply delay, ms: long enough to sample the open turn
const SLOW_C   = 120000;		// (c)/(d) a Here turn that outlives every window here, ms
const JUMP_MS  = 17 * 60 * 1000;	// past DISPATCH_DEADLINE_MS (15 min), the Here lease's deadline
const { ok, bad, check } = checker();
let a = null, b = null, bAlive = true;

/// What the composer button says: 'stop', 'stopping', 'send' or '' (no button).
const btnOf = (pg) => pg.evaluate(() => {
	const el = document.getElementById('chat-send');
	if (!el) return '';
	if (el.classList.contains('stop')) return 'stop';
	if (el.getAttribute('aria-busy') === 'true' && !el.classList.contains('sending')) return 'stopping';
	return 'send';
}).catch(() => '');

/// The chat in focus on `pg`, or ''.
const focusOf = (pg) => pg.evaluate(() => {
	try { const f = window.DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; } catch (e) { return ''; }
}).catch(() => '');

/// Chat `cid`'s log as `pg` reads it from the gateway, opened: `{rows: [{seq, turn, kind, n, mid, status}], err}`.
/// The door, the key and the opening are the page's own (DaimondSync.readLog, DaimondSeal, the space key).
const logOf = (pg, cid) => pg.evaluate(async (id) => {
	const S = window.DaimondSync, Z = window.DaimondSeal, I = window.DaimondIdentity;
	if (!S || !S.readLog) return { rows: [], err: 'no log door (DaimondSync.readLog)' };
	if (!Z || !Z.rowAad || !I || !I.unwrapBytesAad) return { rows: [], err: 'no row opener' };
	const rows = [];
	let since = 0;
	for (let page = 0; page < 20; page++) {
		const got = await S.readLog(id, since);
		if (!got) return { rows, err: 'readLog answered nothing' };
		if (got.gap) return { rows, err: 'gap at low ' + got.low };
		const aad = await Z.rowAad();
		for (const w of (got.rows || [])) {
			const wire = JSON.stringify(w);
			try {
				const r = JSON.parse(await Z.rowOpen(wire, await I.unwrapBytesAad(await Z.rowSealed(wire), aad)));
				const h = r.head || {}, bd = r.body || {};
				rows.push({ seq: +h.seq || 0, turn: String(h.turn || ''), kind: String(h.kind || ''), n: +h.n || 0,
					mid: String(bd.mid || ''), status: String(bd.status || '') });
			} catch (e) { rows.push({ seq: +w.seq || 0, turn: '', kind: 'unopened', err: String(e) }); }
			since = Math.max(since, +w.seq || 0);
		}
		if (!got.more || !(got.rows || []).length) break;
	}
	return { rows };
}, cid).catch((e) => ({ rows: [], err: 'evaluate: ' + (e && e.message) }));

/// Turn `tid`'s messages in chat `cid` as `s` holds them, in their stored (drawn) order.
const turnMsgs = (s, cid, tid) => s.page.evaluate(async ([id, t]) => {
	let got = null;
	try { got = await window.DaimondCore.chatStore().loadMessages(id); } catch (e) { got = null; }
	return ((got && got.messages) || []).filter((m) => m && (String(m.iturn || '') === t || String(m.mid || '') === t))
		.map((m) => ({ mid: String(m.mid || ''), role: m.role, seq: +m.seq || 0, why: m.why || '', content: String(m.content || ''),
			provisional: !!m.provisional, interrupted: !!m.interrupted }));
}, [cid, tid]).catch(() => []);

const isTile = (m) => m.why === 'dispatched' && !m.content.trim();

/// The turn id of the user message carrying `text` that `s` holds, and its chat: `{tid, cid}`.
async function turnOfText(s, text, ms = 30000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const got = await s.page.evaluate(async (tx) => {
			const cs = window.DaimondCore.chatStore();
			for (const sum of cs.stored()) {
				let g = null;
				try { g = await cs.loadMessages(sum.id); } catch (e) { g = null; }
				const m = ((g && g.messages) || []).find((x) => x && x.role === 'user' && String(x.content || '').includes(tx));
				if (m) return { tid: String(m.iturn || m.mid || ''), cid: String(sum.id) };
			}
			return null;
		}, text).catch(() => null);
		if (got && got.tid) return got;
		await s.page.waitForTimeout(250);
	}
	return { tid: '', cid: '' };
}

/// Open chat `cid` on `s` from its rail tile, as the person would, at a desktop's width.
async function openChat(s, cid) {
	await s.page.setViewportSize({ width: 1280, height: 900 });
	const sel = '.session-box.chat-box[data-id="' + cid + '"] .tile-label';
	for (let i = 0; i < 60; i++) {
		if (await s.page.$(sel)) break;
		await s.page.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull()).catch(() => {});
		await s.page.waitForTimeout(500);
	}
	const there = !!(await s.page.$(sel));
	if (there) await s.page.click(sel);
	await s.page.waitForTimeout(500);
	return there && (await focusOf(s.page)) === cid;
}

/// Send `prompt` from A at a phone's width; answer the new placeholder's turn id.
async function dispatchOne(prompt, seen) {
	await send(a.page, prompt);
	for (let i = 0; i < 80; i++) {
		const ph = placeholders(await storedMsgs(a)).map((m) => String(m.iturn)).filter((t) => !seen.has(t));
		if (ph[0]) { seen.add(ph[0]); return ph[0]; }
		await a.page.waitForTimeout(250);
	}
	return '';
}

/// Poll `fn` on node's side until it answers truthy or `ms` passes; answer the last value.
async function within(pg, fn, ms, step = 500) {
	const t0 = Date.now();
	let v = null;
	while (Date.now() - t0 < ms) {
		v = await fn();
		if (v) return v;
		await pg.waitForTimeout(step);
	}
	return v;
}

try {
	({ a, b } = await pair(check, 'tl2-a', 'tl2-b',
		{ openA: { browser: 'webkit', serviceWorkers: 'block' }, openB: { browser: 'chromium' } }));
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	const seen = new Set(placeholders(await storedMsgs(a)).map((m) => String(m.iturn)));
	await settle(a.page);

	// ── (a) a handed-off turn, read on A ─────────────────────────────────────
	const tA = await dispatchOne('@slow ' + SLOW_A + ' TL2-A', seen);
	check('(0) A handed turn a off', !!tA);
	const cidA = tA ? await focusOf(a.page) : '';
	const ranB = tA && await until(a.page, ([t, id]) => {
		try { const r = window.DaimondLease.record(t); return !!r && r.holder === id; } catch (e) { return false; }
	}, [tA, idB], 60000, 250);
	check('(0) B took turn a', !!ranB);
	// Sample A while the log holds no end for the turn: the tile, when drawn, is the turn's last message.
	const tileBad = [];
	let samples = 0, endA = null;
	for (let t0 = Date.now(); tA && Date.now() - t0 < 90000;) {
		const log = await logOf(a.page, cidA);
		endA = log.rows.find((r) => r.turn === tA && r.kind === 'end') || null;
		if (endA) break;
		const ms = await turnMsgs(a, cidA, tA);
		const ti = ms.findIndex(isTile);
		samples++;
		if (ti >= 0 && ti !== ms.length - 1) tileBad.push(ms.map((m) => m.role + (isTile(m) ? '*' : '') + '@' + m.seq).join(','));
		await a.page.waitForTimeout(300);
	}
	check('(a) the log holds turn a\'s end', !!endA, 'status ' + (endA && endA.status));
	check('(a) A drew the state tile last while turn a was open', samples > 0 && tileBad.length === 0,
		samples + ' samples; out of place: ' + tileBad.slice(0, 3).join(' | '));
	await within(a.page, async () => (await turnMsgs(a, cidA, tA)).some((m) => m.role === 'assistant' && m.content.trim() && m.seq), 20000);
	const msA = tA ? await turnMsgs(a, cidA, tA) : [];
	const mids = msA.map((m) => m.mid), dupMid = mids.filter((x, i) => mids.indexOf(x) !== i);
	check('(a) on A each of turn a\'s messages is there once (by mid)', msA.length > 0 && dupMid.length === 0,
		'dup mids ' + JSON.stringify(dupMid));
	const answers = msA.filter((m) => m.role === 'assistant' && m.content.trim());
	check('(a) on A turn a\'s answer is drawn once', answers.length === 1, answers.length + ' answer(s)');
	const seqs = msA.filter((m) => m.seq).map((m) => m.seq);
	check('(a) on A turn a\'s rows carry the log\'s seq, in seq order',
		seqs.length >= 2 && seqs.every((s, i) => !i || s > seqs[i - 1]), JSON.stringify(msA.map((m) => m.role + '@' + m.seq)));
	await settle(a.page);
	await settle(b.page);

	// ── (b) an offline Here turn on B, read on A ─────────────────────────────
	await freshChat(b);
	const origin = new URL(b.page.url()).origin;
	const gwDown = (u) => u.origin === origin && u.pathname.startsWith('/api/');
	const cut = (route) => route.abort('internetdisconnected');
	await b.page.route(gwDown, cut);
	await sendDesk(b.page, '@slow 2000 TL2-B');
	const { tid: tB, cid: cidB } = await turnOfText(b, 'TL2-B');
	check('(0) B started Here turn b offline', !!tB, 'chat ' + cidB);
	const answeredB = tB && await within(b.page, async () =>
		(await turnMsgs(b, cidB, tB)).some((m) => m.role === 'assistant' && m.content.trim()), 30000);
	check('(0) B answered turn b while offline', !!answeredB);
	await b.page.waitForTimeout(2000);
	const offLog = tB ? await logOf(a.page, cidB) : { rows: [] };
	check('(0) the log holds none of turn b while B is offline', !offLog.rows.some((r) => r.turn === tB), JSON.stringify(offLog.err || ''));
	await b.page.unroute(gwDown, cut);
	await b.page.evaluate(() => window.dispatchEvent(new Event('online'))).catch(() => {});
	const logB = tB && await within(a.page, async () => {
		const l = await logOf(a.page, cidB);
		const mine = l.rows.filter((r) => r.turn === tB);
		return mine.some((r) => r.kind === 'end') ? l : null;
	}, 90000, 1000);
	const rowsB = (logB && logB.rows || []).filter((r) => r.turn === tB);
	check('(b) A reads turn b in the log under its turn id once B reconnects, its msg row and its end',
		rowsB.some((r) => r.kind === 'msg') && rowsB.some((r) => r.kind === 'end'),
		JSON.stringify(rowsB.map((r) => r.kind + '@' + r.seq)) + ' ' + ((logB && logB.err) || (offLog && offLog.err) || ''));
	const openedB = tB && await openChat(a, cidB);
	check('(0) A opens chat b from its rail', !!openedB);
	const drawnB = tB && await within(a.page, async () => {
		const ms = await turnMsgs(a, cidB, tB);
		return ms.some((m) => m.role === 'user' && m.seq) && ms.some((m) => m.role === 'assistant' && m.content.trim() && m.seq) ? ms : null;
	}, 30000);
	check('(b) A draws turn b from the log (its ask and its answer carry seq), not by parcel alone', !!drawnB,
		JSON.stringify((await turnMsgs(a, cidB, tB)).map((m) => m.role + '@' + m.seq)));
	await settle(a.page);
	await settle(b.page);

	// ── (d) B's Here turn draws Stop on A, and A's Stop ends it ─────────────
	// Lead ruling 30 Oct (UNBLOCK-28; D-20261020-07 "Stop from another device per the CC
	// benchmark"; the SEAT fix): a turn another device runs reads Stop here, Here turns too
	// (send.js `peerHeldTurnOf`). In chat b, which both devices already hold: a chat B makes
	// now reaches A only by parcel, and B never pushes over its own live turn (sync.js `pushWaits`).
	await sendDesk(b.page, '@slow ' + SLOW_C + ' TL2-D');
	const { tid: tD, cid: cidD } = await turnOfText(b, 'TL2-D');
	const runD = await within(b.page, async () => modelSaw('TL2-D') > 0, 30000);
	check('(0) B runs Here turn d', !!tD && !!runD, 'turn ' + tD);
	const heldD = tD && await within(a.page, async () => a.page.evaluate((t) => {
		try { return !!window.DaimondLease.record(t); } catch (e) { return false; }
	}, tD), 30000);
	check('(0) A reads turn d\'s Here lease', !!heldD);
	const openedD = tD && await openChat(a, cidD);
	check('(0) A opens chat d from its rail', !!openedD);
	const stopD = openedD && await within(a.page, async () => (await btnOf(a.page)) === 'stop', 15000, 250);
	check('(d) A draws Stop for B\'s Here turn', !!stopD, 'reads ' + await btnOf(a.page));
	if (stopD) await a.page.click('#chat-send');
	const endsOn = async (pg) => (await logOf(pg, cidD)).rows.filter((r) => r.turn === tD && r.kind === 'end');
	const endD = stopD && await within(a.page, async () => { const e = await endsOn(a.page); return e.length ? e : null; }, 60000, 1000);
	const endsA = tD ? await endsOn(a.page) : [];
	const endsB = tD ? await endsOn(b.page) : [];
	check('(d) A\'s Stop ends B\'s Here turn: one end row, stopped, read by both devices',
		!!endD && endsA.length === 1 && endsB.length === 1 && endsA[0].status === 'stopped' && endsB[0].status === 'stopped'
			&& endsA[0].seq === endsB[0].seq,
		'A ' + JSON.stringify(endsA) + ' B ' + JSON.stringify(endsB));
	const idleB = tD && await within(b.page, async () => (await btnOf(b.page)) === 'send', 30000, 250);
	check('(d) B\'s run of turn d stops: its composer reads Send', !!idleB, 'reads ' + await btnOf(b.page));
	const idleA = tD && await within(a.page, async () => (await btnOf(a.page)) === 'send', 30000, 250);
	check('(d) A\'s composer reads Send after the end', !!idleA, 'reads ' + await btnOf(a.page));
	await settle(a.page);
	await settle(b.page);

	// ── (c) setup: a second slow Here turn on B, in the same chat ───────────
	await sendDesk(b.page, '@slow ' + SLOW_C + ' TL2-C');
	const { tid: tC, cid: cidC } = await turnOfText(b, 'TL2-C');
	const runC = await within(b.page, async () => modelSaw('TL2-C') > 0, 30000);
	check('(0) B runs Here turn c', !!tC && !!runC, 'turn ' + tC);
	const heldC = tC && await within(a.page, async () => a.page.evaluate((t) => {
		try { return !!window.DaimondLease.record(t); } catch (e) { return false; }
	}, tC), 30000);
	check('(0) A reads turn c\'s Here lease', !!heldC);

	// ── (c) B's tab killed mid-turn: the turn ends interrupted, read on A ────
	await b.close();
	bAlive = false;
	// A's lease view reads the relay's clock (peer.js `authorityNow`: Date.now plus the skew of
	// the last answer's `now`), so a jump of A's clock alone is undone by the next answer.
	// Time passes for the gateway too: every `now` A is told from here on is moved by the jump.
	const aOrigin = new URL(a.page.url()).origin;
	const aApi = (u) => u.origin === aOrigin && u.pathname.startsWith('/api/');
	const later = async (route) => {
		const res = await route.fetch().catch(() => null);
		if (!res) return route.abort('internetdisconnected');
		let body = await res.body();
		try {
			const j = JSON.parse(body.toString());
			if (j && typeof j === 'object' && j.now != null && +j.now > 0) {
				j.now = +j.now + JUMP_MS;
				body = Buffer.from(JSON.stringify(j));
			}
		} catch (e) { /* not JSON: as the gateway sent it */ }
		return route.fulfill({ response: res, body });
	};
	await a.page.route(aApi, later);
	await a.page.clock.fastForward(JUMP_MS);
	const endC = tC && await within(a.page, async () => {
		const l = await logOf(a.page, cidC);
		return l.rows.find((r) => r.turn === tC && r.kind === 'end') || null;
	}, 90000, 1000);
	const leaseC = tC ? await a.page.evaluate((t) => {
		try {
			const L = window.DaimondLease, r = L.record(t);
			return { rec: r && { chatId: r.chatId, holder: r.holder, deadline: r.deadline, expiry: r.expiry, state: r.state },
				now: Date.now(), dead: L.pastAll ? L.pastAll() : null };
		} catch (e) { return { err: String(e) }; }
	}, tC).catch((e) => ({ err: String(e) })) : null;
	check('(c) the log holds turn c\'s end, interrupted, once its lease passed its deadline',
		!!endC && endC.status === 'interrupted', JSON.stringify(endC) + ' lease on A ' + JSON.stringify(leaseC));
	const drawnC = tC && await within(a.page, async () => (await turnMsgs(a, cidC, tC)).some((m) => m.interrupted), 30000);
	check('(c) A draws turn c interrupted', !!drawnC, JSON.stringify(await turnMsgs(a, cidC, tC)));
	const btnC = await btnOf(a.page);
	check('(c) A\'s composer reads Send after the end', btnC === 'send', 'reads ' + btnC);

	console.log(`\nwebkit+chromium: ${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { if (bAlive) await b?.close(); } catch (e) {}
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
