// gateway: live
// verify_handoff_permit.mjs — a handed-off turn's permit is asked on the device it came from.
//
// CONSENT-ROUTE (10 Oct). A daimon turn sent from the phone A runs on the desktop B. When it
// needs a place to write, a toolkit or (in the Ask mode) a command run, the question used to
// open as a dialog on B, where nobody is, and the turn waited on an empty room. Now B asks
// A, and only A: a third device C with the chat open sees the question but cannot answer it.
//
// Three real contexts: A a Chromium phone emulation (iPhone UA, touch), B the Chromium runner,
// C a third Chromium desktop. A Diamond is made on A, synced, and A steers its daimon with
// mock presets that make one tool call each. The arms, named as the coordinator ruled them:
//
//   (1)  the ask opens on A and never on B or C (and C's answer, forged as its footer would
//        post it, authorises nothing);
//   (2)  the answering device writes only that ask's grant: a toolkit yes adds only the kits
//        asked for, a place or run yes writes no holds link and no marks-here entry anywhere;
//   (3a) Not now: "You said no." on A, no grant;
//   (3b) silence: "Your other device didn't answer in time." on A, no grant, after the
//        unchanged 60 s deadline (measured once);
//   (3c) Retry asks again, and Allow then lets the write proceed, the answer landing once;
//   (4)  toolkit and run, as well as place;
//   (5)  control: a turn on B that was not handed off draws the same dialog and writes the
//        same mark as on 075723c9;
//   (7)  B already allows the place or the kit: no ask anywhere.
//
//   MIX=A547 / MIX=B547 serve the r547 (075723c9) www to A or B (DAIMOND_OLD_WWW) and run arm
//   (6) alone: no crash, never a grant, and "Could not ask on your other device." where it
//   applies. C is not opened then.
//
//	node dev/verify_handoff_permit.mjs
//	MIX=A547 DAIMOND_OLD_WWW=<r547 tree>/www node dev/verify_handoff_permit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { open, signInAs, connectMock, newChat, chat, mockLog, clearMockLog, contentText } from './harness.mjs';
import { armFilter, guardRan } from './verdict.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const MIX = process.env.MIX || '';
if (MIX && MIX !== 'A547' && MIX !== 'B547' && MIX !== 'C547') { console.error('MIX is A547, B547 or C547'); process.exit(2); }
// PERMIT_ARMS=fix runs only the review-fix arms (P1-P3, F3, B-F9, RA3) after the setup; PERMIT_ONLY names some.
const ARMS = process.env.PERMIT_ARMS || '';
const on   = armFilter('PERMIT_ONLY');	// PERMIT_ONLY=P1,F3 … runs only the arms named
const OLD = process.env.DAIMOND_OLD_WWW || '';
if (MIX && !OLD) { console.error('MIX needs DAIMOND_OLD_WWW'); process.exit(2); }
const APP = process.env.DAIMOND_APP || 'http://localhost:' + (process.env.DAIMOND_PORT || 8777);
const FAST = !!process.env.PERMIT_FAST;	// skip the 60 s timeout measurement (dev iteration only)

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ..   ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The old page is served from the app's own address (see verify_handoff_mixrace.mjs for why
// Local Network Access checks are off and service workers blocked).
const oldOpen = {
	serviceWorkers: 'block',
	extraArgs: ['--disable-features=LocalNetworkAccessChecks'],
	route: async (page) => {
		await page.route((u) => u.origin === new URL(APP).origin && !u.pathname.startsWith('/api'), (r) => {
			let p = decodeURIComponent(new URL(r.request().url()).pathname);
			if (p.endsWith('/')) p += 'index.html';
			const f = path.join(OLD, p);
			if (f.startsWith(OLD) && fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ path: f });
			return r.continue();
		});
	},
};

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
	+ 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const ready = (pg) => pg.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
	&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());

/// Record every envelope a page seals (asks and grants, in the clear), every trail line, and
/// every dialog it opens, so each arm can say what happened where.
const instrument = (pg) => pg.evaluate(() => {
	if (window.__pv) return;
	window.__pv = { sealed: [], trail: [], dlgs: 0 };
	const P = window.DaimondPeer;
	if (P && P.sealForSelf) {
		const o = P.sealForSelf.bind(P);
		P.sealForSelf = function (x) {
			try {
				if (x && (x.t === 'consent-ask' || x.t === 'consent-grant')) window.__pv.sealed.push({
					t: x.t, kind: String(x.kind || ''), cid: String(x.cid || ''), eid: String(x.eid || ''),
					turnId: String(x.turnId || ''), verdict: String(x.verdict || ''), choice: String(x.choice || ''),
					by: String(x.by || ''), to: String(x.to || ''), target: String(x.target || ''),
					dispatchedBy: String(x.dispatchedBy || ''), deadline: +x.deadline || 0, at: Date.now() });
			} catch (e) {}
			return o.apply(this, arguments);
		};
	}
	const T = window.DaimondTrail;
	if (T && T.note) {
		const n = T.note.bind(T);
		T.note = function (w, d) { try { window.__pv.trail.push(String(w) + ': ' + String(d)); } catch (e) {} return n(w, d); };
	}
	new MutationObserver((ms) => {
		for (const m of ms) for (const el of m.addedNodes) {
			if (el.nodeType === 1 && el.matches && el.matches('.modal.dlg')) window.__pv.dlgs++;
		}
	}).observe(document.body, { childList: true, subtree: true });
}).catch(() => {});
const pv = (pg) => pg.evaluate(() => window.__pv || { sealed: [], trail: [], dlgs: 0 }).catch(() => ({ sealed: [], trail: [], dlgs: 0 }));
const pvReset = (pg) => pg.evaluate(() => { if (window.__pv) { window.__pv.sealed = []; window.__pv.trail = []; window.__pv.dlgs = 0; } }).catch(() => {});

/// The Pending cards on a page, as drawn.
const cards = (pg) => pg.evaluate(() => [...document.querySelectorAll('#pending-list .pend-card')].map((c) => ({
	line:   ((c.querySelector('.pend-line') || {}).textContent || '').trim(),
	detail: ((c.querySelector('.pend-detail') || {}).textContent || '').trim(),
	retry:  !!c.querySelector('.pend-go.pend-retry'),
	go:     ((c.querySelector('.pend-go') || {}).textContent || '').trim(),
}))).catch(() => []);
/// Press a Pending card's go or no button, the first whose line matches.
const press = (pg, src, which) => pg.evaluate((a) => {
	const re = new RegExp(a.src);
	const c = [...document.querySelectorAll('#pending-list .pend-card')]
		.find((x) => re.test(((x.querySelector('.pend-line') || {}).textContent || '')));
	const btn = c && c.querySelector(a.which === 'no' ? '.pend-no' : '.pend-go');
	if (!btn) return false;
	btn.click(); return true;
}, { src, which }).catch(() => false);
const waitCard = async (pg, src, ms) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if ((await cards(pg)).some((c) => new RegExp(src).test(c.line))) return Date.now() - t0;
		await pg.evaluate(() => { try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
		await sleep(400);
	}
	return -1;
};
const openDlgs = (pg) => pg.evaluate(() => [...document.querySelectorAll('.modal.dlg')]
	.filter((d) => d.getClientRects().length).map((d) => d.getAttribute('data-ask')
		|| ('?' + (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)))).catch(() => []);
// A guarded question's yes is disabled for its first second (daimond.js GUARD_MS), and a
// click on it then answers nothing, so wait for it to arm before pressing.
const answerDlg = (pg, yes) => pg.evaluate(async (y) => {
	for (let i = 0; i < 40; i++) {
		const c = [...document.querySelectorAll('.modal.dlg .dlg-card')].pop();
		const b = c && c.querySelector(y ? '.dlg-ok' : '.dlg-cancel');
		if (b && !b.disabled) { b.click(); return true; }
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}, yes).catch(() => false);
const footerButtons = (pg) => pg.evaluate(() => [...document.querySelectorAll('.ti-continue')]
	.filter((x) => x.getClientRects().length).map((x) => x.textContent.trim())).catch(() => []);
const holds = (pg, id) => pg.evaluate(async (id) => {
	try {
		const rows = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]');
		return rows.filter((r) => String(r.rel || '') === 'holds').map((r) => String(r.id || r.to || JSON.stringify(r)));
	} catch (e) { return ['?' + e]; }
}, id).catch((e) => ['?' + e]);
const marks = (pg) => pg.evaluate(() => Object.keys(localStorage).filter((k) => /marks-here/.test(k))
	.map((k) => k + '=' + localStorage.getItem(k)).join('|')).catch(() => '?');
const kits = (pg, id) => pg.evaluate(async (id) => {
	try { await DaimondCore.loadDiamonds(); return (await DaimondDiamond.bounds(id)).toolkits || []; }
	catch (e) { return ['?' + e]; }
}, id).catch(() => ['?']);
const daimonMsgs = (pg, id) => pg.evaluate((did) => {
	try {
		const rec = window.DaimondDiamond.conversation(did);
		return (rec && rec.messages ? rec.messages : []).map((m) => ({ role: String(m.role || ''),
			ranOn: String(m.ranOn || ''), mid: String(m.mid || ''), content: typeof m.content === 'string' ? m.content : '' }));
	} catch (e) { return []; }
}, id).catch(() => []);
// A turn's answer is ANY new non-empty assistant message, not one marker: a @tool turn
// answers 'Tool done.' but a @tools turn 'Tools done.' (dev/mockllm.mjs), and matching the
// one marker read RA3/RA4's answered @tools turns as never answered. Callers count against
// a baseline taken before the send, so earlier turns' answers do not count.
const answers = async (pg, id) => (await daimonMsgs(pg, id)).filter((m) => m.role === 'assistant' && m.content.trim());
// THIS turn's tool results: each request carries the whole thread, so only the tool messages
// after its last user message are this turn's (earlier turns' "Wrote" otherwise read as this one's).
const toolResults = () => { try { return (mockLog() || []).flatMap((r) => {
	const ms = r.messages || [];
	let u = -1; ms.forEach((m, i) => { if (m.role === 'user') u = i; });
	return ms.slice(u + 1).filter((m) => m.role === 'tool').map((m) => contentText(m.content));
}); } catch (e) { return []; } };

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
		await sleep(300);
	}
	return '';
}

// A stand-in machine hand on B, for the toolkit and run turns (verify_kitask.mjs's).
const HAND_ON = () => {
	window.__realHand = window.__realHand || window.DaimondHand || null;
	window.__sent = [];
	window.DaimondHand = {
		hasHand: () => true,
		status:  async () => JSON.stringify({ paired: true, link: 1, transport: 'machine',
			machine: 'test', os: 'linux', root: '/home/u/ws', home: '/home/u',
			caps: ['fence:linux', 'root:/home/u/ws', 'home:/home/u', 'meter:deletes'] }),
		run:     async (spec) => { window.__sent.push(JSON.parse(spec));
			return JSON.stringify({ t: 'exec_result', exit: 0, stdout: 'ran', stderr: '', out_bytes: 3, err_bytes: 0, timed_out: false }); },
		runs: async () => '[]', held: async () => '{}', signal: async () => '{}',
	};
};
const HAND_OFF = () => { if (window.__realHand) window.DaimondHand = window.__realHand; };
const execs = (pg) => pg.evaluate(() => (window.__sent || []).filter((x) => x.t === 'exec')
	.map((x) => ({ argv: x.argv, toolkits: x.toolkits || [] }))).catch(() => []);

let A, B, C;
try {
	// ── Three devices on one account ─────────────────────────────────────
	A = await open(Object.assign({ name: 'hplead', touch: true, ua: IPHONE_UA }, MIX === 'A547' ? oldOpen : {}));
	await ready(A.page);
	const pro = await makePagePro(A.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(A);
	await newChat(A);
	await chat(A, 'seed turn so the account has a chat and a parcel');
	await settle(A.page);

	const pairIn = async (name, extra) => {
		const s = await open(Object.assign({ name, signIn: false, connect: false, browser: 'chromium' }, extra || {}));
		await s.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
		const code = await A.page.evaluate(() => DaimondPairing.create());
		await s.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(s, 'hplead');
		await ready(s.page);
		await makePagePro(s.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
		await connectMock(s);
		await s.page.waitForFunction(() => !!window.DaimondDiamond, null, { timeout: 15000 }).catch(() => {});
		await sleep(1200);
		await settle(s.page);
		return s;
	};
	B = await pairIn('hpmate', MIX === 'B547' ? oldOpen : {});
	if (!MIX || MIX === 'C547') C = await pairIn('hpthird', MIX === 'C547' ? oldOpen : {});
	const idA = await devId(A.page), idB = await devId(B.page), idC = C ? await devId(C.page) : '';
	check('A, B' + (C ? ' and C' : '') + ' are distinct paired devices',
		!!idA && !!idB && idA !== idB && (!C || (idC && idC !== idA && idC !== idB)), JSON.stringify({ idA, idB, idC }));
	const pages = [A.page, B.page].concat(C ? [C.page] : []);
	for (const pg of pages) await instrument(pg);

	await A.page.waitForSelector('#new-diamond-btn', { timeout: 10000 }).catch(() => {});
	const dia = await makeDiamond(A.page, 'PermitDia');
	check('a Diamond was made on A', !!dia, dia);
	const syncAll = async () => {
		await A.page.evaluate(() => window.DaimondSync.push && window.DaimondSync.push()).catch(() => {});
		await sleep(500);
		for (const pg of pages.slice(1)) await pg.evaluate(() => window.DaimondSync.pull && window.DaimondSync.pull(true)).catch(() => {});
	};
	await syncAll();
	const has = async (pg) => { for (let i = 0; i < 40; i++) {
		if (await pg.evaluate((d) => { try { return !!window.DaimondDiamond.conversation(d); } catch (e) { return false; } }, dia).catch(() => false)) return true;
		await sleep(500); } return false; };
	check('the Diamond synced to B' + (C ? ' and C' : ''), (await has(B.page)) && (!C || await has(C.page)));

	// Arm A to hand every turn to B (step-away posture, B nominated).
	// A beats as well as B. A's own beat is asked of the page itself (its real fields, not a
	// hand-made beat that would say "unattended"): the page's pulse reads the interval once a
	// second, so an interval far below zero makes the next pulse beat. This matters after an
	// arm shifts A's clock: the page stamps its last beat with the shifted time, and once the
	// clock is put back it holds its next beat for the shift plus an interval (61 s + 45 s
	// after F3a), while B refuses an ask from an asker whose beat is over 90 s old.
	const beat = async () => {
		await B.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'hpmate')).catch(() => {});
		await A.page.evaluate(() => { const P = window.DaimondPresence; if (P && P.__beatMs == null) { P.__beatMs = P.BEAT_MS; P.BEAT_MS = -1e12; } }).catch(() => {});
		await sleep(1300);
		await A.page.evaluate(() => { const P = window.DaimondPresence; if (P && P.__beatMs != null) { P.BEAT_MS = P.__beatMs; delete P.__beatMs; } }).catch(() => {});
		await A.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await B.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await sleep(500);
	};
	// B NOMINATED, for real: `DaimondCore.nominate` does not exist (it is `roster.nominate`), and
	// the dead call left no nominee, so under the step-away toggle any awake peer could claim
	// the errand and C (no machine hand) took some turns -- the "ran on A" flake of rounds 2-3.
	const nominated = await A.page.evaluate((id) => {
		try { localStorage.setItem('daimond-handoff-when-away', '1'); } catch (e) {}
		const r = window.DaimondCore && DaimondCore.roster;
		if (!r || !r.nominate) return 'no roster.nominate';
		r.nominate(id);
		return r.nominee() === id ? 'B' : 'nominee=' + r.nominee();
	}, idB).catch((e) => String(e && e.message || e));
	await syncAll();
	await beat();
	check('B is the nominated runner on A', nominated === 'B', nominated);
	// The nomination reaching B puts "Make this device the runner?" to it once (runner.js ask).
	// That is B's own setup question, not a consent dialog: answer it yes here, before the arms.
	const RUNNER_Q = /^\?Make this device the runner\?/;
	const runnerQ = async () => { if ((await openDlgs(B.page)).some((d) => RUNNER_Q.test(d))) return answerDlg(B.page, true); return false; };
	let runnerAnswered = false;
	for (let i = 0; i < 30 && !runnerAnswered; i++) {
		await B.page.evaluate(() => { try { window.DaimondSync.pull(true); } catch (e) {} }).catch(() => {});
		runnerAnswered = await runnerQ();
		if (!runnerAnswered) await sleep(500);
	}
	note('B runner question answered at setup: ' + runnerAnswered);

	/// Steer A's daimon and, while the turn runs, let `during` act (answer, forge, wait).
	/// Answers once the turn's answer has landed on A (or `ms` runs out), with the evidence.
	// THE ARMS TEST CONSENT ROUTING, NOT PRESENCE. A's election hands a turn to B only on a
	// fresh, idle beat; after a reload or B's busy->idle edge that beat can be dropped or
	// stamped stale (the PRESENCE-BEAT fault, fixed apart from this change), and the turn
	// then runs on A with no ask at all. So the send waits until A's own seat plan would
	// hand to B, and logs what the plan and the send's election actually said.
	const seatOnA = () => A.page.evaluate((b) => {
		const ms = (v) => (v && typeof v.toNumber === 'function') ? v.toNumber() : (Number(v) || 0);
		const snap = (window.DaimondPresence && DaimondPresence.snapshot()) || {};
		const rec = snap[b] || null;
		let plan = null;
		try { plan = DaimondCore.seat.planNow(); } catch (e) {}
		return { plan: plan && { where: plan.where, dev: plan.deviceId === b ? 'B' : (plan.deviceId || '').slice(0, 8), reason: plan.reason, dispatch: plan.dispatch },
			bAge: rec ? Math.round((Date.now() - ms(rec.lastSeen)) / 1000) : null, bBusy: rec ? (rec.busy | 0) : null };
	}, idB).catch((e) => ({ err: String(e && e.message || e).slice(0, 80) }));
	for (const pg of pages) await pg.evaluate(() => { try { window.DaimondDiag.set(true, 'hpermit'); } catch (e) {} }).catch(() => {});
	const trail = (pg, t) => pg.evaluate((t) => ((window.DaimondDiag && DaimondDiag.rows()) || [])
		.filter((r) => r.ts >= t && /UNDELIVER|reconstruct|errand|hand.?back|claim|lease|backstop|local|busy/i.test(r.tag + ' ' + (r.data || '')))
		.map((r) => (r.ts - t) + 'ms ' + r.tag + ': ' + String(r.data || '').slice(0, 220)), t).catch(() => []);
	const electionAt = (since) => A.page.evaluate((t) => ((window.DaimondDiag && DaimondDiag.rows()) || [])
		.filter((r) => r.ts >= t && /dispatch election|handoff refresh/.test(r.tag)).map((r) => r.tag + ': ' + (r.data || '')), since)
		.catch(() => []);
	let nTurn = 0;

	async function steer(directive, during, ms = 120000) {
		nTurn++;
		const w0 = Date.now();
		let seat = null;
		for (;;) {
			await beat();
			seat = await seatOnA();
			if (seat.plan && seat.plan.dev === 'B' && seat.plan.where === 'runner' && seat.bBusy === 0 && seat.bAge != null && seat.bAge < 30) break;
			if (Date.now() - w0 > 90000) break;
			await sleep(1500);
		}
		console.log('  steer#' + nTurn + ' seat wait ' + (Date.now() - w0) + 'ms ' + JSON.stringify(seat));
		for (const pg of pages) await pvReset(pg);
		try { clearMockLog(); } catch (e) {}
		const before = (await answers(A.page, dia)).length;
		const holdsBefore = { A: await holds(A.page, dia), B: await holds(B.page, dia) };
		const marksBefore = { A: await marks(A.page), B: await marks(B.page) };
		await A.page.$('#dview-chat').then((el) => el && el.click({ force: true })).catch(() => {});
		await sleep(300);
		await A.page.fill('#chat-input', directive);
		const tSend = Date.now();
		await A.page.click('#chat-send', { force: true });
		const t0 = Date.now();
		setTimeout(async () => { const k = nTurn; for (const l of await electionAt(tSend)) console.log('  steer#' + k + ' at send | ' + l.slice(0, 600)); }, 3000);
		const bDlgSeen = new Set(), cCards = new Set(), cFoot = new Set();
		let duringDone = !during, duringOut = null, unstuck = false;
		let landed = false;
		while (Date.now() - t0 < ms) {
			if (await runnerQ()) console.log('  steer#' + nTurn + ' B runner question arrived late; answered yes');
			for (const d of await openDlgs(B.page)) bDlgSeen.add(d);
			if (C) {
				for (const c of await cards(C.page)) if (/Let |Run this/.test(c.line)) cCards.add(c.line);
				for (const f of await footerButtons(C.page)) cFoot.add(f);
			}
			if (!duringDone) { duringDone = true; duringOut = await during({ t0 }); }
			if ((await answers(A.page, dia)).length > before) { landed = true; break; }
			// A dialog on B nobody here will answer (the old behaviour): record it, then say
			// Not now after 8 s so the turn can end and the run go on.
			if (bDlgSeen.size && !unstuck && Date.now() - t0 > 8000 && (await openDlgs(B.page)).length) {
				unstuck = await answerDlg(B.page, false);
			}
			await A.page.evaluate(() => { try { window.DaimondSync.pull(true); } catch (e) {} try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
			await B.page.evaluate(() => { try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
			await sleep(400);
		}
		await sleep(1500);
		const ans = await answers(A.page, dia);
		const ranOn = (ans[ans.length - 1] || {}).ranOn || '';
		if (ranOn !== idB) {
			console.log('  steer#' + nTurn + ' NOT on B (ranOn=' + (ranOn === idA ? 'A' : ranOn === idC ? 'C' : ranOn || '-') + ', ' + (Date.now() - t0) + 'ms); trails:');
			for (const [n, pg] of [['A', A.page], ['B', B.page]]) for (const l of (await trail(pg, tSend)).slice(-14)) console.log('    ' + n + ' | ' + l);
		}
		return {
			landed, copies: ans.length - before, ranOn: (ans[ans.length - 1] || {}).ranOn || '',
			ms: Date.now() - t0, duringOut, unstuck,
			bDlgs: [...bDlgSeen], cCards: [...cCards], cFoot: [...cFoot],
			results: toolResults(),
			pvA: await pv(A.page), pvB: await pv(B.page), pvC: C ? await pv(C.page) : null,
			holdsBefore, marksBefore,
			holdsAfter: { A: await holds(A.page, dia), B: await holds(B.page, dia) },
			marksAfter: { A: await marks(A.page), B: await marks(B.page) },
		};
	}
	const asksOf = (r) => (r.pvB.sealed || []).filter((x) => x.t === 'consent-ask');
	const noRows = (r) => JSON.stringify(r.holdsBefore) === JSON.stringify(r.holdsAfter)
		&& JSON.stringify(r.marksBefore) === JSON.stringify(r.marksAfter);
	const wrote = (r) => r.results.some((c) => /^Wrote /.test(c));
	const refusedW = (r) => r.results.some((c) => /^Refused/.test(c));
	// What the MODEL was told (the engine's tool result, as the mock provider received it):
	// the real reason, and "the user said not now" only for a no (tools.rs `permit_of`).
	const toldW = (r, re) => r.results.some((c) => /^Refused/.test(c) && re.test(c));
	const notNow = (r) => r.results.some((c) => /not now|said no/.test(c));
	const sum = (r) => JSON.stringify({ landed: r.landed, copies: r.copies, ranOnB: r.ranOn === idB, bDlgs: r.bDlgs,
		asks: asksOf(r).map((a) => a.kind + '>' + (a.target === idA ? 'A' : a.target || '∅')), cCards: r.cCards,
		results: r.results.map((c) => c.slice(0, 50)) });
	const PLACEIN = (d, f) => `@tool file_write {"path":"docs/${d}/${f}","content":"permit ${f}"}`;
	const PLACE = (f) => `@tool file_write {"path":"docs/permit/${f}","content":"permit ${f}"}`;

	if (!MIX && ARMS === 'fix') {
		const POSTURE = 'daimond-autonomous-posture';
		const askRe = '^Let .*change';
		const allowOnA = async (re) => {
			const at = await waitCard(A.page, re, 30000);
			const pressed = at >= 0 ? await press(A.page, re, 'go') : false;
			return { at, pressed };
		};

		const SHIFT = (ms) => { window.__realNow = window.__realNow || Date.now; const n = window.__realNow; Date.now = () => n.call(Date) + ms; };
		const UNSHIFT = () => { if (window.__realNow) Date.now = window.__realNow; };

		if (on('P1')) {
		// ── P1 (B-F1): the RUNNER's posture never grants a permit on someone else's turn ──
		console.log('\nP1 — place, the runner is in the step-away posture and hidden');
		await B.page.evaluate((k) => {
			try { localStorage.setItem(k, '1'); } catch (e) {}
			Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
		}, POSTURE);
		const p1 = await steer(PLACEIN('fixp1', 'one.md'), () => allowOnA(askRe), 90000);
		await B.page.evaluate((k) => { try { localStorage.removeItem(k); } catch (e) {} delete document.visibilityState; }, POSTURE);
		note('P1 ' + sum(p1) + ' during=' + JSON.stringify(p1.duringOut));
		check('P1 the runner\'s posture grants nothing: A is asked', asksOf(p1).length === 1 && asksOf(p1)[0].target === idA
			&& !!p1.duringOut && p1.duringOut.at >= 0, sum(p1));
		check('P1 Allow on A writes, and the model is never told the user said not now', wrote(p1) && !notNow(p1), JSON.stringify(p1.results));

		}
		if (on('P2')) {
		// ── P2 (B-F1): the ASKER's posture counts, and is read as a yes ──────
		console.log('\nP2 — place, the asker is in the step-away posture');
		await A.page.evaluate((k) => { try { localStorage.setItem(k, '1'); } catch (e) {} }, POSTURE);
		const p2 = await steer(PLACEIN('fixp2', 'two.md'), async () => {
			const at = await waitCard(A.page, askRe, 12000);
			if (at >= 0) await press(A.page, askRe, 'no');
			return { at };
		}, 90000);
		await A.page.evaluate((k) => { try { localStorage.removeItem(k); } catch (e) {} }, POSTURE);
		note('P2 ' + sum(p2) + ' during=' + JSON.stringify(p2.duringOut));
		check('P2 the asker\'s posture answers: nobody is asked', asksOf(p2).length === 0 && p2.bDlgs.length === 0
			&& !!p2.duringOut && p2.duringOut.at < 0, sum(p2));
		check('P2 and it is read as a yes: the write proceeds', wrote(p2) && !refusedW(p2), JSON.stringify(p2.results));

		}
		if (on('P3')) {
		// ── P3 (F1): B's own turn, while a handed-off ask is open, asks on B ──
		console.log('\nP3 — a turn of B\'s own while a handed-off ask is open on A');
		const p3 = await steer(PLACEIN('fixp3', 'three.md'), async () => {
			const at = await waitCard(A.page, askRe, 30000);
			await B.page.evaluate(async (a) => {
				const mod = await import('/pkg/oxedyne_daimond.js');
				window.__seen = [];
				const b = await DaimondDiamond.bounds(a.id);
				const app = new mod.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
				window.__turn = app.steer_crystal(a.id, a.dir,
					JSON.stringify(b.toolkits || []), [],
					(ev) => { if (ev.type === 'tool_result') window.__seen.push(String(ev.content || '')); })
					.then(() => 'done', (e) => 'threw ' + String(e && e.message || e));
			}, { id: dia, dir: PLACEIN('fixp3own', 'own.md'), mock: process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions' });
			const dlg = await B.page.waitForSelector('.modal.dlg[data-ask="place"]', { timeout: 15000 }).then(() => true, () => false);
			const asks = (await pv(B.page)).sealed.filter((x) => x.t === 'consent-ask').length;
			if (dlg) await answerDlg(B.page, true);
			const own = await B.page.evaluate(async () => ({ end: await window.__turn, seen: window.__seen })).catch((e) => ({ end: 'eval ' + e, seen: [] }));
			const pressed = at >= 0 ? await press(A.page, askRe, 'go') : false;
			return { at, dlg, asks, own, pressed };
		}, 120000);
		const d3 = p3.duringOut || {};
		note('P3 ' + sum(p3) + ' during=' + JSON.stringify(d3).slice(0, 500));
		check('P3 B\'s own turn draws its own place dialog on B', d3.dlg === true, JSON.stringify(d3).slice(0, 300));
		check('P3 and is not refused as "could not ask": Allow on B writes', !!d3.own && d3.own.seen.some((c) => /^Wrote /.test(c))
			&& !d3.own.seen.some((c) => /could not ask/.test(c)), JSON.stringify(d3.own || null).slice(0, 300));
		check('P3 one ask only went to A, and its Allow still writes', d3.asks === 1 && asksOf(p3).length === 1 && p3.landed, sum(p3));

		}
		if (on('F9')) {
		// ── B-F9: a device whose clock runs ahead still draws the ask ─────────
		console.log('\nB-F9 — place, A\'s clock 90 s ahead of B\'s');
		const f9 = await steer(PLACEIN('fixf9', 'nine.md'), async () => {
			await A.page.evaluate(SHIFT, 90000);
			const r = await allowOnA(askRe);
			await A.page.evaluate(UNSHIFT);
			return r;
		}, 100000);
		await A.page.evaluate(UNSHIFT);
		await beat();		// as after F3a: a 90 s shift would hold A's beat for ~135 s
		note('B-F9 ' + sum(f9) + ' during=' + JSON.stringify(f9.duringOut));
		check('B-F9 the ask draws on a device whose clock is 90 s ahead', !!f9.duringOut && f9.duringOut.at >= 0, sum(f9));
		check('B-F9 and its Allow writes', wrote(f9), JSON.stringify(f9.results));

		}
		if (on('F3')) {
		// A turn of B's own, allowed on B, so the Diamond has its folder on the machine (as T4).
		await B.page.evaluate(async (a) => {
			const mod = await import('/pkg/oxedyne_daimond.js');
			const b = await DaimondDiamond.bounds(a.id);
			const app = new mod.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
			window.__turn = app.steer_crystal(a.id, a.dir,
				JSON.stringify(b.toolkits || []), [], () => {})
				.then(() => 'done', (e) => 'threw ' + String(e && e.message || e));
		}, { id: dia, dir: PLACEIN('fixkit', 'home.md'), mock: process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions' });
		const home = await B.page.waitForSelector('.modal.dlg[data-ask="place"]', { timeout: 15000 }).then(() => true, () => false);
		if (home) await answerDlg(B.page, true);
		note('F3 setup: B\'s own place dialog=' + home + ' end=' + await B.page.evaluate(() => window.__turn).catch((e) => 'eval ' + e));
		await syncAll();
		// ── F3: a toolkit yes is written only for an ask still open and delivered ─
		await B.page.evaluate(HAND_ON);
		const NPM = '@tool run {"argv":["npm","--version"],"cwd":""}';
		// Each arm asks for a kit of its own: with one kit between them, F3a's wrongly written
		// `node` left F3b and F3c nothing to ask and so nothing to fail.
		const PIP = '@tool run {"argv":["pip","--version"],"cwd":""}';
		const CARGO = '@tool run {"argv":["cargo","--version"],"cwd":""}';
		const kitRe = '^Let .*use';
		const grantsA = (r) => (r.pvA.sealed || []).filter((x) => x.t === 'consent-grant');

		console.log('\nF3a — toolkit, Allow pressed on A after the deadline');
		const f3a = await steer(NPM, async () => {
			const at = await waitCard(A.page, kitRe, 30000);
			await A.page.evaluate(SHIFT, 61000);
			const pressed = at >= 0 ? await press(A.page, kitRe, 'go') : false;
			await sleep(2500);
			await A.page.evaluate(UNSHIFT);
			return { at, pressed, kitsA: await kits(A.page, dia) };
		}, 150000);
		await A.page.evaluate(UNSHIFT);
		await beat();		// A's clock is back: beat now, or A stays silent for ~106 s and B refuses F3b/F3c unasked
		const k3a = await kits(A.page, dia);
		note('F3a ' + sum(f3a) + ' during=' + JSON.stringify(f3a.duringOut) + ' kitsA=' + JSON.stringify(k3a));
		check('F3a the ask drew on A', !!f3a.duringOut && f3a.duringOut.at >= 0, sum(f3a));
		check('F3a a late Allow writes no kit on A', !k3a.includes('node') && !((f3a.duringOut || {}).kitsA || []).includes('node'), JSON.stringify(k3a));

		console.log('\nF3b — toolkit, Allow pressed on A while its post fails');
		const f3b = await steer(PIP, async () => {
			const at = await waitCard(A.page, kitRe, 30000);
			await A.page.evaluate(() => { window.__realPost = window.__realPost || DaimondPost.post; DaimondPost.post = async () => ({ ok: false }); });
			const pressed = at >= 0 ? await press(A.page, kitRe, 'go') : false;
			await sleep(2500);
			await A.page.evaluate(() => { if (window.__realPost) DaimondPost.post = window.__realPost; });
			return { at, pressed, kitsA: await kits(A.page, dia) };
		}, 150000);
		await A.page.evaluate(() => { if (window.__realPost) DaimondPost.post = window.__realPost; });
		const k3b = await kits(A.page, dia);
		note('F3b ' + sum(f3b) + ' during=' + JSON.stringify(f3b.duringOut) + ' kitsA=' + JSON.stringify(k3b));
		check('F3b the ask drew on A', !!f3b.duringOut && f3b.duringOut.at >= 0, sum(f3b));
		check('F3b an Allow that could not be posted writes no kit on A', !k3b.includes('python') && !((f3b.duringOut || {}).kitsA || []).includes('python'), JSON.stringify(k3b));

		console.log('\nF3c — toolkit, the tile and the footer both pressed');
		const f3c = await steer(CARGO, async () => {
			const at = await waitCard(A.page, kitRe, 30000);
			let foot = [];
			for (let i = 0; i < 20 && !foot.some((f) => /Allow/.test(f)); i++) {
				await A.page.evaluate(() => { try { window.DaimondSync.pull(true); } catch (e) {} }).catch(() => {});
				await sleep(400); foot = await footerButtons(A.page);
			}
			const both = await A.page.evaluate((src) => {
				const re = new RegExp(src);
				const c = [...document.querySelectorAll('#pending-list .pend-card')].find((x) => re.test(((x.querySelector('.pend-line') || {}).textContent || '')));
				const tile = c && c.querySelector('.pend-go');
				const ft = [...document.querySelectorAll('.ti-continue')].find((x) => x.getClientRects().length && /Allow/.test(x.textContent));
				if (tile) tile.click();
				if (ft) ft.click();
				return { tile: !!tile, foot: !!ft };
			}, kitRe);
			return { at, foot, both };
		}, 120000);
		await syncAll(); await sleep(1500);
		const k3c = await kits(A.page, dia);
		note('F3c ' + sum(f3c) + ' during=' + JSON.stringify(f3c.duringOut) + ' grantsA=' + grantsA(f3c).length + ' kitsA=' + JSON.stringify(k3c));
		check('F3c both surfaces drew the question on A', !!f3c.duringOut && f3c.duringOut.both && f3c.duringOut.both.tile && f3c.duringOut.both.foot,
			JSON.stringify(f3c.duringOut));
		check('F3c the two presses are one answer: one grant sealed, the kit held once', grantsA(f3c).length === 1
			&& k3c.filter((k) => k === 'rust').length === 1, 'grants ' + grantsA(f3c).length + ' kits ' + JSON.stringify(k3c));
		await B.page.evaluate(HAND_OFF);
		}
		if (on('RA3')) {
		// ── RA3 (X1): A reloads with an ask open; can a FRESH ask still be answered? ──
		// Step 0 leaves a place ask open on A and reloads A's page. (i) the same turn then asks
		// for a second place in a new folder; (ii) the next handed-off turn asks for a third.
		// Each must be drawn on A, its Allow sealed and posted, and B must go on to write.
		console.log('\nRA3 — place, A reloads with the ask open; a fresh ask in the same turn, then in the next');
		const tag = Date.now().toString(36).slice(-4);
		const d1 = 'ra3a' + tag, d2 = 'ra3b' + tag, d3 = 'ra3c' + tag;
		const W = (d, f) => `file_write {"path":"docs/${d}/${f}","content":"permit ${f}"}`;
		const grantsOf = (p) => ((p && p.sealed) || []).filter((x) => x.t === 'consent-grant');
		const pumpA = () => A.page.evaluate(() => { try { window.DaimondSync.pull(true); } catch (e) {} try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
		const tileFor = async (src) => (await cards(A.page)).some((c) => !c.retry && (c.line + ' ' + c.detail).includes(src));
		const waitTile = async (src, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await tileFor(src)) return Date.now() - t; await pumpA(); await sleep(400); } return -1; };
		const pressTile = (src) => A.page.evaluate((s) => {
			const c = [...document.querySelectorAll('#pending-list .pend-card')].find((x) => !x.querySelector('.pend-go.pend-retry') && (x.textContent || '').includes(s));
			const btn = c && c.querySelector('.pend-go');
			if (!btn) return false; btn.click(); return true;
		}, src).catch(() => false);
		const allowFresh = async (src, ms) => {
			const at = await waitTile(src, ms);
			const g0 = grantsOf(await pv(A.page)).length;
			const pressed = at >= 0 ? await pressTile(src) : false;
			for (let i = 0; i < 8; i++) { await pumpA(); await sleep(500); }
			return { at, pressed, sealed: grantsOf(await pv(A.page)).length - g0 };
		};
		const wroteIn = (r, d) => r.results.some((c) => /^Wrote /.test(c) && c.includes(d));
		const told = (r) => JSON.stringify(r.results.map((c) => c.slice(0, 110)));

		// (i) SAME TURN: one round, two places; the first is left open across the reload and never pressed.
		const r1 = await steer('@tools ' + W(d1, 'a.md') + ' ;; ' + W(d2, 'b.md'), async ({ t0 }) => {
			const at1 = await waitTile(d1, 30000);
			const both = await tileFor(d2);		// was the second already asked before the reload?
			await A.page.reload().catch((e) => note('RA3 reload ' + e));
			const tReload = Date.now() - t0;
			await sleep(3000); await instrument(A.page);
			const redrawn = await waitTile(d1, 15000);
			const second = await allowFresh(d2, 90000);
			return { at1, both, tReload, redrawn, second, tSecond: Date.now() - t0, deadAfter: await tileFor(d1) };
		}, 130000);
		await syncAll(); await sleep(1500);
		const o1 = r1.duringOut || { second: {} }, a1 = asksOf(r1), t1 = a1.length ? a1[0].at : 0;
		note('RA3i ' + sum(r1) + ' ms=' + r1.ms + ' during=' + JSON.stringify(o1));
		note('RA3i asksB=' + JSON.stringify(a1.map((x) => ({ k: x.kind, cid: x.cid.slice(0, 6), dt: x.at - t1, wait: x.deadline - x.at })))
			+ ' grantsA=' + JSON.stringify(grantsOf(r1.pvA).map((x) => ({ cid: x.cid.slice(0, 6), v: x.verdict, dt: x.at - t1 }))) + ' results=' + told(r1));
		const lateBy = a1.length > 1 ? a1[1].at - t1 : -1;
		note('RA3i the second ask was sealed on B ' + lateBy + ' ms after the first (the first waits ' + (a1.length ? a1[0].deadline - a1[0].at : '?') + ' ms): '
			+ (o1.both ? 'BOTH were open before the reload' : lateBy >= 55000 ? 'only AFTER the first timed out' : lateBy >= 0 ? 'BEFORE the first timed out' : 'never asked'));
		check('RA3i the same turn\'s answer landed on the reloaded A', r1.landed, r1.ms + ' ms ' + sum(r1));
		check('RA3i B asked A, and only the first ask was open on A at the reload', a1.length >= 1 && a1[0].target === idA && o1.at1 >= 0 && !o1.both, sum(r1));
		check('RA3i same turn: the second ask is DRAWN on A after the reload', o1.second.at >= 0, JSON.stringify(o1));
		check('RA3i same turn: Allow on it SEALS and posts a grant', !!o1.second.pressed && o1.second.sealed >= 1, JSON.stringify(o1.second));
		check('RA3i same turn: B PROCEEDS, the second file is written', wroteIn(r1, d2) || (wrote(r1) && !wroteIn(r1, d1)), told(r1));

		// (ii) NEXT TURN: a new handed-off turn from the reloaded A needs a third place.
		const r2 = await steer(PLACEIN(d3, 'c.md'), () => allowFresh(d3, 40000), 120000);
		await syncAll(); await sleep(1500);
		const o2 = r2.duringOut || {};
		note('RA3ii ' + sum(r2) + ' ms=' + r2.ms + ' during=' + JSON.stringify(o2) + ' grantsA=' + grantsOf(r2.pvA).length + ' results=' + told(r2));
		check('RA3ii next turn: it ran on B and its ask is DRAWN on A', r2.ranOn === idB && o2.at >= 0, sum(r2));
		check('RA3ii next turn: Allow on it SEALS and posts a grant', !!o2.pressed && o2.sealed >= 1, JSON.stringify(o2));
		check('RA3ii next turn: B PROCEEDS, the file is written', wrote(r2), told(r2));
		note('RA3 the dead first tile on A at the end: ' + ((await tileFor(d1)) ? 'STILL DRAWN' : 'gone')
			+ ' (right after the same-turn Allow: ' + (o1.deadAfter ? 'drawn' : 'gone') + '); cardsA=' + JSON.stringify((await cards(A.page)).map((c) => (c.retry ? 'notice: ' : '') + c.line + ' | ' + c.detail.slice(0, 40))));
		}
	} else if (MIX === 'C547') {
		// ── B-F4: a third device still on r547 draws no tile it could not answer ─
		console.log('\nB-F4 MIX=C547 — place, a third device on r547');
		const r4 = await steer(PLACEIN('fixf4', 'four.md'), async () => {
			const at = await waitCard(A.page, '^Let .*change', 30000);
			for (let i = 0; i < 12; i++) {
				await C.page.evaluate(() => { try { window.DaimondSync.pull(true); } catch (e) {} try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
				await sleep(500);
			}
			const cardsC = (await cards(C.page)).map((c) => c.line), footC = await footerButtons(C.page);
			const pressed = at >= 0 ? await press(A.page, '^Let .*change', 'go') : false;
			return { at, cardsC, footC, pressed };
		}, 100000);
		const d4 = r4.duringOut || {};
		note('B-F4 ' + sum(r4) + ' during=' + JSON.stringify(d4).slice(0, 400) + ' cFoot=' + JSON.stringify(r4.cFoot));
		check('B-F4 the ask opened on A and its Allow wrote', d4.at >= 0 && wrote(r4), sum(r4));
		// r547 hands every verified ask to its tile door whoever it names (r547 peer.js 845,
		// and its askRaiseDecision has no target rule), so while the question is open an
		// r547 third device shows it as a "reach" tile. Said out loud here, because the
		// check below is about a permit's own wording and controls and cannot see it.
		note('B-F4 OPEN (rollout window): reach tile on the r547 third device while asked = '
			+ (d4.cardsC || []).some((l) => /wants to reach/.test(l)));
		check('B-F4 the r547 third device drew no permit tile and no Allow or Deny for it',
			!(d4.cardsC || ['?']).some((l) => /^Let |Run this/.test(l)) && r4.cCards.length === 0
			&& !(d4.footC || []).concat(r4.cFoot).some((f) => /Allow|Deny/.test(f)), JSON.stringify({ c: d4.cardsC, f: d4.footC, seen: r4.cCards, foot: r4.cFoot }));
	} else if (!MIX) {
		// ── T1: place, C forges an Allow, then A says Not now — (1), (3a) ─────
		console.log('\nT1 — place, answered Not now on A (C tries first)');
		let forged = null;
		const t1 = await steer(PLACE('one.md'), async () => {
			const at = await waitCard(A.page, '^Let .*change', 30000);
			const ask = asksOf({ pvB: await pv(B.page) })[0] || null;
			let cAllowed = null;
			if (ask && C) {
				// C posts exactly what its lease footer's Allow posts (answerBlocker).
				forged = await C.page.evaluate(async (a) => {
					try {
						const g = DaimondPeer.makeGrant({ cid: a.cid, eid: a.eid, turnId: a.turnId, kind: a.kind,
							verdict: 'allow', by: DaimondIdentity.deviceId(), to: a.dispatchedBy });
						const r = await DaimondPost.post(await DaimondPeer.sealForSelf(g));
						return !!(r && r.ok);
					} catch (e) { return 'threw ' + e; }
				}, ask);
				await B.page.evaluate(() => { try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
				await sleep(5000);
				cAllowed = toolResults().some((c) => /^Wrote /.test(c));
			}
			const cardsA = await cards(A.page);
			const pressed = at >= 0 ? await press(A.page, '^Let .*change', 'no') : false;
			return { at, cardsA, pressed, cAllowed };
		});
		note('T1 ' + sum(t1) + ' during=' + JSON.stringify(t1.duringOut).slice(0, 400));
		const a1 = asksOf(t1);
		check('(1) the place ask opens on A', !!t1.duringOut && t1.duringOut.at >= 0
			&& a1.length === 1 && a1[0].target === idA, 'card at ' + (t1.duringOut || {}).at + 'ms, asks ' + a1.length);
		check('(1) and never on B (no dialog, no Pending card)', t1.bDlgs.length === 0
			&& !(await cards(B.page)).some((c) => /^Let /.test(c.line)), 'B dialogs ' + JSON.stringify(t1.bDlgs));
		check('(1) and never on C (no card, no Allow in its footer)', !!C && t1.cCards.length === 0
			&& !t1.cFoot.some((f) => /Allow|Deny/.test(f)), JSON.stringify({ cCards: t1.cCards, cFoot: t1.cFoot }));
		check('(1) C\'s forged Allow authorised nothing', forged === true && t1.duringOut && t1.duringOut.cAllowed === false,
			'posted=' + forged + ' wroteAfterC=' + (t1.duringOut || {}).cAllowed);
		const n1 = (await cards(A.page)).find((c) => /^You said no\.$/.test(c.line));
		check('(3a) Not now gives "You said no." on A, with Retry', !!n1 && n1.retry, JSON.stringify(n1 || await cards(A.page)));
		check('(3a) the write was refused and no grant was written', refusedW(t1) && !wrote(t1) && noRows(t1),
			JSON.stringify({ holds: t1.holdsAfter, marksChanged: !noRows(t1) }));
		check('(3a) the model is told "the user said not now"', toldW(t1, /the user said not now/), sum(t1));
		check('(3a) the turn went on and answered once, run on B', t1.copies === 1 && t1.ranOn === idB, sum(t1));

		// ── T2: Retry on that notice asks again; Allow lets the write proceed — (3c), (2) ─
		console.log('\nT2 — Retry, then Allow on A');
		await beat();
		for (const pg of pages) await pvReset(pg);
		try { clearMockLog(); } catch (e) {}
		// Retry RETRACTS the refused turn, its answer with it, so the new answer is counted by
		// mid: the answers not on A before the press.
		const seen2 = new Set((await answers(A.page, dia)).map((m) => m.mid));
		const fresh2 = async () => (await answers(A.page, dia)).filter((m) => !seen2.has(m.mid)).length;
		const hb2 = { A: await holds(A.page, dia), B: await holds(B.page, dia) }, mb2 = { A: await marks(A.page), B: await marks(B.page) };
		const t2at = Date.now();
		const retried = await press(A.page, '^You said no\\.$', 'go');
		const at2 = await waitCard(A.page, '^Let .*change', 40000);
		const busyToast = await A.page.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|')).catch(() => '');
		const allowed2 = at2 >= 0 ? await press(A.page, '^Let .*change', 'go') : false;
		let landed2 = false;
		for (let i = 0; i < 200 && !landed2; i++) {
			landed2 = (await fresh2()) > 0;
			if (!landed2) {
				await A.page.evaluate(() => { try { window.DaimondSync.pull(true); } catch (e) {} try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
				await B.page.evaluate(() => { try { window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
				await sleep(400);
			}
		}
		await sleep(4000);
		const copies2 = await fresh2();
		const res2 = toolResults();
		const pvB2 = await pv(B.page);
		const t2 = { holdsBefore: hb2, marksBefore: mb2,
			holdsAfter: { A: await holds(A.page, dia), B: await holds(B.page, dia) }, marksAfter: { A: await marks(A.page), B: await marks(B.page) } };
		note('T2 retried=' + retried + ' at=' + at2 + ' allowed=' + allowed2 + ' copies=' + copies2 + ' toast=' + busyToast.slice(0, 120)
			+ ' results=' + JSON.stringify(res2.map((c) => c.slice(0, 50))));
		if (!(retried && at2 >= 0)) {
			// Where the retried turn went: both devices' rings from the press on.
			const ring = (pg) => pg.evaluate((t) => ((window.DaimondDiag && DaimondDiag.rows()) || [])
				.filter((r) => r.ts >= t && /ready|errand|claim|reconstruct|hand.?back|dispatch|pull|tomb|UNDELIVER/i.test(r.tag + ' ' + (r.data || '')))
				.map((r) => (r.ts - t) + 'ms ' + r.tag + ': ' + String(r.data || '').slice(0, 200)), t2at).catch(() => []);
			for (const [k, pg] of [['A', A.page], ['B', B.page]]) for (const l of (await ring(pg)).slice(0, 60)) note('T2 ' + k + ' ' + l);
		}
		check('(3c) Retry asks again on A', retried && at2 >= 0
			&& pvB2.sealed.filter((x) => x.t === 'consent-ask' && x.target === idA).length === 1, 'retried=' + retried + ' at=' + at2);
		check('(3c) Allow then lets the write proceed', allowed2 && res2.some((c) => /^Wrote /.test(c)), JSON.stringify(res2.map((c) => c.slice(0, 60))));
		check('(3c) the answer lands on A exactly once', copies2 === 1, copies2 + ' copies');
		check('(2) the place yes wrote no holds link and no marks-here entry on A or B', noRows(t2),
			JSON.stringify({ before: t2.holdsBefore, after: t2.holdsAfter, marks: [t2.marksBefore, t2.marksAfter] }).slice(0, 400));

		// ── T3: silence. The deadline is measured once — (3b) ─────────────────
		console.log('\nT3 — place, A stays silent');
		const t3 = await steer(PLACE('three.md'), async () => {
			const at = await waitCard(A.page, '^Let .*change', 30000);
			return { at };
		}, FAST ? 30000 : 150000);
		const a3 = asksOf(t3)[0] || null;
		const tg = (t3.pvB.sealed || []).find((x) => x.t === 'consent-grant' && x.choice === 'timeout');
		const wait3 = a3 && tg ? tg.at - a3.at : -1;
		note('T3 ' + sum(t3) + ' deadline-at=' + (a3 ? a3.deadline - a3.at : '?') + ' told-after=' + wait3);
		const n3 = (await cards(A.page)).find((c) => /^Your other device didn.t answer in time\.$/.test(c.line));
		check('(2) the place yes was that turn\'s only: the next write there asks A again', !!a3 && a3.target === idA, sum(t3));
		check('(3b) silence gives "Your other device didn\'t answer in time." on A', !!n3 && n3.retry, JSON.stringify(n3 || (await cards(A.page)).map((c) => c.line)));
		check('(3b) the deadline is unchanged at 60 s', !!a3 && Math.abs((a3.deadline - a3.at) - 60000) < 1500
			&& (FAST || (wait3 >= 59000 && wait3 < 75000)), 'ask deadline ' + (a3 ? a3.deadline - a3.at : '?') + ' ms, refused after ' + wait3 + ' ms');
		check('(3b) the write was refused and no grant was written', refusedW(t3) && !wrote(t3) && noRows(t3), sum(t3));
		check('(3b) the model is told the other device didn\'t answer in time, never that the user said no',
			toldW(t3, /didn't answer in time/) && toldW(t3, /did not say no/) && !notNow(t3), JSON.stringify(t3.results));

		// ── T4: control, a turn on B that was not handed off — (5) ────────────
		console.log('\nT4 — control: a turn of B\'s own');
		for (const pg of pages) await pvReset(pg);
		const hb4 = await holds(B.page, dia), mb4 = await marks(B.page);
		await B.page.evaluate(async (a) => {
			const mod = await import('/pkg/oxedyne_daimond.js');
			window.__seen = [];
			const b = await DaimondDiamond.bounds(a.id);
			const app = new mod.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
			window.__turn = app.steer_crystal(a.id, a.dir,
				JSON.stringify(b.toolkits || []), [],
				(ev) => { if (ev.type === 'tool_result') window.__seen.push(String(ev.content || '')); })
				.then(() => 'done', (e) => 'threw ' + String(e && e.message || e));
		}, { id: dia, dir: PLACE('ctl.md'), mock: process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions' });
		const dlg4 = await B.page.waitForSelector('.modal.dlg[data-ask="place"]', { timeout: 15000 }).then(() => true, () => false);
		const asked4 = (await pv(A.page)).sealed.length + (await pv(B.page)).sealed.filter((x) => x.t === 'consent-ask').length;
		if (dlg4) await answerDlg(B.page, true);
		const end4 = await B.page.evaluate(async () => ({ end: await window.__turn, seen: window.__seen })).catch((e) => ({ end: 'eval ' + e, seen: [] }));
		await sleep(800);
		const ha4 = await holds(B.page, dia), ma4 = await marks(B.page);
		note('T4 dlg=' + dlg4 + ' end=' + end4.end + ' seen=' + JSON.stringify(end4.seen.map((c) => c.slice(0, 50))) + ' holds ' + hb4.length + '->' + ha4.length);
		check('(5) control: B\'s own turn draws the place dialog on B, and no ask goes anywhere', dlg4 && asked4 === 0, 'dialog=' + dlg4 + ' asks=' + asked4);
		check('(5) control: Allow writes the file and the same mark as before (a holds link and a marks-here entry on B)',
			end4.seen.some((c) => /^Wrote /.test(c)) && ha4.length === hb4.length + 1 && ma4 !== mb4,
			JSON.stringify({ holds: [hb4.length, ha4.length], marksChanged: ma4 !== mb4 }));

		// ── T5: B already allows docs/permit — (7) place ──────────────────────
		console.log('\nT5 — place B already allows');
		const t5 = await steer(PLACE('five.md'), null, 60000);
		note('T5 ' + sum(t5));
		check('(7) B already allows the place: no ask anywhere, and the write proceeds',
			asksOf(t5).length === 0 && t5.bDlgs.length === 0 && t5.cCards.length === 0 && wrote(t5)
			&& !(await cards(A.page)).some((c) => /^Let .*five/.test(c.line + c.detail)), sum(t5));

		// ── T6: toolkit, Allow on A — (4), (2) ───────────────────────────────
		console.log('\nT6 — toolkit, Allow on A');
		await B.page.evaluate(HAND_ON);
		const kitsBefore = { A: await kits(A.page, dia), B: await kits(B.page, dia) };
		const t6 = await steer('@tool run {"argv":["cargo","--version"],"cwd":""}', async () => {
			const at = await waitCard(A.page, '^Let .*use', 30000);
			const pressed = at >= 0 ? await press(A.page, '^Let .*use', 'go') : false;
			return { at, pressed };
		});
		await syncAll(); await sleep(1500);
		const kitsAfter = { A: await kits(A.page, dia), B: await kits(B.page, dia) };
		const x6 = await execs(B.page);
		note('T6 ' + sum(t6) + ' during=' + JSON.stringify(t6.duringOut) + ' kits ' + JSON.stringify([kitsBefore, kitsAfter]) + ' execs ' + JSON.stringify(x6));
		const a6 = asksOf(t6);
		check('(4) toolkit: the ask opens on A, never on B or C', !!t6.duringOut && t6.duringOut.at >= 0
			&& a6.length === 1 && a6[0].kind === 'toolkit' && a6[0].target === idA && t6.bDlgs.length === 0 && t6.cCards.length === 0, sum(t6));
		check('(4) toolkit: Allow runs it with the kit', x6.length === 1 && x6[0].toolkits.includes('rust'), JSON.stringify(x6));
		check('(2) the toolkit yes added only the kit asked for, to the Diamond (A, synced to B)',
			kitsBefore.A.length === 0 && JSON.stringify(kitsAfter.A) === '["rust"]' && JSON.stringify(kitsAfter.B) === '["rust"]',
			JSON.stringify([kitsBefore, kitsAfter]));

		// ── T7: the kit is held now — (7) toolkit ────────────────────────────
		console.log('\nT7 — toolkit B already allows');
		await B.page.evaluate(() => { window.__sent = []; });
		const t7 = await steer('@tool run {"argv":["cargo","--version"],"cwd":""}', null, 60000);
		const x7 = await execs(B.page);
		note('T7 ' + sum(t7) + ' execs ' + JSON.stringify(x7));
		check('(7) B already allows the kit: no ask anywhere, and it runs', asksOf(t7).length === 0
			&& t7.bDlgs.length === 0 && t7.cCards.length === 0 && x7.length === 1, sum(t7));

		// ── T8: run in the Ask mode, Allow on A — (4), (2) ───────────────────
		console.log('\nT8 — run (Ask mode), Allow on A');
		for (const pg of [A.page, B.page]) await pg.evaluate(() => { try { DaimondHandMode.set('ask'); } catch (e) {} }).catch(() => {});
		await syncAll();
		await B.page.evaluate(() => { window.__sent = []; });
		const t8 = await steer('@tool run {"argv":["ls"],"cwd":""}', async () => {
			const at = await waitCard(A.page, '^Run this command', 30000);
			const pressed = at >= 0 ? await press(A.page, '^Run this command', 'go') : false;
			return { at, pressed };
		});
		const x8 = await execs(B.page);
		const mode8 = await B.page.evaluate(() => DaimondHandMode.get()).catch(() => '?');
		note('T8 mode=' + mode8 + ' ' + sum(t8) + ' during=' + JSON.stringify(t8.duringOut) + ' execs ' + JSON.stringify(x8));
		const a8 = asksOf(t8);
		check('(4) run: the ask opens on A, never on B or C', !!t8.duringOut && t8.duringOut.at >= 0
			&& a8.length === 1 && a8[0].kind === 'run' && a8[0].target === idA && t8.bDlgs.length === 0 && t8.cCards.length === 0, sum(t8));
		check('(4) run: Allow runs the command', x8.length === 1, JSON.stringify(x8));
		check('(2) the run yes wrote no holds link and no marks-here entry on A or B', noRows(t8), JSON.stringify(t8.holdsAfter));
		for (const pg of [A.page, B.page]) await pg.evaluate(() => { try { DaimondHandMode.set('guarded'); } catch (e) {} }).catch(() => {});
		await B.page.evaluate(HAND_OFF);
	} else {
		// ── (6) mixed versions ───────────────────────────────────────────────
		console.log('\n(6) MIX=' + MIX + ' — place, one device on r547');
		const r6 = await steer(PLACE('six.md'), null, 90000);
		const cardsA = await cards(A.page);
		note('(6) ' + sum(r6) + ' trailB=' + JSON.stringify(r6.pvB.trail.filter((x) => /place/.test(x))).slice(0, 300)
			+ ' cardsA=' + JSON.stringify(cardsA.map((c) => c.line)));
		check('(6) no crash: the turn answered on A once', r6.landed && r6.copies === 1, sum(r6));
		check('(6) never a grant: the write was refused and no holds link or marks-here entry was written',
			!wrote(r6) && noRows(r6), sum(r6));
		if (MIX === 'A547') {
			// A CONSENT-ROUTE runner and an r547 sender: the errand carries no `asks`, so B asks
			// nobody, refuses at once and says why in its trail. The r547 A has no notice for it.
			check('(6) A547: B asked nobody (no ask posted, no dialog on B)', asksOf(r6).length === 0 && r6.bDlgs.length === 0, sum(r6));
			check('(6) A547: B refused at once with "could not ask on your other device"',
				r6.pvB.trail.some((x) => /could not ask on your other device/.test(x)) && r6.ms < 30000, r6.ms + 'ms');
			check('(6) A547: the model is told B could not ask on the other device, never that the user said no',
				toldW(r6, /could not ask on the user's other device/) && !notNow(r6), JSON.stringify(r6.results));
			check('(6) A547: A, on r547, shows no question (nothing it could answer)', !cardsA.some((c) => /^Let /.test(c.line)), JSON.stringify(cardsA.map((c) => c.line)));
		} else {
			// An r547 runner and a CONSENT-ROUTE sender: the old runner is unchanged, its own
			// dialog on B (answered Not now here), and A is asked nothing.
			check('(6) B547: the old runner is unchanged: its own place dialog on B, nothing asked of A',
				r6.bDlgs.includes('place') && asksOf(r6).length === 0 && !cardsA.some((c) => /^Let /.test(c.line)), sum(r6));
		}
	}

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	for (const s of [A, B, C]) { try { await s?.close(); } catch (e) {} }
}
guardRan(ok.length + bad.length, on);
process.exit(bad.length ? 1 : 0);
