// gateway: live
// verify_ratings_sync.mjs — a rating made on one device is the same rating on the other
// (Unit H of the U2 plan, ~/usr/code/ai/claude/specs/daimond_rating_u2_plan_20260930.md §4).
//
// Two paired devices of one Pro account on the real gateway, as `verify_provenance.mjs` has them:
// A is the touch context (so it wears the row form of the rating controls), B the desktop. A
// rating is a `rating_log` message at the end of its chat, and it travels in the ordinary parcel,
// by the legacy `chats` section: union by `mid`, first copy wins. U2 adds no sync path, no
// `touchChat` and no key, so what is proved here is that the plain union is enough:
//
//   S1  A rates X up by tap and Y -2 through the popup (tags, a dimension, a note), commits and
//       pushes. B pulls: both messages are there byte for byte, B's arrows are lit as A's are
//       with Y's details control on, and B draws ONE Rating tile of two lines.
//   S2  B rates X down. The record names A's X record in `sup`. After the round A's X is lit down
//       and both devices hold the same head. A draws B's tile.
//   S3  Both devices lose the mailbox. A rates Z up and B rates Z down, both with `sup` ''. Both
//       come back and sync. Both records are on both devices, byte for byte, and the head is the
//       same record on both: the greater (ts, mid), by a rule WRITTEN HERE and not read from the
//       page, and both arrows show it.
//   S4  Both reload. Every lit state and every Rating tile is what it was (Z is held to the head
//       derived from the stored messages, because S3 owns what it showed before the reload).
//   S5  The next `@text` turn on each device: the mock's logged request carries no rating
//       message, no rating key, no note and no rating id (I7).
//   S6  W16's gone wording, which one device cannot reach: a `rating_log` forged into A's store
//       for an answer no chat holds is drawn "an answer no longer here", with no link, on A after
//       a reload and on B after it has synced, while the lines for real answers keep their link.
//
// A device that cannot see a rating is reported by name, never skipped. S1 is where a missing
// `touchChat` would show (D6): a chat that reaches the other device only because it moved up the
// rail. The run stops at that point and says so; it never adds the touch.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE. `--break order` serves a ratings.js whose head is the
// record this page SAW LAST (a number given to each record as it first appears), instead of the
// greatest (ts, mid). The two devices then disagree about Z, and the run must go red in S3 and
// nowhere else:
//
//   node dev/verify_ratings_sync.mjs --break order
//   node dev/verify_ratings_sync.mjs                      # and then, clean
//
// The other five sections are proved the same way, one break each, each red in its own section and
// nowhere else (a break damages a behaviour and not a stored record, because a rating is permanent
// and a wrong record on the wire would redden every later section that compares the devices):
//
//   --break nopush    S1  the commit saves with the sync nudge held off, so it does not push itself
//   --break nosup     S2  a draft over a head takes `sup` '' instead of naming the head
//   --break order     S3  (above)
//   --break regroup   S4  a thread painted from an empty page draws each rating line as a tile of its own
//   --break wire      S5  the newest rating note is sent to the model with the next message
//   --break link      S6  the Rating tile links an answer that is no longer here
//
// A break whose anchor does not match exactly once stops the run (exit 2), so it cannot pass by
// damaging nothing. `--only S1,S2` runs the named sections; a break runs them all and the verdict
// is the set of sections that went red.
//
//   eval "$(bash dev/world.sh N --env)"            # a gateway on DAIMOND_GW_PORT, as for provenance
//   RC_SLOT=<slot>-rate2s node dev/verify_ratings_sync.mjs [--break order] [--only S3]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, newChat, mockLog, errors, shot } from './harness.mjs';
import { checker, settle, pair, reload } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const J    = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Breaks ──────────────────────────────────────────────────────────────
// `from` must occur exactly once in `file`. `order` is two edits of one file: every rating message is
// numbered as it is first seen by this page (`isRatingMsg` is called on each message of a chat the first
// time it is drawn or indexed), and `later` compares those numbers instead of (ts, mid). A record made
// here is numbered at its commit; a record from the other device is numbered when it arrives. So each
// device ranks its own record first and the other's last, whatever their clocks said.
const BREAKS = {
	order: { section: 'S3', file: 'js/ratings.js',
		what: 'the head is the record this page saw last, not the greatest (ts, mid)',
		edits: [
			{ from: '\tfunction later(a, b) {\n\t\tif (a.ts !== b.ts) return a.ts > b.ts;\n\t\treturn a.mid > b.mid;\n\t}\n',
			  to:   '\tvar __seen = {}, __n = 0;\n\tfunction __num(m) { if (__seen[m.mid] === undefined) __seen[m.mid] = ++__n; return __seen[m.mid]; }\n\tfunction later(a, b) { return __num(a) > __num(b); }\n' },
			{ from: '\tfunction isRatingMsg(m) {\n',
			  to:   '\tfunction isRatingMsg(m) { var ok = isRatingMsg0(m); if (ok) __num(m); return ok; }\n\tfunction isRatingMsg0(m) {\n' },
		] },
	// The other five are single edits, each chosen so that the damage reaches ONE section. A rating is permanent
	// (first copy wins), so a break that changed a record on the wire would leave the wrong bytes on the other device
	// and redden every later section that compares the two; these damage a behaviour, not a stored record.
	//
	// S1: the commit's save runs with the sync nudge held off (the page's own `packingParcel` guard, which `nudgeSync`
	// honours). The record is stored and drawn, but nothing arms the push; the verifier's `carry` pushes by hand, so the
	// later sections are untouched and only "the commit pushed itself" is red.
	nopush: { section: 'S1', file: 'js/daimond.js',
		what: 'the rating commit saves with the sync nudge held off, so it does not push itself',
		edits: [
			{ from: 'persistChats();\t\t// and no touchChat: a rating is not a turn\n',
			  to:   'var __pp = packingParcel; packingParcel = true;\t\t// BROKEN: the commit saves without arming the sync\n\t\t\ttry { persistChats(); } finally { packingParcel = __pp; }\n' },
		] },
	// S2: a draft over a head takes `sup` '' and so never names the record it supersedes. On one machine the later
	// clock still makes the new record the head, so only S2's check of `sup` itself can see it (it matters under skew).
	nosup: { section: 'S2', file: 'js/ratings.js',
		what: 'a draft over a head takes `sup` \'\' instead of naming the head',
		edits: [
			{ from: "sup: ctx && ctx.head ? ctx.head.mid : '' };",
			  to:   "sup: '' };" },
		] },
	// S4: a thread painted from an empty page (a reload, a chat opened from the rail) draws each rating line as a tile of
	// its own, keyed by the line's mid, where the live paths group by burst. A reloaded chat opens EMPTY and takes its
	// transcript as an append from index 0, so the damage is placed in the append loop, on the `_renderedSigs.length === 0`
	// draw only: a pull onto a thread already on screen (S1, S2, S3) is untouched, and S6's forged line has mid == burst, so
	// it draws the same. (A first try at the full-rebuild loop reddened S2, where A's live thread is rebuilt by a pull, and
	// did not redden S4, where the reload takes the append loop.)
	regroup: { section: 'S4', file: 'js/daimond.js',
		what: 'a thread painted from an empty page groups each rating line by its own mid and not by its burst',
		edits: [
			{ from: 'drawHistoryMessage(messages[i]);',
			  to:   'drawHistoryMessage(_renderedSigs.length === 0 && messages[i] && messages[i].role === "rating_log" && messages[i].rating\t\t// BROKEN: a first paint groups a rating by its own id\n\t\t\t\t\t\t? Object.assign({}, messages[i], { rating: Object.assign({}, messages[i].rating, { burst: messages[i].mid }) }) : messages[i]);' },
		] },
	// S5: the newest rating note is appended to the text the agent is sent (the stored user message is untouched).
	// Same anchor and damage as `wire` in verify_rating_widget.mjs.
	wire: { section: 'S5', file: 'js/daimond.js',
		what: 'the newest rating note is sent to the model with the next message',
		edits: [
			{ from: "\t\t\t\ttry {\n\t\t\t\t\tawait app.run_turn(text, onEvent);\n\t\t\t\t} catch (e) {\n\t\t\t\t\tif (capFail) {",
			  to:   "\t\t\t\ttry {\n\t\t\t\t\tawait app.run_turn(text + (function () { var w = chat.messages.filter(function (m) { return m.role === 'rating_log' && m.rating && m.rating.note; }).pop(); return w ? '\\n' + w.rating.note : ''; })(), onEvent);\n\t\t\t\t} catch (e) {\n\t\t\t\t\tif (capFail) {" },
		] },
	// S6: the line for a rating whose answer has gone is drawn with a link anyway.
	link: { section: 'S6', file: 'js/daimond.js',
		what: 'the Rating tile links an answer that is no longer here',
		edits: [
			{ from: 'if (L.targetMid !== null) {',
			  to:   'if (true) {\t\t// BROKEN: links a target that has gone' },
			{ from: "what.textContent = t('rating.log_answer', { time: hhmm(target.ts) });",
			  to:   "what.textContent = t('rating.log_answer', { time: hhmm(target ? target.ts : m.ts) });" },
		] },
};
const arg = (f) => { const i = process.argv.indexOf(f); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };
const BREAK = arg('--break');
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
{
	const stale = [];
	for (const [n, b] of Object.entries(BREAKS)) {
		const src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
		for (const e of b.edits) if (src.split(e.from).length !== 2) stale.push(`${n} (${b.file})`);
	}
	if (stale.length) { console.error('break anchor(s) no longer match exactly once: ' + stale.join(', ')); process.exit(2); }
}
const ALL = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const ONLY = new Set((arg('--only') || ALL.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const on = (s) => ONLY.has(s);
const ROUTE = !BREAK ? null : async (page) => {
	const b = BREAKS[BREAK];
	let body = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	for (const e of b.edits) body = body.replace(e.from, () => e.to);
	await page.route('**/' + b.file + '*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
};
if (BREAK) console.log(`\n*** BREAK ${BREAK}: ${BREAKS[BREAK].what} — failures below are the point ***\n`);

const { ok, bad, check } = checker();
class Stop extends Error { constructor(m) { super(m); this.stop = true; } }

// ── The contract, written from the plan and not from the page ───────────
const KEYS = 'h,hash,s,clear,tags,dims,note,form,src,sup,priv,hx,burst,tools,len,prod'.split(',');
const DIMS = 'correct,followed,length,style'.split(',');
/// §2.4, exactly. Answers Map<h, headMessage|null>; a cleared head is null.
function heads(msgs) {
	const rs = (msgs || []).filter((m) => m && m.role === 'rating_log' && m.rating && typeof m.rating.h === 'string');
	const sup = new Set(rs.map((m) => m.rating.sup).filter(Boolean));
	const by = new Map();
	for (const m of rs) {
		if (sup.has(m.mid)) continue;
		const c = by.get(m.rating.h);
		if (!c || m.ts > c.ts || (m.ts === c.ts && m.mid > c.mid)) by.set(m.rating.h, m);
	}
	const out = new Map();
	for (const [h, m] of by) out.set(h, m.rating.clear ? null : m);
	return out;
}
const litOfHead = (m) => !m ? '' : (m.rating.s > 0 ? 'up' : (m.rating.s < 0 ? 'down' : ''));
const detailOfHead = (m) => !!m && (Math.abs(m.rating.s) === 2 || m.rating.s === 0 || m.rating.tags.length > 0
	|| DIMS.some((d) => m.rating.dims[d] !== -1) || m.rating.note !== '');
const isAnswer = (m) => !!m && m.role === 'assistant' && String(m.content || '').trim() && Array.isArray(m.prod)
	&& m.prod[0] && m.prod[0].k === 'answer' && !m.provisional && !m.why;
const NOTE = 'Just give me the command — "no" preamble.\nÉtape 2: ✓ 日本語のメモ, and a few more words so that it is long.';

// ── Reading a device ────────────────────────────────────────────────────
const stored = (s, cid) => s.page.evaluate(async (c) => {
	try { const g = await window.DaimondCore.chatStore().loadMessages(c); return JSON.parse(JSON.stringify((g && g.messages) || [])); } catch (e) { return []; }
}, cid).catch(() => []);
const ratingsOf = async (s, cid) => (await stored(s, cid)).filter((m) => m && m.role === 'rating_log');
const answersOf = async (s, cid) => (await stored(s, cid)).filter(isAnswer);
const byMid = (list) => { const o = {}; for (const m of list) o[String(m.mid)] = m; return o; };
async function waitFor(fn, ms = 20000, step = 400) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { /* again */ } await sleep(step); }
	return false;
}
const mq = (mid) => `#chat-output .ctile[data-mid="${mid}"]`;
/// The visible copy of a control on answer `mid`: the header form or the row form, whichever shows.
const ctl = (s, mid, cls) => s.page.locator(`${mq(mid)} .${cls} >> visible=true`).first();
/// What an answer's tile shows of its rating.
const facts = (s, mid) => s.page.evaluate((mid) => {
	const t = document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`);
	if (!t) return { tile: false };
	const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
	const g = [...t.querySelectorAll('.ctile-rate')].filter(vis)[0] || null;
	const b = (c) => g && g.querySelector('.' + c);
	const lit = !g ? '' : (b('ctile-rate-up').getAttribute('aria-pressed') === 'true' ? 'up'
		: (b('ctile-rate-down').getAttribute('aria-pressed') === 'true' ? 'down' : ''));
	return { tile: true, shown: !!g, lit, detail: !!(g && b('ctile-rate-more').classList.contains('on')) };
}, mid).catch(() => ({ tile: false }));
/// The Rating tiles of the chat on screen, with their lines.
const rtiles = (s) => s.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')].map((t) => ({
	burst: t.dataset.burst || '',
	lines: [...t.querySelectorAll('.rate-line')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
	links: [...t.querySelectorAll('.rate-line')].map((l) => l.querySelectorAll('button.rate-jump-link').length),
}))).catch(() => []);
const pendingOf = (s, cid) => s.page.evaluate((c) => { try { return window.DaimondRatingUI.pendingCount(c); } catch (e) { return -1; } }, cid);
async function flushRatings(s, cid) {
	const r = await s.page.evaluate(async (c) => {
		const u = window.DaimondRatingUI; if (!u || typeof u.flush !== 'function') return 'absent';
		await u.flush(c); return 'ok';
	}, cid);
	if (r !== 'ok') throw new Stop('window.DaimondRatingUI.flush is not exposed on ' + s.name);
	await sleep(500);
}
async function tap(s, mid, which) {
	const b = ctl(s, mid, 'ctile-rate-' + which);
	if (!(await b.count())) throw new Stop(`no visible ${which} control on answer ${mid} (${s.name})`);
	await b.click({ force: true });
	await sleep(200);
}
/// Rate through the popup: a step by position (0 is Wrong), tags by position, one dimension, a note.
async function popupRate(s, mid, { step, tags = [], dim = null, note = '' }) {
	const b = ctl(s, mid, 'ctile-rate-more');
	if (!(await b.count())) throw new Stop(`no details control on answer ${mid} (${s.name})`);
	await b.click({ force: true });
	await s.page.waitForSelector('.rate-card', { timeout: 4000 }).catch(() => {});
	if (!(await s.page.locator('.rate-card >> visible=true').count())) throw new Stop('the details control opens no popup on ' + s.name);
	await s.page.locator('.rate-card .rate-scale .tile-dlg-level').nth(step).click({ force: true });
	for (const i of tags) await s.page.locator('.rate-card .ctile-rate-tags .tile-dlg-level').nth(i).click({ force: true });
	if (dim || note) {
		const open = await s.page.evaluate(() => { const d = document.querySelector('.rate-card details'); return !!d && d.open; });
		if (!open) await s.page.locator('.rate-card details > summary').first().click({ force: true });
		await sleep(200);
		if (dim) await s.page.locator('.rate-card .rate-dim').nth(dim[0]).locator('.tile-dlg-level').nth(dim[1]).click({ force: true });
		if (note) await s.page.locator('.rate-card textarea.rate-said-input').fill(note);
	}
	await s.page.locator('.rate-card .ui-close').first().click({ force: true });
	await sleep(300);
}
async function openChat(s, cid, mid) {
	await s.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
	return waitFor(async () => (await facts(s, mid)).tile, 20000);
}

// ── Moving a parcel ─────────────────────────────────────────────────────
const push = async (s) => { await s.page.evaluate(() => (window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push())).catch(() => {}); await settle(s.page); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {}); await settle(s.page); };
/// Rounds from `from` to `to` until `pred()` holds, or the time is up.
async function carry(from, to, pred, ms = 90000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		await push(from); await pull(to);
		if (await pred()) return true;
		await sleep(1200);
	}
	return false;
}
/// Cut a device off from the mailbox, or put it back. Every `/api/sync` call fails meanwhile; the count is what proves it held.
async function offline(s, off) {
	if (off) { s.cut = 0; await s.page.route('**/api/sync**', (r) => { s.cut++; r.abort(); }); }
	else await s.page.unroute('**/api/sync**');
}

// ── The run ─────────────────────────────────────────────────────────────
let a, b, cid = '';
let X = null, Y = null, Z = null;		// the three answers, as stored on A
let rX = null, rY = null;				// A's two records from S1
const xmid = () => String(X.mid), ymid = () => String(Y.mid), zmid = () => String(Z.mid);
const seenErrors = [];
const sections = {};
async function section(name, fn) {
	if (!on(name)) return;
	console.log(`\n── ${name} ──`);
	const n0 = ok.length, f0 = bad.length;
	try { await fn(); }
	catch (e) {
		check(`${name}: ${e.stop ? e.message : 'threw: ' + String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')}`, false,
			e.stop ? 'stopped; nothing was worked around' : '');
	}
	sections[name] = { ok: ok.length - n0, bad: bad.length - f0 };
}
/// One chat turn on `s`, answered by the mock; its answer as stored on `s`.
async function turn(s, text) {
	const n = (await answersOf(s, cid)).length;
	await chat(s, text);
	await waitFor(async () => (await answersOf(s, cid)).length > n, 20000);
	const all = await answersOf(s, cid);
	return all.length > n ? all[all.length - 1] : null;
}

try {
	({ a, b } = await pair(check, 'ratesync', 'ratemate', { route: ROUTE }));

	// ── Set-up: a chat of three answers on A, carried to B, nothing rated ──
	cid = await newChat(a);
	X = await turn(a, '@text SYNC-X the first answer');
	Y = await turn(a, '@text SYNC-Y the second answer');
	Z = await turn(a, '@text SYNC-Z the third answer');
	check('set-up: A holds three answers, each with its record', !!X && !!Y && !!Z && [X, Y, Z].every((m) => m.prod[0].k === 'answer'),
		[X, Y, Z].map((m) => m ? String(m.mid) : '(none)').join(' '));
	if (!(X && Y && Z)) throw new Stop('A has not three answers to rate');
	const have3 = async () => { const m = byMid(await answersOf(b, cid)); return !!(m[xmid()] && m[ymid()] && m[zmid()]); };
	const got3 = await carry(a, b, have3);
	check('set-up: the chat and its three answers reach B', got3, '');
	if (!got3) throw new Stop('B never received the chat');
	check('set-up: B holds the answers byte-identically (records included)', J((await answersOf(b, cid)).slice(-3)) === J([X, Y, Z]), '');
	const seen = await openChat(b, cid, xmid());
	check('set-up: B can open the chat and its tiles carry data-mid', seen && (await facts(b, xmid())).shown === true, J(await facts(b, xmid())));
	check('set-up: nothing is rated and nothing is pending on either device',
		(await ratingsOf(a, cid)).length === 0 && (await ratingsOf(b, cid)).length === 0
		&& (await pendingOf(a, cid)) === 0 && (await pendingOf(b, cid)) === 0, '');
	if (!seen) throw new Stop('B shows no tile for the first answer');

	// ══ S1. A rates X up and Y -2; B pulls ══════════════════════════════
	await section('S1', async () => {
		await tap(a, xmid(), 'up');
		await popupRate(a, ymid(), { step: 0, tags: [1, 2], dim: [0, 1], note: NOTE });
		check('S1: before the commit nothing has been written and two drafts are pending', (await ratingsOf(a, cid)).length === 0 && (await pendingOf(a, cid)) === 2,
			`${(await ratingsOf(a, cid)).length} written, ${await pendingOf(a, cid)} pending`);
		const v0 = await a.page.evaluate(() => window.DaimondSync.state().version | 0);
		await flushRatings(a, cid);
		const rs = await ratingsOf(a, cid);
		check('S1: A committed exactly two rating_log messages, as one burst', rs.length === 2 && rs[0].ts === rs[1].ts && rs[0].rating.burst === rs[1].rating.burst, `${rs.length} messages`);
		const rX0 = rs.find((m) => m.rating.h === X.prod[0].h), rY0 = rs.find((m) => m.rating.h === Y.prod[0].h);
		check('S1: X is s 1 by tap and Y is s -2 by popup with its tags, dimension and note',
			!!rX0 && !!rY0 && rX0.rating.s === 1 && rX0.rating.src === 'tap' && rY0.rating.s === -2 && rY0.rating.src === 'popup'
			&& J(rY0.rating.tags) === '["ignored","long"]' && rY0.rating.dims.correct === 1 && rY0.rating.note === NOTE,
			J({ x: rX0 && [rX0.rating.s, rX0.rating.src], y: rY0 && [rY0.rating.s, rY0.rating.src, rY0.rating.tags, rY0.rating.dims, rY0.rating.note.length] }));
		check('S1: both records have every key of the declared Rating, in order', rs.every((m) => J(Object.keys(m.rating)) === J(KEYS) && J(Object.keys(m)) === J(['role', 'mid', 'ts', 'rating'])),
			rs.map((m) => Object.keys(m.rating).join(',')).join(' | ').slice(0, 120));
		rX = rX0; rY = rY0;
		if (!(rX && rY)) throw new Stop('A wrote no record for X or Y');

		// THE COMMIT PUSHES ITSELF. Nothing here calls a push on A: the commit is an ordinary save of the chat, and
		// the save arms the sync (I5, D6: a rating needs no `touchChat` and no path of its own). B then asks once.
		const both = async () => { const m = byMid(await ratingsOf(b, cid)); return !!(m[rX.mid] && m[rY.mid]); };
		const rose = await waitFor(async () => (await a.page.evaluate(() => window.DaimondSync.state().version | 0)) > v0, 30000, 500);
		await pull(b);
		check('S1: A\'s commit pushed itself (the mailbox version rose with no push called), and B\'s plain pull holds both records', rose && await both(),
			`version from ${v0} to ${await a.page.evaluate(() => window.DaimondSync.state().version | 0)}, B has them: ${await both()}`);
		const there = await carry(a, b, both);
		check('S1: B received both records', there, '');
		if (!there) {
			// D6: a chat that is not first on the rail is carried only if the union moves it. Say what is the case.
			throw new Stop('B never received the ratings (no touchChat was added: plan §12.4, D6)');
		}
		const bm = byMid(await ratingsOf(b, cid));
		check('S1: B holds X\'s record byte-identical to A\'s (JSON.stringify equal)', J(bm[rX.mid]) === J(rX), J(bm[rX.mid]).slice(0, 100));
		check('S1: B holds Y\'s record byte-identical to A\'s, note and all', J(bm[rY.mid]) === J(rY), J(bm[rY.mid]).slice(0, 100));
		const lit = async (s) => ({ x: await facts(s, xmid()), y: await facts(s, ymid()), z: await facts(s, zmid()) });
		await waitFor(async () => (await lit(b)).y.lit === 'down', 15000);
		const fa = await lit(a), fb = await lit(b);
		check('S1: A\'s arrows: X up, Y down, Z unlit; Y\'s details control on and X\'s off',
			fa.x.lit === 'up' && fa.y.lit === 'down' && fa.z.lit === '' && fa.y.detail === true && fa.x.detail === false, J(fa));
		check('S1: B\'s arrows are lit identically, with Y\'s details control on',
			fb.x.lit === 'up' && fb.y.lit === 'down' && fb.z.lit === '' && fb.y.detail === true && fb.x.detail === false, J(fb));
		const tb = await rtiles(b);
		check('S1: B draws ONE Rating tile with two lines', tb.length === 1 && tb[0].lines.length === 2, J(tb));
		check('S1: A draws the same one tile and two lines, and both devices read the same words', J(await rtiles(a)) === J(tb), J(await rtiles(a)));
		check('S1: the lines are in first-touched order and carry the note on Y\'s', tb.length === 1 && /^\+1/.test(tb[0].lines[0]) && /^[−-]2/.test(tb[0].lines[1])
			&& tb[0].lines[1].includes('Just give me the command'), J(tb[0] && tb[0].lines).slice(0, 160));
	});

	// ══ S2. B rates X down, over A's up ═════════════════════════════════
	let rX2 = null;
	await section('S2', async () => {
		if (!rX) throw new Stop('S1 left no record of A\'s for X to supersede');
		const n0 = (await ratingsOf(b, cid)).length;
		await tap(b, xmid(), 'down');
		check('S2: B\'s down arrow is lit at once, before any commit', (await facts(b, xmid())).lit === 'down', J(await facts(b, xmid())));
		await flushRatings(b, cid);
		const fresh = (await ratingsOf(b, cid)).slice(n0);
		check('S2: B wrote one new record', fresh.length === 1, fresh.length + ' new');
		rX2 = fresh[0];
		if (!rX2) throw new Stop('B wrote no record');
		check('S2: it is s -1 by tap, for X, and its `sup` is A\'s X record', rX2.rating.s === -1 && rX2.rating.src === 'tap' && rX2.rating.h === X.prod[0].h && rX2.rating.sup === rX.mid,
			J({ s: rX2.rating.s, h: rX2.rating.h, sup: rX2.rating.sup, wantSup: rX.mid }));
		const there = await carry(b, a, async () => !!byMid(await ratingsOf(a, cid))[rX2.mid]);
		check('S2: A received it', there, '');
		check('S2: A holds it byte-identical to B\'s', J(byMid(await ratingsOf(a, cid))[rX2.mid]) === J(rX2), '');
		await waitFor(async () => (await facts(a, xmid())).lit === 'down', 15000);
		const fa = await facts(a, xmid()), fb = await facts(b, xmid());
		check('S2: A\'s X is lit down, as B\'s is', fa.lit === 'down' && fb.lit === 'down', J({ a: fa, b: fb }));
		const ha = heads(await stored(a, cid)).get(X.prod[0].h), hb = heads(await stored(b, cid)).get(X.prod[0].h);
		check('S2: both devices hold the same head for X, and it is B\'s record (A\'s is superseded)', !!ha && !!hb && ha.mid === hb.mid && ha.mid === rX2.mid, `${ha && ha.mid} / ${hb && hb.mid}`);
		const f2 = { ay: await facts(a, ymid()), by: await facts(b, ymid()) };
		check('S2: Y is untouched: down with its details on, on both', f2.ay.lit === 'down' && f2.by.lit === 'down' && f2.ay.detail && f2.by.detail, J(f2));
		const ta = await rtiles(a), tb = await rtiles(b);
		check('S2: both devices draw two Rating tiles, the second of one line, and read the same words', ta.length === 2 && tb.length === 2 && ta[1].lines.length === 1 && J(ta) === J(tb), J({ a: ta.map((t) => t.lines.length), b: tb.map((t) => t.lines.length) }));
	});

	// ══ S3. Both devices offline: Z up on A, Z down on B ════════════════
	let zA = null, zB = null;
	await section('S3', async () => {
		await offline(a, true); await offline(b, true);
		try {
			const nA = (await ratingsOf(a, cid)).length, nB = (await ratingsOf(b, cid)).length;
			await tap(a, zmid(), 'up'); await flushRatings(a, cid);
			await sleep(1500);			// B's clock is later by a margin both devices can read, so the head is not a toss of equal ts
			await tap(b, zmid(), 'down'); await flushRatings(b, cid);
			await sleep(1500);
			await push(a); await push(b);			// each asks the mailbox once more, and is refused
			zA = (await ratingsOf(a, cid)).slice(nA)[0]; zB = (await ratingsOf(b, cid)).slice(nB)[0];
			check('S3: each device wrote one record for Z while cut off', !!zA && !!zB && (await ratingsOf(a, cid)).length === nA + 1 && (await ratingsOf(b, cid)).length === nB + 1, `A ${nA}->${(await ratingsOf(a, cid)).length}, B ${nB}->${(await ratingsOf(b, cid)).length}`);
			if (!(zA && zB)) throw new Stop('a device wrote no record for Z');
			check('S3: both have `sup` \'\' (neither saw the other) and are made one after the other', zA.rating.sup === '' && zB.rating.sup === '' && zA.rating.s === 1 && zB.rating.s === -1 && zB.ts > zA.ts,
				J({ a: [zA.rating.s, zA.rating.sup, zA.ts], b: [zB.rating.s, zB.rating.sup, zB.ts] }));
			check('S3: neither device saw the other\'s record while cut off, and the mailbox refused both', !byMid(await ratingsOf(a, cid))[zB.mid] && !byMid(await ratingsOf(b, cid))[zA.mid] && a.cut > 0 && b.cut > 0,
				`refused calls: A ${a.cut}, B ${b.cut}`);
		} finally { await offline(a, false); await offline(b, false); }
		if (!(zA && zB)) throw new Stop('no Z records');
		const both = async (s) => { const m = byMid(await ratingsOf(s, cid)); return !!(m[zA.mid] && m[zB.mid]); };
		await carry(a, b, () => both(b));
		await carry(b, a, () => both(a));
		await carry(a, b, () => both(b), 30000);
		const onA = await both(a), onB = await both(b);
		check('S3: after both sync, both records are on both devices', onA && onB, `A ${onA}, B ${onB}`);
		const ma = byMid(await ratingsOf(a, cid)), mb = byMid(await ratingsOf(b, cid));
		check('S3: each is byte-identical on both devices', J(ma[zA.mid]) === J(mb[zA.mid]) && J(ma[zB.mid]) === J(mb[zB.mid]) && J(ma[zA.mid]) === J(zA) && J(mb[zB.mid]) === J(zB), '');
		const want = (zA.ts !== zB.ts ? (zA.ts > zB.ts ? zA : zB) : (zA.mid > zB.mid ? zA : zB));
		const ha = heads(await stored(a, cid)).get(Z.prod[0].h), hb = heads(await stored(b, cid)).get(Z.prod[0].h);
		check('S3: the head is the same record on both devices, and it is the greater (ts, mid)', !!ha && !!hb && ha.mid === hb.mid && ha.mid === want.mid, `A ${ha && ha.mid}, B ${hb && hb.mid}, wanted ${want.mid} (ts ${zA.ts} / ${zB.ts})`);
		const wantLit = litOfHead(want);
		await waitFor(async () => (await facts(a, zmid())).lit === wantLit && (await facts(b, zmid())).lit === wantLit, 15000);
		const fa = await facts(a, zmid()), fb = await facts(b, zmid());
		check('S3: A\'s arrow for Z shows that head', fa.lit === wantLit, `A shows ${J(fa.lit)}, the head is ${wantLit}`);
		check('S3: B\'s arrow for Z shows that head', fb.lit === wantLit, `B shows ${J(fb.lit)}, the head is ${wantLit}`);
		check('S3: both devices show the same arrow', fa.lit === fb.lit, J({ a: fa.lit, b: fb.lit }));
	});

	// ══ S4. Both reload: the lit states and the tiles are what they were ═
	let before = null;
	await section('S4', async () => {
		const snap = async (s) => ({ x: await facts(s, xmid()), y: await facts(s, ymid()), z: await facts(s, zmid()), tiles: await rtiles(s) });
		before = { a: await snap(a), b: await snap(b) };
		check('S4: there is something to compare: X, Y and Z lit, and four or more Rating tiles', before.a.x.lit && before.a.y.lit && before.a.z.lit && before.a.tiles.length >= 4, J({ a: before.a.tiles.length, b: before.b.tiles.length }));
		await shot(a, 'ratings_sync_A_before_reload').catch(() => {});
		await shot(b, 'ratings_sync_B_before_reload').catch(() => {});
		for (const s of [a, b]) {
			await reload(s);
			if (!(await openChat(s, cid, xmid()))) throw new Stop(`${s.name} cannot open the chat after a reload`);
			await sleep(800);
		}
		const msgsA = await stored(a, cid), msgsB = await stored(b, cid);
		for (const [n, s, bf, msgs] of [['A', a, before.a, msgsA], ['B', b, before.b, msgsB]]) {
			const now = await snap(s), hd = heads(msgs);
			const exp = (m) => ({ lit: litOfHead(hd.get(m.prod[0].h)), detail: detailOfHead(hd.get(m.prod[0].h)) });
			check(`S4: ${n}: after the reload X and Y are lit as they were, details as they were`,
				now.x.lit === bf.x.lit && now.x.detail === bf.x.detail && now.y.lit === bf.y.lit && now.y.detail === bf.y.detail, J({ before: [bf.x, bf.y], after: [now.x, now.y] }));
			check(`S4: ${n}: after the reload X, Y and Z are lit as the stored head says`,
				now.x.lit === exp(X).lit && now.y.lit === exp(Y).lit && now.z.lit === exp(Z).lit && now.y.detail === exp(Y).detail && now.x.detail === exp(X).detail,
				J({ shown: [now.x.lit, now.y.lit, now.z.lit], head: [exp(X).lit, exp(Y).lit, exp(Z).lit] }));
			check(`S4: ${n}: the Rating tiles are the ones it drew before (same bursts, same lines, same order)`, J(now.tiles) === J(bf.tiles), J({ before: bf.tiles.map((t) => t.lines.length), after: now.tiles.map((t) => t.lines.length) }));
		}
		check('S4: the two devices read the same thing after the reload', J((await rtiles(a))) === J((await rtiles(b))), '');
		await shot(a, 'ratings_sync_A_after_reload').catch(() => {});
		await shot(b, 'ratings_sync_B_after_reload').catch(() => {});
	});

	// ══ S5. The next turn on each device carries nothing of a rating ════
	await section('S5', async () => {
		const rs = await ratingsOf(a, cid);
		const mids = rs.map((m) => m.mid).concat(rs.map((m) => m.rating.burst));
		const markers = [NOTE, 'Just give me the command', 'Étape 2', 'daimond/1'].concat(mids);
		const BAD_KEYS = new Set(['rating', 'burst', 'sup', 'hx', 'tools_path']);
		const audit = (req) => {
			const bad = [], msgs = (req && req.messages) || [];
			const walk = (o, where) => {
				if (Array.isArray(o)) { o.forEach((v, i) => walk(v, where + '[' + i + ']')); return; }
				if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (BAD_KEYS.has(k)) bad.push(where + '.' + k); walk(o[k], where + '.' + k); } return; }
			};
			msgs.forEach((m, i) => { if (m && m.role === 'rating_log') bad.push('messages[' + i + '].role=rating_log'); walk(m, 'messages[' + i + ']'); });
			const wire = J(req || {});
			for (const mk of markers) if (mk && wire.includes(mk)) bad.push('contains ' + J(String(mk).slice(0, 30)));
			return bad;
		};
		const lastUser = (e) => { const ms = (e && e.messages) || []; const l = ms.length ? ms[ms.length - 1] : null; return (l && l.role === 'user' && typeof l.content === 'string') ? l.content : ''; };
		for (const [n, s] of [['A', a], ['B', b]]) {
			const text = '@text S5-ON-' + n + ' no rating on the wire';
			const from = mockLog().length;
			await openChat(s, cid, xmid());
			await chat(s, text, { timeout: 45000 });
			// The turn is found by the text it was typed with, as a prefix: a build that adds to what is sent must still be FOUND, so that the audit below can see what it added.
			const mine = (e) => lastUser(e).startsWith(text);
			await waitFor(() => !!mockLog().slice(from).find(mine), 20000);
			const req = mockLog().slice(from).find(mine) || null;
			check(`S5: ${n}: the model was sent this turn`, !!req, req ? (req.messages || []).length + ' messages' : 'no request found');
			if (!req) continue;
			const holds = (await stored(s, cid)).filter((m) => m.role === 'rating_log').length;
			check(`S5: ${n}: the transcript it was sent from holds the ratings (so absence on the wire means something)`, holds >= 5, holds + ' rating_log messages');
			const bd = audit(req);
			check(`S5: ${n}: the request has no rating message, no rating key, no note and no rating id`, bd.length === 0, bd.slice(0, 4).join('; '));
		}
	});

	// ══ S6. W16's gone wording, on a rating forged for an answer that is gone
	await section('S6', async () => {
		const fid = await a.page.evaluate(async ({ cid, xmid }) => {
			const store = window.DaimondCore.chatStore();
			const got = await store.loadMessages(cid), msgs = (got.messages || []).slice();
			const x = msgs.find((m) => String(m.mid) === xmid);
			const prod = JSON.parse(JSON.stringify(x.prod[0]));
			prod.h = prod.h.replace(/\/[^/]*$/, '/mgone00-0-zzzzz');		// an answer no chat holds
			const form = msgs.filter((m) => m.role === 'rating_log').pop().rating.form;
			const id = window.DaimondRatings.newId(Date.now(), 'gone0');
			const rating = window.DaimondRatings.build({ prod, s: 1, clear: false, tags: [], dims: {}, note: '', src: 'tap', sup: '', burst: id, tools: '', len: 0, form });
			const list = store.stored(), rec = list.find((c) => c.id === cid);
			rec.messages = msgs.concat([window.DaimondRatings.message(rating, id, Date.now() + 5000)]);
			rec.updatedAt = Date.now();
			store.save(list);
			return id;
		}, { cid, xmid: xmid() });
		await sleep(800);
		await reload(a);
		check('S6: the forged record is in A\'s store after a reload', (await openChat(a, cid, xmid())) && !!byMid(await ratingsOf(a, cid))[fid], fid);
		const gone = async (s) => {
			const ts = await rtiles(s), t = ts.find((t) => t.burst === fid) || null;
			return { has: !!t, text: t ? t.lines[0] : '', links: t ? t.links[0] : -1, others: ts.filter((x) => x.burst !== fid).map((x) => x.links.every((n) => n === 1)) };
		};
		let g = await gone(a);
		check('S6: A draws the line "an answer no longer here", with no link', g.has && /no longer here/.test(g.text) && g.links === 0, J(g));
		check('S6: the lines for answers that exist keep their link', g.others.length >= 4 && g.others.every(Boolean), J(g.others));
		const there = await carry(a, b, async () => !!byMid(await ratingsOf(b, cid))[fid]);
		check('S6: the forged record reaches B by the ordinary sync', there, '');
		await reload(b);
		await openChat(b, cid, xmid());
		g = await gone(b);
		check('S6: B draws it the same way after a reload', g.has && /no longer here/.test(g.text) && g.links === 0 && g.others.every(Boolean), J(g));
	});

	await shot(b, 'ratings_sync_' + (bad.length ? 'RED' : 'GREEN')).catch(() => {});
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e).slice(0, 700));
} finally {
	for (const [n, s] of [['A', a], ['B', b]]) {
		if (!s) continue;
		let errs = []; try { errs = (errors(s) || []).filter((x) => /rating|DaimondRatings|burst/i.test(x)); } catch (e) { errs = []; }
		check(`${n}: no page error about ratings`, errs.length === 0, errs.slice(0, 2).join(' | '));
	}
	await a?.close().catch(() => {});
	await b?.close().catch(() => {});
}

console.log('\nsections: ' + Object.entries(sections).map(([n, v]) => `${n} ${v.ok} ok/${v.bad} failed`).join(', '));
if (BREAK) {
	const red = Object.entries(sections).filter(([, v]) => v.bad > 0).map(([n]) => n);
	const want = BREAKS[BREAK].section;
	const only = red.length > 0 && red.every((n) => n === want) && bad.every((n) => n.startsWith(want + ':'));
	console.log(`\nbreak '${BREAK}': red in ${red.length ? red.join(', ') : 'NOTHING'}; wanted ${want} only — ${only ? 'AS WANTED' : (red.length ? 'WRONG SET' : 'NOTHING FAILED, so the checks prove nothing')}`);
	process.exit(only ? 0 : 1);
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
