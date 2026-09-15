// verify_social.mjs — Phase 1 of the Social panel: the panel, the badge, the chip.
//
// Three things landed together and each has its own way of looking finished
// while doing nothing:
//
//   1. THE PANEL, renamed from Improve (decision 13). A rename is four
//      hand-wired seams as well as the markup, and every one of them fails
//      QUIETLY: without its `MOBILE_GUESTS` key the panel is a BLANK SCREEN on a
//      phone; without its `onOpen` dispatch it opens and draws nothing; without
//      its `NO_ASK` key the sheet offers an ask pill over a box you write in;
//      and `telemetry.js` holds the panel as an ORDINAL, so a rename that MOVED
//      it changes the meaning of every number already gathered.
//   2. THE DOCK COUNT BADGE. With Web Push declined this is the app's only
//      notification, and the two ways it can be wrong are drawing a zero and
//      counting what the reader is already looking at.
//   3. THE REFERENCE CHIP, and the five rules of §4.3 — resolved by the reader,
//      never disclosing what the reader cannot see, never a URL, at most four,
//      and LAZY.
//
// THE TRAP THIS FILE IS WRITTEN AROUND. A verifier here once shipped green
// while proving nothing, by asserting that `dataset.mpanel` had been SET rather
// than that anything was on the screen. And an absent element reports itself to
// a browser locator as HIDDEN, so a check that only asks "is it hidden" passes
// over a button that does not exist. So, throughout:
//
//   - anything asserted to be hidden is COUNTED first;
//   - anything asserted to be visible is measured with `getBoundingClientRect()`
//     and required to have real area inside the viewport — not an ancestry
//     check, and never `dataset.mpanel`.
//
// Needs `dev/serve.mjs` (DAIMOND_PORT, default 8777) and `dev/mockllm.mjs`.
// `bash dev/world.sh N --up` prints a matching set.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file and the run is expected to FAIL. A
// break whose anchor is not there exactly once ABORTS rather than passing
// quietly, which is how the last stale break in this tree was found.
//
//   node dev/verify_social.mjs --break nochip      # 1e a chip has gone
//   node dev/verify_social.mjs --break swapchip    # 1f two chips have swapped
//   node dev/verify_social.mjs --break sixthchip   # 1g a sixth arrived unannounced
//   node dev/verify_social.mjs --break noguest     # 1a the panel is blank on a phone
//   node dev/verify_social.mjs --break noask       # 1b the sheet offers an ask pill
//   node dev/verify_social.mjs --break moveord     # 1c the telemetry ordinal moved
//   node dev/verify_social.mjs --break bootblind   # 1d a panel open at boot is never told
//   node dev/verify_social.mjs --break zerobadge   # 2a the badge draws a 0
//   node dev/verify_social.mjs --break badgeblind  # 2b it counts what you are looking at
//   node dev/verify_social.mjs --break badgestuck  # 2c looking at it does not clear it
//   node dev/verify_social.mjs --break badgenosave # 2d the reading is never written
//   node dev/verify_social.mjs --break fiveref     # 3a a fifth reference is drawn
//   node dev/verify_social.mjs --break eagerref    # 3b every chip resolves on sight
//   node dev/verify_social.mjs --break senderlabel # 3c the sender names the thing
//   node dev/verify_social.mjs --break refhref     # 3d a reference is drawn as a link
//   node dev/verify_social.mjs --break msgname     # 4  two panels called Message
//   node dev/verify_social.mjs                     # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The breaks ───────────────────────────────────────────────────────
//
// Each is a real edit to a real source file, served in place of it. `find` is a
// literal; `re` is a SHAPE, used wherever the anchor sits inside something that
// is edited often — a table of panels, say. The literal form there is what went
// stale in `verify_mobile.mjs`: it pinned four lines of `MOBILE_GUESTS`, three
// panels were added to the table afterwards, and the break silently stopped
// applying at all.
const BREAKS = {
	noguest: [{
		file: 'js/daimond.js',
		re:   /var MOBILE_GUESTS = \{[\s\S]*?\n\t\};/,
		with: 'var MOBILE_GUESTS = { web: 1, doc: 1, msg: 1, compose: 1, tools: 1, '
			+ 'spend: 1, term: 1, trash: 1 };',
	}],
	// The three ways a head of chips goes wrong, and they are three because one
	// assertion has to redden for all of them: a set membership test would pass
	// `swapchip`, and a count would pass it too.
	nochip: [{
		file: 'index.html',
		find: '\t\t\t\t\t<button type="button" class="imp-chip" data-view="people" aria-pressed="false" data-i18n="social.people">People</button>\n',
		with: '',
	}],
	swapchip: [{
		file: 'index.html',
		find: '<button type="button" class="imp-chip" data-view="messages" aria-pressed="false" data-i18n="social.messages">Messages</button>\n'
			+ '\t\t\t\t\t<button type="button" class="imp-chip" data-view="people" aria-pressed="false" data-i18n="social.people">People</button>',
		with: '<button type="button" class="imp-chip" data-view="people" aria-pressed="false" data-i18n="social.people">People</button>\n'
			+ '\t\t\t\t\t<button type="button" class="imp-chip" data-view="messages" aria-pressed="false" data-i18n="social.messages">Messages</button>',
	}],
	// Untranslated on purpose: a chip nobody decided on is a chip nobody put
	// through the eight locale files either.
	sixthchip: [{
		file: 'index.html',
		find: '<button type="button" class="imp-chip" data-view="proposals" aria-pressed="false" data-i18n="social.proposals">Feedback</button>',
		with: '<button type="button" class="imp-chip" data-view="proposals" aria-pressed="false" data-i18n="social.proposals">Feedback</button>\n'
			+ '\t\t\t\t\t<button type="button" class="imp-chip" data-view="extra" aria-pressed="false">Extra</button>',
	}],
	noask: [{
		file: 'js/mobile.js',
		re:   /var NO_ASK\s*=\s*\{[^}]*\}/,
		with: 'var NO_ASK       = { compose: 1, tools: 1, trash: 1 }',
	}],
	// Renamed AND moved. The panel still works; every panel number already
	// gathered under 16 now means something else.
	moveord: [{
		file: 'js/telemetry.js',
		re:   /'social', 'pending'\]/,
		with: "'pending', 'social']",
	}],
	// A panel that was already open when the app booted is never `show`n, so
	// nothing else would ever call its `onOpen`.
	bootblind: [{
		file: 'js/daimond.js',
		find: "\t\tif (window.DaimondSocial && DaimondPanels.isOpen('social')) { DaimondSocial.onOpen(); postBadge(); }",
		with: "\t\tif (false) { DaimondSocial.onOpen(); postBadge(); }",
	}],
	// A badge that draws its zero. Everything else about it stays right, which
	// is the point: this is the check that tells "it counts" from "it is a mark
	// you have to read before you can ignore it".
	zerobadge: [{
		file: 'js/daimond.js',
		find: "\t\t\tb.textContent = n ? String(n) : '';\n\t\t\tb.hidden = !n;",
		with: "\t\t\tb.textContent = String(n);\n\t\t\tb.hidden = false;",
	}],
	// It counts what is in front of the reader. The number is otherwise correct.
	badgeblind: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tif (!n || visible(id)) return;',
		with: '\t\t\t\tif (!n) return;',
	}],
	// The reading is held in memory and never written, so the count comes back on
	// the next reload and the reader is told twice about a message they have
	// already read. The badge is otherwise exactly right, which is the point.
	badgenosave: [{
		file: 'js/post.js',
		find: '\t\tif (!n) return 0;\n\t\tsave();\n\t\tcountChanged();',
		with: '\t\tif (!n) return 0;\n\t\tcountChanged();',
	}],
	// Looking at the panel does not clear it, so the mark outlives the thing it
	// was about and stops meaning anything.
	badgestuck: [{
		file: 'js/daimond.js',
		find: "\t\t\tseen: function (id) {\n\t\t\t\tif (!(counts[id] | 0)) return;",
		with: "\t\t\tseen: function (id) {\n\t\t\t\tif (true) return;",
	}],
	// R4 off: a message may draw as many references as it carries.
	fiveref: [{
		file: 'js/improve.js',
		find: 'for (var i = 0; i < list.length && out.length < 4; i++) {',
		with: 'for (var i = 0; i < list.length; i++) {',
	}],
	// R5 off: every chip resolves as it is drawn. Ten proposal chips on an inbox
	// opening is ten metered requests against the reader's own allowance.
	eagerref: [{
		file: 'js/improve.js',
		find: '\t\trefs.forEach(function (r) { host.appendChild(refChip(r)); });',
		with: '\t\trefs.forEach(function (r) { host.appendChild(refChip(r)); resolve(r); });',
	}],
	// R1 off: the sender names the thing, and their words are drawn where the
	// forge record's title goes.
	senderlabel: [{
		file: 'js/improve.js',
		find: "\t\tname.textContent = refName(ref);",
		with: "\t\tname.textContent = ref.said || refName(ref);",
	}],
	// R3 off: the chip becomes a link.
	refhref: [{
		file: 'js/improve.js',
		find: "\t\tbox.dataset.ref  = ref.id;",
		with: "\t\tbox.dataset.ref  = ref.id;\n\t\tvar a = document.createElement('a');\n"
			+ "\t\ta.href = 'https://example.invalid/' + ref.id;\n\t\tbox.appendChild(a);",
	}],
	// Decision 17 undone: two things called Message.
	msgname: [{
		file: 'i18n/en.js',
		find: "\t'panel.msg':     'Email message',",
		with: "\t'panel.msg':     'Message',",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// One edit, or a hard stop. An anchor that is not there exactly once changed
/// nothing, and the run below would prove the opposite of what it claims.
function edit(src, spec) {
	if (spec.re) {
		const n = (src.match(new RegExp(spec.re.source, 'g')) || []).length;
		if (n !== 1) {
			console.error(`break '${BREAK}': the shape ${spec.re} matches ${n} time(s) in ${spec.file}.`);
			process.exit(2);
		}
		return src.replace(spec.re, spec.with);
	}
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} time(s) in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// ONE BODY PER FILE. Playwright hands a request to the LAST route registered
/// for its URL, so a two-edit break registered as two routes ships only its
/// second edit — and still goes red, for half the reason it claims.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, edit(src, spec));
	}
	return byFile;
}

// The damaged bodies, computed ONCE and used for both the browser and the two
// source checks below.
//
// READ THROUGH THE BREAK, not off the disk. A source check that reads the file
// while the browser is served a damaged copy is a check no break can redden --
// which is exactly what `--break bootblind` did on 2026-08-17: it went green,
// and a green break run means the check it aims at is checking nothing.
const served = damagedFiles();
const source = (rel) => served.get(rel) ?? fs.readFileSync(path.join(WWW, rel), 'utf8');

const routeBreaks = async (pg) => {
	if (!BREAK) return;
	for (const [file, body] of served) {
		// `index.html` is asked for as the bare root, which is what `goto` is given,
		// so matching it by name would register a route nothing ever hits -- and a
		// break that changes nothing goes GREEN, which is the one outcome a break
		// run must never produce.
		const at = file === 'index.html'
			? (u) => u.pathname === '/' || u.pathname === '/index.html'
			: '**/' + file;
		await pg.route(at, r => r.fulfill({
			status: 200,
			contentType: file.endsWith('.css')  ? 'text/css'
				: file.endsWith('.html') ? 'text/html; charset=utf-8'
				: 'application/javascript',
			body,
		}));
	}
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The source, read as source ───────────────────────────────────────
//
// Two of the four seams are observable by driving the app and two are not. The
// boot dispatch fires before any script this file could install, and there is
// nothing downstream of it that a missing call would change — `start()` renders
// the panel either way. So it is read out of the file, and SAID to be read out
// of the file: a source check that is described as a behaviour check is the
// same lie as a green run that proved nothing.
const SRC = {
	daimond:   source('js/daimond.js'),
	telemetry: source('js/telemetry.js'),
};

// ── Driving ──────────────────────────────────────────────────────────

const s = await open({
	name:    'socialtester',
	profile: scratch('pw', 'social' + (BREAK ? '-' + BREAK : '')),
	signIn:  true,
	connect: false,
	route:   routeBreaks,
});
const { page } = s;

// Every request the panel's own door sees, so R5 is counted rather than assumed.
let asked = 0;
await page.route('**/api/improve**', (route) => {
	asked++;
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ error: 'absent' }),
	});
});

// A phone. `matchMedia('(max-width:760px)')` flips and the shell takes over.
await page.setViewportSize({ width: 390, height: 844 });
// Headless does not reliably advance CSS transitions, so a measured mid-flight
// value is meaningless. Every assertion below reads a settled state.
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(500);

/// A box, in viewport coordinates, or nulls. The one measurement this file
/// trusts.
const boxOf = (sel) => page.evaluate((q) => {
	const e = document.querySelector(q);
	if (!e) return null;
	const b = e.getBoundingClientRect();
	return { x: b.x, y: b.y, w: b.width, h: b.height };
}, sel);

/// Is it really on the screen: real area, and its centre inside the viewport.
/// A element with a box at (-9999, 0) is off screen and every ancestry check in
/// the world says it is fine.
const onScreen = (b) => !!b && b.w > 1 && b.h > 1
	&& b.x + b.w / 2 > 0 && b.x + b.w / 2 < 390
	&& b.y + b.h / 2 > 0 && b.y + b.h / 2 < 844;

try {

// ── 1. The panel, renamed, and its four seams ────────────────────────

// COUNTED first. Everything below asks whether this element is visible, and an
// absent element answers "hidden" to that question.
const panels = await page.locator('#panel-social').count();
check('the panel is in the markup, exactly once', panels === 1, `${panels} found`);

// SIX, and the sixth is not decision 13's either. That decision named four —
// Messages, People, Notes, Proposals — and §5.5 of the same plan reserved room
// for sections still to arrive, so the set was never closed at four. Share was
// added on 2026-08-17 with the share carrier of `dev/SOCIAL_OFFICE_CONTRACT.md`.
// Groups followed on 2026-09-15, when the panel's default view moved from the
// compose box to Messages: a group had been drawn inside the messages list
// until then, which stopped making sense once Messages was what the panel
// opened on. Proposals kept its view id and its i18n key — only the word a
// reader sees became Feedback — so this list still reads `proposals`.
//
// FEED TOOK SETTINGS' SLOT on 2026-09-15 and the head stayed at six. A seventh
// chip blanks or crowds a 390px dock, and the posting name and the doorbell are
// settings: the view is unmoved (`#social-settings`, still in `VIEWS`, still
// drawn by `drawSettings`) and the header cog's "Social settings…" row is the
// door — which is checked below rather than assumed, because a view nothing can
// open is a view that has been deleted with extra steps.
//
// ORDER AND ARITY BOTH, which is why this is an equality against a literal list
// and not a membership test. A chip that has gone, two that have swapped, and a
// seventh nobody decided on are three different faults, and this must redden
// for every one of them — `--break nochip`, `--break swapchip`, `--break sixthchip`.
const chipViews = await page.evaluate(() =>
	[...document.querySelectorAll('#panel-social .imp-chip[data-view]')].map(c => c.dataset.view));
check('its head carries the six chips: Messages, People, Groups, Feed, Share, Feedback',
	JSON.stringify(chipViews) === JSON.stringify(['messages', 'people', 'groups', 'feed', 'share', 'proposals']),
	chipViews.join(' ') || 'none');

// THE CHIPLESS VIEW STILL HAS A DOOR. `settings` is in `VIEWS` and nothing on
// the head opens it, so the cog's row is the only way in and is asserted here.
check('Settings has no chip, and the cog drawer carries the row that opens it',
	await page.evaluate(() => {
		const chip = document.querySelector('#panel-social .imp-chip[data-view="settings"]');
		const views = window.DaimondSocial && window.DaimondSocial.show;
		return !chip && !!views;
	}));

check('the panel declares itself to the layout engine as `social`',
	await page.evaluate(() => {
		const e = document.getElementById('panel-social');
		return !!e && e.dataset.panel === 'social' && e.dataset.zone === 'dock';
	}));

// 1a. ON A PHONE, ASKED FOR, SOMETHING IS VISIBLE.
//
// NOT `body.dataset.mpanel`, which is a fact about the floor and says nothing
// about what the reader was shown — the exact check that let a blank screen
// ship. Real geometry, on the panel and on a control inside it.
await page.evaluate(() => { window.DaimondPanels.hide('social'); });
await sleep(250);
await page.evaluate(() => { window.DaimondPanels.show('social'); });
await sleep(600);

const panelBox = await boxOf('#panel-social');
check('phone: the panel itself has a real box on the screen',
	onScreen(panelBox), JSON.stringify(panelBox));

const chipBox = await boxOf('#panel-social .imp-chip[data-view="proposals"]');
check('phone: and a control inside it is on the screen too',
	onScreen(chipBox), JSON.stringify(chipBox));

const headBox = await boxOf('#panel-social .railhead');
check('phone: the head, which is what names the panel, is on the screen',
	onScreen(headBox), JSON.stringify(headBox));

check('phone: and the head says Social, from the catalogue rather than the markup',
	(await page.evaluate(() =>
		(document.querySelector('#panel-social .railhead [role="heading"]') || {}).textContent || ''
	)).trim() === 'Social');

await shot(s, 'social-phone' + (BREAK ? '-' + BREAK : ''));

// 1b. NO_ASK. The pill is COUNTED before it is asked whether it is hidden.
const askCount = await page.locator('#msheet .msheet-ask, #msheet-ask').count();
check('the sheet has an ask pill to withhold in the first place', askCount >= 1,
	`${askCount} found`);
const askShown = await page.evaluate(() => {
	const e = document.querySelector('#msheet .msheet-ask, #msheet-ask');
	if (!e) return null;
	const b = e.getBoundingClientRect();
	return b.width > 1 && b.height > 1;
});
check('and over the Social panel it is not offered: the panel is already a box you write in',
	askShown === false, 'ask pill drawn: ' + askShown);

// 1c. The telemetry ordinal did not move.
const ord = await page.evaluate(() => {
	const T = window.DaimondTelemetry;
	if (!T) return null;
	return { social: T.ordinal(T.PANELS, 'social'), pending: T.ordinal(T.PANELS, 'pending'),
		improve: T.ordinal(T.PANELS, 'improve') };
});
check('telemetry: `social` sits where `improve` sat, at 16', ord && ord.social === 16,
	JSON.stringify(ord));
check('telemetry: and nothing after it moved — `pending` is still 17',
	ord && ord.pending === 17, JSON.stringify(ord));
check('telemetry: the old name is gone, so it reports as "something else" and not as a panel',
	ord && ord.improve === 0, JSON.stringify(ord));

// 1d. The onOpen dispatches. Two are driven; the third is READ.
const told = await page.evaluate(async () => {
	let n = 0;
	window.DaimondSocial.watch(() => { n++; });
	window.DaimondPanels.hide('social');
	await new Promise(r => setTimeout(r, 250));
	window.DaimondPanels.show('social');
	await new Promise(r => setTimeout(r, 400));
	return n;
});
check('opening the panel tells the panel, so it draws rather than sitting empty', told >= 1,
	`${told} call(s)`);

// READ OUT OF THE FILE, and said to be. The boot dispatch fires before any
// script this file could install, and `start()` renders either way, so there is
// nothing downstream of it a driven run could measure.
check('SOURCE: a panel already open at boot is told too (daimond.js)',
	/window\.DaimondSocial && DaimondPanels\.isOpen\('social'\)[^\n]*DaimondSocial\.onOpen\(\)/
		.test(SRC.daimond));

// 1e. Every chip leads somewhere with something in it.
for (const view of ['messages', 'people', 'groups', 'proposals', 'settings']) {
	const seen = await page.evaluate(async (v) => {
		window.DaimondSocial.show(v);
		await new Promise(r => setTimeout(r, 350));
		const shown = [...document.querySelectorAll('#panel-social .imp-view')]
			.filter(e => !e.hidden);
		if (shown.length !== 1) return { one: false, n: shown.length };
		const e = shown[0];
		const b = e.getBoundingClientRect();
		// SOMETHING IS VISIBLE: a box with area, and text a reader can read
		// inside it. An empty view with a box is the blank screen again.
		const words = (e.innerText || '').trim();
		return { one: true, id: e.id, w: b.width, h: b.height, words: words.slice(0, 80),
			any: words.length > 0 };
	}, view);
	check(`the ${view} chip shows exactly one view`, seen.one, `${seen.n} shown`);
	check(`the ${view} view has a real box on the phone`, seen.w > 1 && seen.h > 20,
		JSON.stringify(seen));
	check(`the ${view} view says something a reader can read`, !!seen.any,
		seen.words || '(nothing)');
	// And a key is never on the screen in place of a sentence.
	check(`the ${view} view says words, not a key`, !/^[a-z]+\.[a-z_.]+$/.test(seen.words || ''),
		seen.words);
}

// ── 2. The count badge, which is the app's only notification ─────────
//
// Restored on the plan's terms (messaging_plan §10.1: "Build it in Phase 1,
// wired to Mail… Messages become its second caller"). It was built, removed on
// 2026-08-31 at the owner's word while messaging had no caller at all, and is
// back with BOTH callers wired — so this section, which used to assert that no
// count ever drew, now asserts that the right one does.
//
// The two ways it can be wrong are the ways it always could be: drawing a zero,
// and counting what the reader is already looking at. The third, which is new,
// is a count that does not survive a reload — an unread message is unread until
// somebody reads it, and a tally that reset with the tab would be a tally that
// lies every morning.
//
// COUNTED, then MEASURED, throughout, per this file's own rule at the top: an
// absent element answers "hidden" to every question a locator can ask it.

const TITLE = await page.evaluate(() => document.title);

// Nothing has arrived, so there is no mark. "No badge" and "a badge holding an
// empty string" are the same thing to a reader, and only one of them is what
// the idiom asks for — so both are allowed here and neither may carry a digit.
const quiet = await page.evaluate(() =>
	[...document.querySelectorAll('.dock-count')]
		.map(e => ({ t: e.textContent, hidden: e.hidden, h: e.getBoundingClientRect().height })));
check('with nothing waiting, no count is drawn anywhere',
	quiet.every(b => b.t === '' && (b.hidden || b.h < 1)), JSON.stringify(quiet));
check('and the tab title carries no count either', !/^\(\d/.test(TITLE), TITLE);

// The Mail panel is put away, so an arrival is something the reader is NOT
// looking at — exactly the case the badge exists to mark.
await page.evaluate(() => { window.DaimondPanels.hide('mail'); window.DaimondPanels.show('social'); });
await sleep(400);

// mail.js's own announcement, with mail.js's own definition of an arrival:
// what came in above the mark the fetch started from, with backfills and
// uid-validity rebuilds already fenced out of it.
await page.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:mail-arrived', {
	detail: { mailbox: 'a@example.com', folder: 'INBOX', count: 3, uids: [7, 8, 9] },
})));
await sleep(400);

/// The mark on one panel's chip, as a reader would find it. The chip row is the
/// top bar on a desktop and the bottom strip on a phone, and it is ONE row
/// either way (js/mobile.js moves it rather than copying it), so this reads
/// whichever is on screen.
const countOn = (id) => page.evaluate((p) => {
	const b = document.querySelector('#panel-tags .ptag[data-panel="' + p + '"] .dock-count');
	if (!b) return { there: false };
	const r = b.getBoundingClientRect();
	return { there: true, t: (b.textContent || '').trim(), hidden: b.hidden,
		w: r.width, h: r.height, x: r.x, y: r.y };
}, id);

const mailMark = await countOn('mail');
check('three messages arriving draws the number three on the Email chip',
	mailMark.there && mailMark.t === '3' && !mailMark.hidden, JSON.stringify(mailMark));
check('and the mark has real area on the screen, not merely an element',
	onScreen(mailMark), JSON.stringify(mailMark));
check('and the tab title says how many are waiting',
	/^\(3\)/.test(await page.evaluate(() => document.title)),
	await page.evaluate(() => document.title));

// A chip row rebuild throws the chips away and rebuilds them. The count has to
// come back with them, or every resize silently clears the only notification
// this app has.
await page.evaluate(() => window.DaimondPanels.reflow());
await sleep(350);
check('and it survives the chip row being thrown away and rebuilt',
	(await countOn('mail')).t === '3');

// Looking at it is what clears it.
await page.evaluate(() => { window.DaimondPanels.show('mail'); });
await sleep(500);
const cleared = await countOn('mail');
check('opening the panel clears the count',
	!cleared.there || (cleared.t === '' && cleared.hidden), JSON.stringify(cleared));
check('and the tab title goes back to what it was',
	await page.evaluate(() => document.title) === TITLE);

// It never marks what is in front of you. This is the check that tells a badge
// from a mark you have to read before you can ignore it.
await page.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:mail-arrived', {
	detail: { mailbox: 'a@example.com', folder: 'INBOX', count: 2, uids: [10, 11] },
})));
await sleep(350);
const whileWatching = await countOn('mail');
check('mail arriving at a panel you are looking at raises no mark',
	(!whileWatching.there || (whileWatching.t === '' && whileWatching.hidden))
	&& (await page.evaluate(() => document.title)) === TITLE,
	JSON.stringify(whileWatching));

await page.evaluate(() => { window.DaimondPanels.hide('mail'); window.DaimondPanels.show('social'); });
await sleep(350);

// ── 2b. Messages, the badge's second caller ──────────────────────────
//
// The tally is `DaimondPost.unread()` and not a memory of arrivals: post.js
// marks a row read when it DRAWS it, so a message folded by a park while the
// panel was shut is still unread, and stays unread while the reader is looking
// at some other view of the same panel.
//
// Seeded through `DaimondPost.take`, which is the door a collect takes: it
// opens the envelope, records the message and WRITES the store. A fixture that
// reached into the record in memory would prove nothing about the reload below,
// which is the check this section exists for.
await page.evaluate(() => { window.DaimondSocial.show('proposals'); });
await sleep(300);
const seeded = await page.evaluate(async () => {
	if (!(await window.DaimondPost.read())) return { locked: true };
	await window.DaimondIdentity.ensureSealingKey();
	const to = window.DaimondIdentity.publicKeyB64url();
	for (let i = 1; i <= 2; i++) {
		const m = await window.DaimondPost.compose(
			{ body: 'a message nobody has opened ' + i, to });
		await window.DaimondPost.take({
			seq: 900 + i, kind: 'post', addr: m.addr, from_pub: to,
			ts: Math.floor(Date.now() / 1000), bytes: m.envelope.length,
			tray: false, expired: false, envelope: m.envelope,
		});
	}
	return { locked: false, unread: window.DaimondPost.unread() };
});
check('two unread messages are two unread messages', seeded.unread === 2,
	JSON.stringify(seeded));

// The Social panel is on screen, but on its PROPOSALS view — so nothing has
// drawn the rows, and the count must stand. `DaimondBadge.post` is the same
// recompute the minute clock makes.
await page.evaluate(() => {
	window.DaimondSocial.show('proposals');
	window.DaimondBadge.post();
});
await sleep(400);
const social = await countOn('social');
check('the Social chip draws the number of unread messages',
	social.there && social.t === '2' && !social.hidden, JSON.stringify(social));
check('and that mark has real area too', onScreen(social), JSON.stringify(social));

// PERSISTENCE. The record is wrapped under the identity key in the same
// `daimond-` store post.js already writes, so a reload finds it — and a count
// that reset on a reload would say nothing had arrived every time the tab was
// reopened.
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
const survived = await page.evaluate(async () => {
	await window.DaimondPost.read();
	window.DaimondBadge.post();
	return { unread: window.DaimondPost.unread() };
});
await sleep(500);
check('the unread count survives a reload', survived.unread === 2, JSON.stringify(survived));
check('and is drawn again without anybody opening anything',
	(await countOn('social')).t === '2', JSON.stringify(await countOn('social')));

// OPENING THE VIEW IS WHAT CLEARS IT, and only the rows it actually drew. Read
// when DRAWN and not when fetched: a device that cleared its own badge on
// collection would clear it for messages nobody ever looked at.
await page.evaluate(() => { window.DaimondPanels.show('social'); window.DaimondSocial.show('messages'); });
await sleep(1200);
const afterOpen = await page.evaluate(() => ({
	unread: window.DaimondPost.unread(),
	rows:   document.querySelectorAll('#social-messages-list .post-msg').length,
}));
check('opening the Messages view marks the rows it drew as read',
	afterOpen.unread === 0 && afterOpen.rows >= 2, JSON.stringify(afterOpen));
const gone = await countOn('social');
check('so the Social chip carries no mark once they have been seen',
	!gone.there || (gone.t === '' && gone.hidden), JSON.stringify(gone));

// And the reading was WRITTEN, not merely held: the store is dropped from
// memory and read back from disk, which is what the next reload will do.
const reread = await page.evaluate(async () => {
	window.DaimondPost.forget();
	await window.DaimondPost.read();
	return window.DaimondPost.unread();
});
check('and the reading was written, so a reload does not raise them again',
	reread === 0, String(reread));

// The chips themselves still open the panels they mark.
const opensMail = await page.evaluate(() => {
	const chip = document.querySelector('#panel-tags .ptag[data-panel="mail"]');
	if (!chip) return { chip: false };
	chip.click();
	return { chip: true, shown: window.DaimondPanels.isOpen('mail') };
});
await sleep(400);
check('the mail chip is still there and still opens the panel',
	opensMail.chip && opensMail.shown === true, JSON.stringify(opensMail));

await page.evaluate(() => { window.DaimondPanels.hide('mail'); window.DaimondPanels.show('social'); });
await sleep(350);

// ── 3. The reference chip, and the five rules ────────────────────────

// R4 — at most four, and only the four kinds this build knows.
const cleaned = await page.evaluate(() => window.DaimondRefs.clean([
	{ kind: 'proposal', id: '1' }, { kind: 'proposal', id: '2' },
	{ kind: 'build', id: 'abc' },  { kind: 'panel', id: 'spend' },
	{ kind: 'guide', id: 'sync.html' },
	{ kind: 'chat', id: 'secret' }, { kind: 'file', id: '/home/someone/x' },
	{ kind: 'proposal' }, 'not an object', null,
]));
check('R4: a message may carry four references and no more', cleaned.length === 4,
	`${cleaned.length}: ` + cleaned.map(r => r.kind).join(' '));
check('R4: and a kind this build does not know is dropped, not drawn',
	cleaned.every(r => ['proposal', 'build', 'panel', 'guide'].includes(r.kind)),
	JSON.stringify(cleaned));
check('R4: a reference with no id is dropped',
	(await page.evaluate(() => window.DaimondRefs.clean([{ kind: 'proposal' }]).length)) === 0);
check('a reference reduces to three fields and no fourth',
	cleaned.every(r => Object.keys(r).sort().join(',') === 'id,kind,said'),
	JSON.stringify(Object.keys(cleaned[0] || {})));

// Draw them somewhere real, inside the panel, so what is measured is what a
// reader would see.
const before = asked;
// NOT inside `#social-messages-list` or `#social-people-list`: those are
// js/post.js's and js/trust.js's own regions and each is cleared wholesale on
// every redraw, so a probe parked in one is gone by the time it is measured —
// which is how this check first went vacuously green, counting nought chips and
// asserting nought of them were links.
await page.evaluate(() => {
	const host = document.createElement('div');
	host.id = 'ref-probe';
	document.getElementById('panel-social').appendChild(host);
	window.DaimondRefs.forget();
	window.DaimondRefs.draw(host, [
		{ kind: 'proposal', id: '14', fallback_label: 'the file view scrolls wrong' },
		{ kind: 'proposal', id: '15', fallback_label: 'a second one' },
		{ kind: 'panel',    id: 'spend' },
		{ kind: 'guide',    id: 'not a page', fallback_label: 'how sync works' },
	]);
});
await page.evaluate(() => window.DaimondSocial.show('messages'));
await sleep(500);

const chipCount = await page.locator('#ref-probe .ref-chip').count();
check('four references draw four chips', chipCount === 4, `${chipCount} drawn`);
const firstChip = await boxOf('#ref-probe .ref-chip');
check('and a chip is really on the screen', onScreen(firstChip), JSON.stringify(firstChip));

// R5 — nothing is read until somebody asks.
await sleep(400);
check('R5: drawing four proposal chips reads nothing from the forge',
	asked === before, `${asked - before} request(s) went out`);

// R3 — not a URL, anywhere on any chip. Both of these are assertions that
// something is ABSENT, and an absent chip satisfies them for the wrong reason,
// so each carries the chip count it was measured over.
check('R3: no chip is a link', chipCount === 4 && await page.evaluate(() =>
	document.querySelectorAll('#ref-probe [href], #ref-probe a').length) === 0,
	`over ${chipCount} chip(s)`);

// R1 — the sender's words are NOT the name of the thing.
const names = await page.evaluate(() =>
	[...document.querySelectorAll('#ref-probe .ref-name')].map(e => e.textContent));
check('R1: the sender did not get to name any of them',
	names.length === 4 && !names.some(n => /file view scrolls wrong|a second one|how sync works/.test(n)),
	names.join(' | ') || '(no chips to read)');

// Pressing ONE chip reads ONE thing.
await page.locator('#ref-probe .ref-chip[data-ref="14"] .ref-act').click();
await sleep(700);
check('R5: pressing one chip reads exactly one thing', asked - before === 1,
	`${asked - before} request(s)`);

// R2 — the forge refused `absent`, which covers "no such repository" AND "it is
// private". The chip says the one sentence that is true in both cases and
// NOTHING sharper.
const shut = await page.evaluate(() => {
	const c = document.querySelector('#ref-probe .ref-chip[data-ref="14"]');
	return { shut: c.classList.contains('shut'),
		note: (c.querySelector('.ref-note') || {}).textContent || '',
		said: (c.querySelector('.ref-said') || {}).textContent || '',
		acts: c.querySelectorAll('.ref-act').length };
});
check('R2: a reference that cannot be opened is drawn shut', shut.shut, JSON.stringify(shut));
check('R2: and says only that the repository is not available',
	/not available to you/.test(shut.note), shut.note);
check('R2: it never says the thing does not exist',
	!/no such|not found|does not exist|private/i.test(shut.note), shut.note);
check('R1: only NOW are the sender\'s words drawn, and framed as the sender\'s',
	/Described as:/.test(shut.said) && /file view scrolls wrong/.test(shut.said), shut.said);
check('a shut chip offers no control, so nothing on it can be pressed twice',
	shut.acts === 0, `${shut.acts} control(s)`);

// A panel reference is navigation and nothing else: it discloses nothing, reads
// nothing, and opens what it names.
await page.evaluate(() => { window.DaimondPanels.hide('spend'); });
await sleep(250);
const askedBeforePanel = asked;
await page.locator('#ref-probe .ref-chip[data-kind="panel"] .ref-act').click();
await sleep(400);
check('a panel reference reads nothing at all', asked === askedBeforePanel);
await page.locator('#ref-probe .ref-chip[data-kind="panel"] .ref-act').click();
await sleep(600);
check('and pressing it opens the panel it names',
	await page.evaluate(() => window.DaimondPanels.isOpen('spend')));

await page.evaluate(() => { window.DaimondPanels.hide('spend'); window.DaimondPanels.show('social'); });
await sleep(300);

// A build reference needs no request either: this build's own stamp is in hand.
const buildSays = await page.evaluate(async () => {
	const host = document.createElement('div');
	host.id = 'ref-build';
	document.getElementById('panel-social').appendChild(host);
	window.DaimondRefs.forget();
	const j = await fetch('build.json', { cache: 'no-store' }).then(r => r.json());
	window.DaimondRefs.draw(host, [
		{ kind: 'build', id: j.build },
		{ kind: 'build', id: 'ffffffffffff' },
	]);
	for (const b of host.querySelectorAll('.ref-act')) b.click();
	await new Promise(r => setTimeout(r, 400));
	return [...host.querySelectorAll('.ref-chip')].map(c => ({
		name: (c.querySelector('.ref-name') || {}).textContent || '',
		note: (c.querySelector('.ref-note') || {}).textContent || '',
		act:  (c.querySelector('.ref-act') || {}).textContent || '',
	}));
});
check('a build you are on says so, and offers nothing to press',
	/build you are on/i.test(buildSays[0].note) && buildSays[0].act === '',
	JSON.stringify(buildSays[0]));
check('a build you are not on says which one you ARE on, and offers the update',
	/You are on build/i.test(buildSays[1].note) && /Update/i.test(buildSays[1].act),
	JSON.stringify(buildSays[1]));

// ── 4. Decision 17: two things called Message, no longer ─────────────

// The panel's own NAME, which is what the chip row, the gallery, the palette
// and the phone sheet's title all read. `#msg-title` is not it: that is written
// by mail.js and carries the subject of whatever is open.
const msgLabel = await page.evaluate(() => ({
	markup:    (document.getElementById('panel-msg') || {}).dataset.label,
	catalogue: window.DaimondI18n ? window.DaimondI18n.t('panel.msg') : null,
}));
check('the email reading panel is called Email message, in the catalogue',
	msgLabel.catalogue === 'Email message', JSON.stringify(msgLabel));
check('and in the markup it falls back to, which is what shows before the first paint',
	msgLabel.markup === 'Email message', JSON.stringify(msgLabel));
check('and the Social panel has the plain word Messages to itself',
	(await page.evaluate(() =>
		(document.querySelector('#panel-social .imp-chip[data-view="messages"]') || {}).textContent
	)) === 'Messages');

} finally {
	await shot(s, 'social' + (BREAK ? '-' + BREAK : ''));
	const errs = s.errs.filter(e => !/Failed to load resource|status of 4\d\d/.test(e));
	check('no console errors along the way', errs.length === 0, errs.slice(0, 3).join(' | '));
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) {
	console.log('failed: ' + bad.join('; '));
	process.exit(1);
}
if (BREAK) {
	console.log(`\nbreak '${BREAK}' produced a GREEN run, which means the check it is `
		+ 'aimed at is not checking anything.');
	process.exit(1);
}
