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
} from './handoffpair.mjs';
import { mockLog } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const { ok, bad, check } = checker();
const ROUNDS = Number(process.env.ROUNDS || 10), PACE = Number(process.env.PACE || 1500);
const ATS = String(process.env.AT || '3 5').split(/\s+/).filter(Boolean).map(Number);
const WAIT = Number(process.env.WAIT || 120) * 1000;
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
		if (process.env.DUMP) for (const s of [a, b]) await s.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true, 'verify')).catch(() => {});
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
		await settle(a.page).catch(() => {});
	}
} catch (e) {
	check('verifier ran', false, String(e && e.stack || e).slice(0, 600));
} finally {
	for (const s of [a, b]) { try { await s?.close(); } catch (e) { /* gone */ } }
	console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + JSON.stringify(bad) : ''));
	guardRan(ok.length + bad.length);
	process.exit(bad.length ? 1 : 0);
}
