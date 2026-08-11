// verify_about.mjs — the About dialog, and the button that opens it.
//
// The header's maker's badge has become an About button, and the badge's two
// claims have moved into the dialog it opens. That is a move of something that
// was ALREADY LIVE, so what has to be proved is mostly that nothing was dropped
// on the way: the two links are still two links, still separate claims, still
// pointing where they pointed.
//
// What is asserted, and why each one rather than the next thing:
//
//   1. THE SWAP HAPPENED, BOTH WAYS. An About button is in the header, and the
//      badge is NOT still in it. Half a move leaves two things saying the same
//      thing in the same row, which is how a "moved" control comes to exist in
//      two places for a release.
//
//   2. IT IS THE APP'S OWN DIALOG. Opened by the button, closed by Escape,
//      closed by the control it offers, focus trapped inside it while it is up,
//      and the focus handed back to the button afterwards. Every one of those is
//      free if the dialog is built on `openBodyDialog` and none of them is if it
//      is a modal somebody wrote for this screen — so they are the check that it
//      really is the shared furniture, rather than something that looks like it.
//
//   3. THE ARTWORK IS THE RIGHT SHAPE. The splash's painted box is measured
//      against the aspect of ITS OWN viewBox, read out of the file. A stretched
//      splash is what happens when a height is set somewhere up the tree, and it
//      is not a thing anybody notices from a screenshot of a picture they have
//      not seen undistorted. It is also measured against the card: full bleed
//      means EXACTLY the card's padding box, in every skin, because a pixel over
//      hangs a horizontal scrollbar under it (`.modal-card` scrolls on y, and
//      CSS then computes overflow-x to auto).
//
//   4. BOTH CLAIMS SURVIVED, SEPARATELY. Two links, two accessible names,
//      two destinations, each opening in a new tab with rel="noopener
//      noreferrer". One link with a name that mentions both is not the same
//      thing: they are separate claims and a reader must be able to follow
//      either without following the other.
//
//   5. THE BUILD IT SHOWS IS THE BUILD IT IS RUNNING. Compared against
//      `www/build.json` on disk, which is the file the app itself reads.
//
//   6. IT FITS A PHONE, AND SO DOES THE ROW IT IS OPENED FROM. The dialog
//      inside the viewport at an iPhone width; the header row un-clipped at 320,
//      375 and 390. The second is not incidental: the button is a fifth control
//      in a row that only ever had space for four, and the bar's `overflow:
//      hidden` amputates the last one rather than complaining.
//
//   7. NOTHING IN IT IS ENGLISH BY ACCIDENT, AND NOTHING IN IT FREEZES.
//      Opened under a second language, every string comes back in that
//      language; and with the dialog STILL OPEN, a switch to a third repaints
//      it where it stands. The second half is not the first one twice: a
//      surface built after the switch is built in the new language whatever the
//      code does, so it is evidence about the table and none at all about the
//      surface. It caught a real one on its first clean run — `openBodyDialog`
//      wrote its heading and its buttons with `textContent`, so every dialog
//      built on it kept the language it was opened in until it was closed.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page (through
// `page.route`, so the browser loads it as it loads anything else) and the run
// is then expected to FAIL. A break whose anchor does not appear exactly once
// aborts rather than passing quietly: a check proved against code that was never
// broken is not proved at all.
//
//   node dev/verify_about.mjs --break nobutton    # 1: no About button in the bar
//   node dev/verify_about.mjs --break oldbadge    # 1: the badge is still there too
//   node dev/verify_about.mjs --break noescape    # 2: Escape does not close it
//   node dev/verify_about.mjs --break notrap      # 2: Tab walks out of the card
//   node dev/verify_about.mjs --break noreturn    # 2: the focus never comes back
//   node dev/verify_about.mjs --break stretch     # 3: the splash is squashed
//   node dev/verify_about.mjs --break nobleed     # 3: it stops short of the edges
//   node dev/verify_about.mjs --break onelink     # 4: one claim instead of two
//   node dev/verify_about.mjs --break norel       # 4: a new tab with a handle back
//   node dev/verify_about.mjs --break wrongbuild  # 5: a build id that is not ours
//   node dev/verify_about.mjs --break crowd       # 6: the header row clips again
//   node dev/verify_about.mjs --break hardcoded   # 7: an English string, always
//   node dev/verify_about.mjs --break unmarked    # 7: right at open, frozen after
//   node dev/verify_about.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/verify_about.mjs
//
// Needs dev/serve.mjs only. No gateway and no model: About spends nothing and
// asks nothing of anybody.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, signInAs, APP } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'about' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// ── The oracles, read off disk ───────────────────────────────────────
//
// Not restated here. The aspect the splash must draw at is the one in the
// artwork's own header, and the build id it must show is the one in the file
// the app fetches — so re-drawing the splash or sealing a new build moves both
// of these on their own, and a check that has silently stopped meaning anything
// is not a thing this file can leave lying about.
const SPLASH = fs.readFileSync(path.join(WWW, 'assets', 'splash.svg'), 'utf8');
const VIEWBOX = (() => {
	const m = /viewBox="([\d.\s-]+)"/.exec(SPLASH);
	if (!m) { console.error('splash.svg carries no viewBox; nothing to measure against.'); process.exit(2); }
	const n = m[1].trim().split(/\s+/).map(Number);
	return { w: n[2], h: n[3], ar: n[2] / n[3] };
})();
const BUILD = JSON.parse(fs.readFileSync(path.join(WWW, 'build.json'), 'utf8')).build;

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must appear
// exactly once, or the run below would prove the opposite of what it claims.
const BREAKS = {
	// No About button at all: the slot is empty and nothing opens the dialog.
	nobutton: [{
		file: 'index.html',
		find: '<button class="icon-btn" id="about-btn"',
		with: '<button class="icon-btn" id="about-btn" hidden style="display:none" data-broken="1"',
	}],
	// Half a move: the button arrives and the badge stays. Two things in one row
	// saying the same thing, which is the state a "moved" control passes through
	// and must not be released in.
	oldbadge: [{
		file: 'index.html',
		find: '\t\t\t<button class="icon-btn" id="guide-btn"',
		with: '\t\t\t<span class="made-by"><img src="assets/made_by_oxedyne.svg" alt="" aria-hidden="true">'
			+ '<a class="mb-hit mb-oxedyne" href="https://oxedyne.com"></a>'
			+ '<a class="mb-hit mb-ai" href="https://need2know.ai/mostly-ai/code"></a></span>\n'
			+ '\t\t\t<button class="icon-btn" id="guide-btn"',
	}],
	// The shared dialog's Escape, gone. If About had a modal of its own this
	// break would not touch it, and the check would pass with the app broken —
	// which is exactly what it is here to notice.
	noescape: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tif (e.key === \'Escape\') { e.preventDefault(); close(true); }\n'
			+ '\t\t\t\telse if (e.key === \'Tab\') keepFocusIn(card, e);',
		with: '\t\t\t\tif (e.key === \'Tab\') keepFocusIn(card, e);',
	}],
	// The focus trap, gone: Tab walks out of the card and into the app behind it.
	notrap: [{
		file: 'js/daimond.js',
		find: '\tfunction keepFocusIn(card, e) {',
		with: '\tfunction keepFocusIn(card, e) {\n\t\tif (card) return;',
	}],
	// The focus is not handed back. A dialog opened from the keyboard and closed
	// from the keyboard leaves the user at the top of the document.
	noreturn: [{
		file: 'js/daimond.js',
		find: '\tfunction refocus(prev, host) {\n\t\tif (tookFocus(prev)) return;',
		with: '\tfunction refocus(prev, host) {\n\t\tif (prev || !prev) return;\n\t\tif (tookFocus(prev)) return;',
	}],
	// A height on the splash: the artwork is squashed to fit a box that is not
	// its shape, and on a phone the card grows past the screen with it.
	stretch: [{
		file: 'css/app.css',
		find: '\theight: auto;\n\tmargin: calc(var(--about-pad) * -1) calc(var(--about-pad) * -1) 0;',
		with: '\theight: 520px;\n\tmargin: calc(var(--about-pad) * -1) calc(var(--about-pad) * -1) 0;',
	}],
	// The bleed cancelled: the splash sits inside the card's padding like a
	// paragraph, with a margin of card showing round it.
	nobleed: [{
		file: 'css/app.css',
		find: '\twidth: calc(100% + var(--about-pad) * 2);\n\t/* Stated, not inherited',
		with: '\twidth: 100%;\n\t/* Stated, not inherited',
	}],
	// One claim where there were two.
	onelink: [{
		file: 'js/daimond.js',
		find: '\t\t\t[\'mb-ai\', \'https://need2know.ai/mostly-ai/code\', \'topbar.made_with_ai\'],\n',
		with: '',
	}],
	// A new tab with a handle back on this window, and a referrer off it.
	norel: [{
		file: 'js/daimond.js',
		find: '\t\t\ta.rel = \'noopener noreferrer\';',
		with: '\t\t\ta.rel = \'\';',
	}],
	// A build id that is not the one this tab is running. Truncated rather than
	// blanked, because a blank would be caught by "there is a build id at all"
	// and this has to be caught by "it is the RIGHT one".
	wrongbuild: [{
		file: 'js/daimond.js',
		find: '\t\tvar known = buildId();\n\t\tvid.textContent = known;',
		with: '\t\tvar known = buildId();\n\t\tvid.textContent = known.slice(0, 6);',
	}],
	// The header row back at the breakpoint it had before About was a fifth
	// control in it, which is where the bar starts amputating the last one.
	crowd: [{
		file: 'css/responsive.css',
		find: '@media (max-width: 380px) {\n\t.topbar { gap: 8px; }',
		with: '@media (max-width: 360px) {\n\t.topbar { gap: 8px; }',
	}],
	// An English sentence written into the dialog rather than looked up. This is
	// the failure the project shipped twice in one day, so it gets a break.
	hardcoded: [{
		file: 'js/daimond.js',
		find: '\t\tDaimondI18n.bind(said, \'\', \'about.what\');',
		with: '\t\tsaid.textContent = \'Daimond is an AI agent workspace that runs entirely in your browser.\';',
	}],
	// Looked up, but not MARKED. Right in every language at the moment the
	// dialog is built, and frozen in that language for as long as it stays open
	// — which is the shape that left the Admin drawer in Spanish through a
	// switch to Japanese on 2026-08-10, and had shipped once before that.
	unmarked: [{
		file: 'js/daimond.js',
		find: '\t\tDaimondI18n.bind(said, \'\', \'about.what\');',
		with: '\t\tsaid.textContent = DaimondI18n.t(\'about.what\');',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop.
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

const TYPE = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const body = damaged(spec);
		const type = TYPE[path.extname(spec.file)] || 'text/plain';
		if (spec.file === 'index.html') {
			// The document is served at `/`, not at `/index.html`, so it cannot be
			// matched by a glob on the file's name.
			await page.route(
				(url) => url.pathname === '/' || url.pathname === '/index.html',
				r => r.fulfill({ status: 200, contentType: type, body }));
		} else {
			await page.route('**/' + spec.file, r => r.fulfill({ status: 200, contentType: type, body }));
		}
	}
}

// ── Driving ──────────────────────────────────────────────────────────

const IS_UP = () => {
	const c = document.querySelector('.about-card');
	return !!c && c.getClientRects().length > 0 && getComputedStyle(c).visibility !== 'hidden';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// Open About the way a keyboard user does, so the focus is genuinely ON the
/// button when the dialog takes over — which is what makes "the focus comes
/// back" mean anything. A synthetic `.click()` leaves the focus wherever it was.
async function openFromKeyboard(page) {
	await page.focus('#about-btn');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(500);
}

/// Shut whatever is over the app, without asserting anything about how.
async function quieten(page) {
	for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(90); }
	await page.evaluate(() => {
		document.querySelectorAll('.modal.dlg').forEach(m => m.remove());
	});
	await page.waitForTimeout(120);
}

const s = await open({ name: 'about', signIn: false, connect: false, profile: PROFILE });
const { page } = s;
await serveBreaks(page);
// The routes only bite on a load that comes after them, and signing in reloads
// nothing — so the page is reopened with them in place.
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await signInAs(s, 'about');
await page.waitForTimeout(1500);

try {
	// ── 1. The swap happened, both ways ──────────────────────────
	const bar = await page.evaluate(() => {
		const b = document.getElementById('about-btn');
		const seen = (el) => !!el && el.getClientRects().length > 0
			&& getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
		return {
			drawn:   seen(b),
			inRow:   !!(b && b.closest('.top-actions')),
			name:    b ? (b.getAttribute('aria-label') || '') : '',
			classes: b ? b.className : '',
			// The icon has to be the app's own `.ic`, at the size the rest of the
			// row draws: a button that is the right shape and the wrong weight
			// reads as belonging to a different set.
			icon:    b ? (() => {
				const i = b.querySelector('svg.ic');
				if (!i) return null;
				const r = i.getBoundingClientRect();
				const cs = getComputedStyle(i);
				return { w: Math.round(r.width), h: Math.round(r.height), stroke: cs.strokeWidth };
			})() : null,
			// And the same box as its neighbours, so the row does not step.
			sameBox: (() => {
				if (!b) return false;
				const g = document.getElementById('guide-btn');
				if (!g) return false;
				const a = b.getBoundingClientRect(), q = g.getBoundingClientRect();
				return Math.abs(a.width - q.width) < 1.5 && Math.abs(a.height - q.height) < 1.5;
			})(),
			badgeInBar: document.querySelectorAll('.top-actions .made-by, .topbar .made-by').length,
		};
	});
	check('an About button is drawn in the header row', bar.drawn && bar.inRow,
		`drawn=${bar.drawn} inRow=${bar.inRow}`);
	check('and it says what it is', /about/i.test(bar.name) || bar.name.length > 0, bar.name || '(no name)');
	check('and it is one of the row\'s icon buttons, at the row\'s icon size',
		/icon-btn/.test(bar.classes) && bar.icon && bar.icon.w === 18 && bar.icon.h === 18
			&& bar.icon.stroke === '1.75px' && bar.sameBox,
		`${bar.classes} ${JSON.stringify(bar.icon)} sameBox=${bar.sameBox}`);
	check('AND THE OLD BADGE IS GONE FROM THE HEADER — a move, not a copy',
		bar.badgeInBar === 0, `${bar.badgeInBar} badge(s) still in the bar`);

	// ── 2. It is the app's own dialog ────────────────────────────
	// Opened by a real pointer click on the button, first: that is how most
	// people will open it, and a handler bound to the wrong element passes a
	// synthetic `.click()` and fails this.
	await page.click('#about-btn');
	await page.waitForTimeout(600);
	check('a click on it opens the dialog', await page.evaluate(IS_UP));

	const furniture = await page.evaluate(() => {
		const c = document.querySelector('.about-card');
		if (!c) return null;
		return {
			modalCard: c.classList.contains('modal-card') && c.classList.contains('dlg-card'),
			inModal:   !!c.closest('.modal'),
			role:      c.getAttribute('role'),
			modal:     c.getAttribute('aria-modal'),
			// Named by a heading that is IN the tree even though it is not in the
			// pixels: `aria-labelledby` pointing at nothing is a dialog with no name.
			labelledBy: (() => {
				const id = c.getAttribute('aria-labelledby');
				const h = id && c.querySelector('#' + CSS.escape(id));
				return h ? (h.textContent || '').trim() : '';
			})(),
			closer: !!c.querySelector('.tile-dlg-done'),
		};
	});
	check('it is the app\'s dialog furniture, not a modal of its own',
		!!furniture && furniture.modalCard && furniture.inModal
			&& furniture.role === 'dialog' && furniture.modal === 'true',
		JSON.stringify(furniture));
	check('and it is named to the accessibility tree by a real heading',
		!!furniture && furniture.labelledBy.length > 0, furniture && furniture.labelledBy);

	// The focus trap, with the dialog up. Fourteen presses, which is more than
	// twice round anything in this card: a trap that only holds for one press is
	// not a trap, and neither is one that holds until the ring wraps.
	//
	// Driven one press at a time from OUT here, not from a loop inside the page:
	// the trap is a keydown handler, and a synthetic focus walk would never fire
	// it and would prove nothing about the thing being asserted.
	const walk = [];
	let escaped = false;
	for (let i = 0; i < 14; i++) {
		await page.keyboard.press('Tab');
		await page.waitForTimeout(60);
		const where = await page.evaluate(() => {
			const card = document.querySelector('.about-card');
			const a = document.activeElement;
			return {
				inside: !!(card && a && card.contains(a)),
				what: a ? (a.tagName.toLowerCase() + (a.id ? '#' + a.id : '')
					+ (a.className ? '.' + String(a.className).split(' ')[0] : '')) : '(none)',
			};
		});
		walk.push(where.what);
		if (!where.inside) { escaped = true; break; }
	}
	check('the focus is trapped inside it — fourteen Tabs and it never leaves',
		!escaped, walk.join(' → '));

	// Escape, from wherever the pointer left the focus. A handler scoped to
	// "focus is still in my card" stops working the moment somebody clicks the
	// prose they are reading, which is a thing people do.
	const textAt = await page.evaluate(() => {
		const p = document.querySelector('.about-card .about-said');
		if (!p) return null;
		const r = p.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	if (textAt) {
		await page.mouse.click(textAt.x, textAt.y);
		await page.waitForTimeout(150);
	}
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	check('Escape closes it, even after the pointer has moved the focus off it',
		!(await page.evaluate(IS_UP)));

	// The pointer's own way out.
	await quieten(page);
	await page.evaluate(() => document.getElementById('about-btn').click());
	await page.waitForTimeout(500);
	await page.evaluate(() => { const b = document.querySelector('.about-card .tile-dlg-done'); if (b) b.click(); });
	await page.waitForTimeout(400);
	check('and the control it offers closes it too', !(await page.evaluate(IS_UP)));

	// And the focus comes back to the button that opened it.
	await quieten(page);
	await openFromKeyboard(page);
	check('Enter on the button opens it', await page.evaluate(IS_UP));
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
	const landed = await page.evaluate(() => {
		const a = document.activeElement;
		return a ? (a.id || a.tagName.toLowerCase()) : '(none)';
	});
	check('AND THE FOCUS COMES BACK TO THE BUTTON', landed === 'about-btn', landed);

	// ── 3. The artwork is the right shape ────────────────────────
	// Both skins: `--about-pad` mirrors the card's padding and the warm skin
	// loosens it, so a bleed measured against one skin's number is a picture
	// hanging over the edge of the other's card.
	for (const skin of ['sharp', 'warm']) {
		await quieten(page);
		await page.evaluate((k) => document.documentElement.setAttribute('data-skin', k), skin);
		await page.waitForTimeout(250);
		await page.evaluate(() => document.getElementById('about-btn').click());
		await page.waitForTimeout(600);
		const art = await page.evaluate(() => {
			const c = document.querySelector('.about-card');
			const img = c && c.querySelector('.about-splash');
			if (!img) return null;
			const r = img.getBoundingClientRect(), cr = c.getBoundingClientRect();
			return {
				w: +r.width.toFixed(2), h: +r.height.toFixed(2), ar: r.width / r.height,
				natAr: img.naturalWidth / img.naturalHeight,
				loaded: img.complete && img.naturalWidth > 0,
				// The card's PADDING box, which is what full bleed means here.
				padBox: c.clientWidth,
				fromTop: +(r.top - cr.top).toFixed(2),
				cardH: +cr.height.toFixed(2),
				overX: c.scrollWidth - c.clientWidth,
				alt: img.getAttribute('alt') || '',
			};
		});
		check(`[${skin}] the splash actually loaded`, !!art && art.loaded, art && JSON.stringify(art));
		if (!art) continue;
		// Against the artwork's OWN viewBox, read off disk — not against a number
		// written here, which would agree with a redrawn splash's box and with
		// nothing else.
		check(`[${skin}] IT IS NOT STRETCHED — drawn at its own ${VIEWBOX.ar.toFixed(4)} aspect`,
			Math.abs(art.ar - VIEWBOX.ar) < 0.02,
			`drawn ${art.ar.toFixed(4)} (${art.w}x${art.h}), file ${VIEWBOX.ar.toFixed(4)}, `
			+ `natural ${art.natAr.toFixed(4)}`);
		check(`[${skin}] it reaches both edges of the card, and not a pixel past`,
			Math.abs(art.w - art.padBox) < 1.5 && art.overX === 0,
			`splash ${art.w}, card padding box ${art.padBox}, overflow-x ${art.overX}`);
		check(`[${skin}] and it is the top of the dialog, at a size that dominates it`,
			art.fromTop < 2 && art.h / art.cardH > 0.25,
			`${art.fromTop}px from the top, ${(100 * art.h / art.cardH).toFixed(1)}% of the card`);
		check(`[${skin}] it says what it is a picture of`, art.alt.length > 12, art.alt);
	}
	await page.evaluate(() => document.documentElement.setAttribute('data-skin', 'sharp'));

	// ── 4. Both claims survived, separately ──────────────────────
	await quieten(page);
	await page.evaluate(() => document.getElementById('about-btn').click());
	await page.waitForTimeout(600);
	const links = await page.evaluate(() => {
		const c = document.querySelector('.about-card');
		return [...c.querySelectorAll('a[href]')].map(a => ({
			href:   a.href,
			name:   a.getAttribute('aria-label') || (a.textContent || '').trim(),
			title:  a.getAttribute('title') || '',
			target: a.getAttribute('target') || '',
			rel:    a.getAttribute('rel') || '',
			box:    (() => { const r = a.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }; })(),
		}));
	});
	const ox = links.find(l => /oxedyne\.com/.test(l.href));
	const ai = links.find(l => /need2know\.ai/.test(l.href));
	check('BOTH of the badge\'s links are in the dialog',
		!!ox && !!ai, links.map(l => l.href).join(' | ') || 'none');
	check('and each has an accessible name of its own',
		!!ox && !!ai && ox.name.length > 0 && ai.name.length > 0 && ox.name !== ai.name,
		`${ox && JSON.stringify(ox.name)} vs ${ai && JSON.stringify(ai.name)}`);
	check('and a title of its own, for the pointer',
		!!ox && !!ai && ox.title.length > 0 && ai.title.length > 0 && ox.title !== ai.title,
		`${ox && JSON.stringify(ox.title)} vs ${ai && JSON.stringify(ai.title)}`);
	check('and each opens in a new tab with no handle back on this window',
		!!ox && !!ai && [ox, ai].every(l => l.target === '_blank'
			&& /noopener/.test(l.rel) && /noreferrer/.test(l.rel)),
		[ox, ai].map(l => l && `${l.target} rel=${JSON.stringify(l.rel)}`).join(' | '));
	check('and each has a hit area of its own, side by side',
		!!ox && !!ai && ox.box.w > 8 && ai.box.w > 8 && ox.box.x !== ai.box.x,
		JSON.stringify([ox && ox.box, ai && ai.box]));

	// ── 5. The build it shows is the build it is running ─────────
	// `build.json` is the file the app itself fetches, so this is the app's own
	// answer checked against the app's own source of it.
	await page.waitForTimeout(400);
	const said = await page.evaluate(() => {
		const c = document.querySelector('.about-card');
		const b = c.querySelector('.about-build');
		return {
			build: b ? (b.textContent || '').trim() : '',
			row:   (c.querySelector('.about-ver').textContent || '').trim(),
			copy:  !!c.querySelector('.about-ver .copy-id'),
		};
	});
	check('THE BUILD ID IT SHOWS IS THE ONE IN build.json',
		said.build === BUILD, `dialog "${said.build}" vs build.json "${BUILD}"`);
	check('and it is shown the way the status panel shows it: a label, and a copy button',
		said.row.length > said.build.length && said.copy, JSON.stringify(said));

	// ── 6. It fits a phone, and so does the row it opens from ────
	await quieten(page);
	await page.setViewportSize({ width: 390, height: 844 });		// iPhone 14/15
	await page.waitForTimeout(400);
	await page.evaluate(() => document.getElementById('about-btn').click());
	await page.waitForTimeout(700);
	const phone = await page.evaluate(() => {
		const c = document.querySelector('.about-card');
		if (!c) return null;
		const r = c.getBoundingClientRect();
		const close = c.querySelector('.tile-dlg-done');
		const cb = close && close.getBoundingClientRect();
		return {
			top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
			left: +r.left.toFixed(1), right: +r.right.toFixed(1),
			vw: window.innerWidth, vh: window.innerHeight,
			// Anything hidden behind the card's own scroll. The card MAY scroll —
			// that is what `overflow-y: auto` is for — but the Close button being
			// below the fold on a first open is the failure this exists to catch.
			hidden: c.scrollHeight - c.clientHeight,
			closeVisible: !!cb && cb.bottom <= window.innerHeight + 0.5 && cb.top >= 0,
			pageScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		};
	});
	check('ON A PHONE THE WHOLE DIALOG IS ON THE SCREEN',
		!!phone && phone.top >= 0 && phone.bottom <= phone.vh + 0.5
			&& phone.left >= 0 && phone.right <= phone.vw + 0.5,
		JSON.stringify(phone));
	check('and the way out of it is on the screen with it',
		!!phone && phone.closeVisible && phone.hidden === 0, JSON.stringify(phone));
	check('and nothing about it makes the page scroll sideways',
		!!phone && phone.pageScrollX === 0, phone && String(phone.pageScrollX));
	await shot(s, 'about-phone' + (BREAK ? '-' + BREAK : ''));

	// The header row itself, at the widths where it is tightest. The bar is
	// `overflow: hidden`, which is not a fit but a guillotine: it takes the last
	// control in the row off the screen without a word.
	await quieten(page);
	for (const w of [320, 375, 390]) {
		await page.setViewportSize({ width: w, height: 780 });
		await page.waitForTimeout(400);
		const row = await page.evaluate(() => {
			const bar = document.querySelector('.topbar');
			const act = document.querySelector('.top-actions');
			const br = bar.getBoundingClientRect();
			const vis = [...act.children].filter(e => getComputedStyle(e).display !== 'none' && e.getClientRects().length);
			const last = vis[vis.length - 1];
			const about = document.getElementById('about-btn');
			const ar = about && about.getBoundingClientRect();
			return {
				clip: +(bar.scrollWidth - bar.clientWidth).toFixed(1),
				slack: last ? +(br.right - last.getBoundingClientRect().right).toFixed(1) : null,
				n: vis.length,
				aboutIn: !!ar && ar.right <= br.right + 0.5 && ar.left >= br.left - 0.5,
				aboutBox: ar ? Math.round(ar.width) + 'x' + Math.round(ar.height) : null,
			};
		});
		check(`at ${w}px the header row is not clipped`, row.clip === 0 && row.slack >= 0,
			`${row.n} control(s), clip ${row.clip}, slack ${row.slack}`);
		check(`at ${w}px About is on the screen and still a thumb's target`,
			row.aboutIn && parseInt(row.aboutBox, 10) >= 32,
			`${row.aboutBox}, inside=${row.aboutIn}`);
	}
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.waitForTimeout(300);

	// ── 7. Nothing in it is English by accident ──────────────────
	// German, because it shares an alphabet with English — a check that switched
	// to Japanese would pass on a hardcoded English string that simply had not
	// been translated, because the assertion would be "not Latin".
	await quieten(page);
	await page.evaluate(async () => { await window.DaimondI18n.setLocale('de'); });
	await page.waitForTimeout(900);
	await page.evaluate(() => document.getElementById('about-btn').click());
	await page.waitForTimeout(700);
	const de = await page.evaluate(() => {
		const c = document.querySelector('.about-card');
		const btn = document.getElementById('about-btn');
		return {
			btn:   btn.getAttribute('aria-label') || '',
			said:  (c.querySelector('.about-said').textContent || '').trim(),
			alt:   c.querySelector('.about-splash').getAttribute('alt') || '',
			label: (c.querySelector('.about-ver-label').textContent || '').trim(),
			close: c.querySelector('.tile-dlg-done').title || '',
			links: [...c.querySelectorAll('a[href]')].map(a => a.getAttribute('aria-label') || ''),
		};
	});
	// Asserted against the German TABLE, read from the same file the app reads,
	// rather than against words written out here — a check that quotes the
	// translation is a check that has to be edited every time the translation is.
	const deTable = await page.evaluate(() => {
		const keys = ['topbar.about', 'about.what', 'about.splash_alt', 'rel.version',
			'common.close', 'topbar.made_by', 'topbar.made_with_ai'];
		const out = {};
		keys.forEach(k => { out[k] = window.DaimondI18n.t(k); });
		return out;
	});
	check('EVERY STRING IN IT COMES BACK IN THE SECOND LANGUAGE',
		de.said === deTable['about.what']
			&& de.alt === deTable['about.splash_alt']
			&& de.btn === deTable['topbar.about']
			&& de.label === deTable['rel.version']
			&& de.close === deTable['common.close']
			&& de.links.includes(deTable['topbar.made_by'])
			&& de.links.includes(deTable['topbar.made_with_ai']),
		JSON.stringify(de));
	// And the same again with the dialog ALREADY OPEN when the language changes.
	// A surface built fresh in the new language is not evidence about one that
	// was on screen at the switch: the strings have to be MARKED, not merely
	// looked up, or the dialog stays in the language it was opened in for as
	// long as it is up. That shape has shipped in this app twice.
	await page.evaluate(async () => { await window.DaimondI18n.setLocale('fr'); });
	await page.waitForTimeout(900);
	const live = await page.evaluate(() => {
		const c = document.querySelector('.about-card');
		const fr = {};
		['about.what', 'about.splash_alt', 'rel.version', 'common.close',
			'topbar.made_by', 'topbar.made_with_ai'].forEach(k => { fr[k] = window.DaimondI18n.t(k); });
		return {
			up:    !!c && c.getClientRects().length > 0,
			said:  c ? (c.querySelector('.about-said').textContent || '').trim() : '',
			alt:   c ? (c.querySelector('.about-splash').getAttribute('alt') || '') : '',
			label: c ? (c.querySelector('.about-ver-label').textContent || '').trim() : '',
			close: c ? (c.querySelector('.tile-dlg-done').title || '') : '',
			links: c ? [...c.querySelectorAll('a[href]')].map(a => a.getAttribute('aria-label') || '') : [],
			fr,
		};
	});
	check('AND IT REPAINTS ITSELF WHEN THE LANGUAGE CHANGES UNDER IT',
		live.up && live.said === live.fr['about.what']
			&& live.alt === live.fr['about.splash_alt']
			&& live.label === live.fr['rel.version']
			&& live.close === live.fr['common.close']
			&& live.links.includes(live.fr['topbar.made_by'])
			&& live.links.includes(live.fr['topbar.made_with_ai']),
		JSON.stringify(live));

	// And the artwork does NOT change with the language: the splash and the badge
	// are marks, not copy.
	check('and the artwork is the same artwork in any language',
		await page.evaluate(() => {
			const c = document.querySelector('.about-card');
			return /splash\.svg$/.test(c.querySelector('.about-splash').getAttribute('src'))
				&& /made_by_oxedyne\.svg$/.test(c.querySelector('.made-by img').getAttribute('src'));
		}));
	await page.evaluate(async () => { await window.DaimondI18n.setLocale('en'); });
	await sleep(600);

	// A dialog that draws itself while throwing is not drawing itself.
	const errs = errors(s).filter(e => !/Failed to load resource/.test(e));
	check('nothing threw while it was on screen', errs.length === 0, errs.slice(0, 3).join(' | '));

	await quieten(page);
	await page.evaluate(() => document.getElementById('about-btn').click());
	await page.waitForTimeout(600);
	await shot(s, 'about' + (BREAK ? '-' + BREAK : ''));
} catch (e) {
	// A run that cannot get to the end of itself IS a failure, and one that says
	// so in the same voice as the rest. Left to throw, the summary below never
	// printed and a `--break` run exited 1 -- which is this file's signal for
	// "the break broke nothing", the opposite of what had happened.
	check('the run got to the end of itself', false, String(e && e.message ? e.message : e).split('\n')[0]);
	try { await shot(s, 'about-threw' + (BREAK ? '-' + BREAK : '')); } catch (e2) { /* no picture either */ }
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0
	? `\nabout: all ${ok.length} checks passed`
	: `\nabout: ${bad.length} of ${ok.length + bad.length} checks FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
