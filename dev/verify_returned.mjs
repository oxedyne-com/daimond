// verify_returned.mjs — the proposer's RETURNED-NOTES inbox (js/improve.js).
//
// A proposal this device raised may be DECLINED by an operator, and the decline carries a one-line
// reason BACK to the proposer. Unlike the rest of the Social panel -- which has no change feed and is
// read by looking (contract §7) -- a returned note is news the writer would not otherwise find, so it
// is read into the capture view beside the box the note was written in, and cleared PER ENTRY once
// seen. Two doors, behind ONE client constant so a path firm-up is a one-line change:
//
//   GET  /<account>/<name>/proposals/returned?format=json         header x-ore-voice   -> { returned:[…] }
//   POST /<account>/<name>/proposals/returned/ack?format=json     header x-ore-voice   FORM acked=<when>[,…]
//
// which the client reaches through the same-origin gateway route `/api/improve?…&returned=1[&ack=1]`,
// exactly as vote (`&vote=1`) and amend (`&amend=1`) do. The gateway (another session's) forwards to
// the forge and derives the caller from the voice; this test STANDS IN FOR the gateway+forge with an
// in-memory store, so it can prove what the CLIENT put on the wire: that the ACK body is a FORM and
// not a JSON `{acked:[…]}`, that a dismiss acks that note's OWN `when` and not the whole inbox, and
// that the GET carries the caller's voice.
//
// WHAT IS PROVED:
//   1. THE INBOX READS. loadReturned() GETs the returned notes and drawReturned() draws one line per
//      note, "Your proposal '<title>' was declined: <reason>", newest first.
//   2. THE READ CARRIES THE VOICE. The GET rides the caller's voice header; there is no name in it.
//   3. NO VOICE, NO INBOX. With no voice held, loadReturned() is a quiet no-op: no request, no rows.
//   4. A DISMISS ACKS PER ENTRY, AS A FORM. Dismissing one note posts `acked=<that when>` (a form,
//      NOT a JSON body), and the forge's remainder becomes the shown list -- the dismissed note is
//      gone, the others stay.
//   5. THE ACK NAMES ONLY THE SEEN KEY. Dismissing the first of three acks ONLY its `when`, never all
//      three -- per entry, never delete-whole.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a damaged improve.js and the
// run is expected to FAIL the one check it targets:
//   node dev/verify_returned.mjs --break ackjson   # 4  the ACK posts a JSON body, not a form
//   node dev/verify_returned.mjs --break dropwhole # 5  a dismiss acks the whole inbox, not one key
//   node dev/verify_returned.mjs                   # and then, clean
//
// Needs playwright-core (resolved via dev/harness.mjs) and node. No dev server, no Rust: the page and
// the module are served from disk through page.route, and the gateway+forge is an in-memory store.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PW, CHROME, scratch } from './harness.mjs';

const { chromium } = await import(pathToFileURL(PW).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'returned' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The broken copies ────────────────────────────────────────────────
// Each edit is a real change to www/js/improve.js, served in place of it. `find` must appear exactly
// once, or the run aborts: a break that matched nothing would prove the opposite of what it claims.
const BREAKS = {
	// The ACK posts a JSON `{acked:[…]}` body instead of a form. The contract's machine surface reads
	// a form and REJECTS a `{`/`[` body, so this is the exact mistake the form rule forbids. Bites
	// check 4: the captured ACK body is no longer `acked=<when>`.
	ackjson: [{
		file: 'js/improve.js',
		find: "\t\tvar f = new URLSearchParams();\n\t\tf.set('acked', keys.join(','));\n\t\tvar a = await ask(route(RETURNED + '&ack=1'), {\n\t\t\tmethod:  'POST',\n\t\t\theaders: { 'Content-Type': 'application/x-www-form-urlencoded' },\n\t\t\tbody:    f.toString(),\n\t\t});",
		with: "\t\tvar a = await ask(route(RETURNED + '&ack=1'), {\n\t\t\tmethod:  'POST',\n\t\t\theaders: { 'Content-Type': 'application/json' },\n\t\t\tbody:    JSON.stringify({ acked: keys }),\n\t\t});",
	}],
	// A dismiss acks the WHOLE inbox rather than the one note seen -- delete-whole, which the per-entry
	// rule forbids. Bites check 5: dismissing the first of three acks all three.
	dropwhole: [{
		file: 'js/improve.js',
		find: "\t\t\tackReturned(Number(b.dataset.when));",
		with: "\t\t\tackReturned(_returned.notes.map(function (x) { return x.when; }));",
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

const improveSrc = () => FILES.get('js/improve.js') ?? fs.readFileSync(path.join(WWW, 'js', 'improve.js'), 'utf8');

// ── The gateway+forge, stood in for by an in-memory store ────────────
// The store holds the caller's returned notes. A GET answers them; the ACK reads the form `acked=`,
// drops those `when` keys, and answers the remainder. Every request is captured so the checks can read
// the voice header, the method, and the raw body the client actually sent.

const VOICE = 'caller-voice-secret-2026';
let store = [];					// [{ when, title, reason }, …]
const reqs = [];				// { method, url, voice, ctype, body }

function returnedFor(u) {
	// The gateway maps `&returned=1[&ack=1]` to the forge's returned door, exactly as it maps
	// `&vote=1` and `&amend=1`. Nothing else is consulted here; the account/repo ride in the query.
	return u.searchParams.get('returned') === '1';
}

async function storeRoute(route) {
	const req = route.request();
	const u = new URL(req.url());
	const method = req.method();
	const headers = req.headers();
	const body = req.postData() || '';
	reqs.push({ method, url: req.url(), voice: headers['x-ore-voice'] || headers['x-daimond-voice'] || '',
		ctype: headers['content-type'] || '', body });

	if (!returnedFor(u)) {
		return route.fulfill({ status: 404, contentType: 'application/json',
			body: JSON.stringify({ error: 'no_proposal' }) });
	}
	// The forge derives the caller from the voice; an unvoiced write is refused before it is read.
	if (method === 'POST' && !(headers['x-ore-voice'] || headers['x-daimond-voice'])) {
		return route.fulfill({ status: 401, contentType: 'application/json',
			body: JSON.stringify({ error: 'unvoiced' }) });
	}
	if (method === 'POST' && u.searchParams.get('ack') === '1') {
		// Read the FORM body only. A JSON body has no `acked` field here, so the break that sends one
		// acks nothing and the store never shrinks -- which is exactly what the machine surface does.
		const acked = new URLSearchParams(body).get('acked') || '';
		const drop = acked.split(/[ ,]+/).map(s => Number(s)).filter(n => n > 0);
		store = store.filter(r => !drop.includes(r.when));
	}
	return route.fulfill({ status: 200, contentType: 'application/json',
		body: JSON.stringify({ returned: store.slice() }) });
}

// ── The harness page ─────────────────────────────────────────────────
// A bare page that holds the capture-view hosts js/improve.js draws into (#improve-returned and the
// flash target #improve-say), inside #panel-social so the module's delegated click listener fires. A
// minimal DaimondVoice stub sends the caller's voice on x-ore-voice -- the header the forge reads --
// so the checks can prove the read is voiced and the ACK body is a form. `has()` is toggled to drive
// the no-voice path.

const PAGE = `<!doctype html><meta charset="utf-8"><title>Returned-notes harness</title>
<body><div id="panel-social">
	<div id="improve-returned" hidden></div>
	<div id="improve-say"></div>
</div>
<script>
window.__voiceHeld = true;
window.DaimondVoice = {
	has:  function () { return !!window.__voiceHeld; },
	send: function (path, opts) {
		var o = Object.assign({}, opts || {});
		o.headers = Object.assign({}, (opts && opts.headers) || {});
		// The gateway translates x-daimond-voice into the forge's x-ore-voice; the store reads
		// either, so send the forge's own spelling here and prove the caller's voice rode the read.
		o.headers['x-ore-voice'] = ${JSON.stringify(VOICE)};
		return fetch(path, o);
	},
};
</script>
<script src="/js/improve.js"></script></body>`;

const ORIGIN = 'https://daimond.test';

async function run() {
	fs.mkdirSync(PROFILE, { recursive: true });
	const env = Object.assign({}, process.env);
	delete env.DISPLAY;
	const browser = await chromium.launchPersistentContext(PROFILE, {
		executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
		env, viewport: { width: 900, height: 700 },
	});
	const page = browser.pages()[0] || await browser.newPage();
	const errs = [];
	page.on('pageerror', e => errs.push(String(e.message)));

	await page.route(`${ORIGIN}/`, r => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
	await page.route(`${ORIGIN}/js/improve.js`, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: improveSrc() }));
	await page.route(`${ORIGIN}/api/improve*`, storeRoute);

	const sleep = (ms) => new Promise(r => setTimeout(r, ms));

	try {
		await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

		// ── 1. The inbox reads and draws ─────────────────────────────
		store = [
			{ when: 1756700000, title: 'Dark-mode contrast', reason: 'out of scope for this cycle' },
			{ when: 1756800000, title: 'Faster cold start',  reason: 'already tracked as #41' },
			{ when: 1756900000, title: 'Export to CSV',      reason: 'not a fit for the product' },
		];
		reqs.length = 0;
		await page.evaluate(() => window.DaimondImprove.loadReturned());
		await sleep(300);

		const rows = page.locator('#improve-returned .imp-returned-one');
		check('the inbox draws one row per returned note', (await rows.count()) === 3, `${await rows.count()} rows`);
		const texts = (await page.locator('#improve-returned .imp-returned-said').allInnerTexts()).map(s => s.trim());
		check("a row reads \"Your proposal '<title>' was declined: <reason>\"",
			texts.some(s => s.includes("Export to CSV") && s.includes('not a fit for the product')), texts.join(' | '));
		check('the notes are drawn newest first',
			texts[0].includes('Export to CSV') && texts[2].includes('Dark-mode contrast'), texts.join(' | '));

		// ── 2. The read carried the voice, and no name ──────────────
		const get0 = reqs.find(r => r.method === 'GET');
		check('the returned GET fired', !!get0, `${reqs.length} request(s)`);
		check('the returned GET carried the caller voice on x-ore-voice', !!get0 && get0.voice === VOICE, get0 && get0.voice);
		check('the returned GET named the returned door and no name',
			!!get0 && /[?&]returned=1(&|$)/.test(get0.url) && !/name=|address=/.test(get0.url), get0 && get0.url);

		// ── 4/5. A dismiss acks that note's OWN when, as a FORM ─────
		reqs.length = 0;
		const csvWhen = 1756900000;		// the newest, drawn first
		await page.locator(`#improve-returned .imp-returned-one[data-when="${csvWhen}"] [data-act="improve-returned-dismiss"]`).click();
		await sleep(300);
		const ack0 = reqs.find(r => r.method === 'POST');
		check('dismissing a note fired an ACK write', !!ack0, `${reqs.length} request(s)`);
		check('the ACK is a form body, not JSON',
			!!ack0 && /application\/x-www-form-urlencoded/.test(ack0.ctype) && ack0.body.indexOf('{') !== 0, ack0 && `${ack0.ctype} :: ${ack0.body}`);
		const af = ack0 ? Object.fromEntries(new URLSearchParams(ack0.body)) : {};
		check('the ACK body is acked=<that when> and only that key',
			JSON.stringify(Object.keys(af)) === JSON.stringify(['acked']) && af.acked === String(csvWhen), JSON.stringify(af));
		check('the ACK carried the caller voice on x-ore-voice', !!ack0 && ack0.voice === VOICE, ack0 && ack0.voice);

		// The dismissed note is gone; the other two stay -- per entry, never delete-whole.
		await sleep(150);
		const left = await page.evaluate(() => window.DaimondImprove.returned().map(r => r.when).sort((a, b) => a - b));
		check('only the dismissed note was acked; the rest remain',
			JSON.stringify(left) === JSON.stringify([1756700000, 1756800000]), JSON.stringify(left));
		check('the store dropped only the acked note', JSON.stringify(store.map(r => r.when).sort((a, b) => a - b)) === JSON.stringify([1756700000, 1756800000]), JSON.stringify(store.map(r => r.when)));
		check('the drawn rows fell to two', (await rows.count()) === 2, `${await rows.count()} rows`);

		// ── 3. No voice, no inbox ────────────────────────────────────
		await page.evaluate(() => { window.DaimondImprove.reset(); window.__voiceHeld = false; });
		reqs.length = 0;
		await page.evaluate(() => window.DaimondImprove.loadReturned());
		await sleep(200);
		check('with no voice, the inbox reads nothing (no request)', reqs.length === 0, `${reqs.length} request(s)`);
		check('with no voice, no rows are drawn and the host is hidden',
			(await rows.count()) === 0 && (await page.locator('#improve-returned[hidden]').count()) === 1);

		check('no page errors were thrown', errs.length === 0, errs.join(' | '));
	} finally {
		await browser.close();
	}
}

await run();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
