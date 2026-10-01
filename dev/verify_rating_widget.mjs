// gateway: none
// verify_rating_widget.mjs — the rating widget on an answer (Unit C of the U2 plan,
// ~/usr/code/ai/claude/specs/daimond_rating_u2_plan_20260930.md §2-§4).
//
// One device, one world. It reads only the contract: the record in §2.2, the head rule in
// §2.4, the markup in §3, and `window.DaimondRatingUI.flush(chatId)` / `pendingCount(chatId)`.
// It leans on nothing in ratings.js: the head rule is WRITTEN HERE, so a wrong head in the
// page is a disagreement and not a tautology, and `DaimondProvenance` (U1) is the oracle
// for `prod`, `tools` and `len`.
//
//   W1  where the arrows are          W10 the next message commits first
//   W2  one tap, one record           W11 not while a turn runs
//   W3  the rated tile never changes  W12 switch and hide
//   W4  one burst, one tile           W13 reload
//   W5  no focus moves                W14 selection mode and collapse
//   W6  the chip row                  W15 a daimon answer
//   W7  flip, supersede, withdraw     W16 the jump link
//   W8  the popup                     W17 the rail does not move
//   W9  clear                         L layout   T tap areas   K keyboard
//   FV  the popup's cross, mouse and key
//
// A section that cannot find the widget fails once, by name, and the rest of the run goes on:
// on the code before U2 every section is red for that reason and no other.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE. `--break <name>` serves a damaged www/js file
// through `page.route` and runs the one section it damages (`--full` runs them all, to see
// the red stay in its own section). A break whose anchor no longer matches exactly once in
// the file stops the run (exit 2) and so cannot pass by damaging nothing.
//
//   eval "$(bash dev/world.sh N --up)"; eval "$(bash dev/world.sh N --env)"
//   RC_SLOT=<slot>-rate2 node dev/verify_rating_widget.mjs [--only W2,W3] [--break shape] [--full]
//   DAIMOND_BROWSER=webkit node dev/verify_rating_widget.mjs --only T,L
//
// Shots: $DAIMOND_SCRATCH/rate2/shots/<look>_<size>_<surface>.png

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, newChat, signInAs, mockLog, contentText, errors, scratch, BROWSER } from './harness.mjs';
import { checker } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const J    = JSON.stringify;

// ── Breaks: exact anchors in D's and E's code (merged at 247fe1f0) ──────────
// `from` must occur exactly once in `file`, or the run stops. Each damage is the smallest change that makes the
// section's own claim false. Where a damage could be seen by a second section that repeats the claim for another
// surface (W15 repeats W3 for a daimon), the damage is confined to the surface its own section exercises, so that a
// break is red in its own section only.
const BREAKS = {
	// The commit throws the transcript away and draws it again, on an ordinary chat (a daimon's thread is left alone,
	// because W15 asserts the same thing for it). The rated tile's bytes come back the same; the node does not. It
	// damages both drawing paths: a chat drawn by live turns and one drawn from history (W3's second half).
	rebuild:    { section: 'W3',  file: 'js/daimond.js',
		from: "function rateDraw(chat, list) {",
		to:   "function rateDraw(chat, list) {\n\t\tif (!chat.diamondId) { _renderSynced = false; renderHistory(chat.messages); return; }",
		what: 'the commit forces a full transcript rebuild' },
	// The plan named `due`, but `due` only guards the timer, which is already set to the quiet: making it always true
	// changes nothing anyone can see. The quiet itself is the thing W4 holds, so it is cut to 2.5 s.
	eager:      { section: 'W4',  file: 'js/ratings.js',
		from: "var BURST_MS  = 10000;",
		to:   "var BURST_MS  = 2500;",
		what: 'a burst commits after 2.5 s of quiet, not 10 s (`due` and the timer both cut short)' },
	focus:      { section: 'W5',  file: 'js/daimond.js',
		from: "row.after(tags);",
		to:   "row.after(tags); tags.querySelector('button').focus();",
		what: 'the chip row focuses its first chip' },
	// F1: the details control is let through the `mousedown` refusal, so its popup's cross takes a pointer's focus state; this
	// refuses it again, as every rating control was before the fix.
	morefocus:  { section: 'FV',  file: 'js/daimond.js',
		from: "if (b && !b.classList.contains('ctile-rate-more')) e.preventDefault();",
		to:   "if (b) e.preventDefault();",
		what: 'a press on the details control moves no focus, as on the other rating controls' },
	shape:      { section: 'W2',  file: 'js/ratings.js',
		from: "\t\t\thash:   String(prod.hash || ''),\t\t\t\t\t// '' for an answer\n",
		to:   "",
		what: '`build` leaves out `hash`' },
	// No path put the note on the wire, so the break adds one: the newest note is appended to what the agent is sent
	// (the stored user message is untouched, so only W10's wire check can see it).
	wire:       { section: 'W10', file: 'js/daimond.js',
		from: "\t\t\t\ttry {\n\t\t\t\t\tawait app.run_turn(text, onEvent);\n\t\t\t\t} catch (e) {\n\t\t\t\t\tif (capFail) {",
		to:   "\t\t\t\ttry {\n\t\t\t\t\tawait app.run_turn(text + (function () { var w = chat.messages.filter(function (m) { return m.role === 'rating_log' && m.rating && m.rating.note; }).pop(); return w ? '\\n' + w.rating.note : ''; })(), onEvent);\n\t\t\t\t} catch (e) {\n\t\t\t\t\tif (capFail) {",
		what: 'the newest rating note is sent to the model with the next message' },
	popupdirty: { section: 'W8',  file: 'js/daimond.js',
		from: "st.s = next;",
		to:   "st.s = next; DaimondRatings.setDraft(rateBurstFor(chat.id), h, { s: st.s, tags: st.tags, dims: st.dims, note: st.note }, rateCtx(chat, g)); commitRatings(chat.id, {});",
		what: 'a step chosen in the popup writes its own record at once' },
	// PF-1: the scale steps once drew `6px 3px` (R2-04's rule, deleted when the three overrunning words were shortened). LL holds
	// the toggle option's `6px 8px`; this puts the rule back, after a line that exists with or without it.
	steppad:    { section: 'LL',  file: 'css/app.css',
		from: ".rate-card .ctile-rate-tags { margin-top: 2px; }",
		to:   ".rate-card .ctile-rate-tags { margin-top: 2px; }\n:root .rate-card .rate-scale .tile-dlg-level { padding-left: 3px; padding-right: 3px; }",
		what: 'the scale steps draw 3px of side padding, not the toggle option\'s 8px' },
	touch:      { section: 'W17', file: 'js/daimond.js',
		from: "persistChats();\t\t// and no touchChat: a rating is not a turn",
		to:   "touchChat(chat); persistChats();",
		what: 'the commit calls touchChat' },
};
const arg = (f) => { const i = process.argv.indexOf(f); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };
const BREAK = arg('--break');
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
{
	const src = {};
	const stale = [];
	for (const [n, b] of Object.entries(BREAKS)) {
		src[b.file] = src[b.file] || fs.readFileSync(path.join(WWW, b.file), 'utf8');
		if (src[b.file].split(b.from).length !== 2) stale.push(n);
	}
	if (stale.length) { console.error('break(s) no longer match exactly once: ' + stale.join(', ')); process.exit(2); }
}
const ALL = 'W1,W2,W3,W4,W5,W6,W7,W8,W9,W10,W11,W12,W13,W14,W15,W16,W17,FV,L,LL,T,K';
const ONLY = new Set((arg('--only') || (BREAK && !process.argv.includes('--full') ? BREAKS[BREAK].section : ALL))
	.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
if (ONLY.has('L')) { ONLY.add('LD'); ONLY.add('LP'); }	// L is the computer's layout, then the phone's; either can be asked for alone
const on = (s) => ONLY.has(s);
const ROUTE = !BREAK ? null : async (page) => {
	const b = BREAKS[BREAK];
	const body = fs.readFileSync(path.join(WWW, b.file), 'utf8').replace(b.from, () => b.to);
	console.log(`\n*** BREAK ${BREAK}: ${b.what} — failures below are the point ***\n`);
	await page.route('**/' + b.file + '*', (r) => r.fulfill({ status: 200, contentType: b.file.endsWith('.css') ? 'text/css' : 'application/javascript', body }));
};

const { ok, bad, check } = checker();
class Skip extends Error { constructor(m) { super(m); this.skip = true; } }
const need = (c, m) => { if (!c) throw new Skip(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { /* again */ } await sleep(step); }
	return false;
}
async function section(name, fn) {
	if (!on(name)) return;
	console.log(`\n── ${name} ──`);
	try { await fn(); }
	catch (e) { check(`${name}: ${e.skip ? e.message : 'threw: ' + e.message}`, false, e.skip ? 'the widget is not there' : String(e.stack || '').split('\n')[1] || ''); }
}

// ── The contract, written from the plan and not from the page ───────────
const KEYS  = 'h,hash,s,clear,tags,dims,note,form,src,sup,priv,hx,burst,tools,len,prod'.split(',');
const DIMS  = 'correct,followed,length,style'.split(',');
const DOWN  = [['wrong', 'Wrong'], ['ignored', 'Ignored instructions'], ['long', 'Too long'], ['short', 'Too short'],
	['style', 'Tone or format'], ['tool', 'Tool use'], ['refused', 'Refused or hedged'], ['slow', 'Slow']];
const UP    = [['correct', 'Correct'], ['followed', 'Followed instructions'], ['concise', 'Concise'], ['style_good', 'Good style']];
const RID   = /^r-[0-9a-z]+-[0-9a-z]{5}$/;
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

// ── The device ──────────────────────────────────────────────────────────
// One profile, so the phone is the SAME identity as the desktop, already connected to the mock. A
// persistent profile cannot be open twice, so each device closes the other when it takes the floor.
let D = null, PH = null;
const NAME = 'rate2v';
const PROF = scratch('pw', 'rate2v' + (BREAK ? '-' + BREAK : '') + '-' + BROWSER);
fs.rmSync(PROF, { recursive: true, force: true });
const seenErrors = [];
async function letGo(s) { if (!s) return; try { const e = await errors(s); if (e && e.length) seenErrors.push(String(e[0]).slice(0, 160)); } catch (e) { /* none */ } await s.close().catch(() => {}); }
async function boot() {
	if (D) return D;
	await letGo(PH); PH = null;
	const first = !fs.existsSync(PROF);
	D = await open({ name: NAME, profile: PROF, route: ROUTE, connect: first });
	await D.page.setViewportSize({ width: 1440, height: 900 });
	return D;
}
async function wear(s, theme) {
	await s.page.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, theme);
	await sleep(500);
}
const chatIdNow = (s = D) => s.page.evaluate(() => { try { const f = window.DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; } catch (e) { return ''; } });
const stored = (cid, s = D) => s.page.evaluate(async (c) => {
	try { const g = await window.DaimondCore.chatStore().loadMessages(c); return JSON.parse(JSON.stringify((g && g.messages) || [])); } catch (e) { return []; }
}, cid);
const ratings = async (cid, s = D) => (await stored(cid, s)).filter((m) => m && m.role === 'rating_log');
const mq = (mid) => `#chat-output .ctile[data-mid="${mid}"]`;
/// The visible copy of a control on answer `mid`: the header form or the row form, whichever shows.
const ctl = (mid, cls, s = D) => s.page.locator(`${mq(mid)} .${cls} >> visible=true`).first();
const has = async (loc) => (await loc.count()) > 0;
async function flush(cid, s = D) {
	const r = await s.page.evaluate(async (c) => {
		const u = window.DaimondRatingUI; if (!u || typeof u.flush !== 'function') return 'absent';
		await u.flush(c); return 'ok';
	}, cid);
	need(r === 'ok', 'window.DaimondRatingUI.flush is not exposed');
	await sleep(500);
}
const pending = (cid, s = D) => s.page.evaluate((c) => { try { return window.DaimondRatingUI.pendingCount(c); } catch (e) { return -1; } }, cid);
/// What the tile shows of itself, and its own bytes without any chrome.
const facts = (mid, s = D) => s.page.evaluate((mid) => {
	const t = document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`);
	if (!t) return { tile: false };
	const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
	const groups = [...t.querySelectorAll('.ctile-rate')], seen = groups.filter(vis), g = seen[0] || null;
	const b = (c) => g && g.querySelector('.' + c);
	const clone = t.cloneNode(true); clone.querySelectorAll('[data-chrome]').forEach((n) => n.remove());
	const tags = [...t.querySelectorAll('.ctile-rate-tags')].filter(vis)[0] || null;
	const lit = !g ? '' : (b('ctile-rate-up').getAttribute('aria-pressed') === 'true' ? 'up' : (b('ctile-rate-down').getAttribute('aria-pressed') === 'true' ? 'down' : ''));
	return { tile: true, groups: groups.length, visible: seen.length, inRow: !!(g && g.closest('.ctile-rate-row')),
		role: g && g.getAttribute('role'), label: g && g.getAttribute('aria-label'),
		up: !!b('ctile-rate-up'), down: !!b('ctile-rate-down'), more: !!b('ctile-rate-more'),
		popup: g && b('ctile-rate-more') && b('ctile-rate-more').getAttribute('aria-haspopup'),
		detail: !!(g && b('ctile-rate-more') && b('ctile-rate-more').classList.contains('on')), lit,
		chips: tags ? [...tags.querySelectorAll('.tile-dlg-level')].map((x) => ({ t: x.textContent.trim(), on: x.getAttribute('aria-pressed') === 'true' })) : null,
		html: clone.outerHTML };
}, mid);
/// The answers of a chat, as stored.
const answersOf = async (cid, s = D) => (await stored(cid, s)).filter(isAnswer);
async function turn(text, s = D) {
	const cid = await chatIdNow(s), n = (await answersOf(cid, s)).length;
	await chat(s, text);
	await waitFor(async () => (await answersOf(cid, s)).length > n, 15000);
	const all = await answersOf(cid, s);
	return all[all.length - 1];
}
async function tap(mid, which, s = D) {
	const b = ctl(mid, 'ctile-rate-' + which, s);
	need(await has(b), `no visible ${which} control on answer ${mid}`);
	await b.click({ force: true });
	await sleep(150);
}
const LONG = Array.from({ length: 140 }, (_, i) => 'sentence' + i).join(' ');
const NOTE = Array.from('Just give me the command — "no" preamble.\nÉtape 2: ✓ 日本語のメモ, and more words to fill it out. '.repeat(6)).slice(0, 300).join('');

// ── The seeded chat: three answers ──────────────────────────────────────
let seed = null;
async function seedMain() {
	if (seed) return seed;
	await boot();
	const cid = await newChat(D);
	const dir = await D.page.evaluate((c) => window.DaimondAttach.chatScratch(c), cid);
	const a1 = await turn('@text FIRST-ANSWER a short one');
	const a2 = await turn(`@tools file_write ${J({ path: dir + '/a.txt', content: 'hi' })} ;; file_read ${J({ path: dir + '/a.txt' })}`);
	const a3 = await turn('@text ' + LONG);
	return seed = { cid, a: [a1, a2, a3].filter(Boolean), dir };
}
const freshAnswer = (tag) => turn('@text ANSWER-' + tag + ' with some words in it');

// ══ W1 ═══════════════════════════════════════════════════════════════════
await section('W1', async () => {
	const { cid, a } = await seedMain();
	need(a.length === 3, 'the seeded chat has ' + a.length + ' answers, wanted 3');
	for (const [i, m] of a.entries()) {
		const f = await facts(String(m.mid));
		check(`W1: answer ${i + 1}'s live tile carries data-mid`, f.tile === true, 'no tile with data-mid ' + m.mid);
		check(`W1: answer ${i + 1} shows exactly one rating group (the other form is hidden)`, f.visible === 1 && f.groups >= 2, `groups ${f.groups}, visible ${f.visible}`);
		check(`W1: answer ${i + 1}'s group is a labelled group of up, down and details, none lit`,
			f.role === 'group' && !!f.label && f.up && f.down && f.more && f.popup === 'dialog' && f.lit === '' && !f.detail, J({ role: f.role, label: f.label, popup: f.popup, lit: f.lit }));
	}
	const stray = await D.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile-rate, #chat-output .ctile-rate-row')]
		.filter((g) => !g.closest('.ctile.chat-msg-assistant')).length + document.querySelectorAll('#chat-output .ctile[data-t="user"] .ctile-rate, #chat-output .ctile[data-t="tool"] .ctile-rate').length);
	check('W1: no group on a user tile, a tool tile or anywhere but an answer', stray === 0, stray + ' stray');
	// Mid-turn: nothing on the streaming answer or the empty placeholder.
	await D.page.fill('#chat-input', '@slow 3500 STREAMING-W1');
	await D.page.click('#chat-send', { force: true });
	await sleep(1200);
	const mid = await D.page.evaluate(() => ({ groups: document.querySelectorAll('#chat-output .ctile-rate').length,
		tiles: [...document.querySelectorAll('#chat-output .ctile.chat-msg-assistant')].length }));
	check('W1: nothing is mounted on a streaming answer or its placeholder', mid.groups === 0 || mid.groups === 2 * a.length, `${mid.groups} groups over ${mid.tiles} assistant tiles, ${a.length} answers settled`);
	await waitFor(async () => (await answersOf(cid)).length > a.length, 20000);
	await sleep(700);
	const a4 = (await answersOf(cid)).pop();
	const f4 = await facts(String(a4.mid));
	check('W1: the answer that just finished live has a group and its tile carries data-mid', f4.tile === true && f4.visible === 1, J(f4.tile ? { g: f4.groups, v: f4.visible } : 'no tile'));
	seed.a.push(a4);
	// A pre-U1 answer: written with no record, drawn after a reload.
	await newChat(D);
	await D.page.evaluate(() => { window.__provSaved = window.DaimondProvenance; window.DaimondProvenance = undefined; });
	await chat(D, '@text OLD-SHAPE-W1 an answer with no record');
	await D.page.evaluate(() => { window.DaimondProvenance = window.__provSaved; });
	const oc = await chatIdNow();
	const old = (await stored(oc)).filter((m) => m.role === 'assistant' && String(m.content || '').trim());
	check('W1: the pre-U1 answer was written with no record', old.length === 1 && !('prod' in old[0]), old.map((m) => Object.keys(m).join(',')).join(' | '));
	await D.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(D, NAME);
	await waitFor(() => D.page.evaluate(() => /OLD-SHAPE-W1/.test((document.getElementById('chat-output') || {}).innerText || '')), 20000);
	const og = await D.page.evaluate(() => document.querySelectorAll('#chat-output .ctile-rate').length);
	check('W1: an answer with no record has no group', og === 0, og + ' groups');
	await D.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
	await waitFor(() => D.page.evaluate(() => /FIRST-ANSWER/.test((document.getElementById('chat-output') || {}).innerText || '')), 15000);
	const back = await facts(String(a[0].mid));
	check('W1: after a reload the same answers show their group', back.tile && back.visible === 1, J({ tile: back.tile, v: back.visible }));
});

// ══ W2 and W3 share one flow: a tap on answer 1, a real 10 s of quiet ═══
let flow1 = null;
async function flowOne() {
	if (flow1) { if (flow1.err) throw new Skip(flow1.err); return flow1; }
	try {
		const { cid, a } = await seedMain();
		const m1 = a[0], mid = String(m1.mid);
		await D.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
		await sleep(600);
		const before = await stored(cid), pre = await facts(mid);
		need(pre.tile && pre.visible === 1, 'answer 1 has no visible rating group');
		await D.page.evaluate((mid) => { document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`).__v = 'kept'; }, mid);
		const tiles0 = await D.page.evaluate(() => document.querySelectorAll('#chat-output .ctile').length);
		await tap(mid, 'up');
		const at = { f: await facts(mid), sto: await stored(cid),
			tiles: await D.page.evaluate(() => document.querySelectorAll('#chat-output .ctile').length), tiles0 };
		await sleep(11000);
		await waitFor(async () => (await ratings(cid)).length >= 1, 4000);
		const after = await stored(cid), post = await facts(mid);
		const kept = await D.page.evaluate((mid) => document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`).__v, mid);
		const derived = await D.page.evaluate(({ msgs, mid }) => {
			const P = window.DaimondProvenance, m = msgs.find((x) => String(x.mid) === mid), p = P.of(m)[0];
			return { prod: JSON.stringify(p), tools: P.toolPath(msgs, p.t, m.mid).join('>'), len: P.lenOf(m.content) };
		}, { msgs: after, mid });
		return flow1 = { cid, mid, m1, before, pre, at, after, post, kept, derived };
	} catch (e) { flow1 = { err: e.message }; throw e; }
}
await section('W2', async () => {
	const f = await flowOne();
	check('W2: the arrow is lit at once', f.at.f.lit === 'up', 'lit: ' + JSON.stringify(f.at.f.lit));
	check('W2: the transcript is unchanged until the commit', J(f.at.sto) === J(f.before) && f.at.tiles === f.at.tiles0, `stored ${f.at.sto.length} vs ${f.before.length}; tiles ${f.at.tiles} vs ${f.at.tiles0}`);
	const fresh = f.after.filter((m) => !f.before.some((b) => b.mid === m.mid));
	check('W2: after 11 s of quiet there is exactly one new message', fresh.length === 1, fresh.length + ' new');
	const r = fresh[0];
	need(r, 'no rating_log was written');
	check('W2: it is a rating_log and the LAST message', r.role === 'rating_log' && f.after[f.after.length - 1].mid === r.mid, 'last role ' + f.after[f.after.length - 1].role);
	check('W2: the message has exactly role, mid, ts, rating, in that order, and no content', J(Object.keys(r)) === J(['role', 'mid', 'ts', 'rating']), J(Object.keys(r)));
	check('W2: the mid is a RatingId and ts a millisecond time', RID.test(r.mid) && Number.isInteger(r.ts) && r.ts > 1.7e12, r.mid + ' ' + r.ts);
	const k = r.rating || {};
	check('W2: the rating has every key, in declared order', J(Object.keys(k)) === J(KEYS), J(Object.keys(k)));
	check('W2: dims has its four keys, all -1', J(Object.keys(k.dims || {})) === J(DIMS) && DIMS.every((d) => k.dims[d] === -1), J(k.dims));
	check('W2: s 1, clear false, tags [], hash "", note "", sup "", priv false, hx daimond',
		k.s === 1 && k.clear === false && J(k.tags) === '[]' && k.hash === '' && k.note === '' && k.sup === '' && k.priv === false && k.hx === 'daimond',
		J({ s: k.s, clear: k.clear, tags: k.tags, hash: k.hash, note: k.note, sup: k.sup, priv: k.priv, hx: k.hx }));
	check('W2: src is tap, form is daimond/N, burst is its own mid', k.src === 'tap' && /^daimond\/\d+$/.test(k.form) && k.burst === r.mid, J({ src: k.src, form: k.form, burst: k.burst }));
	check('W2: h is the answer\'s handle and prod is byte-equal to DaimondProvenance.of(answer)[0]', k.h === f.m1.prod[0].h && J(k.prod) === f.derived.prod, String(k.h));
	check('W2: tools and len are the derived values', k.tools === f.derived.tools && k.len === f.derived.len, J({ tools: k.tools, want: f.derived.tools, len: k.len, wantLen: f.derived.len }));
});
await section('W3', async () => {
	const f = await flowOne();
	check('W3: the rated tile\'s own bytes (chrome removed) are identical after the commit', f.pre.html === f.post.html, 'the tile changed');
	check('W3: it is the same DOM node (a marker set before the tap survives)', f.kept === 'kept', 'marker: ' + f.kept);
	const unchanged = f.before.every((b, i) => J(f.after[i]) === J(b));
	check('W3: every earlier message is byte-identical (so its msgSig is unchanged)', unchanged && f.after.length === f.before.length + 1, `${f.before.length} before, ${f.after.length} after`);
	// The other drawing path. The chat above was drawn by live turns; a chat opened from history (here, after a reload)
	// commits through renderHistory's append path, and a rebuild there would replace every tile on the screen.
	const { cid, a } = await seedMain();
	const m = await freshAnswer('W3b'); need(m, 'no answer to rate');
	await D.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(D, NAME);
	await D.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
	await waitFor(() => D.page.evaluate(() => /ANSWER-W3b/.test((document.getElementById('chat-output') || {}).innerText || '')), 20000);
	const mid = String(m.mid), older = String(a[0].mid);
	const pre = await facts(mid);
	need(pre.tile && pre.visible === 1, 'the answer drawn from history shows no rating group');
	await D.page.evaluate((mids) => { for (const x of mids) document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(x)}"]`).__v = 'kept'; }, [mid, older]);
	await tap(mid, 'up'); await flush(cid);
	const post = await facts(mid);
	const kept = await D.page.evaluate((mids) => mids.map((x) => { const t = document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(x)}"]`); return t ? t.__v : 'gone'; }), [mid, older]);
	check('W3: drawn from history, the rated tile keeps its bytes (chrome removed) through the commit', post.tile && pre.html === post.html, 'the tile changed');
	check('W3: and it and an older tile are the same DOM nodes (nothing was rebuilt)', J(kept) === '["kept","kept"]', J(kept));
});

// ══ W4 ═══════════════════════════════════════════════════════════════════
// The touches are spaced 3.2 s apart: nine seconds after the first and three after the last, the burst must still be
// held, and it commits on the quiet after the LAST touch (about 10 s), never on the first touch's clock or at once.
await section('W4', async () => {
	const { cid, a } = await seedMain();
	await flush(cid).catch(() => {});
	const n0 = (await ratings(cid)).length, tiles0 = await D.page.evaluate(() => document.querySelectorAll('#chat-output .ctile[data-t="rating"]').length);
	await tap(String(a[1].mid), 'up');
	await sleep(3200);
	await tap(String(a[2].mid), 'down');
	const chips = await facts(String(a[2].mid));
	need(chips.chips && chips.chips.length === 8, 'no chip row under a down tap on answer 3');
	await sleep(3200);
	const rowLoc = ctl(String(a[2].mid), 'ctile-rate-tags');
	const stillThere = await has(rowLoc);
	check('W4: the chip row is still under answer 3 three seconds after the tap', stillThere, 'gone: the burst was committed early');
	if (stillThere) await rowLoc.locator('.tile-dlg-level').nth(2).click({ force: true, timeout: 5000 });
	const tLast = await D.page.evaluate(() => Date.now());
	await sleep(3200);
	const held = { pending: await pending(cid), written: (await ratings(cid)).length - n0 };
	check('W4: nine seconds after the first touch and three after the last, both drafts are still held and nothing is written', held.pending === 2 && held.written === 0, J(held));
	await waitFor(async () => (await ratings(cid)).length >= n0 + 2, 12000, 300);
	const rs = (await ratings(cid)).slice(n0);
	check('W4: two messages for two answers', rs.length === 2, rs.length + ' new');
	check('W4: they were written on the quiet after the last touch (9 to 13 s later), not sooner', rs.length === 2 && rs[0].ts - tLast >= 9000 && rs[0].ts - tLast <= 13000, rs[0] ? (rs[0].ts - tLast) + ' ms' : 'none');
	// Looked up by handle, not by position: a merge orders messages that share a ts by mid, and the mids inside one burst
	// end in random characters, so the stored order of a burst's lines is not the order they were touched in (finding).
	const r1 = rs.find((r) => r.rating.h === a[1].prod[0].h), r2 = rs.find((r) => r.rating.h === a[2].prod[0].h);
	check('W4: they share ts and burst, and burst is the first touched one\'s mid (answer 2\'s)', !!r1 && !!r2 && r1.ts === r2.ts && r1.rating.burst === r1.mid && r2.rating.burst === r1.mid, J(rs.map((r) => [r.ts, r.mid, r.rating.burst])));
	check('W4: answer 2 is up, and answer 3 is down with the tag long', !!r1 && !!r2 && r1.rating.s === 1 && r2.rating.s === -1 && J(r2.rating.tags) === '["long"]', J([r1 && r1.rating.s, r2 && r2.rating.s, r2 && r2.rating.tags]));
	const drawn = await D.page.evaluate(() => { const t = [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')].pop(); return t ? [...t.querySelectorAll('.rate-line .rate-jump-link')].map((x) => x.dataset.mid) : []; });
	check('W4: the tile was drawn in first-touched order (answer 2\'s line, then answer 3\'s)', J(drawn) === J([String(a[1].mid), String(a[2].mid)]), J(drawn));
	const tile = await D.page.evaluate(() => { const t = [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')]; const l = t[t.length - 1];
		return { n: t.length, lines: l ? l.querySelectorAll('p.rate-line').length : 0 }; });
	check('W4: drawn as one new Rating tile holding two lines', tile.n === tiles0 + 1 && tile.lines === 2, J(tile) + ' from ' + tiles0);
});

// ══ W5 ═══════════════════════════════════════════════════════════════════
await section('W5', async () => {
	await seedMain();
	const m = await freshAnswer('W5'); need(m, 'no answer to rate');
	const mid = String(m.mid), cid = await chatIdNow();
	const act = () => D.page.evaluate(() => { const e = document.activeElement; return e ? (e.id || e.tagName + '.' + e.className) : ''; });
	await D.page.focus('#chat-input');
	const before = await act();
	await tap(mid, 'down');
	check('W5: a pointer tap on down (which opens the chip row) leaves focus where it was', (await act()) === before, before + ' -> ' + await act());
	check('W5: the chip row is there, so this checked the row', !!(await facts(mid)).chips, 'no chip row');
	await tap(mid, 'down');
	const down = ctl(mid, 'ctile-rate-down'); await down.focus();
	await D.page.keyboard.press('Enter'); await sleep(200);
	const onArrow = () => D.page.evaluate(() => { const e = document.activeElement; return !!e && e.classList.contains('ctile-rate-down'); });
	check('W5: Enter on the down arrow leaves focus on it, chip row and all', await onArrow(), await act());
	await D.page.keyboard.press('Space'); await sleep(200);
	check('W5: Space on it leaves focus on it too', await onArrow(), await act());
	await flush(cid).catch(() => {});
});

// ══ W6 ═══════════════════════════════════════════════════════════════════
await section('W6', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('W6'); need(m, 'no answer to rate');
	const mid = String(m.mid), n0 = (await ratings(cid)).length;
	await tap(mid, 'down');
	let f = await facts(mid);
	need(f.chips, 'no chip row after a down tap');
	check('W6: the down tags in form order, with their labels', J(f.chips.map((c) => c.t)) === J(DOWN.map((d) => d[1])), J(f.chips.map((c) => c.t)));
	await ctl(mid, 'ctile-rate-tags').locator('.tile-dlg-level').nth(2).click({ force: true });
	f = await facts(mid);
	check('W6: a toggle presses the chip and writes nothing yet', f.chips.filter((c) => c.on).map((c) => c.t).join() === 'Too long' && (await ratings(cid)).length === n0 && (await pending(cid)) === 1, J(f.chips.filter((c) => c.on)));
	await flush(cid);
	const rs = (await ratings(cid)).slice(n0);
	check('W6: the commit writes one message, carrying the tag', rs.length === 1 && J(rs[0].rating.tags) === '["long"]', J(rs.map((r) => r.rating.tags)));
	check('W6: the commit removes the chip row', (await facts(mid)).chips === null, 'still there');
	const m2 = await freshAnswer('W6b');
	await tap(String(m2.mid), 'up');
	check('W6: an up tap shows no chip row', (await facts(String(m2.mid))).chips === null, 'a row under an up tap');
	await flush(cid);
});

// ══ W7 ═══════════════════════════════════════════════════════════════════
await section('W7', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('W7'); need(m, 'no answer to rate');
	const mid = String(m.mid), n0 = (await ratings(cid)).length;
	await tap(mid, 'up'); await tap(mid, 'down'); await flush(cid);
	let rs = (await ratings(cid)).slice(n0);
	check('W7: up then down in one burst is one message with s -1', rs.length === 1 && rs[0].rating.s === -1 && rs[0].rating.sup === '', J(rs.map((r) => r.rating.s)));
	need(rs.length === 1, 'no first record');
	await tap(mid, 'up'); await flush(cid);
	rs = (await ratings(cid)).slice(n0);
	check('W7: a later tap up is a new message naming the earlier one in sup', rs.length === 2 && rs[1].rating.s === 1 && rs[1].rating.sup === rs[0].mid, J(rs.map((r) => [r.rating.s, r.rating.sup])));
	check('W7: the up arrow is lit', (await facts(mid)).lit === 'up', (await facts(mid)).lit);
	await tap(mid, 'up'); await flush(cid);
	rs = (await ratings(cid)).slice(n0);
	const c = rs[2] && rs[2].rating;
	check('W7: tapping the lit arrow writes a clear record', rs.length === 3 && !!c && c.clear === true && c.s === 0 && J(c.tags) === '[]' && DIMS.every((d) => c.dims[d] === -1) && c.note === '' && c.sup === rs[1].mid, J(c));
	const f = await facts(mid);
	check('W7: nothing is lit after the clear', f.lit === '' && !f.detail, J({ lit: f.lit, detail: f.detail }));
});

// ── The popup (E) ───────────────────────────────────────────────────────
const card = (s = D) => s.page.locator('.rate-card >> visible=true').first();
async function openPopup(mid, s = D) {
	const b = ctl(mid, 'ctile-rate-more', s);
	need(await has(b), 'no details control on answer ' + mid);
	await b.click({ force: true });
	await s.page.waitForSelector('.rate-card', { timeout: 4000 }).catch(() => {});
	need(await has(card(s)), 'the details control opens no popup');
}
const closePopup = async (how = 'cross', s = D) => {
	if (how === 'cross') await s.page.locator('.rate-card .ui-close').first().click({ force: true });
	else await s.page.keyboard.press('Escape');
	await sleep(300);
};
const stepBtn = (i, s = D) => s.page.locator('.rate-card .rate-scale .tile-dlg-level').nth(i);
const tagBtn = (i, s = D) => s.page.locator('.rate-card .ctile-rate-tags .tile-dlg-level').nth(i);
const dimBtn = (row, v, s = D) => s.page.locator('.rate-card .rate-dim').nth(row).locator('.tile-dlg-level').nth(v);
async function openDetails(s = D) {
	const on = await s.page.evaluate(() => { const d = document.querySelector('.rate-card details'); return !!d && d.open; });
	if (!on) await s.page.locator('.rate-card details > summary').first().click({ force: true });
	await sleep(200);
}
// ══ FV ═══════════════════════════════════════════════════════════════════
// F1 (QA, 2026-10-01): the popup's cross wore the rose ring after a MOUSE open whenever a text field held focus. The press
// on the details control was refused (I6), so the page's script focus on the cross inherited the composer's focus-visible
// state, as it does from any text field. The press here is a real one (Playwright's click goes through the mouse), not an
// `el.click()`, which rings every dialog's cross and proves nothing. The keyboard open keeps its ring: it is the keyboard
// user's cue.
await section('FV', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('FV'); need(m, 'no answer to rate');
	const mid = String(m.mid);
	const cross = () => D.page.evaluate(() => {
		const x = document.querySelector('.rate-card .ui-close'); if (!x) return null;
		const cs = getComputedStyle(x);
		return { on: document.activeElement === x, fv: x.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, colour: cs.outlineColor };
	});
	const ringed = (c) => !!c && (c.fv || (c.style !== 'none' && parseFloat(c.width) > 0));
	await D.page.focus('#chat-input');
	await D.page.keyboard.type('a draft held in the composer');
	await openPopup(mid);
	const byMouse = await cross();
	check('FV: a mouse open puts focus on the popup\'s cross, so the next check looks at the cross', !!byMouse && byMouse.on, J(byMouse));
	check('FV: after typing in the composer, a mouse open leaves the cross with no :focus-visible and no outline', !!byMouse && byMouse.on && !ringed(byMouse), J(byMouse));
	await closePopup('cross');
	await D.page.fill('#chat-input', '');
	await ctl(mid, 'ctile-rate-more').focus();
	await D.page.keyboard.press('Enter'); await sleep(500);
	const byKey = await cross();
	check('FV: a keyboard open puts focus on the cross, which matches :focus-visible and shows its outline', !!byKey && byKey.on && byKey.fv && byKey.style !== 'none' && parseFloat(byKey.width) > 0, J(byKey));
	await closePopup('esc');
	await flush(cid).catch(() => {});
});

let w8 = null;
await section('W8', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('W8'); need(m, 'no answer to rate');
	const mid = String(m.mid), n0 = (await ratings(cid)).length;
	await openPopup(mid);
	check('W8: the scale is five steps in words, in one row', (await stepBtn(0).count()) === 1 && (await D.page.locator('.rate-card .rate-scale .tile-dlg-level').count()) === 5
		&& J(await D.page.locator('.rate-card .rate-scale .tile-dlg-level').allTextContents()) === J(['Wrong', 'Poor', 'Fine', 'Good', 'Great']), J(await D.page.locator('.rate-card .rate-scale .tile-dlg-level').allTextContents()));
	await stepBtn(0).click({ force: true });
	await tagBtn(1).click({ force: true }); await tagBtn(2).click({ force: true });
	await openDetails();
	const nDims = await D.page.locator('.rate-card .rate-dim').count();
	check('W8: Details holds the four dimensions and the words field', nDims === 4 && (await D.page.locator('.rate-card textarea.rate-said-input').count()) === 1, nDims + ' dims');
	await dimBtn(0, 1).click({ force: true });
	await D.page.locator('.rate-card textarea.rate-said-input').fill(NOTE);
	const where = (await D.page.locator('.rate-card .rate-where').innerText().catch(() => '')).trim();
	const cm = m.prod[0].cm;
	check('W8: "where it goes" names the model that answered and says nothing of a model reading it', where.includes(cm) && !/\b(read|reads|reading|sees?|sent|training|private|counts? towards)\b/i.test(where), where);
	check('W8: nothing is written while the popup is open', (await ratings(cid)).length === n0, '');
	await closePopup('cross');
	check('W8: closing by the cross removes the popup', !(await has(card())), '');
	await flush(cid);
	const rs = (await ratings(cid)).slice(n0);
	check('W8: closing writes ONE message, src popup', rs.length === 1 && rs[0].rating.src === 'popup', rs.length + ' new');
	const k = (rs[0] || {}).rating || {};
	check('W8: s -2, tags ignored and long, correct 1 and the others -1', k.s === -2 && J(k.tags) === '["ignored","long"]' && k.dims && k.dims.correct === 1 && k.dims.followed === -1 && k.dims.length === -1 && k.dims.style === -1, J({ s: k.s, tags: k.tags, dims: k.dims }));
	check('W8: the note is verbatim (300 characters, quotes, a newline, non-Latin)', k.note === NOTE, J(k.note).slice(0, 80));
	check('W8: the details control is lit (detail)', (await facts(mid)).detail === true, '');
	w8 = { mid, cid };
});

// ══ W9 ═══════════════════════════════════════════════════════════════════
await section('W9', async () => {
	const { cid } = await seedMain();
	if (!w8) {	// stand alone: make a head with detail through the popup
		const m = await freshAnswer('W9'); need(m, 'no answer to rate');
		await openPopup(String(m.mid)); await stepBtn(0).click({ force: true }); await closePopup('cross'); await flush(cid);
		w8 = { mid: String(m.mid), cid };
	}
	const n0 = (await ratings(cid)).length;
	await openPopup(w8.mid);
	need(await has(D.page.locator('.rate-card .rate-clear')), 'no Clear button on a rated product');
	await D.page.locator('.rate-card .rate-clear').click({ force: true });
	await sleep(300);
	check('W9: Clear closes the popup', !(await has(card())), '');
	await flush(cid);
	const rs = (await ratings(cid)).slice(n0);
	check('W9: Clear writes a clear record', rs.length === 1 && rs[0].rating.clear === true && rs[0].rating.s === 0, J(rs.map((r) => r.rating.clear)));
	const f = await facts(w8.mid);
	check('W9: nothing is lit afterwards', f.lit === '' && !f.detail, J({ lit: f.lit, detail: f.detail }));
	const m = await freshAnswer('W9b');
	await openPopup(String(m.mid));
	check('W9: Clear is absent when the product has no head', !(await has(D.page.locator('.rate-card .rate-clear'))), '');
	await closePopup('escape'); await flush(cid);
	check('W9: closing with no step chosen writes nothing', (await ratings(cid)).length === n0 + 1, '');
});

// ══ W10 ══════════════════════════════════════════════════════════════════
await section('W10', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('W10'); need(m, 'no answer to rate');
	await tap(String(m.mid), 'up');
	let marker = '';
	const m2 = await freshAnswer('W10b');
	if (await has(ctl(String(m2.mid), 'ctile-rate-more'))) {
		marker = 'NOTE-MARKER-' + Date.now().toString(36);
		await openPopup(String(m2.mid)); await stepBtn(0).click({ force: true });
		await openDetails(); await D.page.locator('.rate-card textarea.rate-said-input').fill(marker); await closePopup('cross');
	}
	const text = '@text NEXT-TURN-' + Date.now().toString(36);
	const from = mockLog().length;
	await chat(D, text);
	const msgs = await stored(cid);
	const iu = msgs.map((x) => x.role === 'user' && x.content === text).lastIndexOf(true);
	const ir = msgs.map((x) => x.role === 'rating_log' && x.rating.h === m.prod[0].h).lastIndexOf(true);
	check('W10: the rating_log sits before the new user message', ir >= 0 && iu > ir, `rating at ${ir}, user at ${iu}`);
	const req = mockLog().slice(from).find((e) => (e.messages || []).some((x) => x.role === 'user' && contentText(x.content).includes(text)));
	need(req, 'the mock logged no request for the next turn');
	const wire = J(req);
	check('W10: no rating field, role or handle in the request (I7)', !/rating_log|"rating"|"burst"|"sup"|p1:answer|"prod"/.test(wire), (wire.match(/rating_log|"rating"|"burst"|"sup"|p1:answer|"prod"/) || [''])[0]);
	check('W10: the note text is nowhere in the request', !marker || !wire.includes(marker), marker || '(the popup is not built yet, so no note was written)');
});

// ══ W11 ══════════════════════════════════════════════════════════════════
await section('W11', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('W11'); need(m, 'no answer to rate');
	const n0 = (await ratings(cid)).length;
	await D.page.fill('#chat-input', '@slow 6000 SLOW-W11');
	await D.page.click('#chat-send', { force: true });
	await sleep(1200);
	await tap(String(m.mid), 'up');
	await flush(cid).catch(() => {});
	await sleep(1500);
	check('W11: nothing is written while the turn runs, even when forced', (await ratings(cid)).length === n0, (await ratings(cid)).length - n0 + ' written');
	await waitFor(async () => (await ratings(cid)).length > n0, 25000);
	const msgs = await stored(cid);
	const ia = msgs.map((x) => x.role === 'assistant' && String(x.content || '').includes('Eventually')).lastIndexOf(true);
	const ir = msgs.map((x) => x.role === 'rating_log').lastIndexOf(true);
	check('W11: once the turn ends the rating lands after that turn\'s answer', ir > ia && ia >= 0 && ir === msgs.length - 1, `answer at ${ia}, rating at ${ir} of ${msgs.length}`);
	const order = await D.page.evaluate(() => { const o = [...document.querySelectorAll('#chat-output > *')]; const a = o.findLastIndex((e) => /Eventually/.test(e.textContent)); const r = o.findLastIndex((e) => e.matches('[data-t="rating"]') || e.querySelector('[data-t="rating"]')); return { a, r }; });
	check('W11: and the Rating tile is drawn after it', order.r > order.a && order.a >= 0, J(order));
});

// ══ W12 ══════════════════════════════════════════════════════════════════
await section('W12', async () => {
	const { cid } = await seedMain();
	const m = await freshAnswer('W12'); need(m, 'no answer to rate');
	const n0 = (await ratings(cid)).length;
	await tap(String(m.mid), 'up');
	await newChat(D);
	check('W12: leaving the chat commits the rating into the chat that was left', await waitFor(async () => (await ratings(cid)).length === n0 + 1, 5000), (await ratings(cid)).length - n0 + ' written');
	const cid2 = await chatIdNow();
	const m2 = await turn('@text ANSWER-W12b in the new chat');
	need(m2, 'no answer in the new chat');
	await tap(String(m2.mid), 'up');
	await D.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
	check('W12: the page going hidden commits', await waitFor(async () => (await ratings(cid2)).length === 1, 5000), (await ratings(cid2)).length + ' written');
	await D.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
	const m3 = await freshAnswer('W12c');
	await tap(String(m3.mid), 'down');
	await D.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
	check('W12: pagehide commits', await waitFor(async () => (await ratings(cid2)).length === 2, 5000), (await ratings(cid2)).length + ' written');
});

// ══ W13 ══════════════════════════════════════════════════════════════════
const litMap = () => D.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#chat-output .ctile.chat-msg-assistant[data-mid]')].map((t) => {
	const g = [...t.querySelectorAll('.ctile-rate')].find((x) => x.getClientRects().length); if (!g) return [t.dataset.mid, null];
	const u = g.querySelector('.ctile-rate-up'), d = g.querySelector('.ctile-rate-down'), mo = g.querySelector('.ctile-rate-more');
	return [t.dataset.mid, (u.getAttribute('aria-pressed') === 'true' ? 'up' : d.getAttribute('aria-pressed') === 'true' ? 'down' : '') + (mo.classList.contains('on') ? '+' : '')];
})));
await section('W13', async () => {
	await seedMain();
	const cid = await chatIdNow();
	const m = await freshAnswer('W13'); need(m, 'no answer to rate');
	await tap(String(m.mid), 'down'); await flush(cid);
	const before = await litMap(), tiles = await D.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')].map((t) => t.textContent));
	need(Object.values(before).some((v) => v), 'no answer is lit before the reload');
	await D.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(D, NAME);
	await waitFor(() => D.page.evaluate(() => !!document.querySelector('#chat-output .ctile[data-t="rating"]')), 20000);
	const after = await litMap(), tiles2 = await D.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')].map((t) => t.textContent));
	check('W13: the lit states equal those before the reload', J(after) === J(before), J(before) + ' vs ' + J(after));
	check('W13: the Rating tiles equal those before it', J(tiles2) === J(tiles), tiles.length + ' vs ' + tiles2.length);
	const hs = heads(await stored(cid)), want = {};
	for (const a of await answersOf(cid)) { const h = hs.get(a.prod[0].h) || null; want[String(a.mid)] = h ? litOfHead(h) + (detailOfHead(h) ? '+' : '') : ''; }
	check('W13: the lit states equal a fresh derivation from the stored messages (§2.4)', J(after) === J(want), J(want) + ' vs ' + J(after));
});

// ══ W14 ══════════════════════════════════════════════════════════════════
await section('W14', async () => {
	await seedMain();
	const m = await freshAnswer('W14'); need(m, 'no answer to rate');
	const mid = String(m.mid), cid = await chatIdNow();
	await tap(mid, 'down');
	const shown = () => D.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile-rate, #chat-output .ctile-rate-row, #chat-output .ctile-rate-tags')].filter((e) => e.getClientRects().length).length);
	check('W14: before selection mode the group and chip row show', (await shown()) >= 2, await shown() + ' shown');
	await D.page.click('#collapse-btn', { force: true }); await sleep(400);
	const sel = await D.page.evaluate(() => document.getElementById('chat-output').classList.contains('selecting'));
	check('W14: selection mode is on', sel, '');
	check('W14: selection mode hides the group, the row and the chip row', (await shown()) === 0, await shown() + ' still shown');
	await D.page.click('#collapse-btn', { force: true }); await sleep(400);
	const lbl = D.page.locator(`${mq(mid)} > .ctile-lbl .ctile-who`).first();
	const col = () => D.page.evaluate((mid) => document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`).classList.contains('collapsed'), mid);
	const c0 = await col(); await lbl.click({ force: true }); await sleep(250);
	check('W14: a click on the label still collapses the tile', (await col()) !== c0, 'collapsed ' + c0 + ' -> ' + await col());
	await lbl.click({ force: true }); await sleep(250);
	const c1 = await col(); await tap(mid, 'up');
	check('W14: a click on an arrow does not collapse it', (await col()) === c1, '');
	await flush(cid).catch(() => {});
});

// ══ W15 ══════════════════════════════════════════════════════════════════
await section('W15', async () => {
	await boot();
	await D.page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await D.page.waitForSelector('.dlg-card', { timeout: 8000 });
	await D.page.evaluate((nm) => {
		const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
		const i = c.querySelector('input.dlg-input'); i.value = nm; i.dispatchEvent(new Event('input', { bubbles: true })); c.querySelector('.dlg-ok').click();
	}, 'Rated ' + Date.now().toString(36));
	await sleep(1500);
	const id = await D.page.evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
	need(id, 'no Diamond was made');
	await D.page.evaluate((id) => { const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}'); const def = window.DaimondModels.getDefault() || {};
		all[id] = { provider: def.provider, model: def.model, workerProvider: def.provider, workerModel: def.model, visionProvider: '', visionModel: '' };
		localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); }, id);
	await D.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await sleep(500);
	await D.page.fill('#chat-input', '@text DAIMON-ANSWER-W15 the daimon replies');
	await D.page.click('#chat-send', { force: true });
	await waitFor(() => D.page.evaluate((id) => !window.DaimondCore.diamondBusy(id), id), 60000, 500);
	await sleep(1000);
	const rec = () => D.page.evaluate((id) => { const r = window.DaimondDiamond.conversation(id); return r ? { id: r.id, messages: JSON.parse(JSON.stringify(r.messages || [])) } : { id: '', messages: [] }; }, id);
	const r0 = await rec(), ans = r0.messages.filter(isAnswer).pop();
	need(ans, 'the daimon made no answer with a record');
	const mid = String(ans.mid);
	const pre = await facts(mid);
	need(pre.tile && pre.visible === 1, 'the daimon answer shows no rating group');
	await D.page.evaluate((mid) => { document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`).__v = 'kept'; }, mid);
	await tap(mid, 'up'); await flush(r0.id);
	const r1 = await rec();
	const rs = r1.messages.filter((m) => m.role === 'rating_log');
	check('W15: the message lands in the daimon\'s record', rs.length === 1 && r1.messages[r1.messages.length - 1].mid === rs[0].mid, rs.length + ' in the record');
	check('W15: it names the daimon answer (matched on screen, not by prod.c)', rs.length === 1 && rs[0].rating.h === ans.prod[0].h && J(rs[0].rating.prod) === J(ans.prod[0]), '');
	const post = await facts(mid);
	const kept = await D.page.evaluate((mid) => document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`).__v, mid);
	check('W15: the daimon tile is unchanged and the same node', pre.html === post.html && kept === 'kept', '');
});

// ══ W16 ══════════════════════════════════════════════════════════════════
await section('W16', async () => {
	const { cid, a } = await seedMain();
	await D.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
	await sleep(500);
	const link = D.page.locator('#chat-output .ctile[data-t="rating"] .rate-jump-link').first();
	need(await has(link), 'no jump link in any Rating line');
	await D.page.evaluate(() => { document.getElementById('chat-output').scrollTop = 1e6; });
	await D.page.focus('#chat-input');
	const before = await D.page.evaluate(() => document.getElementById('chat-output').scrollTop);
	await link.click({ force: true }); await sleep(500);
	const r = await D.page.evaluate(() => { const o = document.getElementById('chat-output').getBoundingClientRect(); const e = document.activeElement;
		const t = [...document.querySelectorAll('#chat-output .ctile[data-mid]')].find((x) => x.querySelector('.ctile-rate-up[aria-pressed="true"]'));
		const tr = t ? t.getBoundingClientRect() : null;
		return { top: tr ? tr.top - o.top : null, inTile: !!(e && e.closest && e.closest('#chat-output .ctile')), scrollTop: document.getElementById('chat-output').scrollTop }; });
	check('W16: the jump brings a rated tile\'s top into view in #chat-output', r.top !== null && r.top >= -2 && r.top < 400 && r.scrollTop !== before, J(r));
	check('W16: and moves no focus into the tile', !r.inTile, '');
	// NOT COVERED, and never counted as a pass: a rated answer cannot be made to go through the
	// page, and the store has no test door to write a forged rating_log. The pure half (lineOf's
	// `targetMid: null`) is in ratings.test.mjs; the drawing half (the gone wording, no link) is open.
	console.log('  NOT COVERED  W16: a line whose rated answer has gone shows the gone wording and no link');
});

// ══ W17 ══════════════════════════════════════════════════════════════════
await section('W17', async () => {
	const { cid } = await seedMain();
	// A fresh answer of its own, so what W14 and the others left on the seeded chat's last answer is no concern of this
	// section: it rates a product that nothing has rated, in a chat that the second chat then pushes down the rail.
	await D.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
	await sleep(600);
	const mine = await freshAnswer('W17');
	need(mine, 'no fresh answer to rate');
	await newChat(D);
	const cid2 = await chatIdNow();
	await turn('@text SECOND-CHAT-W17 words');
	const order = () => D.page.evaluate(() => window.DaimondCore.chatStore().stored().slice().sort((a, b) => b.updatedAt - a.updatedAt).map((s) => [s.id, s.updatedAt]));
	await D.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid);
	await sleep(800);
	const before = await order();
	need(before.length >= 2 && before[0][0] !== cid, 'the chat to rate is already first on the rail');
	const m = (await answersOf(cid)).find((x) => String(x.mid) === String(mine.mid));
	need(m, 'the fresh answer is not in the chat');
	await tap(String(m.mid), 'down'); await tap(String(m.mid), 'down'); await tap(String(m.mid), 'up');
	const n0 = (await ratings(cid)).length;
	await flush(cid);
	check('W17: a rating was committed', (await ratings(cid)).length > n0, '');
	const after = await order();
	check('W17: the rail order and every updatedAt are unchanged (no touchChat)', J(after) === J(before), J(before.slice(0, 2)) + ' -> ' + J(after.slice(0, 2)));
});

await section('K', async () => {
	const { cid } = await seedMain();
	await D.page.setViewportSize({ width: 1440, height: 900 });
	await setPanelWidth(D, 0);
	const m = await freshAnswer('K'); need(m, 'no answer');
	const mid = String(m.mid);
	const order = await D.page.evaluate((mid) => {
		const ok = (e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
		const all = [...document.querySelectorAll('button, a[href], input, textarea, select, summary, [tabindex]')].filter(ok);
		const t = document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`);
		if (!t) return [-1, -1, -1];
		const names = ['ctile-rate-up', 'ctile-rate-down', 'ctile-rate-more'].map((c) => all.indexOf([...t.querySelectorAll('.' + c)].find((e) => e.getClientRects().length)));
		return names;
	}, mid);
	need(order.every((i) => i >= 0), 'the arrows and details are not tabbable on answer ' + mid + ' ' + J(order));
	check('K: the arrows and details are tabbable, consecutive and in document order', order.every((i) => i >= 0) && order[1] === order[0] + 1 && order[2] === order[1] + 1, J(order));
	await ctl(mid, 'ctile-rate-up').focus();
	const at = () => D.page.evaluate(() => document.activeElement && document.activeElement.className);
	await D.page.keyboard.press('Tab');
	check('K: Tab from up reaches down', /ctile-rate-down/.test(await at()), await at());
	await D.page.keyboard.press('Tab');
	check('K: then details', /ctile-rate-more/.test(await at()), await at());
	await ctl(mid, 'ctile-rate-up').focus(); await D.page.keyboard.press('Enter'); await sleep(150);
	check('K: Enter presses up', (await facts(mid)).lit === 'up', (await facts(mid)).lit);
	await D.page.keyboard.press('Space'); await sleep(150);
	check('K: Space presses it again (withdraws the draft)', (await facts(mid)).lit === '', (await facts(mid)).lit);
	await ctl(mid, 'ctile-rate-more').focus(); await D.page.keyboard.press('Enter'); await sleep(500);
	need(await has(card()), 'Enter on details opens no popup');
	check('K: the popup opens with focus on the cross', await D.page.evaluate(() => { const e = document.activeElement; return !!e && e.classList.contains('ui-close') && !!e.closest('.rate-card'); }), await at());
	let inside = true;
	for (let i = 0; i < 24; i++) { await D.page.keyboard.press('Tab'); if (!(await D.page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.rate-card')))) { inside = false; break; } }
	check('K: Tab stays inside the popup', inside, await at());
	await D.page.keyboard.press('Escape'); await sleep(400);
	check('K: Escape closes it', !(await has(card())), '');
	check('K: and returns focus to the details control', /ctile-rate-more/.test(String(await at())), await at());
	await flush(cid).catch(() => {});
});


// ══ L, T, K ══════════════════════════════════════════════════════════════
const SHOTS = path.join(process.env.DAIMOND_SCRATCH || '.', 'rate2', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const snap = (s, look, size, surf) => s.page.screenshot({ path: path.join(SHOTS, `${look}_${size}_${surf}.png`) }).catch(() => {});
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const LONG_MODEL = 'anthropic/claude-opus-5.5-extended-context-preview-20260930-very-long';
/// A new chat on `s`; on the phone the rail is a drawer, opened first and closed after. The page leaves the drawer open
/// over a new chat (only picking a chat or a Diamond closes it), so the scrim is tapped, as a thumb would; with the drawer
/// open the next `#chat-send` click lands on the scrim and the turn is never sent. That was T's "no answers on the phone".
async function startChat(s) {
	if (s !== PH) return newChat(s);
	const drawerOpen = () => s.page.evaluate(() => document.body.classList.contains('drawer-open'));
	if (!(await drawerOpen())) { await s.page.evaluate(() => document.getElementById('drawer-btn').click()); await sleep(800); }
	await s.page.evaluate(() => document.getElementById('new-session-btn').click());
	await s.page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
	await sleep(700);
	if (await drawerOpen()) { await s.page.evaluate(() => document.getElementById('scrim').click()); await waitFor(async () => !(await drawerOpen()), 4000); await sleep(400); }
	return chatIdNow(s);
}
async function phone() {
	if (PH) return PH;
	await boot(); await letGo(D); D = null;		// the profile is made and connected on the desktop first
	PH = await open({ name: NAME, profile: PROF, touch: true, connect: false, ...(BROWSER === 'webkit' ? { ua: PHONE_UA } : { isMobile: true }), route: ROUTE });
	await PH.page.setViewportSize({ width: 390, height: 844 });
	return PH;
}
/// One chat of seven answers on `s`: five rated up in one burst (a Rating tile of five lines), one left with an open chip row, one bare.
async function layoutChat(s) {
	await startChat(s);
	const cid = await chatIdNow(s), mids = [];
	for (let i = 0; i < 7; i++) { const m = await turn(i === 0 ? '@text ' + LONG : '@text LAYOUT-' + i + ' words', s); need(m, 'no answer ' + i); mids.push(String(m.mid)); }
	for (let i = 0; i < 5; i++) await tap(mids[i], 'up', s);
	await flush(cid, s);
	await tap(mids[5], 'down', s);
	return { cid, mids };
}
async function setPanelWidth(s, px) {
	await s.page.evaluate((px) => { let st = document.getElementById('v-panelw'); if (!st) { st = document.createElement('style'); st.id = 'v-panelw'; document.head.appendChild(st); }
		st.textContent = px ? `.panel.ai{flex:0 0 ${px}px!important;width:${px}px!important;max-width:${px}px!important;min-width:0!important}` : ''; }, px);
	await sleep(400);
	// The panel's border box, as set; the container the rules query is its content box, two pixels narrower.
	return s.page.evaluate(() => { const p = document.querySelector('.panel.ai'); return p ? Math.round(p.getBoundingClientRect().width) : 0; });
}
const geom = (s, mid) => s.page.evaluate((mid) => {
	const t = document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`); if (!t) return null;
	const vis = (e) => e && e.getClientRects().length > 0, R = (e) => e && e.getBoundingClientRect();
	const groups = [...t.querySelectorAll('.ctile-rate')].filter(vis), g = groups[0];
	const lbl = t.querySelector('.ctile-lbl'), peek = t.querySelector('.ctile-peek'), time = t.querySelector('.ctile-time'), copy = t.querySelector('.ctile-copy');
	const user = document.querySelector('#chat-output .ctile[data-t="user"] .ctile-time');
	const row = g && g.closest('.ctile-rate-row'), body = t.querySelector('.ctile-body'), tags = [...t.querySelectorAll('.ctile-rate-tags')].find(vis);
	const pos = (a, b) => !!(a && b) && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
	return { n: groups.length, row: !!row, inHead: !!(g && g.closest('.ctile-lbl')), between: !!g && pos(peek, g) && pos(g, time),
		sameLine: !!g && !!time && Math.abs((R(g).top + R(g).bottom) / 2 - (R(time).top + R(time).bottom) / 2) <= 3,
		timeRight: time ? R(time).right : null, userRight: user ? R(user).right : null,
		lblH: lbl ? R(lbl).height : 0, userLblH: (() => { const u = document.querySelector('#chat-output .ctile[data-t="user"] .ctile-lbl'); return u ? R(u).height : 0; })(), tileH: R(t).height, lblClip: lbl ? lbl.scrollWidth - lbl.clientWidth : 0, copyIn: copy && vis(copy) ? R(copy).right <= R(t).right + 0.5 : true,
		rowUnder: row && body ? R(row).top - R(body).bottom : null, tagsUnder: tags && row ? R(tags).top - R(row).bottom : null };
}, mid);
const setModel = (s, mid, name) => s.page.evaluate(({ mid, name }) => { const m = document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"] .ctile-meta`); if (m) m.textContent = name; return m ? m.textContent : ''; }, { mid, name });
const scrollTo = (s, mid) => s.page.evaluate((mid) => document.querySelector(`#chat-output .ctile[data-mid="${CSS.escape(mid)}"]`).scrollIntoView({ block: 'center' }), mid);
async function popupLayout(s, look, size, mids) {
	await scrollTo(s, mids[0]); await openPopup(mids[0], s);
	await snap(s, look, size, 'popup');
	const p = await s.page.evaluate(() => { const c = document.querySelector('.rate-card'); const y = (q) => { const e = c.querySelector(q); return e && e.getClientRects().length ? e.getBoundingClientRect().top : null; };
		const bs = [...c.querySelectorAll('.rate-scale .tile-dlg-level')].map((b) => b.getBoundingClientRect());
		const cr = c.getBoundingClientRect(), all = [...c.querySelectorAll('button, textarea, summary')].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect());
		let over = 0; for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) { const a = all[i], b = all[j]; if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) over++; }
		return { scale: y('.rate-scale'), tags: y('.ctile-rate-tags'), det: y('details'), where: y('.rate-where'), clear: y('.rate-clear'),
			oneLine: bs.length === 5 && bs.every((b) => Math.abs(b.top - bs[0].top) < 1.5), over, out: all.filter((r) => r.left < cr.left - 0.5 || r.right > cr.right + 0.5).length }; });
	const seq = [p.scale, p.tags, p.det, p.where, p.clear].filter((v) => v !== null);
	check(`L: ${look} ${size} popup rows come in order (scale, tags, Details, where, Clear)`, seq.length >= 3 && seq.every((v, i) => i === 0 || v > seq[i - 1]), J(p));
	check(`L: ${look} ${size} popup scale is on one line`, p.oneLine, '');
	check(`L: ${look} ${size} popup controls overlap nothing and stay inside the card`, p.over === 0 && p.out === 0, `${p.over} overlaps, ${p.out} outside`);
	await openDetails(s); await s.page.locator('.rate-card textarea.rate-said-input').fill(NOTE + NOTE); await sleep(200);
	// R2-03: "In your words" is a field like any other, so it takes the app's field padding.
	const pad = await s.page.evaluate(() => { const c = getComputedStyle(document.querySelector('.rate-card textarea.rate-said-input')); return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].join(' '); });
	check(`L: ${look} ${size} popup: the words field has the app's field padding, 6px 8px (R2-03)`, pad === '6px 8px 6px 8px', pad);
	await snap(s, look, size, 'popup_details_note');
	await closePopup('escape', s);
}
async function layoutRun(s, look, size, mids, form) {
	await scrollTo(s, mids[0]);
	if (form === 'header') await s.page.hover(`${mq(mids[6])} .ctile-lbl`); else await s.page.hover(`${mq(mids[6])}`).catch(() => {});
	const g = await geom(s, mids[6]);
	need(g && g.n === 1, `${look} ${size}: ${g ? g.n : 'no'} visible groups on the bare answer`);
	if (form === 'header') {
		check(`L: ${look} ${size} header form: the group lies between the peek and the time, on one line`, g.inHead && g.between && g.sameLine, J(g));
		check(`L: ${look} ${size} header form: the time's right edge equals a user tile's to 1px`, g.userRight !== null && Math.abs(g.timeRight - g.userRight) <= 1, `${g.timeRight} vs ${g.userRight}`);
		// R2-01: the group's buttons once carried `margin: 0` over Copy's -2px, which drew the bar 30px tall on every answer.
		check(`L: ${look} ${size} header form: the label bar is 28px, as a user tile's (R2-01)`, Math.abs(g.lblH - 28) <= 0.5 && Math.abs(g.lblH - g.userLblH) <= 0.5, `${g.lblH}px against a user tile's ${g.userLblH}px`);
		check(`L: ${look} ${size} header form: a one-line answer tile is 66.5px tall, as a base tile (R2-01)`, Math.abs(g.tileH - 66.5) <= 1, g.tileH + 'px');
	} else {
		check(`L: ${look} ${size} row form: exactly one group shows, in the row, directly under the body`, g.row && g.rowUnder !== null && g.rowUnder >= -1 && g.rowUnder <= 16, J(g));
	}
	await snap(s, look, size, 'hover');
	await scrollTo(s, mids[1]); await snap(s, look, size, 'rated');
	await scrollTo(s, mids[5]);
	const gc = await geom(s, mids[5]);
	check(`L: ${look} ${size} the open chip row lies under ${form === 'row' ? 'the row' : 'the header'} and wraps only among chips`, gc && (gc.tagsUnder === null || gc.tagsUnder >= -1), J(gc));
	await snap(s, look, size, 'chips');
	const rt = await s.page.evaluate(() => { const t = [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')].pop(); const r = t && t.getBoundingClientRect(); return t ? { lines: t.querySelectorAll('.rate-line').length, right: r.right, over: [...t.querySelectorAll('.rate-line')].filter((l) => l.scrollWidth > l.clientWidth + 1).length } : null; });
	check(`L: ${look} ${size} the Rating tile holds five lines, none clipped`, rt && rt.lines === 5 && rt.over === 0, J(rt));
	await s.page.evaluate(() => { const t = [...document.querySelectorAll('#chat-output .ctile[data-t="rating"]')].pop(); if (t) t.scrollIntoView({ block: 'center' }); });
	await snap(s, look, size, 'rating_tile');
	await popupLayout(s, look, size, mids);
}
await section('LD', async () => {
	await boot();
	for (const px of [445, 440, 700]) {	// the rig: can the chat panel be held at a width
		const w = await setPanelWidth(D, px);
		check(`L: rig: the chat panel can be held at ${px}px`, Math.abs(w - px) <= 1, w + 'px');
	}
	const natural = await setPanelWidth(D, 0);
	console.log(`  (the chat panel's natural width at 1440x900 with the default panels is ${natural}px; the header form needs the container over 440px, which is a panel of 443px or more)`);
	check(`L: the default computer layout (${natural}px) is under the header form's line, so it wears the row form`, natural - 2 <= 440, natural + 'px');
	const lc = await layoutChat(D);
	for (const look of ['obsidian', 'porcelain']) {
		await wear(D, look);
		await D.page.setViewportSize({ width: 1440, height: 900 });
		const w = await setPanelWidth(D, 700);
		check(`L: ${look} 1440 the chat panel is held at 700px, over the 440px line`, Math.abs(w - 700) <= 1, w + 'px');
		await layoutRun(D, look, '1440x900', lc.mids, 'header');
		const w5 = await setPanelWidth(D, 443);
		check(`L: ${look} the panel was set to 443px (content box 441px, the narrowest that still holds the header form)`, Math.abs(w5 - 443) <= 1, w5 + 'px');
		await setModel(D, lc.mids[6], LONG_MODEL);
		const g = await geom(D, lc.mids[6]);
		check(`L: ${look} 443px, longest model name: the header form holds one line and Copy stays inside the tile`, g && g.n === 1 && !g.row && g.inHead && g.lblClip <= 1 && g.copyIn && g.between && Math.abs(g.lblH - g.userLblH) <= 0.5, J(g));
		await snap(D, look, '443', 'longname');
		const w1 = await setPanelWidth(D, 440);
		check(`L: ${look} the panel was set to 440px (content box 438px, under the line)`, Math.abs(w1 - 440) <= 1, w1 + 'px');
		await layoutRun(D, look, '440', lc.mids, 'row');
		await setPanelWidth(D, 0);
	}
});
await section('LP', async () => {
	const P = await phone();
	const pc = await layoutChat(P);
	for (const look of ['obsidian', 'porcelain']) { await wear(P, look); await layoutRun(P, look, '390x844', pc.mids, 'row'); }
	// R2-02: `.ctile-peek` once squeezed a Thinking tile's model name ("fast", 24.4px) down to 6px at 390px.
	await chat(P, '@reason I compare the lead times against a May start first. ;; Harlow is the only one that lands in May.').catch(() => {});
	await sleep(800);
	const metas = await P.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile .ctile-meta')].filter((e) => e.getClientRects().length && e.textContent.trim().length >= 1 && e.textContent.trim().length <= 8)
		.map((e) => ({ kind: e.closest('.ctile').dataset.t, text: e.textContent.trim(), w: Math.round(e.getBoundingClientRect().width * 10) / 10, clip: e.scrollWidth - e.clientWidth })));
	check('L: phone 390: the chat holds a Thinking tile with a model name, so the next check looks at one (R2-02)', metas.some((m) => m.kind === 'think'), J(metas.map((m) => m.kind)));
	const squeezed = metas.filter((m) => m.w < 22 || m.clip > 0);
	check('L: phone 390: a short model name keeps its natural width (over 22px) and is not cut, on every tile (R2-02)', squeezed.length === 0, J(squeezed));
});
// R2-04: the five scale words must stay whole at 390px in every language, with Details shut and open. PF-1: and the steps wear
// the toggle option's own padding, `6px 8px`, so no word is made to fit by thinning the role (bar rule 2). `nat` is the text's
// own width (a Range over it, so the ellipsis does not hide it) and `room` the space the step gives it; `clip` is the integer
// scrollWidth reading, which a fraction of a pixel can slip under.
await section('LL', async () => {
	const P = await phone();
	await startChat(P);
	const m = await turn('@text LOCALE-LL words', P); need(m, 'no answer on the phone');
	const words = () => P.page.evaluate(() => [...document.querySelectorAll('.rate-card .rate-scale .tile-dlg-level')].map((b) => {
		const e = b.querySelector('.rate-step-word'), cs = getComputedStyle(b), rg = document.createRange();
		rg.selectNodeContents(e);
		const r1 = (x) => Math.round(x * 10) / 10;
		return { t: e.textContent, clip: e.scrollWidth - e.clientWidth, nat: r1(rg.getBoundingClientRect().width), room: r1(e.getBoundingClientRect().width),
			pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' ') };
	}));
	const whole = (w) => w.clip <= 0 && w.nat <= w.room;
	try {
		for (const code of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
			const set = await P.page.evaluate((c) => window.DaimondI18n.setLocale(c), code); await sleep(600);
			await scrollTo(P, String(m.mid)); await openPopup(String(m.mid), P);
			const shut = await words(); await openDetails(P); const open = await words();
			console.log(`  (LL ${code}: ${shut.map((w) => w.t + ' ' + w.nat).join(' | ')}; room ${shut[0] ? shut[0].room : '?'}px)`);
			check(`LL: ${code}: five scale words, none cut, with Details shut (R2-04)`, set === true && shut.length === 5 && shut.every(whole), J(shut.filter((w) => !whole(w))) || J(set));
			check(`LL: ${code}: five scale words, none cut, with Details open (R2-04)`, open.length === 5 && open.every(whole), J(open.filter((w) => !whole(w))));
			check(`LL: ${code}: the five steps draw the toggle option's padding, 6px 8px, shut and open (PF-1, bar rule 2)`,
				shut.length === 5 && open.length === 5 && [...shut, ...open].every((w) => w.pad === '6px 8px 6px 8px'), J([...new Set([...shut, ...open].map((w) => w.pad))]));
			await closePopup('escape', P);
		}
	} finally { await P.page.evaluate(() => window.DaimondI18n.setLocale('en')).catch(() => {}); }
});

/// Every U2 control on the current screen, as a 44x44 square (or the control's own box where it is larger).
const squares = (s, sel) => s.page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => {
	e.scrollIntoView({ block: 'center' });
	const r = e.getBoundingClientRect(), w = Math.max(44, r.width), h = Math.max(44, r.height);
	// The square slides inside its tile (still 44x44): a first glyph on the text's edge puts a centred square 5px outside it, where the thread answers.
	const tl = e.closest('.ctile'), tb = tl ? tl.getBoundingClientRect() : { left: -1e9, right: 1e9, top: -1e9, bottom: 1e9 };
	const sl = Math.max(tb.left, Math.min(r.left + r.width / 2 - w / 2, tb.right - w)), st = Math.max(tb.top, Math.min(r.top + r.height / 2 - h / 2, tb.bottom - h));
	const cx = sl + w / 2, cy = st + h / 2;
	// A probe point cut off by the tile's rounded corner is outside the tile as drawn, so it is not demanded.
	const rc = tl ? ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((c) => parseFloat(getComputedStyle(tl)['border' + c + 'Radius']) || 0) : [0, 0, 0, 0];
	const cut = (x, y) => [[tb.left, tb.top, 1, 1], [tb.right, tb.top, -1, 1], [tb.right, tb.bottom, -1, -1], [tb.left, tb.bottom, 1, -1]].some(([ax, ay, sx, sy], i) => {
		const ox = (x - ax) * sx, oy = (y - ay) * sy;
		return rc[i] > 0 && ox >= 0 && oy >= 0 && ox < rc[i] && oy < rc[i] && Math.hypot(rc[i] - ox, rc[i] - oy) > rc[i];
	});
	const pts = [[0, 0], [21, 0], [-21, 0], [0, 21], [0, -21], [21, 21], [21, -21], [-21, 21], [-21, -21]].map(([dx, dy]) => [cx + dx, cy + dy]).filter(([x, y]) => !cut(x, y));
	const miss = pts.filter(([x, y]) => { const h2 = document.elementFromPoint(x, y); return !(h2 && (h2 === e || e.contains(h2))); }).length;
	return { name: (e.className || e.tagName).toString().split(' ').slice(0, 2).join('.') + ':' + (e.textContent || '').trim().slice(0, 12), l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2, miss };
}), sel);
async function tapAreas(s, tag, sel) {
	const sq = await squares(s, sel);
	check(`T: ${tag}: there are controls to measure`, sq.length > 0, sq.length + ' found');
	const miss = sq.filter((q) => q.miss > 0);
	check(`T: ${tag}: every control's 44px square hits it or a descendant`, miss.length === 0, miss.map((q) => q.name + ' x' + q.miss).join(', '));
	const ov = [];
	for (let i = 0; i < sq.length; i++) for (let j = i + 1; j < sq.length; j++) {
		const a = sq[i], b = sq[j];
		if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5) ov.push(a.name + ' / ' + b.name);
	}
	check(`T: ${tag}: no two squares overlap`, ov.length === 0, ov.slice(0, 4).join(', '));
}
await section('T', async () => {
	const P = await phone();
	await startChat(P);
	const cid = await chatIdNow(P);
	const m1 = await turn('@text TAP-1 words', P), m2 = await turn('@text TAP-2 words', P);
	if (!(m1 && m2)) {	// say what the phone shows, so the fault is read and not guessed
		await snap(P, 'phone', 'T', 'noanswers');
		const st = await P.page.evaluate(async (c) => { const g = await window.DaimondCore.chatStore().loadMessages(c); const f = window.DaimondAttach.focus();
			return { focus: f && f.kind + ':' + f.id, stored: ((g && g.messages) || []).map((m) => m.role + (m.prod ? '+prod' : '') + (m.provisional ? '+prov' : '') + (m.why ? '+why:' + m.why : '')) }; }, cid);
		console.log('  (T phone: stored ' + J(st) + ')');
		console.log('  (T phone: chat ' + cid + '; ' + J(await P.page.evaluate(() => ({ url: location.pathname, w: innerWidth, out: ((document.getElementById('chat-output') || {}).innerText || '').slice(-300),
			input: (document.getElementById('chat-input') || {}).value, send: (document.getElementById('chat-send') || {}).className, n: document.querySelectorAll('#chat-output .ctile').length }))) + ')');
	}
	need(m1 && m2, 'no answers on the phone');
	await tap(String(m1.mid), 'up', P); await flush(cid, P);
	const own = '.ctile-rate-up, .ctile-rate-down, .ctile-rate-more';
	await scrollTo(P, String(m1.mid));
	await tapAreas(P, 'the arrows and details', `#chat-output ${own}`);
	await tap(String(m2.mid), 'down', P);
	await tapAreas(P, 'the chip row', '#chat-output .ctile-rate-tags .tile-dlg-level');
	await openPopup(String(m1.mid), P);
	await stepBtn(0, P).click({ force: true }); await openDetails(P);
	await tapAreas(P, 'the popup', '.rate-card .rate-scale .tile-dlg-level, .rate-card .ctile-rate-tags .tile-dlg-level, .rate-card .rate-dim .tile-dlg-level, .rate-card details > summary, .rate-card textarea, .rate-card .rate-clear, .rate-card .ui-close');
	await closePopup('escape', P);
});
// ── The end ─────────────────────────────────────────────────────────────
await letGo(D); await letGo(PH);
if (seenErrors.length) console.log('  (first page error of each device: ' + seenErrors.join(' | ') + ')');
console.log(`\n${ok.length} ok, ${bad.length} failed${BREAK ? ' (BREAK ' + BREAK + ')' : ''}`);
if (bad.length) { console.log('\nFAILED:\n' + bad.map((b) => '  - ' + b).join('\n')); process.exit(1); }
