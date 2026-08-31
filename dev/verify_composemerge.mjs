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
// The model is not run for real: `DaimondTriage.polish` is overridden in the page
// to return a fixed draft, so what is proved is improve.js's WIRING -- that a
// polished note posts what the drafting returned, through the same door a verbatim
// note leaves by. `dev/verify_triage.mjs` proves the real model run.
//
//   eval "$(bash dev/world.sh 8 --env)"
//   node dev/verify_composemerge.mjs
//   node dev/verify_composemerge.mjs --break noflush

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
		find: '\t\t\tvar q = load().notes.slice();		// a snapshot of ids; the list changes under us',
		with: '\t\t\tvar q = [];		// snapshot severed by the break',
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
	const refuse = (status, error) => r.fulfill({ status, contentType: 'application/json',
		body: JSON.stringify({ error, said: 'The forge refused: ' + error + '.' }) });

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
	check('(a) and the proposal appears in the list',
		await page.evaluate(() => window.DaimondImprove.forge.props().some(p => p.n === 100)));

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
