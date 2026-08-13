// verify_legalreach.mjs — the two promises the legal pages make about the app.
//
// PROMISE ONE: the documents exist where the user is. Daimond published its
// Terms and its Privacy Policy at daimond.app and then shipped the app on
// daimond.oxedyne.com, where both paths 404. The app itself never mentioned
// them. A beta consent line had nowhere to point, and "by using Daimond you
// agree to these Terms" was addressed to somebody who could not open them.
//
// PROMISE TWO: Terms §13 and Privacy §9 both say, of stored file data,
// "You will be told IN THE APP before it happens"; and Terms §7 sells a
// five-year licence without the app ever saying when the five years are up.
//
// Six properties are worth asserting and the rest is decoration.
//
//   1. THE DOCUMENT OPENS INSIDE DAIMOND. Not "a link exists" — the Web panel
//      is on screen, its frame is showing a page of THIS origin, and the page
//      in it has the document's own heading and the document's own words. A
//      link out to daimond.app satisfies "reachable" and fails this.
//
//   2. NOTHING IN IT LEAVES THE ORIGIN. Every anchor in both documents is
//      resolved in the frame and required to be same-origin. This is asserted
//      at the DOM of the rendered page and not by reading the source, because
//      what matters is where a click would go.
//
//   3. THE APP LEADS TO THEM WITHOUT BEING TOLD THEY EXIST. About — where the
//      small print already lives — carries both, and clicking one shows it.
//
//   4. THE IN-APP COPY IS THE PUBLISHED COPY. The pages are generated from
//      landing/; the generator's own --check must pass, and the check is
//      itself proved to have teeth by feeding it a mutated source.
//
//   5. THE NOTICE IS DRIVEN BY THE FACT, AND NAMES THE RIGHT DAY. In grace: a
//      notice, naming grace_start + grace_secs and not grace_start. Not in
//      grace: nothing. Both halves, because a notice that is always up is not
//      a notice, and a notice with the wrong date is worse than none.
//
//   6. IT SAYS WHAT THE TERMS SAY AND NOTHING MORE GENEROUS. The wording is
//      checked against the clause it is quoting: "is deleted", never "may be
//      deleted" (the Terms say, in terms, 'We say "is", not "may be"'); the
//      licence notice must carry what does NOT stop, or it overstates the loss.
//      A × on either lasts a day and no longer.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page, and the run is
// expected to FAIL. A break whose anchor does not appear exactly once aborts:
// a check proved against code that was never broken is not proved at all.
//
//   node dev/verify_legalreach.mjs --break linkout      # 1 fails: it opens daimond.app
//   node dev/verify_legalreach.mjs --break external     # 2 fails: an anchor off-origin
//   node dev/verify_legalreach.mjs --break norow        # 3 fails: About says nothing
//   node dev/verify_legalreach.mjs --break unreached    # 5 fails: nothing in the app calls it
//   node dev/verify_legalreach.mjs --break nograce      # 5 fails: the fields are ignored
//   node dev/verify_legalreach.mjs --break gracelen     # 5 fails: the date is the wrong day
//   node dev/verify_legalreach.mjs --break always       # 5 fails: a notice with no lapse
//   node dev/verify_legalreach.mjs --break halfquiet    # 5 fails: silent on a half-answer
//   node dev/verify_legalreach.mjs --break maybe        # 6 fails: "may be deleted"
//   node dev/verify_legalreach.mjs --break expires      # 6 fails: the gateway is overruled
//   node dev/verify_legalreach.mjs --break lead         # 6 fails: four years' warning
//   node dev/verify_legalreach.mjs --break hushforever  # 6 fails: dismissed for good
//   node dev/verify_legalreach.mjs --break topup        # 6 fails: Top up does nothing
//   node dev/verify_legalreach.mjs                      # and then, clean
//
//   eval "$(bash dev/world.sh 12 --up)"
//   node dev/verify_legalreach.mjs
//
// Needs dev/serve.mjs only. No gateway on :9002: every /api route is stubbed
// here, and everything below the stub is the real code.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WWW  = path.join(ROOT, 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'legalreach' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The seam that is not applied yet ─────────────────────────────────
//
// js/legal.js, js/lapse.js and css/lapse.css are new files, and nothing loads a
// file in this app except index.html — which this lane does not own. Until those
// three lines land, the behaviour below cannot be exercised at all.
//
// So the document is patched in flight WITH THE EXACT LINES the seam asks for,
// and the fact that it had to be is reported as a failing check of its own. The
// run therefore stays red until the seam is applied, and goes green the moment
// it is, with no change here: `wire()` finds the tags already present and
// patches nothing.

const SEAM = [
	{
		after: '<link rel="stylesheet" href="css/terminal.css">',
		add:   '<link rel="stylesheet" href="css/lapse.css">',
	},
	{
		after: '<script src="js/handmode.js"></script>',
		add:   '<script src="js/legal.js"></script>\n<script src="js/lapse.js"></script>',
	},
];

/// index.html as it should be served. Returns `[html, patched]`.
function wire() {
	let html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
	let patched = false;
	for (const s of SEAM) {
		if (html.includes(s.add)) continue;
		if (!html.includes(s.after)) {
			console.error(`the seam anchor is gone from index.html: ${s.after}`);
			process.exit(2);
		}
		html = html.replace(s.after, s.after + '\n' + s.add);
		patched = true;
	}
	return [html, patched];
}

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it.
const BREAKS = {
	// The world before this work: the app hands the reader to another website.
	// `open()` still answers true, so a caller cannot tell — only the panel can.
	linkout: [{
		file: 'js/legal.js',
		find: '\t\tif (window.DaimondWeb && DaimondWeb.guide) {\n'
			+ '\t\t\tDaimondWeb.guide(sub);\n\t\t\treturn true;\n\t\t}',
		with: '\t\tif (window.DaimondWeb && DaimondWeb.guide) {\n'
			+ '\t\t\twindow.open(\'https://daimond.app/\' + which + \'.html\', \'_blank\');\n'
			+ '\t\t\treturn true;\n\t\t}',
	}],
	// Exactly what the generator's `unlink` takes out, put back: one anchor in
	// §1 pointing at the product website. The document still renders, still
	// reads correctly, and now has a door out of the app in it.
	//
	// This is the one break that serves a DOCUMENT rather than a script, and
	// Chrome treats a fulfilled document as public address space — so the
	// stylesheets it then asks of the loopback server are refused, and the
	// "nothing threw" check fails alongside the real one. Both failures are in
	// a run that is meant to fail; the link check is the one being proved.
	external: [{
		file: 'guide/legal/terms.html',
		find: 'daimond.app. In these Terms,',
		with: '<a href="https://daimond.app">daimond.app</a>. In these Terms,',
	}],
	// The documents exist and open, and nothing in the app mentions them.
	norow: [{
		file: 'js/legal.js',
		find: '\tfunction decorate(card) {\n\t\tvar body = card.querySelector(\'.about-body\');',
		with: '\tfunction decorate(card) {\n\t\tif (card) return;\n\t\tvar body = card.querySelector(\'.about-body\');',
	}],
	// Everything works, and nothing in the shipped app ever runs it: the module
	// is loaded, its functions are correct, and only a test ever calls one. This
	// is the defect class this tree keeps shipping, so it gets its own break.
	unreached: [{
		file: 'js/lapse.js',
		find: '\twindow.addEventListener(\'daimond:authed\', start);',
		with: '\t// window.addEventListener(\'daimond:authed\', start);',
	}],
	// The gateway answers and the client throws the answer away — which is the
	// state this file was written to end.
	nograce: [{
		file: 'js/lapse.js',
		find: '\t\t\t\tif (typeof bal.storage_grace_start === \'number\') {',
		with: '\t\t\t\tif (false && typeof bal.storage_grace_start === \'number\') {',
	}],
	// A notice on the right subject naming the wrong day: the day the grace
	// BEGAN, not the day the data goes. The reader tops up six months late.
	gracelen: [{
		file: 'js/lapse.js',
		find: '\t\t\t\t\tstate.storageAt = (start > 0 && len > 0) ? (start + len) * 1000 : 0;',
		with: '\t\t\t\t\tstate.storageAt = (start > 0 && len > 0) ? start * 1000 : 0;',
	}],
	// The notice is furniture: up whether or not anything is lapsing.
	always: [{
		file: 'js/lapse.js',
		find: '\tfunction storageSpec() {\n\t\tif (!state.storageOn) return null;',
		with: '\tfunction storageSpec() {\n\t\tif (false) return null;',
	}],
	// The half-answer silences it: an account in grace, a gateway that did not
	// say how long, and an app that therefore says nothing at all.
	halfquiet: [{
		file: 'js/lapse.js',
		find: '\t\t\t\t\tstate.storageOn = start > 0;',
		with: '\t\t\t\t\tstate.storageOn = start > 0 && Number(bal.storage_grace_secs) > 0;',
	}],
	// The hedge the Terms explicitly refuse: "We say 'is', not 'may be'".
	maybe: [{
		file: 'js/lapse.js',
		find: '\t\t\t\t+ \'allowance is deleted. Files on this device are untouched.\'),',
		with: '\t\t\t\t+ \'allowance may be deleted. Files on this device are untouched.\'),',
	}],
	// The client computes its own expiry and ignores the one the gateway is
	// enforcing. Both dates look plausible; only one is the one that bites.
	expires: [{
		file: 'js/lapse.js',
		find: '\t\tif (typeof j.expires_ts === \'number\' && j.expires_ts > 0) return j.expires_ts * 1000;',
		with: '\t\tif (false) return 0;',
	}],
	// Four years and eleven months of being told the licence is ending.
	lead: [{
		file: 'js/lapse.js',
		find: '\t\tif (state.licenceAt - now > lead) return null;',
		with: '\t\tif (false) return null;',
	}],
	// The × silences a deletion notice for ever.
	hushforever: [{
		file: 'js/lapse.js',
		find: '\t\treturn !!h && (Date.now() - h) < HUSH_MS;',
		with: '\t\treturn !!h;',
	}],
	// The button is drawn, and pressing it does nothing at all. This is the
	// defect class the app keeps shipping, so it gets its own break.
	topup: [{
		file: 'js/lapse.js',
		find: '\t\t\tacts.push(act(t(\'lapse.top_up\', \'Top up credits\'), function () {\n'
			+ '\t\t\t\tDaimondAdmin.credits(t(\'lapse.credits_pitch\',\n'
			+ '\t\t\t\t\t\'Topping up stops the stored data above the free allowance being deleted.\'));\n'
			+ '\t\t\t}, true));',
		with: '\t\t\tacts.push(act(t(\'lapse.top_up\', \'Top up credits\'), function () {\n'
			+ '\t\t\t}, true));',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified
/// to differ from the file on disk.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const MIME = { '.js': 'application/javascript', '.html': 'text/html; charset=utf-8' };

// ── The stubbed gateway ──────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// What the gateway is currently saying. Each phase below sets these and then
// asks the app to re-read, exactly as the six-hourly poll would.
//
// It opens IN GRACE, because the first thing to prove is that the app asks on
// its own — no test called anything, the notice is simply there a few seconds
// after the session is.
const GRACE_STARTED = now() - 10 * DAY;
const GRACE_SECS    = 180 * DAY;
let BALANCE = {
	ok: true, credits_minor: 0, currency: 'usd', entries: [],
	storage_grace_start: GRACE_STARTED,
	storage_grace_secs:  GRACE_SECS,
	storage_paid_bytes:  240 * 1024 * 1024,
};
let LICENCE = { ok: true, licence: null, held: false, currency: 'usd', pro_price_minor: 4500 };

// Every balance read that LEFT the page, so "it asked" can be told from "it
// happened to have the answer already".
let balanceReads = 0;

async function stub(page) {
	const [html, patched] = wire();
	await page.route((u) => u.pathname === '/' || u.pathname === '/index.html',
		(r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
	global.__patched = patched;

	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const body = damaged(spec);
			const type = MIME[path.extname(spec.file)] || 'text/plain';
			await page.route('**/' + spec.file,
				(r) => r.fulfill({ status: 200, contentType: type, body }));
		}
	}

	// Everything the app asks of a gateway that is not here, answered rather
	// than left to 502 so the console stays readable. FIRST, because Playwright
	// gives the last matching route the request — so every stub that means
	// something is registered after this one and wins.
	await page.route('**/api/**', (r) => r.fulfill(json({ ok: true })));

	await page.route('**/api/account',        (r) => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', (r) => r.fulfill(json({ ok: true, challenge: 'chal-lr', challenge_id: 'cid-lr' })));
	await page.route('**/api/auth/verify',    (r) => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        (r) => { balanceReads++; return r.fulfill(json(BALANCE)); });
	await page.route('**/api/licence',        (r) => r.fulfill(json(LICENCE)));
}

// ── Driving ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Ask the app to re-read the gateway, through the same function its own timer
/// calls, and let it redraw.
async function reread(page) {
	await page.evaluate(() => window.DaimondLapse.check());
	await sleep(300);
}

/// The notice of a kind, as the reader sees it: heading, body and the words on
/// its controls. Null when there is none.
function notice(page, kind) {
	return page.evaluate((k) => {
		const el = document.querySelector('.lapse-note.lapse-' + k);
		if (!el) return null;
		return {
			head:  (el.querySelector('.lapse-head') || {}).textContent || '',
			body:  [...el.querySelectorAll('.lapse-body')].map((p) => p.textContent).join(' '),
			acts:  [...el.querySelectorAll('.lapse-acts > *')].map((a) => a.textContent),
			shown: el.getBoundingClientRect().width > 0,
		};
	}, kind);
}

/// A date as the app writes it, from a timestamp the TEST worked out. The
/// formatting is shared with the app on purpose — the oracle here is the
/// arithmetic (when the data goes), not the spelling of the month.
function asDate(page, ms) {
	return page.evaluate((t) => new Date(t).toLocaleDateString(
		(window.DaimondI18n && DaimondI18n.locale()) || undefined,
		{ day: 'numeric', month: 'long', year: 'numeric' }), ms);
}

const s = await open({ name: 'legalreach', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

await signInAs(s, 'legalreach');
await page.waitForTimeout(2500);

try {
	// ── 0. The seam ──────────────────────────────────────────────
	check('index.html loads js/legal.js, js/lapse.js and css/lapse.css', !global.__patched,
		global.__patched ? 'not yet — the three lines were injected for this run, '
			+ 'so everything below is proved against code the shipped page does not load' : null);

	const up = await page.evaluate(() => [!!window.DaimondLegal, !!window.DaimondLapse]);
	check('the two modules are up', up[0] && up[1], JSON.stringify(up));

	// ── 0b. Something in production asks ─────────────────────────
	//
	// THE CHECK THIS APP MOST NEEDS. A surface that only a test calls is a
	// surface no user ever sees, and this tree has shipped several. Nothing has
	// been evaluated in the page at this point: the app signed in, raised its own
	// `daimond:authed`, and the notice arrived because the shipped code asked the
	// gateway of its own accord.
	let byItself = true;
	await page.waitForSelector('.lapse-note.lapse-storage', { timeout: 25000 })
		.catch(() => { byItself = false; });
	check('the app asks by itself once there is a session, and says so unprompted', byItself);

	// ── 1. The document opens inside Daimond ─────────────────────
	await page.evaluate(() => window.DaimondLegal.open('terms'));
	await sleep(1200);

	const panelUp = await page.evaluate(() => {
		const el = document.getElementById('panel-web');
		return !!el && el.offsetParent !== null;
	});
	check('opening the Terms puts the Web panel on screen', panelUp);

	const here = new URL(page.url()).origin;
	let doc = page.frames().find((f) => /guide\/legal\/terms\.html/.test(f.url()));
	check('and the frame is showing a page of this origin, not another site',
		!!doc && new URL(doc.url()).origin === here,
		doc ? doc.url() : page.frames().map((f) => f.url()).join(' | '));

	if (doc) {
		const h1 = (await doc.textContent('h1').catch(() => '')) || '';
		check('the page in the frame is the Terms themselves', /Terms of Service/.test(h1), h1);

		// The clause this whole verifier is about, in the document the app shows.
		const said = await doc.evaluate(() => document.body.innerText);
		check('and it carries the clause that promises the notice',
			/You will be told in the app before it happens/.test(said));
		check('and the five-year section',
			/What happens when the five years end/.test(said)
			&& /cloud storage and Daimond Email switch off/.test(said));
	}

	// ── 2. Nothing in either document leaves the origin ──────────
	for (const which of ['terms', 'privacy']) {
		await page.evaluate((w) => window.DaimondLegal.open(w), which);
		await sleep(900);
		const f = page.frames().find((fr) => new RegExp(`guide/legal/${which}\\.html`).test(fr.url()));
		if (!f) { check(`the ${which} document opens in the frame`, false); continue; }
		const off = await f.evaluate(() => {
			const out = [];
			document.querySelectorAll('a[href]').forEach((a) => {
				let u;
				try { u = new URL(a.getAttribute('href'), document.baseURI); }
				catch (e) { out.push(a.getAttribute('href')); return; }
				if (u.origin !== location.origin) out.push(u.href);
			});
			return out;
		});
		const n = await f.evaluate(() => document.querySelectorAll('a[href]').length);
		check(`every link in the ${which} document stays in the app`,
			off.length === 0 && n > 3, off.length ? off.join(', ') : `${n} links`);
	}

	// ── 3. The app leads to them ─────────────────────────────────
	await page.evaluate(() => window.DaimondPanels.hide('web'));
	await page.click('#about-btn');
	await sleep(600);
	const row = await page.evaluate(() => {
		const r = document.querySelector('.about-legal');
		if (!r) return null;
		return [...r.querySelectorAll('a')].map((a) => a.textContent.trim());
	});
	check('About offers both documents', !!row && row.length === 2
		&& /Terms/.test(row[0]) && /Privacy/.test(row[1]), row ? row.join(' / ') : 'no row');

	// And the link in it does what a link in it should: the document, in the
	// panel. Asserted from the About dialog, because that is the path a person
	// actually takes.
	if (row) {
		await page.evaluate(() => {
			const a = document.querySelector('.about-legal a');
			a.click();
		});
		await sleep(1200);
		const f = page.frames().find((fr) => /guide\/legal\/terms\.html/.test(fr.url()));
		check('and clicking one shows it in the panel', !!f && new URL(f.url()).origin === here,
			f ? f.url() : 'no frame');
		await page.evaluate(() => {
			const x = document.querySelector('.about-card .ui-close, .about-card .tile-dlg-done');
			if (x) x.click();
		});
		await sleep(300);
	}

	// ── 4. The in-app copy is the published copy ─────────────────
	{
		let current = true, why = '';
		try {
			execFileSync('node', [path.join(HERE, 'legal-pages.mjs'), '--check'],
				{ cwd: ROOT, stdio: 'pipe' });
		} catch (e) {
			current = false;
			why = String(e.stdout || e.message).split('\n').filter(Boolean).slice(-2).join(' | ');
		}
		check('the in-app documents are current with landing/', current, why || null);

		// …and the check that says so can tell. A source with one word moved must
		// produce a different page, or "current" means nothing.
		const gen  = await import('./legal-pages.mjs');
		const real = gen.build({ file: 'terms.html', title: 'Terms of Service' });
		const src  = path.join(ROOT, 'landing', 'terms.html');
		const keep = fs.readFileSync(src, 'utf8');
		const spot = 'You will be told in the app before it happens';
		if (keep.indexOf(spot) < 0) {
			check('the drift check has teeth', false, 'the sentence it mutates is not in the source');
		} else {
			fs.writeFileSync(src, keep.replace(spot, 'You may be told in the app'));
			let moved = false;
			try {
				moved = gen.build({ file: 'terms.html', title: 'Terms of Service' }) !== real;
			} finally {
				fs.writeFileSync(src, keep);
			}
			check('and a word changed in landing/ would be caught', moved);
		}
	}

	// ── 5. The notice is driven by the fact ──────────────────────
	//
	// Not in grace first, so the notice's absence later cannot be mistaken for
	// a notice that never appears at all.
	const inGrace = BALANCE;
	BALANCE = {
		ok: true, credits_minor: 500, currency: 'usd', entries: [],
		storage_grace_start: 0, storage_grace_secs: GRACE_SECS, storage_paid_bytes: 0,
	};
	await reread(page);
	check('an account that is not in grace is told nothing', !(await notice(page, 'storage')));

	const started = GRACE_STARTED;
	const ends    = (started + GRACE_SECS) * 1000;
	BALANCE = inGrace;
	await reread(page);

	const st = await notice(page, 'storage');
	check('an account in grace is told, on screen', !!st && st.shown);
	await page.screenshot({ path: path.join(HERE, 'shots', 'legalreach-storage.png') });

	if (st) {
		const wantEnd   = await asDate(page, ends);
		const wantStart = await asDate(page, started * 1000);
		check('and the day named is the day the data goes, not the day grace began',
			st.head.includes(wantEnd) && !st.head.includes(wantStart),
			`said "${st.head}", wanted ${wantEnd}`);
		check('and it says how much is at stake', /240\.0 MB/.test(st.body), st.body.slice(0, 120));

		// ── 6. What it says, and what it must not ────────────────
		check('it says the data IS deleted, as the Terms do',
			/is deleted/.test(st.body) && !/may be deleted/.test(st.body), st.body);
		check('it says the meter has paused and nothing is back-charged',
			/back-charged/.test(st.body) && /still\s+read/.test(st.body));
		check('it says this device is untouched',
			/(on this device are untouched|device are untouched)/i.test(st.body));

		// The two controls, and both do what they say.
		check('it offers a way to top up and a way to read the clause',
			st.acts.length === 2 && /Top up/.test(st.acts[0]) && /Terms/.test(st.acts[1]),
			st.acts.join(' / '));

		await page.evaluate(() => document.querySelector('.lapse-storage .lapse-act-primary').click());
		await sleep(700);
		const credits = await page.evaluate(() => {
			const v = document.getElementById('admin-credits');
			const n = document.getElementById('credits-note');
			return { shown: !!v && v.style.display !== 'none', note: n ? n.textContent : '' };
		});
		check('Top up credits reaches the Credits view, saying why it was opened',
			credits.shown && /Topping up/.test(credits.note),
			JSON.stringify(credits));

		await page.evaluate(() => document.querySelector('.lapse-storage .lapse-act:not(.lapse-act-primary)').click());
		await sleep(1200);
		const clause = page.frames().find((f) => /guide\/legal\/terms\.html#storage-lapse/.test(f.url()));
		check('and "What the Terms say" opens that clause, in the app',
			!!clause && new URL(clause.url()).origin === here,
			clause ? clause.url() : page.frames().map((f) => f.url()).join(' | '));
		if (clause) {
			const target = await clause.evaluate(() => {
				const el = document.getElementById('storage-lapse');
				return el ? el.textContent.slice(0, 80) : '';
			});
			check('and the clause it lands on is the storage one',
				/Cloud storage above the free allowance is metered/.test(target), target);
		}
		await page.evaluate(() => window.DaimondPanels.hide('web'));

		// A × lasts a day. Not for ever: the notice this silences is a deletion.
		await page.evaluate(() => document.querySelector('.lapse-storage .lapse-x').click());
		await sleep(300);
		check('dismissing it takes it down', !(await notice(page, 'storage')));
		await page.evaluate(() => window.DaimondLapse.render());
		await sleep(200);
		check('and it stays down for the rest of the day', !(await notice(page, 'storage')));

		await page.evaluate(() => {
			const k = 'daimond-lapse-hushed';
			const h = JSON.parse(localStorage.getItem(k) || '{}');
			Object.keys(h).forEach((x) => { h[x] = Date.now() - 25 * 3600 * 1000; });
			localStorage.setItem(k, JSON.stringify(h));
			window.DaimondLapse.render();
		});
		await sleep(200);
		check('and it is back tomorrow', !!(await notice(page, 'storage')));

		// A gateway that says an account is in grace but not how long it runs
		// must not silence the warning. No date is invented; the sentence says
		// what is known.
		BALANCE = { ok: true, credits_minor: 0, currency: 'usd', entries: [],
			storage_grace_start: started, storage_paid_bytes: 240 * 1024 * 1024 };
		await page.evaluate(() => localStorage.removeItem('daimond-lapse-hushed'));
		await reread(page);
		const half = await notice(page, 'storage');
		check('a grace with no length still warns, and names no day it does not know',
			!!half && /when the grace period ends/.test(half.head)
			&& !/\d{4}/.test(half.head), half ? half.head : 'nothing said');
	}

	// ── 6b. The licence, and its five years ──────────────────────
	BALANCE = { ok: true, credits_minor: 500, currency: 'usd', entries: [],
		storage_grace_start: 0, storage_grace_secs: GRACE_SECS };

	// Bought a year ago: four years to run, and nothing to say about it.
	LICENCE = { ok: true, held: true, currency: 'usd', pro_price_minor: 4500,
		licence: { licence_id: 'l1', product: 'pro', issued_ts: now() - 365 * DAY } };
	await reread(page);
	check('a licence with years to run says nothing', !(await notice(page, 'licence')));

	// Bought four years and eleven months ago: a month left.
	const issued = now() - (5 * 365 - 20) * DAY;
	LICENCE = { ok: true, held: true, currency: 'usd', pro_price_minor: 4500,
		licence: { licence_id: 'l1', product: 'pro', issued_ts: issued } };
	await reread(page);
	const lic = await notice(page, 'licence');
	check('a licence within a month of its five years does say so', !!lic && lic.shown);

	if (lic) {
		const d = new Date(issued * 1000);
		d.setFullYear(d.getFullYear() + 5);
		check('and it names five years from the purchase',
			lic.head.includes(await asDate(page, d.getTime())), lic.head);

		check('it says which three services stop',
			/sync/i.test(lic.body) && /cloud storage/i.test(lic.body) && /Email/i.test(lic.body));
		check('and, in the same breath, what does not',
			/[Nn]othing is deleted/.test(lic.body) && /nothing is locked/.test(lic.body)
			&& /never stops/.test(lic.body) && /credits are unaffected/.test(lic.body),
			lic.body);
		// The app does not fall behind a paywall, and the notice must not hint
		// that it does.
		check('it does not say the app stops',
			!/(stop working|no longer be able to use|locked out|read-only)/i.test(lic.body), lic.body);
		// There is no Buy again, because /api/checkout/pro answers 409 while a
		// licence exists. A button that refuses is worse than no button.
		check('it draws no control that would refuse',
			lic.acts.length === 1 && /Terms/.test(lic.acts[0]), lic.acts.join(' / '));
	}

	// The gateway is the authority on when a licence ends.
	const soon = now() + 5 * DAY;
	LICENCE = { ok: true, held: true, currency: 'usd', pro_price_minor: 4500, expires_ts: soon,
		licence: { licence_id: 'l1', product: 'pro', issued_ts: issued } };
	await page.evaluate(() => {
		// Yesterday's dismissal must not hide today's different date.
		localStorage.removeItem('daimond-lapse-hushed');
	});
	await reread(page);
	const lic2 = await notice(page, 'licence');
	check('an expiry the gateway states overrules the one computed from the term',
		!!lic2 && lic2.head.includes(await asDate(page, soon * 1000)),
		lic2 ? lic2.head : 'no notice');

	// And it asked, rather than being handed the answer by something else.
	check('it read the gateway to learn all this', balanceReads > 0, `${balanceReads} reads`);

	await page.screenshot({ path: path.join(HERE, 'shots', 'legalreach.png') });

	const noisy = s.errs.filter((e) => !/502|Failed to load resource|favicon/.test(e));
	check('nothing threw', noisy.length === 0, noisy.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `break '${BREAK}': FAILED as it should — the checks above have teeth.`
		: `break '${BREAK}': everything still passed, so the checks prove nothing.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
