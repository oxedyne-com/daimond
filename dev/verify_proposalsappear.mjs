// verify_proposalsappear.mjs — the meta-bug: a batch-sent proposal must APPEAR.
//
// The owner sent eight queued drafts as proposals. All eight reached the forge,
// and ONE appeared in the app's Proposals view. The other seven were hidden --
// which hid, among them, the very proposals about the app they were meant to
// surface. This is the fault that made everything else harder to see, so it is
// checked on its own here.
//
// The mechanism: `www/js/approvelist.js` sends each ticked draft through
// improve.js's forge door (`forge.open`/`say`/`amend`). A door PUTS a write on
// the wire and answers with the record it changed; the panel's OWN send, comment
// and vote each fold that answer back into the proposal store (`absorb`), but the
// batch did not. So a proposal the queue opened never entered `_by`/`_order`, and
// the Proposals view -- drawn from `_order` -- omitted it until the next full
// walk. The fix folds each answer in through `forge.absorb`.
//
// What this proves: after a MULTI-ITEM batch send, EVERY proposal the batch
// opened is present in the panel's proposal store AND drawn in the list, with NO
// re-walk of the forge in between -- the send itself must make them appear.
//
// The forge is answered locally in the /api/improve stub, deterministically, and
// a POST that opens a proposal is given a FRESH, INCREMENTING number, so several
// new proposals in one batch are several distinct records and "they all appear"
// is a claim with more than one thing in it.
//
//   eval "$(bash dev/world.sh 8 --env)"
//   node dev/verify_proposalsappear.mjs
//   node dev/verify_proposalsappear.mjs --break noappear

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

const PROFILE = scratch('pw', 'proposalsappear' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The seams: the fix must be wired, or the run proves nothing. The approve-
// list must hand the forge's answer to the panel, and the panel must offer the
// door that folds it in.

const SEAM = [
	{ file: 'js/approvelist.js', want: 'p.forge.absorb(a.data)',
	  why: 'a sent draft is never folded into the proposal store, so it cannot appear' },
	{ file: 'js/improve.js', want: 'absorb:   function (data) { return absorb(cleanProp(data)); }',
	  why: 'the panel offers no door to fold a batch answer into its proposal store' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = FILES.get(s.file) ?? fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the appear-in-the-view fix is not wired, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}

// ── The break. The one edit that reintroduces the meta-bug: the batch sends, but
// its answers are never folded back, so the proposals never enter the view.

const BREAKS = {
	noappear: [{
		file: 'js/approvelist.js',
		find: '\t\ttry { if (p.forge && p.forge.absorb) p.forge.absorb(a.data); }',
		with: '\t\ttry { if (false && p.forge && p.forge.absorb) p.forge.absorb(a.data); }',
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

// ── The forge, answered locally. A GET reads the listing (two proposals already
// there, so the view starts non-empty) or one proposal; a POST that opens a new
// proposal is given the next number, counting up from 100.

const HDR = 'x-daimond-voice';
// allowlist secret
const SECRET = 'mock-voice-ada-0000000000000';

let nextNew = 100;

function listingBody() {
	const prop = (n) => ({ number: n, title: 'Existing ' + n, state: 'open', author: 'ada',
		comments: 0, opened: 1, changed: 2, mark: null, build: null });
	return JSON.stringify({ proposals: [prop(5), prop(4)], total: 2, done: true });
}

function detailBody(n) {
	return { number: n, title: 'Proposal ' + n, body: 'the body of ' + n, state: 'open',
		author: 'ada', comments: 0, opened: 1, changed: 2, discussion: [],
		votes: { for: 0, against: 0 }, mark: null, build: null, revisions: [] };
}

const asked = [];

async function improveRoute(r) {
	const req = r.request();
	const u   = new URL(req.url());
	const q   = u.searchParams;
	const method = req.method();
	const headers = req.headers();
	asked.push({ url: req.url(), method, query: Object.fromEntries(q) });

	const json = (obj) => r.fulfill({ status: 200, contentType: 'application/json',
		body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
	const refuse = (status, error) => r.fulfill({ status, contentType: 'application/json',
		body: JSON.stringify({ error, said: 'The forge refused: ' + error + '.' }) });

	if (method === 'GET') {
		if (q.get('n') !== null) return json(detailBody(Number(q.get('n'))));
		return json(listingBody());
	}
	if (!headers[HDR]) return refuse(401, 'unvoiced');

	// A new proposal (no n) is given a fresh number; a comment or revision lands on
	// the proposal it named. The answer is the detail shape the panel's cleanProp
	// reads, carrying the number the caller must fold in.
	const n = q.get('n');
	const num = n !== null ? Number(n) : nextNew++;
	return json(detailBody(num));
}

const j = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(page) {
	for (const [p, body] of FILES) {
		const type = p.endsWith('.html') ? 'text/html' : 'application/javascript';
		await page.route('**/' + p, r => r.fulfill({ status: 200, contentType: type, body }));
	}
	await page.route(u => u.pathname === '/api/improve', improveRoute);
	await page.route('**/api/telemetry',      r => r.fulfill(j({ ok: true })));
	await page.route('**/api/account',        r => r.fulfill(j({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(j({ ok: true, challenge: 'chal-pa', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(j({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(j({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(j({ ok: true, licence: false, currency: 'usd' })));
}

const opens = () => asked.filter(a => a.method === 'POST' && a.query.n === undefined);

// ── The batch: three NEW proposals, each distinct, so "all appear" has three
// things in it and the incrementing forge gives each its own number.

const DRAFTS = [
	{ kind: 'new', title: 'Lost text on reload', body: 'the box empties',       from: ['na'] },
	{ kind: 'new', title: 'Reply box scrolls',   body: 'it jumps on send',       from: ['nb'] },
	{ kind: 'new', title: 'Dark mode contrast',  body: 'the muted grey is thin', from: ['nc'] },
];

const s = await open({ name: 'proposalsappear', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

await signInAs(s, 'proposalsappear');
await page.waitForTimeout(1200);

try {
	// Open the Social panel and read the listing once, so the view starts with the
	// two existing proposals and `read` is already true -- the exact state the
	// meta-bug hid behind: a list that is read, and never re-walked after a send.
	await page.evaluate(() => { window.DaimondPanels.show('social'); });
	await page.waitForTimeout(300);
	await page.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(500);

	const before = await page.evaluate(() => ({
		props: window.DaimondImprove.forge.props().map(p => p.n),
		read:  window.DaimondImprove.listing().shown.length,
	}));
	check('the listing is read first, so the view holds the two existing proposals',
		before.props.length === 2 && before.props.indexOf(5) !== -1 && before.props.indexOf(4) !== -1,
		JSON.stringify(before.props));

	// A voice, so writes are permitted. It lives in the Settings view now, so show
	// that before reaching for the paste control.
	await page.evaluate(() => window.DaimondSocial.show('settings'));
	await page.waitForTimeout(200);
	await page.click('[data-act="improve-voice-open"]');
	await page.waitForTimeout(200);
	await page.fill('#improve-voice-in', SECRET);
	await page.click('[data-act="improve-voice-save"]');
	await page.waitForTimeout(600);
	check('a voice is held, so the queue can send',
		await page.evaluate(() => window.DaimondVoice.has()) === true);
	await page.evaluate(() => window.DaimondSocial.show('proposals'));
	await page.waitForTimeout(200);

	// Queue the three, tick all, and send as one batch.
	await page.evaluate((drafts) => {
		window.DaimondApproveList.reset();
		window.DaimondApproveList.clear();
		window.DaimondApproveList.enqueue(drafts);
		window.DaimondApproveList.selectAll(true);
	}, DRAFTS);
	await page.waitForTimeout(200);
	const ticked = await page.evaluate(() =>
		window.DaimondApproveList.queue().filter(d => d.sel).length);
	check('all three drafts are queued and ticked', ticked === 3, `${ticked}`);

	const beforeOpens = opens().length;
	await page.evaluate(() => window.DaimondApproveList.send());
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondApproveList.busy()); i++) {
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(400);

	check('the batch opened three proposals on the forge', opens().length - beforeOpens === 3,
		`${opens().length - beforeOpens} opens`);

	// ── THE META-BUG CHECK. No load() was called after the send: the send ITSELF
	// must have folded each answer into the store. All three new numbers, and the
	// two that were already there, are present -- five in all, none displaced.
	const after = await page.evaluate(() => window.DaimondImprove.forge.props().map(p => p.n));
	const has = (n) => after.indexOf(n) !== -1;
	check('every proposal the batch opened is now in the store, WITHOUT a re-walk',
		has(100) && has(101) && has(102),
		JSON.stringify(after));
	check('and the two that were already there are still present: nothing was displaced',
		has(5) && has(4) && after.length === 5,
		JSON.stringify(after));

	// ── AND DRAWN. RETIRED with the Social browse-list (option b, 2026-08-31): the
	// Social ▸ Proposals surface is a capture box now and no longer renders
	// `#improve-props .imp-prop` rows -- that list moved to the Improve hub
	// (js/tracker.js). The META-BUG this file exists for is the FOLD, and it is
	// proved above at the STORE level (`forge.props()`), which the `noappear` break
	// still reddens; the hub's DRAWING of proposals (and the folding of a vote or
	// comment answer into a card) is proved in dev/verify_tracker.mjs. A DOM-row
	// check against a list that no longer exists would assert nothing, so it is not
	// masked here -- it is gone, and its meaning is where the rendering now lives.

	// The queue emptied, as a batch of accepted sends should.
	const queue = await page.evaluate(() => window.DaimondApproveList.queue().length);
	check('the queue is empty: every sent draft left it', queue === 0, `${queue}`);

	await shot(s, 'proposalsappear' + (BREAK ? '-' + BREAK : ''));

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
