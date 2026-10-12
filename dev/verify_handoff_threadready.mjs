// gateway: live
// verify_handoff_threadready.mjs — a hand-off carries the thread the sender holds, and a runner
// that cannot rebuild it hands the turn back at once (D2, THREAD-READY, 11 Oct).
//
// WHAT HAPPENED. A Diamond's other face set `current` to its daimon chat without loading the
// transcript, so a send from there fingerprinted a thread of none ("7 of 0"). The runner
// claimed the turn, pulled toward a thread it could never match, and held it until its stall
// clock ran out -- which the sender's own unrelated pushes kept resetting. The owner's turn sat
// on "Sent to your other devices" for minutes, then ran here as "hand-off didn't finish".
//
// THE PROPERTIES (A the sender, a desktop armed to hand every turn to B; B the runner):
//
//   (a) FACE      A reloads, shows the Diamond's other face, and sends. The errand's thread
//                 counts what A holds; B runs it, or refuses at once and A runs it here.
//                 Needs OPFS (a Diamond's workspace): skipped where the engine lacks it.
//   (b) MISMATCH  An errand whose thread can never match (injected on A) is handed back
//                 inside 5 s of B collecting it, with no claim, and A runs the turn once.
//   (c) HEALTHY   A plain hand-off still runs on B, carrying the thread A stored.
//   (d) READABLE  The answer's tile on A names the cause, every character shown, at the column's width (it wraps, never ellipsises).
//
// Engine: DAIMOND_BROWSER (chromium default, webkit). Needs the dev stack and Pro.
//   node dev/verify_handoff_threadready.mjs

import {
	checker,
	pair,
	until,
	settle,
	storedMsgs,
	answersFor,
	modelSaw,
	sendDesk,
	freshChat,
	reload,
} from './handoffpair.mjs';
import { BROWSER } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const HANDBACK_MS = 5000;		// (b) collect -> hand-back noted on A
const ANSWER_MS   = 60000;		// any turn's answer reaching A
const LINE_RE     = /^Ran here — .+ didn’t have the whole conversation$/;
const { ok, bad, check } = checker();
const tag = Math.random().toString(36).slice(2, 7);

/// Diag rows on a page whose tag matches `re` and whose data names `needle`.
const rowsOf = (s, re, needle) => s.page.evaluate(([src, n]) => {
	const r = new RegExp(src);
	try { return window.DaimondDiag.rows().filter((x) => r.test(String(x.tag)) && (!n || String(x.data).includes(n)))
		.map((x) => ({ ts: x.ts, tag: String(x.tag), data: String(x.data).slice(0, 220) })); } catch (e) { return []; }
}, [re.source, needle || '']).catch(() => []);

/// Wrap A's buildDispatch to record each plan's thread, and, with `inject`, send that thread instead.
const capture = (s, inject) => s.page.evaluate((inj) => {
	const P = window.DaimondPeer;
	if (!P.__trOrig) P.__trOrig = P.buildDispatch;
	window.__trThreads = [];
	P.buildDispatch = function (c, o) {
		const oo = inj ? Object.assign({}, o, { thread: inj }) : o;
		const plan = P.__trOrig.call(this, c, oo);
		try {
			const e = plan.errand(0);
			window.__trThreads.push({ turn: String(o && o.turnId || ''), n: e.thread ? e.thread.n : -1,
				loaded: c ? c._loaded !== false : null });
		} catch (err) { window.__trThreads.push({ err: String(err) }); }
		return plan;
	};
}, inject || null);
const uncapture = (s) => s.page.evaluate(() => {
	const P = window.DaimondPeer;
	if (P.__trOrig) { P.buildDispatch = P.__trOrig; delete P.__trOrig; }
	return window.__trThreads || [];
}).catch(() => []);

/// A Diamond's daimon chat as A holds it in memory (a daimon chat is not in the store's list).
const diaMsgs = (s, did) => s.page.evaluate((d) => {
	try { const c = window.DaimondDiamond.conversation(d); return (c && c.messages) ? JSON.parse(JSON.stringify(c.messages)) : []; }
	catch (e) { return []; }
}, did).catch(() => []);

/// The dispatched turn id of the newest user row carrying `needle` on A.
async function turnOf(a, needle, dia = '') {
	for (let i = 0; i < 80; i++) {
		const ms = dia ? await diaMsgs(a, dia) : await storedMsgs(a);
		const u = ms.filter((m) => m && m.role === 'user' && String(m.content || '').includes(needle)).pop();
		if (u && u.iturn) return String(u.iturn);
		const ph = ms.find((m) => m && m.why === 'dispatched' && String(m.itext || '').includes(needle));
		if (ph) return String(ph.iturn);
		await a.page.waitForTimeout(250);
	}
	return '';
}

/// The answer to turn `tid` on A, once it is there.
async function answerOf(a, tid, ms = ANSWER_MS, dia = '') {
	for (const t0 = Date.now(); Date.now() - t0 < ms;) {
		const got = tid ? answersFor(dia ? await diaMsgs(a, dia) : await storedMsgs(a), tid)[0] : null;
		if (got) return got;
		await a.page.waitForTimeout(500);
	}
	return null;
}

/// The model-facing count of A's stored thread for turn `tid` (the new user row included).
const storedN = (a, tid, chatId = '') => a.page.evaluate(async ([t, cid]) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of (cid ? [{ id: cid }] : cs.stored())) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		const ms = (got && got.messages) || [];
		if (!ms.some((m) => m && String(m.iturn) === t)) continue;
		return window.DaimondPeer.threadSig({ messages: ms }, t).n;
	}
	return -1;
}, [tid, chatId]).catch(() => -1);

/// The hand-off tiles' header lines on A, as the person reads them.
/// Each is its text and whether it sits on one line, unclipped.
const tileLines = (a) => a.page.evaluate(() => Array.from(document.querySelectorAll('#chat-output .chat-msg-handoff'))
	.map((x) => {
		const h = x.querySelector('.ctile-who') || x;
		const lh = parseFloat(getComputedStyle(h).lineHeight) || 20;
		const r = h.getBoundingClientRect();
		// The column the tile sits in: the thread's content box less the tile's own side margins (its indent).
		const co = document.getElementById('chat-output'), cs = getComputedStyle(x);
		const col = co ? co.clientWidth - parseFloat(getComputedStyle(co).paddingLeft) - parseFloat(getComputedStyle(co).paddingRight)
			- parseFloat(cs.marginLeft) - parseFloat(cs.marginRight) : 0;
		const tw = x.getBoundingClientRect().width;
		// Readable: every character shown (nothing clipped or ellipsised), and the tile takes the column's width.
		return { text: (h.textContent || '').trim(), one: h.scrollWidth <= h.clientWidth + 1 && Math.abs(tw - col) <= 2,
			dim: 'h=' + Math.round(r.height) + '/lh=' + lh + ' sw=' + h.scrollWidth + ' cw=' + h.clientWidth + ' vw=' + innerWidth + ' col=' + Math.round(col)
				+ ' lbl=' + Array.from((h.parentElement || h).children).map((k) => k.className + ':' + Math.round(k.getBoundingClientRect().width)).join(',')
				+ ' tile=' + Math.round(x.getBoundingClientRect().width) };
	}))
	.catch(() => []);

/// (d): the newest hand-off tile names the thread cause, readable at the column width.
async function oneLine(a, label) {
	let lines = [];
	for (let i = 0; i < 20; i++) {
		lines = await tileLines(a);
		if (lines.some((l) => LINE_RE.test(l.text))) break;
		await a.page.waitForTimeout(250);
	}
	const hit = lines.filter((l) => LINE_RE.test(l.text));
	check('(d) ' + label + ': the tile says why, readable at the column width', hit.length >= 1 && hit[0].one,
		(hit[0] ? hit[0].text + (hit[0].one ? '' : ' [clipped or narrower than its column: ' + hit[0].dim + ']') : lines.map((l) => l.text).join(' | ') || 'no hand-off tile').slice(0, 600));
}

let a, b;
try {
	({ a, b } = await pair(check, 'trlead', 'trmate', { openA: { touch: false } }));
	const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	for (const s of [a, b]) await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'threadready'); } catch (e) { /* none */ } });
	const hasOpfs = await a.page.evaluate(() => { try { return !!(navigator.storage && navigator.storage.getDirectory); } catch (e) { return false; } });
	console.log('engine ' + BROWSER + ', OPFS ' + (hasOpfs ? 'yes' : 'no'));

	// ── (a) setup: a Diamond whose daimon has turns, made while A still runs its own ──
	let diaId = '';
	if (hasOpfs) {
		console.log('\n(a) setup: a Diamond with three local daimon turns on A');
		await a.page.setViewportSize({ width: 1280, height: 900 });
		await a.page.waitForSelector('#new-diamond-btn', { timeout: 10000 }).catch(() => {});
		await a.page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await a.page.waitForSelector('.dlg-card', { timeout: 8000 }).catch(() => {});
		await a.page.evaluate(() => {
			const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
			const inp = card.querySelector('input.dlg-input');
			inp.value = 'ThreadFace';
			inp.dispatchEvent(new Event('input', { bubbles: true }));
			card.querySelector('.dlg-ok').click();
		});
		for (let i = 0; i < 30 && !diaId; i++) {
			diaId = await a.page.evaluate(() => { const c = window.DaimondDiamond.current(); return c ? c.id : ''; });
			if (!diaId) await a.page.waitForTimeout(300);
		}
		check('(a) a Diamond is current on A', !!diaId, diaId);
		await a.page.$('#dview-chat').then((el) => el && el.click({ force: true })).catch(() => {});
		await a.page.waitForTimeout(400);
		for (let k = 1; k <= 3; k++) {
			const p = 'face turn ' + k + ' ' + tag;
			await sendDesk(a.page, p);
			const tid = '';
			let ans = false;
			for (const t0 = Date.now(); !ans && Date.now() - t0 < 40000;) {
				const ms = await diaMsgs(a, diaId);
				const at = ms.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(p));
				ans = at >= 0 && ms.slice(at + 1).some((m) => m && m.role === 'assistant' && String(m.content || '').trim());
				if (!ans) await a.page.waitForTimeout(500);
			}
			if (!ans) {
				const ms = await diaMsgs(a, diaId);
				check('(a) daimon turn ' + k + ' answered on A', false, 'turn=' + tid + ' rows=' + JSON.stringify(ms.slice(-4).map((m) =>
					[m.role, String(m.iturn || ''), String(m.why || ''), String(m.content || '').slice(0, 40)])));
				break;
			}
		}
		await settle(a.page);
		await a.page.evaluate(() => window.DaimondSync.push && window.DaimondSync.push()).catch(() => {});
		await b.page.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull(true)).catch(() => {});
		const bHas = await until(b.page, (d) => { try { return !!window.DaimondDiamond.conversation(d); } catch (e) { return false; } }, diaId, 20000);
		check('(a) the Diamond reached B', bHas);
	} else {
		console.log('\n(a) SKIPPED on ' + BROWSER + ': no OPFS here, so no Diamond (run it under chromium)');
	}

	// ARM A: every turn goes to B. `pair` nominated B, the one route off A since
	// D-20261009-23; the step-away posture is kept as verify_daimon_handoff keeps it.
	await a.page.evaluate(() => { try { localStorage.setItem('daimond-handoff-when-away', '1'); } catch (e) { /* none */ } });
	const beat = async () => {
		await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'trmate')).catch(() => {});
		await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await a.page.waitForTimeout(1000);
	};
	await beat();

	// ── (c) A healthy hand-off still runs on B, with the thread A stored ──
	console.log('\n(c) a healthy hand-off');
	await freshChat(a);
	const pc0 = 'healthy one ' + tag;
	await sendDesk(a.page, pc0);					// a first turn, so the thread is more than one row
	const tc0 = await turnOf(a, pc0);
	await answerOf(a, tc0);
	await beat();
	await capture(a, null);
	const pc = 'healthy two ' + tag;
	await sendDesk(a.page, pc);
	const tc = await turnOf(a, pc);
	const ansC = await answerOf(a, tc);
	const thrC = (await uncapture(a)).filter((x) => x.turn === tc).pop();
	check('(c) the turn ran on B', !!ansC && String(ansC.ranOn || '') === idB,
		ansC ? 'ranOn=' + String(ansC.ranOn || '').slice(0, 8) : 'no answer in ' + ANSWER_MS + 'ms');
	const nC = await storedN(a, tc);
	check('(c) its errand carried the thread A stored', !!thrC && thrC.n === nC && nC > 1, 'errand n=' + (thrC ? thrC.n : '?') + ' stored n=' + nC);
	check('(c) the model saw it once', modelSaw(pc) === 1, 'seen ' + modelSaw(pc));

	// ── (b)+(d) A thread that can never match comes back at once ──
	console.log('\n(b) an injected thread mismatch');
	await beat();
	await capture(a, { n: 0, sig: 0 });
	const pb = 'mismatch ' + tag;
	const sentB = Date.now();
	await sendDesk(a.page, pb);
	const tb = await turnOf(a, pb);
	const handed = tb ? await until(a.page, (t) => {
		try { return window.DaimondDiag.rows().some((r) => r.tag === 'handoff handback noted' && String(r.data).includes(t)); } catch (e) { return false; }
	}, tb, 60000) : false;
	await uncapture(a);
	const colB  = (await rowsOf(b, /^collect age$/, tb))[0];
	const backA = (await rowsOf(a, /^handoff handback noted$/, tb))[0];
	const took  = (await rowsOf(b, /^collect CLAIMED$/, tb)).length;
	const span  = colB && backA ? backA.ts - colB.ts : -1;
	check('(b) B handed it back inside ' + HANDBACK_MS / 1000 + ' s of collecting it', handed && span >= 0 && span <= HANDBACK_MS,
		handed ? (span >= 0 ? span + 'ms after collect, ' + (backA.ts - sentB) + 'ms after send' : 'no collect row on B') : 'no hand-back in 60 s');
	check('(b) B never claimed it', took === 0, took + ' claim(s)');
	const ansB = await answerOf(a, tb);
	check('(b) A ran it here', !!ansB && String(ansB.ranOn || '') === idA, ansB ? 'ranOn=' + String(ansB.ranOn || '').slice(0, 8) : 'no answer');
	check('(b) the model saw it once', modelSaw(pb) === 1, 'seen ' + modelSaw(pb));
	await oneLine(a, '(b)');

	// ── (a)+(d) The send from the Diamond's other face, after a reload ──
	if (hasOpfs && diaId) {
		console.log('\n(a) a send from the Diamond\'s other face after a reload');
		// Open the Diamond on its crystal face, as the person left it, then reload: the boot comes
		// back to it, and its daimon chat is a summary until something loads it.
		await a.page.setViewportSize({ width: 1280, height: 900 });
		await a.page.evaluate((d) => { const x = document.querySelector('.diamond-box[data-id="' + d + '"]'); if (x) x.click(); }, diaId);
		await a.page.waitForTimeout(1200);
		await a.page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
		await a.page.waitForTimeout(800);
		await reload(a);
		await a.page.setViewportSize({ width: 1280, height: 900 });
		await a.page.waitForFunction((d) => { try { const c = window.DaimondDiamond.current(); return !!c && c.id === d; } catch (e) { return false; } },
			diaId, { timeout: 20000 }).catch(() => {});
		await a.page.waitForTimeout(1500);
		await a.page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c && c.getAttribute('aria-pressed') !== 'true') c.click(); });
		await a.page.waitForTimeout(800);
		for (const s of [a]) await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'threadready'); } catch (e) { /* none */ } });
		const face = await a.page.evaluate((d) => {
			const c = window.DaimondDiamond.conversation(d);
			const cb = document.getElementById('dview-crystal');
			return { id: c ? c.id : '', loaded: c ? c._loaded !== false : null,
				crystal: !!cb && cb.getAttribute('aria-pressed') === 'true',
				cur: (window.DaimondDiamond.current() || {}).id || '' };
		}, diaId).catch((e) => ({ err: String(e) }));
		check('(a) A shows the Diamond\'s crystal face, its daimon chat not resident', face.crystal && face.loaded === false && face.cur === diaId,
			JSON.stringify(face));
		await beat();
		await capture(a, null);
		const pa = 'face send ' + tag;
		const sentA = Date.now();
		await a.page.evaluate((t) => {
			const i = document.getElementById('chat-input');
			i.value = t; i.dispatchEvent(new Event('input', { bubbles: true }));
			document.getElementById('chat-send').click();
		}, pa);
		const ta = await turnOf(a, pa, diaId);
		const ansA = await answerOf(a, ta, 90000, diaId);
		const thrA = (await uncapture(a)).filter((x) => x.turn === ta).pop();
		const nA = await storedN(a, ta, face.id);
		check('(a) the errand counted the thread A holds', !!thrA && thrA.n === nA && nA >= 4,
			'errand n=' + (thrA ? thrA.n : '?') + ' stored n=' + nA + (thrA ? ' loaded=' + thrA.loaded : ''));
		const ranB = !!ansA && String(ansA.ranOn || '') === idB;
		const ranA = !!ansA && String(ansA.ranOn || '') === idA;
		const quick = ansA ? (ansA.ts || Date.now()) - sentA : -1;
		check('(a) B ran it, or A ran it here at once', ranB || (ranA && quick <= 30000),
			ansA ? 'ranOn=' + (ranB ? 'B' : ranA ? 'A' : String(ansA.ranOn || '?').slice(0, 8)) + ' at +' + quick + 'ms' : 'no answer in 90 s');
		check('(a) the model saw it once', modelSaw(pa) === 1, 'seen ' + modelSaw(pa));
		if (ranA) {
			await a.page.$('#dview-chat').then((el) => el && el.click({ force: true })).catch(() => {});
			await oneLine(a, '(a)');
		}
	}
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	if (bad.length && a && b) {
		for (const [n, s] of [['A', a], ['B', b]]) {
			for (const r of (await rowsOf(s, /handoff|handback|collect|ready|reconstruct|dispatch|fallback|local/)).slice(-30)) {
				console.log('  ' + n + ' .. ' + r.tag + ' | ' + r.data);
			}
		}
	}
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
