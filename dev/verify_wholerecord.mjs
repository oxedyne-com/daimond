// An answer shortened to fit the model's window stays whole in the user's record.
//
// The owner's ruling of 2026-08-28: *the model gets the shortened version, his transcript
// keeps every word.*  `compact::elide_bulk` used to rewrite the older assistant turns of
// `session.messages` down to `TOOL_ELISION_CAP` -- 400 characters and a note -- and
// `session.messages` is the list `DaimondApp::export_session` hands the browser to store, to
// back up and to put in the sync parcel.  So a thousand-word answer became two sentences in
// the STORE as well as on the wire, permanently, and nothing anywhere said so.
//
// The separation is made at the point of derivation: the elision is done to the turn's own
// message list on its way out and never to the session.  This asks the two questions that
// distinguishes those, and it asks them of the two artefacts rather than of the app --
// `dev/ctxmock.log`, which is what the provider was really sent, and IndexedDB, which is what
// is really on disk.
//
// The window is calibrated the way `dev/verify_compact.mjs` calibrates it, and for the reason
// written there at length: the floor is the system prompt plus the tool schemas, nobody owns
// it, and a written-down window stops being a window the day a lane adds a tool.
//
//   node dev/verify_wholerecord.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const H = await import(path.join(HERE, 'harness.mjs'));
const { open, newChat, transcript, shot, connectMock, storedChats, signInAs } = H;

const WORLD = Number(process.env.DAIMOND_PORT || 8777) - 8777;
const LOG   = process.env.DAIMOND_WHOLE_LOG
	|| path.join(HERE, WORLD ? `wholemock-${WORLD}.log` : 'wholemock.log');
const PORT  = Number(process.env.DAIMOND_WHOLE_PORT || 9800 + WORLD);
const MOCK  = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const MODEL = 'mock/fast';
const NAME  = 'wholerecord';
const MARK  = 'LONGANSWER-K4W9';
// The sentence the engine writes over what it shortened. Read from `compact.rs` rather than
// copied, so a change to the wording fails here loudly instead of turning every check below
// into one that cannot see its own subject.
const CLIP = (() => {
	const src = fs.readFileSync(path.join(ROOT, 'src', 'compact.rs'), 'utf8');
	const m = /were folded away to fit the context window/.exec(src);
	if (!m) throw new Error('compact.rs no longer writes that sentence; this file cannot see its subject');
	return m[0];
})();
const PROBE_LIMIT = 10_000_000;
const HEADROOM    = 400;
const FOLD_AT = (() => {
	const m = /pub const FOLD_AT:\s*f64\s*=\s*([0-9.]+)/.exec(
		fs.readFileSync(path.join(ROOT, 'src', 'compact.rs'), 'utf8'));
	if (!m) throw new Error('compact.rs no longer declares FOLD_AT; this file cannot calibrate');
	return Number(m[1]);
})();

let failures = 0;
const log = (...a) => console.log(...a);
const line = (t) => log('\n════════ ' + t + ' ════════');
const check = (ok, what, detail = '') => {
	log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '  -- ' + detail : ''));
	if (!ok) failures++;
};
const requests = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
	.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const bodyOf = (r) => (r.messages || []).map(m => {
	const c = m.content;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) return c.map(p => (p && p.text) || '').join(' ');
	return '';
}).join('\n');

async function startMock(limit) {
	const child = spawn('node', [path.join(HERE, 'ctxmock.mjs'), String(PORT), String(limit)],
		{ stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, DAIMOND_CTX_LOG: LOG } });
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
			if (r.ok) return child;
		} catch (e) { /* not up yet */ }
		await new Promise(r => setTimeout(r, 100));
	}
	child.kill();
	throw new Error(`ctxmock did not come up on ${PORT}; is something else already listening?`);
}

const say = async (s, text, waitMs = 7000) => {
	await s.page.fill('#chat-input', text);
	await s.page.click('#chat-send');
	await s.page.waitForTimeout(waitMs);
};

try { fs.writeFileSync(LOG, ''); } catch {}
let mock = await startMock(PROBE_LIMIT);
const s = await open({ name: NAME, connect: false });
await connectMock(s, { baseUrl: MOCK, model: MODEL });
await newChat(s);

await say(s, 'hello', 5000);
const probed = (() => { const r = requests(); return r.length ? r[0].used : 0; })();
if (!probed) { log('FAIL  the probe never reached the mock, so the window cannot be calibrated'); process.exit(1); }
const LIMIT = Math.ceil((probed + HEADROOM) / FOLD_AT);
log(`floor ${probed} tokens, folding at ${FOLD_AT}, so the window for this run is ${LIMIT}`);
mock.kill();
await new Promise((r) => setTimeout(r, 300));
try { fs.writeFileSync(LOG, ''); } catch {}
mock = await startMock(LIMIT);
await newChat(s);

// ── The fixture: one long answer, then enough bulk to outgrow the window ─────
line('1. a long answer, and then a conversation too big to send');
// `@text` echoes what follows it, so the answer is built here and its marker sits well past
// TOOL_ELISION_CAP -- the whole point is a word that only survives if the record is whole.
const FILL = 'the answer goes on at length about what it found and why it matters. ';
const LONG = FILL.repeat(12) + MARK + ' ' + FILL.repeat(40);
await say(s, `@text ${LONG}`, 8000);
let reached = false;
for (let i = 0; i < 8 && !reached; i++) {
	await say(s, '@big 20', 10000);
	reached = requests().some(r => bodyOf(r).includes(CLIP));
	const last = requests().slice(-1)[0] || {};
	log(`  turn ${i + 1}: ${last.used} tokens, refused=${!!last.refused}, shortened=${reached}`);
}
// A fixture that never reached the branch proves nothing, so it stops rather than passing.
if (!reached) {
	console.error('the conversation never had an answer shortened on the way out, so there is '
		+ 'nothing here to be whole or not whole. The fixture no longer reaches elide_bulk.');
	await s.close();
	mock.kill();
	process.exit(2);
}
check(true, 'the wire really did carry a shortened answer, which is the state this is about');

line('2. what the model was sent, and what the store kept');
const stored = await storedChats(s);
const chat = stored.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || {};
const sess = (chat.session && chat.session.msgs) || [];
const sessText = sess.map(m => String((m && m.content) || '')).join('\n');
const seenText = (chat.messages || []).map(m => String((m && m.content) || '')).join('\n');

check(sess.length > 0,
	'the model\'s own conversation was stored, which is the artefact under test',
	`${sess.length} messages`);
// THE RULING, and the check that was red before it. The store used to hold exactly what went on
// the wire, sentence for sentence, because the two were one list.
//
// A FOLD IS NOT THIS. A conversation this size folds as well as shortening, and a fold really
// does replace what it folded -- deliberately, announced, and drawn as a line across the thread
// by `appendCompacted`. So the marker is not asked of the stored session, which may legitimately
// no longer hold the message it was in; what is asked is that nothing in that store was CLIPPED,
// which is the operation that was never announced and never had a way back.
check(!sessText.includes(CLIP),
	'AND NOTHING IN IT WAS SHORTENED — the record is not the wire',
	sessText.includes(CLIP) ? 'the store holds the engine\'s own elision note' : 'no elision note in the store');
check(!seenText.includes(CLIP),
	'nor was anything in the transcript on screen');
check(seenText.includes(MARK),
	'and the long answer is still there in full, marker and all — which is the user\'s record');

line('3. and the reader is told, once and quietly');
const said = await transcript(s);
// The notice that actually shortened something, not merely a notice. A fold that shortened
// nothing writes "shortened 0", and a check that matched it would pass on a run where the
// sentence under test never described anything.
const shortNote = (said.match(/[^\n]*[Ss]hortened [1-9][0-9]* long[^\n]*/) || [''])[0];
check(/on the way to the model/.test(shortNote),
	'the notice says where the shortening applies, rather than leaving it to be guessed',
	shortNote.slice(0, 200) || '(no notice reported shortening anything)');
// TOLD ONCE. The shortening is redone from the whole record on every turn from here on, so the
// engine says so every turn; a thread with a grey notice per turn is the noise `worthSaying`
// exists to stop.
const shortLines = (said.match(/[Ss]hortened [1-9][0-9]* long/g) || []).length;
check(shortLines <= 1,
	'and it is said once rather than on every turn from then on',
	`${shortLines} such notice(s) in the thread`);

// SCROLLED TO THE NOTICE BEFORE IT IS SHOT. A conversation this size ends in several screens of
// bulk, so a screenshot taken where the thread happens to be shows lorem ipsum and settles
// nothing about the one element this file is about.
await s.page.evaluate(() => {
	const notes = [...document.querySelectorAll('.chat-msg-compacted')];
	const last = notes[notes.length - 1];
	if (last) last.scrollIntoView({ block: 'center' });
});
await s.page.waitForTimeout(400);
await shot(s, 'wholerecord-notice');

line('4. after a reload');
await s.page.reload({ waitUntil: 'domcontentloaded' });
await s.page.waitForTimeout(1200);
await signInAs(s, NAME);
await s.page.waitForTimeout(1500);
await s.page.evaluate(() => {
	const b = document.querySelector('#session-list .chat-box.active')
		|| document.querySelector('#session-list .chat-box');
	if (b) b.click();
});
await s.page.waitForTimeout(1200);
const after = await transcript(s);
check(after.includes(MARK), 'a reader who comes back tomorrow still has every word of it');

await shot(s, 'wholerecord-final');
// The 400 is the fixture: `ctxmock` refuses a request past the window it was started with, and
// driving the app into exactly that refusal is how this file gets a conversation shortened at
// all. Filtering it is not looking away from an error; it is naming the one this run causes.
const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway|\b400\b/i.test(e));
check(errs.length === 0, 'no unexpected console errors', errs.slice(0, 3).join(' | '));
await s.close();
mock.kill();

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
