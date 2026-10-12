// gateway: live
// verify_handoff_rerun.mjs — a runner that reloads mid-turn does not run the turn again (r545 F-C2-1).
//
// WHAT HAPPENED (r545 QA-C2). A hands B a ten-round turn; B reloads at round 3. The asker
// re-sent the errand and B ran the whole turn again from round 0: the model saw the turn
// start twice, every tool call before the reload was made a second time (each side effect
// twice), and the lost run's rows stood beside the second run's on both devices.
//
// THE PROPERTIES, for a reload at round 3 and again at round 5:
//
//   (1) The model sees the turn START once, and no request is made after the reload
//       beyond one already in flight.
//   (2) THE SIDE-EFFECT COUNTER: each round writes `chats/<id>/work/ctr/<tag>-{n}-{c}.txt` on B (mockllm's
//       `{n}` round index and `{c}` call id); every round index has exactly one file.
//   (3) No dead-run rows: on A and on B the turn's tool rows name each round once, the
//       turn's rows carry one run, and no provisional row is left; A reloaded agrees.
//   (4) A ends with exactly one `why: 'runner'` interrupted answer, drawn as
//       "Interrupted" with a Retry button; Retry runs the turn afresh to one answer.
//
// RED on 436db66f (the turn reran: starts 2, rounds 0-2 written twice, no runner badge).
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway.
//   node dev/verify_handoff_rerun.mjs            # ROUNDS=10 PACE=1500 AT="3 5"

import {
	checker,
	pair,
	storedMsgs,
	placeholders,
	send,
	freshChat,
	settle,
	reload,
	nominateRunner,
} from './handoffpair.mjs';
import { mockLog } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const { ok, bad, check } = checker();
const ROUNDS = Number(process.env.ROUNDS || 10), PACE = Number(process.env.PACE || 1500);
const ATS = String(process.env.AT ?? '3 5').split(/\s+/).filter(Boolean).map(Number);
const WAIT = Number(process.env.WAIT || 120) * 1000;
// Arm (5), HANDOFF post-QA B F-B1: Retry pressed on A and then on B this many ms later.
const GAPS = String(process.env.GAPS ?? '0 3000 10000').split(/\s+/).filter(Boolean).map(Number);
// Where arm (5)'s Retry runs: `runner` (B nominated: the switch sends it to B) and `here`
// (nobody nominated when Retry is pressed, so each device's press runs it Here, and the
// lease alone decides which one does: the loser reads Stop on the winner's lease).
const MODES5 = String(process.env.MODES5 ?? 'runner here').split(/\s+/).filter(Boolean);
const msgsOf = (r) => (r && (r.messages || (r.body && r.body.messages) || (r.req && r.req.messages))) || [];

/// The rows of turn `tid` among `ms`: its user row onwards to the next user row, and
/// any row tagged with it.
function spanOf(ms, tid, tag) {
	const out = []; let inSpan = false;
	for (const m of ms || []) {
		if (!m) continue;
		if (m.role === 'user') { inSpan = m.mid === tid || m.iturn === tid || String(m.content || '').includes(tag); continue; }
		if (inSpan || (tid && m.iturn === tid)) out.push(m);
	}
	return out;
}

/// The counter files on `s` whose names hold `tag`, from the OPFS root down.
const counterFiles = (s, tag) => s.page.evaluate(async (tag) => {
	const found = [];
	async function walk(d, depth) {
		if (depth > 6) return;
		for await (const [name, h] of d.entries()) {
			if (h.kind === 'directory') await walk(h, depth + 1);
			else if (name.indexOf(tag) === 0) found.push(name);
		}
	}
	try { await walk(await DaimondCloud.opfsRoot(), 0); } catch (e) { found.push('ERR ' + e); }
	return found;
}, tag).catch((e) => ['ERR ' + e]);

/// What turn `tid`'s rows on one device say.
function shape(ms, tid, tag) {
	const span = spanOf(ms, tid, tag);
	const rounds = {};
	span.filter((m) => m.role === 'tool_log').forEach((m) => {
		const g = /-(\d+)-call_/.exec(String(m.args || '') + String(m.content || ''));
		const n = g ? g[1] : '?';
		rounds[n] = (rounds[n] || 0) + 1;
	});
	const runs = [...new Set(span.filter((m) => m.run && m.why !== 'dispatched').map((m) => m.run))];
	return {
		rows: span.length,
		twice: Object.keys(rounds).filter((n) => rounds[n] > 1),
		tools: Object.keys(rounds).length,
		runs: runs.length,
		prov: span.filter((m) => m.provisional).length,
		lost: span.filter((m) => m.interrupted && m.why === 'runner').length,
		otherIntr: span.filter((m) => m.interrupted && m.why !== 'runner' && m.why !== 'dispatched').length,
		finals: span.filter((m) => m.role === 'assistant' && /Called \d+ time/.test(String(m.content || '')) && !m.provisional).length,
	};
}

/// B's `collect CLAIMED` diag rows: one per errand B took to run.
const claimsB = (b) => b.page.evaluate(() => { try { return window.DaimondDiag.rows().filter((r) => r.tag === 'collect CLAIMED').map((r) => String(r.data || '')); } catch (e) { return []; } }).catch(() => []);
/// The interrupted tile on `s`, or null.
const tileOf = (s) => s.page.evaluate(() => { const f = [...document.querySelectorAll('.turn-interrupted')].pop(); if (!f) return null;
	const l = f.querySelector('.ti-label'), btn = f.querySelector('button'); return { label: l ? l.textContent.slice(0, 90) : '', btn: btn ? btn.textContent : '' }; }).catch(() => null);
/// What the composer's button offers on `s` ('Stop', 'Send', ...).
const sendLabel = (s) => s.page.evaluate(() => { const b = document.querySelector('#chat-send'); return b ? String(b.getAttribute('aria-label') || b.title || '') : ''; }).catch(() => '');
const chatRows = (s, id) => s.page.evaluate(async (id) => { let g = null; try { g = await window.DaimondCore.chatStore().loadMessages(id); } catch (e) {} return (g && g.messages) || []; }, id).catch(() => []);
/// What one device holds of a retried turn: its finals, its user rows, the lost run's rows.
const view = (ms, tid, tag) => ({
	finals: ms.filter((m) => m && m.role === 'assistant' && !m.provisional && /Called \d+ time/.test(String(m.content || ''))).length,
	users:  ms.filter((m) => m && m.role === 'user' && String(m.content || '').includes(tag)).length,
	lost:   ms.filter((m) => m && m.interrupted && m.why === 'runner' && m.iturn === tid).length,
	prov:   ms.filter((m) => m && m.provisional).length,
});
/// Open chat `cid` on B, at a desktop's width.
async function openOnB(b, cid) {
	const sel = '.session-box.chat-box[data-id="' + cid + '"] .tile-label';
	for (let i = 0; i < 40; i++) { if (await b.page.$(sel)) break; await b.page.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull()).catch(() => {}); await b.page.waitForTimeout(500); }
	const there = !!(await b.page.$(sel)); if (there) await b.page.click(sel, { force: true }); await b.page.waitForTimeout(800); return there;
}

let a, b;
try {
	({ a, b } = await pair(check, 'rra' + Date.now().toString(36), 'rrb' + Date.now().toString(36)));
	for (const AT of ATS) {
		const tag = 'rr' + AT + Math.random().toString(36).slice(2, 7);
		console.log('\n── B reloads at round ' + AT + ' (' + tag + ') ──');
		const reqs = () => mockLog().filter((r) => JSON.stringify(r).includes(tag));
		const starts = () => reqs().filter((r) => { const m = msgsOf(r); const l = m[m.length - 1]; return l && l.role === 'user'; }).length;
		// B reloaded in the pass before, and A hands off only to a peer it sees awake: wait for
		// B's beat to reach A again, or the next pass runs on A and tests nothing.
		const awake = await a.page.waitForFunction(() => (window.DaimondPresence.awake(window.DaimondIdentity.deviceId(), Date.now()) || []).length >= 1,
			null, { timeout: 60000, polling: 500 }).then(() => true, () => false);
		if (!awake) console.log('  A sees no awake peer before this pass');
		await freshChat(a);
		// A chat may write only inside its own `chats/<id>/work` (the chat fence): a
		// workspace-root path is refused as an ordinary tool result and writes nothing.
		const cid = await a.page.evaluate(() => {
			const f = window.DaimondAttach && DaimondAttach.focus();
			return (f && f.kind === 'chat') ? String(f.id) : '';
		}).catch(() => '');
		const prompt = '@rounds ' + ROUNDS + '/' + PACE + ' file_write '
			+ JSON.stringify({ path: 'chats/' + cid + '/work/ctr/' + tag + '-{n}-{c}.txt', content: 'x' });
		// The ring is on for every pass: (4)'s F-B2 check reads B's `collect CLAIMED` rows,
		// which a ring left off never holds (it read [] for a Retry B did run).
		for (const s of [a, b]) await s.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true, 'verify')).catch(() => {});
		// DUMP: what each press on A landed on -- the r545 second pass sent nothing because the
		// press at Send's centre landed on the undo toast standing over it (verify_undo_clear).
		if (process.env.DUMP) await a.page.evaluate(() => {
			window.__presses = [];
			document.addEventListener('click', (e) => {
				const el = e.target && e.target.closest ? (e.target.closest('button') || e.target) : e.target;
				window.__presses.push(el ? (el.id ? '#' + el.id : el.outerHTML.slice(0, 160)) : null);
			}, true);
		}).catch(() => {});
		await send(a.page, prompt);
		let ph = null;
		for (let i = 0; i < 80 && !ph; i++) {
			ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(tag)) || null;
			if (!ph) await a.page.waitForTimeout(150);
		}
		check('A handed the turn off', !!ph, ph ? 'tid=' + ph.iturn : 'ran locally');
		if (!ph && process.env.DUMP) {
			const rows = await a.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : []).slice(-20)).catch((e) => ['ERR ' + e]);
			console.log('  A diag:\n' + rows.map((r) => '    ' + JSON.stringify(r).slice(0, 300)).join('\n'));
			const st = await a.page.evaluate(() => {
				const btn = document.querySelector('#chat-send');
				const r = btn ? btn.getBoundingClientRect() : null;
				const at = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
				return { input: (document.querySelector('#chat-input') || {}).value, busy: !!(btn && btn.disabled),
					atSend: !btn ? 'no #chat-send' : at && btn.contains(at) ? 'Send' : at ? at.outerHTML.slice(0, 160) : null,
					presses: window.__presses };
			}).catch((e) => 'ERR ' + e);
			console.log('  A state ' + JSON.stringify(st));
			const pl = await a.page.evaluate(() => {
				const n = Date.now(), ms = (v) => (v && v.toNumber) ? v.toNumber() : (+v || 0);
				const pres = window.DaimondPresence.snapshot() || {};
				const peers = Object.keys(pres).map((id) => { const r = pres[id] || {};
					return { id: id.slice(0, 8), busy: r.busy, beat: Math.round((n - ms(r.lastSeen)) / 1000), mv: r.mobileView, runner: r.runner }; });
				const ls = window.DaimondLease.snapshot() || {};
				const leases = Object.keys(ls.leases || ls).map((t) => { const r = (ls.leases || ls)[t] || {};
					return { t: t.slice(0, 10), h: String(r.holder || '').slice(0, 8), mode: r.mode, live: window.DaimondLease.holder(t) ? 1 : 0 }; });
				return { peers, leases };
			}).catch((e) => 'ERR ' + e);
			console.log('  A presence+leases ' + JSON.stringify(pl));
			const bs = await b.page.evaluate(() => {
				const n = Date.now(), ms = (v) => (v && v.toNumber) ? v.toNumber() : (+v || 0);
				const me = window.DaimondIdentity.deviceId(), r = (window.DaimondPresence.snapshot() || {})[me] || {};
				return { selfBusy: r.busy, selfBeat: Math.round((n - ms(r.lastSeen)) / 1000), core: window.DaimondCore.busy(),
					workers: (typeof Workers !== 'undefined' && Workers) ? Workers.active : 'n/a', vis: document.visibilityState,
					diag: (window.DaimondDiag ? DaimondDiag.rows() : []).filter((x) => !/store write|push size/.test(x.tag)).slice(-25)
						.map((x) => x.a + ' ' + x.tag + ': ' + String(x.data).slice(0, 160)) };
			}).catch((e) => 'ERR ' + e);
			console.log('  B state ' + JSON.stringify(bs, null, 1));
			const ms = (await storedMsgs(a)).filter((m) => m && (String(m.content || '').includes(tag) || String(m.itext || '').includes(tag)));
			console.log('  A rows with tag: ' + JSON.stringify(ms.map((m) => ({ r: m.role, it: m.iturn, why: m.why, pv: m.provisional, intr: m.interrupted }))));
		}
		if (!ph) continue;
		const tid = String(ph.iturn);
		let reached = false;
		for (const t = Date.now(); Date.now() - t < 60000 && !reached;) { reached = reqs().length >= AT + 1; if (!reached) await a.page.waitForTimeout(200); }
		check('B is running it at round ' + AT, reached, 'reqs=' + reqs().length);
		const atReload = reqs().length;
		await reload(b);
		console.log('  B reloaded; reqs=' + reqs().length + ' starts=' + starts());

		// Until A holds the turn's ending (badge or answer) and the model has gone quiet.
		let quiet = Date.now(), lastN = -1, ended = false;
		for (const t = Date.now(); Date.now() - t < WAIT;) {
			const n = reqs().length;
			if (n !== lastN) { lastN = n; quiet = Date.now(); }
			const sa = shape(await storedMsgs(a), tid, tag);
			ended = sa.lost > 0 || sa.finals > 0;
			if (ended && Date.now() - quiet > 3 * PACE + 4000) break;
			await a.page.waitForTimeout(1000);
		}
		await settle(a.page).catch(() => {});
		await a.page.waitForTimeout(3000);
		console.log('  END reqs=' + reqs().length + ' (at reload ' + atReload + ') starts=' + starts());
		if (process.env.DUMP) {
			const rows = await b.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : []).slice(-60)).catch((e) => ['ERR ' + e]);
			console.log('  B diag:\n' + rows.map((r) => '    ' + JSON.stringify(r).slice(0, 300)).join('\n'));
			console.log('  B console:\n' + b.logs.filter((l) => /peer|errand|lease|recover|interrupt|reconstruct/i.test(l)).slice(-40).map((l) => '    ' + l.slice(0, 300)).join('\n'));
		}

		// (1) the model.
		check('(1) the model saw the turn start once', starts() === 1, 'starts=' + starts());
		check('(1) no request after the reload beyond one in flight', reqs().length <= atReload + 1,
			'reqs=' + reqs().length + ' at reload ' + atReload);
		// (2) the side effects.
		const files = await counterFiles(b, tag);
		const per = {};
		files.forEach((f) => { const g = /-(\d+)-call_/.exec(f); const n = g ? g[1] : f; per[n] = (per[n] || 0) + 1; });
		const twice = Object.keys(per).filter((n) => per[n] > 1);
		check('(2) every round\'s side effect happened once', files.length > 0 && !twice.length,
			files.length + ' files; twice: ' + twice.join(',') + ' ' + JSON.stringify(files.slice(0, 14)));
		check('(2) [ctl] the rounds before the reload did write', Object.keys(per).length >= AT - 1, JSON.stringify(per));
		// (3) the rows.
		const sa = shape(await storedMsgs(a), tid, tag), sb = shape(await storedMsgs(b), tid, tag);
		console.log('  A ' + JSON.stringify(sa) + '\n  B ' + JSON.stringify(sb));
		for (const [n, s] of [['A', sa], ['B', sb]]) {
			check('(3) ' + n + ': each round\'s tool row once', s.tools > 0 && !s.twice.length, JSON.stringify(s));
			check('(3) ' + n + ': the turn\'s rows carry one run, none provisional', s.runs <= 1 && s.prov === 0, JSON.stringify(s));
		}
		// (4) the ending.
		check('(4) A: exactly one runner-interrupted answer, no other ending', sa.lost === 1 && sa.finals === 0 && sa.otherIntr === 0, JSON.stringify(sa));
		const tile = await a.page.evaluate(() => {
			const f = [...document.querySelectorAll('.turn-interrupted')].pop();
			if (!f) return null;
			const l = f.querySelector('.ti-label'), btn = f.querySelector('button');
			return { label: l ? l.textContent : '', btn: btn ? btn.textContent : '' };
		}).catch(() => null);
		check('(4) A draws "Interrupted" with a Retry button', !!tile && /Interrupted\. The device running this/.test(tile.label) && tile.btn === 'Retry',
			JSON.stringify(tile));
		await reload(a);
		await a.page.waitForTimeout(3000);
		const sa2 = shape(await storedMsgs(a), tid, tag);
		check('(3) A reloaded: one runner badge, no provisional, each round once', sa2.lost === 1 && sa2.prov === 0 && !sa2.twice.length, JSON.stringify(sa2));
		// Retry: the turn runs afresh, a new turn, to one answer.
		const clicked = await a.page.evaluate(() => {
			const f = [...document.querySelectorAll('.turn-interrupted')].pop();
			const btn = f && f.querySelector('button');
			if (!btn) return false;
			btn.click(); return true;
		}).catch(() => false);
		check('(4) Retry is there to press after a reload', clicked);
		const claims0 = clicked ? (await claimsB(b)).length : 0;
		let fin = null;
		// Read this pass's chat only: storedMsgs spans every chat, and the pass before left its
		// own "Called N times" answer, which read as this Retry's answer before it had run.
		const chatMsgs = () => a.page.evaluate(async (id) => {
			let got = null;
			try { got = await window.DaimondCore.chatStore().loadMessages(id); } catch (e) { got = null; }
			return (got && got.messages) || [];
		}, cid).catch(() => []);
		for (const t = Date.now(); clicked && Date.now() - t < WAIT && !fin;) {
			const ms = cid ? await chatMsgs() : await storedMsgs(a);
			const f = ms.filter((m) => m && m.role === 'assistant' && !m.provisional && /Called \d+ time/.test(String(m.content || '')));
			const userRows = ms.filter((m) => m && m.role === 'user' && String(m.content || '').includes(tag));
			const lostLeft = ms.filter((m) => m && m.interrupted && m.why === 'runner' && m.iturn === tid).length;
			if (f.length) fin = { finals: f.length, users: userRows.length, lostLeft };
			else await a.page.waitForTimeout(1000);
		}
		check('(4) Retry ran the turn afresh to one answer, the lost run gone', !!fin && fin.finals === 1 && fin.users === 1 && fin.lostLeft === 0,
			JSON.stringify(fin));
		// F-B2: B is the runner the switch names, so the Retry goes there, as a Send would.
		const claimed = (await claimsB(b)).slice(claims0);
		check('(4) F-B2: the Retry follows the switch and runs on the runner B', claimed.length >= 1, JSON.stringify(claimed) + (claimed.length ? '' : ' A diag: '
			+ JSON.stringify(await a.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : []).filter((r) => /dispatch|seat|nomin|retry|peer|auto/i.test(r.tag)).slice(-12).map((r) => r.tag + ' ' + String(r.data || '').slice(0, 120))).catch(() => []))));
		await settle(a.page).catch(() => {});
	}
	// (5) F-B1: RETRY ON BOTH DEVICES. A hands B a 6-round turn, B reloads at round 2, both
	// draw Interrupted + Retry; Retry is pressed on A and on B GAP ms later (if B still
	// offers it). Exactly one new model start, one user row and one final on both devices,
	// and B reads Stop, not Retry, while the retried turn runs.
	for (const MODE of MODES5) for (const G of GAPS) {
		const R5 = 6, P5 = 1500, AT5 = 2;
		// `stop`: a `here` pass where B, the device that lost the lease, presses the Stop it
		// draws (lead ruling): A's run must end. Once, at the first gap.
		if (MODE === 'stop' && G !== GAPS[0]) continue;
		const GAP = MODE === 'runner' ? G : MODE + ' ' + G;
		const tag = 'r5' + MODE[0] + G + Math.random().toString(36).slice(2, 6);
		console.log('\n── (5) ' + MODE + ': Retry on A, then on B ' + G + ' ms later (' + tag + ') ──');
		// The hand-off that is lost needs B as the runner; a `here` pass un-names it after.
		// Named again as its owner would (B is asked "Make this device the runner?" anew, and
		// that question left open sits over B's chat list), after a `here` pass un-named it.
		const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
		if (await a.page.evaluate(() => window.DaimondCore.roster.nominee() || '').catch(() => '') !== idB) await nominateRunner(check, a, b);
		const reqs = () => mockLog().filter((r) => JSON.stringify(r).includes(tag));
		const starts = () => reqs().filter((r) => { const m = msgsOf(r); const l = m[m.length - 1]; return l && l.role === 'user'; }).length;
		await a.page.waitForFunction(() => (window.DaimondPresence.awake(window.DaimondIdentity.deviceId(), Date.now()) || []).length >= 1, null, { timeout: 60000, polling: 500 }).catch(() => {});
		await freshChat(a);
		const cid = await a.page.evaluate(() => { const f = window.DaimondAttach && DaimondAttach.focus(); return (f && f.kind === 'chat') ? String(f.id) : ''; }).catch(() => '');
		await send(a.page, '@rounds ' + R5 + '/' + P5 + ' file_write ' + JSON.stringify({ path: 'chats/' + cid + '/work/ctr/' + tag + '-{n}-{c}.txt', content: 'x' }));
		let ph = null;
		for (let i = 0; i < 80 && !ph; i++) { ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(tag)) || null; if (!ph) await a.page.waitForTimeout(150); }
		check('(5) gap ' + GAP + ' [ctl] A handed the turn off', !!ph, 'ran locally');
		if (!ph) continue;
		const tid = String(ph.iturn);
		for (const t = Date.now(); Date.now() - t < 60000 && reqs().length < AT5 + 1;) await a.page.waitForTimeout(200);
		await reload(b);
		let tile = null;
		for (const t = Date.now(); Date.now() - t < 120000 && !(tile && tile.btn === 'Retry');) { tile = await tileOf(a); if (!(tile && tile.btn === 'Retry')) await a.page.waitForTimeout(1000); }
		await a.page.waitForTimeout(P5 * 3 + 2000);
		check('(5) gap ' + GAP + ' [ctl] A draws Interrupted + Retry', !!tile && tile.btn === 'Retry', JSON.stringify(tile));
		await openOnB(b, cid);
		let tb = null;
		for (const t = Date.now(); Date.now() - t < 30000 && !(tb && tb.btn === 'Retry');) { tb = await tileOf(b); if (!(tb && tb.btn === 'Retry')) await b.page.waitForTimeout(1000); }
		check('(5) gap ' + GAP + ' [ctl] B also draws Interrupted + Retry', !!tb && tb.btn === 'Retry', JSON.stringify(tb) + ' B holds ' + JSON.stringify(view(await chatRows(b, cid), tid, tag))
			+ ' B on ' + await b.page.evaluate(() => { const f = window.DaimondAttach && DaimondAttach.focus(); return f ? f.kind + ':' + f.id : ''; }).catch(() => '?') + ' cid ' + cid);
		if (MODE !== 'runner') {
			for (const s of [a, b]) await s.page.evaluate(() => window.DaimondCore.roster.nominate('')).catch(() => {});
			await a.page.waitForTimeout(1500);
			const noms = await Promise.all([a, b].map((s) => s.page.evaluate(() => window.DaimondCore.roster.nominee() || '').catch(() => '?')));
			check('(5) ' + GAP + ' [ctl] nobody is nominated on A or B', noms.every((n) => !n), JSON.stringify(noms));
		}
		const s0 = starts(), c5 = (await claimsB(b)).length;
		let pressed = '';
		let stopB = false, retryB = false, va = null, why5 = '';
		// Who held the retried turn's lease, sampled on A while it ran: the runner B in a
		// `runner` pass (F-B2), and exactly one device in a `here` pass.
		const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());
		const held = new Set();
		const sampleHolder = async () => {
			const h = await a.page.evaluate((t) => (window.DaimondLease && DaimondLease.holder(t + '-rt')) || '', tid).catch(() => '');
			if (h) held.add(h === idB ? 'B' : h === idA ? 'A' : 'other');
		};
		const tA = Date.now();
		await a.page.locator('.turn-interrupted button').last().click({ timeout: 4000 }).then(() => { pressed += 'A '; }).catch(() => { pressed += 'Ax '; });
		// B reads Stop from the press on (a long gap can outlast the retried run itself).
		while (Date.now() - tA < G) { if (/stop/i.test(await sendLabel(b))) stopB = true; await sampleHolder(); await b.page.waitForTimeout(200); }
		let tStop = 0, aEnd = 0;
		const rq0 = reqs().length;
		if (MODE === 'stop') {
			for (const t = Date.now(); Date.now() - t < 20000 && !stopB;) { if (/stop/i.test(await sendLabel(b))) stopB = true; else { await sampleHolder(); await b.page.waitForTimeout(200); } }
			if (stopB) await b.page.locator('#chat-send').click({ timeout: 2000 }).then(() => { pressed += 'B-Stop '; tStop = Date.now(); }).catch(() => { pressed += 'B-Stopx '; });
		} else if (((await tileOf(b)) || {}).btn === 'Retry') await b.page.locator('.turn-interrupted button').last().click({ timeout: 2000 }).then(() => { pressed += 'B '; }).catch(() => { pressed += 'Bx '; });
		else pressed += '(B offers no Retry) ';
		// While the retried turn runs: B reads Stop and offers no Retry.
		for (const t = Date.now(); Date.now() - t < 120000;) {
			if (/stop/i.test(await sendLabel(b))) stopB = true;
			await sampleHolder();
			// A Retry button, not any footer: a hand-off's own footer shares the class.
			if (tStop && Date.now() - tStop > 1500 && !/stop/i.test(await sendLabel(a))) { aEnd = Date.now(); break; }
			if (MODE !== 'stop' && Date.now() - tA > G + 4000 && ((await tileOf(b)) || {}).btn === 'Retry' && !retryB) {
				retryB = true;
				why5 = JSON.stringify({ tile: await tileOf(b), data: view(await chatRows(b, cid), tid, tag),
					cur: await b.page.evaluate(() => { const f = window.DaimondAttach && DaimondAttach.focus(); return f ? f.kind + ':' + f.id : ''; }).catch(() => '?'), cid }) + ' ' + JSON.stringify(await b.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : []).slice(-25).map((r) => r.tag + ' ' + String(r.data || '').slice(0, 90))).catch(() => []));
			}
			va = view(await chatRows(a, cid), tid, tag);
			if (va.finals >= 1) break;
			await a.page.waitForTimeout(500);
		}
		let quiet = Date.now(), lastN = -1;
		for (const t = Date.now(); Date.now() - t < 40000;) { const n = reqs().length; if (n !== lastN) { lastN = n; quiet = Date.now(); } if (Date.now() - quiet > 12000) break; await a.page.waitForTimeout(1000); }
		await settle(a.page).catch(() => {});
		await openOnB(b, cid);
		await b.page.waitForTimeout(4000);
		va = view(await chatRows(a, cid), tid, tag);
		const vb = view(await chatRows(b, cid), tid, tag);
		console.log('  pressed: ' + pressed + ' starts ' + s0 + '->' + starts() + ' A ' + JSON.stringify(va) + ' B ' + JSON.stringify(vb)
			+ ' claimedOnB ' + ((await claimsB(b)).length - c5) + ' held ' + [...held].join(',') + (why5 ? '\n  B diag at the stale Retry: ' + why5 : ''));
		check('(5) gap ' + GAP + ': the retried turn ran on ' + (MODE === 'runner' ? 'the runner B (F-B2)' : 'one device'),
			MODE === 'runner' ? held.size === 1 && held.has('B') : held.size === 1, [...held].join(','));
		if (MODE === 'stop') {
			check('(5) stop: B, which lost the lease, read Stop and pressed it', stopB && tStop > 0, 'pressed ' + pressed);
			check('(5) stop: A\'s run ended within 15 s of B\'s Stop', aEnd > 0 && aEnd - tStop < 15000, 'ended ' + (aEnd ? (aEnd - tStop) + ' ms' : 'never'));
			check('(5) stop: the run made fewer than its ' + R5 + ' rounds', reqs().length - rq0 < R5, 'requests ' + (reqs().length - rq0));
			await reload(a); await reload(b); await a.page.waitForTimeout(8000);
			check('(5) stop: no further model start after B\'s Stop and both reloads', starts() === s0 + 1, 'starts ' + s0 + '->' + starts());
			continue;
		}
		check('(5) gap ' + GAP + ': Retry made exactly one new model start', starts() === s0 + 1, 'starts ' + s0 + '->' + starts() + ' pressed ' + pressed);
		check('(5) gap ' + GAP + ': A holds one final, one user row, the lost run gone', va.finals === 1 && va.users === 1 && va.lost === 0 && va.prov === 0, JSON.stringify(va));
		check('(5) gap ' + GAP + ': B holds one final, one user row, the lost run gone', vb.finals === 1 && vb.users === 1 && vb.lost === 0, JSON.stringify(vb));
		check('(5) gap ' + GAP + ': B read Stop while the retry ran, and no Retry', stopB && !retryB, 'stop=' + stopB + ' retryLeft=' + retryB);
		await reload(a); await reload(b); await a.page.waitForTimeout(8000);
		const va2 = view(await chatRows(a, cid), tid, tag), vb2 = view(await chatRows(b, cid), tid, tag);
		check('(5) gap ' + GAP + ': after both reload, one final and one user row on each', va2.finals === 1 && va2.users === 1 && vb2.finals <= 1 && vb2.users <= 1 && va2.lost + vb2.lost === 0,
			JSON.stringify({ a: va2, b: vb2 }));
		check('(5) gap ' + GAP + ': no further model start after the reloads', starts() === s0 + 1, 'starts=' + starts());
	}

	// (6) R3 F1 (lead ruling a): A's Stop on a turn B runs ends it as a Stop pressed on B
	// would: B's partial (the rounds it ran) is kept and marked stopped by the person, on
	// both devices, and nothing runs again. Folded in from the QA-A probe's `stop` arm.
	if (String(process.env.ARM6 ?? '1') === '1') {
		const tag = 'r6' + Math.random().toString(36).slice(2, 7);
		console.log('\n── (6) A stops the turn B runs (' + tag + ') ──');
		const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
		if (await a.page.evaluate(() => window.DaimondCore.roster.nominee() || '').catch(() => '') !== idB) await nominateRunner(check, a, b);
		const reqs = () => mockLog().filter((r) => JSON.stringify(r).includes(tag));
		const starts = () => reqs().filter((r) => { const m = msgsOf(r); const l = m[m.length - 1]; return l && l.role === 'user'; }).length;
		await freshChat(a);
		const cid = await a.page.evaluate(() => { const f = window.DaimondAttach && DaimondAttach.focus(); return (f && f.kind === 'chat') ? String(f.id) : ''; }).catch(() => '');
		await send(a.page, '@rounds 12/1500 file_write ' + JSON.stringify({ path: 'chats/' + cid + '/work/ctr/' + tag + '-{n}-{c}.txt', content: 'x' }));
		let ph = null;
		for (let i = 0; i < 80 && !ph; i++) { ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(tag)) || null; if (!ph) await a.page.waitForTimeout(150); }
		check('(6) [ctl] A handed the turn off', !!ph, 'ran locally');
		if (ph) {
			const tid = String(ph.iturn);
			for (const t = Date.now(); Date.now() - t < 60000 && reqs().length < 4;) await a.page.waitForTimeout(200);
			const running = await b.page.evaluate((t) => { const r = DaimondLease.record(t); return !!r && r.mode === 'running' && r.holder === DaimondIdentity.deviceId(); }, tid).catch(() => false);
			check('(6) [ctl] B runs the turn before the stop', running && reqs().length >= 4, 'reqs ' + reqs().length);
			const lab = await sendLabel(a);
			await a.page.click('#chat-send', { force: true });
			const t0 = Date.now(), r0 = reqs().length;
			let ended = 0;
			for (; Date.now() - t0 < 20000 && !ended;) { const r = await b.page.evaluate((t) => { const x = DaimondLease.record(t); return !x || x.mode !== 'running'; }, tid).catch(() => false); if (r) ended = Date.now(); else await a.page.waitForTimeout(200); }
			await a.page.waitForTimeout(6000);
			check('(6) A read Stop, and B left the run within 15 s of it', /stop/i.test(lab) && ended > 0 && ended - t0 < 15000, 'label ' + lab + ' ended ' + (ended ? ended - t0 + ' ms' : 'never'));
			check('(6) the run made no request after it stopped beyond one in flight', reqs().length - r0 <= 1, 'after ' + (reqs().length - r0));
			const shape = (ms) => { const sp = spanOf(ms, tid, tag); return {
				ends: sp.filter((m) => m.role === 'end_log').map((m) => m.how + '/' + (m.why || '')),
				ran: sp.filter((m) => m.role === 'tool' || m.role === 'tool_log' || (m.role === 'assistant' && !m.provisional && !m.why)).length,
				intr: sp.filter((m) => m.interrupted).length, prov: sp.filter((m) => m.provisional).length }; };
			let sa = null;
			for (const t = Date.now(); Date.now() - t < 40000;) { sa = shape(await chatRows(a, cid)); if (sa.ends.length) break; await a.page.waitForTimeout(1000); }
			const sb = shape(await chatRows(b, cid));
			console.log('  (6) A ' + JSON.stringify(sa) + ' B ' + JSON.stringify(sb));
			for (const [n, s] of [['A', a], ['B', b]]) {
				const ms = await chatRows(s, cid);
				console.log('  (6) ' + n + ' rows: ' + JSON.stringify(ms.slice(-14).map((m) => m && ({ r: m.role, it: m.iturn, why: m.why, how: m.how, pv: m.provisional, intr: m.interrupted, c: String(m.content || '').slice(0, 40) }))));
			}
			check('(6) A keeps B\'s partial, marked stopped by the person (as a local Stop)', sa.ran >= 1 && sa.ends.length === 1 && sa.ends[0] === 'stopped/user' && sa.intr === 0 && sa.prov === 0, JSON.stringify(sa));
			check('(6) B holds the same stopped partial', sb.ran >= 1 && sb.ends.length === 1 && sb.ends[0] === 'stopped/user', JSON.stringify(sb));
			check('(6) both composers read Send', !/stop/i.test(await sendLabel(a)) && !/stop/i.test(await sendLabel(b)), (await sendLabel(a)) + ' / ' + (await sendLabel(b)));
			await reload(a); await reload(b); await a.page.waitForTimeout(8000);
			const sa2 = shape(await chatRows(a, cid));
			check('(6) after both reload: the stopped partial stands on A and nothing ran again', sa2.ends.length === 1 && sa2.ends[0] === 'stopped/user' && starts() === 1, JSON.stringify(sa2) + ' starts ' + starts());
		}
	}
} catch (e) {
	check('verifier ran', false, String(e && e.stack || e).slice(0, 600));
} finally {
	for (const s of [a, b]) { try { await s?.close(); } catch (e) { /* gone */ } }
	console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + JSON.stringify(bad) : ''));
	guardRan(ok.length + bad.length);
	process.exit(bad.length ? 1 : 0);
}
