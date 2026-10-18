// gateway: none
// verify_composemerge.mjs — note-capture merged into the Proposals view.
//
// The standalone Notes view is gone. A note is written in a compose box at the
// top of Proposals and becomes a proposal, in one of two modes -- and THEY DO NOT
// END THE SAME WAY:
//
//   POST VERBATIM  — the words become the proposal at once (the direct path).
//   POLISH & POST  — the model rewrites the note into a proposal, and that draft
//                    is HELD on the row with Send now beside it. Nothing leaves
//                    until it is pressed.
//
// The second half of that changed on 2026-09-14: the drafting used to post in the
// same breath, so the card carrying the model's words was drawn and removed inside
// one turn. The owner watched his proposal go public before he could read it --
// "It should wait for my permission." dev/verify_socialpost.mjs is that property's
// own verifier; what is kept here is that the two modes still both WORK.
//
// A note that cannot be sent yet -- written offline, or a send that failed --
// waits in a small queue under the box, REMEMBERING its mode, and is drained
// automatically when the browser comes back online.
//
// What this proves, the four the owner asked for:
//   (a) verbatim online  → an immediate proposal, in the list, note gone;
//   (b) polish online    → the model's draft HELD, then posted on the press;
//   (c) offline submit   → queued, with its mode, nothing on the wire;
//   (d) reconnect        → the flush drains the queue: a verbatim note posts, a
//                          polish note is drafted and then waits for a press.
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
//   node dev/verify_composemerge.mjs --break selfwake
//   node dev/verify_composemerge.mjs --break pointerdown
//   node dev/verify_composemerge.mjs --break nodefer
//
// And the "what goes with it" row under the buttons (R53 composemerge, QA C-Q1 to C-Q3):
//
//   (g) THE ROW IS REDRAWN WHEN A PANEL OPENS OR CLOSES, AND AT NO OTHER TIME. It
//       names a panel opened with no press near it, it is written at most once per
//       open or close, and at rest it is written never. A MutationObserver on `#main`
//       once did the redraw, and the row is inside `#main`, so it woke itself sixty
//       times a second for as long as the page was visible (`--break selfwake`).
//   (h) A PRESS IS NEVER MOVED UNDER. A line grown a step before the press (a longer
//       palette name: no DOM change at all) must not be redrawn on the way to the
//       button, or the button drops under a finger that has not moved and the click
//       is lost (`--break pointerdown`, the release-4 listener); and a panel the app
//       opens while the finger is down has its redraw owed until the finger comes up
//       (`--break nodefer`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, signInAs } from './harness.mjs';
import { guardRan } from './verdict.mjs';

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
	// 831c70c1's observer on `#main`, which holds the row, and the unconditional write it
	// fed: every redraw is a mutation that wakes the next. Only (g) reddens.
	selfwake: [{
		file: 'js/improve.js',
		find: '\t\t\t\tDaimondPanels.onChange(redrawSoon);\n',
		with: '\t\t\t\tnew MutationObserver(function () { requestAnimationFrame(function () { if (!contextOff()) drawContext(); }); })'
			+ ".observe(document.getElementById('main'), { attributes: true, attributeFilter: ['style', 'class', 'hidden'], childList: true, subtree: true });\n",
	}, {
		file: 'js/improve.js',
		find: '\t\tif (line.textContent !== ctx) line.textContent = ctx;\n',
		with: '\t\tline.textContent = ctx;\n',
	}],
	// The release-4 listener: the row redrawn as the hand arrives at the button. Only (h)'s
	// grown line reddens.
	pointerdown: [{
		file: 'js/improve.js',
		find: "\t\tdocument.addEventListener('pointerdown', function () { _pressing = true; }, true);\n",
		with: "\t\tdocument.addEventListener('pointerdown', function (e) { var t = e.target; "
			+ "if (t && t.closest && t.closest('#panel-social') && !contextOff()) drawContext(); }, true);\n",
	}],
	// A panel opened under a press is redrawn at once. Only (h)'s held press reddens.
	nodefer: [{
		file: 'js/improve.js',
		find: '\t\tif (_pressing) { _drawOwed = true; return; }\n',
		with: '',
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

	// ── (b) Polish online → the draft is HELD, and the press posts it ──
	before = opens().length;
	await typeAndClick('the reply box scrolls to the top on send', 'improve-polish');
	await page.waitForTimeout(1200);
	check('(b) polish online posted NOTHING: the draft waits for a press',
		opens().length - before === 0, `${opens().length - before} posts`);
	check('(b) and the model\'s draft is held on the note',
		await page.evaluate(() => {
			const n = window.DaimondImprove.notes()[0];
			return !!(n && n.draft && /^Polished:/.test(n.draft.title));
		}) === true);
	await page.click('#improve-queue .imp-queue-row [data-act="improve-resend"]');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(300);
	const bPost = opens().length - before === 1 ? fields(opens()[opens().length - 1].body) : {};
	check('(b) pressing Send now posted exactly one proposal', opens().length - before === 1,
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

	// ── (d) Reconnect → each note as far as it may go without a press ──
	//
	// AS FAR AS IT MAY GO IS NOT THE SAME FOR BOTH. The verbatim note's characters
	// are the author's own and the press that queued them was the consent, so it
	// posts. The polish note is DRAFTED -- the press that queued it was consent to
	// spend on the model -- and then stops, because nobody has yet agreed to
	// publish what the model wrote.
	before = opens().length;
	await stubPolish();				// the override does not survive if the panel reset; re-arm
	await setOnline(true, true);	// fires 'online' → daimond.js → flushQueue
	for (let i = 0; i < 60 && await page.evaluate(() => window.DaimondImprove.notes().length > 1); i++) {
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(600);
	const left = await page.evaluate(() => window.DaimondImprove.notes().map(n => ({ mode: n.mode, draft: !!n.draft })));
	let newPosts = opens().slice(before).map(a => fields(a.body).title);
	check('(d) reconnect posted the verbatim note, and only it',
		opens().length - before === 1
		&& newPosts.some(t => t === 'offline verbatim note about a crash'),
		JSON.stringify(newPosts));
	check('(d) the polish note was drafted and is waiting on a press',
		left.length === 1 && left[0].mode === 'polish' && left[0].draft === true,
		JSON.stringify(left));
	before = opens().length;
	await page.click('#improve-queue .imp-queue-row [data-act="improve-resend"]');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(400);
	newPosts = opens().slice(before).map(a => fields(a.body).title);
	check('(d) and the press sends it, as the model\'s draft',
		opens().length - before === 1 && newPosts.some(t => /^Polished:/.test(t)),
		JSON.stringify(newPosts));
	check('(d) the queue is empty again',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);

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
	await page.waitForTimeout(1200);
	check('(f) a one-line POLISH note is untouched by the rule and is drafted',
		await page.evaluate(() => {
			const n = window.DaimondImprove.notes()[0];
			return !!(n && n.draft);
		}) === true);
	await page.click('#improve-queue .imp-queue-row [data-act="improve-resend"]');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	check('(f) and the press posts it', opens().length - before === 1,
		`${opens().length - before} posts`);

	// ── (g) The row at rest, and over opens and closes ──
	// The row was closed for (f); it comes back as a person would find it on a new note.
	await page.evaluate(() => {
		const r = document.getElementById('improve-with');
		if (r) { delete r.dataset.off; r.hidden = false; }
		window.dispatchEvent(new Event('resize'));
	});
	await page.waitForTimeout(400);
	const g = await page.evaluate(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const line = document.getElementById('improve-with-text');
		let writes = 0;
		const mo = new MutationObserver((l) => { writes += l.length; });
		mo.observe(line, { childList: true, characterData: true, subtree: true });
		const real = DaimondPanels.panels;
		let reads = 0;
		DaimondPanels.panels = function () { reads++; return real.apply(this, arguments); };
		await wait(2000);
		const rest = { writes, reads };
		writes = 0;
		let named = 0;
		for (let i = 0; i < 20; i++) {
			DaimondPanels.show('agents');
			await wait(60);
			if (/Agents/i.test(line.textContent)) named++;
			DaimondPanels.hide('agents');
			await wait(60);
		}
		await wait(400);
		const cycles = { writes, named };
		DaimondPanels.panels = real;
		mo.disconnect();
		return { rest, cycles, open: DaimondPanels.isOpen('agents'), text: line.textContent.slice(0, 120) };
	});
	check('(g) at rest the row is not rewritten (2 s, nothing happening)', g.rest.writes === 0, JSON.stringify(g.rest));
	check('(g) nor is what it says recomputed at rest (< 4 reads of the panel list in 2 s)', g.rest.reads < 4, JSON.stringify(g.rest));
	check('(g) a panel opened with no press near it is named by the row', g.cycles.named >= 18, JSON.stringify(g.cycles));
	check('(g) twenty opens and closes write the row at most once each way', g.cycles.writes <= 40, JSON.stringify(g.cycles));

	// ── (h) A press is never moved under ──
	await page.evaluate(() => {
		window.__polishN = 0;
		const real = window.DaimondTriage.polish;
		window.DaimondTriage.polish = async function (t) { window.__polishN++; return real(t); };
	});
	const rowH = () => page.evaluate(() => Math.round(document.getElementById('improve-with').getBoundingClientRect().height));
	const setSkin = (v) => page.evaluate((v) => { if (v) localStorage.setItem('daimond-skin', v); else localStorage.removeItem('daimond-skin'); }, v);
	const redraw = async () => { await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await page.waitForTimeout(250); };
	const btn = () => page.evaluate(() => {
		const b = document.querySelector('#panel-social [data-act="improve-polish"]');
		const r = b.getBoundingClientRect();
		const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
		const at = document.elementFromPoint(x, y);
		return { x, y, hit: !!(at && (at === b || b.contains(at))), vh: window.innerHeight };
	});
	await page.locator('#panel-social [data-act="improve-polish"]').scrollIntoViewIfNeeded().catch(() => {});
	const skin0 = await page.evaluate(() => localStorage.getItem('daimond-skin') || '');
	await redraw();
	const h0 = await rowH();
	let grow = '';
	for (let k = 2; k <= 80 && !grow; k += 2) {
		const v = (skin0 || 'warm') + ' ' + 'x'.repeat(k);
		await setSkin(v); await redraw();
		// A whole line, not a pixel of rounding: a row that grows by a rounding error moves no button.
		if (await rowH() >= h0 + 8) grow = v;
	}
	await setSkin(skin0); await redraw();
	check('(h) control: a palette name that adds a line to the row was found', !!grow, `row ${h0}px`);
	if (grow) {
		await page.evaluate(() => {
			const box = document.getElementById('improve-box');
			box.value = 'The line grew a step before this press\nIts body.';
			box.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await setSkin(grow);
		await page.waitForTimeout(600);
		const p0 = await btn();
		check('(h) control: the Polish button is on screen, under the pointer', p0.hit, JSON.stringify(p0));
		const n0 = await page.evaluate(() => window.__polishN);
		await page.mouse.move(p0.x, p0.y);
		await page.mouse.down();
		await page.waitForTimeout(100);
		const p1 = await btn();
		await page.mouse.up();
		await page.waitForTimeout(800);
		const landed = await page.evaluate(() => window.__polishN) - n0;
		check('(h) a line grown a step before the press: the button stays under the finger', p1.y === p0.y, `moved ${p1.y - p0.y}px`);
		check('(h) and the press lands', landed === 1, `polish calls ${landed}; button ${JSON.stringify(p0)}`);
		await setSkin(skin0);
		await page.evaluate(() => { try { for (const n of window.DaimondImprove.notes()) window.DaimondImprove.drop && window.DaimondImprove.drop(n.id); } catch (e) { /* none */ } });
	}
	await redraw();
	// A panel the app opens while a finger is down: the row's redraw waits for the finger.
	await page.evaluate(() => {
		const box = document.getElementById('improve-box');
		box.value = '';
		box.dispatchEvent(new Event('input', { bubbles: true }));
	});
	const q0 = await btn();
	await page.evaluate(() => {
		const line = document.getElementById('improve-with-text');
		window.__rowWrites = 0;
		window.__rowMo = new MutationObserver((l) => { window.__rowWrites += l.length; });
		window.__rowMo.observe(line, { childList: true, characterData: true, subtree: true });
	});
	await page.mouse.move(q0.x, q0.y);
	await page.mouse.down();
	await page.evaluate(() => DaimondPanels.show('agents'));
	await page.waitForTimeout(300);
	const held = await page.evaluate(() => window.__rowWrites);
	await page.mouse.up();
	await page.waitForTimeout(500);
	const after = await page.evaluate(() => {
		window.__rowMo.disconnect();
		return { writes: window.__rowWrites, names: /Agents/i.test(document.getElementById('improve-with-text').textContent) };
	});
	check('(h) a panel opened while the finger is down: the row is not redrawn under it', held === 0, `writes while held ${held}`);
	check('(h) and it is redrawn once the finger is up, naming the panel', after.writes > held && after.names, JSON.stringify(after));
	await page.evaluate(() => DaimondPanels.hide('agents'));

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
guardRan(ok.length + bad.length);
console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
