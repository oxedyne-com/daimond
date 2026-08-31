// verify_triage.mjs — one verb whose object is the whole list of notes.
//
// `www/js/triage.js` reads every kept note and the public proposal list, asks a
// model for a PLAN, and draws each draft in a box that is sent by its own press.
// `dev/IMPROVE_CONTRACT.md` §11 is the contract; the fixture is the owner's own
// eighteen notes, which is why the clustering assertions below name real ones.
//
// ── WHAT IS AT EACH END ──────────────────────────────────────────────
//
// `dev/mock_forge.mjs` on :8443, through a stand-in for the gateway that builds
// the upstream path the way `gateway/src/handlers/improve.rs` does — the same
// arrangement `dev/verify_improve.mjs` uses, and for the same reason: a verifier
// that answered the panel out of its own idea of the forge would agree with
// itself. TWO THINGS ARE REWRITTEN AT THE HOP, both deliberately:
//
//   * the per-asker "you may amend" flag, `mine_to_amend`. The forge answers it
//     now and the mock answers it too, but only for a proposal the asking voice
//     actually wrote — so the hop forces all three phases instead: absent in
//     one, `false` in another, `true` in a third, because ABSENT and FALSE are
//     different facts and the panel must draw them differently. THE SPELLING IS
//     READ OUT OF `js/improve.js`, never written here: a fixture holding its own
//     copy of the name goes on answering the old key after a rename and keeps a
//     broken client green, which is what happened to `amend` and `may_amend`;
//   * the repository name, so a refusal stays reachable.
//
// `dev/mockllm.mjs` on a port of this run's own, with `MOCK_TRIAGE_PLAN` naming
// `dev/fixtures/triage_plan_18.json` — a plan a REAL model produced over the
// real eighteen notes against the real brief. Replayed rather than re-earned:
// what this file proves is the pipeline around the plan, and a fixed answer
// invented here would prove the clustering was whatever it was written to be.
// What IS proved about the brief is that all eighteen notes and the whole
// proposal list actually reached the model, which a plausible plan cannot show.
//
//   1. NOTHING RUNS ON ITS OWN. Opening the panel with eighteen kept notes in
//      the store reaches no model at all. Counted at the network, so a request
//      that was never made and one that was merely hidden look different.
//
//   2. THE COST IS SAID BEFORE THE PRESS, not after. It names the model, it
//      carries a figure, and it is ABOVE the button — a price a person reads
//      once the money is gone is not consent.
//
//   3. ONE PRESS DRAFTS, AND EVERYTHING IT WAS GIVEN ARRIVED. All eighteen note
//      ids are in the request the model was actually sent, and the proposal
//      listing was read first. A brief that quietly dropped the oldest half
//      would still produce a plausible plan.
//
//   4. THE PROPOSALS ARE READ WITH NO VOICE, which is what lets this work before
//      anybody is enrolled.
//
//   5. DRAFTING SENDS NOTHING TO THE FORGE, AND HANDS THE DRAFTS TO THE QUEUE.
//      The whole plan lands in the approve-list (js/approvelist.js) and not one
//      proposal has been opened. Triage generates; it keeps no per-draft box or
//      Send of its own.
//
//   6. (MOVED) ONE PRESS PER DRAFT, WHAT LEAVES IS THE BOX, and the title+body
//      field set are now dev/verify_approvelist.mjs's -- the queue sends, so what
//      leaves is proved where it leaves.
//
//   7. (MOVED) A FOLDED NOTE IS NOT A SENT ONE is also the queue's now: it folds
//      the notes a sent draft was written from. §8 below still holds the cap
//      itself, driven through `DaimondImprove.fold` directly.
//
//   8. AND THE CAP HONOURS THAT. Driven past two hundred with a mix of sent and
//      folded notes: the sent ones go and the folded ones stay.
//
//   9. (MOVED) THE REVISION DRAFT'S DARK/LIT GATE is the queue's, since a revision
//      draft is drawn there now. `cleanProp`'s absent-vs-false (§10) and the
//      panel's own Revise control (§10c) stay here -- both improve.js's.
//
//  10. ABSENT IS NOT FALSE. `cleanProp` does not coerce the flag: a proposal
//      nobody asked about is `askedAmend: false`, and one answered `false` is
//      `askedAmend: true`. Both draw nothing, and they are still different
//      facts — the second can change when a voice is set and the first cannot.
//
//  10b. THE PANEL'S KEY IS THE FORGE'S KEY. Everything above is driven through
//      a hop that INJECTS the flag, so every one of those checks passes just as
//      well against a name nobody answers. That is how two lanes shipped two
//      different wrong spellings, each with a green run behind it. This one
//      asks the forge itself which word arrives.
//
//  10c. `revisions` IS A LIST AND NOT A COUNT, and the Revise button under a
//      proposal goes through the same door the triage draft does. It did not:
//      both halves declared `async function amend` in one closure, the later
//      declaration won outright, and the button threw on its first line while
//      every triage check went on passing.
//
//  11. A REFUSAL IS SAID AND NOTHING IS RETRIED. One request, one sentence
//      beside the draft, and the notes untouched.
//
//  12. AN UNREADABLE ANSWER COSTS NOTHING ELSE. `parse` takes junk without
//      drafting from it, the panel says so, and no note is marked.
//
//  13. EVERY NOTE IS ACCOUNTED FOR — in a draft's `from` or in `left` with a
//      reason. A plan quietly one note short is a report quietly lost.
//
//  14. THE RUN IS BOOKED AGAINST THE ACCOUNT'S OWN LEDGER. Money spent that
//      nothing records is money the spend panel cannot show.
//
// Run it in a world of its own; the mock provider is this file's own, on its
// own port, with its own log:
//
//   eval "$(bash dev/world.sh 7 --env)"
//   node dev/verify_triage.mjs
//   node dev/verify_triage.mjs --break foldsent

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, connectMock } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'triage' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The fixture: the owner's own eighteen notes ──────────────────────

const NOTES = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'triage_notes_18.json'), 'utf8')).notes;
const PLAN  = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'triage_plan_18.json'), 'utf8'));
const PLAN_FILE = path.join(HERE, 'fixtures', 'triage_plan_18.json');

// ── The forge and the model, both this run's own ─────────────────────

const FORGE_PORT = 8443;
const MOCK_PORT  = Number(process.env.TRIAGE_MOCK_PORT || 9143);
const MOCK_URL   = `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`;
const MOCK_LOG   = scratch('triage', 'mockllm-triage.log');

const started = [];

async function reachable(port, p) {
	try { const r = await fetch(`http://127.0.0.1:${port}${p}`); await r.text(); return true; }
	catch (e) { return false; }
}

async function startBoth() {
	if (await reachable(FORGE_PORT, '/a/b/proposals?format=json&limit=1')) {
		console.error(`:${FORGE_PORT} is already held by something. Free it, or the run below `
			+ 'would be driven against somebody else\'s forge.');
		process.exit(2);
	}
	if (await reachable(MOCK_PORT, '/__world')) {
		console.error(`:${MOCK_PORT} is already held by something, so the plan this run replays `
			+ 'would not be the plan it asserts on.');
		process.exit(2);
	}
	started.push(spawn('node', [path.join(HERE, 'mock_forge.mjs'), '--port', String(FORGE_PORT),
		'--count', '6'], { stdio: ['ignore', 'ignore', 'inherit'] }));
	fs.writeFileSync(MOCK_LOG, '');
	started.push(spawn('node', [path.join(HERE, 'mockllm.mjs'), String(MOCK_PORT)], {
		stdio: ['ignore', 'ignore', 'inherit'],
		env: { ...process.env, DAIMOND_MOCK_LOG: MOCK_LOG, MOCK_TRIAGE_PLAN: PLAN_FILE },
	}));
	for (let i = 0; i < 120; i++) {
		if (await reachable(FORGE_PORT, '/a/b/proposals?format=json&limit=1')
			&& await reachable(MOCK_PORT, '/__world')) return;
		await new Promise(r => setTimeout(r, 100));
	}
	console.error('the forge or the mock provider never bound; nothing below would prove anything.');
	process.exit(2);
}

function stopBoth() {
	for (const p of started) { try { p.kill('SIGTERM'); } catch (e) { /* already gone */ } }
	started.length = 0;
}
process.on('exit', stopBoth);
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => { stopBoth(); process.exit(130); });
}

/// Everything the model was actually sent, since the log was cleared.
const modelLog = () => {
	if (!fs.existsSync(MOCK_LOG)) return [];
	return fs.readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean)
		.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

// ── The seams ────────────────────────────────────────────────────────

const SEAM = [
	{ file: 'index.html', want: '<script src="js/triage.js"></script>',
	  why: 'the drafting module is not loaded' },
	{ file: 'js/improve.js', want: 'DaimondTriage.polish', // the per-note polish path the compose box drives
	  why: 'the compose box has no polish path to the drafting machinery' },
	{ file: 'js/improve.js', want: 'window.DaimondTriage) DaimondTriage.draw()',
	  why: 'the panel never draws the row, so a batch surface could not be restored' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the drafting half is not wired up, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must appear
// exactly once, or nothing was changed and the run proves the opposite of what
// it claims.

const BREAKS = {
	// NOTE: the triage-side send breaks -- `foldsent` (a folded note marked sent),
	// `rebuild` (send reads the record not the box) and `amendbright` (a revision
	// drawn sendable whatever the forge said) -- MOVED to dev/verify_approvelist.mjs
	// as `failvanishes`, `staleedit` and `amendbright`, because the send and the
	// revision gate they broke now live in the queue. Triage no longer sends.

	// The cap treats a folded note as delivered, which is the same data loss
	// arriving from the other side: `fold` is right and eviction is wrong.
	evictfolded: [{
		file: 'js/improve.js',
		find: '\t\treturn !!(rec && rec.sent && !(rec.into && rec.into.length));',
		with: '\t\treturn !!(rec && (rec.sent || (rec.into && rec.into.length)));',
	}],
	// The flag is coerced like every other field, so "nobody asked" and
	// "answered no" become the same fact and the control can never light up
	// for a reason anybody can see.
	coerce: [{
		file: 'js/improve.js',
		find: '\t\tif (Object.prototype.hasOwnProperty.call(p, AMEND_FLAG)) {\n'
			+ '\t\t\trec.askedAmend = true;\n'
			+ '\t\t\trec.amendable  = (p[AMEND_FLAG] === true);\n\t\t}',
		with: '\t\trec.askedAmend = true;\n\t\trec.amendable = !!p[AMEND_FLAG];',
	}],
	// (`autorun` and `noconsent` retired: they broke the batch drafting CONTROL,
	// whose UI was removed when note-capture merged into the compose box. The
	// compose box's own model path -- "Polish & post" -- runs only on a press and
	// only for one note, and that is proved in dev/verify_composemerge.mjs.)

	// The panel goes back to a spelling nobody answers. THE BREAK THIS LANE EXISTS
	// FOR: two lanes built this half against a forge that had not published the
	// name, guessed `amend` and `may_amend`, and each had a green run behind it --
	// because every check either of them wrote was driven through a fixture that
	// injected whatever the panel was looking for. Under this break the hop does
	// the same, so every one of those checks stays green and only the one that
	// asks the FORGE what word it sends can tell.
	oldflag: [{
		file: 'js/improve.js',
		find: "\tvar AMEND_FLAG = 'mine_to_amend';",
		with: "\tvar AMEND_FLAG = 'amend';",
	}],
	// `revisions` read the way `comments` beside it is read. The panel would then
	// hold a number where a list belongs, and the count it draws would be NaN.
	revcount: [{
		file: 'js/improve.js',
		find: '\t\tif (typeof p.body === \'string\') rec.detail = true;',
		with: '\t\tif (p.revisions !== undefined) rec.revisions = whole(p.revisions);\n'
			+ '\t\tif (typeof p.body === \'string\') rec.detail = true;',
	}],
	// THE COLLISION, PUT BACK. Both halves of this seam declared `async function
	// amend` in one closure; the later declaration wins outright, so the panel's
	// button called the wire door with no arguments and threw, while every triage
	// check went on passing. The export moves with it, or the module would throw
	// on load and redden the whole run instead of the one check that can see it.
	twoamends: [
		{
			file: 'js/improve.js',
			find: '\tasync function revise(n, parts) {',
			with: '\tasync function amend(n, parts) {',
		},
		{
			file: 'js/improve.js',
			find: '\t\t\tamend:   revise,',
			with: '\t\t\tamend:   amend,',
		},
	],
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

// ── The gateway, stood in for ────────────────────────────────────────

const NAME = /^[A-Za-z0-9_-]+$/;
const HDR  = 'x-daimond-voice';
// allowlist secret
const SECRET = 'mock-voice-ada-0000000000000';
const MOCK_SECRET = 'mock-voice-ada';

/// What the hop does to the forge's answer about the amend flag.
///
/// 'absent'  the forge as it stands today: the key is not there at all
/// 'false'   the forge answering, and saying no
/// 'true'    the forge answering, and saying yes
let amendMode = 'absent';

/// The panel's own name for the flag, taken from the panel.
///
/// NOT A COPY. Two lanes each guessed this name against a forge that did not
/// answer it yet, and a fixture that had held either guess would have gone on
/// feeding the panel a key it recognised while the real forge sent another.
/// Read out of the source, and the run stops if it cannot be found — a fixture
/// that quietly fell back to a literal would be the same fault again.
const AMEND_FLAG = (() => {
	// THE SOURCE AS SERVED, break and all. Taking it off disk instead would make
	// the `oldflag` break invisible here and visible in five checks at once: the
	// hop would inject the right name into a panel looking for the wrong one, and
	// the whole revision section would go red for a reason that is not its own.
	// Reading what is actually served keeps every hop-driven check green under
	// that break and leaves exactly one — the forge's own word — to find it.
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

/// The path `upstream_path()` builds, including the revision route this lane
/// added to the gateway. Written here from that function rather than guessed.
function upstreamPath(u) {
	const q = u.searchParams;
	const n = q.get('n');
	const voting   = q.get('vote')  === '1';
	const amending = q.get('amend') === '1';
	let p = `/${q.get('account')}/${q.get('repo')}/proposals`;
	if (n !== null) p += '/' + n + (voting ? '/vote' : (amending ? '/amend' : ''));
	p += '?format=json';
	if (n === null) {
		for (const k of ['state', 'from', 'limit']) {
			const v = q.get(k);
			if (v !== null) p += `&${k}=${v}`;
		}
	}
	return p;
}

/// Put the flag on, take it off, or set it false — on a listing and on a detail
/// alike, since the panel reads both.
function withFlag(text) {
	let j;
	try { j = JSON.parse(text); } catch (e) { return text; }
	const FLAG = AMEND_FLAG;
	const mark = (o) => {
		if (!o || typeof o !== 'object') return o;
		if (amendMode === 'absent') delete o[FLAG];
		else o[FLAG] = (amendMode === 'true');
		return o;
	};
	if (Array.isArray(j.proposals)) j.proposals.forEach(mark);
	if (typeof j.number === 'number') mark(j);
	return JSON.stringify(j);
}

const wire  = [];			// every request the page made, whatever its address
const asked = [];			// every request that reached /api/improve

async function improveRoute(r) {
	const req = r.request();
	const u   = new URL(req.url());
	const q   = u.searchParams;
	const method = req.method();
	const body = req.postData() || '';
	const headers = req.headers();
	asked.push({ url: req.url(), method, body, query: Object.fromEntries(q), headers });

	const refuse = (status, sentence) => r.fulfill({
		status, contentType: 'application/json',
		body: JSON.stringify({ ok: false, error: sentence }),
	});
	if (!NAME.test(q.get('account') || '')) return refuse(400, 'An account is letters, digits, \'-\' and \'_\'.');
	if (!NAME.test(q.get('repo') || ''))    return refuse(400, 'A repository is letters, digits, \'-\' and \'_\'.');
	if (q.get('vote') === '1' && q.get('amend') === '1') {
		return refuse(400, 'A request is a vote or a revision, not both.');
	}
	const voice = headers[HDR];
	if (method === 'POST' && !voice) {
		return refuse(401, 'Writing on the forge needs your voice, which Daimond sends with the '
			+ 'request and never keeps here.');
	}

	// The revision route, answered here rather than forwarded, because what is
	// proved on this side is that the request went to the revision PATH — the
	// forge's own half of it is `dev/mock_forge.mjs`'s S31. The answer is the
	// shape the deployed forge gives: the record it changed, with `revisions` a
	// LIST and `comments` beside it a COUNT.
	if (q.get('amend') === '1') {
		const f = new URLSearchParams(body);
		return r.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify({ number: Number(q.get('n')),
				title: f.get('title') || '', body: f.get('body') || '',
				state: 'open', author: 'ada', comments: 0, opened: 1, changed: 2,
				discussion: [], votes: { for: 0, against: 0 }, mark: null, build: null,
				revisions: [{ title: 'what it used to say', body: 'and how', when: 1 }] }) });
	}

	const out = { accept: 'application/json' };
	if (voice) out['x-ore-voice'] = (voice === SECRET ? MOCK_SECRET : voice);
	if (method === 'POST') out['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';

	let res, text;
	try {
		res = await fetch(`http://127.0.0.1:${FORGE_PORT}` + upstreamPath(u), {
			method, headers: out, body: method === 'POST' ? body : undefined,
		});
		text = await res.text();
	} catch (e) {
		return r.fulfill({ status: 502, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'The forge could not be reached just now.' }) });
	}
	return r.fulfill({ status: res.status,
		contentType: res.headers.get('content-type') || 'application/json',
		body: withFlag(text) });
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
		let body = '';
		try { body = req.postData() || ''; } catch (e) { body = ''; }
		wire.push({ url: req.url(), method: req.method(), body });
	});
	await page.route(u => u.pathname === '/api/improve', improveRoute);
	await page.route('**/api/telemetry',      r => r.fulfill(json({ ok: true })));
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-trg', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: false, currency: 'usd' })));
}

// ── Driving ──────────────────────────────────────────────────────────

/// Requests the page made to the model, told from everything else by address.
const turns = () => wire.filter(w => w.url.indexOf('/v1/chat/completions') !== -1);
/// Proposals opened, comments said, revisions made — told apart the way the
/// gateway tells them apart: by the query, never by the body.
const opens     = () => asked.filter(a => a.method === 'POST' && a.query.n === undefined);
const says      = () => asked.filter(a => a.method === 'POST' && a.query.n !== undefined
	&& a.query.vote === undefined && a.query.amend === undefined);
const revisions = () => asked.filter(a => a.method === 'POST' && a.query.amend === '1');

const fields = (raw) => {
	const out = {};
	for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
	return out;
};

await startBoth();

const s = await open({ name: 'triage', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'triage');
await page.waitForTimeout(1500);
await connectMock(s, { baseUrl: MOCK_URL, model: 'mock/fast' });
await page.waitForTimeout(600);

try {
	// The owner's own eighteen notes, written into the store the panel reads.
	await page.evaluate((notes) => {
		const key = Object.keys(localStorage).find(k => k.indexOf('daimond-improve') !== -1)
			|| 'daimond-improve';
		localStorage.setItem(key, JSON.stringify({ v: 3, notes }));
		if (window.DaimondImprove) window.DaimondImprove.reset();
	}, NOTES);

	// NO VOICE YET, deliberately. The whole first half below runs unenrolled,
	// because that is the state a new tester is in and because the proposal list
	// is read with no credential at all -- which is what makes drafting possible
	// before anybody has been given anything.
	await page.evaluate(() => { window.DaimondPanels.show('social'); });
	await page.waitForTimeout(400);
	await page.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
	await page.waitForTimeout(800);
	check('no voice is held yet, so the half below is the unenrolled case',
		await page.evaluate(() => !window.DaimondVoice.has()));

	const stored = await page.evaluate(() => window.DaimondImprove.notes().length);
	check('the eighteen notes are in the store the panel reads', stored === 18, `${stored} found`);

	// ── 1. Nothing runs on its own ───────────────────────────────
	//
	// THE BATCH DRAFTING NO LONGER HAS A UI. Note-capture merged into the compose
	// box in the Proposals view, which drafts ONE note at a time -- "Polish & post",
	// proved end to end in dev/verify_composemerge.mjs. What is guarded HERE is the
	// MACHINERY that survived and that the polish path shares: the brief the model is
	// handed, the parse that defends its answer, and the cost said before a run --
	// driven headlessly, so nothing here pays for a turn.
	check('opening the panel reaches no model at all', turns().length === 0,
		`${turns().length} request(s) left the page`);

	// ── 2. The brief carries everything, and drops nothing ───────
	const brief = await page.evaluate(() =>
		window.DaimondTriage.brief(window.DaimondImprove.notes(), []));
	const missing = NOTES.filter(n => brief.user.indexOf(n.id) === -1);
	check('every one of the eighteen note ids is in the brief', missing.length === 0,
		missing.map(n => n.id).join(', '));
	const missingWords = NOTES.filter(n => brief.user.indexOf(n.text.split('\n')[0].slice(0, 40)) === -1);
	check('and the first words of every one of them', missingWords.length === 0,
		missingWords.map(n => n.id).join(', '));
	check('the brief tells the model not to merge two faults that share a panel',
		/DO NOT MERGE TWO FAULTS BECAUSE THEY TOUCH THE SAME PANEL/.test(brief.system));
	check('and that a note holding two faults becomes two proposals',
		/one note holds two faults: TWO proposals/.test(brief.system));

	// ── 3. The cost is honest, measured off that brief ───────────
	const est = await page.evaluate(() =>
		window.DaimondTriage.estimate(window.DaimondImprove.notes(), []));
	check('the estimate is measured off the real brief, not a round number',
		est.inTok === Math.ceil((brief.system.length + brief.user.length) / 3.5) && est.inTok > 1200,
		JSON.stringify({ inTok: est.inTok }));
	check('it names the model a run would use', !!est.model && /mock\/fast/.test(est.model),
		est.model || '(none)');
	check('and says honestly whether anything prices that model',
		est.known === false && est.usd === 0, JSON.stringify(est));

	// ── 4. The parse defends a junk answer, reads a good one ─────
	const parsed = await page.evaluate(() => ({
		fence:   window.DaimondTriage.parse('```json\n{"drafts":[]}\n```'),
		prose:   window.DaimondTriage.parse('Sure: {"drafts":[{"kind":"new","title":"x","body":"y","from":[]}]}'),
		garbage: window.DaimondTriage.parse('not json at all'),
		nokind:  window.DaimondTriage.parse('{"drafts":[{"title":"no kind"}]}'),
	}));
	check('a fenced empty plan parses to no drafts, not a throw',
		parsed.fence && parsed.fence.err === '' && parsed.fence.drafts.length === 0, JSON.stringify(parsed.fence));
	check('a plan wrapped in prose is still read', parsed.prose && parsed.prose.drafts.length === 1,
		JSON.stringify(parsed.prose));
	check('junk parses to an empty plan with a shape error, and costs nothing else',
		parsed.garbage && parsed.garbage.err === 'shape' && parsed.garbage.drafts.length === 0,
		JSON.stringify(parsed.garbage));
	check('a draft with no kind this build knows is dropped, and counted',
		parsed.nokind && parsed.nokind.drafts.length === 0 && parsed.nokind.dropped === 1,
		JSON.stringify(parsed.nokind));

	// ── 5. The fixture plan, HELD without paying: the hand-off ───
	// `hold()` is the same hand-off a real run makes -- parse, then to the queue --
	// so the plan-to-queue coverage stands without a model turn.
	const plan = await page.evaluate((p) => window.DaimondTriage.hold(p), PLAN);

	const PLAN_LEN = PLAN.drafts.length;
	check('the whole fixture plan is read, none dropped', plan && plan.drafts.length === PLAN_LEN,
		plan ? `${plan.drafts.length} of ${PLAN_LEN}` : 'none');

	// ── 6. The listing is read with no voice ─────────────────────
	const reads = asked.filter(a => a.method === 'GET');
	check('the proposal listing is read with no voice at all, so this works unenrolled',
		reads.length > 0 && reads.every(a => !a.headers[HDR]),
		`${reads.length} read(s), ${reads.filter(a => a.headers[HDR]).length} voiced`);

	// ── 7. Drafting sends nothing to the forge ───────────────────
	check('drafting reaches no forge write: nothing has been posted',
		opens().length === 0 && says().length === 0 && revisions().length === 0,
		`${opens().length} opens, ${says().length} comments, ${revisions().length} revisions`);

	// The hand-off: every draft went to the approve-list queue, which is where a
	// draft is reviewed and sent -- dev/verify_approvelist.mjs owns the sending.
	const queued = await page.evaluate(() =>
		window.DaimondApproveList ? window.DaimondApproveList.queue() : []);
	check('every draft the plan named landed in the approve-list queue',
		queued.length === PLAN_LEN, `${queued.length} of ${PLAN_LEN} queued`);
	check('and each is tagged with what sending it would do',
		queued.length === PLAN_LEN && queued.every(d => ['new', 'comment', 'revision'].indexOf(d.kind) !== -1),
		queued.map(d => d.kind).join(','));

	// ── 8. Every note is accounted for ───────────────────────────
	const accounted = new Set();
	(plan ? plan.drafts : []).forEach(d => d.from.forEach(id => accounted.add(id)));
	(plan ? plan.left : []).forEach(l => accounted.add(l.id));
	const lost = NOTES.filter(n => !accounted.has(n.id));
	check('every note is in a draft or said to be left out, by name', lost.length === 0,
		lost.map(n => n.id).join(', '));

	const twice = {};
	(plan ? plan.drafts : []).forEach(d => d.from.forEach(id => { twice[id] = (twice[id] || 0) + 1; }));
	const splitTwo = Object.keys(twice).filter(k => twice[k] > 1).sort();
	check('the two notes holding two faults each became two drafts, and only those two',
		splitTwo.length === 2 && splitTwo.includes('nmtbemooi4ok8') && splitTwo.includes('nmtbes6h4vei5'),
		splitTwo.join(', '));

	await shot(s, 'triage-machinery' + (BREAK ? '-' + BREAK : ''));

	// ── A voice is set, from the Settings view where it now lives, for the panel's
	// own Revise control below.
	await page.evaluate(() => window.DaimondSocial.show('settings'));
	await page.waitForTimeout(200);
	await page.click('[data-act="improve-voice-open"]');
	await page.waitForTimeout(200);
	await page.fill('#improve-voice-in', SECRET);
	await page.click('[data-act="improve-voice-save"]');
	await page.waitForTimeout(800);
	check('a voice can be set from the Settings view',
		await page.evaluate(() => window.DaimondVoice.has()) === true);
	check('setting a voice runs no model turn', turns().length === 0, `${turns().length} model turn(s)`);
	await page.evaluate(() => window.DaimondSocial.show('proposals'));
	await page.waitForTimeout(200);

	// §6 (ONE PRESS PER DRAFT, WHAT LEAVES IS THE BOX) and §7 (A FOLDED NOTE IS NOT
	// A SENT ONE) MOVED to dev/verify_approvelist.mjs, which now owns the sending
	// and the fold. Triage no longer sends, so what-leaves-is-the-box, the
	// title+body field set, and folding-on-send are proved where they now happen.

	// ── 8. And the cap honours it ────────────────────────────────
	const capped = await page.evaluate(() => {
		// Two hundred and forty notes: eighty sent, eighty folded, eighty plain.
		// The cap is two hundred, so forty must go, and every one of them must
		// come out of the eighty the forge already holds.
		const key = Object.keys(localStorage).find(k => k.indexOf('daimond-improve') !== -1)
			|| 'daimond-improve';
		const notes = [];
		for (let i = 0; i < 240; i++) {
			const kind = i % 3;
			notes.push({
				id: 'cap' + i, at: 1000000 + i, text: 'note ' + i,
				sent: kind === 0 ? 2000 + i : 0,
				n:    kind === 0 ? 100 + i : 0,
				into: kind === 1 ? [500 + i] : [],
			});
		}
		localStorage.setItem(key, JSON.stringify({ v: 3, notes }));
		window.DaimondImprove.reset();
		// One write, which is what applies the cap.
		window.DaimondImprove.fold(['cap1'], 999);
		const left = window.DaimondImprove.notes();
		return {
			total:  left.length,
			sent:   left.filter(r => r.sent && !r.into.length).length,
			folded: left.filter(r => r.into.length).length,
			plain:  left.filter(r => !r.sent && !r.into.length).length,
		};
	});
	check('the cap holds at two hundred', capped.total === 200, JSON.stringify(capped));
	check('and every folded note survived it', capped.folded === 80, JSON.stringify(capped));
	check('and every note nobody has delivered survived it', capped.plain === 80, JSON.stringify(capped));
	check('and what went was forty notes the forge already holds in full',
		capped.sent === 40, JSON.stringify(capped));

	// ── 9 and 10. The revision control, and absent against false ─
	//
	// Driven through `cleanProp` itself rather than through a plan, because what
	// is being asserted is the record and not the drawing -- and the drawing is
	// asserted underneath it, from the same record.
	amendMode = 'absent';
	await page.evaluate(() => { window.DaimondImprove.reset(); });
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(700);
	const absent = await page.evaluate(() => {
		const p = window.DaimondImprove.listing().shown[0];
		const r = window.DaimondImprove.proposal(p);
		return { n: p, askedAmend: r.askedAmend, amendable: r.amendable,
			may: window.DaimondImprove.forge.mayAmend(p) };
	});
	check('with no flag in the answer, nobody was asked and nobody may amend',
		absent.askedAmend === false && absent.amendable === false && absent.may === false,
		JSON.stringify(absent));

	amendMode = 'false';
	await page.evaluate(() => { window.DaimondImprove.reset(); });
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(700);
	const said_no = await page.evaluate(() => {
		const p = window.DaimondImprove.listing().shown[0];
		const r = window.DaimondImprove.proposal(p);
		return { askedAmend: r.askedAmend, amendable: r.amendable,
			may: window.DaimondImprove.forge.mayAmend(p) };
	});
	check('a flag answered FALSE is a different fact from no flag at all',
		said_no.askedAmend === true && said_no.amendable === false && said_no.may === false,
		JSON.stringify(said_no));
	check('and the two are told apart, which is what the panel needs to light up later',
		absent.askedAmend !== said_no.askedAmend,
		`absent ${absent.askedAmend} / false ${said_no.askedAmend}`);

	// ── 10b. THE PANEL'S KEY IS THE FORGE'S KEY, AND `revisions` IS A LIST ─
	//
	// Everything above is driven through the hop, which INJECTS the flag — so all
	// of it would pass just as well against a name nobody answers. That is exactly
	// how two lanes shipped `amend` and `may_amend` against a forge that says
	// `mine_to_amend`, each with a green run behind it. This reaches the forge
	// itself, with a voice and without one, and asks whether the word the panel
	// looks for is the word that arrives.
	const forgeSaid = await (async () => {
		const at = `http://127.0.0.1:${FORGE_PORT}/oxedyne/ore/proposals?format=json&limit=1`;
		const bare   = await (await fetch(at)).json();
		const voiced = await (await fetch(at, { headers: { 'x-ore-voice': MOCK_SECRET } })).json();
		const has = (o) => Object.prototype.hasOwnProperty.call(o, AMEND_FLAG);
		return { bare: has(bare.proposals[0]), voiced: has(voiced.proposals[0]),
			value: voiced.proposals[0][AMEND_FLAG] };
	})();
	check(`the forge answers the very key the panel reads, '${AMEND_FLAG}', and only to a voice`,
		forgeSaid.voiced === true && forgeSaid.bare === false
		&& (forgeSaid.value === true || forgeSaid.value === false),
		JSON.stringify(forgeSaid));

	// And `revisions` survives `cleanProp` as the LIST it is. `comments` beside it
	// is a COUNT on both routes, which is the analogy that turns a list into a
	// type error; and a listing record carries no `revisions` at all, so `null`
	// there is the honest answer and `[]` would be a claim nobody made.
	const revs = await page.evaluate(async () => {
		const n = window.DaimondImprove.listing().shown[0];
		const listed = window.DaimondImprove.proposal(n);
		await window.DaimondImprove.one(n);
		const whole = window.DaimondImprove.proposal(n);
		return { listed: listed.revisions, whole: whole.revisions, comments: whole.comments };
	});
	check('a listing record carries no revisions and says so with null, never with an empty list',
		revs.listed === null, JSON.stringify(revs.listed));
	check('and the whole proposal carries the LIST the forge sent, beside comments as a COUNT',
		Array.isArray(revs.whole) && revs.whole.length === 0
		&& typeof revs.comments === 'number', JSON.stringify(revs));

	// ── 10c. THE PANEL'S OWN REVISE CONTROL, PRESSED ─────────────
	//
	// Everything about revising up to here goes through the triage plan, which
	// reaches the forge by a different function from the one the button under a
	// proposal reaches it by. THE TWO WERE THE SAME NAME. Two lanes each declared
	// `async function amend` in one closure a fortnight apart, and a function
	// declaration does not collide — the later one silently replaced the earlier,
	// so the triage half worked, its checks passed, and the button threw on its
	// first line. Nothing either lane wrote could see it, because each half was
	// right. This presses the button.
	amendMode = 'true';
	await page.evaluate(() => { window.DaimondImprove.reset(); });
	// THE PROPOSALS VIEW, because this half is pressed rather than called: every
	// check above reads the record and this one reads the screen, and a row drawn
	// into a hidden view is a row nothing can click.
	await page.evaluate(() => window.DaimondImprove.show('proposals'));
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(700);
	// An OPEN one: `drawAmendControl` asks the forge who the author is and asks
	// this side whether the proposal is still taking words.
	const openN = await page.evaluate(() => {
		const shown = window.DaimondImprove.listing().shown;
		for (const n of shown) {
			const r = window.DaimondImprove.proposal(n);
			if (r && r.state === 'open') return n;
		}
		return 0;
	});
	const at = (sel) => `.imp-prop[data-prop="${openN}"] ${sel}`;
	await page.locator(at('[data-act="improve-open"]')).click();
	await page.locator(at('[data-act="improve-amend-open"]')).click();
	await page.fill(at('.imp-amend-title'), 'The words it says now');
	await page.fill(at('.imp-amend-body'), 'And what they were changed for.');
	const beforePress = revisions().length;
	await page.locator(at('[data-act="improve-amend-save"]')).click();
	await page.waitForTimeout(900);
	const pressed = await page.evaluate((n) => {
		const r = window.DaimondImprove.proposal(n);
		const f = document.querySelector('.imp-prop[data-prop="' + n + '"] .imp-prop-facts');
		return { title: r && r.title, revisions: r && r.revisions,
			facts: f ? (f.textContent || '') : '' };
	}, openN);
	check('pressing Revise under a proposal sends exactly one revision, to the revision route',
		openN > 0 && revisions().length === beforePress + 1
		&& revisions()[revisions().length - 1].query.amend === '1',
		`#${openN}, ${revisions().length - beforePress} request(s)`);
	check('and the record it answered is taken back, so the row shows the new words at once',
		pressed.title === 'The words it says now', JSON.stringify(pressed.title));
	check('with the revisions it carried kept as a LIST and said in words a person reads',
		Array.isArray(pressed.revisions) && pressed.revisions.length === 1
		&& /revised once/.test(pressed.facts),
		JSON.stringify(pressed).slice(0, 240));
	await page.evaluate(() => window.DaimondImprove.show('notes'));

	// THE REVISION DRAFT'S DARK/LIT GATE AND ITS SEND MOVED to
	// dev/verify_approvelist.mjs: a revision draft is now drawn in the QUEUE, and
	// whether it offers a tick is gated there on the forge's per-asker
	// `mine_to_amend` flag (dark when the forge is silent, lit when it grants,
	// never a path to another author's proposal). What stays HERE is `cleanProp`'s
	// absent-vs-false above, and the panel's OWN Revise control below §10c -- both
	// improve.js's, not triage's.

	// ── 11. A refusal is said and nothing is retried ─────────────
	// ── 12. An unreadable answer costs nothing else ──────────────
	const junk = await page.evaluate(() => [
		window.DaimondTriage.parse('I am sorry, I cannot do that.'),
		window.DaimondTriage.parse('```json\n{"drafts":[{"kind":"nope"}],"left":[]}\n```'),
		window.DaimondTriage.parse('{"drafts":[{"kind":"comment","body":"x","from":[]}],"left":[]}'),
	]);
	check('prose in place of a plan is read as no plan at all',
		junk[0].drafts.length === 0 && junk[0].err === 'shape', JSON.stringify(junk[0]));
	check('a kind this build does not know is dropped and counted, never guessed',
		junk[1].drafts.length === 0 && junk[1].dropped === 1, JSON.stringify(junk[1]));
	check('a comment with no proposal number is dropped: it has nowhere to land',
		junk[2].drafts.length === 0 && junk[2].dropped === 1, JSON.stringify(junk[2]));

	// ── 14. A REAL polish run: it reaches the model, and is booked ─
	//
	// The one paid turn in this file. `DaimondTriage.polish` is what the compose
	// box's "Polish & post" runs; here it is run for real against the mock model,
	// so meter() and the account ledger are exercised and the note's own words are
	// shown to have reached the model. (dev/verify_composemerge.mjs stubs the draft
	// to prove the WIRING that posts it; this proves the run itself.)
	await page.evaluate(() => window.DaimondTriage.polish('The compose box loses focus after a post.'));
	await page.waitForTimeout(700);
	const polishSent = modelLog();
	const polishMsg = polishSent.length
		? (polishSent[polishSent.length - 1].messages || []).filter(m => m.role === 'user')
			.map(m => String(m.content || '')).join('\n')
		: '';
	check('a Polish run reaches the model, carrying the note\'s own words',
		/compose box loses focus/.test(polishMsg), polishMsg.slice(0, 120));
	const booked = await page.evaluate(() => {
		try {
			if (!window.DaimondLedger) return null;
			var per = window.DaimondLedger.perModel('month') || [];
			return per.map(function (r) { return { model: r.model || r.m || '', tokens: r.tokens || 0 }; });
		} catch (e) { return null; }
	});
	check('and it is booked to the account\'s own ledger, under the model that ran it',
		Array.isArray(booked) && booked.some(r => /mock\/fast/.test(r.model) && r.tokens > 0),
		JSON.stringify(booked));

	const errs = errors(s).filter(e => !/Failed to load resource/.test(e));
	check('nothing above was reached by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	await shot(s, 'triage' + (BREAK ? '-' + BREAK : ''));
} finally {
	await s.close();
	stopBoth();
}

console.log(`\nmodel turns: ${turns().length}   forge requests: ${asked.length}`
	+ `   opens: ${opens().length}   revisions: ${revisions().length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
