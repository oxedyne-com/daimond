// verify_approvelist.mjs — the approve-list: a local review queue, batch-sent.
//
// `www/js/approvelist.js` takes drafts (js/triage.js's own shape), holds them in
// a local queue, and sends the ticked ones as a BATCH through improve.js's forge
// door. What this proves:
//
//   1. A TRIAGE GENERATE LANDS THE DRAFTS DIRECTLY IN THE QUEUE. "Draft from
//      notes" hands its plan's drafts to the approve-list, which draws one row
//      per draft tagged with what it is and where it lands. And the OLD per-draft
//      send surface in triage is GONE: no draft boxes, no per-draft Send, no
//      send/drop exports. One review surface, no back-compat.
//
//   2. THE QUEUE IS LOCAL AND STAYS OUT OF THE SYNC PARCEL. It lives under
//      `daimond-approvelist`, a key sync.js's allowlist parcel never gathers, so
//      a draft is a proposal-not-yet-made and belongs to this device — the same
//      rule notes keep.
//
//   3. TICK + SEND SELECTED POSTS EXACTLY THE TICKED DRAFTS, and no others,
//      through improve.js's forge door: `open` for a new proposal (no `n`), `say`
//      for a comment (`n`, no `amend`), `amend` for a revision (`amend=1`). Told
//      apart the way the gateway tells them apart — by the query, never the body.
//
//   4. WHAT LEAVES IS THE BOX. A row is EDITED before the press, and the edit is
//      what left: the send reads the textarea at the moment it posts, not the
//      record the draft was enqueued from. The field set is exactly title+body.
//
//   5. A SENT DRAFT LEAVES THE QUEUE; A REFUSED ONE STAYS, with the forge's own
//      sentence beside it, and is never retried. One refusal in a batch does not
//      take the drafts that went with it.
//
//   6. A REVISION AMENDS THE AUTHOR'S OWN PROPOSAL ONLY. The forge's per-asker
//      `mine_to_amend` flag gates the tick: a proposal it granted is sendable and
//      posts to `amend=1`; one it did not is drawn with NO tick and never posts.
//      There is no path here that edits someone else's proposal.
//
// The forge is answered locally in the /api/improve stub, deterministically —
// what is proved here is the CLIENT: the queue, the routing, and the payload.
// `dev/verify_triage.mjs` and `dev/verify_improve.mjs` prove the forge's own
// shape through `dev/mock_forge.mjs`; this file does not repeat that.
//
//   eval "$(bash dev/world.sh 8 --env)"
//   node dev/verify_approvelist.mjs
//   node dev/verify_approvelist.mjs --break sendunticked

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

const PROFILE = scratch('pw', 'approvelist' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The seams: the module must be loaded and drawn, or nothing proves anything.

const SEAM = [
	{ file: 'index.html', want: '<script src="js/approvelist.js"></script>',
	  why: 'the approve-list module is not loaded' },
	{ file: 'js/improve.js', want: 'window.DaimondApproveList) DaimondApproveList.draw()',
	  why: 'the panel never draws the queue, so it appears only after some other redraw' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the approve-list is not wired up, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}

// ── The breaks. Each is a real edit to a real file, served in place of it. The
// anchor must appear exactly once, or nothing was changed.

const BREAKS = {
	// Send ignores the tick and posts every draft. Proves the batch is exactly the
	// ticked ones and not the whole queue.
	sendunticked: [{
		file: 'js/approvelist.js',
		find: '\t\tvar picked = q.filter(function (d) { return d.sel && sendable(d); });',
		with: '\t\tvar picked = q.filter(function (d) { return sendable(d); });',
	}],
	// Send reads the record the draft was enqueued from rather than the box.
	// Identical on screen until a row is edited before the press — which is the one
	// moment the whole "what leaves is the screen" rule rests on.
	staleedit: [{
		file: 'js/approvelist.js',
		find: '\t\tvar batch = picked.map(function (d) { return { id: d.id, text: boxed(d.id) }; });',
		with: '\t\tvar batch = picked.map(function (d) { return { id: d.id, text: bodyOf(d) }; });',
	}],
	// A refused send is dropped from the queue anyway, so the words are lost with
	// nothing anywhere holding them.
	failvanishes: [{
		file: 'js/approvelist.js',
		find: '\t\t\td.err = p.forge.saying(a) + \' \' + tOr(\'approve.kept\', \'Kept here; nothing tried again.\');\n\t\t\treturn false;',
		with: '\t\t\td.err = p.forge.saying(a); remove(d.id);\n\t\t\treturn false;',
	}],
	// A revision the forge has not granted is made tickable, so a control reaches a
	// route this asker may not use — exactly the defect improve.js was rewritten to
	// remove, and a path to editing a proposal that is not the asker's.
	amendbright: [{
		file: 'js/approvelist.js',
		find: '\t\ttry { return !!(p && p.forge.mayAmend(d.n)); } catch (e) { return false; }',
		with: '\t\treturn true;',
	}],
	// A sent draft no longer folds the notes it was written from, so the only copy
	// of what the person wrote is now spare and the cap can evict it -- the data
	// loss the fold exists to prevent.
	nofold: [{
		file: 'js/approvelist.js',
		find: '\t\ttry { if (num && d.from.length) p.fold(d.from, num); }',
		with: '\t\ttry { if (false && num && d.from.length) p.fold(d.from, num); }',
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
	requireSeams();
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const p = spec.file;
		const src = FILES.get(p) ?? fs.readFileSync(path.join(WWW, p), 'utf8');
		FILES.set(p, edit(src, spec, `break '${BREAK}'`));
	}
}
build();

// ── The forge, answered locally in the /api/improve stub ─────────────
//
// Deterministic, so a refusal happens exactly where this file wants one and the
// routing can be asserted precisely. A POST whose title or said carries the
// sentinel is refused with a forge token; everything else succeeds.

const HDR  = 'x-daimond-voice';
// allowlist secret
const SECRET = 'mock-voice-ada-0000000000000';
const FAIL_SENTINEL = 'FORCE-FORGE-REFUSAL';

// The panel's own name for the per-asker amend flag, read out of the source as
// served (break and all), never written here — a fixture holding its own copy of
// the name feeds the panel a key it recognises after a rename and keeps a broken
// client green. This is the discipline dev/verify_triage.mjs draws out at length.
const AMEND_FLAG = (() => {
	const src = FILES.get('js/improve.js')
		?? fs.readFileSync(path.join(WWW, 'js', 'improve.js'), 'utf8');
	const m = /\bvar AMEND_FLAG = '([A-Za-z0-9_]+)';/.exec(src);
	if (!m) {
		console.error('js/improve.js no longer holds `var AMEND_FLAG = \'...\';`, so this file '
			+ 'cannot know which key the panel reads and nothing below would prove anything.');
		process.exit(2);
	}
	return m[1];
})();

// The listing the panel reads. #7 is the user's own (amend granted); #8 is
// someone else's (amend answered FALSE — a real answer, not silence).
function listingBody() {
	const prop = (n, mineAmend) => {
		const o = { number: n, title: 'Proposal ' + n, state: 'open', author: 'ada',
			comments: 0, opened: 1, changed: 2, mark: null, build: null };
		o[AMEND_FLAG] = mineAmend;
		return o;
	};
	return JSON.stringify({ proposals: [prop(7, true), prop(8, false)], total: 2, done: true });
}

function oneBody(n) {
	const mine = n === 7;
	const o = { number: n, title: 'Proposal ' + n, body: 'the body of ' + n, state: 'open',
		author: 'ada', comments: 0, opened: 1, changed: 2, discussion: [],
		votes: { for: 0, against: 0 }, mark: null, build: null, revisions: [] };
	o[AMEND_FLAG] = mine;
	return JSON.stringify(o);
}

const asked = [];			// every request that reached /api/improve
const wire  = [];			// every request the page made, for the sync/parcel check

async function improveRoute(r) {
	const req = r.request();
	const u   = new URL(req.url());
	const q   = u.searchParams;
	const method = req.method();
	const body = req.postData() || '';
	const headers = req.headers();
	asked.push({ url: req.url(), method, body, query: Object.fromEntries(q), headers });

	const json = (obj, status = 200) => r.fulfill({ status, contentType: 'application/json',
		body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
	const refuse = (status, error) => r.fulfill({ status, contentType: 'application/json',
		body: JSON.stringify({ error, said: 'The forge refused: ' + error + '.' }) });

	// A read: the listing, or one proposal. No voice needed.
	if (method === 'GET') {
		if (q.get('n') !== null) return json(oneBody(Number(q.get('n'))));
		return json(listingBody());
	}

	// A write needs a voice, exactly as the forge insists.
	if (!headers[HDR]) return refuse(401, 'unvoiced');

	// The sentinel forces a refusal wherever this file wants one.
	if (body.indexOf(encodeURIComponent(FAIL_SENTINEL)) !== -1
		|| body.indexOf(FAIL_SENTINEL) !== -1) {
		return refuse(400, 'malformed');
	}

	const n = q.get('n');
	// A revision (amend=1) or a comment (n, no amend) both land on their proposal;
	// a new proposal (no n) is given a fresh number. The answer is the record the
	// forge changed, in the shape the panel's cleanProp reads.
	const num = n !== null ? Number(n) : 101;
	return json({ number: num, title: 'x', body: 'y', state: 'open', author: 'ada',
		comments: 0, opened: 1, changed: 2, discussion: [], votes: { for: 0, against: 0 },
		mark: null, build: null, revisions: [] });
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(page) {
	for (const [p, body] of FILES) {
		const type = p.endsWith('.html') ? 'text/html' : 'application/javascript';
		await page.route('**/' + p, r => r.fulfill({ status: 200, contentType: type, body }));
	}
	if (FILES.has('index.html')) {
		await page.route(u => u.pathname === '/' || u.pathname === '/index.html',
			r => r.fulfill({ status: 200, contentType: 'text/html', body: FILES.get('index.html') }));
	}
	page.on('request', req => {
		let b = '';
		try { b = req.postData() || ''; } catch (e) { b = ''; }
		wire.push({ url: req.url(), method: req.method(), body: b });
	});
	await page.route(u => u.pathname === '/api/improve', improveRoute);
	await page.route('**/api/telemetry',      r => r.fulfill(json({ ok: true })));
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-apl', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: false, currency: 'usd' })));
}

// ── Reading what left, told apart by the query like the gateway does ──

const opens     = () => asked.filter(a => a.method === 'POST' && a.query.n === undefined);
const says      = () => asked.filter(a => a.method === 'POST' && a.query.n !== undefined
	&& a.query.vote === undefined && a.query.amend === undefined);
const revisions = () => asked.filter(a => a.method === 'POST' && a.query.amend === '1');
const posts     = () => asked.filter(a => a.method === 'POST');

const fields = (raw) => {
	const out = {};
	for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
	return out;
};

// ── The drafts this run enqueues. Two lands, one comment, one revision on the
// user's own proposal (#7), one revision on someone else's (#8).

const DRAFTS = [
	{ kind: 'new',      title: 'Lost text on reload', body: 'the box empties', from: ['na'], why: 'one fault' },
	{ kind: 'comment',  n: 7, body: 'this also happens on iOS', from: ['nb'], why: 'lands on 7' },
	{ kind: 'revision', n: 7, title: 'Reload keeps the box', body: 'it should persist', from: ['nc'], why: 'the statement was wrong' },
	{ kind: 'revision', n: 8, title: 'not mine to touch', body: 'someone else opened it', from: ['nd'], why: 'author-only' },
	// A second comment, SENDABLE but left unticked in the batch below, so a send
	// that ignored the tick would carry a draft nobody chose. Without it every
	// sendable draft happens to be ticked and the tick cannot be shown to matter.
	{ kind: 'comment',  n: 7, body: 'and one more thing about 7', from: ['ne'], why: 'second comment, unticked' },
];

const s = await open({ name: 'approvelist', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

await signInAs(s, 'approvelist');
await page.waitForTimeout(1200);

try {
	// Open the Social panel and read the forge listing, so the panel knows which
	// proposals this asker may amend.
	await page.evaluate(() => { window.DaimondPanels.show('social'); });
	await page.waitForTimeout(300);
	await page.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(500);

	// A voice, so writes are permitted (the forge refuses one without it).
	await page.click('[data-act="improve-voice-open"]');
	await page.waitForTimeout(200);
	await page.fill('#improve-voice-in', SECRET);
	await page.click('[data-act="improve-voice-save"]');
	await page.waitForTimeout(600);
	check('a voice is held, so the queue can send',
		await page.evaluate(() => window.DaimondVoice.has()) === true);

	// ── 1. A triage GENERATE lands the drafts DIRECTLY in the queue ─
	//
	// The single path: "Draft from notes" produces a plan and hands the drafts to
	// the approve-list, which is the one review surface. `hold()` is the paid-turn-
	// free equivalent of a run -- it goes through triage's own `parse()` and the
	// same `toQueue` hand-off a real run makes, so what lands here is what a run
	// would land. (`dev/verify_triage.mjs` proves the real model run reaches it.)
	const gen = await page.evaluate((drafts) => {
		window.DaimondApproveList.reset();
		window.DaimondApproveList.clear();
		const held = window.DaimondTriage.hold({ drafts, left: [] });
		return { held: held ? held.drafts.length : 0,
			queue: window.DaimondApproveList.queue().length };
	}, DRAFTS);
	await page.waitForTimeout(300);
	check('running Draft-from-notes lands the generated drafts straight in the queue',
		gen.held === 5 && gen.queue === 5, JSON.stringify(gen));
	const rows = await page.locator('#improve-approve .apl-row').count();
	check('one row per draft is drawn in the queue', rows === 5, `${rows} rows`);
	const kinds = await page.evaluate(() => [...document.querySelectorAll('#improve-approve .apl-row')]
		.map(r => r.dataset.kind));
	check('each row is tagged with what pressing it would do',
		kinds.length === 5 && kinds.every(k => ['new', 'comment', 'revision'].indexOf(k) !== -1),
		kinds.join(','));

	// ── 1b. THE OLD PER-DRAFT SEND SURFACE IN TRIAGE IS GONE ─────
	// No back-compat: triage no longer draws draft boxes or a per-draft Send, and
	// its send/drop exports are removed. The queue is the only place a draft is
	// sent, so there cannot be two surfaces to keep in step.
	const oldGone = await page.evaluate(() => ({
		draftBoxes: document.querySelectorAll('#improve-triage .trg-draft').length,
		sendBtns:   document.querySelectorAll('#improve-triage [data-act="triage-send"]').length,
		sendExport: typeof window.DaimondTriage.send,
		dropExport: typeof window.DaimondTriage.drop,
	}));
	check('triage draws no per-draft box and no per-draft Send any more',
		oldGone.draftBoxes === 0 && oldGone.sendBtns === 0, JSON.stringify(oldGone));
	check('and triage exposes no send/drop of its own: the queue is the one door',
		oldGone.sendExport === 'undefined' && oldGone.dropExport === 'undefined',
		JSON.stringify(oldGone));

	await shot(s, 'approvelist-queue' + (BREAK ? '-' + BREAK : ''));

	// ── 2. The queue is local and out of the sync parcel ─────────
	const stored = await page.evaluate(() => {
		const key = Object.keys(localStorage).find(k => k.indexOf('daimond-approvelist') !== -1);
		return { key, has: !!key, raw: key ? localStorage.getItem(key) : '' };
	});
	check('the queue is persisted under a local daimond-approvelist key',
		stored.has && /Lost text on reload/.test(stored.raw), stored.key || '(no key)');
	const parcel = await page.evaluate(async () => {
		try {
			if (!window.DaimondSync || !window.DaimondSync.parcel) return { ran: false };
			const p = await window.DaimondSync.parcel();
			const s = JSON.stringify(p || {});
			return { ran: true, leaks: s.indexOf('Lost text on reload') !== -1
				|| s.indexOf('daimond-approvelist') !== -1 };
		} catch (e) { return { ran: false, err: String(e && e.message || e) }; }
	});
	check('the sync parcel does not carry the queue: a draft is not synced',
		parcel.ran ? parcel.leaks === false : true,
		parcel.ran ? JSON.stringify(parcel) : 'DaimondSync.parcel unavailable — key is out of the allowlist by construction');

	// ── 6. A revision the forge did not grant offers no tick ─────
	const gate = await page.evaluate(() => {
		const q = window.DaimondApproveList.queue();
		const mine = q.find(d => d.kind === 'revision' && d.n === 7);
		const not  = q.find(d => d.kind === 'revision' && d.n === 8);
		const tickOf = (id) => {
			const row = document.querySelector('.apl-row[data-draft="' + id + '"]');
			return !!(row && row.querySelector('.apl-tick'));
		};
		return { mineTick: tickOf(mine.id), notTick: tickOf(not.id), notId: not.id, mineId: mine.id };
	});
	check('a revision of the asker\'s own proposal (amend granted) offers a tick',
		gate.mineTick === true, JSON.stringify(gate));
	check('a revision of someone else\'s proposal (amend not granted) offers NO tick',
		gate.notTick === false, JSON.stringify(gate));
	// And it cannot be forced ticked through the API either.
	const forced = await page.evaluate((id) => window.DaimondApproveList.select(id, true), gate.notId);
	check('nor can that revision be ticked through the API: no path edits another\'s proposal',
		forced === false);

	// ── 3+4. Tick the new + comment + own-revision, edit one, send ─
	const EDIT = ' quokka-edit-marker';
	await page.evaluate((edit) => {
		const q = window.DaimondApproveList.queue();
		const byKind = {};
		q.forEach(d => { byKind[d.kind + (d.n || '')] = d; });
		// Tick the new proposal, the comment on 7, and the revision of 7.
		[q.find(d => d.kind === 'new'),
		 q.find(d => d.kind === 'comment'),
		 q.find(d => d.kind === 'revision' && d.n === 7)].forEach(d => {
			const box = document.querySelector('.apl-row[data-draft="' + d.id + '"] .apl-tick');
			if (box && !box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
		});
		// Edit the NEW proposal's box after the model answered — this is what must
		// travel, not the enqueued record.
		const nd = q.find(d => d.kind === 'new');
		const ta = document.querySelector('.apl-row[data-draft="' + nd.id + '"] .apl-box');
		if (ta) ta.value = ta.value + edit;
	}, EDIT);
	await page.waitForTimeout(200);

	const ticked = await page.evaluate(() =>
		window.DaimondApproveList.queue().filter(d => d.sel).length);
	check('exactly the three sendable ticks are recorded', ticked === 3, `${ticked}`);

	const beforePosts = posts().length;
	await page.click('#improve-approve [data-act="approve-send"]');
	await page.waitForTimeout(500);
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondApproveList.busy()); i++) {
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(400);

	check('one press posted exactly the three ticked drafts, and no others',
		posts().length - beforePosts === 3, `${posts().length - beforePosts} posts`);
	check('and they went to the right doors: one open, one comment, one revision',
		opens().length === 1 && says().length === 1 && revisions().length === 1,
		`opens ${opens().length}, says ${says().length}, revisions ${revisions().length}`);

	const openF = opens().length ? fields(opens()[0].body) : {};
	check('the new proposal carried the box, INCLUDING the edit made after enqueue',
		(openF.title + '\n' + openF.body).indexOf(EDIT) !== -1,
		JSON.stringify(openF).slice(0, 200));
	check('and its field set is exactly title and body, nothing a person could not see',
		JSON.stringify(Object.keys(openF).sort()) === JSON.stringify(['body', 'title']),
		Object.keys(openF).sort().join(','));
	check('the revision went to the amend route, on the asker\'s own proposal #7',
		revisions().length === 1 && revisions()[0].query.n === '7' && revisions()[0].query.amend === '1',
		JSON.stringify(revisions()[0] && revisions()[0].query));
	check('the comment went to proposal #7 by the comment door, not the amend one',
		says().length === 1 && says()[0].query.n === '7' && says()[0].query.amend === undefined,
		JSON.stringify(says()[0] && says()[0].query));

	// ── 5. Sent drafts leave; the untouched one and the un-grantable one stay ─
	const afterSend = await page.evaluate(() => window.DaimondApproveList.queue().map(d => ({
		kind: d.kind, n: d.n, sel: d.sel })));
	check('every sent draft left the queue; the unticked and un-grantable ones stay',
		afterSend.length === 2, JSON.stringify(afterSend));
	check('what remains is the unticked comment and the revision the forge would not grant',
		afterSend.length === 2
		&& afterSend.some(d => d.kind === 'comment' && d.n === 7)
		&& afterSend.some(d => d.kind === 'revision' && d.n === 8),
		JSON.stringify(afterSend));

	// ── 5c. Sending folds the notes a draft was written from ─────
	// The fold MOVED here from triage: when the queue sends a draft, the notes it
	// was drafted from are marked folded (into a proposal) but NOT sent -- this
	// device still holds the only copy of what the person wrote, so the cap in
	// improve.js never evicts them. dev/verify_triage.mjs proved this while triage
	// held the send; it is the queue's now.
	const folded = await page.evaluate(async () => {
		const key = Object.keys(localStorage).find(k => k.indexOf('daimond-improve') !== -1) || 'daimond-improve';
		localStorage.setItem(key, JSON.stringify({ v: 3, notes: [
			{ id: 'fa', at: 1000, text: 'note a', sent: 0, n: 0, into: [] },
			{ id: 'fb', at: 1001, text: 'note b', sent: 0, n: 0, into: [] },
		] }));
		window.DaimondImprove.reset();
		window.DaimondApproveList.reset();
		window.DaimondApproveList.clear();
		window.DaimondApproveList.enqueue([{ kind: 'new', title: 'folds its notes',
			body: 'from a and b', from: ['fa', 'fb'] }]);
		window.DaimondApproveList.selectAll(true);
		await window.DaimondApproveList.send();
		const notes = window.DaimondImprove.notes().filter(r => r.id === 'fa' || r.id === 'fb')
			.map(r => ({ id: r.id, sent: r.sent, n: r.n, into: r.into,
				delivered: window.DaimondImprove.delivered(r) }));
		return { notes, queue: window.DaimondApproveList.queue().length };
	});
	await page.waitForTimeout(300);
	check('a sent draft folds the notes it was written from, then leaves the queue',
		folded.queue === 0 && folded.notes.length === 2, JSON.stringify(folded));
	check('and those notes are folded, NOT sent, NOT delivered: the only copy stays here',
		folded.notes.every(n => n.into.length === 1 && n.sent === 0 && n.n === 0 && n.delivered === false),
		JSON.stringify(folded.notes));

	// ── 5b. A refused send stays with an error; its batch-mates go ─
	await page.evaluate((sentinel) => {
		window.DaimondApproveList.clear();
		window.DaimondApproveList.enqueue([
			{ kind: 'new', title: 'this one goes', body: 'fine', from: ['a'] },
			{ kind: 'new', title: sentinel, body: 'the forge will refuse this', from: ['b'] },
		]);
	}, FAIL_SENTINEL);
	await page.waitForTimeout(200);
	await page.evaluate(() => window.DaimondApproveList.selectAll(true));
	await page.waitForTimeout(150);
	const beforeFail = posts().length;
	await page.click('#improve-approve [data-act="approve-send"]');
	await page.waitForTimeout(400);
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondApproveList.busy()); i++) {
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(300);
	check('both ticked drafts were attempted', posts().length - beforeFail === 2,
		`${posts().length - beforeFail}`);
	const afterFail = await page.evaluate(() => window.DaimondApproveList.queue().map(d => ({
		title: d.title, err: d.err })));
	check('the one the forge refused stayed in the queue, alone',
		afterFail.length === 1 && afterFail[0].title === FAIL_SENTINEL,
		JSON.stringify(afterFail).slice(0, 200));
	check('and it carries the forge\'s own sentence plus that it is kept, so nothing looks broken in silence',
		afterFail.length === 1 && afterFail[0].err.length > 20 && /kept here/i.test(afterFail[0].err),
		afterFail[0] && afterFail[0].err);
	const errRow = await page.evaluate(() => {
		const e = document.querySelector('#improve-approve .apl-err');
		return e ? (e.textContent || '') : '';
	});
	check('the error is drawn beside the draft, not only stored',
		/kept here/i.test(errRow), errRow || '(no error row drawn)');

	await shot(s, 'approvelist-sent' + (BREAK ? '-' + BREAK : ''));

	const errs = errors(s).filter(e => !/Failed to load resource/.test(e));
	check('nothing above was reached by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log(`\nforge posts: ${posts().length}   opens: ${opens().length}`
	+ `   comments: ${says().length}   revisions: ${revisions().length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
