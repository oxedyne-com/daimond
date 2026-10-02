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
//   S5  U4 inverts U2's S5 (I7): the note goes to the model once. A sends the next `@text` turn: its last user message on the
//       wire is the note (from the stored `pre`), a blank line, then the words typed; no rating message, key, id or handle
//       travels with it. B pulls A's message and sends its own: it goes as typed with no note, and B's wire holds A's turn once,
//       byte for byte as A sent it (note, blank line, words), before B's own (P5: B's engine is brought up to the chat).
//   S6  W16's gone wording, which one device cannot reach: a `rating_log` forged into A's store
//       for an answer no chat holds is drawn "an answer no longer here", with no link, on A after
//       a reload and on B after it has synced, while the lines for real answers keep their link.
//   S7  U3, the Diamond half: a file rating on a Diamond's changed-files note. The daimon's conversation is a chat in
//       the store, so the same `chats` union carries it. A taps the last row's down arrow and the `scope` chip, commits
//       and pushes. B pulls: the conversation, the note (records included) and the rating are there byte for byte, the
//       heads for the row's handle are the same, and B, opening the Diamond, draws that row lit down with its details
//       control on and no other row lit. The chat half: a chat turn that changed files leaves a `files_log`; A rates its
//       second row up and pushes. B, which never ran the turn and holds no version store for the chat, holds the
//       `files_log` and the rating byte for byte, has the same head, and draws the row from the records alone, lit as
//       A's is, in a Files tile that is byte-identical to A's (J6).
//
//   S8  U4 (J5, J9): A rates a fresh answer with words and sends the next message; B pulls it: the record is byte for byte A's, `pre`
//       included, and B's user tile shows only the words typed. (A preset between the rating and the next message: see the V log.)
//
//   S9  A rating minted on a device whose clock runs behind (the 5.3.0 QA, surface 1/2). A's chat, a fresh one, is carried to B; B's
//       clock runs 90 s behind while it rates A's answer. The record's `ts` is past every message before it (so it sorts after the
//       person's last message on every device, whatever the clocks said), it reaches A byte for byte, and A's next message tells it
//       (that it is told once, not twice, is S5's). The `ts` is set at creation and never edited.
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
// The other six sections are proved the same way, one break each, each red in its own section and
// nowhere else (a break damages a behaviour and not a stored record, because a rating is permanent
// and a wrong record on the wire would redden every later section that compares the devices):
//
//   --break nopush    S1  the commit saves with the sync nudge held off, so it does not push itself
//   --break nosup     S2  a draft over a head takes `sup` '' instead of naming the head
//   --break order     S3  (above)
//   --break regroup   S4  a thread painted from an empty page draws each rating line as a tile of its own
//   --break twice     S5  noteFor reads every rating in the chat, so B's turn after A's tells A's note again
//   --break link      S6  the Rating tile links an answer that is no longer here
//   --break refile    S7  a file rating takes the first record of the transcript's notes and files_logs, not the row's
//   --break late      S8 and S5  `pre` is set 250 ms after the first save, so the copy that syncs has none (S5: A's note is not on B's wire)
//   --break noextend  S5  `ensureApp` returns a live engine as it stands, so B's engine never takes A's turn (the pre-P5 page)
//   --break skew      S9  a burst is committed with the clock's time as it stands, not past the chat's last message
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
import { chat, newChat, mockLog, contentText, errors, shot } from './harness.mjs';
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
	// S5 (U4): `noteFor` cuts the transcript at the person's last own message, so a rating is told with the next message and then
	// never again. Without the cut every rating in the chat is told again on every message, so B's turn after A's repeats A's note.
	twice: { section: 'S5', file: 'js/ratings.js',
		what: 'noteFor reads every rating in the chat, not only those since the last person\'s message',
		edits: [
			{ from: 'for (i = list.length - 1; i >= 0; i--) { if (own(list[i])) { cut = i; break; } }',
			  to:   'for (i = list.length - 1; i >= 0; i--) { if (own(list[i])) { break; } }\t\t// BROKEN: no cut, so every rating is told again' },
		] },
	// S8 (U4, J9): `pre` is set in the step that appends the message. Here it is set 250 ms later, so the first save (and the
	// sync that follows it) carries the message without it, and B's copy, which first-copy-wins keeps, never holds it. The engine
	// is still told the note (a hidden holder read at the turn's start), so the wire and S5 are untouched and only S8's byte check is red.
	// S5 as well as S8 since V3c: S5 asserts that A's note sits on B's wire, and a `pre` set late rightly breaks that too.
	late: { section: 'S8', also: ['S5'], file: 'js/daimond.js',
		what: '`pre` is set 250 ms after the first save, so the synced copy has none',
		edits: [
			{ from: '\t\t\tif (pre) rec.pre = pre;\n',
			  to:   '\t\t\tif (pre) { Object.defineProperty(rec, \'__w\', { value: pre, configurable: true, writable: true }); setTimeout(function () { rec.pre = pre; }, 250); }\t\t// BROKEN: pre after the first save\n' },
			{ from: ': ((turnRec && typeof turnRec.pre === \'string\') ? turnRec.pre : \'\');',
			  to:   ': ((turnRec && typeof turnRec.pre === \'string\') ? turnRec.pre : ((turnRec && turnRec.__w) || \'\'));' },
		] },
	// S5, B's wire (P5, D-20261002-08): `ensureApp` reconciles a live engine with the chat at the start of every turn, so B's model
	// is sent A's turn, note and all, once. Without it B's engine holds only what it was built with and B's request has no A in it.
	// It is the edit `verify_session_reconcile.mjs` calls `noextend`, here against S5 alone: the page is the one before P5.
	noextend: { section: 'S5', file: 'js/daimond.js',
		what: 'ensureApp returns a live engine as it stands: nothing brings B\'s engine up to the chat A took a turn in',
		edits: [
			{ from: 'if (chat.app) return reconcileEngine(chat, exceptMid);',
			  to:   'if (chat.app) return chat.app;\t\t// BROKEN: a live engine is never brought up to the chat' },
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
	// S7: a file row's record is looked up by its handle in the notes of the chat on screen. Here it is the first record of
	// the first note instead, so a rating of the last row is filed under another file. S1 to S6 rate answers, which take
	// the other branch of `rateTarget`, so the damage reaches S7 only.
	refile: { section: 'S7', file: 'js/daimond.js',
		what: 'a file rating takes the first record of the transcript\'s notes instead of the row\'s',
		edits: [
			{ from: 'var fp = tile.dataset.h ? rateFileRecs().get(tile.dataset.h) : null;',
			  to:   'var fp = tile.dataset.h ? rateFileRecs().values().next().value : null;\t\t// BROKEN: the first record, not the row\'s' },
		] },
	// S9: a burst is stamped past the chat's last message. Here it is stamped at the clock's time alone, as it was before 5.3.0's fix
	// round, so a rating from a device whose clock runs behind sorts before the person's last message and is never told.
	skew: { section: 'S9', file: 'js/daimond.js',
		what: 'a burst is committed at the clock\'s time as it stands, not past the chat\'s last message',
		edits: [
			{ from: 'DaimondRatings.take(b, tsPast(chat, Date.now()))',
			  to:   'DaimondRatings.take(b, Date.now())\t\t// BROKEN: the clock\'s time, not past the last message' },
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
const ALL = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];
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

/// A Diamond made on `s` through the rail's own button, given the default model for its daimon and its worker (the
/// same set-up `verify_rating_widget.mjs` uses). Its id.
const mkDiamondOn = async (s, label) => {
	await s.page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await s.page.waitForSelector('.dlg-card', { timeout: 8000 });
	await s.page.evaluate((nm) => { const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
		const i = c.querySelector('input.dlg-input'); i.value = nm; i.dispatchEvent(new Event('input', { bubbles: true })); c.querySelector('.dlg-ok').click(); }, label + ' ' + Date.now().toString(36));
	await sleep(1500);
	const id = await s.page.evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
	await s.page.evaluate((id) => { const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}'); const def = window.DaimondModels.getDefault() || {};
		all[id] = { provider: def.provider, model: def.model, workerProvider: def.provider, workerModel: def.model, visionProvider: '', visionModel: '' };
		localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); }, id);
	return id;
};
/// One steer typed into Diamond `id`'s composer on `s`, waited out; the daimon's conversation record afterwards.
const steerOn = async (s, id, text) => {
	await s.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); }); await sleep(500);
	await s.page.fill('#chat-input', text); await s.page.click('#chat-send', { force: true });
	await sleep(800); await waitFor(() => s.page.evaluate((id) => !window.DaimondCore.diamondBusy(id), id), 90000, 500); await sleep(1000);
	return s.page.evaluate((id) => { const r = window.DaimondDiamond.conversation(id); return r ? { id: r.id, messages: JSON.parse(JSON.stringify(r.messages || [])) } : { id: '', messages: [] }; }, id);
};
const isNote = (m) => m && m.role === 'user' && /^\[Daimond: this turn changed /.test(String(m.content || ''));
const FWROW = '#chat-output .turn-files .turn-file-row';
/// The changed-files rows on screen: handle, and what each shows of its rating.
const fileRows = (s) => s.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((r) => {
	const g = r.querySelector('.ctile-rate');
	return { h: r.getAttribute('data-h') || '', group: !!g,
		lit: !g ? '' : (g.querySelector('.ctile-rate-up').getAttribute('aria-pressed') === 'true' ? 'up' : (g.querySelector('.ctile-rate-down').getAttribute('aria-pressed') === 'true' ? 'down' : '')),
		detail: !!(g && g.querySelector('.ctile-rate-more').classList.contains('on')) };
}), FWROW).catch(() => []);

/// The last Files tile's own bytes, the rating chrome removed, or null.
const lastFilesTile = (s) => s.page.evaluate(() => { const t = [...document.querySelectorAll('#chat-output .turn-files')].pop(); if (!t) return null; const c = t.cloneNode(true); c.querySelectorAll('[data-chrome]').forEach((n) => n.remove()); return c.outerHTML; }).catch(() => null);
const isFilesLog = (m) => !!m && m.role === 'files_log' && Array.isArray(m.prod);

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

	// ══ S5. The note goes to the model once, with the next message, from whichever device sends it (U4) ═
	await section('S5', async () => {
		const rs = await ratingsOf(a, cid);
		const ids = rs.map((m) => m.mid).concat(rs.map((m) => m.rating.burst));
		const BAD_KEYS = new Set(['rating', 'burst', 'sup', 'hx', 'tools_path']);
		// What must never travel with the note: a rating message, a rating key, a rating id or a handle. The words and the note itself may.
		const audit = (req) => {
			const bad = [], msgs = (req && req.messages) || [];
			const walk = (o, where) => {
				if (Array.isArray(o)) { o.forEach((v, i) => walk(v, where + '[' + i + ']')); return; }
				if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (BAD_KEYS.has(k)) bad.push(where + '.' + k); walk(o[k], where + '.' + k); } return; }
			};
			msgs.forEach((m, i) => { if (m && m.role === 'rating_log') bad.push('messages[' + i + '].role=rating_log'); walk(m, 'messages[' + i + ']'); });
			const wire = J(req || {});
			for (const mk of ids.concat(['p1:answer', 'daimond/1'])) if (mk && wire.includes(mk)) bad.push('contains ' + J(String(mk).slice(0, 30)));
			return bad;
		};
		const WORDS = 'Just give me the command';
		const userTexts = (req) => ((req && req.messages) || []).filter((m) => m && m.role === 'user').map((m) => contentText(m.content));
		const sendOn = async (s, n) => {
			const text = '@text S5-ON-' + n + ' the note goes once';
			const from = mockLog().length;
			await openChat(s, cid, xmid());
			await chat(s, text, { timeout: 45000 });
			// The turn is found by the words typed, which end the last user message whether or not a note leads it.
			const mine = (e) => { const u = userTexts(e); return u.length > 0 && u[u.length - 1].endsWith(text); };
			await waitFor(() => !!mockLog().slice(from).find(mine), 20000);
			return { text, req: mockLog().slice(from).find(mine) || null };
		};
		// A sends first: the ratings of S1 to S4 are all after the chat's last message of the person's. Without them there is no note to tell.
		check('S5: the transcript holds the ratings of S1 to S4 (so the note has something to say)', rs.length >= 5, rs.length + ' rating_log messages; run S1 to S4 with S5');
		if (rs.length < 5) throw new Stop('S5 needs the ratings S1 to S4 make');
		const ta = await sendOn(a, 'A');
		check('S5: A: the model was sent this turn', !!ta.req, ta.req ? (ta.req.messages || []).length + ' messages' : 'no request found');
		if (!ta.req) throw new Stop('no request for A\'s turn');
		// What A's STORED copy holds (`pre` beside `content`) is S8's claim, so that a `pre` set late is red there only.
		const last = userTexts(ta.req).pop();
		check('S5: A: the last user message on the wire is the note, a blank line, then the words typed, byte for byte', typeof last === 'string' && last.startsWith('[Daimond: ') && last.endsWith('\n\n' + ta.text) && !last.slice(0, last.length - ta.text.length - 2).includes('\n\n[Daimond'), J(String(last).slice(0, 140)));
		check('S5: A: the note carries the words typed in S1, once, in one message only', userTexts(ta.req).filter((t) => t.includes(NOTE)).length === 1 && J(ta.req).split(J(NOTE).slice(1, -1)).length === 2,
			userTexts(ta.req).filter((t) => t.includes(NOTE)).length + ' message(s)');
		check('S5: A: no rating message, key, id or handle travels with it', audit(ta.req).length === 0, audit(ta.req).slice(0, 4).join('; '));
		// B sends next, once A's message is in B's transcript: its note was told, so B tells nothing and the earlier one stays in history, once.
		const got = await carry(a, b, async () => (await stored(b, cid)).some((m) => m.role === 'user' && m.content === ta.text));
		check('S5: B holds A\'s message (its `pre` byte for byte is S8\'s)', got, '');
		const tb = await sendOn(b, 'B');
		check('S5: B: the model was sent this turn', !!tb.req, tb.req ? (tb.req.messages || []).length + ' messages' : 'no request found');
		if (!tb.req) throw new Stop('no request for B\'s turn');
		const lastB = userTexts(tb.req).pop();
		check('S5: B: its message goes as typed, with no note (the ratings were told with A\'s)', lastB === tb.text, J(String(lastB).slice(0, 140)));
		// B's model is sent A's turn (P5: the engine is brought up to the chat at the start of every turn), so A's message is on B's wire
		// exactly as A's model read it (the note, a blank line, the words), once, before B's own, and the note is in that one message and in no other.
		const utB = userTexts(tb.req), heldB = utB.filter((t) => t.includes(NOTE)).length;
		console.log('  (S5 B: the user messages on the wire, in order: ' + J(utB.map((t) => t.slice(0, 48) + (t.length > 48 ? '...' : ''))) + ')');
		const atA = utB.indexOf(last);
		check('S5: B: A\'s turn is on B\'s wire exactly once, byte for byte as A sent it, and before B\'s own message', utB.filter((t) => t === last).length === 1 && atA >= 0 && atA < utB.length - 1,
			utB.filter((t) => t === last).length + ' copies, at ' + atA + ' of ' + utB.length + ' user messages');
		check('S5: B: and A\'s note is on it once, in that message, and never in B\'s own', heldB === 1 && utB[atA] === last && !lastB.includes(NOTE) && J(tb.req).split(J(NOTE).slice(1, -1)).length === 2,
			heldB + ' message(s) carry it, ' + (J(tb.req).split(J(NOTE).slice(1, -1)).length - 1) + ' time(s) in the request');
		check('S5: B: no rating message, key, id or handle in the request', audit(tb.req).length === 0, audit(tb.req).slice(0, 4).join('; '));
	});

	// ══ S8. `pre` travels with A's message byte for byte, and B's bubble stays the words typed (U4, J5, J9) ═
	await section('S8', async () => {
		const NOTE8 = 'S8 words only the note holds';
		const t8 = await turn(a, '@text S8-ANS a fourth answer');
		check('S8: A has an answer to rate', !!t8, '');
		if (!t8) throw new Stop('no answer to rate');
		await openChat(a, cid, String(t8.mid));
		await popupRate(a, String(t8.mid), { step: 1, tags: [0], note: NOTE8 });
		const text = '@text S8-NEXT go on', n = (await answersOf(a, cid)).length;
		await chat(a, text, { timeout: 45000 });
		await waitFor(async () => (await answersOf(a, cid)).length > n, 20000);
		const ua = (await stored(a, cid)).filter((m) => m.role === 'user' && m.content === text).pop() || null;
		check('S8: A\'s message took the note as `pre`, and its `content` is the words typed', !!ua && typeof ua.pre === 'string' && ua.pre.includes(NOTE8) && ua.content === text, ua ? J(Object.keys(ua)) : 'no stored message');
		const got = await carry(a, b, async () => (await stored(b, cid)).some((m) => m.role === 'user' && m.content === text));
		const ub = (await stored(b, cid)).find((m) => m.role === 'user' && m.content === text) || null;
		check('S8: B holds A\'s message', got && !!ub, '');
		check('S8: B holds it with `pre` byte for byte, and every key it carries', !!ua && !!ub && J(ub) === J(ua) && typeof ub.pre === 'string', ub ? J(Object.keys(ub)) + ' vs ' + J(ua && Object.keys(ua)) : 'none');
		await openChat(b, cid, String(t8.mid));
		const tiles = await b.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile[data-t="user"]')].map((t) => (t.innerText || '').trim()));
		check('S8: B\'s tile for it shows the words typed and no note', tiles.some((x) => x.endsWith(text)) && !tiles.some((x) => /\[Daimond/.test(x)), J(tiles.slice(-3)));
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

	// ══ S7. A file rating on a Diamond's changed-files note (U3, the Diamond half) ═
	await section('S7', async () => {
		// Two halves in one section: a Stop in the first is a red check and the second still runs, so a break that damages the shared
		// lookup (`refile`) is seen by both, and both stay inside S7.
		for (const [half, fn] of [['the Diamond half', s7Diamond], ['the chat half', s7Chat]]) {
			try { await fn(); }
			catch (e) { check(`S7: ${half}: ${e.stop ? e.message : 'threw: ' + String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')}`, false, e.stop ? 'stopped; nothing was worked around' : ''); }
		}
	});
	async function s7Diamond() {
		const did = await mkDiamondOn(a, 'Rated');
		if (!did) throw new Stop('A made no Diamond');
		const dir = `diamonds/${did}/code`;
		await steerOn(a, did, '@tools file_write ' + J({ path: dir + '/s7a.md', content: '# A\n\nfirst.\n' }));
		const r = await steerOn(a, did, '@tools file_write ' + J({ path: dir + '/s7b.md', content: '# B\n\nsecond.\n' }) + ' ;; file_write ' + J({ path: dir + '/s7c.md', content: '# C\n\nthird.\n' }));
		const dcid = r.id, notes = r.messages.filter(isNote);
		check('S7: A holds two changed-files notes, the second with two records', notes.length === 2 && notes.every((n) => Array.isArray(n.prod) && n.prod.length >= 1) && notes[1].prod.length >= 2,
			J(notes.map((n) => (n.prod || []).length)));
		if (!(dcid && notes.length === 2 && notes[1].prod.length >= 2)) throw new Stop('A\'s Diamond left no two notes of changed files');
		const note = notes[1], rec = note.prod[note.prod.length - 1], h = rec.h;
		const rowSel = `${FWROW}[data-h="${h}"]`;
		const drawn = await waitFor(async () => (await fileRows(a)).some((x) => x.h === h && x.group), 15000);
		check('S7: A draws the last row with a rating group, and the file rows of both notes have a handle', drawn && (await fileRows(a)).filter((x) => x.h).length >= 3, J((await fileRows(a)).map((x) => [!!x.h, x.group])));
		if (!drawn) throw new Stop('A draws no rating group on the last file row');
		const n0 = (await ratingsOf(a, dcid)).length;
		await a.page.locator(`${rowSel} .ctile-rate-down`).first().click({ force: true });
		await sleep(300);
		const chip = a.page.locator(`${rowSel} + .ctile-rate-tags .tile-dlg-level[data-tag="scope"]`).first();
		if (!(await chip.count())) throw new Stop('the down arrow on the file row sets no scope chip after the row on A');
		await chip.click({ force: true });
		await sleep(200);
		await flushRatings(a, dcid);
		const rs = (await ratingsOf(a, dcid)).slice(n0);
		check('S7: A committed one rating_log, for the last row: s -1 by tap, tagged scope', rs.length === 1 && rs[0].rating.h === h && rs[0].rating.s === -1 && rs[0].rating.src === 'tap' && J(rs[0].rating.tags) === '["scope"]',
			J(rs.map((x) => [x.rating.h, x.rating.s, x.rating.src, x.rating.tags])) + ' wanted h ' + h);
		const rf = rs[0];
		if (!rf) throw new Stop('A wrote no rating for the row');
		check('S7: it carries the row\'s record and hash, no tool path and no length, and every declared key in order', J(rf.rating.prod) === J(rec) && rf.rating.hash === rec.hash && rec.hash !== ''
			&& rf.rating.tools === '' && rf.rating.len === 0 && J(Object.keys(rf.rating)) === J(KEYS), J({ prod: J(rf.rating.prod) === J(rec), hash: rf.rating.hash, keys: Object.keys(rf.rating).length }));

		// A's commit is an ordinary save of the daimon's conversation, which `chats` carries: nothing but the carry is added.
		// A note is found on B by its words, which name its files: it is the engine's own message and the test does not lean on its `mid`.
		const noteOn = (ms, n) => ms.find((x) => isNote(x) && x.content === n.content) || null;
		const there = await carry(a, b, async () => { const ms = await stored(b, dcid); return !!(byMid(ms)[rf.mid] && noteOn(ms, note)); });
		check('S7: B received the Diamond\'s conversation, with the note and the rating', there, '');
		if (!there) throw new Stop('B never received the Diamond\'s conversation (a daimon\'s chat travels by the plain union)');
		const sb = await stored(b, dcid), sa = await stored(a, dcid), mb = byMid(sb);
		check('S7: B holds the rating byte-identical to A\'s', J(mb[rf.mid]) === J(rf), J(mb[rf.mid]).slice(0, 100));
		check('S7: B holds both notes byte-identical to A\'s, records included', notes.every((n) => J(noteOn(sb, n)) === J(n)), '');
		const ha = heads(sa).get(h), hb = heads(sb).get(h);
		check('S7: both devices hold the same head for the row\'s handle, the new record, down with the scope tag', !!ha && !!hb && ha.mid === hb.mid && ha.mid === rf.mid && litOfHead(hb) === 'down' && J(hb.rating.tags) === '["scope"]',
			`${ha && ha.mid} / ${hb && hb.mid}`);
		check('S7: no other handle has a head, on either device', heads(sa).size === 1 && heads(sb).size === 1, `${heads(sa).size} / ${heads(sb).size}`);

		// B draws it. B has the Diamond itself by the `diamonds` section; opening it shows the conversation held above.
		const box = `.session-box.diamond-box[data-id="${did}"]`;
		const onRail = await waitFor(() => b.page.evaluate((q) => !!document.querySelector(q), box), 30000);
		check('S7: the Diamond reaches B\'s rail', onRail, '');
		if (!onRail) throw new Stop('B\'s rail shows no such Diamond');
		await b.page.evaluate((q) => { document.querySelector(q).click(); }, box);
		await sleep(800);
		await b.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
		const lit = await waitFor(async () => (await fileRows(b)).some((x) => x.h === h && x.lit === 'down'), 25000);
		const rows = await fileRows(b);
		check('S7: B draws the last row lit down, with its details control on', lit && rows.some((x) => x.h === h && x.lit === 'down' && x.detail), J(rows));
		check('S7: B draws no other row lit, and every row with a handle has its group', rows.filter((x) => x.h && x.h !== h).every((x) => x.group && x.lit === '' && !x.detail) && rows.filter((x) => x.h).length >= 3, J(rows));
		const fa = await fileRows(a);
		check('S7: A draws the same rows lit as B does', J(fa.map((x) => [x.h, x.lit, x.detail])) === J(rows.map((x) => [x.h, x.lit, x.detail])), J(fa.map((x) => x.lit)) + ' / ' + J(rows.map((x) => x.lit)));
	}

	// The chat half (U3, P1b): a chat turn that changed files leaves a `files_log` row of its own records. A rates one row up; B, which
	// never ran the turn and holds no version store for the chat, draws the row from the records that travelled, lit as A's is (J6).
	async function s7Chat() {
		const cid7 = await newChat(a);
		const dir = await a.page.evaluate((c) => window.DaimondAttach.chatScratch(c), cid7);
		const logs = async (s) => (await stored(s, cid7)).filter(isFilesLog);
		await chat(a, '@tools file_write ' + J({ path: dir + '/s7n.md', content: 'a new file\n' }) + ' ;; file_write ' + J({ path: dir + '/s7o.md', content: 'another new file\n' }), { timeout: 45000 });
		const logged = await waitFor(async () => (await logs(a)).length === 1, 20000);
		check('S7: the chat turn left one files_log on A, of two records', logged && (await logs(a))[0].prod.length === 2, J((await logs(a)).map((m) => m.prod.length)));
		if (!logged) throw new Stop('A\'s chat turn appended no files_log (the chat\'s Files row is not there)');
		const log = (await logs(a))[0];
		const drawn = await waitFor(async () => (await fileRows(a)).filter((x) => x.h && x.group).length === 2, 15000);
		check('S7: A draws one row per record, each with its rating group', drawn, J(await fileRows(a)));
		if (!drawn) throw new Stop('A draws no rated Files row for the chat');
		// A row that is not the first record's, so a lookup that takes the first record cannot pass.
		const h = (await fileRows(a)).map((x) => x.h).find((x) => x && x !== log.prod[0].h), rec = log.prod.find((p) => p.h === h);
		check('S7: the row rated is the second record\'s, so the first-record lookup would be wrong', !!rec && rec !== log.prod[0], J(log.prod.map((p) => p.h)));
		if (!rec) throw new Stop('no drawn row carries the second record\'s handle');
		const n0 = (await ratingsOf(a, cid7)).length;
		await a.page.locator(`${FWROW}[data-h="${h}"] .ctile-rate-up`).first().click({ force: true });
		await sleep(300);
		await flushRatings(a, cid7);
		const rs = (await ratingsOf(a, cid7)).slice(n0);
		check('S7: A committed one rating_log for that row: s +1 by tap, no tag, the record\'s hash and its prod byte for byte', rs.length === 1 && rs[0].rating.h === h && rs[0].rating.s === 1 && rs[0].rating.src === 'tap'
			&& J(rs[0].rating.tags) === '[]' && rs[0].rating.hash === rec.hash && rec.hash !== '' && J(rs[0].rating.prod) === J(rec) && rs[0].rating.tools === '' && rs[0].rating.len === 0,
			J(rs.map((x) => [x.rating.h, x.rating.s, x.rating.src, x.rating.hash])) + ' wanted h ' + h);
		const rf = rs[0];
		if (!rf) throw new Stop('A wrote no rating for the chat\'s row');
		const tileA = await lastFilesTile(a);

		const there = await carry(a, b, async () => { const ms = await stored(b, cid7); return !!(byMid(ms)[rf.mid] && ms.some(isFilesLog)); });
		check('S7: B received the chat, its files_log and the rating', there, '');
		if (!there) throw new Stop('B never received the chat that holds the Files row');
		const sa = await stored(a, cid7), sb = await stored(b, cid7), mb = byMid(sb);
		check('S7: B holds the rating byte-identical to A\'s', J(mb[rf.mid]) === J(rf), J(mb[rf.mid]).slice(0, 100));
		check('S7: B holds the files_log byte-identical to A\'s (records, 18 keys, via)', J(sb.filter(isFilesLog)) === J(sa.filter(isFilesLog)) && log.prod.every((p) => Object.keys(p).length === 18), J(sb.filter(isFilesLog).map((m) => m.prod.length)));
		const ha = heads(sa).get(h), hb = heads(sb).get(h);
		check('S7: both devices hold the same head for the row\'s handle, up, and no other handle has one', !!ha && !!hb && ha.mid === rf.mid && hb.mid === rf.mid && litOfHead(hb) === 'up' && heads(sa).size === 1 && heads(sb).size === 1, `${ha && ha.mid} / ${hb && hb.mid}`);
		check('S7: the files_log is { role, mid, ts, prod, delta }: one { h, add, del } per file, so the counts travel with the message (P3)',
			J(Object.keys(log)) === J(['role', 'mid', 'ts', 'prod', 'delta']) && Array.isArray(log.delta) && log.delta.length === 2 && log.delta.every((d) => J(Object.keys(d)) === J(['h', 'add', 'del']) && log.prod.some((p) => p.h === d.h)),
			J(log.delta));
		const held = await b.page.evaluate((c) => window.DaimondVersions.manifests('chat:' + c).then((m) => m.length), cid7);
		check('S7: B holds no version store for the chat, so its row can only be drawn from the records (J6)', held === 0, held + ' manifests on B');
		await b.page.evaluate((c) => { const x = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (x) x.click(); }, cid7);
		const lit = await waitFor(async () => (await fileRows(b)).some((x) => x.h === h && x.lit === 'up'), 25000);
		const rows = await fileRows(b);
		check('S7: B draws the chat\'s Files row from the records, the rated row lit up, details off, the other row unlit', lit && rows.length === 2 && rows.every((x) => x.h && x.group)
			&& rows.filter((x) => x.h === h).every((x) => x.lit === 'up' && !x.detail) && rows.filter((x) => x.h !== h).every((x) => x.lit === '' && !x.detail), J(rows));
		const fa = await fileRows(a);
		check('S7: A draws the same rows lit as B does', J(fa.map((x) => [x.h, x.lit, x.detail])) === J(rows.map((x) => [x.h, x.lit, x.detail])), J(fa.map((x) => x.lit)) + ' / ' + J(rows.map((x) => x.lit)));
		const dl = (x) => x.page.evaluate(() => [...document.querySelectorAll('#chat-output .turn-files .turn-file-delta')].map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())).catch(() => []);
		const dA = await dl(a), dB = await dl(b);
		check('S7: B draws the counts A draws (+N and -M, from the message alone), one per file', dA.length === 2 && J(dA) === J(dB) && dB.every((x) => /\+\d/.test(x)), J(dA) + ' / ' + J(dB));
		const tileB = await lastFilesTile(b);
		check('S7: the Files tile is byte-identical on the two devices, rating chrome removed', !!tileA && tileA === tileB, tileA === tileB ? '' : 'A ' + String(tileA).length + ' bytes, B ' + String(tileB).length + ' bytes');
	}

	// ══ S9. A rating made on a device whose clock runs behind sorts after the person's last message and is told once ═══
	// B's clock is 90 s behind for the rating alone. Minted at the clock's time, the record's `ts` would fall before the question's
	// and the answer's, the merge would put it before the person's last message, and `noteFor` would never tell it (the record is kept).
	await section('S9', async () => {
		const SKEW = 90000, TOLD = /\[Daimond: the user rated/;
		cid = await newChat(a);
		const t9 = await turn(a, '@text S9-T1 first');
		check('S9: A has an answer to rate', !!t9, '');
		if (!t9) throw new Stop('no answer to rate');
		const m9 = String(t9.mid);
		const got = await carry(a, b, async () => !!byMid(await answersOf(b, cid))[m9]);
		check('S9: the chat and its answer reach B', got, '');
		if (!got || !(await openChat(b, cid, m9))) throw new Stop('B shows no tile for the answer');
		const before = await stored(b, cid);
		// The skew is on B's page for the tap and the commit alone, and is taken off before anything else runs.
		await b.page.evaluate((k) => { window.__realNow = Date.now; Date.now = () => window.__realNow() - k; }, SKEW);
		try { await tap(b, m9, 'up'); await flushRatings(b, cid); }
		finally { await b.page.evaluate(() => { if (window.__realNow) { Date.now = window.__realNow; delete window.__realNow; } }); }
		const rb = await ratingsOf(b, cid);
		check('S9: the rating is stored on B, once', rb.length === 1, rb.length + ' rating_log messages');
		if (rb.length !== 1) throw new Stop('B holds no single rating');
		const past = Math.max(...before.map((m) => (typeof m.ts === 'number' ? m.ts : 0)));
		check('S9: its `ts` is past every message that was in the chat (it sorts after the person\'s last message, whatever the clock said)', rb[0].ts > past,
			'rating ts - last message ts = ' + (rb[0].ts - past) + ' ms');
		const sorted = (await stored(b, cid)).slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)));
		check('S9: and in the merged order it is the chat\'s last record', sorted[sorted.length - 1].mid === rb[0].mid, sorted.map((m) => m.role[0]).join(''));
		const userTexts = (req) => ((req && req.messages) || []).filter((m) => m && m.role === 'user').map((m) => contentText(m.content));
		const sendOn = async (s, text) => {
			const from = mockLog().length;
			await openChat(s, cid, m9);
			await chat(s, text, { timeout: 45000 });
			const mine = (e) => { const u = userTexts(e); return u.length > 0 && u[u.length - 1].endsWith(text); };
			await waitFor(() => !!mockLog().slice(from).find(mine), 20000);
			const req = mockLog().slice(from).find(mine) || null;
			return req ? userTexts(req).pop() : null;
		};
		const gotA = await carry(b, a, async () => (await ratingsOf(a, cid)).length === 1);
		const ra = await ratingsOf(a, cid);
		check('S9: A holds the record byte for byte (its `ts` is the one B set, never edited)', gotA && ra.length === 1 && J(ra[0]) === J(rb[0]), gotA ? '' : 'it never reached A');
		const textA = '@text S9-A2 after the rating', textB = '@text S9-B2 own device';
		const lastA = await sendOn(a, textA);
		check('S9: A\'s next message tells the rating B made', lastA !== null && TOLD.test(lastA), J(String(lastA).slice(0, 100)));
		const gotB = await carry(a, b, async () => (await stored(b, cid)).some((m) => m.role === 'user' && m.content === textA));
		check('S9: B holds A\'s message', gotB, '');
		const lastB = await sendOn(b, textB);
		// That the note is told once and not twice is S5's claim (`twice` is red there); here, that it is told at all.
		const told = [lastA, lastB].map((t) => t !== null && TOLD.test(t));
		check('S9: the rating is told on one of the two devices (told once is S5\'s)', told.some(Boolean), 'A told=' + told[0] + ' B told=' + told[1]);
		const rb2 = await ratingsOf(b, cid);
		check('S9: and B still holds the one record, `ts` unchanged', rb2.length === 1 && J(rb2[0]) === J(rb[0]), rb2.length + ' record(s)');
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
	const wanted = [BREAKS[BREAK].section].concat(BREAKS[BREAK].also || []);
	const want = wanted.join(' and ');
	const only = red.length > 0 && red.every((n) => wanted.includes(n)) && bad.every((n) => wanted.some((w) => n.startsWith(w + ':')));
	console.log(`\nbreak '${BREAK}': red in ${red.length ? red.join(', ') : 'NOTHING'}; wanted ${want} only — ${only ? 'AS WANTED' : (red.length ? 'WRONG SET' : 'NOTHING FAILED, so the checks prove nothing')}`);
	process.exit(only ? 0 : 1);
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
