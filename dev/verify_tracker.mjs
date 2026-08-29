// verify_tracker.mjs — the Tracker view reads Daimond's proposals, and the owner settles them.
//
// The Tracker (www/js/tracker.js) is a read-first window onto Daimond's own development, which
// lives as PROPOSALS on the Oregami forge repository `oxedyne/daimond`. It reaches the forge the
// way improve.js does: through the same-origin Daimond gateway route `/api/improve`, which
// forwards to the forge and translates `x-daimond-voice` into the forge's `x-ore-voice`. This
// drives the view in a real browser; the gateway is STOOD IN FOR here (as verify_improve.mjs
// stands it in), building the upstream forge path and translating the voice header, and the forge
// behind it is dev/mock_forge.mjs.
//
// WHAT IS PROVED, each a clause of what the view is for:
//   1. THE LISTING DRAWS. A row per proposal: its state word, its number, its title, its comment
//      count and its vote TALLY. Newest first.
//   2. VOTES ARE DARK. The tally is two counts and the DOM carries no voter identity anywhere —
//      not even when the forge is made to publish one (`--break` on the mock is not needed; the
//      view ignores a `voters` field by construction, and `leakvoters` proves the check bites).
//   3. A PROPOSAL OPENS IN FULL. Its statement, its revisions, its comments, its state.
//   4. READING IS UNVOICED. Every read the view makes carries no x-ore-voice header at all.
//   5. WITHOUT AN ADMIN VOICE THERE IS NO SETTLE. The view is read-only for everybody but the
//      owner, so no settle control is drawn.
//   6. THE OWNER SETTLES. With an admin voice, Accept posts `state=accepted` under x-ore-voice
//      and the row moves to Being done; a settled proposal offers Reopen, which posts `state=open`.
//   7. A REFUSAL IS SAID. A repository that is not available draws the sentence, not a blank.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a damaged tracker.js
// and the run is expected to FAIL the one check it targets:
//   node dev/verify_tracker.mjs --break leakvoters     # 2  a voter name reaches the DOM
//   node dev/verify_tracker.mjs --break voicedread     # 4  a read carries a voice
//   node dev/verify_tracker.mjs --break alwayssettle   # 5  settle drawn with no voice
//   node dev/verify_tracker.mjs --break swallow        # 7  a refusal drawn as blank
//   node dev/verify_tracker.mjs                        # and then, clean
//
// Needs playwright-core (resolved via dev/harness.mjs) and node. No dev server, no Rust: the page
// and the module are served from disk through page.route, and the forge is the mock, proxied.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PW, CHROME, scratch } from './harness.mjs';

const { chromium } = await import(pathToFileURL(PW).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'tracker' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The broken copies ────────────────────────────────────────────────
// Each edit is a real change to www/js/tracker.js, served in place of it. `find` must appear
// exactly once, or the run aborts: a break that matched nothing would prove the opposite of what
// it claims.
const BREAKS = {
	// A voter identity drawn into the tally. The forge never sends one, so this fabricates it —
	// which is exactly the shape of the mistake the dark-vote rule forbids: the DOM naming who
	// voted. The counts stay right, so only the dark check moves.
	leakvoters: [{
		file: 'js/tracker.js',
		find: "\t\treturn el('span', 'trk-tally', tOr('tracker.tally', '{yes} for, {no} against',\n\t\t\t{ yes: p.votes.for, no: p.votes.against }));",
		with: "\t\tvar s = el('span', 'trk-tally', tOr('tracker.tally', '{yes} for, {no} against',\n\t\t\t{ yes: p.votes.for, no: p.votes.against }));\n\t\ts.title = 'quokka-voter-leak voted for';\n\t\treturn s;",
	}],
	// A voice attached to a READ. The repository is public, so a read must carry none; this makes
	// the listing read send the admin voice on its GET.
	voicedread: [{
		file: 'js/tracker.js',
		find: "\t\tvar a = await request(route('limit=' + PAGE), { method: 'GET' });",
		with: "\t\tvar a = await request(route('limit=' + PAGE), { method: 'GET' }, cfg.voice);",
	}],
	// Settle controls drawn with no owner voice: a control that belongs to the owner offered to a
	// reader who cannot use it.
	alwayssettle: [{
		file: 'js/tracker.js',
		find: "\t\tif (!canSettle()) return null;\n\t\tvar acts = el('div', 'trk-settle');",
		with: "\t\tvar acts = el('div', 'trk-settle');",
	}],
	// A refusal swallowed: the error is dropped and the view draws blank.
	swallow: [{
		file: 'js/tracker.js',
		find: "\t\tif (_st.err) _host.appendChild(el('div', 'trk-err', saying(_st.err)));",
		with: "\t\tif (_st.err && false) _host.appendChild(el('div', 'trk-err', saying(_st.err)));",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The file as served: this run's break on top of what is on disk.
const FILES = new Map();
function edit(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, so nothing `
			+ 'was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}
function build() {
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const src = FILES.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		FILES.set(spec.file, edit(src, spec));
	}
}
build();

const trackerSrc = () => FILES.get('js/tracker.js') ?? fs.readFileSync(path.join(WWW, 'js', 'tracker.js'), 'utf8');

// ── The forge, spawned and proxied ───────────────────────────────────

const MOCK_PORT = 8452;
let mockProc = null;

async function reachable(port) {
	try { const r = await fetch(`http://127.0.0.1:${port}/a/b/proposals?format=json&limit=1`); await r.text(); return true; }
	catch { return false; }
}
async function startMock() {
	if (await reachable(MOCK_PORT)) {
		console.error(`:${MOCK_PORT} is already held; free it, or this run drives someone else's forge.`);
		process.exit(2);
	}
	mockProc = spawn('node', [path.join(HERE, 'mock_forge.mjs'), '--port', String(MOCK_PORT), '--count', '12'],
		{ stdio: ['ignore', 'ignore', 'inherit'] });
	for (let i = 0; i < 100; i++) { if (await reachable(MOCK_PORT)) return; await new Promise(r => setTimeout(r, 100)); }
	console.error('the mock forge never bound.');
	process.exit(2);
}
function stopMock() { if (mockProc) { try { mockProc.kill('SIGTERM'); } catch { /* gone */ } mockProc = null; } }
process.on('exit', stopMock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopMock(); process.exit(130); });

// Every request the page made to the gateway route, so the read checks can see whether a voice
// rode on a GET. `voice` here is the Daimond voice header the browser sent.
const forgeReqs = [];

/// The upstream forge path the gateway builds from the query, reproduced from
/// gateway/src/handlers/improve.rs (and verify_improve.mjs's stand-in): `format=json` is written
/// by the gateway and never taken from the caller; the settle `state` field rides in the body.
function upstreamPath(u) {
	const q = u.searchParams;
	const n = q.get('n');
	let p = `/${q.get('account')}/${q.get('repo')}/proposals`;
	if (n !== null) p += '/' + n;
	p += '?format=json';
	if (n === null) {
		for (const k of ['state', 'from', 'limit']) {
			const v = q.get(k);
			if (v !== null) p += `&${k}=` + v;
		}
	}
	return p;
}

/// THE DAIMOND GATEWAY, stood in for. It reads the account/repo/n/selectors off the query,
/// translates the Daimond voice header (`x-daimond-voice`) into the forge's (`x-ore-voice`),
/// forwards to the mock forge over loopback, and hands the answer back verbatim. Same-origin as
/// the page, so no CORS is involved — which is the whole point of routing through the gateway.
async function gatewayRoute(route) {
	const req = route.request();
	const u = new URL(req.url());
	const method = req.method();
	const headers = req.headers();
	const dvoice = headers['x-daimond-voice'] || '';
	forgeReqs.push({ url: req.url(), method, voice: dvoice, body: req.postData() || '' });
	// The gateway refuses a voiceless POST before forwarding (reproduced from improve.rs).
	if (method === 'POST' && !dvoice) {
		return route.fulfill({ status: 401, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'writing needs a voice' }) });
	}
	const out = { 'accept': 'application/json' };
	if (dvoice) out['x-ore-voice'] = dvoice;			// the translation the gateway performs
	if (method === 'POST') out['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
	let res, text;
	try {
		res = await fetch(`http://127.0.0.1:${MOCK_PORT}${upstreamPath(u)}`, {
			method, headers: out, body: method === 'POST' ? (req.postData() || '') : undefined,
		});
		text = await res.text();
	} catch (e) {
		return route.fulfill({ status: 502, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'the forge could not be reached' }) });
	}
	return route.fulfill({
		status: res.status,
		contentType: res.headers.get('content-type') || 'application/json',
		body: text,
	});
}

// ── The harness page ─────────────────────────────────────────────────
// A bare page whose only job is to hold a mount point and load the module. The view draws itself
// into `#trk`; the checks read the DOM and call the published API.

const PAGE = `<!doctype html><meta charset="utf-8"><title>Tracker harness</title>
<body><div id="trk"></div><script src="/js/tracker.js"></script>
<script>window.__mount = function (opts) {
	DaimondTracker.reset();
	// base is the same-origin gateway route; the harness's #trk is the mount point (the app uses
	// #tracker-view). onOpen() reads the listing, which mount() no longer does on its own.
	DaimondTracker.configure(Object.assign({ base: '/api/improve', account: 'oxedyne', repo: 'daimond', voice: '' }, opts || {}));
	DaimondTracker.mount(document.getElementById('trk'));
	DaimondTracker.onOpen();
};</script></body>`;

const ORIGIN = 'https://daimond.test';

async function run() {
	await startMock();

	fs.mkdirSync(PROFILE, { recursive: true });
	const env = Object.assign({}, process.env);
	delete env.DISPLAY;
	const browser = await chromium.launchPersistentContext(PROFILE, {
		executablePath: CHROME, headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
		env, viewport: { width: 1000, height: 900 },
	});
	const page = browser.pages()[0] || await browser.newPage();
	const errs = [];
	page.on('pageerror', e => errs.push(String(e.message)));

	// Serve the page and the module; proxy the forge host.
	await page.route(`${ORIGIN}/`, r => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
	await page.route(`${ORIGIN}/js/tracker.js`, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: trackerSrc() }));
	await page.route(`${ORIGIN}/api/improve*`, gatewayRoute);

	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	/// Mount the view with the given config and wait for the first listing.
	const mount = async (opts) => {
		forgeReqs.length = 0;
		await page.evaluate((o) => window.__mount(o), opts || null);
		await sleep(600);
	};

	try {
		await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

		// ── 1. The listing ───────────────────────────────────────────
		await mount();
		const rows = await page.locator('#trk .trk-row').count();
		check('the listing draws a row per proposal', rows === 12, `${rows} rows`);

		const first = page.locator('#trk .trk-row').first();
		check('a row carries a state word', (await first.locator('.trk-state').count()) === 1);
		check('a row carries its number', /^#\d+$/.test((await first.locator('.trk-num').innerText()).trim()));
		check('a row carries a title', (await first.locator('.trk-title').innerText()).trim().length > 0);
		check('a row carries a comment count', (await first.locator('.trk-comments').count()) === 1);
		check('a row carries a vote tally', (await first.locator('.trk-tally').count()) === 1);

		// Newest first.
		const nums = await page.locator('#trk .trk-num').allInnerTexts();
		const parsed = nums.map(s => Number(s.replace('#', '')));
		const sorted = parsed.slice().sort((a, b) => b - a);
		check('the listing runs newest first', JSON.stringify(parsed) === JSON.stringify(sorted));

		// ── 2. Votes are dark ────────────────────────────────────────
		const tally = (await first.locator('.trk-tally').innerText()).trim();
		check('the tally is two counts and nothing else', /for.*against/i.test(tally) || /\d+.*\d+/.test(tally), tally);
		// No voter identity anywhere in the whole view — text, titles or attributes.
		const html = await page.locator('#trk').innerHTML();
		check('no voter identity appears anywhere in the view', !/voter|quokka-voter/i.test(html));

		// ── 4. Reading is unvoiced (measured over the listing read) ──
		const readsWithVoice = forgeReqs.filter(r => r.method === 'GET' && r.voice);
		check('the listing read carried no voice', readsWithVoice.length === 0,
			`${readsWithVoice.length} voiced GET(s)`);

		// ── 5. No settle control without an admin voice ──────────────
		check('with no voice, no settle control is drawn (listing)',
			(await page.locator('#trk .trk-settle-btn').count()) === 0);

		// ── 3. A proposal opens in full ──────────────────────────────
		await first.locator('.trk-title').click();
		await sleep(500);
		check('opening a proposal shows the detail view', (await page.locator('#trk .trk-detail').count()) === 1);
		check('the detail shows the proposal title and body', (await page.locator('#trk .trk-detail-title').count()) === 1
			&& (await page.locator('#trk .trk-body').count()) === 1);
		check('the detail shows a comments section', (await page.locator('#trk .trk-comments-list').count()) === 1);
		check('the detail shows the state', (await page.locator('#trk .trk-detail .trk-state').count()) === 1);
		// A detail read is still unvoiced.
		const detailVoiced = forgeReqs.filter(r => r.method === 'GET' && r.voice);
		check('the detail read carried no voice', detailVoiced.length === 0, `${detailVoiced.length} voiced GET(s)`);
		// And with no voice, still no settle control in the detail.
		check('with no voice, no settle control is drawn (detail)',
			(await page.locator('#trk .trk-settle-btn').count()) === 0);

		await page.locator('#trk .trk-back').click();
		await sleep(300);
		check('Back returns to the listing', (await page.locator('#trk .trk-row').count()) === 12);

		// ── 6. The owner settles ─────────────────────────────────────
		// mock-voice-ada is the mock's ADMIN voice; the view sends it verbatim as x-ore-voice.
		await mount({ voice: 'mock-voice-ada' });
		// Open an OPEN proposal (one whose state badge says so), so Accept is on offer.
		const openRow = page.locator('#trk .trk-row').filter({ has: page.locator('.trk-state[data-state="open"]') }).first();
		check('the corpus has an open proposal to settle', (await openRow.count()) === 1);
		await openRow.locator('.trk-title').click();
		await sleep(500);
		// EVEN WITH A VOICE HELD, a READ carries none — the repository is public. This is where
		// `voicedread` bites: the owner phase holds an admin voice, so a read that leaked it shows
		// here where the read-only phase (empty voice) could not.
		const ownerVoicedReads = forgeReqs.filter(r => r.method === 'GET' && r.voice);
		check('reads carry no voice even when an admin voice is held', ownerVoicedReads.length === 0,
			`${ownerVoicedReads.length} voiced GET(s)`);
		check('with an admin voice, settle controls are drawn', (await page.locator('#trk .trk-settle-btn').count()) >= 1);

		// Only proceed to settle if this proposal is open (offers Accept).
		const accept = page.locator('#trk .trk-settle-btn[data-which="accept"]');
		if (await accept.count()) {
			forgeReqs.length = 0;
			await accept.click();
			await sleep(500);
			const posted = forgeReqs.filter(r => r.method === 'POST');
			check('Accept posts exactly one write', posted.length === 1, `${posted.length} writes`);
			const w = posted[0] || { voice: '', body: '' };
			check('the settle write carried the admin voice in x-daimond-voice (gateway translates to x-ore-voice)',
				w.voice === 'mock-voice-ada', w.voice);
			const f = Object.fromEntries(new URLSearchParams(w.body));
			check('the settle write is the decide field state=accepted, and nothing else',
				JSON.stringify(Object.keys(f).sort()) === JSON.stringify(['state']) && f.state === 'accepted',
				JSON.stringify(f));
			const badge = (await page.locator('#trk .trk-detail .trk-state').innerText()).trim();
			check('the proposal now reads Being done', /being done/i.test(badge), badge);

			// Reopen is offered on the settled proposal, and posts state=open.
			const reopen = page.locator('#trk .trk-settle-btn[data-which="reopen"]');
			check('a settled proposal offers Reopen', (await reopen.count()) === 1);
			if (await reopen.count()) {
				forgeReqs.length = 0;
				await reopen.click();
				await sleep(500);
				const rp = forgeReqs.filter(r => r.method === 'POST')[0] || { body: '' };
				const rf = Object.fromEntries(new URLSearchParams(rp.body));
				check('Reopen posts state=open', rf.state === 'open', JSON.stringify(rf));
			}
		} else {
			check('Accept posts exactly one write', false, 'the first proposal was not open; fixture drift');
		}

		// ── 7. A refusal is said ─────────────────────────────────────
		await mount({ repo: '_absent' });
		const err = await page.locator('#trk .trk-err').count();
		check('a repository that is not available draws the refusal sentence', err === 1);
		if (err) {
			const said = (await page.locator('#trk .trk-err').innerText()).trim();
			check('the refusal sentence is non-empty', said.length > 0, said);
		}

		check('no page errors were thrown', errs.length === 0, errs.join(' | '));
	} finally {
		await browser.close();
		stopMock();
	}
}

await run();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
