// verify_render.mjs — a model's own fold, and what is allowed to ride inside it.
//
// `DaimondRender.md` is the one door model text comes through: `marked` first,
// then a tag/attribute whitelist, and the result goes straight to `innerHTML`
// on the chat, the crystal, the viewer and the Wire. Until 2026-08-21 neither
// `DETAILS` nor `SUMMARY` was on that whitelist — nor on the drop list — so a
// `<details>` fell to the unknown-wrapper branch and the WHOLE fold became one
// text node. A model that folded part of an answer away had every heading, list
// and code block in it destroyed for the trouble: worse off than if it had never
// folded at all. That is the defect this file was written against.
//
// What is asserted, and why each one rather than the next thing:
//
//   1. THE FOLD IS A FOLD, AND ITS CONTENTS SURVIVED. A real `<details>` in the
//      output, with a real `<h2>` and a real `<ul>` inside it, hidden while it
//      is closed and shown when the summary is pressed. "Hidden" is not read off
//      a computed `display` — see the note on CONTAINMENT below, because the
//      obvious rect measurement is a trap here too.
//
//   2. NOTHING EXECUTABLE RIDES IN. The whole payload of an XSS attempt is put
//      INSIDE the fold — a `<script>`, an `<iframe>`, an `onclick`, an image
//      whose `onerror` sets a global, a `javascript:` link and an unknown
//      wrapper — and every one of them is asserted gone. This is the check that
//      admitting two tags did not quietly admit a subtree the sanitiser stops
//      walking.
//
//   3. NESTING. A fold inside a fold, opened one level at a time. The renderer
//      is not given a depth limit for `<details>` that it does not have for
//      `<div>`, so what is asserted is that the recursion composes.
//
//   4. A FOLD WITH NO SUMMARY. The renderer does NOT invent a label. The
//      browser draws its own, in the BROWSER's language rather than the app's,
//      and that is the accepted cost: a synthesised label needs a string in
//      eight locales, and inventing words the model did not write is not the
//      renderer's job. What is asserted is that the fold still works and that
//      no label was made up — the second half so the decision cannot be
//      reversed silently.
//
//   5. AN ORPHAN SUMMARY. A `<summary>` outside a `<details>` is a disclosure
//      label with nothing to disclose: the browser still draws the triangle, so
//      it reads as a control and does nothing. Its words are kept, its markup
//      is not.
//
//   6. `open`. A model saying the fold starts expanded is obeyed, and a model
//      saying nothing gets a closed fold.
//
//   7. STYLING, BOTH WAYS. A model's fold is drawn in the app's own language,
//      and the app's OWN `<details>` — the release notes' list of sealed
//      builds — is not, because the class is stamped by the sanitiser rather
//      than matched on a bare element.
//
// CONTAINMENT, AND WHY NOT A BARE RECT. A closed `<details>` in Chrome puts its
// contents behind `content-visibility: hidden`, and a skipped subtree KEEPS ITS
// LAST LAYOUT: `getBoundingClientRect()` on the heading inside a closed fold
// comes back 588x32.5 with one client rect, sitting below the 28px-tall fold
// that is supposedly containing it. Measured that way every check below would
// pass on a fold that never opens. So "shown" is two geometric facts together —
// the content's rect lies INSIDE the fold's own rect, and the point at its
// centre hit-tests to something inside the fold — and "hidden" is the negation
// of both. This is the same family as `verify_view`'s chip-in-a-scroller, found
// four days earlier, and it is recorded here because the rect looked fine.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page (through
// `page.route`), and the run is then expected to FAIL. A break whose anchor does
// not appear exactly once aborts rather than passing quietly.
//
//   node dev/verify_render.mjs --break nofold       # 1: THE DEFECT AS IT SHIPPED
//   node dev/verify_render.mjs --break norecurse    # 2: scrub stops at the fold
//   node dev/verify_render.mjs --break letscript    # 2: a <script> inside it
//   node dev/verify_render.mjs --break letiframe    # 2: an <iframe> inside it
//   node dev/verify_render.mjs --break letonerror   # 2: a handler that fires
//   node dev/verify_render.mjs --break letjsurl     # 2: a javascript: link
//   node dev/verify_render.mjs --break synthsummary # 4: a label we invented
//   node dev/verify_render.mjs --break keeporphan   # 5: a stray disclosure
//   node dev/verify_render.mjs --break noopen       # 6: `open` thrown away
//   node dev/verify_render.mjs --break bareselector # 7: the app's own details
//   node dev/verify_render.mjs --break quietsummary # 7: the fold's label gone quiet
//   node dev/verify_render.mjs                      # and then, clean
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_render.mjs
//
// Needs dev/serve.mjs only. No gateway, and no model: the renderer is handed
// the text a model WOULD have written, so nothing here spends anything.
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

const PROFILE = scratch('pw', 'render' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must appear
// exactly once, or the run below would prove the opposite of what it claims.
const BREAKS = {
	// THE DEFECT AS IT SHIPPED, restored exactly: the whitelist without the two
	// tags on it. Not a synthetic break — this is the file as it stood before
	// the fix, so what reddens under it is what a reader saw in the product.
	nofold: [{
		file: 'js/render.js',
		find: "\t\t'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV',\n"
			+ "\t\t'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'KBD',\n"
			+ "\t\t'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUMMARY', 'SUP',\n"
			+ "\t\t'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',\n",
		with: "\t\t'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM',\n"
			+ "\t\t'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'KBD', 'LI',\n"
			+ "\t\t'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',\n"
			+ "\t\t'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',\n",
	}],
	// The subtree left unwalked. Admitting a container and then not scrubbing
	// what is in it is the exact shape of a whitelist that has been widened
	// without thinking, and it is invisible from the outside of the fold.
	norecurse: [{
		file: 'js/render.js',
		find: '\t\t\tscrub(ch);',
		with: "\t\t\tif (tag !== 'DETAILS') scrub(ch);",
	}],
	// A `<script>` no longer dropped whole, and allowed as an ordinary element.
	letscript: [
		{ file: 'js/render.js',
			find: "\t\t'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',",
			with: "\t\t'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META'," },
		{ file: 'js/render.js',
			find: "\t\t'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV',",
			with: "\t\t'SCRIPT', 'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV'," },
	],
	// The same for an `<iframe>`, which is the one that loads a foreign origin
	// without any script at all.
	letiframe: [
		{ file: 'js/render.js',
			find: "\t\t'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',",
			with: "\t\t'SCRIPT', 'STYLE', 'OBJECT', 'EMBED', 'LINK', 'META'," },
		{ file: 'js/render.js',
			find: "\t\t'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV',",
			with: "\t\t'IFRAME', 'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV'," },
	],
	// An event handler on the attribute whitelist. `onerror` rather than
	// `onclick` on purpose: an image inserted by `innerHTML` really does fail
	// and really does fire, so this break proves the "nothing ran" check by
	// making something run, rather than by making an attribute visible.
	letonerror: [{
		file: 'js/render.js',
		find: "\tvar ATTR_OK = wordSet(['CLASS', 'TITLE', 'ALT', 'ALIGN']);",
		with: "\tvar ATTR_OK = wordSet(['CLASS', 'TITLE', 'ALT', 'ALIGN', 'ONERROR']);",
	}],
	// The URL guard opened to the scheme it exists to refuse.
	letjsurl: [{
		file: 'js/render.js',
		find: '\t\tif (/^(https?:|mailto:|#|\\/)/i.test(v)) return true;',
		with: '\t\tif (/^(https?:|mailto:|javascript:|#|\\/)/i.test(v)) return true;',
	}],
	// The decision about a missing `<summary>`, reversed: a label invented by
	// the renderer, in English, whatever the app is set to.
	synthsummary: [{
		file: 'js/render.js',
		find: "\t\t\tif (tag === 'DETAILS') ch.classList.add('md-fold');",
		with: "\t\t\tif (tag === 'DETAILS') {\n"
			+ "\t\t\t\tch.classList.add('md-fold');\n"
			+ "\t\t\t\tif (!ch.querySelector('summary')) {\n"
			+ "\t\t\t\t\tvar sm = document.createElement('summary');\n"
			+ "\t\t\t\t\tsm.textContent = 'Details';\n"
			+ "\t\t\t\t\tch.insertBefore(sm, ch.firstChild);\n"
			+ "\t\t\t\t}\n"
			+ "\t\t\t}",
	}],
	// A stray `<summary>` kept as markup: a triangle in the middle of a
	// paragraph that looks pressable and is not.
	keeporphan: [{
		file: 'js/render.js',
		find: "\t\t\tvar orphanSummary = (tag === 'SUMMARY' && node.nodeName !== 'DETAILS');",
		with: '\t\t\tvar orphanSummary = false;',
	}],
	// `open` thrown away with every other unvetted attribute, so a model that
	// asks for an expanded fold gets a closed one.
	noopen: [{
		file: 'js/render.js',
		find: "\t\t\t\tif (!keep && up === 'OPEN' && tag === 'DETAILS') keep = true;\n",
		with: '',
	}],
	// The stylesheet matching a bare `details`, so the app's own disclosures
	// take the styling meant for a model's fold. This is what the stamped class
	// exists to prevent and nothing else would notice it.
	bareselector: [{
		file: 'css/app.css',
		find: 'details.md-fold {',
		with: 'details {',
	}],
	// The summary handed back to the quiet treatment it carried before 4017d78,
	// which is the regression that change exists to prevent: a fold's label is
	// the substance of the half that is hidden, and set in the muted ink at the
	// small size it reads as a caption for something rather than a thing to
	// read. Nothing else on the page moves, so only 7a can catch it.
	quietsummary: [{
		file: 'css/app.css',
		find: 'details.md-fold > summary {\n\tpadding: 4px 0;\n\tcolor: var(--text-primary);',
		with: 'details.md-fold > summary {\n\tpadding: 4px 0;\n\tcolor: var(--text-muted);',
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

const TYPE = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

/// The damaged files, ONE BODY PER FILE. Playwright hands a request to the LAST
/// route registered for its URL, so two routes on one file ship only the second
/// edit — and a two-edit break then goes red for half the reason it claims.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		const type = TYPE[path.extname(file)] || 'text/plain';
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: type, body }));
	}
}

// ── The text a model would have written ──────────────────────────────
//
// TWO SHAPES OF THE SAME FOLD, and the difference between them is not this
// file's to fix. CommonMark says an HTML block runs to the next blank line, so
// `<details>` with its content pressed up against it is ONE raw block and the
// markdown inside is never parsed — `## heading` stays four characters and a
// space. Blank lines around the inner markdown are what make it markdown. Both
// are asserted, each for what it can prove: the tight one that the fold is no
// longer flattened, the spaced one that structure inside it survives.
const TIGHT  = '<details><summary>gist</summary>\n## heading\n- a\n- b\n</details>';
const SPACED = '<details>\n<summary>the short of it</summary>\n\n'
	+ '## heading\n\n- a\n- b\n\n```js\nvar x = 1;\n```\n\n</details>';
const NESTED = '<details>\n<summary>outer</summary>\n\n'
	+ '<details>\n<summary>inner</summary>\n\nthe innermost thing\n\n</details>\n\n</details>';
const NOSUM  = '<details>\n\n## unlabelled\n\n</details>';
const ORPHAN = 'before\n\n<summary>stray</summary>\n\nafter';
const OPENED = '<details open>\n<summary>already open</summary>\n\n## expanded\n\n</details>';
// The whole of an attack, inside the fold. Every line of it is a separate thing
// the sanitiser exists to stop, and the image is the one that really fires.
const ATTACK = '<details>\n<summary onclick="window.__pwned=1">gist</summary>\n\n'
	+ '<script>window.__pwned=1;<\/script>\n\n'
	+ '<iframe src="/index.html"></iframe>\n\n'
	+ '<img src="/no-such-image-9104.png" onerror="window.__pwned=1">\n\n'
	+ '<a href="javascript:window.__pwned=1">a link</a>\n\n'
	+ '<p onclick="window.__pwned=1">a paragraph</p>\n\n'
	+ '<marquee>an unknown wrapper</marquee>\n\n</details>';

// ── Driving ──────────────────────────────────────────────────────────
//
// No sign-in and no provider: the renderer is a pure function of its text, and
// the gate in front of the app does not change what `DaimondRender.md` returns.
const s = await open({
	name: 'render', profile: PROFILE, signIn: false, connect: false,
	route: serveBreaks,
});
const page = s.page;

try {
	await page.waitForFunction(() => window.DaimondRender && window.DaimondRender.md,
		null, { timeout: 20000 });

	// One host for every sample, laid over the page so a hit test is answered by
	// the fold rather than by whatever the app happens to be showing behind it.
	// `.chat-msg-content` because that is the class the chat renders into, so the
	// message-body rules apply here exactly as they do in the product.
	await page.evaluate((src) => {
		const box = document.createElement('div');
		box.id = 'render-probe';
		box.className = 'chat-msg-content';
		box.style.cssText = 'position:fixed;left:0;top:0;width:640px;'
			+ 'z-index:2147483647;background:var(--bg-primary,#000);padding:8px';
		document.body.appendChild(box);
		for (const [k, text] of Object.entries(src)) {
			const cell = document.createElement('div');
			cell.dataset.sample = k;
			cell.innerHTML = window.DaimondRender.md(text);
			box.appendChild(cell);
		}
	}, { TIGHT, SPACED, NESTED, NOSUM, ORPHAN, OPENED, ATTACK });

	// The attack image has to be given time to fail before "nothing ran" means
	// anything: an `onerror` that has not fired yet is not an `onerror` that was
	// stripped, and the two are indistinguishable at zero milliseconds.
	await page.waitForTimeout(900);

	/// Everything measured in one pass, so a check below reads a number rather
	/// than driving the page itself.
	const geom = await page.evaluate(() => {
		const box = document.getElementById('render-probe');
		const cell = (k) => box.querySelector(`[data-sample="${k}"]`);
		// SHOWN, in two geometric facts at once. See the file header: a closed
		// fold's contents keep their last layout, so a rect with area proves
		// nothing on its own.
		const shown = (el) => {
			if (!el) return { rect: false, hit: false };
			const fold = el.closest('details');
			const a = fold.getBoundingClientRect(), c = el.getBoundingClientRect();
			const inside = c.height > 0 && c.top >= a.top - 0.5 && c.bottom <= a.bottom + 0.5;
			const at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
			return { rect: inside, hit: !!at && fold.contains(at) };
		};
		const out = {};

		// 1 — the fold, and what is in it.
		const tight = cell('TIGHT').querySelector('details');
		out.tight = tight ? {
			stamped: tight.classList.contains('md-fold'),
			// The flattened form has NO element children at all; this is the
			// difference between a fold and one text node.
			elements: tight.querySelectorAll('*').length,
			text: cell('TIGHT').textContent.replace(/\s+/g, ' ').trim(),
		} : null;
		// THE DEFECT, NAMED. Flattened, the whole fold is one text node and
		// the cell has nothing else in it. This is the shape the product
		// shipped, and it is what `--break nofold` puts back.
		const tcell = cell('TIGHT');
		out.tightFlat = tcell.childNodes.length === 1 && tcell.firstChild.nodeType === 3;
		out.tightText = tcell.textContent.replace(/\s+/g, ' ').trim();

		const sp = cell('SPACED').querySelector('details');
		out.spaced = sp ? {
			summary: sp.querySelector(':scope > summary')
				? sp.querySelector(':scope > summary').textContent.trim() : null,
			h2: !!sp.querySelector('h2'),
			lis: sp.querySelectorAll('ul > li').length,
			closedH: +sp.getBoundingClientRect().height.toFixed(1),
			shutH2: shown(sp.querySelector('h2')),
		} : null;
		if (sp) {
			sp.querySelector(':scope > summary').click();
			out.spaced.openH = +sp.getBoundingClientRect().height.toFixed(1);
			out.spaced.openH2 = shown(sp.querySelector('h2'));
			// The code-block transform runs on the string AFTER sanitisation, so
			// this is the check that the trusted pass still finds a fence that
			// is inside a fold rather than beside one.
			out.spaced.codeBlock = !!sp.querySelector('.code-block .code-copy-btn');
			out.spaced.styles = {
				border: getComputedStyle(sp).borderLeftWidth,
				colour: getComputedStyle(sp.querySelector(':scope > summary')).color,
			};
			sp.open = false;
		}

		// 2 — the attack.
		const atk = cell('ATTACK');
		const fold = atk.querySelector('details');
		const on = [];
		if (fold) for (const el of fold.querySelectorAll('*')) {
			for (const a of el.attributes) if (/^on/i.test(a.name)) on.push(el.tagName + '@' + a.name);
		}
		out.attack = {
			fold: !!fold,
			scripts: atk.querySelectorAll('script').length,
			frames: atk.querySelectorAll('iframe').length,
			handlers: on,
			jsHrefs: [...atk.querySelectorAll('a')].filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
			// `<marquee>` is not on the whitelist, so it must have been reduced
			// to its words — inside the fold, which is where the recursion is.
			marquees: atk.querySelectorAll('marquee').length,
			marqueeWords: atk.textContent.includes('an unknown wrapper'),
			rels: [...atk.querySelectorAll('a')].map(a => a.getAttribute('rel')),
			ran: typeof window.__pwned !== 'undefined',
		};

		// 3 — nesting.
		const outer = cell('NESTED').querySelector('details');
		const inner = outer ? outer.querySelector('details') : null;
		out.nested = {
			both: !!outer && !!inner,
			stamped: !!inner && inner.classList.contains('md-fold'),
			body: !!inner && !!inner.querySelector('p'),
		};
		if (inner) {
			out.nested.shut     = shown(inner.querySelector('p'));
			outer.open = true;
			out.nested.outerOnly = shown(inner.querySelector('p'));
			inner.open = true;
			out.nested.bothOpen  = shown(inner.querySelector('p'));
			outer.open = false; inner.open = false;
		}

		// 4 — a fold with no summary.
		const ns = cell('NOSUM').querySelector('details');
		out.nosum = ns ? {
			invented: !!ns.querySelector('summary'),
			h2: !!ns.querySelector('h2'),
			shut: shown(ns.querySelector('h2')),
			// Where a real mouse must land to hit the label the BROWSER drew.
			at: (() => { const r = ns.getBoundingClientRect(); return { x: r.left + 24, y: r.top + 8 }; })(),
		} : null;

		// 5 — an orphan summary.
		out.orphan = {
			survived: cell('ORPHAN').querySelectorAll('summary').length,
			words: cell('ORPHAN').textContent.includes('stray'),
		};

		// 6 — `open`.
		const op = cell('OPENED').querySelector('details');
		out.opened = op ? { open: op.open, h2: shown(op.querySelector('h2')) } : null;

		// 7 — the app's own disclosure, which must NOT be dressed as a model's.
		const mine = document.createElement('details');
		mine.innerHTML = '<summary>the app\'s own</summary><p>body</p>';
		box.appendChild(mine);
		out.appOwn = { border: getComputedStyle(mine).borderLeftWidth };
		mine.remove();
		return out;
	});

	console.log(JSON.stringify(geom, null, 1));

	// ── 1. The fold is a fold, and its contents survived ──────────────
	check('1a a `<details>` survives the renderer at all',
		!!geom.tight, geom.tight ? null : 'flattened to: ' + JSON.stringify(geom.tightText));
	// The tight form's INNER markdown is not parsed and is not expected to be:
	// CommonMark runs an HTML block to the next blank line, so `## heading` here
	// is four characters and a space, exactly as it was before the fix. What
	// this asserts is the fold itself — that the cell is not one text node with
	// every element in it gone.
	check('1b the fold is not one flat text node',
		geom.tightFlat === false && !!geom.tight && geom.tight.elements >= 1,
		geom.tight ? geom.tight.elements + ' element(s), flat=' + geom.tightFlat
			: 'flat=' + geom.tightFlat + ' ' + JSON.stringify(geom.tightText));
	check('1c the sanitiser stamped it, so the stylesheet can find it',
		!!geom.tight && geom.tight.stamped);
	check('1d a heading and a two-item list survive INSIDE the fold',
		!!geom.spaced && geom.spaced.h2 && geom.spaced.lis === 2,
		geom.spaced ? `h2=${geom.spaced.h2} li=${geom.spaced.lis}` : 'no fold');
	check('1e the summary carries the model\'s own words',
		!!geom.spaced && geom.spaced.summary === 'the short of it',
		geom.spaced ? JSON.stringify(geom.spaced.summary) : null);
	check('1f closed, the heading is not shown — neither contained nor hit',
		!!geom.spaced && !geom.spaced.shutH2.rect && !geom.spaced.shutH2.hit,
		geom.spaced ? JSON.stringify(geom.spaced.shutH2) : null);
	check('1g pressing the summary shows it — contained AND hit, and the fold grew',
		!!geom.spaced && geom.spaced.openH2.rect && geom.spaced.openH2.hit
			&& geom.spaced.openH > geom.spaced.closedH,
		geom.spaced ? `${geom.spaced.closedH} → ${geom.spaced.openH}px, ${JSON.stringify(geom.spaced.openH2)}` : null);

	check('1h a fenced code block inside the fold keeps its Copy button',
		!!geom.spaced && geom.spaced.codeBlock === true,
		geom.spaced ? String(geom.spaced.codeBlock) : 'no fold');

	// ── 2. Nothing executable rides in ──────────────────────────────────
	check('2a no `<script>` survives inside the fold',
		geom.attack.scripts === 0, String(geom.attack.scripts));
	check('2b no `<iframe>` survives inside the fold',
		geom.attack.frames === 0, String(geom.attack.frames));
	check('2c no `on*` handler survives on anything inside the fold',
		geom.attack.handlers.length === 0, geom.attack.handlers.join(', '));
	check('2d and nothing RAN: the image failed with no handler left on it',
		geom.attack.ran === false, geom.attack.ran ? 'window.__pwned was set' : null);
	check('2e a `javascript:` link did not survive inside the fold',
		geom.attack.jsHrefs === 0, String(geom.attack.jsHrefs));
	check('2f an unknown wrapper inside the fold is still reduced to its words',
		geom.attack.marquees === 0 && geom.attack.marqueeWords,
		`marquee=${geom.attack.marquees} words=${geom.attack.marqueeWords}`);
	check('2g links inside the fold still get rel="noopener noreferrer nofollow"',
		geom.attack.rels.length > 0 && geom.attack.rels.every(r => r === 'noopener noreferrer nofollow'),
		JSON.stringify(geom.attack.rels));

	// ── 3. Nesting ────────────────────────────────────────────────────
	check('3a a fold inside a fold is two folds, both stamped',
		geom.nested.both && geom.nested.stamped, JSON.stringify(geom.nested));
	check('3b the inner fold\'s body survives as markup',
		geom.nested.body);
	// Absent measurements read as "not shown" rather than throwing, so a break
	// that removes the fold altogether still reports every check it damaged
	// instead of stopping the run at the first missing property.
	const sh = (x) => x || { rect: false, hit: false };
	check('3c it opens one level at a time — shut, outer only, then both',
		!sh(geom.nested.shut).rect && !sh(geom.nested.shut).hit
			&& !sh(geom.nested.outerOnly).rect && !sh(geom.nested.outerOnly).hit
			&& sh(geom.nested.bothOpen).rect && sh(geom.nested.bothOpen).hit,
		JSON.stringify({ shut: geom.nested.shut, outerOnly: geom.nested.outerOnly, both: geom.nested.bothOpen }));

	// ── 4. A fold with no summary ─────────────────────────────────────
	check('4a the renderer invents no label for an unlabelled fold',
		!!geom.nosum && geom.nosum.invented === false,
		geom.nosum ? String(geom.nosum.invented) : 'no fold');
	check('4b its content survives and is hidden while it is shut',
		!!geom.nosum && geom.nosum.h2 && !geom.nosum.shut.rect && !geom.nosum.shut.hit,
		geom.nosum ? JSON.stringify(geom.nosum.shut) : null);
	if (geom.nosum) {
		// A real mouse, on the label the browser drew for itself. `details.click()`
		// would not do: the UA's summary is in a shadow root, so a synthetic click
		// on the `<details>` never reaches the thing that toggles it.
		await page.mouse.click(geom.nosum.at.x, geom.nosum.at.y);
		await page.waitForTimeout(150);
		const after = await page.evaluate(() => {
			const ns = document.querySelector('[data-sample="NOSUM"] details');
			const h2 = ns.querySelector('h2');
			const a = ns.getBoundingClientRect(), c = h2.getBoundingClientRect();
			const at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
			return { open: ns.open, rect: c.top >= a.top - 0.5 && c.bottom <= a.bottom + 0.5,
				hit: !!at && ns.contains(at) };
		});
		check('4c the browser\'s own label still works as a disclosure',
			after.open && after.rect && after.hit, JSON.stringify(after));
	}

	// ── 5. An orphan summary ──────────────────────────────────────────
	check('5a a `<summary>` outside a fold does not survive as markup',
		geom.orphan.survived === 0, String(geom.orphan.survived));
	check('5b but its words do',
		geom.orphan.words);

	// ── 6. `open` ─────────────────────────────────────────────────────
	check('6a `<details open>` starts expanded',
		!!geom.opened && geom.opened.open && geom.opened.h2.rect && geom.opened.h2.hit,
		geom.opened ? JSON.stringify(geom.opened) : 'no fold');
	check('6b `<details>` without it starts closed',
		!!geom.spaced && geom.spaced.closedH < geom.spaced.openH,
		geom.spaced ? `${geom.spaced.closedH}px closed` : null);

	// ── 7. Styling, both ways ─────────────────────────────────────────
	// WHICH INK, AND WHY IT MOVED. This read `--text-muted` until 4017d78, when
	// the summary was deliberately given the answer's own size and ink: a fold's
	// label is now a sentence or two of what the fold concludes, so it has to be
	// legible at the weight of the reply it belongs to, and the left edge and
	// the triangle are what say it is foldED. The muted treatment stayed with
	// the thinking tile, which is the model's own working and must not compete.
	// So the token asked for here is `--text-primary`. Left pointing at the old
	// one, this check has been red since seq 147 about a change it was never
	// told of -- three releases went out over it.
	const ink = await page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim());
	const asRgb = await page.evaluate((hex) => {
		const d = document.createElement('span'); d.style.color = hex;
		document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c;
	}, ink);
	check('7a a model\'s fold is drawn in the app\'s language, not the browser\'s',
		!!geom.spaced && geom.spaced.styles.border === '2px'
			&& geom.spaced.styles.colour === asRgb,
		geom.spaced ? JSON.stringify(geom.spaced.styles) + ' vs ' + asRgb : null);
	check('7b the app\'s OWN `<details>` is untouched by it',
		geom.appOwn.border === '0px', geom.appOwn.border);

	// ── 8. The copy button COPIES, which is not the same as being there ──
	//
	// `7`'s `out.spaced.codeBlock` asserts a `.code-copy-btn` is on the page, and that
	// is all it asserts. On 2026-08-28 `dev/mutate.mjs` changed the class the delegated
	// listener in www/js/render.js looks for -- from `code-copy-btn` to something
	// nothing wears -- and every check in this file stayed green while the button under
	// every code block silently stopped working. The element was still there; only the
	// behaviour had gone, and presence was the only thing being asked about.
	//
	// So this presses it and reads what the press did. The clipboard itself is not
	// available to a headless page without a permission grant, and the point here is
	// the WIRING rather than the platform: a press that reaches the handler changes the
	// button's label and adds `copied`, and a press that reaches nothing leaves both
	// exactly as they were. That is the difference the mutation makes, so that is what
	// is measured.
	const copied = await s.page.evaluate(async () => {
		const btn = document.querySelector('.code-block .code-copy-btn');
		if (!btn) return { found: false };
		const before = btn.textContent;
		btn.click();
		// The handler runs a promise before it relabels, so give the microtask queue a
		// turn rather than reading the button in the same tick that pressed it.
		await new Promise(r => setTimeout(r, 250));
		return {
			found:   true,
			before,
			after:   btn.textContent,
			marked:  btn.classList.contains('copied'),
			changed: btn.textContent !== before || btn.classList.contains('copied'),
		};
	});
	check('8 the copy button under a code block is WIRED, not merely present',
		copied.found && copied.changed,
		copied.found
			? `label ${JSON.stringify(copied.before)} -> ${JSON.stringify(copied.after)}, `
				+ `copied=${copied.marked}; unchanged means the press reached no handler`
			: 'no .code-copy-btn on the page at all');

	// The renderer drawing itself while throwing is not drawing itself. The
	// attack's own 404 is expected — the image is MEANT to fail, that is what
	// makes 2d mean anything — so it is not counted as the app throwing.
	const errs = errors(s).filter(e => !/no-such-image-9104/.test(e))
		.filter(e => !/Failed to load resource/.test(e));
	check('nothing threw while it was on screen', errs.length === 0, errs.slice(0, 3).join(' | '));

	await shot(s, 'render-fold' + (BREAK ? '-' + BREAK : ''));
} catch (e) {
	// A run that cannot get to the end of itself IS a failure, and one that says
	// so in the same voice as the rest.
	check('the run got to the end of itself', false, String(e && e.message ? e.message : e).split('\n')[0]);
	try { await shot(s, 'render-threw' + (BREAK ? '-' + BREAK : '')); } catch (e2) { /* no picture either */ }
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0
	? `\nrender: all ${ok.length} checks passed`
	: `\nrender: ${bad.length} of ${ok.length + bad.length} checks FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
