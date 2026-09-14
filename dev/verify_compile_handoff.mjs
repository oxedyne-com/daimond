// verify_compile_handoff.mjs — A PHONE THAT CANNOT LAY A BOOK OUT HANDS IT
// TO A MACHINE THAT CAN, AND GETS THE PAGES BACK.
//
// The loop is the author's own, and it broke on one fact: the 48-page book is 29
// files the phone may not hold and 306 MB of wasm heap it may not have. Pressing
// Compile there produced either a file the gather could not reach — `which was not
// among the 17 files gathered` — or, worse, a tab iOS ended without a word.
//
// So the placement decides, from what the device can MEASURE about itself, and the
// button says the answer before it is pressed. This drives that end to end across
// real paired contexts on a real gateway:
//
//   1. THE PHONE LACKS A FILE. The button reads "Compile on <runner>", the title
//      names how many are missing; the press posts exactly ONE compile envelope;
//      the runner takes the lease once, writes the carried file, compiles ONCE
//      (through its own watch, so the write and the errand are one layout and not
//      two heap growths), streams frames and reports; the phone DRAWS without
//      compiling, and its cloud index names the runner's chunks.
//   2. THE PHONE HAS EVERYTHING AND IT FITS. "Compile here", no envelope, a local
//      build — the placement moves nothing it does not have to.
//   3. TOO LARGE. The same book, the same files, a heap ceiling it cannot meet:
//      handed off, with BOTH megabyte numbers in the title.
//   4. NOBODY IS AWAKE. The button is disabled and NAMES the machine that could do
//      it, rather than saying no device can.
//   5. THE RETRY, ONCE. A sidecar that claims everything is here and a file that is
//      not: the local compile fails in the compiler's own words, and the same
//      answer is taken late, said out loud, and taken only once.
//   6. A DESKTOP IS UNCHANGED. Everything places here, nothing is posted, and the
//      preview still lands on `<main>-preview.pdf` and never on `<main>.pdf`.
//   7. NO DOUBLE COMPILE UNDER A RACE. "Compile here" pressed while the runner is
//      mid-layout revokes the lease; the runner aborts and the phone compiles once.
//
// THE BOOK IS THE AUTHOR'S OWN, copied read-only out of `~/usr/books/ontheism/
// TheOrder/Onthearche`, because a fixture that compiles in a tenth of a second
// proves nothing about a heap ceiling or about a hand-off anybody would want.
//
// ENGINES. R (the runner) and P1 (the phone) are Chromium: the OPFS half runs
// there, and Playwright's WebKit has no OPFS at all
// (`reference_playwright_webkit`), so a WebKit context cannot HOLD a book. P2 is
// WebKit at 390x844 — the engine an iPhone actually runs — for the half that needs
// no file on the phone: the placement's own answer and the sentence it produces.
// What cannot run there is NAMED on the count line, never skipped in silence.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_compile_handoff.mjs --break norequire   # 1,3: any peer is seated
//   node dev/verify_compile_handoff.mjs --break noadopt     # 1: the chunks are not named
//   node dev/verify_compile_handoff.mjs --break noretry     # 5: the late answer is not taken
//   node dev/verify_compile_handoff.mjs --break twocompiles # 1: two layouts, two growths
//   node dev/verify_compile_handoff.mjs --break noplace     # 1,3: the phone compiles anyway
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_compile_handoff.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, shot } from './harness.mjs';
import { makePagePro, makePagePack } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [], unrun = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
/// A check that COULD NOT be asked here, named rather than passed.
const cannot = (name, why) => {
	unrun.push(name + ' (' + why + ')');
	console.log('  --   ' + name + ' — not run: ' + why);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/// SHA-256 of nothing. Named because it is what a whole book's import hashes came
/// back as while `read_bytes(path, 0, 0)` was reading zero bytes: one digest for
/// every file, so no two could ever be told apart and a file that moved under an
/// errand was reported as current.
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The `require` filter goes, so ANY live peer is seated for a compile —
	// including one that holds neither the folder nor the book.
	norequire: [{
		file: 'js/peer.js',
		find: '\tfunction meetsRequire(rec, req) {\n\t\treturn !req || (!!rec && rec[req] === true);\n\t}',
		with: '\tfunction meetsRequire(rec, req) {\n\t\tvoid req; void rec; return true;\n\t}',
	}],
	// The runner's chunks are never named by the device that CAN commit, which is
	// the whole of why the phone has to adopt them.
	noadopt: [{
		file: 'js/daimond.js',
		find: '\t\tif (DaimondCloud.isPreviewKey) {\n\t\t\tObject.keys(rx).forEach(function (k) {',
		with: '\t\tif (false && DaimondCloud.isPreviewKey) {\n\t\t\tObject.keys(rx).forEach(function (k) {',
	}],
	// The late answer is not taken: a local failure that the placement would have
	// moved is simply reported.
	noretry: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\tvar retriable = LOCAL_MISS.test(out.error) || TYPST_TRAPPED.test(out.error);',
		with: '\t\t\t\t\tvar retriable = false;',
	}],
	// The runner compiles DIRECTLY instead of through its own watch, so the write's
	// own rebuild and the errand's are two layouts and two heap growths.
	twocompiles: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\t} else if (st && st.path === main && W.rebuild) {',
		with: '\t\t\t\t\t} else if (false && st && st.path === main && W.rebuild) {',
	}],
	// The placement is not consulted at all: Compile means "here", whatever the
	// device can or cannot hold — which is exactly where this began.
	noplace: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tif (place && place.where === \'runner\') {',
		with: '\t\t\t\tif (false && place && place.where === \'runner\') {',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

async function routes(page) {
	if (!BREAK) return;
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	for (const [file, body] of byFile) {
		await page.route('**/' + file, r => r.fulfill({ status: 200,
			contentType: 'application/javascript', body }));
	}
}

// ── The book, copied ─────────────────────────────────────────────────
const SRC  = path.join(process.env.HOME, 'usr/books/ontheism/TheOrder/Onthearche');
const COPY = scratch('compile-handoff' + (BREAK ? '-' + BREAK : ''), 'book');
const ROOT = 'ontheism/TheOrder/Onthearche';
const MAIN = ROOT + '/onthearche.typ';

if (!fs.existsSync(path.join(SRC, 'onthearche.typ'))) {
	console.error('the book is not at ' + SRC + '; nothing to seed.');
	process.exit(2);
}
fs.rmSync(COPY, { recursive: true, force: true });
fs.mkdirSync(COPY, { recursive: true });
for (const n of fs.readdirSync(SRC)) {
	if (/\.typ$/i.test(n)) fs.copyFileSync(path.join(SRC, n), path.join(COPY, n));
}

const seed = [];
for (const n of fs.readdirSync(COPY)) {
	seed.push([ROOT + '/' + n, fs.readFileSync(path.join(COPY, n), 'utf8')]);
}
for (const [rel, re] of [
	['assets/svg',            /\.svg$/i],
	['assets/jpg',            /\.jpe?g$/i],
	['assets/fonts',          /^Felipa-Regular\.ttf$/],
	['assets/fonts/libertinus', /^LibertinusSerif.*\.otf$/i],
]) {
	let names = [];
	try { names = fs.readdirSync(path.join(SRC, rel)); } catch (e) { continue; }
	for (const n of names) {
		if (!re.test(n)) continue;
		const b = fs.readFileSync(path.join(SRC, rel, n));
		seed.push([ROOT + '/' + rel + '/' + n,
			/\.svg$/i.test(n) ? b.toString('utf8') : Array.from(b)]);
	}
}
// A chapter the phone will NOT be given, so the gather on the phone genuinely
// cannot reach it. Chosen by name so the assertion can say which.
const HOLE = seed.find(([p]) => /chap_practice\.typ$/.test(p));
if (!HOLE) { console.error('the book has no chap_practice.typ to withhold.'); process.exit(2); }
const MAINTEXT = (seed.find(([p]) => p === MAIN) || [])[1];
if (typeof MAINTEXT !== 'string') { console.error('the book has no ' + MAIN + '.'); process.exit(2); }

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/// Write a seed through the app's own doors, in small batches.
async function seedInto(page, files) {
	for (let i = 0; i < files.length; i += 8) {
		await page.evaluate(async (batch) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			for (const f of batch) {
				if (typeof f[1] === 'string') await m.write_file(f[0], f[1]);
				else await app.write_bytes(f[0], new Uint8Array(f[1]));
			}
		}, files.slice(i, i + 8));
	}
}

/// Take a file back off a context, through the app's own door.
///
/// `file_delete` is how every other verifier in this directory deletes a workspace
/// file (`verify_chunks`, `verify_cloud`, `verify_sync`), and there is NO
/// `delete_file` export in the wasm to do it with instead. That is not a detail: the
/// first run of this file called one, the call threw, the throw was swallowed by a
/// `.catch`, and cell 1 went on to measure a phone that held the whole book while
/// saying it was withholding a chapter.
async function removeFrom(page, path) {
	return await page.evaluate(async (f) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		return String(await app.run_tool('file_delete', JSON.stringify({ path: f })));
	}, path);
}

const st = (pg) => pg.evaluate(() => {
	try { return window.DaimondTypstWatch.state(); } catch (e) { return null; }
});
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());

/// Make a context STATE the placement pair on every beat it sends from here on, and
/// arm the runner posture for real.
///
/// A browser context cannot arrive at either field honestly: there is no file chooser
/// to grant a mounted folder and no extension to answer for a machine hand, so
/// `selfHoldsFolder()` and `selfHoldsHand()` are false in every Playwright context
/// there has ever been. `verify_runnerseat.mjs` states the runner posture for the same
/// reason. What must not be stated is what the ELECTION does with the answer, which is
/// the whole of what this file measures.
///
/// It PATCHES rather than beating once because the pair is deliberately LIVE and not
/// sticky like `mobile`: `presenceTick` re-beats from the two real signals every
/// `BEAT_MS` (45 s), and an explicit false replaces a stored true by design, since a
/// hand is unplugged while the page goes on beating. One stated beat therefore lasts
/// about one tick — which is how cell 3 first read "no device that can do this is
/// awake" with the runner sitting there.
///
/// The runner posture is NOT patched: `DaimondRunner.on()` is
/// `localStorage[KEY] === '1'`, so arming it is the real thing and the tick then sends
/// it of its own accord.
const claimPair = (pg, o) => pg.evaluate((opt) => {
	window.__claimHand   = !!opt.hand;
	window.__claimFolder = !!opt.folder;
	try {
		if (opt.runner) localStorage.setItem(window.DaimondRunner.KEY, '1');
		else localStorage.removeItem(window.DaimondRunner.KEY);
	} catch (e) { /* a private window: the stated beat below still carries it */ }
	const P = window.DaimondPresence, S = window.DaimondSync;
	if (!P.__pairPatched) {
		const beat = P.beat;
		P.beat = function (id, nm, now, att, svc, build, runner, mobile) {
			return beat(id, nm, now, att, svc, build, runner, mobile,
				window.__claimHand, window.__claimFolder);
		};
		const bp = S.beatPresence;
		S.beatPresence = function (id, nm, att, svc, runner, mobile) {
			return bp(id, nm, att, svc, runner, mobile,
				window.__claimHand, window.__claimFolder);
		};
		P.__pairPatched = true;
	}
	const id = window.DaimondIdentity.deviceId();
	const nm = (window.DaimondCore && window.DaimondCore.deviceSelfName
		&& window.DaimondCore.deviceSelfName(id)) || 'a device';
	const mob = !!(window.DaimondShell && window.DaimondShell.isMobileDevice
		&& window.DaimondShell.isMobileDevice());
	P.beat(id, nm, Date.now(), true, true, null, !!opt.runner, mob);
	return S.beatPresence(id, nm, true, true, !!opt.runner, mob);
}, o);

/// Does this context hold the file at all? `typst_watch_stamps` answers `'0:-1'` for a
/// path that is not there, which is the very probe the placement's ledger asks.
const holds = (pg, f) => pg.evaluate(async (path) => {
	try {
		const m = await import('/pkg/oxedyne_daimond.js');
		return String((await m.typst_watch_stamps([path]))[0] || '') !== '0:-1';
	} catch (e) { return null; }		// a question that could not be asked is not an answer
}, f);

/// The Doc panel's Compile button, as a reader sees it.
const docBtn = (pg, act) => pg.evaluate((a) => {
	const b = document.querySelector('[data-act="' + a + '"]');
	if (!b) return null;
	return { text: b.textContent || '', title: b.getAttribute('title') || '',
		disabled: !!b.disabled, off: b.classList.contains('files-btn-off') };
}, act);

const docMsg = (pg) => pg.evaluate(() => {
	const e = document.querySelector('.files-view-msg');
	return e ? { text: e.textContent || '', err: e.classList.contains('err'),
		shown: e.style.display !== 'none' } : null;
});

/// Plant a sidecar for the document, as a peer's successful build would have left
/// one. The CROSSING of a real sidecar is proved in www/js/place.test.mjs (B2/B3)
/// and by cell 1 below (the runner writes one); what is wanted here is a KNOWN
/// import set and a known heap figure, so a cell measures the placement rather than
/// the weather.
const plantSidecar = (pg, o) => pg.evaluate(async (opt) => {
	const key = await window.DaimondPeer.docKeyFor('', opt.main);
	window.DaimondCloud.contentSet('@p/' + key, Object.assign({
		v: 2, size: 0, key: '', chunks: [], kind: 'vector',
		main: opt.main, wsid: '', by: 'seeded', name: 'a peer', ms: 5000,
		ts: Date.now(),
	}, opt.rec));
	return '@p/' + key;
}, o);

/// Wait until `drawn` has moved past `was`, or give up.
async function drewPast(pg, was, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const s = await st(pg);
		if (s && s.drawn > was) return Date.now() - t0;
		await sleep(250);
	}
	return -1;
}

/// Keep every sentence the Doc panel shows from here on.
///
/// A poll cannot do this: the retry line is written and replaced by the dispatch's own
/// progress within a frame or two, and a cell that polls reports "never said it" about
/// a sentence that was said. It is also the only way to tell a hand-off the PLACEMENT
/// took from one the retry took after a local failure -- the end state is the same
/// pages either way, which is why breaking the placement left cell 1 green.
const recordSaid = (pg) => pg.evaluate(() => {
	const e = document.querySelector('.files-view-msg');
	window.__said = [];
	if (!e) return false;
	new MutationObserver(() => window.__said.push(e.textContent || ''))
		.observe(e, { childList: true, characterData: true, subtree: true });
	return true;
});
const saidSoFar = (pg) => pg.evaluate(() => window.__said || []);

/// Wait until the Doc panel's message matches, or give up. Answers the ms.
async function saidWithin(pg, re, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const m = await docMsg(pg);
		if (m && re.test(m.text)) return Date.now() - t0;
		await sleep(250);
	}
	return -1;
}

/// Open a document in the Doc panel and wait for the buttons to be labelled.
async function openDoc(pg, file) {
	await pg.evaluate((f) => window.DaimondDoc.show(f), file);
	await sleep(1500);
	// The labelling is one stamp probe and a hash pass; on the author's book that is
	// a couple of megabytes read once, so it is given a real moment.
	for (let i = 0; i < 40; i++) {
		const b = await docBtn(pg, 'compile');
		if (b && /Compile (here|on)/i.test(b.text)) return b;
		await sleep(500);
	}
	return await docBtn(pg, 'compile');
}

let R = null, P1 = null, P2 = null, D = null;
try {
	// ══ THE RUNNER ════════════════════════════════════════════════════
	R = await open({ name: 'cmprunner', signIn: true, connect: true, defaults: false,
		route: routes });
	await R.page.setViewportSize({ width: 1900, height: 1000 });
	await R.page.keyboard.press('Escape');
	await R.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPresence
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 25000 })
		.catch(() => {});
	const GWDIR = new URL('../gateway', import.meta.url).pathname;
	const pro = await makePagePro(R.page, GWDIR, GW_URL);
	check('the account holds Pro, so the post and presence doors answer at all',
		pro.pro === true, JSON.stringify(pro));
	// AND IT HOLDS THE TYPESETTING PACK. The compiler is sold in one (`drop01`), and
	// a gateway is the only thing that knows whether an account has bought it: with no
	// gateway `/api/tools` cannot be asked, nothing is locked, and a verifier compiles
	// freely. The moment one is up -- which this file needs for the post, presence and
	// lease doors -- every compile here answers "Typesetting is part of a tool pack
	// this account has not bought" instead, and the run measures the till.
	const packR = await makePagePack(R.page, 'drop01', 'typst_compile', GWDIR, GW_URL);
	check('and it holds the typesetting pack, so a compile is not refused at the till',
		packR.locked === false, JSON.stringify(packR));
	// AND THE RUNNER'S WORKSPACE STAYS THE RUNNER'S. It stands in for a desktop with
	// the folder actually mounted, and such a device NEVER puts its workspace on the
	// parcel and never commits (`filesSyncable`, `collectFiles`) -- which is exactly why
	// the phone has to adopt the runner's `@p/` refs for its own commit to keep them.
	// A Playwright context cannot mount a folder, so without this both contexts push
	// their files at each other: the runner hands the withheld chapter back to the phone
	// within a tick, and the phone's deletion of it reaches the runner MID-ERRAND, which
	// is how the runner came to lay out 37 pages of a 49-page book and to count three
	// layouts where the errand asked for one. `filesSyncable` reads `DaimondTools`, so
	// taking the panel away after its locks are pushed is the one page-side switch that
	// says "these files are not the parcel's business".
	await R.page.evaluate(() => { try { delete window.DaimondTools; } catch (e) { window.DaimondTools = null; } });
	console.log(`  ..   seeding ${seed.length} file(s) of the book into the runner`);
	await seedInto(R.page, seed);
	await claimPair(R.page, { runner: true, hand: true, folder: true });
	// AND THE RUNNER HAS THE BOOK OPEN AND LAID OUT, which is the author's own case and
	// the one the "one layout" claim is about. The errand compiles THROUGH the watch
	// only where the watch holds this document (`st.path === main`, the compile dep in
	// daimond.js), and that is the branch where the errand's own writes raise
	// `daimond-file-written` and could add a SECOND layout to a heap that only grows.
	// The watch takes the document on its first COMPILE, not on the panel opening, so
	// this presses the button once. It is done before the phone exists, because
	// everything between the phone's press and the runner's answer is time for the
	// account's own sync to hand the withheld chapter back.
	await openDoc(R.page, MAIN);
	await R.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	const rDrew = await drewPast(R.page, 0, 300000);
	const rPath = (await st(R.page) || {}).path;
	check('the runner holds the book open and laid out, so an errand goes through its watch',
		rPath === MAIN && rDrew > 0, JSON.stringify({ path: rPath, ms: rDrew }));

	// ══ THE PHONE ═════════════════════════════════════════════════════
	P1 = await open({ name: 'cmpphone', signIn: false, connect: false, defaults: false,
		ua: IPHONE, touch: true, isMobile: true, route: routes });
	await P1.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 20000 })
		.catch(() => {});
	const code = await R.page.evaluate(() => DaimondPairing.create());
	await P1.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await P1.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(P1, 'cmprunner');
	await P1.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPresence
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 30000 })
		.catch(() => {});
	await P1.page.keyboard.press('Escape');
	await P1.page.setViewportSize({ width: 390, height: 844 });
	await sleep(2000);
	const packP = await makePagePack(P1.page, 'drop01', 'typst_compile', GWDIR, GW_URL);
	check('the phone is on the runner’s account and holds the same pack',
		packP.locked === false && packP.id === pro.id, JSON.stringify(packP));
	check('the phone context is 390px wide and says it is an iPhone',
		(await P1.page.evaluate(() => innerWidth)) === 390
		&& (await P1.page.evaluate(() =>
			!!(window.DaimondShell && DaimondShell.isMobileDevice()))),
		await P1.page.evaluate(() => innerWidth + 'px'));

	// THE BOOK MINUS ONE CHAPTER, so the gather on the phone genuinely cannot reach
	// it — the fault this whole mechanism exists for.
	console.log(`  ..   seeding the book MINUS ${HOLE[0]} into the phone`);
	await seedInto(P1.page, seed.filter(([p]) => p !== HOLE[0]));
	await claimPair(P1.page, { runner: false, hand: false, folder: false });
	await R.page.evaluate(() => window.DaimondSync.refreshPresence());
	await P1.page.evaluate(() => window.DaimondSync.refreshPresence());
	await sleep(1500);

	const idR = await devId(R.page), idP = await devId(P1.page);
	check('the two paired contexts hold distinct per-device ids',
		!!idR && !!idP && idR !== idP, JSON.stringify({ idR, idP }));
	const seen = await P1.page.evaluate((id) => {
		const p = window.DaimondPresence.snapshot();
		const r = p[id];
		return r ? { hand: r.hand, folder: r.folder, runner: r.runner, mobile: r.mobile,
			name: r.name } : null;
	}, idR);
	check('the runner reaches the phone with hand:true and folder:true on its beat',
		!!seen && seen.hand === true && seen.folder === true && seen.runner === true
		&& seen.mobile === false, JSON.stringify(seen));

	// ══ CELL 1: THE PHONE LACKS A FILE ════════════════════════════════
	//
	// The sidecar names the full import set, which is what lets the phone find out it
	// is missing one BEFORE it compiles rather than by failing.
	const imports = seed.filter(([p]) => /\.typ$/.test(p)).map(([p]) => p);
	await plantSidecar(P1.page, { main: MAIN, rec: { imports, hashes: {}, heapMB: 40, headroom: 40 } });
	// AND THE HOLE HAS TO STILL BE A HOLE. Both contexts are one account, and a
	// context holding the workspace in OPFS rather than in a mounted folder DOES put
	// its files on the parcel (`filesSyncable`, `collectFiles`) -- so the runner's copy
	// of the withheld chapter syncs to the phone within a tick or two of seeding, and
	// the first run of this cell read "Compile here" for the honest reason that by then
	// nothing was missing. The file is taken back off the phone here, and the probe the
	// placement's own ledger asks is then ASSERTED, so a cell that has quietly stopped
	// testing a missing file says so instead of passing.
	const gone1 = await removeFrom(P1.page, HOLE[0]);
	check('1. the phone genuinely cannot reach the withheld chapter',
		(await holds(P1.page, HOLE[0])) === false, HOLE[0] + ' — ' + gone1);
	const b1 = await openDoc(P1.page, MAIN);
	check('1. the button reads "Compile on <the runner>" rather than "Compile here"',
		!!b1 && /Compile on/i.test(b1.text) && !b1.disabled,
		JSON.stringify(b1));
	check('1. and the title names how many of this document’s files are not here',
		!!b1 && /\bmissing\b/i.test(b1.title) && /\b1\b/.test(b1.title),
		JSON.stringify(b1 && b1.title));

	// THE RUNNER HAS THE BOOK OPEN, which is both the author's real case and the one
	// the "one layout" claim is about: the errand compiles THROUGH the watch only where
	// the watch holds this document (`st.path === main`, the compile dep in
	// daimond.js), and that is the branch where the errand's own writes raise
	// `daimond-file-written` and could add a SECOND layout on a heap that only grows.
	// With the panel shut on the runner the errand compiles directly, `builds` never
	// moves, and both the assertion below and the `twocompiles` break measure nothing.
	// AND STILL A HOLE AT THE PRESS. The placement is taken twice -- once to label the
	// button and again on the click, because files change between the two -- and in
	// between, the account's own sync is handing the runner's copy of this chapter back
	// to the phone. It is taken off again here, milliseconds before the press, so what
	// the press decides on is the state this cell is about.
	// AND NOTHING IS WAITED FOR. The two contexts are one account and neither can mount
	// a real folder, so BOTH put their workspace on the parcel -- which a real
	// folder-mounted desktop never does (`filesSyncable`). Giving the deletion a sync
	// round to settle therefore takes the chapter off the RUNNER as well, and the runner
	// then cannot lay the book out at all: "chap_practice.typ, which was not among the
	// 126 files gathered". The press has to happen inside the window where the phone has
	// lost the file and the runner still has it, so it happens at once.
	const again1 = await removeFrom(P1.page, HOLE[0]);
	check('1. and it is still missing at the moment the button is pressed',
		(await holds(P1.page, HOLE[0])) === false, HOLE[0] + ' — ' + again1);
	const rBefore = await st(R.page) || { builds: 0, drawn: 0 };
	const pBefore = await st(P1.page) || { builds: 0, drawn: 0 };
	await recordSaid(P1.page);
	await P1.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	// The report is the end of it: the runner has to be woken by its collect loop,
	// take the lease, write, lay 48 pages out and upload the artifact.
	const said = await saidWithin(P1.page, /Built on/i, 240000);
	const msg1 = await docMsg(P1.page);
	check('1. the pages come back, and the panel says which machine built them',
		said > 0, said > 0 ? `${(said / 1000).toFixed(1)}s — ${msg1.text}`
			: `timed out — ${msg1 && msg1.text}`);
	// AND IT WENT STRAIGHT THERE. The retry-once rule is a second road to the same
	// pages, so "the pages came back" is true whether the placement moved the compile
	// or a local failure did -- which is why disabling the placement altogether left
	// this cell green. The panel says which happened: a placement that worked never
	// mentions a failure here.
	const said1 = await saidSoFar(P1.page);
	check('1. and the placement sent it, rather than a local failure sending it late',
		!said1.some(x => /trying on|failed here/i.test(x)),
		JSON.stringify(said1.filter(x => /trying|failed/i.test(x)).slice(0, 2)));
	const rAfter = await st(R.page) || { builds: 0 };
	check('1. the runner laid the book out EXACTLY ONCE — the write and the errand are one build',
		rAfter.builds - rBefore.builds === 1,
		`builds ${rBefore.builds} → ${rAfter.builds}`);
	// WHAT THE LAYOUT WAS MADE OF, not where a byte sits afterwards. Reading the
	// chapter back out of the runner's OPFS is a RACE and was one: the two contexts are
	// one account, so the phone's deletion of the chapter syncs to the runner, and a
	// `read_bytes` that lands between that and the errand's write throws NotFoundError
	// and takes the whole run down with it. What the cell is owed is that the file the
	// phone had not got took part in the layout that came back -- which the report's own
	// import set says, and no sync can move.
	const carried = await P1.page.evaluate(async (o) => {
		const key = '@p/' + (await window.DaimondPeer.docKeyFor('', o.main));
		const rec = window.DaimondCloud.index()[key] || {};
		return { named: (rec.imports || []).indexOf(o.hole) >= 0,
			hash: String((rec.hashes || {})[o.hole] || '') };
	}, { main: MAIN, hole: HOLE[0] }).catch(() => ({ named: false, hash: '' }));
	check('1. and the layout that came back was made of the chapter the phone had not got',
		carried.named && carried.hash.length === 64 && carried.hash !== EMPTY_SHA,
		JSON.stringify(carried));
	const pAfter = await st(P1.page) || { builds: 0, drawn: 0 };
	check('1. the PHONE drew the pages and did NOT compile',
		pAfter.drawn > pBefore.drawn && pAfter.builds === pBefore.builds,
		`drawn ${pBefore.drawn} → ${pAfter.drawn}, builds ${pBefore.builds} → ${pAfter.builds}`);
	check('1. and the view says whose pages these are',
		!!pAfter.given && !!pAfter.given.by, JSON.stringify(pAfter.given));
	check('1. the pages are real pages — the whole book, not a title page',
		(pAfter.pages | 0) > 40, `${pAfter.pages} pages`);
	const ix1 = await P1.page.evaluate(async (main) => {
		const key = '@p/' + (await window.DaimondPeer.docKeyFor('', main));
		const ix = window.DaimondCloud.index();
		const rec = ix[key];
		const peers = Object.keys(ix).filter(k => k.indexOf(key + '.peer') === 0)
			.map(k => ({ k, n: (ix[k].chunks || []).length }));
		return { key, has: !!rec, chunks: rec ? (rec.chunks || []).length : 0,
			imports: rec ? (rec.imports || []).length : 0,
			hashes: rec ? Object.keys(rec.hashes || {}).length : 0, peers };
	}, MAIN);
	check('1. the phone’s cloud index holds the document’s preview, with its chunks and hashes',
		ix1.has && ix1.chunks > 0 && ix1.imports >= 17 && ix1.hashes > 0,
		JSON.stringify(ix1));
	check('1. and the phone’s own index NAMES the runner’s chunk addresses, so its commit keeps them',
		ix1.chunks > 0, JSON.stringify({ chunks: ix1.chunks, peers: ix1.peers }));
	await shot(P1, 'compile-handoff-01-pages' + (BREAK ? '-' + BREAK : ''));

	// ══ CELL 2: THE PHONE HAS EVERYTHING ══════════════════════════════
	//
	// The same phone, given the chapter it was missing and a sidecar whose numbers
	// fit its ceiling. The placement must move NOTHING it does not have to.
	await seedInto(P1.page, [HOLE]);
	// AND A SAVE, so the press has a layout to do. Cell 1 left the phone showing the
	// runner's pages of this very document, and a watch asked to rebuild a document
	// nothing has touched answers that the pages are already right -- correctly, and
	// with no build to count. The author's own case for pressing Compile is that they
	// have just saved, so that is what this does: one comment line onto the main file.
	await P1.page.evaluate(async (o) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file(o.main, o.text + '\n// compile-handoff: cell 2\n');
	}, { main: MAIN, text: MAINTEXT });
	await plantSidecar(P1.page, { main: MAIN, rec: { imports, hashes: {}, heapMB: 40, headroom: 40 } });
	await P1.page.evaluate(() => window.DaimondTypstWatch.budgetMB(2500));
	const b2 = await openDoc(P1.page, MAIN);
	check('2. with every file here and room for the build, the button reads "Compile here"',
		!!b2 && /Compile here/i.test(b2.text) && !b2.disabled, JSON.stringify(b2));
	const p2Before = await st(P1.page) || { builds: 0, drawn: 0 };
	await P1.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	// NOT BY THE WATCH'S COUNTER. Pressing Compile goes through `compileTypst`, which
	// lays the book out to a PDF and writes `<main>-preview.pdf`; the watch's `builds`
	// and `drawn` count ITS rebuilds, and a press that produced a perfectly good preview
	// moves neither. What says the phone did the work is the file it wrote and the
	// sentence it wrote about it.
	const said2 = await saidWithin(P1.page, /Compiled/i, 300000);
	const wrote2 = await P1.page.evaluate(async (root) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		try { const b = await m.read_bytes(root + '/onthearche-preview.pdf', 0, 8);
			return !!(b && b.length); } catch (e) { return false; }
	}, ROOT);
	const p2After = await st(P1.page) || { builds: 0 };
	check('2. the phone laid it out ITSELF', said2 > 0 && wrote2 === true,
		`${(said2 / 1000).toFixed(1)}s, preview written ${wrote2}`);
	// NOT BY COUNTING THE RUNNER'S BUILDS, which cannot answer this: the chapter seeded
	// back above syncs to the runner, whose watch lays the book out for it -- 5 → 8 with
	// no errand anywhere near. What says nothing was handed off is the phone's own view:
	// `given` is cleared by a local build, and the panel says "Compiled", not "Built on".
	const msg2 = await docMsg(P1.page);
	check('2. and nothing was handed off — the pages on screen are this device’s own',
		!p2After.given && !!msg2 && !/Built on/i.test(msg2.text),
		JSON.stringify({ given: p2After.given, msg: msg2 && msg2.text }));

	// ══ CELL 3: TOO LARGE ═════════════════════════════════════════════
	//
	// Every file present; only the heap is short. Nothing about the document changed,
	// so the only thing that can move the compile is the measurement.
	await plantSidecar(P1.page, { main: MAIN, rec: { imports, hashes: {}, heapMB: 700, headroom: 60 } });
	await P1.page.evaluate(() => window.DaimondTypstWatch.budgetMB(768));
	const b3 = await openDoc(P1.page, MAIN);
	check('3. a heap the phone cannot afford moves the compile, with every file here',
		!!b3 && /Compile on/i.test(b3.text), JSON.stringify(b3));
	// BOTH FIGURES, AS THE PLACEMENT ITSELF MEASURED THEM. The sidecar's 700 + 60 is
	// what the document last COST; the need is that plus this page's own headroom, which
	// only ever grows, so the sentence's number is not the sidecar's and pinning the
	// sidecar's would pin nothing. What must hold is that the title carries the two
	// numbers the answer was taken on, and that the document's own cost is inside the
	// first of them.
	// READ OUT OF THE TITLE ITSELF, not from a second placement. Asking again answers
	// about the sidecar as it stands a moment later, and the account's own sync replaces
	// a planted sidecar with the real one from the last local build -- which is how a
	// title saying 888 and 563 came back beside a second reading of 0 and 0.
	const nums = String((b3 && b3.title) || '').match(/\d+/g) || [];
	check('3. and the title states BOTH numbers it measured, rather than asserting the case',
		nums.length >= 2 && Number(nums[0]) >= 760 && Number(nums[0]) > Number(nums[1])
		&& /MB/.test(b3.title), JSON.stringify({ title: b3 && b3.title, nums }));

	// ══ CELL 4: NOBODY IS AWAKE ═══════════════════════════════════════
	//
	// The runner's beat is aged out through the seat window rather than by waiting it
	// out, exactly as the seat-line test does. The sentence has to NAME the machine.
	// THE SAME SIDECAR, RE-PLANTED. Sync replaces it with whatever the last real build
	// recorded, and a document that FITS is placed `here` however asleep the fleet is --
	// which is a true answer to a different question from the one this cell asks.
	await plantSidecar(P1.page, { main: MAIN, rec: { imports, hashes: {}, heapMB: 700, headroom: 60 } });
	await P1.page.evaluate(() => window.DaimondTypstWatch.budgetMB(768));
	// AND THE ROSTER HAS TO HAVE HEARD THE RUNNER. Naming a sleeping machine is the
	// whole of this cell, and the roster is written by `notePlaceSeen` on the phone's
	// OWN presence tick -- every 45 s. Waited for rather than assumed: without this the
	// cell reads "No device that can do this is awake", which is a true sentence about a
	// roster that is simply empty and says nothing about the one under test.
	let onRoster = false;
	for (let i = 0; i < 40; i++) {
		onRoster = await P1.page.evaluate(() => {
			const r = window.DaimondCore.place.roster() || {};
			return Object.keys(r).some(k => r[k] && r[k].folder === true);
		}).catch(() => false);
		if (onRoster) break;
		await sleep(3000);
	}
	check('4. the phone remembers a machine that said it holds the folder', onRoster,
		JSON.stringify(await P1.page.evaluate(() => window.DaimondCore.place.roster())
			.catch(() => null)));
	const aged = await P1.page.evaluate(async (main) => {
		// Age every peer past the dispatch window, so nothing live remains.
		const p = window.DaimondPresence.snapshot();
		const old = {};
		Object.keys(p).forEach((id) => {
			old[id] = Object.assign({}, p[id], { lastSeen: Date.now() - 10 * 60 * 1000,
				servicedAt: Date.now() - 10 * 60 * 1000 });
		});
		window.DaimondPresence.forget();
		window.DaimondPresence.adopt(old);
		return await window.DaimondCore.place.forTask('compile', main);
	}, MAIN).catch(() => null);
	if (aged) {
		check('4. with nothing awake the compile is placed on NOBODY',
			aged.where === 'nobody', JSON.stringify({ where: aged.where, key: aged.key }));
		check('4. and the sentence NAMES the machine that could do it, from what it last said',
			aged.key === 'place.nobody' && !!aged.label,
			JSON.stringify({ key: aged.key, label: aged.label }));
	} else {
		cannot('4. the honest sentence when nobody is awake',
			'DaimondCore.place is not reachable from the page');
	}

	// ══ CELL 5: THE RETRY, ONCE ═══════════════════════════════════════
	//
	// A sidecar that claims everything is here, and a file that is not: the probe
	// finds nothing missing, the placement says "here", and the COMPILER is the first
	// thing to find out otherwise.
	const gone5 = await removeFrom(P1.page, HOLE[0]);
	check('5. the import the sidecar does not mention is genuinely off the phone',
		(await holds(P1.page, HOLE[0])) === false, HOLE[0] + ' — ' + gone5);
	await plantSidecar(P1.page, { main: MAIN, rec: { imports: [MAIN], hashes: {}, heapMB: 40, headroom: 40 } });
	await P1.page.evaluate(() => window.DaimondTypstWatch.budgetMB(2500));
	// The runner has to be awake again for the late answer to have anywhere to go.
	await claimPair(R.page, { runner: true, hand: true, folder: true });
	await P1.page.evaluate(() => window.DaimondSync.refreshPresence());
	await sleep(1500);
	const b5 = await openDoc(P1.page, MAIN);
	check('5. with a sidecar that claims everything is here, the button says "Compile here"',
		!!b5 && /Compile here/i.test(b5.text), JSON.stringify(b5));
	// The whole cell rests on the COMPILER being the first thing to find out, so the
	// file has to be gone at the press and not merely at the labelling -- sync puts it
	// back within a tick or two, and a local compile that SUCCEEDS proves nothing here.
	const again5 = await removeFrom(P1.page, HOLE[0]);
	check('5. and it is still gone at the moment the button is pressed',
		(await holds(P1.page, HOLE[0])) === false, HOLE[0] + ' — ' + again5);
	// AND THE LATE ANSWER HAS SOMEWHERE TO GO. The retry asks the placement again with
	// the missing file KNOWN (`placeForMissing`) and hops only if that names a runner,
	// so a cell that fails here is failing about the fleet, not about the retry.
	const late5 = await P1.page.evaluate((main) =>
		window.DaimondCore.place.forMissing('compile', main), MAIN).catch(() => null);
	check('5. and the late answer has a runner to go to',
		!!late5 && late5.where === 'runner' && !!late5.deviceId,
		JSON.stringify(late5 && { where: late5.where, label: late5.label, why: late5.why }));
	// EVERY SENTENCE THE PANEL SHOWS, kept. The retry line is written and then replaced
	// by the dispatch's own progress within a frame or two, so a poll every 250 ms
	// reports "never said it" about a sentence that was said -- which is what it did.
	await recordSaid(P1.page);
	await P1.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	const built5 = await saidWithin(P1.page, /Built on|built/i, 240000);
	const said5 = await saidSoFar(P1.page);
	check('5. the local failure is said out loud, and names where it is going instead',
		said5.some(x => /trying on/i.test(x)),
		JSON.stringify(said5.filter(x => /trying|failed|Compiling on/i.test(x)).slice(0, 3)));
	check('5. and the late answer brings the pages back', built5 > 0,
		built5 > 0 ? `${(built5 / 1000).toFixed(1)}s` : 'timed out');

	// ══ CELL 6: A DESKTOP IS UNCHANGED ════════════════════════════════
	D = await open({ name: 'cmpdesk', signIn: true, connect: true, defaults: false,
		route: routes });
	await D.page.setViewportSize({ width: 1900, height: 1000 });
	await D.page.keyboard.press('Escape');
	await sleep(1000);
	// ITS OWN ACCOUNT, so its own purchase: an unlock on one account is not an unlock
	// on another, which is the point of the entitlement.
	const packD = await makePagePro(D.page, GWDIR, GW_URL).then(() =>
		makePagePack(D.page, 'drop01', 'typst_compile', GWDIR, GW_URL));
	check('6. the plain desktop holds the typesetting pack on its OWN account',
		packD.locked === false && packD.id !== pro.id, JSON.stringify(packD));
	console.log('  ..   seeding the whole book into a plain desktop');
	await seedInto(D.page, seed);
	const placeD = await D.page.evaluate(async (main) => {
		const out = {};
		for (const k of ['compile', 'publish', 'edit', 'view', 'save']) {
			const p = await window.DaimondCore.place.forTask(k, main);
			out[k] = p.where;
		}
		return out;
	}, MAIN).catch(() => null);
	if (placeD) {
		// A desktop with the folder and the hand places everything here. This context
		// has neither (OPFS, no extension), so what is asserted is the honest half: a
		// compile it can do is placed here, and a `run` it cannot is not pretended.
		check('6. a desktop holding the whole book compiles it HERE',
			placeD.compile === 'here', JSON.stringify(placeD));
		check('6. and editing, viewing and saving are never moved anywhere',
			placeD.edit === 'here' && placeD.view === 'here' && placeD.save === 'here',
			JSON.stringify(placeD));
	} else {
		cannot('6. a desktop is unchanged', 'DaimondCore.place is not reachable from the page');
	}
	const b6 = await openDoc(D.page, MAIN);
	check('6. its button says "Compile here", with nothing to explain but that',
		!!b6 && /Compile here/i.test(b6.text), JSON.stringify(b6));
	const d6Before = await st(D.page) || { drawn: 0 };
	await D.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	const drew6 = await drewPast(D.page, d6Before.drawn, 300000);
	check('6. and pressing it lays the book out here', drew6 > 0,
		drew6 > 0 ? `${(drew6 / 1000).toFixed(1)}s` : 'timed out');
	const wrote6 = await D.page.evaluate(async (root) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const one = async (f) => {
			try { const b = await m.read_bytes(f, 0, 8); return !!(b && b.length); }
			catch (e) { return false; }
		};
		return { preview: await one(root + '/onthearche-preview.pdf'),
			final: await one(root + '/onthearche.pdf') };
	}, ROOT);
	check('6. the preview lands on <main>-preview.pdf and NEVER on the published <main>.pdf',
		wrote6.preview === true && wrote6.final === false, JSON.stringify(wrote6));

	// ══ CELL 7: NO DOUBLE COMPILE UNDER A RACE ════════════════════════
	//
	// The phone hands off, then takes it back before the report. The lease is the
	// arbiter: the runner's read-only ticker sees it revoked and stops, so one
	// document is laid out once even though two devices were asked.
	await P1.page.evaluate(() => window.DaimondTypstWatch.budgetMB(768));
	await plantSidecar(P1.page, { main: MAIN, rec: { imports, hashes: {}, heapMB: 700, headroom: 60 } });
	await claimPair(R.page, { runner: true, hand: true, folder: true });
	await P1.page.evaluate(() => window.DaimondSync.refreshPresence());
	await sleep(1000);
	const b7 = await openDoc(P1.page, MAIN);
	check('7. the race starts from a handed-off press', !!b7 && /Compile on/i.test(b7.text),
		JSON.stringify(b7));
	const r7Before = await st(R.page) || { builds: 0 };
	await P1.page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	await sleep(2500);
	// TAKE IT BACK: revoke the compile's lease, which is exactly what pressing
	// "Compile here" on the phone does to it.
	const revoked = await P1.page.evaluate(async (main) => {
		const cid = 'cmp-' + (await window.DaimondPeer.docKeyFor('', main));
		try {
			await window.DaimondLease.revoke(cid,
				window.DaimondPeer.syncCas(window.DaimondCore.place.syncShim()));
			return cid;
		} catch (e) { return 'unreachable: ' + String(e && e.message || e); }
	}, MAIN).catch((e) => 'threw: ' + String(e));
	if (/^cmp-/.test(String(revoked))) {
		await sleep(60000);
		const r7After = await st(R.page) || { builds: 0 };
		check('7. one document, one layout: the runner built at most once across the race',
			r7After.builds - r7Before.builds <= 1,
			`builds ${r7Before.builds} → ${r7After.builds}`);
	} else {
		cannot('7. the take-back revokes the compile’s lease',
			'the lease CAS is not reachable from the page: ' + revoked);
	}

	// ══ P2: THE ENGINE AN iPHONE RUNS ═════════════════════════════════
	//
	// The decision and its sentence, on WebKit. Playwright's WebKit has no OPFS, so
	// this context cannot HOLD the book at all — what it can answer is what the
	// placement says and how that reads, which is the half that reaches a person.
	P2 = await open({ name: 'cmpwebkit', signIn: false, connect: false, defaults: false,
		browser: 'webkit', touch: true, ua: IPHONE, route: routes });
	await P2.page.setViewportSize({ width: 390, height: 844 });
	await P2.page.waitForFunction(() => !!(window.DaimondPeer && window.DaimondPeer.placeTask),
		null, { timeout: 30000 }).catch(() => {});
	const opfs = await P2.page.evaluate(() =>
		!!(navigator.storage && navigator.storage.getDirectory));
	check('the WebKit context is the engine an iPhone runs, at 390px',
		/WebKit/.test(await P2.page.evaluate(() => navigator.userAgent))
		&& !/Chrome\//.test(await P2.page.evaluate(() => navigator.userAgent))
		&& (await P2.page.evaluate(() => innerWidth)) === 390);
	const wk = await P2.page.evaluate((rid) => {
		const P = window.DaimondPeer;
		const now = Date.now();
		const presence = { [rid]: { name: 'argonaut', lastSeen: now, servicedAt: now,
			runner: true, mobile: false, hand: true, folder: true } };
		const roster = { [rid]: { name: 'argonaut', lastSeen: now, hand: true, folder: true,
			mobile: false } };
		const opts = { selfId: 'phone', selfName: 'phone', roster,
			freshWindowMs: P.DISPATCH_FRESH_MS, selfMobile: true };
		const led = { deviceId: 'phone', hand: false, folder: false, mobile: true,
			budgetMB: 768, heapMB: 306, headroom: 40, files: { missing: ['book/chap3.typ'] } };
		const need = (k, h) => ({ kind: k, files: [], memoryMB: 120, hand: !!h, main: 'm.typ' });
		const live = P.placeTask(need('compile'), led, presence, opts, now);
		const pub  = P.placeTask(need('publish', true), led, presence, opts, now);
		const gone = P.placeTask(need('compile'), led, {}, opts, now);
		const say = (p) => window.DaimondI18n.t(p.key,
			{ name: p.label, n: p.n, need: p.needMB, room: p.roomMB });
		return {
			live: { where: live.where, text: say(live), why: live.why },
			pub:  { where: pub.where,  text: say(pub),  why: pub.why },
			gone: { where: gone.where, text: say(gone), key: gone.key },
		};
	}, 'a0000000000000000000000000000000').catch(() => null);
	if (wk) {
		check('P2 (WebKit) a missing file names the runner, in words a reader gets',
			wk.live.where === 'runner' && /Compile on argonaut/i.test(wk.live.text),
			JSON.stringify(wk.live));
		check('P2 (WebKit) a publish names the machine that holds the hand',
			wk.pub.where === 'runner' && /Publish on argonaut/i.test(wk.pub.text),
			JSON.stringify(wk.pub));
		check('P2 (WebKit) and with nobody awake the sentence names argonaut rather than nobody',
			wk.gone.where === 'nobody' && wk.gone.key === 'place.nobody'
			&& /argonaut/i.test(wk.gone.text), JSON.stringify(wk.gone));
	} else {
		cannot('P2 (WebKit) the placement and its sentences', 'the page did not answer');
	}
	if (!opfs) {
		cannot('P2 (WebKit) holding the book, compiling it, and drawing a hand-off',
			'Playwright’s WebKit has no OPFS — navigator.storage.getDirectory is absent, '
			+ 'so the app cannot hold a file in it');
	}
	await shot(P2, 'compile-handoff-webkit' + (BREAK ? '-' + BREAK : ''));
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	for (const s of [P2, D, P1, R]) { if (s) { try { await s.close(); } catch (e) {} } }
}

console.log(`\n${ok.length} ok, ${bad.length} failed`
	+ (unrun.length ? `, ${unrun.length} NOT RUN: ${unrun.join('; ')}` : ''));
if (bad.length) { console.log('FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
