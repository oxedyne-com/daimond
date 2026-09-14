// verify_typedit_phone.mjs — editing a `.typ` with live pages ON A PHONE.
//
// The loop this checks is the author's own: open a chapter of a 48-page book, edit
// it, save, and watch the typeset pages become the new ones. On a desktop that works
// because the source and the pages can sit side by side. On a phone one thing is on
// screen at a time, and every part of the loop broke on that one fact:
//
//   1. TWO SHEETS WERE TWO TURNS. The Doc sheet and the Preview sheet were separate
//      guests, so raising one stashed the other — and the watch, which stops when its
//      view leaves the screen, stopped with it. Silently: the bar read `live` for a
//      second, then idle, and a Save rebuilt nothing. They are ONE sheet with two
//      tabs now — Source | Pages — and both panels are raised together, so the tab
//      the reader is not looking at is merely invisible: the pages keep their scroll,
//      the loop keeps running, and a Save made on the Source tab has already
//      refreshed them by the time he turns back. Away is the sheet coming down or
//      another guest taking it, and that PAUSES rather than ends. Only a person
//      closing the pages ends the watch.
//
//   2. THE PDF WAS THE FALLBACK, AND IT IS NO USE HERE. iOS Safari draws an embedded
//      PDF as page one and nothing else, so a 48-page book arrived as one page with
//      no way to reach the rest. Nothing goes in the `<embed>` at a phone's width:
//      the live typeset pages — SVG sheets, one page each, drawn a band at a time —
//      are the only rendering, and they are the one that can be scrolled, zoomed and
//      put back where the reader was.
//
//   3. THE HEAP BUDGET WAS A DESKTOP'S. 2500 MB against a 4 GB wasm wall is right for
//      a machine that traps; iOS does not trap, it ENDS THE TAB, and the "compiler
//      bricked, reload" sentence the desktop budget buys is never read because there
//      is no page left to read it on. Measured here: this book lays out at 303 MB and
//      climbs about 32 MB a rebuild.
//
//   4. THE KEYBOARD TOOK HALF THE SCREEN AND NOBODY TOLD THE SHEET. iOS does not
//      shrink the layout viewport for a keyboard, so the line being typed sat among
//      the keys. The sheet is placed above them and the editor is scrolled so the
//      caret's own line — a WRAPPED line, measured, not counted — stays in what is
//      left. The Pages tab goes while the keyboard is up: half the room is gone and a
//      tab that would throw the typing away if a thumb brushed it is the worst thing
//      to leave beside it.
//
//   5. AND A BACKGROUNDED TAB IS A KILLED TAB. Everything typed and not saved went
//      with it, with no message, because nothing had failed. Every keystroke is kept
//      in browser storage now and offered back on the next open. It is NOT an
//      autosave: the file is untouched until Save, so the daimon's own `file_edit`
//      and the three-way sync merge are unaffected.
//
// THE BOOK IS THE AUTHOR'S OWN, copied read-only out of `~/usr/books/ontheism/
// TheOrder/Onthearche` — 17 sources, the pictures they name and the two font families
// they set — because a fixture that compiles in a tenth of a second proves nothing
// about a heap ceiling or about a save the reader waits on.
//
// TWO ENGINES (`feedback_two_device_features_need_two_context_verifier`): Chromium
// with an iPhone UA at 390x844, which is where the OPFS half runs, and WebKit at the
// same size, which is the engine an iPhone actually runs. PLAYWRIGHT'S WEBKIT HAS NO
// OPFS (`reference_playwright_webkit`) — `navigator.storage.getDirectory` is absent,
// so the app cannot hold a file in it and nothing that needs one can run there. What
// can is run and what cannot is NAMED on the count line, never skipped in silence.
// A desktop Chromium at 1900px stands beside them both, asserting that none of this
// cost the three-seat layout anything.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page, and the run is expected
// to FAIL. A break whose anchor does not appear exactly once aborts rather than
// passing quietly.
//
//   node dev/verify_typedit_phone.mjs --break notabs      # 1 fails: two sheets again
//   node dev/verify_typedit_phone.mjs --break embedon     # 2 fails: the PDF is back
//   node dev/verify_typedit_phone.mjs --break stoponhide  # 5 fails: a tab ends the watch
//   node dev/verify_typedit_phone.mjs --break deskbudget  # 7 fails: a desktop ceiling
//   node dev/verify_typedit_phone.mjs --break keeptab     # 8 fails: the tab stays up
//   node dev/verify_typedit_phone.mjs --break nocaret     # 9 fails: typing behind the keys
//   node dev/verify_typedit_phone.mjs --break nodraft    # 10 fails: the typing is lost
//   node dev/verify_typedit_phone.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 35 --up)"
//   node dev/verify_typedit_phone.mjs
//
// No gateway and no model: every compile here is the real vendored typst, and the
// only network is localhost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

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

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The Doc and the Preview are two guests again, so raising one stashes the other
	// and the loop has no surface it can live on.
	notabs: [{
		file: 'js/mobile.js',
		find: '\tvar FACES = { doc: \'preview\' };',
		with: '\tvar FACES = {};',
	}],
	// The PDF goes back in the `<embed>`, which on the engine this width stands for
	// is a picture of page one with forty-seven pages behind it that cannot be
	// reached.
	embedon: [{
		file: 'js/daimond.js',
		find: '\t\tvar narrow = !!(window.DaimondShell && DaimondShell.isPhone());',
		with: '\t\tvar narrow = false;',
	}],
	// Hiding the pages ends the watch, which is what the Source tab does every time
	// the reader goes to type.
	stoponhide: [{
		file: 'js/typstwatch.js',
		find: '\tif (S.seen && !shown) { pause(); return; }',
		with: '\tif (S.seen && !shown) { stop(); return; }',
	}],
	// The desktop's ceiling on a phone: 2500 MB against an engine that ends the tab
	// somewhere far below it and says nothing.
	deskbudget: [{
		file: 'js/typstwatch.js',
		find: '\tif (onPhone()) S.budget = Math.min(S.budget, BUDGET_MOBILE);',
		with: '\t/* budget left at the desktop default */',
	}],
	// The other tab stays beside the caret while the keyboard is up, one thumb-width
	// from throwing the typing away.
	keeptab: [{
		file: 'js/mobile.js',
		find: '\t\tif (tabsEl) tabsEl.classList.toggle(\'typing\', !!on);',
		with: '\t\tif (tabsEl) tabsEl.classList.toggle(\'typing\', false);',
	}],
	// The caret is left wherever the shrinking viewport put it, which is behind the
	// keyboard for any line but the first few.
	nocaret: [{
		file: 'js/mobile.js',
		find: '\t\tif (r.bottom > hi) ta.scrollTop += (r.bottom - hi);\n'
			+ '\t\telse if (r.top < lo) ta.scrollTop -= (lo - r.top);',
		with: '\t\tvoid hi; void lo;',
	}],
	// Nothing is kept, so a tab the system ends takes every unsaved character with
	// it — which is the whole of the fault, and it looks like nothing happening.
	nodraft: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tlocalStorage.setItem(DRAFT_KEY + path,\n'
			+ '\t\t\t\t\tJSON.stringify({ text: text, base: base, at: Date.now() }));',
		with: '\t\t\t\tvoid text; void base;',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// `src` with `spec` applied, or a hard stop.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// Serve every break's damage, one body per file.
async function routes(page) {
	if (!BREAK) return;
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	for (const [file, body] of byFile) {
		const type = /\.css$/.test(file) ? 'text/css' : 'application/javascript';
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: type, body }));
	}
}

// ── The book, copied ─────────────────────────────────────────────────
//
// READ-ONLY AT SOURCE. This run edits a chapter and compiles over the PDF beside it,
// and the original is the author's live manuscript — so the sources are copied into
// the scratch root first and every read below is of the copy.
const SRC  = path.join(process.env.HOME, 'usr/books/ontheism/TheOrder/Onthearche');
const COPY = scratch('typedit-phone' + (BREAK ? '-' + BREAK : ''), 'book');
const ROOT = 'ontheism/TheOrder/Onthearche';		// where it lands in the workspace
const MAIN = ROOT + '/onthearche.typ';
const CHAP = ROOT + '/chap_practice.typ';

if (!fs.existsSync(path.join(SRC, 'onthearche.typ'))) {
	console.error('the book is not at ' + SRC + '; nothing to seed.');
	process.exit(2);
}
fs.rmSync(COPY, { recursive: true, force: true });
fs.mkdirSync(COPY, { recursive: true });
for (const n of fs.readdirSync(SRC)) {
	if (/\.typ$/i.test(n)) fs.copyFileSync(path.join(SRC, n), path.join(COPY, n));
}

/// Everything the workspace is seeded with: `[path, text | byte array]`.
///
/// THE PICTURES AND THE FONTS ARE NOT DECORATION HERE. The Rust gatherer walks
/// `assets/fonts` outward from the main and reads the bytes; a book that sets Felipa
/// and Libertinus Serif is REFUSED outright without them, so a seed of sources alone
/// would check the refusal rather than the loop.
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

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// Write the seed through the app's own doors, in small batches: one `evaluate`
/// carrying four megabytes of font is a message nobody needs to send.
async function seedInto(page) {
	for (let i = 0; i < seed.length; i += 8) {
		await page.evaluate(async (files) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			for (const f of files) {
				if (typeof f[1] === 'string') await m.write_file(f[0], f[1]);
				else await app.write_bytes(f[0], new Uint8Array(f[1]));
			}
		}, seed.slice(i, i + 8));
	}
}

/// This world stands up no gateway, so `/api` answers 502 and a favicon is missing:
/// neither is the app throwing, and neither is what this file is about.
const quiet = (s) => errors(s).filter(
	x => !/favicon|net::ERR|Failed to load resource/.test(x));

const st = (page) => page.evaluate(() => window.DaimondTypstWatch.state());
const sheet = (page) => page.evaluate(() => {
	const t = document.getElementById('msheet-tabs');
	const body = document.getElementById('msheet-body');
	const box = (e) => {
		if (!e) return null;
		const r = e.getBoundingClientRect();
		return { top: Math.round(r.top), bottom: Math.round(r.bottom),
			w: Math.round(r.width), h: Math.round(r.height) };
	};
	return {
		guest: window.DaimondSheet ? DaimondSheet.guest() : null,
		face:  window.DaimondSheet ? DaimondSheet.face() : null,
		tabsHidden: !t || t.hidden,
		typing: !!(t && t.classList.contains('typing')),
		tabs: t ? Array.from(t.querySelectorAll('.msheet-tab')).map(b => ({
			face: b.dataset.face, text: b.textContent,
			on: b.classList.contains('on'),
			shown: !!(b.offsetWidth || b.offsetHeight),
		})) : [],
		docIn: !!(body && body.contains(document.getElementById('panel-doc'))),
		pvIn:  !!(body && body.contains(document.getElementById('panel-preview'))),
		sheetBox: box(document.getElementById('msheet')),
		kb: document.getElementById('msheet')
			? getComputedStyle(document.getElementById('msheet')).getPropertyValue('--kb').trim() : '',
	};
});

/// What is actually drawn: one SVG sheet per page in view, inside the shadow root.
const drawn = (page) => page.evaluate(() => {
	const host = document.getElementById('typst-live');
	const pages = host && host.querySelector('.tl-pages');
	const e = document.getElementById('doc-embed');
	const svgs = pages ? Array.from(pages.shadowRoot.querySelectorAll('svg')) : [];
	return {
		live: !!host,
		shown: !!(host && (host.offsetWidth || host.offsetHeight)),
		sheets: svgs.length,
		tallest: svgs.reduce((a, s) => Math.max(a, Math.round(s.getBoundingClientRect().height)), 0),
		ink: svgs.reduce((a, s) => a + s.querySelectorAll('path, use, g').length, 0),
		// EVERY `<embed>` IN THE DOCUMENT, not just this one, and whether any of them
		// is on screen or holding bytes. The claim is about the page, not the element.
		embeds: Array.from(document.querySelectorAll('embed')).map(x => ({
			id: x.id, src: x.getAttribute('src') || '',
			shown: !!(x.offsetWidth || x.offsetHeight),
		})),
	};
});

/// Wait until `drawn` has moved past `was`, or give up after `ms`.
async function rebuilt(page, was, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const s = await st(page);
		if (s.drawn > was) return Date.now() - t0;
		await sleep(200);
	}
	return -1;
}

let phone, desk, wk;
try {
	// ── THE PHONE ────────────────────────────────────────────────────
	phone = await open({ name: 'typeditphone' + (BREAK ? '-' + BREAK : ''), touch: true,
		ua: IPHONE, route: routes });
	const p = phone.page;
	// The harness leaves the Admin dialog up, and it covers the screen.
	await p.keyboard.press('Escape');
	await sleep(400);
	await p.setViewportSize({ width: 390, height: 844 });
	await sleep(700);
	check('the phone context is 390px wide and says it is an iPhone',
		(await p.evaluate(() => innerWidth)) === 390
		&& /iPhone/.test(await p.evaluate(() => navigator.userAgent)),
		await p.evaluate(() => innerWidth + 'px'));

	console.log(`  ..   seeding ${seed.length} file(s) of the book`);
	await seedInto(p);

	// ── 1. One sheet, two tabs ───────────────────────────────────────
	await p.evaluate((f) => window.DaimondDoc.show(f), MAIN);
	await sleep(1200);
	const s1 = await sheet(p);
	check('the Doc sheet carries Source | Pages, and both panels are in it',
		!s1.tabsHidden && s1.tabs.length === 2
		&& s1.tabs[0].face === 'doc' && s1.tabs[1].face === 'preview'
		&& /Source/i.test(s1.tabs[0].text) && /Pages/i.test(s1.tabs[1].text)
		&& s1.docIn && s1.pvIn,
		JSON.stringify({ tabs: s1.tabs.map(t => t.face + ':' + t.text), docIn: s1.docIn, pvIn: s1.pvIn }));

	// ── 2. Compile draws pages, and nothing goes in the embed ────────
	const t0 = Date.now();
	await p.evaluate(() => document.querySelector('[data-act="compile"]').click());
	const cold = await rebuilt(p, 0, 180000);
	const w2 = await st(p);
	check('⚙ Compile on the main lays the whole book out on the phone',
		cold > 0 && w2.pages > 40 && w2.mode === 'live',
		`${w2.pages} pages, ${(cold / 1000).toFixed(1)}s cold, mode ${w2.mode}`
		+ (w2.error ? ' — ' + w2.error.slice(0, 160) : ''));
	await sleep(900);
	const d2 = await drawn(p);
	check('and they are DRAWN PAGES, one sheet per page, not a PDF',
		d2.live && d2.shown && d2.sheets > 1 && d2.ink > 100,
		`${d2.sheets} sheet(s), ${d2.ink} marks, tallest ${d2.tallest}px`);
	check('NO `<embed>` IS ON THE PAGE AT A PHONE’S WIDTH: none shown, none holding bytes',
		d2.embeds.every(x => !x.shown && !x.src),
		JSON.stringify(d2.embeds));
	const s2 = await sheet(p);
	check('and compiling turned the sheet to its Pages tab',
		s2.face === 'preview' && s2.tabs[1].on, JSON.stringify({ face: s2.face }));
	await shot(phone, 'typedit-phone-01-pages' + (BREAK ? '-' + BREAK : ''));

	// ── Two fingers on the pages ─────────────────────────────────────
	//
	// REAL TOUCH POINTS THROUGH CDP, so the browser's own gesture arbitration
	// decides what the second finger is for — the same route `probe_typstphone.mjs`
	// drives the sheet's nested scroller with. A scripted `zoom()` call would prove
	// the function and nothing about whether a finger can reach it.
	const zoomWas = (await st(p)).zoom;
	const sbox = await p.evaluate(() => {
		const e = document.querySelector('#typst-live .tl-scroll');
		const r = e.getBoundingClientRect();
		return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
	});
	const cdp = await p.context().newCDPSession(p);
	const two = (d) => [
		{ x: Math.round(sbox.cx - d), y: Math.round(sbox.cy), radiusX: 8, radiusY: 8, force: 1, id: 1 },
		{ x: Math.round(sbox.cx + d), y: Math.round(sbox.cy), radiusX: 8, radiusY: 8, force: 1, id: 2 },
	];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: two(40) });
	for (let i = 1; i <= 10; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: two(40 + i * 8) });
		await sleep(25);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await sleep(700);
	const zoomed = await st(p);
	check('TWO FINGERS ZOOM THE PAGES, and nothing reaches the compiler',
		zoomed.zoom > zoomWas * 1.5 && zoomed.builds === w2.builds,
		`zoom ${zoomWas} → ${zoomed.zoom}, builds ${w2.builds} → ${zoomed.builds}`);
	await p.evaluate(() => window.DaimondTypstWatch.zoom(1));
	await sleep(400);

	// ── 3. Edit the chapter, save, and the pages follow ──────────────
	// Through the app's own editor, which is what the reader uses: the Source tab,
	// ✎ Edit, type, ✔ Save. Not a `write_file` behind its back.
	// A PAGE DEEP IN THE BOOK, not page one. "The place is kept" is trivially true at
	// the top -- a rebuild that threw the scroll away would land there and look right
	// -- so the reader is put on page twelve and it is page twelve that has to survive.
	await p.evaluate(() => window.DaimondTypstWatch.goToPage(12));
	await sleep(700);
	const at3 = (await st(p)).at;
	const page3 = at3 ? at3.page : 0;
	await p.evaluate((f) => window.DaimondDoc.show(f), CHAP);
	await sleep(1000);
	await p.evaluate(() => DaimondSheet.tab('doc'));
	await sleep(400);
	await p.evaluate(() => document.querySelector('[data-act="edit"]').click());
	await sleep(500);
	const b3 = (await st(p)).drawn;
	const t3 = Date.now();
	await p.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		ta.value = ta.value + '\n\nA sentence the verifier typed.\n';
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await p.evaluate(() => document.querySelector('[data-act="edit"]').click());   // ✔ Save
	const took3 = await rebuilt(p, b3, 20000);
	const w3 = await st(p);
	check('a chapter saved from the Source tab refreshes the Pages within 10s',
		took3 > 0 && took3 < 10000,
		took3 > 0 ? `${(took3 / 1000).toFixed(1)}s (save→drawn), build ${w3.builds}`
			: 'no rebuild in 20s');
	check('and the reader is still on the page he was on, twelve pages in',
		!!w3.at && w3.at.page === page3 && page3 >= 10,
		`page ${w3.at ? w3.at.page : '?'} of ${w3.pages}, was ${page3}`);

	// ── 4/5. Away to another sheet, and back ─────────────────────────
	await p.evaluate(() => DaimondPanels.show('tools'));
	await sleep(2500);
	const away = await st(p);
	check('LEAVING THE DOC SHEET PAUSES THE WATCH RATHER THAN ENDING IT',
		away.mode === 'paused' && away.path === MAIN,
		`mode ${away.mode}, path "${away.path}"`);
	await p.evaluate((f) => window.DaimondDoc.show(f), CHAP);
	await sleep(1500);
	const back = await st(p);
	check('and coming back arms it again',
		back.mode === 'live' && back.path === MAIN, `mode ${back.mode}`);
	const b5 = (await st(p)).drawn;
	await p.evaluate(() => DaimondSheet.tab('doc'));
	await sleep(300);
	await p.evaluate(() => document.querySelector('[data-act="edit"]').click());
	await sleep(400);
	await p.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		ta.value = ta.value + '\nAnd a second sentence.\n';
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await p.evaluate(() => document.querySelector('[data-act="edit"]').click());
	const took5 = await rebuilt(p, b5, 20000);
	check('ONE MORE SAVE STILL REFRESHES THE PAGES after the round trip',
		took5 > 0 && took5 < 10000,
		took5 > 0 ? `${(took5 / 1000).toFixed(1)}s` : 'no rebuild in 20s');

	// ── 6/7. The heap ────────────────────────────────────────────────
	const w6 = await st(p);
	check('the phone gets the PHONE’S ceiling, not the desktop’s',
		w6.budget <= 768, `${w6.budget} MB`);
	let worst = 0;
	for (let r = 0; r < 3; r++) {
		const b = (await st(p)).drawn;
		await p.evaluate(async (a) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const t = await m.read_file(a.chap);
			await m.write_file(a.chap, t + '\n// rebuild ' + a.r + '\n');
		}, { chap: CHAP, r });
		await rebuilt(p, b, 30000);
		const s = await st(p);
		worst = Math.max(worst, s.heap);
	}
	const w7 = await st(p);
	check('and five rebuilds of a 48-page book stay under it, still live',
		worst > 0 && worst < w7.budget && w7.mode === 'live',
		`worst heap ${Math.round(worst)} MB of ${w7.budget}, ${w7.builds} builds, mode ${w7.mode}`);

	// ── A BACKGROUNDED PHONE HOLDS NOTHING IT CAN BUILD AGAIN ────────
	//
	// iOS reclaims a backgrounded tab by ENDING it, and what it weighs is everything
	// the page holds. The vector artifact is the largest single thing here, so it is
	// let go on the way out and built again on the way back — the pages already
	// drawn stay on screen throughout, which is what stops this being a blank.
	//
	// `document.hidden` is posed rather than driven: no driver can background a tab,
	// and the handler reads exactly that property.
	const held8 = (await st(p)).holds;
	await p.evaluate(() => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await sleep(600);
	const gone = await st(p);
	check('BACKGROUNDED, THE PHONE LETS THE LAID-OUT BOOK GO and pauses',
		held8 > 0 && gone.holds === 0 && gone.mode === 'paused',
		`held ${Math.round(held8 / 1024)} KiB → ${gone.holds}, mode ${gone.mode}`);
	const pagesStill = await drawn(p);
	check('and the pages the reader was on are still on the screen he comes back to',
		pagesStill.sheets > 0 && pagesStill.ink > 100,
		`${pagesStill.sheets} sheet(s), ${pagesStill.ink} marks`);
	const b8 = gone.drawn;
	await p.evaluate(() => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	const took8 = await rebuilt(p, b8, 30000);
	const backUp = await st(p);
	check('and coming back builds it once and holds it again',
		took8 > 0 && backUp.holds > 0 && backUp.mode === 'live',
		took8 > 0 ? `${(took8 / 1000).toFixed(1)}s, holding ${Math.round(backUp.holds / 1024)} KiB`
			: 'nothing rebuilt in 30s');

	// ── 8/9. The keyboard ────────────────────────────────────────────
	await p.evaluate(() => DaimondSheet.tab('doc'));
	await sleep(300);
	await p.evaluate(() => document.querySelector('[data-act="edit"]').click());
	await sleep(400);
	// A caret a long way down the file, which is where a chapter is actually edited.
	await p.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		ta.focus();
		const at = Math.floor(ta.value.length * 0.75);
		ta.setSelectionRange(at, at);
		ta.dispatchEvent(new Event('click', { bubbles: true }));
	});
	await sleep(500);
	const s8 = await sheet(p);
	check('WITH THE EDITOR FOCUSED THE PAGES TAB STEPS ASIDE',
		s8.typing && s8.tabs.filter(t => t.shown).length === 1 && s8.tabs[0].shown,
		JSON.stringify(s8.tabs.map(t => t.face + (t.shown ? ':shown' : ':gone'))));
	// The keyboard, posed as the viewport change it is: iOS gives the page a shorter
	// visual viewport and the app has nothing else to go on.
	// 508px of page left, which is an iPhone's 844 less the ~336 its keyboard takes.
	// A driver cannot shrink the VISUAL viewport alone, so the layout one stands in
	// for it -- which is exactly what an Android browser does anyway, and what `maxH`
	// and `kbH` between them read either way.
	await p.setViewportSize({ width: 390, height: 508 });
	await sleep(900);
	const caret = await p.evaluate(() => {
		const r = window.DaimondSheet.caretRect();
		const ta = document.querySelector('.files-edit');
		const b = ta ? ta.getBoundingClientRect() : null;
		return r ? {
			top: Math.round(r.top), bottom: Math.round(r.bottom),
			seen: { top: Math.round(r.seen.top), bottom: Math.round(r.seen.bottom) },
			box: b ? { top: Math.round(b.top), bottom: Math.round(b.bottom) } : null,
			inner: window.innerHeight,
		} : null;
	});
	check('AND THE CARET’S OWN LINE IS STILL ON SCREEN, above where the keys are',
		!!caret && caret.top >= caret.seen.top && caret.bottom <= caret.seen.bottom
		&& !!caret.box && caret.top >= caret.box.top - 1 && caret.bottom <= caret.box.bottom + 1,
		JSON.stringify(caret));
	await shot(phone, 'typedit-phone-02-typing' + (BREAK ? '-' + BREAK : ''));
	await p.setViewportSize({ width: 390, height: 844 });
	await sleep(600);

	// ── 10. A killed tab loses nothing ───────────────────────────────
	const TYPED = '\nA paragraph typed and never saved.\n';
	await p.evaluate((typed) => {
		const ta = document.querySelector('.files-edit');
		ta.value = ta.value + typed;
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	}, TYPED);
	await sleep(400);
	// The tab is ENDED, not closed politely: a reload is the nearest thing a driver
	// has to iOS reclaiming the page, and nothing gets a chance to save on the way.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => !!(window.DaimondDoc && window.DaimondSheet), null, { timeout: 30000 });
	await sleep(1500);
	await p.evaluate((f) => window.DaimondDoc.show(f), CHAP);
	await sleep(1500);
	const restored = await p.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		const m = document.querySelector('.files-view-msg');
		return { has: !!ta, text: ta ? ta.value.slice(-60) : '',
			msg: m && m.style.display !== 'none' ? (m.textContent || '').trim() : '' };
	});
	check('AFTER A KILLED TAB THE UNSAVED PARAGRAPH IS BACK, and a line says so',
		restored.has && restored.text.indexOf('typed and never saved') >= 0
		&& /restor/i.test(restored.msg),
		JSON.stringify({ tail: restored.text.replace(/\n/g, '\\n'), msg: restored.msg.slice(0, 90) }));

	check('no console error in the phone context', quiet(phone).length === 0,
		quiet(phone).slice(0, 2).join(' | '));

	// ── THE DESKTOP, UNCHANGED ───────────────────────────────────────
	desk = await open({ name: 'typeditdesk' + (BREAK ? '-' + BREAK : ''), route: routes });
	const q = desk.page;
	await q.keyboard.press('Escape');
	await sleep(400);
	await q.setViewportSize({ width: 1900, height: 1000 });
	await sleep(800);
	await seedInto(q);
	await q.evaluate((f) => window.DaimondDoc.show(f), MAIN);
	await sleep(1200);
	await q.evaluate(() => document.querySelector('[data-act="compile"]').click());
	await rebuilt(q, 0, 180000);
	await sleep(1200);
	await q.evaluate((f) => window.DaimondDoc.show(f), CHAP);
	await sleep(1500);
	const seats = await q.evaluate(() => {
		const stage = document.getElementById('stage');
		const up = Array.from(stage.querySelectorAll('.panel')).filter(
			e => e.offsetWidth || e.offsetHeight).map(e => e.id);
		const t = document.getElementById('msheet-tabs');
		const e = document.getElementById('doc-embed');
		return { up, sheetOpen: document.body.classList.contains('sheet-open'),
			tabsHidden: !t || t.hidden,
			embed: { src: !!e.getAttribute('src'), display: e.style.display } };
	});
	check('THE DESKTOP STILL SEATS THREE at 1900px — chat, source and pages together',
		seats.up.indexOf('panel-ai') >= 0 && seats.up.indexOf('panel-doc') >= 0
		&& seats.up.indexOf('panel-preview') >= 0,
		seats.up.join(' '));
	check('and the phone shell is nowhere near it: no sheet, no tab strip',
		!seats.sheetOpen && seats.tabsHidden, JSON.stringify(seats));
	const b9 = (await st(q)).drawn;
	await q.evaluate(async (chap) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const t = await m.read_file(chap);
		await m.write_file(chap, t + '\n// desktop edit\n');
	}, CHAP);
	const took9 = await rebuilt(q, b9, 20000);
	check('the desktop loop is untouched: an edit still rebuilds beside the source',
		took9 > 0, took9 > 0 ? `${(took9 / 1000).toFixed(1)}s` : 'no rebuild in 20s');
	// And the pause property on the desktop, where it is the two-seat eviction rather
	// than a tab: hiding the panel keeps the watch, closing it ends the watch.
	await q.evaluate(() => { document.getElementById('panel-preview').style.display = 'none'; });
	await sleep(2500);
	const hidden9 = await st(q);
	check('a preview pushed off screen PAUSES on the desktop too, keeping its path',
		hidden9.mode === 'paused' && hidden9.path === MAIN,
		`mode ${hidden9.mode}, path "${hidden9.path}"`);
	await q.evaluate(() => { document.getElementById('panel-preview').style.display = ''; });
	await sleep(2500);
	check('and it comes back live when the panel does',
		(await st(q)).mode === 'live', (await st(q)).mode);
	await shot(desk, 'typedit-desk-1900' + (BREAK ? '-' + BREAK : ''));
	check('no console error in the desktop context', quiet(desk).length === 0,
		quiet(desk).slice(0, 2).join(' | '));

	// ── WEBKIT, THE ENGINE AN IPHONE RUNS ────────────────────────────
	wk = await open({ name: 'typeditwk' + (BREAK ? '-' + BREAK : ''), browser: 'webkit',
		touch: true, ua: IPHONE, connect: false, route: routes });
	const k = wk.page;
	await k.setViewportSize({ width: 390, height: 844 });
	await k.waitForFunction(() => !!(window.DaimondSheet && window.DaimondPanels), null, { timeout: 30000 });
	await sleep(800);
	const opfs = await k.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory));
	check('the WebKit context is the engine an iPhone runs, at 390px',
		/WebKit/.test(await k.evaluate(() => navigator.userAgent))
		&& !/Chrome\//.test(await k.evaluate(() => navigator.userAgent))
		&& (await k.evaluate(() => innerWidth)) === 390);
	await k.evaluate(() => DaimondPanels.show('doc'));
	await sleep(1200);
	const sk = await sheet(k);
	check('WebKit raises the same one sheet with Source | Pages',
		!sk.tabsHidden && sk.tabs.length === 2 && sk.docIn && sk.pvIn,
		JSON.stringify({ tabs: sk.tabs.map(t => t.face), docIn: sk.docIn, pvIn: sk.pvIn }));
	await k.evaluate(() => DaimondSheet.tab('preview'));
	await sleep(400);
	const sk2 = await sheet(k);
	check('and the tabs swap which panel is on screen, keeping both mounted',
		sk2.face === 'preview' && sk2.docIn && sk2.pvIn
		&& (await k.evaluate(() => document.getElementById('panel-doc')
			.classList.contains('msheet-face-off'))),
		JSON.stringify({ face: sk2.face }));
	await shot(wk, 'typedit-webkit-tabs' + (BREAK ? '-' + BREAK : ''));
	if (!opfs) {
		cannot('WebKit: compile, save→refresh, heap and the restored draft',
			'Playwright’s WebKit has no OPFS — navigator.storage.getDirectory is absent, '
			+ 'so the app cannot hold the book');
	} else {
		cannot('WebKit: the OPFS half', 'unexpectedly present; this run did not use it');
	}
	check('no console error in the WebKit context', quiet(wk).length === 0,
		quiet(wk).slice(0, 2).join(' | '));
} finally {
	for (const s of [phone, desk, wk]) { if (s) { try { await s.close(); } catch (e) {} } }
}

console.log(`\n${ok.length} ok, ${bad.length} failed`
	+ (unrun.length ? `, ${unrun.length} NOT RUN: ${unrun.join('; ')}` : ''));
if (bad.length) { console.log('FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
