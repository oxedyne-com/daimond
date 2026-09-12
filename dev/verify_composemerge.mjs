// verify_composemerge.mjs — note-capture merged into the Proposals view.
//
// The standalone Notes view is gone. A note is written in a compose box at the
// top of Proposals and posted straight as a proposal, in one of two modes that
// both auto-send:
//
//   POST VERBATIM  — the words become the proposal at once (the direct path).
//   POLISH & POST  — the model rewrites the note into a proposal, then that is
//                    posted (the triage draft path).
//
// A note that cannot be sent yet -- written offline, or a send that failed --
// waits in a small queue under the box, REMEMBERING its mode, and is drained
// automatically when the browser comes back online.
//
// What this proves, the four the owner asked for:
//   (a) verbatim online  → an immediate proposal, in the list, note gone;
//   (b) polish online    → the DRAFTED proposal posted and in the list;
//   (c) offline submit   → queued, with its mode, nothing on the wire;
//   (d) reconnect        → the flush drains the queue, each note in its own mode.
//
// And two more, added because the queue had no way out of a refusal:
//
//   (e) A NOTE THE FORGE REFUSES LEAVES THE FLUSH. Every check above is about a
//       send that will eventually work, and the queue was built for exactly
//       that: it re-sends everything waiting at every panel open and every
//       reconnect. A note the forge REFUSES never stops being waiting, so it
//       was re-sent for ever -- two 400s on the owner's desktop at every boot,
//       with the row still saying "Waiting to send". So a settled refusal
//       (malformed/unpermitted/unsupported/absent/no_proposal, or 400/403/404/
//       405) is written onto the note, the flush skips it, the row says what
//       the forge said, and SEND NOW is what puts it back on the wire -- once.
//       The count at the network is what makes this provable: "not re-sent"
//       and "re-sent and hidden" look identical on the screen.
//
//   (f) A NOTE THE FORGE WOULD REFUSE IS NEVER QUEUED. The forge takes no
//       proposal with an empty body (`NO_BODY`), and the compose box asked only
//       for a first line -- so a one-line note written with the "what goes with
//       it" row closed was queued, refused, and kept. It is refused at the box
//       now, where the words are still in front of the person who can fix them.
//
// The model is not run for real: `DaimondTriage.polish` is overridden in the page
// to return a fixed draft, so what is proved is improve.js's WIRING -- that a
// polished note posts what the drafting returned, through the same door a verbatim
// note leaves by. `dev/verify_triage.mjs` proves the real model run.
//
//   eval "$(bash dev/world.sh 8 --env)"
//   node dev/verify_composemerge.mjs
//   node dev/verify_composemerge.mjs --break noflush
//   node dev/verify_composemerge.mjs --break resendsrefused
//   node dev/verify_composemerge.mjs --break queuesnobody

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'composemerge' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Seams: the merged surface must be wired, or the run proves nothing.

const SEAM = [
	{ file: 'index.html', want: 'data-act="improve-post"',
	  why: 'the compose box has no Post action' },
	{ file: 'index.html', want: 'data-act="improve-polish"',
	  why: 'the compose box has no Polish action' },
	{ file: 'js/improve.js', want: 'flushQueue: flushQueue',
	  why: 'the queue cannot be drained on reconnect' },
	{ file: 'js/daimond.js', want: 'DaimondImprove.flushQueue()',
	  why: 'the online event never drains the queue' },
	{ file: 'index.html', want: 'id="improve-raised"',
	  why: 'the compose box has no "Raised — see it in Improve" confirmation host' },
	{ file: 'js/improve.js', want: "act === 'improve-open-hub'",
	  why: 'the Raised confirmation cannot open the Improve hub' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = FILES.get(s.file) ?? fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the merged compose surface is not wired, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}

// ── The break: the reconnect flush is severed, so an offline note never sends.

const BREAKS = {
	// The reconnect flush is severed: it iterates an empty snapshot, so a queued
	// note is never drained when the browser comes back. (a)-(c) stay green -- the
	// immediate sends and the offline queueing are untouched -- and only (d) reddens.
	noflush: [{
		file: 'js/improve.js',
		find: '\t\t\tvar q = sendable();',
		with: '\t\t\tvar q = [];		// snapshot severed by the break',
	}],
	// The flush takes every queued note again, refused or not -- which is what it
	// did, and is the whole defect. (a)-(d) stay green; only (e) reddens.
	resendsrefused: [{
		file: 'js/improve.js',
		find: '\t\t\tvar q = sendable();',
		with: '\t\t\tvar q = load().notes.slice();',
	}, {
		file: 'js/improve.js',
		find: '\t\t\t\tif (!rec || rec.refused) continue;\t// taken, or refused meanwhile',
		with: '\t\t\t\tif (!rec) continue;',
	}],
	// The compose box asks for a title and nothing else, so a body-less note is
	// queued exactly as it used to be. Only (f) reddens.
	queuesnobody: [{
		file: 'js/improve.js',
		find: '\t\t\tif (!cut.body.trim()) {',
		with: '\t\t\tif (false) {',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function edit(src, spec, what) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`${what}: the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const FILES = new Map();
function build() {
	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const p = spec.file;
			const src = FILES.get(p) ?? fs.readFileSync(path.join(WWW, p), 'utf8');
			FILES.set(p, edit(src, spec, `break '${BREAK}'`));
		}
	}
	requireSeams();
}
build();

// ── The forge, answered locally. GET reads an (empty) listing; a POST that opens
// a proposal is given the next number, from 100 up.

const HDR = 'x-daimond-voice';
// allowlist secret
const SECRET = 'mock-voice-ada-0000000000000';

let nextNew = 100;
const asked = [];

// When set, every POST that OPENS a proposal is refused with this token and this
// sentence -- the shape the real forge answers a body-less proposal with. A flag
// rather than a second stand-in, because (e) needs the SAME forge to refuse and
// then accept the same note: a retry that went to a different server would prove
// the client can talk to two servers and nothing about the retry.
let refusing = null;

async function improveRoute(r) {
	const req = r.request();
	const u   = new URL(req.url());
	const q   = u.searchParams;
	const method = req.method();
	const body = req.postData() || '';
	const headers = req.headers();
	asked.push({ method, body, query: Object.fromEntries(q) });

	const json = (obj) => r.fulfill({ status: 200, contentType: 'application/json',
		body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
	const refuse = (status, error, said) => r.fulfill({ status, contentType: 'application/json',
		body: JSON.stringify({ error, said: said || ('The forge refused: ' + error + '.') }) });

	if (method === 'GET') {
		if (q.get('n') !== null) {
			const n = Number(q.get('n'));
			return json({ number: n, title: 'Proposal ' + n, body: 'b', state: 'open', author: 'ada',
				comments: 0, opened: 1, changed: 2, discussion: [], votes: { for: 0, against: 0 },
				mark: null, build: null, revisions: [] });
		}
		return json({ proposals: [], total: 0, done: true });
	}
	if (!headers[HDR]) return refuse(401, 'unvoiced');

	const n = q.get('n');
	if (n === null && refusing) return refuse(400, refusing.error, refusing.said);
	const num = n !== null ? Number(n) : nextNew++;
	return json({ number: num, title: 'Proposal ' + num, body: 'b', state: 'open', author: 'ada',
		comments: 0, opened: 1, changed: 2, discussion: [], votes: { for: 0, against: 0 },
		mark: null, build: null, revisions: [] });
}

const j = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(page) {
	for (const [p, body] of FILES) {
		const type = p.endsWith('.html') ? 'text/html' : 'application/javascript';
		await page.route('**/' + p, r => r.fulfill({ status: 200, contentType: type, body }));
	}
	if (FILES.has('index.html')) {
		await page.route(u => u.pathname === '/' || u.pathname === '/index.html',
			r => r.fulfill({ status: 200, contentType: 'text/html', body: FILES.get('index.html') }));
	}
	await page.route(u => u.pathname === '/api/improve', improveRoute);
	await page.route('**/api/telemetry',      r => r.fulfill(j({ ok: true })));
	await page.route('**/api/account',        r => r.fulfill(j({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(j({ ok: true, challenge: 'chal-cm', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(j({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(j({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(j({ ok: true, licence: false, currency: 'usd' })));
}

const opens = () => asked.filter(a => a.method === 'POST' && a.query.n === undefined);
const fields = (raw) => { const o = {}; for (const [k, v] of new URLSearchParams(raw)) o[k] = v; return o; };

const s = await open({ name: 'composemerge', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

await signInAs(s, 'composemerge');
await page.waitForTimeout(1000);

// A page helper: force the browser's online state, and (optionally) fire the event.
async function setOnline(on, fire) {
	await page.evaluate(({ on, fire }) => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on });
		if (fire) window.dispatchEvent(new Event(on ? 'online' : 'offline'));
	}, { on, fire });
}

// The polish path, without a real model: a fixed draft, so the WIRING is proved.
async function stubPolish() {
	await page.evaluate(() => {
		window.DaimondTriage = window.DaimondTriage || {};
		window.DaimondTriage.polish = async function (text) {
			return { title: 'Polished: ' + String(text || '').split('\n')[0].slice(0, 40),
				body: 'A tidier body the model wrote from the note.' };
		};
	});
}

async function typeAndClick(text, act) {
	await page.evaluate((t) => {
		const box = document.getElementById('improve-box');
		box.value = t;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	}, text);
	await page.waitForTimeout(80);
	await page.click('#panel-social [data-act="' + act + '"]');
}

try {
	await page.evaluate(() => { window.DaimondPanels.show('social'); });
	await page.waitForTimeout(300);
	await page.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(400);

	// A voice, set through the Settings view where it now lives.
	await page.evaluate(() => window.DaimondSocial.show('settings'));
	await page.waitForTimeout(200);
	await page.click('#panel-social [data-act="improve-voice-open"]');
	await page.waitForTimeout(150);
	await page.fill('#improve-voice-in', SECRET);
	await page.click('#panel-social [data-act="improve-voice-save"]');
	await page.waitForTimeout(500);
	check('a voice is held (set from Settings), so the box can post',
		await page.evaluate(() => window.DaimondVoice.has()) === true);
	await page.evaluate(() => window.DaimondSocial.show('proposals'));
	await page.waitForTimeout(200);

	await stubPolish();
	await setOnline(true, false);

	// ── (a) Verbatim online → an immediate proposal, note gone ──
	let before = opens().length;
	await typeAndClick('Reload empties the note box\nIt should keep what I typed.', 'improve-post');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(300);
	const aPost = opens().length - before === 1 ? fields(opens()[opens().length - 1].body) : {};
	check('(a) verbatim online posted exactly one proposal', opens().length - before === 1,
		`${opens().length - before} posts`);
	check('(a) it carried the words verbatim, as title + body',
		aPost.title === 'Reload empties the note box' && /keep what I typed/.test(aPost.body || ''),
		JSON.stringify(aPost).slice(0, 140));
	check('(a) the note is gone from the queue: it became a proposal',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);
	check('(a) and the proposal appears in the store',
		await page.evaluate(() => window.DaimondImprove.forge.props().some(p => p.n === 100)));

	// ── Capture-only: the browse list is gone, a confirmation points at the hub ──
	// The Social ▸ Proposals surface writes a proposal; the browse/vote list of all
	// proposals is the Improve hub (js/tracker.js) now, not here, so the two surfaces
	// no longer duplicate a list.
	check('the browse list of all proposals is NOT on the capture surface',
		await page.locator('#panel-social #improve-props').count() === 0,
		`${await page.locator('#panel-social #improve-props').count()} list host(s)`);
	check('after a raise, the "Raised — see it in Improve" confirmation shows',
		await page.locator('#improve-raised [data-act="improve-open-hub"]').count() === 1);
	const raisedText = await page.evaluate(() => {
		const h = document.getElementById('improve-raised');
		return h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : '';
	});
	check('the confirmation reads "Raised" and names the Improve hub',
		/[Rr]aised/.test(raisedText) && /Improve/.test(raisedText), raisedText);
	// The affordance opens the Improve hub panel (js/tracker.js, #panel-tracker).
	await page.click('#improve-raised [data-act="improve-open-hub"]');
	await page.waitForTimeout(300);
	check('pressing Improve opens the Improve hub panel',
		await page.evaluate(() => !!(window.DaimondPanels && DaimondPanels.isOpen('tracker'))) === true);
	// Back to Social for the checks that follow.
	await page.evaluate(() => { window.DaimondPanels.show('social'); window.DaimondSocial.show('proposals'); });
	await page.waitForTimeout(200);

	// ── (b) Polish online → the DRAFTED proposal posted ─────────
	before = opens().length;
	await typeAndClick('the reply box scrolls to the top on send', 'improve-polish');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(300);
	const bPost = opens().length - before === 1 ? fields(opens()[opens().length - 1].body) : {};
	check('(b) polish online posted exactly one proposal', opens().length - before === 1,
		`${opens().length - before} posts`);
	check('(b) it carried the model\'s DRAFT, not the raw note',
		/^Polished:/.test(bPost.title || '') && /tidier body/.test(bPost.body || ''),
		JSON.stringify(bPost).slice(0, 140));
	check('(b) the note is gone and the drafted proposal appears',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0
		&& await page.evaluate(() => window.DaimondImprove.forge.props().some(p => p.n === 101)));

	await shot(s, 'composemerge-posted' + (BREAK ? '-' + BREAK : ''));

	// ── (c) Offline submit → queued, with its mode, nothing sent ─
	await setOnline(false, true);
	before = opens().length;
	await typeAndClick('offline verbatim note about a crash', 'improve-post');
	await page.waitForTimeout(250);
	await typeAndClick('offline polish note about wording', 'improve-polish');
	await page.waitForTimeout(250);
	const queued = await page.evaluate(() => window.DaimondImprove.notes().map(n => ({ mode: n.mode, text: n.text.split('\n')[0] })));
	check('(c) offline, nothing reached the forge', opens().length - before === 0,
		`${opens().length - before} posts`);
	check('(c) both notes are queued, each remembering its mode',
		queued.length === 2
		&& queued.some(n => n.mode === 'verbatim' && /crash/.test(n.text))
		&& queued.some(n => n.mode === 'polish' && /wording/.test(n.text)),
		JSON.stringify(queued));
	const qHead = await page.evaluate(() => {
		const h = document.querySelector('#improve-queue .imp-queue-head');
		return h ? h.textContent : '';
	});
	check('(c) the queue shows "Waiting to send (2)"', /2/.test(qHead) && /[Ww]aiting/.test(qHead), qHead);
	check('(c) a queued (offline) note also shows the Raised confirmation',
		await page.locator('#improve-raised [data-act="improve-open-hub"]').count() === 1);
	await shot(s, 'composemerge-offline' + (BREAK ? '-' + BREAK : ''));

	// ── (d) Reconnect → the flush drains, each in its own mode ──
	before = opens().length;
	await stubPolish();				// the override does not survive if the panel reset; re-arm
	await setOnline(true, true);	// fires 'online' → daimond.js → flushQueue
	for (let i = 0; i < 60 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(400);
	const drained = await page.evaluate(() => window.DaimondImprove.notes().length);
	const newPosts = opens().slice(before).map(a => fields(a.body).title);
	check('(d) reconnect drained the queue: nothing left waiting', drained === 0, `${drained} left`);
	check('(d) both queued notes were sent on reconnect', opens().length - before === 2,
		`${opens().length - before} posts`);
	check('(d) the verbatim one went verbatim, the polish one as a draft',
		newPosts.some(t => t === 'offline verbatim note about a crash')
		&& newPosts.some(t => /^Polished:/.test(t)),
		JSON.stringify(newPosts));

	// ── (e) A refusal the forge will repeat takes the note out of the flush ──
	//
	// Counted at the network throughout. The claim is about REQUESTS THAT ARE NOT
	// MADE, and a client that made them and swallowed the answers would look
	// exactly the same on the screen.

	/// The one queued row, as it is drawn.
	const qRow = () => page.evaluate(() => {
		const row = document.querySelector('#improve-queue .imp-queue-row');
		if (!row) return null;
		const st = row.querySelector('.imp-note-state');
		return {
			id:     row.dataset.note,
			state:  st ? st.dataset.state : '',
			says:   st ? (st.textContent || '').trim() : '',
			send:   !!row.querySelector('[data-act="improve-resend"]'),
			drop:   !!row.querySelector('.imp-note-drop, [data-act="improve-drop"]'),
		};
	});

	refusing = { error: 'malformed', said: 'The proposal has no body.' };
	before = opens().length;
	await typeAndClick('the forge will not take this one\nand it will not change its mind.', 'improve-post');
	await page.waitForTimeout(600);
	check('(e) a refused note cost exactly one request', opens().length - before === 1,
		`${opens().length - before} posts`);
	let qr = await qRow();
	check('(e) the note is STILL in the queue: the forge has no copy of it',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 1);
	const marked = await page.evaluate(() => {
		const n = window.DaimondImprove.notes()[0];
		return n && n.refused ? { why: n.refused.why, said: n.refused.said, at: n.refused.at } : null;
	});
	check('(e) and it is marked refused, with the forge\'s token and sentence kept',
		!!marked && marked.why === 'malformed' && /no body/.test(marked.said || '') && marked.at > 0,
		JSON.stringify(marked));
	check('(e) the row says the forge would not take it, not "waiting to send"',
		!!qr && qr.state === 'refused' && /no body/.test(qr.says) && !/[Ww]aiting/.test(qr.says),
		JSON.stringify(qr));
	check('(e) and both controls are still on the row: Send now, and Delete',
		!!qr && qr.send === true && qr.drop === true, JSON.stringify(qr));

	// The defect itself: every panel open and every reconnect used to put it back
	// on the wire. Three drains, and the network must not move.
	before = opens().length;
	await page.evaluate(() => window.DaimondImprove.flushQueue());
	await page.evaluate(() => window.DaimondImprove.onOpen());
	await setOnline(true, true);
	await page.waitForTimeout(700);
	check('(e) a flush, a panel open and a reconnect send it NOWHERE',
		opens().length - before === 0, `${opens().length - before} posts`);
	check('(e) and it is still there, still refused, rather than quietly dropped',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 1
		&& await page.evaluate(() => !!window.DaimondImprove.notes()[0].refused));

	// Send now is the way back onto the wire, and it is ONE attempt.
	before = opens().length;
	await page.click('#improve-queue .imp-queue-row [data-act="improve-resend"]');
	await page.waitForTimeout(700);
	check('(e) Send now retries, exactly once', opens().length - before === 1,
		`${opens().length - before} posts`);
	qr = await qRow();
	check('(e) refused again, so the refusal is written back and the flush stays off it',
		!!qr && qr.state === 'refused'
		&& await page.evaluate(() => !!window.DaimondImprove.notes()[0].refused),
		JSON.stringify(qr));
	before = opens().length;
	await page.evaluate(() => window.DaimondImprove.flushQueue());
	await page.waitForTimeout(400);
	check('(e) and a flush after the second refusal still sends nothing',
		opens().length - before === 0, `${opens().length - before} posts`);

	// And when the forge stops refusing, the same press sends it and success still
	// takes the note off the queue -- which is what makes the refusal a state and
	// not a grave.
	refusing = null;
	before = opens().length;
	await page.click('#improve-queue .imp-queue-row [data-act="improve-resend"]');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	check('(e) once the forge takes it, Send now posts it', opens().length - before === 1,
		`${opens().length - before} posts`);
	check('(e) and success still removes the note from the queue',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);
	// The number the stand-in has just handed out, rather than one counted by hand:
	// every accepted open above moves it, so a literal here would be a check that
	// re-breaks whenever a section is added earlier in the file.
	const gotN = nextNew - 1;
	check('(e) the proposal it became is in the store',
		await page.evaluate((n) => window.DaimondImprove.forge.props().some(p => p.n === n), gotN),
		'#' + gotN);
	await shot(s, 'composemerge-refused' + (BREAK ? '-' + BREAK : ''));

	// ── (f) A note with no body never enters the queue ──────────
	//
	// The "what goes with it" line IS a body, so it has to be off for the box to
	// be able to produce a body-less note at all -- which is exactly the state the
	// owner's two refused notes were written in.
	await page.evaluate(() => {
		const box = document.getElementById('improve-box');
		box.value = 'x';
		box.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(150);
	await page.click('#panel-social [data-act="improve-with-off"]');
	await page.waitForTimeout(150);
	check('(f) the "what goes with it" row is closed, so a one-line note has no body',
		await page.evaluate(() => /\n/.test(window.DaimondImprove.outgoing()) === false));

	before = opens().length;
	await typeAndClick('one line and nothing under it', 'improve-post');
	await page.waitForTimeout(500);
	check('(f) nothing reached the forge', opens().length - before === 0,
		`${opens().length - before} posts`);
	check('(f) and nothing was queued: the note the forge would refuse was never taken',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);
	const said = await page.evaluate(() => {
		const n = document.getElementById('improve-say');
		return n ? (n.textContent || '').trim() : '';
	});
	check('(f) the box says what is missing, naming the body', /body/i.test(said), said);
	check('(f) and the words are still in the box for the person to finish',
		await page.evaluate(() => document.getElementById('improve-box').value) === 'one line and nothing under it');
	// A polished note is NOT held to this: the model writes the body, so the box
	// never sees one. The check is the pair of (f), and without it the guard could
	// be sitting on both verbs and nothing here would notice.
	before = opens().length;
	await stubPolish();
	await typeAndClick('one line, to be polished', 'improve-polish');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	check('(f) a one-line POLISH note is untouched by the rule and still posts',
		opens().length - before === 1, `${opens().length - before} posts`);

	const errs = errors(s).filter(e => !/Failed to load resource/.test(e));
	check('nothing above was reached by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log(`\nforge opens: ${opens().length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
