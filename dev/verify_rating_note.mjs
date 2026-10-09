// gateway: live
// verify_rating_note.mjs — a rating reaches the model once, with the person's next message (U4, plan 5.3.0 §5 V3, J7 to J9).
//
// Every assertion reads the mock provider's LOGGED REQUEST (what the model was sent), or the stored record or the DOM where the
// check is about the record or the bubble (N2). One desktop device for N1 to N3 and N5 to N9, a pair for N4. The note is
// `[Daimond: the user rated your answer of HH:MM −1 (tag): "words".]`, kept in `pre` beside `content` and joined as
// `pre + "\n\n" + content` at the engine's seam. Semantics: a rating is told with the next message, so that request's LAST user
// message is the note; a LATER request of the session holds it as ordinary history, once, never again as new.
//
//   N1  a -1 with a tag and words: the next `@text` request's last user message is the note, a blank line, then the typed
//       words; a second turn sends no note and the history holds it once
//   N2  the bubble, the stored `content` and the DOM show only what was typed; `pre` is on the stored message, also after a reload
//   N3  a turn in another chat carries no note (run last of the device sections, so `leak` has no foreign rating to tell the others)
//   N4  a handed-off turn: B's request carries A's note once; a later turn on either device does not resend it as new
//   N5  a daimon steer after a rating of a daimon answer and of a tail-note file carries both clauses
//   N6  a trigger turn, a preset (the door a gather round and the conductor take) and a worker request carry no note
//   N7  a rating in a chat never continued appears in no request after N3's
//   N8  the words arrive verbatim: quotes, newline, `É`, `✓`, a `]` and a blank line, and 8 KiB at the bound
//   N9  a turn interrupted and continued sends the note once in history and never again as new (path 5, a correction told into an
//       app-made turn, is not driven: a rating cannot commit in an interrupted turn's placeholder, so the Continue after a crash has none)
//   M   the mock reads a note's own boundary, and a note-led `@leak` and `@reasononce` are seen (mockllm.mjs)
//
// EACH SECTION IS PROVED AGAINST BROKEN CODE (`--break NAME`; a break whose anchor does not match exactly once stops the run, exit 2):
//   twice   N1 N4 N9  noteFor reads every rating in the chat, so the next message tells the old note again
//   bubble  N2        a redrawn user bubble shows `pre` before the words (the draw only; the stored content and the wire stay)
//   leak    N3        noteFor is also given the other chats' rating records after this chat's own, so another chat's rating is told here
//   nohand  N4        the errand drops `pre`
//   trigger N6        an app-made record (trigger, preset, gather, Continue nudge) takes a note
//
//   eval "$(bash dev/world.sh N --env)"; RC_SLOT=<slot>-note node dev/verify_rating_note.mjs [--break twice] [--only N1,N2]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, scratch, signInAs, newChat, chat, mockLog, clearMockLog, contentText, errors, checker } from './harness.mjs';
import { pair, send, settle } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const J    = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (f) => { const i = process.argv.indexOf(f); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };

// ── Breaks ──────────────────────────────────────────────────────────────
const BREAKS = {
	twice: { sections: ['N1', 'N4', 'N9'], file: 'js/ratings.js', what: 'noteFor reads every rating in the chat, not only those since the last person\'s message',
		edits: [{ from: 'for (i = list.length - 1; i >= 0; i--) { if (own(list[i])) { cut = i; break; } }',
			to: 'for (i = list.length - 1; i >= 0; i--) { if (own(list[i])) { break; } }\t\t// BROKEN: no cut' }] },
	bubble: { sections: ['N2'], file: 'js/daimond.js', what: 'a redrawn user bubble shows `pre` before the words (the draw only: the stored content and the wire are untouched)',
		// Anchored on the call's head only: the arguments after `m.prod` grow (files, app) and the break is about `m.content`.
		edits: [{ from: '\t\t\tappendUserMessage(m.content, m.ts, m.prod',
			to: '\t\t\t/* BROKEN: the note in the bubble */ appendUserMessage((typeof m.pre === \'string\' && m.pre ? m.pre + \'\\n\\n\' : \'\') + m.content, m.ts, m.prod' }] },
	leak: { sections: ['N3'], file: 'js/daimond.js', what: 'noteFor is also given the OTHER chats\' rating records, after this chat\'s own messages, so the cut stays here and a rating made elsewhere is told here',
		edits: [{ from: '\t\t\tvar ms = (chat && chat.messages) || [];\n\t\t\tif (typeof at === \'number\') {',
			to: '\t\t\tvar ms = Array.prototype.concat.apply((chat && chat.messages) || [], chats.filter(function (c) { return c !== chat; }).map(function (c) { return (c.messages || []).filter(function (m) { return m && m.role === \'rating_log\'; }); }));\t\t// BROKEN: other chats\' ratings\n\t\t\tif (typeof at === \'number\') {' }] },
	nohand: { sections: ['N4'], file: 'js/peer.js', what: 'the errand drops `pre`',
		edits: [{ from: '\t\t\tpre:     String(o.pre == null ? \'\' : o.pre),\n\t\t\tmodel:',
			to: '\t\t\tpre:     \'\',\t\t// BROKEN: the note is dropped\n\t\t\tmodel:' }] },
	trigger: { sections: ['N6'], file: 'js/daimond.js', what: 'an app-made record takes a note',
		edits: [{ from: '\t\t} else {\n\t\t\trec.app = true;\n\t\t}\n',
			to: '\t\t} else {\n\t\t\trec.app = true;\n\t\t\tvar __p = ratingPre(chat); if (__p) rec.pre = __p;\t\t// BROKEN: an app record takes a note\n\t\t}\n' }] },
};
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
const ALL = ['M', 'N1', 'N2', 'N5', 'N6', 'N8', 'N9', 'N3', 'N7', 'N4'];		// N3 last among the device sections: the `leak` break then has no foreign rating to tell the others
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
const BASE = mockLog().length;		// the world's log holds earlier runs; this run's requests start here
const sections = {};
async function section(name, fn) {
	if (!on(name)) return;
	console.log(`\n── ${name} ──`);
	const n0 = ok.length, f0 = bad.length;
	try { await fn(); } catch (e) { check(`${name}: threw: ${String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')}`, false, ''); }
	sections[name] = { ok: ok.length - n0, bad: bad.length - f0 };
}
const need = (c, m) => { if (!c) throw new Error('need: ' + m); };
async function waitFor(fn, ms = 20000, step = 300) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { /* again */ } await sleep(step); }
	return false;
}

// ── What the model was sent ─────────────────────────────────────────────
const userTexts = (r) => ((r && r.messages) || []).filter((m) => m && m.role === 'user').map((m) => contentText(m.content));
const lastUserText = (r) => { const u = userTexts(r); return u.length ? u[u.length - 1] : ''; };
/// The latest request whose last user message ends with `words`, at or after log position `from`.
const reqEnding = (words, from = 0) => { const l = mockLog().slice(from).filter((r) => lastUserText(r).endsWith(words)); return l.length ? l[l.length - 1] : null; };
const holding = (r, w) => userTexts(r).filter((t) => t.includes(w)).length;
const NOTE_RE = (w) => new RegExp('^\\[Daimond: the user rated your answer of \\d\\d:\\d\\d [−+]\\d( \\([^)]+\\))?: "' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\.\\]$');

// ── One device ──────────────────────────────────────────────────────────
let D = null;
const stored = (s, cid) => s.page.evaluate(async (c) => {
	try { const g = await window.DaimondCore.chatStore().loadMessages(c); return JSON.parse(JSON.stringify((g && g.messages) || [])); } catch (e) { return []; }
}, cid).catch(() => []);
const isAnswer = (m) => !!m && m.role === 'assistant' && String(m.content || '').trim() && Array.isArray(m.prod) && m.prod[0] && m.prod[0].k === 'answer' && !m.provisional && !m.why;
const answers = (ms) => ms.filter(isAnswer);
const userBy = (ms, text) => ms.filter((m) => m && m.role === 'user' && !Array.isArray(m.prod) && m.content === text).pop() || null;
const bubbles = (s) => s.page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile[data-t="user"]')].map((t) => (t.innerText || '').trim()));
const outText = (s) => s.page.evaluate(() => (document.getElementById('chat-output') || {}).innerText || '');
const sendBusy = (s) => s.page.evaluate(() => { const b = document.getElementById('chat-send'); return !!b && (/stop/i.test((b.getAttribute('title') || '') + b.className) || b.disabled); });
const composer = async (s, text) => { await s.page.fill('#chat-input', text); await s.page.click('#chat-send', { force: true }); };
const ctl = (s, mid, cls) => s.page.locator(`#chat-output .ctile[data-mid="${mid}"] .${cls} >> visible=true`).first();
async function tapOn(s, mid, which) {
	const b = ctl(s, mid, 'ctile-rate-' + which);
	need((await b.count()) > 0, `no visible ${which} control on ${mid}`);
	await b.click({ force: true }); await sleep(200);
}
/// Rate answer `mid` through the popup: the step at position `step`, one tag, and the words.
async function popupRate(s, mid, { step = 1, words = '' }) {
	const b = ctl(s, mid, 'ctile-rate-more');
	need((await b.count()) > 0, 'no details control on ' + mid);
	await b.click({ force: true });
	await s.page.waitForSelector('.rate-card', { timeout: 4000 }).catch(() => {});
	await s.page.locator('.rate-card .rate-scale .tile-dlg-level').nth(step).click({ force: true });
	await s.page.locator('.rate-card .ctile-rate-tags .tile-dlg-level').nth(0).click({ force: true });
	if (words) {
		const open = await s.page.evaluate(() => { const d = document.querySelector('.rate-card details'); return !!d && d.open; });
		if (!open) await s.page.locator('.rate-card details > summary').first().click({ force: true });
		await sleep(200);
		await s.page.locator('.rate-card textarea.rate-said-input').fill(words);
	}
	await s.page.locator('.rate-card .ui-close').first().click({ force: true });
	await sleep(300);
}
const openChatOn = async (s, cid) => { await s.page.evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid); await sleep(800); };
const chatId = (s) => s.page.evaluate(() => { try { const f = window.DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; } catch (e) { return ''; } });
/// A fresh chat holding one answered turn; { cid, a } with `a` the answer.
async function freshAnswered(s, text) {
	const cid = await newChat(s);
	await chat(s, text);
	await waitFor(async () => answers(await stored(s, cid)).length >= 1, 20000);
	return { cid, a: answers(await stored(s, cid))[0] };
}

// ── M. the mock reads the note's own boundary ───────────────────────────
await section('M', async () => {
	const port = 19000 + Math.floor(Math.random() * 900), log = scratch('note_mock.log');
	const p = spawn(process.execPath, [path.join(HERE, 'mockllm.mjs'), String(port)], { env: { ...process.env, DAIMOND_MOCK_LOG: log }, stdio: 'ignore' });
	try {
		await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/__world`)).status > 0; } catch (e) { return false; } }, 8000, 200);
		const ask = async (text) => { const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
			body: J({ model: 'mock/fast', messages: [{ role: 'user', content: text }] }) }); const j = await r.json(); return (j.choices && j.choices[0].message.content) || ''; };
		const note = (w) => '[Daimond: the user rated your answer of 09:05 −1 (wrong): "' + w + '".]\n\n';
		check('M: a note whose words hold `]` and a blank line is cut at its own end: the `@text` body after it is answered', (await ask(note('a]\n\nb') + '@text MOCK-BODY-1')) === 'MOCK-BODY-1', J(await ask(note('a]\n\nb') + '@text MOCK-BODY-1')));
		check('M: a note-led `@leak` is seen (the leaked call comes back)', (await ask(note('words') + '@leak go')).includes('<arg_key>'), J((await ask(note('words') + '@leak go')).slice(0, 60)));
		check('M: a note-led `@reasononce` is seen (the first round says nothing)', (await ask(note('words') + '@reasononce thinking ;; the answer')) === '', J(await ask(note('words') + '@reasononce thinking ;; the answer')));
		check('M: a plain note-led message is answered plain', (await ask(note('words') + 'hello there')).includes('hello there'), '');
	} finally { p.kill(); }
});

try {
	if (ALL.some((n) => n !== 'N4' && n !== 'M' && on(n))) {
		const PROF = scratch('pw', 'u34v-note-' + (process.env.DAIMOND_BROWSER || 'chromium'));
		fs.rmSync(PROF, { recursive: true, force: true });
		D = await open({ name: 'u34vnote', profile: PROF, connect: true, route: ROUTE });
		await D.page.setViewportSize({ width: 1440, height: 900 });
		D.page.setDefaultTimeout(6000);
	}
	let R = null;		// N3's rated chat, never continued (N7)
	let c1 = null, rec1 = null;
	const W1 = 'NW1 keep it shorter', T1 = '@text N1-NEXT go';

	await section('N1', async () => {
		const { cid, a } = await freshAnswered(D, '@text N1-ANS one'); c1 = cid;
		await popupRate(D, String(a.mid), { step: 1, words: W1 });
		const from = mockLog().length;
		await chat(D, T1);
		rec1 = userBy(await stored(D, cid), T1);
		const rq = reqEnding(T1, from);
		check('N1: the model was sent the next message', !!rq && !!rec1, '');
		need(rq && rec1, 'no request or record');
		check('N1: the note names the answer, the sign, a tag and the words, in the plan\'s form', NOTE_RE(W1).test(rec1.pre || ''), J(rec1.pre));
		check('N1: the last user message is the note, a blank line, then the words typed, byte for byte', lastUserText(rq) === rec1.pre + '\n\n' + T1, J(lastUserText(rq).slice(0, 150)));
		check('N1: the words are in one user message of the request, once', holding(rq, W1) === 1 && J(rq).split(W1).length === 2, holding(rq, W1) + ' message(s)');
		const T1b = '@text N1-AGAIN go on';
		const from2 = mockLog().length;
		await chat(D, T1b);
		const rq2 = reqEnding(T1b, from2);
		check('N1: a second turn with no new rating sends no note: its last message is the words alone', !!rq2 && lastUserText(rq2) === T1b, J(rq2 && lastUserText(rq2).slice(0, 120)));
		check('N1: and the earlier note is in its history once, never twice', !!rq2 && holding(rq2, W1) === 1 && J(rq2).split(W1).length === 2, rq2 ? holding(rq2, W1) + ' message(s)' : 'no request');
		check('N1: no request in the run carries a note as its last message but the one that was told', mockLog().slice(BASE).filter((r) => lastUserText(r).startsWith('[Daimond:')).length === 1, mockLog().slice(BASE).filter((r) => lastUserText(r).startsWith('[Daimond:')).length + ' requests');
	});

	await section('N2', async () => {
		need(c1 && rec1, 'N1 first');
		const m = await stored(D, c1), u = userBy(m, T1);
		check('N2: the stored `content` is exactly what was typed, and `pre` is on the stored message', !!u && u.content === T1 && typeof u.pre === 'string' && u.pre.startsWith('[Daimond: '), J(u && Object.keys(u)));
		const bs = await bubbles(D);
		check('N2: the bubble and the DOM show only what was typed', bs.some((b) => b.endsWith(T1)) && !bs.some((b) => /\[Daimond:/.test(b)) && !/\[Daimond:/.test(await outText(D)), J(bs.slice(-3)));
		await D.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(D, 'u34vnote');
		await openChatOn(D, c1);
		await waitFor(() => D.page.evaluate(() => /N1-AGAIN/.test((document.getElementById('chat-output') || {}).innerText || '')), 20000);
		const u2 = userBy(await stored(D, c1), T1), bs2 = await bubbles(D);
		check('N2: after a reload `pre` is the same bytes, and the redrawn thread shows only what was typed', !!u2 && u2.pre === rec1.pre && u2.content === T1 && !bs2.some((b) => /\[Daimond:/.test(b)) && !/\[Daimond:/.test(await outText(D)), J(bs2.slice(-3)));
	});

	let DID = '', DCID = '';
	const dconv = () => D.page.evaluate((id) => { const r = window.DaimondDiamond.conversation(id); return r ? { id: r.id, messages: JSON.parse(JSON.stringify(r.messages || [])) } : { id: '', messages: [] }; }, DID);
	const dsteer = async (text) => { await composer(D, text); await sleep(800); await waitFor(() => D.page.evaluate((id) => !window.DaimondCore.diamondBusy(id), DID), 90000, 500); await sleep(1000); return dconv(); };
	const FWROW = '#chat-output .turn-files .turn-file-row';
	await section('N5', async () => {
		await D.page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await D.page.waitForSelector('.dlg-card', { timeout: 8000 });
		await D.page.evaluate((nm) => { const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
			const i = c.querySelector('input.dlg-input'); i.value = nm; i.dispatchEvent(new Event('input', { bubbles: true })); c.querySelector('.dlg-ok').click(); }, 'NoteD ' + Date.now().toString(36));
		await sleep(1500);
		DID = await D.page.evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
		need(DID, 'no Diamond');
		await D.page.evaluate((id) => { const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}'); const def = window.DaimondModels.getDefault() || {};
			all[id] = { provider: def.provider, model: def.model, workerProvider: def.provider, workerModel: def.model, visionProvider: '', visionModel: '' };
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); }, DID);
		await D.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); }); await sleep(500);
		let c = await dsteer('@text N5-D1 first'); DCID = c.id;
		const d1 = answers(c.messages)[0]; need(d1, 'no daimon answer');
		c = await dsteer('@tools file_write ' + J({ path: `diamonds/${DID}/code/n5a.md`, content: '# N5\n\nfirst.\n' }));
		const note = c.messages.filter((m) => m.role === 'user' && /^\[Daimond: this turn changed /.test(String(m.content || ''))).pop();
		need(note && note.prod && note.prod.length, 'no tail note with files');
		const h = note.prod[note.prod.length - 1].h;
		await popupRate(D, String(d1.mid), { step: 1, words: 'NW5 daimon words' });
		await waitFor(() => D.page.evaluate((s) => !!document.querySelector(s), `${FWROW}[data-h="${h}"] .ctile-rate-down`), 10000);
		await D.page.locator(`${FWROW}[data-h="${h}"] .ctile-rate-down`).first().click({ force: true });
		await sleep(400);
		const from = mockLog().length;
		c = await dsteer('@text N5-STEER go');
		const rq = reqEnding('@text N5-STEER go', from), last = rq ? lastUserText(rq) : '';
		check('N5: the daimon was sent the steer', !!rq, '');
		check('N5: the last message carries both clauses, the answer\'s with its words and the file\'s change, then the typed steer', /^\[Daimond: the user rated your answer of \d\d:\d\d [−+]\d.*"NW5 daimon words"\. They rated the change to \S*n5a\.md [−+]\d.*\]\n\n@text N5-STEER go$/s.test(last), J(last.slice(0, 260)));
		const u = userBy(c.messages, '@text N5-STEER go');
		check('N5: the stored steer keeps the words as `content` and the note as `pre`', !!u && u.content === '@text N5-STEER go' && typeof u.pre === 'string' && last === u.pre + '\n\n' + u.content, J(u && Object.keys(u)));
	});

	await section('N6', async () => {
		need(DID, 'N5 first');
		let c = await dconv();
		const dlast = answers(c.messages).pop(); need(dlast, 'no daimon answer');
		await popupRate(D, String(dlast.mid), { step: 1, words: 'NW6 rated before' });
		await D.page.evaluate(async ({ D, says }) => {
			const T = window.DaimondTriggers, ta = T.blank('activity');
			ta.id = 'activity-' + Date.now().toString(36);	// as the app's `+` names it
			ta.minutes = 1; ta.offScreen = true; ta.instruction = says;
			await window.DaimondCore.triggerSet(D, ta);
			const got = (window.DaimondTriggersOf(D) || [])[0];
			window.DaimondPause.set(T.node(D, got.id), true);
			window.DaimondPause.set(window.DaimondPause.id('root', 'diamonds', D, 'self'), true);
		}, { D: DID, says: '@text N6-TRIG tick' });
		const from = mockLog().length;
		let tr = null;
		for (let i = 0; i < 8 && !tr; i++) {
			await D.page.evaluate(async () => { window.DaimondTriggers.noteActivity(); await window.DaimondTriggerTick(); });
			await sleep(700);
			tr = (await dconv()).messages.find((m) => m.role === 'user' && String(m.content).includes('N6-TRIG')) || null;
		}
		await waitFor(() => D.page.evaluate((id) => !window.DaimondCore.diamondBusy(id), DID), 60000, 500);
		await D.page.evaluate((D) => (window.DaimondTriggersOf(D) || []).forEach((t) => window.DaimondPause.set(window.DaimondTriggers.node(D, t.id), false)), DID);
		check('N6: the trigger fired a turn', !!tr, '');
		const rq = mockLog().slice(from).find((r) => lastUserText(r).includes('N6-TRIG')) || null;
		check('N6: the trigger\'s request carries no note, though a rating was committed before it', !!rq && !J(rq).includes('NW6') && !lastUserText(rq).includes('[Daimond:') && !!tr && tr.app === true && !('pre' in tr), J(tr && Object.keys(tr)));
		clearMockLog();
		await D.page.evaluate(() => window.DaimondCore.steer('@text N6-PRESET go'));
		await waitFor(() => D.page.evaluate((id) => !window.DaimondCore.diamondBusy(id), DID), 60000, 500); await sleep(800);
		const rp = reqEnding('@text N6-PRESET go');
		check('N6: a preset (the door a gather round takes) is sent as its bare words, no note', !!rp && lastUserText(rp) === '@text N6-PRESET go' && !J(rp).includes('NW6'), J(rp && lastUserText(rp).slice(0, 100)));
		c = await dsteer('@text N6-NEXT now');
		const un = userBy(c.messages, '@text N6-NEXT now');
		check('N6: the rating was not used up by them: the person\'s next steer is told it, once', !!un && /NW6 rated before/.test(un.pre || '') && holding(reqEnding('@text N6-NEXT now'), 'NW6 rated before') === 1, J(un && un.pre));
		// A worker's request: a person's message that spawns it takes the note, the worker's own task does not.
		const w = await freshAnswered(D, '@text N6-WCHAT answer');
		await popupRate(D, String(w.a.mid), { step: 1, words: 'NW6W worker words' });
		clearMockLog();
		await chat(D, '@tool spawn_agent ' + J({ name: 'noteworker', task: 'N6-TASK find it' }), { timeout: 45000 });
		await waitFor(() => !!mockLog().find((r) => userTexts(r).includes('N6-TASK find it')), 30000, 400);
		const wq = mockLog().find((r) => userTexts(r).includes('N6-TASK find it')) || null;
		check('N6: a worker request carries no note and none of the rating\'s words', !!wq && !J(wq).includes('NW6W') && !J(wq).includes('[Daimond:'), wq ? 'found' : 'no worker request');
	});

	await section('N8', async () => {
		const W8 = 'He said "no", then \\ left.\nÉtape 2: ✓ a]\n\nb done', W8K = 'K8K' + 'x'.repeat(8189);
		const { cid, a } = await freshAnswered(D, '@text N8-ANS one');
		// Both answers first: a rating committed before a later message of the person's was told with that message.
		await chat(D, '@text N8-ANS two'); await waitFor(async () => answers(await stored(D, cid)).length >= 2, 20000);
		const a2 = answers(await stored(D, cid))[1];
		await popupRate(D, String(a.mid), { step: 1, words: W8 });
		await popupRate(D, String(a2.mid), { step: 1, words: W8K });
		const from = mockLog().length, T = '@text N8-NEXT go';
		await chat(D, T, { timeout: 45000 });
		const rec = userBy(await stored(D, cid), T), rq = reqEnding(T, from), last = rq ? lastUserText(rq) : '';
		check('N8: the model was sent the message with its note', !!rq && !!rec && typeof rec.pre === 'string', '');
		need(rq && rec, 'no request or record');
		check('N8: quotes, a backslash, a newline, `É`, `✓` and `]` then a blank line arrive verbatim inside the note', last.includes(': "' + W8 + '"'), J(last.slice(last.indexOf('He said') - 80, last.indexOf('He said') + 160)) + ' ' + J(rec.pre.length));
		check('N8: 8 KiB of words at the bound arrive whole (8192 bytes)', Buffer.byteLength(W8K) === 8192 && last.includes(': "' + W8K + '"'), 'bytes in the wire message ' + Buffer.byteLength(last));
		check('N8: the last user message is still pre, a blank line, then the words, byte for byte', last === rec.pre + '\n\n' + T, '');
	});

	let hold = false; const held = [];
	await section('N9', async () => {
		const { cid, a } = await freshAnswered(D, '@text N9-ANS one');
		await popupRate(D, String(a.mid), { step: 1, words: 'NW9 before the crash' });
		await D.page.route('**/chat/completions', (route) => { if (hold) held.push(route); else route.continue(); });
		hold = true;
		const Q = '@text N9-ASK probe';
		await composer(D, Q); await sleep(1500);
		const u = userBy(await stored(D, cid), Q);
		check('N9: the question took the note and its request is held in flight', !!u && /NW9 before the crash/.test(u.pre || '') && held.length >= 1, J(u && u.pre));
		need(u, 'no record');
		hold = false;
		await D.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(D, 'u34vnote');
		await openChatOn(D, cid);
		const got = await waitFor(() => D.page.evaluate(() => !!document.querySelector('.ti-continue')), 20000, 400);
		check('N9: the interrupted turn comes back with its Continue button', got, '');
		need(got, 'no Continue');
		const from = mockLog().length;
		await D.page.evaluate(() => document.querySelector('.ti-continue').click());
		await waitFor(() => !!reqEnding(Q, from), 30000, 400);
		await waitFor(async () => !(await sendBusy(D)), 30000, 400); await sleep(800);
		const rq = reqEnding(Q, from);
		check('N9: the question is asked again with the same note, once in the request', !!rq && lastUserText(rq) === u.pre + '\n\n' + Q && holding(rq, 'NW9 before the crash') === 1, J(rq && lastUserText(rq).slice(0, 120)));
		const T = '@text N9-NEXT go', from2 = mockLog().length;
		await chat(D, T);
		const rq2 = reqEnding(T, from2);
		check('N9: the next message sends no note as new, and history holds the old one once', !!rq2 && lastUserText(rq2) === T && holding(rq2, 'NW9 before the crash') === 1, rq2 ? holding(rq2, 'NW9 before the crash') + ' message(s); last ' + J(lastUserText(rq2).slice(0, 80)) : 'no request');
		// Path 5 (a correction typed into an app-made turn, carrying a note) is NOT driven here: see the V3 log.
	});

	await section('N3', async () => {
		const r = await freshAnswered(D, '@text N3-RATED answer'); R = r;
		await popupRate(D, String(r.a.mid), { step: 1, words: 'NW3 other chat words' });
		await sleep(1500);
		const cid2 = await newChat(D), from = mockLog().length;
		await chat(D, '@text N3-OTHER hello');
		const rq = reqEnding('@text N3-OTHER hello', from);
		check('N3: a turn in another chat was sent', !!rq, '');
		check('N3: it carries no note: its last message is the words alone, and neither the note nor its words are anywhere in the request', !!rq && lastUserText(rq) === '@text N3-OTHER hello' && !J(rq).includes('NW3') && !J(rq).includes('[Daimond:'), J(rq && lastUserText(rq).slice(0, 140)));
		check('N3: the rating is a record at the end of its own chat, so it was committed', (await stored(D, r.cid)).some((m) => m.role === 'rating_log') && cid2 !== r.cid, '');
	});

	await section('N7', async () => {
		need(R, 'N3 first');
		const all = mockLog().filter((r) => !lastUserText(r).endsWith('@text N3-OTHER hello'));
		check('N7: a rating in a chat never continued is in no request after N3\'s', all.length > 0 && !all.some((r) => J(r).includes('NW3')), all.length + ' requests read');
		check('N7: the chat still holds the rating and nothing told it', (await stored(D, R.cid)).some((m) => m.role === 'rating_log') && !(await stored(D, R.cid)).some((m) => m.role === 'user' && typeof m.pre === 'string' && m.pre.includes('NW3')), '');
	});
	await D?.close().catch(() => {});
	D = null;

	await section('N4', async () => {
		const { a, b } = await pair(check, 'notea', 'noteb', { route: ROUTE });
		try {
			await chat(a, '@text N4-ONE answer');
			const cid = await chatId(a);
			await waitFor(async () => answers(await stored(a, cid)).length >= 1, 20000);
			const a1 = answers(await stored(a, cid)).pop(); need(a1, 'no answer on A');
			await popupRate(a, String(a1.mid), { step: 1, words: 'NW4 handed off' });
			await a.page.route('**/chat/completions', (r) => r.abort());		// A cannot ask the model itself: a request that arrives is B's
			const T = '@text N4-TWO handed', from = mockLog().length;
			await send(a.page, T);
			await waitFor(() => !!reqEnding(T, from), 60000, 500);
			const rq = reqEnding(T, from), rec = userBy(await stored(a, cid), T);
			check('N4: the handed-off turn reached the model (from B, since A cannot)', !!rq, '');
			need(rq && rec, 'no request or record');
			check('N4: A\'s stored message carries the note', typeof rec.pre === 'string' && /NW4 handed off/.test(rec.pre), J(rec.pre));
			check('N4: B\'s request carries A\'s note once: its last message is the note, a blank line, then the words', lastUserText(rq) === rec.pre + '\n\n' + T && holding(rq, 'NW4 handed off') === 1, J(lastUserText(rq).slice(0, 140)));
			await waitFor(async () => answers(await stored(a, cid)).length >= 2, 60000, 500);
			const T3 = '@text N4-THREE again', from3 = mockLog().length;
			await send(a.page, T3);
			await waitFor(() => !!reqEnding(T3, from3), 60000, 500);
			const r3 = reqEnding(T3, from3);
			check('N4: a later turn from A sends no note as new', !!r3 && lastUserText(r3) === T3 && holding(r3, 'NW4 handed off') <= 1, J(r3 && lastUserText(r3).slice(0, 100)));
			await a.page.unroute('**/chat/completions');
			await waitFor(async () => (await stored(b, cid)).some((m) => m.content === T3), 60000, 1000).catch(() => {});
			await openChatOn(b, cid);
			const T4 = '@text N4-FOUR on B', from4 = mockLog().length;
			await chat(b, T4);
			const r4 = reqEnding(T4, from4);
			check('N4: a later turn on B sends no note as new (history holds it at most once)', !!r4 && lastUserText(r4) === T4 && holding(r4, 'NW4 handed off') <= 1, J(r4 && lastUserText(r4).slice(0, 100)));
			console.log('  (N4 B: the user messages on the wire: ' + J(r4 ? userTexts(r4).map((t) => t.slice(0, 40)) : []) + ')');
		} finally { await a.close().catch(() => {}); await b.close().catch(() => {}); }
	});
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e).slice(0, 700));
} finally {
	await D?.close().catch(() => {});
}

console.log('\nsections: ' + Object.entries(sections).map(([n, v]) => `${n} ${v.ok} ok/${v.bad} failed`).join(', '));
if (BREAK) {
	const red = Object.entries(sections).filter(([, v]) => v.bad > 0).map(([n]) => n), want = BREAKS[BREAK].sections;
	const only = red.length > 0 && red.every((n) => want.includes(n));
	console.log(`\nbreak '${BREAK}': red in ${red.length ? red.join(', ') : 'NOTHING'}; wanted ${want.join(', ')} only — ${only ? 'AS WANTED' : (red.length ? 'WRONG SET' : 'NOTHING FAILED, so the checks prove nothing')}`);
	process.exit(only ? 0 : 1);
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
