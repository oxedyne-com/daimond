// gateway: live
// verify_session_reconcile.mjs -- the model is sent the whole chat (D-20261002-08).
//
// THE LAW. The engine's session is a function of the chat's converged messages, reconciled at turn start in `ensureApp`.
// It was not: an engine built for a chat was never brought up to the chat again (F2), and an engine could be built from a
// transcript that had not loaded (F1). Diagnosis: ~/usr/code/ai/claude/specs/daimond_session_stale_diag_20261002.md.
// Two paired devices of one Pro account on the real gateway, as `verify_ratings_sync.mjs` has them, and the mock model.
// THE ORACLE IS THE MOCK'S REQUEST, read against the sending device's STORED transcript (in the chat's converged order, with
// each person's message as `pre` + blank line + words), never against the page's own marker: the wire is what the model reads.
//
//   P1  F2. A live engine takes a peer's turn. B opens a chat A started and sends (its engine is built); A rates, sends, and the
//       turn syncs; B sends again. B's request holds A's question and answer exactly once, in the chat's order, and A's message
//       goes in as A's own model read it, `pre` byte for byte (the same bytes as in A's request). The same for A after B's turn.
//   P2  F1, one device, no peer. Two chats, a reload, the older chat opened from the rail, a send: the request holds the whole
//       chat, and no engine was built from a transcript that had not loaded (the display path built one).
//   P3  F1 on the second device. B's first send in a chat A started: (a) B never opened it, (b) B opened it before A's turn
//       arrived, (c) B holds an idle engine, built from a chat that was resident at boot, when A's turn arrives. Each request
//       holds the whole chat once, and no engine was built from a transcript that had not loaded.
//   P5  Concurrent turns. Both devices hold a live engine and send while cut off, then converge. Each turn is in each request
//       exactly once and in the chat's order on both devices (the device that held the later turn re-seeds in the chat's order).
//   (P4, the property over interleavings, is `www/js/sessionreconcile.test.mjs`; P6, the suites that must not move, is run by the lane.)
//
// EACH SECTION IS PROVED AGAINST BROKEN CODE, red in the sections it owns and nowhere else:
//
//   --break noextend    P1, P3, P5  `ensureApp` returns a live engine as it stands (the reconcile reverted)
//   --break wirebuild   P2, P3      `renderWire` builds the engine of a chat whose transcript has not loaded (the guard reverted)
//
// Under `wirebuild` the reconcile still cures the wire, so what goes red is the build check: no engine is built from a
// transcript that has not loaded. Under `noextend` the guard still keeps the empty engine away, so P2 stays green.
// A break whose anchor does not match exactly once stops the run (exit 2), so it cannot pass by damaging nothing.
// `--red` skips the anchor check of the breaks, for the red-first run on a tree that does not hold the fix yet, and `--base <file>`
// serves that daimond.js instead of the tree's own: `git show 268a224c:www/js/daimond.js > f` gives the red run on the fixed tree.
//
//   eval "$(bash dev/world.sh N --env)"            # with the live gateway on DAIMOND_GW_PORT, as for provenance
//   RC_SLOT=<slot>-sessrec node dev/verify_session_reconcile.mjs [--break noextend|wirebuild] [--only P1,P2] [--red [--base <daimond.js>]]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, newChat, mockLog, contentText, errors } from './harness.mjs';
import { checker, settle, pair, reload } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const J    = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Breaks ──────────────────────────────────────────────────────────────
const BREAKS = {
	noextend: { sections: ['P1', 'P3', 'P5'], file: 'js/daimond.js',
		what: 'ensureApp returns a live engine as it stands: nothing reconciles it with the chat',
		edits: [
			{ from: 'if (chat.app) return reconcileEngine(chat, exceptMid);',
			  to:   'if (chat.app) return chat.app;\t\t// BROKEN: a live engine is never brought up to the chat' },
		] },
	wirebuild: { sections: ['P2', 'P3'], file: 'js/daimond.js',
		what: 'renderWire builds the engine of a chat whose transcript has not loaded',
		edits: [
			{ from: "if (!did && current._loaded === false) { dropWire(); return; }\n",
			  to:   '\t\t// BROKEN: the display builds an engine from a chat that is not resident\n' },
		] },
};
const arg = (f) => { const i = process.argv.indexOf(f); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };
const BREAK = arg('--break');
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
if (!process.argv.includes('--red')) {
	const stale = [];
	for (const [n, b] of Object.entries(BREAKS)) {
		if (BREAK && n !== BREAK) continue;
		const src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
		for (const e of b.edits) if (src.split(e.from).length !== 2) stale.push(`${n} (${b.file})`);
	}
	if (stale.length) { console.error('break anchor(s) no longer match exactly once: ' + stale.join(', ')); process.exit(2); }
}
const ALL = ['P1', 'P2', 'P3', 'P5'];
const ONLY = new Set((arg('--only') || ALL.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const on = (s) => ONLY.has(s);

// The page is served an instrumented daimond.js (and the break, when asked): nothing on disk changes. `_builds` lists every
// engine this page built, with whether the chat's transcript had loaded.
const INSTR = [
	{ from: 'window.DaimondCore = {\n',
	  to: 'window.DaimondCore = {\n\t\t_builds: function () { return window.__builds || []; },\n' },
	{ from: '\t\tchat.app = new DaimondApp(a.baseUrl, a.apiKey, a.model,',
	  to: '\t\t(window.__builds = window.__builds || []).push({ id: chat.id, nm: (chat.messages || []).length, ld: chat._loaded !== false });\n\t\tchat.app = new DaimondApp(a.baseUrl, a.apiKey, a.model,' },
];
const ROUTE = async (page) => {
	let body = fs.readFileSync(arg('--base') || path.join(WWW, 'js/daimond.js'), 'utf8');
	const edits = INSTR.concat(BREAK ? BREAKS[BREAK].edits : []);
	for (const e of edits) {
		const n = body.split(e.from).length - 1;
		if (n !== 1) { console.error('instrument anchor matched ' + n + ' times: ' + e.from.slice(0, 70)); process.exit(2); }
		body = body.replace(e.from, () => e.to);
	}
	await page.route('**/js/daimond.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
};
if (BREAK) console.log(`\n*** BREAK ${BREAK}: ${BREAKS[BREAK].what} -- failures below are the point ***\n`);

const { ok, bad, check } = checker();
class Stop extends Error { constructor(m) { super(m); this.stop = true; } }
const sections = {};
async function section(name, fn) {
	if (!on(name)) return;
	const o0 = ok.length, b0 = bad.length;
	console.log(`\n== ${name} ==`);
	try { await fn(); }
	catch (e) {
		if (e && e.stop) check(`${name}: stopped: ${e.message}`, false, '');
		else check(`${name}: threw`, false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
	}
	sections[name] = { ok: ok.length - o0, bad: bad.length - b0 };
}

// ── Reading a device ────────────────────────────────────────────────────
const stored = (s, cid) => s.page.evaluate(async (c) => {
	try { const g = await window.DaimondCore.chatStore().loadMessages(c); return JSON.parse(JSON.stringify((g && g.messages) || [])); } catch (e) { return []; }
}, cid).catch(() => []);
const builds = (s) => s.page.evaluate(() => { try { return window.DaimondCore._builds(); } catch (e) { return []; } }).catch(() => []);
async function waitFor(fn, ms = 20000, step = 400) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { /* again */ } await sleep(step); }
	return false;
}
const openChat = async (s, cid) => {
	await s.page.evaluate((c) => { const x = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (x) x.click(); }, cid);
	await sleep(1500);
};
const push = async (s) => { await s.page.evaluate(() => (window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push())).catch(() => {}); await settle(s.page); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {}); await settle(s.page); };
async function carry(from, to, pred, ms = 60000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { await push(from); await pull(to); if (await pred()) return true; await sleep(1200); }
	return false;
}
const hasText = (s, cid, text) => async () => (await stored(s, cid)).some((m) => m.role === 'user' && m.content === text);
const hasAnswerOf = (s, cid, text) => async () => {
	const ms = await stored(s, cid), i = ms.findIndex((m) => m.role === 'user' && m.content === text);
	return i >= 0 && ms.slice(i + 1).some((m) => m.role === 'assistant' && String(m.content || '').trim());
};
/// Both of a turn's messages, the question and its answer, are on `s`.
const hasTurn = (s, cid, text) => async () => (await hasText(s, cid, text)()) && (await hasAnswerOf(s, cid, text)());

/// The chat's prose in its converged order, as the model must read it: (ts, mid), a person's message as `pre`, a blank line and the
/// words, an assistant's as it stands; furniture, a partial answer and an empty message left out.
function proseOf(msgs) {
	return (msgs || []).filter((m) => m && m.content && String(m.content).trim() && (m.role === 'user' || m.role === 'assistant') && !m.interrupted
			&& !m.provisional && !m.framed)
		.slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)))
		.map((m) => ({ role: m.role, text: (m.role === 'user' && typeof m.pre === 'string' && m.pre) ? m.pre + '\n\n' + m.content : String(m.content) }));
}
const norm = (t) => String(t).replace(/\s+$/g, '');
/// What the request holds of the conversation: every message but the system one, as { role, text }.
const wireOf = (req) => ((req && req.messages) || []).filter((m) => m && m.role !== 'system').map((m) => ({ role: m.role, text: contentText(m.content) }));
const brief = (l) => l.map((x) => x.role[0] + ':' + x.text.replace(/\s+/g, ' ').slice(0, 26)).join(' | ');

/// Send `text` on `s` (the chat on screen) and return the model's request for it.
async function sendOn(s, cid, text) {
	const from = mockLog().length;
	await openChat(s, cid);
	await chat(s, text, { timeout: 45000 });
	const mine = (e) => { const u = ((e && e.messages) || []).filter((m) => m && m.role === 'user').map((m) => contentText(m.content)); return u.length > 0 && u[u.length - 1].endsWith(text); };
	await waitFor(() => !!mockLog().slice(from).find(mine), 20000);
	return mockLog().slice(from).find(mine) || null;
}
/// Send, with the chat as `s` stores it read BEFORE the send: the request must hold that, in that order, once each, then the new
/// message. Returns the request, its wire and the converged transcript it was judged against.
async function sendJudged(name, s, cid, text) {
	const before = proseOf(await stored(s, cid));
	const req = await sendOn(s, cid, text);
	check(`${name}: the model was sent the turn`, !!req, req ? '' : 'no request found for ' + text);
	const wire = wireOf(req);
	// The new message goes with the note it took as it was sent (`pre`), which only the record made by the send can say.
	const um = (await stored(s, cid)).find((m) => m.role === 'user' && m.content === text);
	const want = before.concat([{ role: 'user', text: (um && typeof um.pre === 'string' && um.pre) ? um.pre + '\n\n' + text : text }]);
	const same = wire.length === want.length && want.every((w, i) => wire[i].role === w.role && norm(wire[i].text) === norm(w.text));
	check(`${name}: the request holds the whole chat (${before.length} earlier messages) in its converged order, then the new message`, same,
		same ? '' : `wire(${wire.length}) ${brief(wire)}  <>  want(${want.length}) ${brief(want)}`);
	const off = before.map((w) => [w, wire.filter((x) => x.role === w.role && norm(x.text) === norm(w.text)).length]).filter(([, n]) => n !== 1);
	check(`${name}: every earlier message is in the request exactly once`, off.length === 0,
		off.map(([w, n]) => `${w.role[0]}:${w.text.replace(/\s+/g, ' ').slice(0, 24)} x${n}`).join('; '));
	return { req, wire, before };
}
/// No engine was built from a transcript that had not loaded.
async function noEmptyBuild(name, s, cid) {
	const bl = (await builds(s)).filter((x) => x.id === cid);
	const empty = bl.filter((x) => !x.ld);
	check(`${name}: no engine was built from a chat whose transcript had not loaded`, empty.length === 0, empty.length + ' of ' + bl.length + ' builds: ' + J(bl.map((x) => [x.nm, x.ld])));
}
const isAnswer = (m) => !!m && m.role === 'assistant' && String(m.content || '').trim() && Array.isArray(m.prod) && m.prod[0] && m.prod[0].k === 'answer' && !m.provisional && !m.why;
const ctl = (s, mid, cls) => s.page.locator(`#chat-output .ctile[data-mid="${mid}"] .${cls} >> visible=true`).first();
/// A thumbs-up on the answer `mid`, committed, so the person's next message carries a note (`pre`).
async function rateUp(s, cid, mid) {
	const b = ctl(s, mid, 'ctile-rate-up');
	if (!(await b.count())) throw new Stop(`no visible up control on answer ${mid} (${s.name})`);
	await b.click({ force: true });
	await sleep(300);
	const r = await s.page.evaluate(async (c) => { const u = window.DaimondRatingUI; if (!u || typeof u.flush !== 'function') return 'absent'; await u.flush(c); return 'ok'; }, cid);
	if (r !== 'ok') throw new Stop('window.DaimondRatingUI.flush is not exposed on ' + s.name);
	await sleep(500);
}

let a, b;
try {
	({ a, b } = await pair(check, 'sessrec', 'sessmate', { route: ROUTE }));

	// ══ P1. A live engine takes a peer's turn (F2), `pre` as the sender's model read it ═══════════════
	await section('P1', async () => {
		const cid = await newChat(a);
		await chat(a, '@text P1-T1 first'); await chat(a, '@text P1-T2 second');
		check('P1: A holds both turns', await hasTurn(a, cid, '@text P1-T2 second')(), '');
		await newChat(b);
		await carry(a, b, hasTurn(b, cid, '@text P1-T2 second'));
		// B sends in A's chat: its engine is built here, holding T1 and T2.
		await sendJudged('P1: B sends (its engine is built)', b, cid, '@text P1-B3 from-b');
		await carry(b, a, hasTurn(a, cid, '@text P1-B3 from-b'));
		check('P1: A holds B\'s turn', await hasTurn(a, cid, '@text P1-B3 from-b')(), '');
		// A rates T2's answer up, so that its next message carries the note, then sends: A's live engine takes B's turn.
		await openChat(a, cid);
		const ans = (await stored(a, cid)).filter(isAnswer).pop();
		if (!ans) throw new Stop('A holds no answer with a record to rate');
		await rateUp(a, cid, ans.mid);
		const r4 = await sendJudged('P1: A sends after B\'s turn syncs (A\'s engine is live)', a, cid, '@text P1-A4 from-a');
		const ua = (await stored(a, cid)).find((m) => m.role === 'user' && m.content === '@text P1-A4 from-a');
		check('P1: A\'s message took the rating note as `pre`', !!ua && typeof ua.pre === 'string' && ua.pre.startsWith('[Daimond: '), ua ? J(String(ua.pre).slice(0, 40)) : 'no stored message');
		const wa = wireOf(r4.req).filter((x) => x.role === 'user').pop();
		check('P1: on A\'s wire the note, a blank line and the words go as one message', !!ua && !!wa && norm(wa.text) === norm(ua.pre + '\n\n' + ua.content), wa ? J(wa.text.slice(0, 60)) : '');
		await carry(a, b, hasTurn(b, cid, '@text P1-A4 from-a'));
		check('P1: B holds A\'s turn, `pre` byte for byte', J((await stored(b, cid)).find((m) => m.role === 'user' && m.content === '@text P1-A4 from-a')) === J(ua), '');
		const r5 = await sendJudged('P1: B sends after A\'s turn syncs (B\'s engine is live)', b, cid, '@text P1-B5 from-b');
		const held = wireOf(r5.req).filter((x) => x.role === 'user' && x.text.endsWith('@text P1-A4 from-a'));
		check('P1: B\'s request holds A\'s message once, as A\'s model read it (the same bytes as in A\'s request)', held.length === 1 && !!wa && norm(held[0].text) === norm(wa.text),
			held.length + ' copies; ' + (held[0] ? J(held[0].text.slice(0, 60)) : ''));
		await carry(b, a, hasTurn(a, cid, '@text P1-B5 from-b'));
		await sendJudged('P1: A sends after B\'s second turn syncs', a, cid, '@text P1-A6 from-a');
	});

	// ══ P2. One device: reload, open an older chat from the rail, send (F1) ═══════════════════════════
	await section('P2', async () => {
		const c1 = await newChat(a);
		await chat(a, '@text P2-H1 first'); await chat(a, '@text P2-H2 second');
		await newChat(a);
		await chat(a, '@text P2-OTHER a different chat');
		await reload(a);
		await openChat(a, c1);
		await sendJudged('P2: A sends in the older chat after a reload', a, c1, '@text P2-H3 third');
		await noEmptyBuild('P2', a, c1);
	});

	// ══ P3. B's first send in a chat A started (F1 on the second device) ══════════════════════════════
	await section('P3', async () => {
		// (a) B never opened the chat.
		const ca = await newChat(a);
		await chat(a, '@text P3a-T1 first'); await chat(a, '@text P3a-T2 second');
		await newChat(b);
		await carry(a, b, hasTurn(b, ca, '@text P3a-T2 second'));
		await chat(a, '@text P3a-A3 from-a');
		await carry(a, b, hasTurn(b, ca, '@text P3a-A3 from-a'));
		await sendJudged('P3a: B opens the chat A started and sends', b, ca, '@text P3a-B4 from-b');
		await noEmptyBuild('P3a', b, ca);
		// (b) B opened the chat before A's turn arrived.
		const cb = await newChat(a);
		await chat(a, '@text P3b-T1 first'); await chat(a, '@text P3b-T2 second');
		await carry(a, b, hasTurn(b, cb, '@text P3b-T2 second'));
		await openChat(b, cb);
		await chat(a, '@text P3b-A3 from-a');
		await carry(a, b, hasTurn(b, cb, '@text P3b-A3 from-a'));
		await sendJudged('P3b: B, which opened the chat before A\'s turn, sends', b, cb, '@text P3b-B4 from-b');
		await noEmptyBuild('P3b', b, cb);
		// (c) B holds an idle engine, built from a chat that was resident at boot, when A's turn arrives.
		const cc = await newChat(a);
		await chat(a, '@text P3c-T1 first'); await chat(a, '@text P3c-T2 second');
		await carry(a, b, hasTurn(b, cc, '@text P3c-T2 second'));
		await openChat(b, cc);
		await reload(b);
		const bl = (await builds(b)).filter((x) => x.id === cc);
		console.log('  (P3c: B\'s engines after the reload, [messages held, transcript loaded]: ' + J(bl.map((x) => [x.nm, x.ld])) + ')');
		check('P3c: B built its engine from the resident chat at boot, holding the chat (the shape the case needs)', bl.length >= 1 && bl.every((x) => x.ld && x.nm >= 4), J(bl.map((x) => [x.nm, x.ld])));
		await chat(a, '@text P3c-A3 from-a');
		await carry(a, b, hasTurn(b, cc, '@text P3c-A3 from-a'));
		await sendJudged('P3c: B, whose engine was idle when A\'s turn arrived, sends', b, cc, '@text P3c-B4 from-b');
		await noEmptyBuild('P3c', b, cc);
	});

	// ══ P5. Concurrent turns, then one converged chat ═══════════════════════════════════════════════
	await section('P5', async () => {
		const cid = await newChat(a);
		await chat(a, '@text P5-T1 first');
		await newChat(b);
		await carry(a, b, hasTurn(b, cid, '@text P5-T1 first'));
		await sendJudged('P5: B sends B0 (its engine is built and has run)', b, cid, '@text P5-B0 from-b');
		await carry(b, a, hasTurn(a, cid, '@text P5-B0 from-b'));
		// A and B cut off from each other: A's turn is finished before B's begins, so the chat's order is A1 then B1.
		await sendJudged('P5: A sends A1 (B0 reached it)', a, cid, '@text P5-A1 from-a');
		const rb1 = await sendOn(b, cid, '@text P5-B1 from-b');
		check('P5: B sent B1 without having A1 (the turns are concurrent)', !!rb1 && !wireOf(rb1).some((x) => x.text.includes('P5-A1')), '');
		await carry(a, b, hasTurn(b, cid, '@text P5-A1 from-a'));
		await carry(b, a, hasTurn(a, cid, '@text P5-B1 from-b'));
		const sa = proseOf(await stored(a, cid)), sb = proseOf(await stored(b, cid));
		check('P5: the two devices hold the same chat in the same order', J(sa) === J(sb), sa.length + ' / ' + sb.length + ' messages');
		const tx = sa.map((x) => x.text.replace(/\s+/g, ' ')).join(' | ');
		const pa = tx.indexOf('P5-A1'), pb = tx.indexOf('P5-B1');
		check('P5: the converged order is A1 then B1', pa >= 0 && pb > pa, '');
		// One sends: each turn once, in the chat's order, on A (which held the earlier turn and appends B1) and on B (which re-seeds).
		await sendJudged('P5: A sends A2 (a live engine takes B1, which came after its own tail)', a, cid, '@text P5-A2 from-a');
		await carry(a, b, hasTurn(b, cid, '@text P5-A2 from-a'));
		await sendJudged('P5: B sends B2 (a live engine takes A1, which came before its own tail)', b, cid, '@text P5-B2 from-b');
		await carry(b, a, hasTurn(a, cid, '@text P5-B2 from-b'));
		await sendJudged('P5: A sends A3 once more, on the chat B now holds in order', a, cid, '@text P5-A3 from-a');
	});
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e).slice(0, 700));
} finally {
	for (const [n, s] of [['A', a], ['B', b]]) {
		if (!s) continue;
		let errs = []; try { errs = (errors(s) || []).filter((x) => /append_message|restore|reconcile|already borrowed|unreachable/i.test(x)); } catch (e) { errs = []; }
		check(`${n}: no page error from the engine's session calls`, errs.length === 0, errs.slice(0, 2).join(' | '));
	}
	await a?.close().catch(() => {});
	await b?.close().catch(() => {});
}

console.log('\nsections: ' + Object.entries(sections).map(([n, v]) => `${n} ${v.ok} ok/${v.bad} failed`).join(', '));
if (BREAK) {
	const red = Object.entries(sections).filter(([, v]) => v.bad > 0).map(([n]) => n);
	const want = BREAKS[BREAK].sections;
	const exact = red.length === want.length && want.every((n) => red.includes(n)) && bad.every((n) => want.some((w) => n.startsWith(w)));
	console.log(`\nbreak '${BREAK}': red in ${red.length ? red.join(', ') : 'NOTHING'}; wanted ${want.join(', ')} only -- ${exact ? 'AS WANTED' : (red.length ? 'WRONG SET' : 'NOTHING FAILED, so the checks prove nothing')}`);
	process.exit(exact ? 0 : 1);
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
