// verify_handoff_selfrecover.mjs — WS-HAND #1/#2 (the MONEY defect), #5 (one tile on
// a re-seat) and #6 (a refused hand-off is rendered), end to end in REAL contexts.
//
// #1/#2 — a hand-off the dispatching device ends up running ITSELF must leave NOTHING
// on the relay for a peer to re-run and re-bill. Before the fix `takeRow` HELD the own
// errand unconditionally, so a peer waking within the 15-min deadline collected it, took
// the freed lease and re-ran + RE-BILLED the turn; the same hold froze the ack cursor.
// The fix: `settle(turnId)` frees the local hold once the turn is settled here, the ack
// then drops the relay row, and the released lease carries `settled:1` so a raced taker
// stands down. Here: A dispatches to a present-but-NOT-listening B (a phantom); A
// recovers the turn locally on return; THEN B runs a collect INSIDE the deadline.
//
// REWRITTEN 2026-09-20 (a live two-device gate found the ORIGINAL #1 check measured the
// wrong thing). It counted ASSISTANT ROWS on B, deterministically 1 in EVERY run,
// `--break` included: B stays paired and sync-connected throughout, so A's one
// completed turn reaches B over the ORDINARY chat-sync mailbox regardless of whether B
// ever touched the peer/lease machinery -- a row on B is not evidence B ran anything.
// The money question is BILLING: was the errand's turn put to the model MORE THAN ONCE,
// and did B ever become the runner. Two direct signals now stand in for the row count:
//
//   MONEY #1a — real LLM completions for the turn, read off the mock's own log
//      (dev/mockllm.mjs logs every request it is sent), filtered to this errand's
//      prompt. This is what a real provider would bill: exactly ONE across the whole
//      cluster in the fixed build, TWO -- the re-bill -- with `--break`.
//   MONEY #1b — B's OWN take-if-vacant lease claim, made directly through the real
//      lease CAS door (`DaimondPeer.syncCas` + `DaimondSync.leaseGet`/`leaseCommit`,
//      exactly as `daimond.js`'s runner wires it) rather than inferred from a
//      transcript: `DaimondLease.take(tid, …)` must answer `{won:false, why:'settled'}`
//      in the fixed build -- the lease itself, not a race against ordinary sync, is
//      what refuses B -- and `{won:true}` once the settle-stamp is reverted.
//
// Both need B's ORDINARY chat-sync pull isolated for the run, or the transcript-based
// stand-down (`dispatchedTurnSettled`, D1(b) in `runErrand`) protects B for a reason
// that has nothing to do with the fix under test and neither signal could ever flip.
// B's own `/api/sync` (bare, query-less: the content parcel) is blocked with
// `page.route` for the scenario's critical window -- NOT `?lease=1` (the lease's own
// door, which the MONEY #1b probe needs) and not `/api/post` (the peer errand/report
// mailbox: the errand carries its own seed, so B can still reconstruct and -- if the
// lease lets it -- genuinely RUN the turn without any ordinary parcel pull at all; see
// daimond.js `peerReconstruct`'s "THE SEED, FIRST").
//
// `--break` (`holdOwnDispatch → true`) alone turned out to have NO TEETH either: it only
// changes whether A holds its OWN dispatch row on the relay after recovering (the S-HAND
// #2 ack-cursor fix), which is not what refuses B's lease claim. The refusal is the
// `settled:1` stamp a done->released lease transition carries (peer.js `leaseSetCas`,
// read by `leaseTakeFromCas`); `--break` now ALSO reverts that, by stripping `settled`
// off whatever either page commits through `DaimondSync.leaseCommit` -- reproducing "the
// settle path was reverted" without touching the fix in peer.js.
//
// With both reverted, MONEY #1b (below) proves the LEASE ITSELF has stopped refusing:
// B's own take-if-vacant claim, made through the real door the runner uses, WINS
// (`won:true`) where the fixed build answers `why:'settled'`. That is the actual
// mechanism the commit fixed, proven directly rather than inferred. MONEY #1a (the
// completions count) does NOT currently flip under `--break`: B's own real `collect()`
// still stands down `already-done` before it ever reaches the lease, for a reason this
// file could not identify within its own fence (see the note beside that check) -- so
// the double-bill is proven at the lease-mechanism level, not yet reproduced end-to-end
// through B's ordinary collect path. Reported as found, not forced green.
//
// #5 — a re-seat draws ONE hand-off tile (markTurnDispatched updates in place).
// #6 — a 413 (and a prompt larger than the door) is RENDERED as a refused seat and the
//      turn runs here, its provenance naming the refusal.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway (DAIMOND_GW_PORT),
// Pro-granted via pro.mjs (dev/pro.mjs's signed `customer.subscription.created` webhook,
// verified live 2026-09-20 against a fresh capped dev gateway at HEAD -- "A holds Pro"
// passes and the two-context round-trip runs).
//
//   node dev/verify_handoff_selfrecover.mjs
//   node dev/verify_handoff_selfrecover.mjs --break   # revert holdOwnDispatch AND the
//                                                      # lease's settled-stamp

import { open, chat, signInAs, newChat, connectMock, shot, storedChats, mockLog, clearMockLog, contentText } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const RTMS = Number(process.env.RESCUE_MS || 90000);
const BREAK = process.argv.includes('--break');
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());
async function until(pg, fn, arg, ms = 30000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true; await pg.waitForTimeout(step);
	}
	return false;
}
async function untilChats(s, pred, ms = 30000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let cs = []; try { cs = await storedChats(s); } catch (e) { cs = []; }
		try { if (pred(cs)) return cs; } catch (e) {}
		await s.page.waitForTimeout(step);
	}
	try { return await storedChats(s); } catch (e) { return []; }
}
const allMsgs = (cs) => (cs || []).flatMap((c) => (c.messages || []));
const dispatchedRows = (cs, needle) => allMsgs(cs).filter((m) => m.why === 'dispatched' && new RegExp(needle, 'i').test(m.itext || ''));
const answersFor = (cs, needle) => allMsgs(cs).filter((m) =>
	m.role === 'assistant' && m.content && m.content.trim() && !m.interrupted
	&& new RegExp(needle, 'i').test((m.itext || '') + ' ' + (m.content || '')));

// Apply the --break in the LIVE page: revert takeRow to hold an own errand
// unconditionally (never consult holdOwnDispatch) AND revert the lease's own
// settled-stamp, reproducing the pre-fix defect on BOTH of the paths that guard it.
// `holdOwnDispatch` alone has no teeth against the MONEY checks below (see the header):
// it only decides whether A keeps its OWN dispatch row on the relay (S-HAND #2), not
// whether B's lease claim is refused. The refusal that matters is the `settled:1` a
// done->released transition stamps (peer.js `leaseSetCas`); stripped here, at the one
// door every such commit passes through (`DaimondSync.leaseCommit`), rather than in
// peer.js, which carries the fix.
async function applyBreak(pg) {
	await pg.evaluate(() => {
		try {
			const P = window.DaimondPeer;
			if (P && P.holdOwnDispatch) P.holdOwnDispatch = async () => true;	// always hold
		} catch (e) {}
		try {
			// REVERT THE SETTLE PATH ITSELF (S-HAND #1's own name for the fix). Diagnosed
			// live 2026-09-20: `holdOwnDispatch` alone left the row gone by the time B ever
			// looked, because A's own successful local-recovery run acks the errand
			// unconditionally through `peerRunErrandDeps`'s `ack` dep (daimond.js) --
			// `DaimondPost.settle(turnId)` THEN `DaimondPost.ack()` -- regardless of
			// `holdOwnDispatch`, which only gates a SEPARATE case (A's own later re-collect
			// of a still-unrun dispatch). No-opping `settle` here reproduces the pre-fix
			// world precisely: A's own hold on the row is never freed, so `ackThrough`'s
			// watermark never passes it and the row survives on the relay for B to
			// genuinely find and re-run.
			const D = window.DaimondPost;
			if (D && D.settle) D.settle = async () => ({ settled: false });
		} catch (e) {}
		try {
			const S = window.DaimondSync;
			if (S && S.leaseCommit && !S.__unsettledBreak) {
				const orig = S.leaseCommit.bind(S);
				S.__unsettledBreak = true;
				S.leaseCommit = (base, proposed) => {
					const stripped = {};
					for (const k of Object.keys(proposed || {})) {
						const rec = Object.assign({}, proposed[k]);
						delete rec.settled;
						stripped[k] = rec;
					}
					return orig(base, stripped);
				};
			}
		} catch (e) {}
	});
}

// The real lease CAS, reconstructed the way daimond.js `peerSyncShim` wires it
// (`DaimondSync.leaseGet`/`leaseCommit`, not the content parcel) so a probe can drive
// `DaimondLease.take` exactly as the runner does, from OUTSIDE runErrand's D1(a)/D1(b)/
// D1(c) guards -- isolating the lease's OWN refusal from the transcript/report-based
// stand-downs that also protect B, and would otherwise mask a lease that had stopped
// refusing anything at all.
function leaseProbe(pg, turnId) {
	return pg.evaluate(async (tid) => {
		try {
			const shim = {
				read:    async () => { try { return await DaimondSync.leaseGet(); } catch (e) { return { version: 0, leases: {} }; } },
				commit:  async (base, proposed) => { try { return await DaimondSync.leaseCommit(base, proposed); } catch (e) { return { ok: false, version: base | 0, leases: {} }; } },
				version: () => { try { return DaimondSync.leaseVersion() | 0; } catch (e) { return 0; } },
				leases:  () => { try { return DaimondLease.snapshot() || {}; } catch (e) { return {}; } },
			};
			const cas = DaimondPeer.syncCas(shim);
			const holder = DaimondIdentity.deviceId();
			const eid = 'probe-' + Math.random().toString(36).slice(2);
			return await DaimondLease.take(tid, { holder, eid, deadline: Date.now() + 60000 }, cas, Date.now);
		} catch (e) { return { err: String((e && e.message) || e) }; }
	}, turnId);
}

// The last USER message's text, off one logged mock request -- the same read
// `dev/mockllm.mjs`'s own `lastUser` makes, reconstructed here because the money count
// below wants it from OUTSIDE the mock's process.
function lastUserText(messages) {
	for (let i = (messages || []).length - 1; i >= 0; i--) {
		if (messages[i] && messages[i].role === 'user') return contentText(messages[i].content);
	}
	return '';
}

// How many real completions the mock served for a turn whose prompt matches `needle` --
// the direct money signal: what a real provider would have billed.
const completionsFor = (needle) => mockLog().filter((r) => new RegExp(needle, 'i').test(lastUserText(r.messages)));

let a, b, c;
try {
	// ── A: the phone, and B: a paired desktop peer. ───────────────────────────
	a = await open({ name: 'selfrec', touch: true });
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro (the dispatch/presence path is not refused)', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the chat and its parcel exist');
	await settle(a.page);
	if (BREAK) await applyBreak(a.page);

	b = await open({ name: 'selfrecmate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((cc) => DaimondPairing.redeem(cc), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'selfrec');
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices', !!idA && !!idB && idA !== idB, JSON.stringify({ idA, idB }));

	// ═══════════════════════════════════════════════════════════════════════════
	// #1/#2 — A dispatches to a PHANTOM B, recovers locally, THEN B collects.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n#1/#2 self-recover — the own errand is settled, so a late B does not re-run');

	// B is present (beats presence, so A dispatches to it) but NOT listening.
	await b.page.evaluate(() => {
		try { window.DaimondPost.parkStop && window.DaimondPost.parkStop(); } catch (e) {}
		window.__savedCollect = window.DaimondPost.collect;
		try { window.DaimondPost.collect = async () => ({ ok: true, got: 0 }); } catch (e) {}
		// ISOLATE THE LEASE (both runs, not only --break). Diagnosed live 2026-09-20: the
		// SAME collect() batch that delivers the errand also delivers A's own "done" REPORT
		// (posted moments after A's local recovery, over the SAME mailbox as the errand,
		// which the /api/sync block below cannot separate from it) -- and `dispatchedTurnSettled`
		// (D1(b) in runErrand) reads that report FIRST, standing B down before it ever reaches
		// the lease. That is a genuine, independent defence in a present-but-listening-late B,
		// and it would mask whether the LEASE ALONE still refuses B once the report is out of
		// the picture (a true partition: B never heard A finish at all). So B is made deaf to
		// reports here -- `DaimondPeer.onReport` overridden to a no-op AFTER daimond.js's own
		// registration -- so what stands B down below is the lease and nothing else.
		try { if (window.DaimondPeer && DaimondPeer.onReport) DaimondPeer.onReport(function () {}); } catch (e) {}
		window.__phantomBeat = setInterval(() => {
			try { window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'phantom'); } catch (e) {}
		}, 3000);
	});
	await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'phantom'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(1200);

	const PROMPT = 'SELFREC please answer once';
	clearMockLog();		// so the completions count below is this turn's alone
	await a.page.fill('#chat-input', PROMPT);
	await a.page.click('#chat-send', { force: true });
	const disp = await untilChats(a, (cs) => dispatchedRows(cs, 'selfrec').length >= 1, 10000);
	check('A dispatched the turn to the phantom peer', dispatchedRows(disp, 'selfrec').length >= 1);
	const tid = (dispatchedRows(disp, 'selfrec')[0] || {}).iturn;

	// ISOLATE THE LEASE. Block B's ORDINARY chat-sync pull -- the bare, query-less
	// `/api/sync` (the content parcel) -- so B's own transcript cannot receive A's
	// answer over the ordinary mailbox before B's own collect below. `?lease=1`
	// (the lease door the MONEY #1b probe needs) and `/api/post` (the peer errand/
	// report mailbox, which carries its own seed -- daimond.js `peerReconstruct`)
	// are untouched: B can still reconstruct and, if the lease lets it, genuinely
	// run the turn. Without this, D1(b) (`dispatchedTurnSettled`) can stand B down
	// for a reason that has nothing to do with the fix under test, and neither
	// MONEY check below could ever tell a real refusal from an incidental one.
	await b.page.route('**/api/sync', (route) => {
		const req = route.request();
		let bare = false;
		try { bare = req.method() === 'GET' && !new URL(req.url()).search; } catch (e) {}
		return bare ? route.abort() : route.continue();
	});

	// A returns to the foreground and recovers the orphan LOCALLY.
	await a.page.waitForTimeout(2500);
	await a.page.evaluate(() => {
		try { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); } catch (e) {}
		document.dispatchEvent(new Event('visibilitychange'));
	});
	const recovered = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		return /selfrec/i.test((out && out.innerText) || '') && !/sent to your other/i.test((out && out.innerText) || '');
	}, null, 40000);
	check('A recovered the orphaned turn locally on return', recovered);
	await settle(a.page);

	// NOW B collects, INSIDE the deadline. With the fix, the errand is gone (settled +
	// acked) and the released lease carries settled:1, so B produces NOTHING.
	await b.page.evaluate(() => { try { window.DaimondPost.collect = window.__savedCollect; } catch (e) {} });
	if (BREAK) await applyBreak(b.page);
	const collectRes = await b.page.evaluate(() => { try { return window.DaimondPost.collect(); } catch (e) { return { err: String(e) }; } });
	await b.page.waitForTimeout(6000);
	await settle(b.page);
	// KNOWN LIMIT (2026-09-20, live diagnosis): under --break, B's OWN real `collect()`
	// consistently stands down `already-done` at once (`window.DaimondDiag` traced it:
	// "collect errand" immediately followed by "collect stand-down … already done", no
	// lease take attempted) -- even with the ordinary `/api/sync` pull blocked AND
	// `DaimondPeer.onReport` overridden to a no-op before this scenario starts. So
	// `dispatchedTurnSettled`'s two proofs (a collected 'done' report, or a merged
	// assistant row) are not the whole story here; something else settles it for B before
	// this file's own isolation takes hold, and closing that gap needs the app author's
	// own read, not a further dev/ harness patch. `collectRes` is logged so a future run
	// has the evidence in hand rather than a bare number.
	if (BREAK) console.log('  note  B\'s own collect() -> ' + JSON.stringify(collectRes)
		+ ' (see the note below the completions check for why this does not reach the lease)');

	// INFORMATIONAL ONLY, never asserted on: B holds a row for the turn EITHER WAY,
	// because B stays paired and sync-connected -- once the block above is lifted, the
	// ordinary chat-sync mailbox delivers A's own answer here regardless of whether B
	// ever touched the peer/lease machinery. A row on B is not evidence of a re-run;
	// see the header for the run this was measured on.
	await b.page.unroute('**/api/sync');
	const bChats = await storedChats(b);
	const bAns = tid ? allMsgs(bChats).filter((m) => m.role === 'assistant' && String(m.iturn) === String(tid) && m.content && m.content.trim()).length : 0;
	console.log('  note  B holds ' + bAns + ' assistant row(s) for the turn (via ordinary sync, once unblocked -- not asserted on)');

	// Read straight off the gateway's own lease door (`DaimondSync.leaseGet`), not
	// `DaimondLease.record` -- B's LOCAL adopted view is only refreshed by an explicit
	// lease action or a periodic poll, neither of which has necessarily happened yet at
	// this point, and `leaseTakeFromCas`'s own early 'settled' stand-down (the exact path
	// under test) returns without adopting anything into it. The gateway's own record is
	// the source of truth the fix actually stamped.
	const lease = await b.page.evaluate(async (t) => {
		try {
			const got = await DaimondSync.leaseGet();
			const r = (got && got.leases) ? got.leases[String(t)] : null;
			return { mode: r && r.mode, settled: r && r.settled, holder: r && r.holder };
		} catch (e) { return { err: String(e) }; }
	}, tid);
	// `holder` is NOT re-asserted null here: unlike `DaimondLease.holder()` (which
	// nullifies a non-live record), the raw gateway record keeps the LAST holder's id
	// for provenance even once `mode` reads 'released' -- `mode` is the vacancy signal.
	if (!BREAK) {
		check('#1: B\'s lease for the turn is released and stamped settled:1',
			lease && lease.mode === 'released' && lease.settled === 1,
			JSON.stringify(lease));
	} else {
		check('--break: the lease is released but the settled-stamp is GONE (the settle path was reverted)',
			lease && lease.mode === 'released' && !lease.settled, JSON.stringify(lease));
	}

	// MONEY #1b — B's OWN take-if-vacant claim, made directly against the real lease
	// door: `leaseTakeFromCas` must refuse it with `why:'settled'` in the fixed build
	// (the lease itself is what stands B down, not a race against ordinary sync), and
	// must WIN it once --break has stripped the settled-stamp.
	const probe = await leaseProbe(b.page, tid);
	if (!BREAK) {
		check('#1 MONEY: B\'s own lease claim is refused -- leaseTakeFromCas reads why:"settled" -- so B never becomes the runner',
			probe && probe.won === false && probe.why === 'settled', JSON.stringify(probe));
	} else {
		check('--break: B\'s own lease claim WINS -- "settled" no longer stands in the way',
			probe && probe.won === true, JSON.stringify(probe));
	}

	// MONEY #1a — real LLM completions for the turn, off the mock's own log: what a
	// real provider would have billed. Exactly one in the fixed build, every run.
	//
	// UNDER --break THIS DOES NOT CURRENTLY FLIP, and that is reported honestly rather
	// than forced green: B's REAL `collect()` above still stands down `already-done` at
	// once (logged above), before it ever reaches the lease this file's OTHER probe
	// (MONEY #1b, immediately above) proves is wide open. `dispatchedTurnSettled`'s two
	// named proofs -- a collected 'done' report, or a merged assistant row -- are both
	// isolated against here (the ordinary `/api/sync` pull blocked, `onReport` a no-op),
	// and B still settles instantly, so some THIRD path stands it down that this file has
	// not identified. The decisive, mechanism-level proof of the money invariant is MONEY
	// #1b: the real take-if-vacant lease claim, made through the same door the runner
	// uses, refuses with why:'settled' unbroken and WINS once the settle-stamp is
	// reverted -- that is the actual fix (peer.js `leaseTakeFromCas`), proven directly.
	// This count is kept and asserted anyway, never silenced, so closing the gap (finding
	// B's real third stand-down reason) shows up here as a newly-passing check rather
	// than as a check quietly dropped.
	const completions = completionsFor('selfrec');
	if (!BREAK) {
		check('#1 MONEY: the errand was put to the model EXACTLY ONCE across the whole cluster (never re-billed)',
			completions.length === 1, 'completions for this turn: ' + completions.length);
	} else {
		check('--break: the mock sees TWO completions for the turn (B\'s real collect() re-running it) -- NOT YET REPRODUCED, see the note above',
			completions.length >= 2, 'completions for this turn: ' + completions.length);
	}

	const aChats = await storedChats(a);
	const aAns = tid ? answersFor(aChats, 'selfrec').filter((m) => String(m.iturn) === String(tid)).length : answersFor(aChats, 'selfrec').length;
	check('#1: A has (at least) one assistant row for the turn', aAns >= 1, 'A answers for iturn: ' + aAns);

	const post = await a.page.evaluate(async () => {
		try {
			const st = await window.DaimondPost.read();
			const s = window.DaimondPost.state();
			return { through: st.through, seen: st.seen, holds: (st.holds || []).length, acked: s.acked };
		} catch (e) { return { err: String(e) }; }
	});
	if (!BREAK) {
		check('#2: A\'s ack cursor is free (through === seen, holds empty, acked >= through)',
			post && post.through === post.seen && post.holds === 0 && post.acked >= post.through, JSON.stringify(post));
	} else {
		console.log('  note  #2 ack-cursor shape not asserted under --break: holdOwnDispatch is reverted on purpose');
	}

	await shot(a, 'selfrecover_' + (bad.length ? 'RED' : 'GREEN'));

	// ═══════════════════════════════════════════════════════════════════════════
	// #6 — a refused hand-off is rendered, and the turn runs here.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n#6 refused hand-off — a 413 is shown as a refused seat, the turn runs here');
	let postCalls = 0;
	await a.page.route('**/api/post', async (route) => {
		postCalls++;
		if (postCalls === 1) return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ ok: false, why: 'too large' }) });
		return route.continue();
	});
	const PROMPT6 = 'REFUSED413 answer here please';
	await a.page.fill('#chat-input', PROMPT6);
	await a.page.click('#chat-send', { force: true });
	const refusedNote = await until(a.page, () => {
		const n = document.querySelector('.seat-note.seat-warn');
		return !!(n && /refused \(413\)/i.test(n.textContent || ''));
	}, null, 20000);
	check('#6: the seat note reads "refused (413)"', refusedNote);
	const ranHere413 = await untilChats(a, (cs) => answersFor(cs, 'refused413').some((m) => String(m.ranOn) === String(idA)), RTMS);
	check('#6: the refused turn completed HERE with one assistant row', answersFor(ranHere413, 'refused413').filter((m) => String(m.ranOn) === String(idA)).length === 1);
	await a.page.unroute('**/api/post');

	// Second case: a prompt larger than the relay door -> status 0, no POST /api/post.
	// A short cool-off from the 413 case just above, so whatever just refused a dispatch
	// a moment ago is not why THIS turn skips dispatch entirely (diagnosed live 2026-09-20:
	// with no gap, 0 'dispatched' rows for this prompt -- A ran it locally without ever
	// trying a peer, so the size-refusal path under test was never reached).
	console.log('#6 prompt-too-large — no POST is made, the note reads status 0');
	await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'phantom'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(5000);
	let postCalls2 = 0;
	await a.page.route('**/api/post', async (route) => {
		if (route.request().method() === 'POST') postCalls2++;
		return route.continue();
	});
	const HUGE = 'BIGPROMPT ' + 'x'.repeat(80 * 1024);
	await a.page.fill('#chat-input', HUGE);
	await a.page.click('#chat-send', { force: true });
	await a.page.waitForTimeout(4000);
	const note0 = await a.page.evaluate(() => {
		const n = document.querySelector('.seat-note.seat-warn');
		return n ? n.textContent : '';
	});
	check('#6: an oversized prompt shows a refused seat (status 0)', /refused \(0\)/i.test(note0 || ''), 'note=' + JSON.stringify(note0));
	check('#6: no POST /api/post was attempted for the oversized prompt', postCalls2 === 0, 'post calls: ' + postCalls2);
	// QUARANTINE NOTE (2026-09-20, live diagnosis, not fixed here -- out of this file's
	// fence and needs the app author's read): both checks above are RED, deterministically,
	// on an unmodified build, and are unrelated to the money invariant this file exists to
	// prove. `dispatchedRows` for this prompt is EMPTY -- A never attempted a peer at all
	// (autoDispatchDecision's own election, peer.js `handoffTarget`, never ran the
	// `fitsPostDoor` size gate this pair of checks is about) and answered the oversized
	// prompt locally with no seat-note. Neither `holdOwnDispatch` nor the lease's
	// settled-stamp (what this file's `--break` reverts) has any bearing on that election,
	// and re-beating B's presence and waiting 5s longer before sending did not change it --
	// so this is not a timing race this file's own waits can close. Left asserting (not
	// silenced) so a fix or a further regression both show up here.
	const bigDispatched = dispatchedRows(await storedChats(a), 'bigprompt').length;
	if (!bigDispatched) console.log('  note  quarantined: A never attempted a peer for this prompt (0 dispatched rows) -- '
		+ 'the size-refusal path the two checks above are about was never reached; see the note above them');
	await a.page.unroute('**/api/post');

	// ═══════════════════════════════════════════════════════════════════════════
	// #5 — a re-seat draws ONE hand-off tile.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n#5 one tile per turn — a re-seat updates the placeholder in place');
	c = await open({ name: 'selfrecC', signIn: false, connect: false });
	await c.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code2 = await a.page.evaluate(() => DaimondPairing.create());
	await c.page.evaluate((cc) => DaimondPairing.redeem(cc), code2.code);
	await c.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(c, 'selfrec');
	await c.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(c.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(c);
	await c.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'liveC'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);

	const PROMPT5 = 'RESEAT trying the next desktop';
	await a.page.fill('#chat-input', PROMPT5);
	await a.page.click('#chat-send', { force: true });
	const rs = await untilChats(a, (cs) => dispatchedRows(cs, 'reseat').length >= 1, 10000);
	const tid5 = (dispatchedRows(rs, 'reseat')[0] || {}).iturn;
	// Trigger the re-seat backstop (phantom B never picks it up; C is live), and POLL for
	// the tile rather than sleep-then-snapshot-once: `appendDispatchedTile` deliberately
	// draws NOTHING once the answer has merged (owner rule, 2026-09-18 -- the merged reply
	// draws its own quiet provenance tile instead), so a single fixed-delay snapshot taken
	// after C's round trip has already landed reads a correctly-empty DOM as a failure. The
	// property under test -- never MORE than one tile for the turn -- is checked on every
	// poll, not only the last one, so a genuine second tile from a real re-seat still fails
	// this the instant it appears.
	// The SAME reason the row count is polled alongside the tile, not read once
	// afterward: a completed re-seat resolves the placeholder's own `why` away from
	// 'dispatched' (the merged answer draws its own quiet provenance tile instead --
	// owner rule, 2026-09-18), so a single read taken after the round trip has already
	// landed sees a correctly-empty store as a failure. "Never more than one" is the
	// actual property (a re-seat updates the placeholder IN PLACE rather than adding a
	// second one); tracked as a peak across the same poll the tile uses.
	let tiles = 0, tilesEverSeen = false, rows = 0, rowsEverSeen = false;
	for (let t0 = Date.now(); Date.now() - t0 < 6000; ) {
		const n = await a.page.evaluate((t) => document.querySelectorAll('.ctile[data-t="handoff"][data-handoff-turn="' + t + '"]').length, tid5);
		if (n > tiles) tiles = n;
		if (n > 0) tilesEverSeen = true;
		const r = tid5 ? dispatchedRows(await storedChats(a), 'reseat').filter((m) => String(m.iturn) === String(tid5)).length : 0;
		if (r > rows) rows = r;
		if (r > 0) rowsEverSeen = true;
		if (n > 1 || r > 1) break;			// already failing; no need to keep polling
		await a.page.waitForTimeout(300);
	}
	check('#5: never MORE than one hand-off tile for the turn after a re-seat', tiles <= 1, 'peak tiles=' + tiles);
	if (!tilesEverSeen) console.log('  note  the tile was never observed at all -- the round trip likely finished inside the '
		+ 'poll\'s own first tick, which is a timing gap in this check rather than evidence against the fix');
	check('#5: never more than one why:dispatched row for the turn in the store', rows <= 1, 'peak rows=' + rows);
	if (!rowsEverSeen) console.log('  note  no dispatched row was ever observed for this turn -- see the tile note above');

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (c) await c.close().catch(() => {});
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) for (const l of bad) console.log('  FAILED: ' + l);
process.exit(bad.length ? 1 : 0);
