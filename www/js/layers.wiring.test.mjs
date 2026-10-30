// layers.wiring.test.mjs -- that every layer the app opens goes through the stack.
//
//	node --test www/js/layers.wiring.test.mjs
//
// layers.test.mjs proves the stack. This proves nothing opens AROUND it: the
// next dialog somebody writes, or a page shown outside DaimondStack, would
// otherwise bring back a surface the platform's Back leaves the app from, and no
// unit test of the stack could see it. The checks are over the source, by role:
// every builder of a `.modal` registers it, a popover has one opener and one
// closer, and the safe-area inset is applied to each role of
// layer head by ONE rule of its own.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const read = (...p) => readPage(path.join(WWW, ...p), 'utf8');
const JS   = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'));
const count = (s, re) => (s.match(re) || []).length;

test('every file that builds a modal registers it with the stack', () => {
	// className = 'modal ...', elt('div', 'modal'), '<div class="modal ...'.
	const BUILD = /className\s*=\s*'modal[ ']|elt\('div',\s*'modal'\)|html\('<div class="modal[ "]/g;
	let builders = 0;
	for (const f of JS) {
		const s = read('js', f), n = count(s, BUILD);
		if (!n) continue;
		builders += n;
		const reg = count(s, /DaimondLayers\.open\(/g);
		assert.ok(reg >= 1, `${f} builds ${n} modal(s) and never calls DaimondLayers.open`);
	}
	assert.ok(builders >= 8, 'the scan found only ' + builders + ' modal builders; the pattern has drifted');
});

test('every opener of a dialog has the matching closer reporting it', () => {
	for (const f of JS) {
		const s = read('js', f);
		const opens = count(s, /DaimondLayers\.open\(DaimondLayers\.uid\('dialog'\)/g);
		const dones = count(s, /DaimondLayers\.done\(lid\)/g);
		assert.equal(dones >= opens, true, `${f}: ${opens} dialog layer(s) opened, ${dones} closed`);
	}
});

test('nothing flips the retired drawer class (Stack A2: the rail is the home page)', () => {
	let hits = 0;
	for (const f of JS) hits += count(read('js', f), /classList\.(add|remove|toggle)\('drawer-open'/g);	// keeps: drawer-open asserts nothing flips it
	assert.equal(hits, 0, 'drawer-open is flipped in ' + hits + ' places');	// keeps: drawer-open asserts nothing flips it
});

test('a popover is hidden in one place, which tells the stack', () => {
	const w = read('js', 'workspace.js');
	assert.match(w, /function hidePop\(pop\) \{\s*pop\.hidden = true;\s*DaimondLayers\.done\('pop'\);/);
	// Stack A3: on its way home from Settings the Appearance menu is put down closed. Standing in
	// Settings it was a group of rows, never hung on the layer stack, so there is nothing to tell.
	const away = w.match(/function unmountAppearance\(\) \{[\s\S]*?\n\t\}\n/);
	assert.ok(away && /menuEl\.hidden = true/.test(away[0]), 'unmountAppearance puts the menu down closed');
	assert.equal(count(w.replace(away[0], ''), /\b(menuEl|galEl|el|pop)\.hidden = true/g), 1, 'a popover is hidden somewhere other than hidePop');
	assert.equal(count(read('js', 'handmode.js'), /pop\.hidden = true/g), 0);
	assert.match(w, /function openPop[\s\S]*?DaimondLayers\.hang\(pop, 'pop'/);
});

test('the sheet, the palette and the Admin drawer register and report', () => {
	const m = read('js', 'mobile.js'), w = read('js', 'workspace.js'), d = read('js', 'daimond.js');
	assert.match(m, /DaimondLayers\.open\('sheet'/);
	assert.match(m, /DaimondLayers\.done\('sheet'\)/);
	assert.match(w, /DaimondLayers\.open\('palette'/);
	assert.match(w, /DaimondLayers\.done\('palette'\)/);
	for (const id of [ 'admin', 'admin-view' ]) {
		assert.match(d, new RegExp(`DaimondLayers\\.open\\('${id}'`));
		assert.match(d, new RegExp(`DaimondLayers\\.done\\('${id}'\\)`));
	}
});

test('nothing overwrites the history state a layer entry carries', () => {
	for (const f of JS) assert.equal(count(read('js', f), /history\.replaceState\(\{\}/g), 0, f);
});

// ── One history mover (Stack A4i) ───────────────────────────────────────────
// history.js alone moves the session history and hears popstate; the layers and the phone's page stack ask it.
// web.js steps the Web sheet's own frame (`contentWindow.history`), which is the frame's, not the page's.
test('history.js alone moves the history and hears popstate', () => {
	const MOVE = /\.(pushState|replaceState)\s*\(|(?<!contentWindow\.)\bhistory\.(go|back|forward)\s*\(|['"]popstate['"]/g;
	const files = JS.map((f) => [ f, read('js', f) ]);
	for (const f of fs.readdirSync(path.join(HERE, 'page')).filter((n) => n.endsWith('.js'))) files.push([ 'page/' + f, read('js', 'page', f) ]);
	for (const [ f, src ] of files) {
		const code = src.replace(/^\s*(\/\/|\/\*|\*).*$/gm, '');
		if (f === 'history.js') continue;
		assert.equal(count(code, MOVE), 0, `${f} moves history itself: ask DaimondHistory`);
	}
	const h = read('index.html');
	const at = (name) => h.indexOf(`<script src="js/${name}"></script>`);
	assert.ok(at('history.js') > 0 && at('history.js') < at('layers.js'), 'history.js loads before layers.js');
});

test('the stack is loaded before anything that opens a surface', () => {
	const h = read('index.html');
	const at = (name) => h.indexOf(`<script src="js/${name}"></script>`);
	assert.ok(at('layers.js') > 0, 'layers.js is not loaded');
	for (const f of [ 'mobile.js', 'workspace.js', 'pairing.js', 'mail.js', 'report.js', 'handmode.js', 'passcode.js', 'graph.js', 'dockdrag.js' ]) {
		assert.ok(at(f) < 0 || at('layers.js') < at(f), `layers.js must come before ${f}`);
	}
	assert.match(h, /viewport-fit=cover/);
});

// ── Escape is the stack's, not the module's (r535 U4) ───────────────────────

// How many quoted 'Escape' each file may hold in code, and why: the router itself, the one full-screen
// bubble listener that must see what the router did not take, the recorder's list of keys worth keeping,
// and the terminal, where Escape is a byte for the program in it.
const ESCAPE_ALLOW = { 'layers.js': 1, 'daimond.js': 1, 'record.js': 1, 'terminal.js': 3 };

/// The source without its comments, so that a note about Escape is not taken for a handler of it.
const code = (s) => s
	.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
	.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

test('no module answers Escape for itself, outside the few that must', () => {
	for (const f of JS) {
		const n = count(code(read('js', f)), /['"`]Escape['"`]/g);
		assert.equal(n, ESCAPE_ALLOW[f] || 0, `${f} compares a key with 'Escape' ${n} time(s) in code; ${ESCAPE_ALLOW[f] || 0} allowed`);
	}
});

test('the terminal marks the three elements that own Escape as input', () => {
	const t = read('js', 'terminal.js');
	for (const v of [ 'input', 'paste', 'menu' ]) {
		assert.match(t, new RegExp(`\\b${v}\\.setAttribute\\('data-own-escape'`), `terminal.js: ${v} is not marked data-own-escape`);
	}
});

test('what Escape used to close is a layer, or a claim the router asks', () => {
	const d = read('js', 'daimond.js'), p = read('js', 'passcode.js'), m = read('js', 'mobile.js');
	// The Chats menu is a layer (a menu): Back closes it as well.
	assert.match(d, /DaimondLayers\.hang\(menu, 'chatsmenu', closeChatsMenu(, anchor)?\)/);
	assert.match(d, /function closeChatsMenu\(\) \{[^}]*DaimondLayers\.done\('chatsmenu'\)/s);
	// The composer's skill menu and the link form are claims: key modes, no history.
	assert.match(d, /DaimondLayers\.claim\('skill', /);
	assert.match(d, /DaimondLayers\.release\('skill'\)/);
	assert.match(d, /DaimondLayers\.claim\('linkform', /);
	// The passcode dialog is a dialog layer like pairing's and mail's.
	assert.match(p, /DaimondLayers\.open\(DaimondLayers\.uid\('dialog'\), /);
	assert.match(p, /DaimondLayers\.done\(lid\)/);
	// The drawer is gone (Stack A2): the rail is the stack's home page and Back is the history's, so it holds no layer.
	assert.doesNotMatch(m, /DaimondLayers\.open\('drawer'/);
	assert.match(m, /DaimondLayers\.open\('sheet'/);
	// The drag and the graph are claims, held for the page's life, that decline when idle.
	assert.match(read('js', 'dockdrag.js'), /DaimondLayers\.claim\('dockdrag', /);
	assert.match(read('js', 'graph.js'), /DaimondLayers\.claim\('graph', /);
});

test('a claim that is not a surface never opens a history entry', () => {
	for (const f of [ 'dockdrag.js', 'graph.js' ]) {
		const s = read('js', f);
		assert.equal(count(s, /DaimondLayers\.open\(/g), 0, `${f} keeps its Escape as a claim; it must not also open a layer`);
	}
});

// ── The safe-area inset, one rule per role of layer ─────────────────────────

const rule = (css, sel) => {
	const i = css.indexOf(sel);
	assert.ok(i >= 0, 'no rule for ' + sel);
	return css.slice(i, css.indexOf('}', i));
};

test('the phone\'s modal, its card and the identity card keep clear of the status bar', () => {
	const css = read('css', 'mobile.css');
	assert.match(rule(css, '.modal { padding:'), /var\(--safe-t\)/);
	assert.match(rule(css, '.modal-card {'), /var\(--safe-t\)/);
	assert.match(rule(css, '#identity-modal .modal-card'), /var\(--safe-t\)/);
});

test('Settings on a phone stands below the status bar, its body riding the page', () => {
	// The Admin drawer is retired (a9f9374c7): Settings is a page of the stack, and the stack's page holds the inset.
	assert.match(rule(read('css', 'phone', 'stack.css'), '#phone-stack > .phone-page:not(:empty):not([data-page="home"]) {'), /inset:\s*calc\(var\(--safe-t\) \+ 52px\)/);
	assert.match(rule(read('css', 'phone', 'settings.css'), '.sg-page > .admin-body {'), /position:\s*static/);
});

test('the palette stands below the status bar at any height', () => {
	const css = read('css', 'workspace.css');
	assert.match(rule(css, '.pal-scrim {'), /var\(--safe-t\)/);
	assert.match(rule(css, '.pal-scrim { padding-top'), /var\(--safe-t\)/);
});

test('the guide\'s header keeps its controls under the status bar', () => {
	assert.match(rule(read('css', 'guide.css'), '.site-head {'), /padding-top:\s*var\(--safe-t\)/);
});

test('a popover\'s head stays put while its rows scroll', () => {
	assert.match(rule(read('css', 'app.css'), '.pop > .ui-head { position'), /position:\s*sticky/);
});

test('a popover opened from a row of the fold gives the stack the fold\'s own button to return to', () => {
	// Settings is a row of Help's popover on a phone. Opening it hides that popover, so the row is not drawn when
	// the layer is recorded, and Escape would give the keyboard to the page instead of to Help (r535 K1).
	const w = read('js', 'workspace.js');
	const open = w.slice(w.indexOf('function openPop'), w.indexOf('function hidePop'));
	assert.match(open, /getClientRects\(\)\.length/, 'openPop does not ask whether the anchor is drawn');
	assert.match(open, /getElementById\('help-btn'\)/, 'openPop has no drawn trigger to fall back on');
	assert.match(open, /DaimondLayers\.hang\(pop, 'pop',[\s\S]*?\},\s*back\)/, 'the stack is not handed the drawn trigger');
});

// ── Menus are the stack's: one at a time, gone on navigation (OWNKEY-PG) ────

// MENUGATE. A menu reaches the body only through DaimondLayers.hang, which registers it as the one menu up. The gate is
// by what code does to the body, not by a class name or a role: every use of the body (or the root, or an alias of
// either) other than a read of its state is on KEPT below, by file and line, with what it puts there and why that is
// no menu. A new menu, whatever its class and however it is built, is a new use and fails; so is an alias
// (`var b = document.body`), a guard chain (`(x || document.body).appendChild(m)`) and an insert next to a child.
// menugate.test.mjs runs the builders themselves and finds no menu on the body that `hang` did not put there.
const BODY = /\bdocument\s*\.\s*(body|documentElement|scrollingElement)\b|\bdocument\s*\[\s*['"](body|documentElement)['"]\s*\]|\bownerDocument\s*\.\s*(body|documentElement)\b|querySelector(All)?\(\s*['"](body|html)\b|getElementsByTagName\(\s*['"](body|html)['"]/g;
const READS = new Set([ 'classList', 'dataset', 'style', 'contains', 'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute',
	'toggleAttribute', 'getBoundingClientRect', 'getClientRects', 'clientWidth', 'clientHeight', 'scrollTop', 'scrollLeft', 'scrollHeight',
	'scrollWidth', 'offsetWidth', 'offsetHeight', 'focus', 'addEventListener', 'removeEventListener', 'querySelector', 'querySelectorAll',
	'getElementsByClassName', 'matches', 'className', 'id', 'lang', 'dir', 'removeChild' ]);

/// Every use of the body in `src` that is not a read of its state: [ trimmed line, … ], one per use.
function bodyUses(src) {
	const out = [];
	for (const ln of src.split('\n')) {
		const tr = ln.trim();
		if (/^(\/\/|\/\*|\*)/.test(tr)) continue;
		BODY.lastIndex = 0;
		let m;
		while ((m = BODY.exec(ln))) {
			const after = ln.slice(m.index + m[0].length), before = ln.slice(0, m.index);
			const mem = after.match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
			if (mem && READS.has(mem[1])) continue;
			if (/^\s*[!=]==?/.test(after) || /[!=]==?\s*$/.test(before) || /!\s*$/.test(before)) continue;	// a comparison or a guard
			if (/(getComputedStyle|\.observe)\(\s*$/.test(before)) continue;	// its style read, or its changes watched
			out.push(tr);
		}
	}
	return out;
}

// What else is put on the body, or holds it, and why each is no menu. A line that changes is a new use: say here what
// it puts on the body, or put a menu up with DaimondLayers.hang.
const KEPT = {
	'avatar.js':     [ [ 'document.body.appendChild(box);', 'the avatar picker, a modal' ] ],
	'crystal.js':    [ [ "var el = document.getElementById('crystal-body') || document.body;", 'where the crystal is measured' ],
	                   [ 'var root = document.documentElement;', 'the theme read for the frame' ],
	                   [ '(el || document.body).appendChild(probe);', 'a measuring probe, removed at once' ],
	                   [ "say({ cmd: 'data', data: wireData(data, req, document.body, names) });", 'the page passed as data' ],
	                   [ 'document.body.appendChild(frame);', 'a hidden sight-probe frame' ] ],
	'daimond.js':    [ [ 'document.body.appendChild(box);', 'the storage alarm (role alert), and two toasts' ],
	                   [ 'document.body.appendChild(box);', '' ], [ 'document.body.appendChild(box);', '' ],
	                   [ '(document.body || document.documentElement).appendChild(chatsHeldEl);', 'the chats-held status line' ],
	                   [ '(document.body || document.documentElement).appendChild(chatsHeldEl);', '' ],
	                   [ 'document.body.appendChild(b);', 'the left banner (role status)' ],
	                   [ 'var root = document.documentElement;', 'theme properties set on the root' ], [ 'var root = document.documentElement;', '' ],
	                   [ 'document.body.appendChild(back);', 'modal dialogs: confirm and prompt, the tile dialogs, the lock' ],
	                   [ 'document.body.appendChild(back);', '' ], [ 'document.body.appendChild(back);', '' ], [ 'document.body.appendChild(back);', '' ],
	                   [ 'document.body.appendChild(menu);', 'the / skill list: a listbox of the composer, a claim of its input and no layer' ],
	                   [ 'document.body.appendChild(ta);', 'a copy textarea, removed at once' ] ],
	'debugshare.js': [ [ '(document.head || document.body || document.documentElement).appendChild(s);', 'a style element' ],
	                   [ '(document.head || document.body || document.documentElement).appendChild(s);', '' ] ],
	'dockdrag.js':   [ [ 'document.body.appendChild(overlay);', 'the drop-zone overlay of a drag' ],
	                   [ 'document.body.appendChild(g);', 'the dragged ghost' ] ],
	'fullscreen.js': [ [ 'var docEl = document.documentElement;', 'what full screen is asked of' ] ],
	'lapse.js':      [ [ 'document.body.appendChild(host);', 'the notices host' ] ],
	'lensshot.js':   [ [ 'return S.rasterise(document.body, { viewport: true, frame_label: label })', 'a screenshot of the page' ] ],
	'mail.js':       [ [ 'document.body.appendChild(back);', 'a modal dialog' ] ],
	'mobile.js':     [ [ 'var root = document.documentElement;', 'the viewport properties' ],
	                   [ 'document.body.appendChild(mirror);', 'a hidden caret-measuring mirror' ] ],
	'models.js':     [ [ 'var cs = getComputedStyle(inp.isConnected ? inp : document.body);', 'a style read' ],
	                   [ 'document.body.appendChild(mpPop);', 'the model picker\'s list: a listbox of its input, closed on blur, no layer' ] ],
	'pairing.js':    [ [ 'document.body.appendChild(scrim);', 'the pairing modal' ] ],	// keeps: scrim pairing.js's own local, not #scrim
	'passcode.js':   [ [ 'document.body.appendChild(scrim);', 'the passcode modal' ] ],	// keeps: scrim passcode.js's own local, not #scrim
	'record.js':     [ [ "push({ type: 'key', key: name }, el.nodeType === 1 ? el : document.body);", 'the target of a recorded key' ],
	                   [ 'document.body.appendChild(badge);', 'the recording badge' ] ],
	'render.js':     [ [ 'document.body.appendChild(ta);', 'a copy textarea, removed at once' ] ],
	'report.js':     [ [ 'document.body.appendChild(wrap);', 'the report modal and its alert line' ], [ 'document.body.appendChild(wrap);', '' ] ],
	'selfshot.js':   [ [ 'if (!sel || !String(sel).trim()) return document.body;', 'the page as a screenshot target' ],
	                   [ "var root = name === 'screen' ? document.body : viewEl(name);", '' ] ],
	'share.js':      [ [ 'document.body.appendChild(input);', 'a file input, clicked and removed' ], [ 'document.body.appendChild(input);', '' ] ],
	'support.js':    [ [ 'document.body.appendChild(wrap);', 'the support modal' ] ],
	'syncicon.js':   [ [ 'document.body.appendChild(tip);', 'the sync tooltip' ] ],
	'testnet.js':    [ [ 'document.body.appendChild(wrap);', 'the Testnet sheet (a modal)' ] ],
	'terminal.js':   [ [ 'document.body.appendChild(ta);', 'a copy textarea, removed at once' ] ],
	'undo.js':       [ [ 'document.body.appendChild(el);', 'the undo bar (role status)' ] ],
	'updater.js':    [ [ 'document.body.appendChild(b);', 'the update banner (role status)' ] ],
	'viewer.js':     [ [ 'document.body.appendChild(a);', 'a download link, clicked and removed' ] ],
	'web.js':        [ [ "var main = document.querySelector('main, [role=\"main\"], article') || document.body;", 'what a page reader reads' ] ],
	'workspace.js':  [ [ 'document.body.appendChild(safeProbe);', 'the safe-area probe, hidden' ] ],
};
const tally = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());

/// What in file `f`, whose source is `src`, puts something on the body that neither hang nor KEPT accounts for.
function unnamed(f, src) {
	const got = tally(bodyUses(src)), want = tally((KEPT[f] || []).map((k) => k[0])), out = [];
	for (const [ ln, n ] of got) {
		if ((want.get(ln) || 0) < n) out.push(`${f}: \`${ln}\` puts something on the body (${n} use(s), ${want.get(ln) || 0} named). `
			+ 'A menu goes up with DaimondLayers.hang(el, id, close, opener); anything else is named in KEPT with why it is no menu');
	}
	return out;
}

test('nothing reaches the body but through DaimondLayers.hang, outside the uses named here (MENUGATE)', () => {
	for (const f of JS) {
		if (f === 'layers.js') continue;		// hang itself
		assert.deepEqual(unnamed(f, read('js', f)), []);
		const got = tally(bodyUses(read('js', f)));
		for (const [ ln, n ] of tally((KEPT[f] || []).map((k) => k[0]))) {
			assert.equal(got.get(ln) || 0, n, `${f}: KEPT names \`${ln}\` ${n} time(s) and the source has ${got.get(ln) || 0}: prune it`);
		}
	}
	for (const f of Object.keys(KEPT)) assert.ok(JS.includes(f), `KEPT names ${f}, which is gone`);
});

test('the gate fails a new menu whatever its class, role or route to the body (the QA mutations, and the aliases)', () => {
	const d = read('js', 'daimond.js');
	const builder = (cls, attach, reg) => `\n\tfunction openSeatMenu(anchor) {\n\t\tvar menu = document.createElement('div');\n\t\t${cls}\n`
		+ `\t\t${attach}\n\t\t${reg}\n\t}\n`;
	const MUT = [
		[ 'class seat-menu, a plain open',            builder("menu.className = 'seat-menu';", 'document.body.appendChild(menu);', "DaimondLayers.open('seatmenu', function () {}, anchor);") ],
		[ 'classList.add, no layers call',            builder("menu.classList.add('railhead-menu');", 'document.body.appendChild(menu);', '') ],
		[ 'classList.add with a new class name',      builder("menu.classList.add('seat-picker');", 'document.body.appendChild(menu);', '') ],
		[ 'class railhead-menu seat, a plain open',   builder("menu.className = 'railhead-menu seat';", 'document.body.appendChild(menu);', "DaimondLayers.open('seatmenu', function () {});") ],
		[ 'no role and no class at all',              builder('', 'document.body.append(menu);', '') ],
		[ 'an alias of the body',                     builder('', 'var host = document.body; host.appendChild(menu);', '') ],
		[ 'a guard chain',                            builder('', '(document.body || document.documentElement).appendChild(menu);', '') ],
		[ 'next to a child of the body',              builder('', 'document.body.firstElementChild.after(menu);', '') ],
		[ 'on the root',                              builder('', 'document.documentElement.appendChild(menu);', '') ],
		[ 'through a query',                          builder('', "document.querySelector('body').appendChild(menu);", '') ],
		[ 'through an element\'s document',           builder('', 'anchor.ownerDocument.body.insertAdjacentElement(\'beforeend\', menu);', '') ],
		[ 'a second copy of a named line',            builder('', 'document.body.appendChild(back);', '') ],
	];
	for (const [ what, m ] of MUT) assert.ok(unnamed('daimond.js', d + m).length > 0, 'the gate let through a menu put up by ' + what);
	assert.ok(unnamed('seat.js', builder("menu.className = 'railhead-menu';", 'document.body.appendChild(menu);', '')).length > 0, 'a new file');
	assert.equal(unnamed('daimond.js', d + builder("menu.classList.add('seat-picker');", '', "DaimondLayers.hang(menu, 'seatmenu', function () {}, anchor);")).length, 0,
		'a menu put up through hang is the rule kept');
});

test('the stack takes a menu only with its element: DaimondLayers.menu and a plain open of a menu are gone', () => {
	for (const f of JS) {
		const s = read('js', f);
		assert.equal(count(s, /DaimondLayers\.menu\(/g), 0, `${f} registers a menu apart from its element; use DaimondLayers.hang`);
		assert.equal(count(s, /DaimondLayers\.open\('(sourcemenu|chatsmenu|filesmenu|tagmore|foldmenu|pop)'/g), 0,
			`${f} opens a menu as a plain layer: it would outlive a navigation and stand over the next control`);
	}
	const hangs = JS.reduce((n, f) => n + count(read('js', f), /DaimondLayers\.hang\(/g), 0);
	assert.ok(hangs >= 6, 'only ' + hangs + ' menus go up through hang; the source, Chats, Workspace, tag, fold and pop menus all do');
	assert.match(read('js', 'workspace.js'), /DaimondLayers\.hang\(pop, 'pop'/);
	const d = read('js', 'daimond.js');
	assert.match(d, /DaimondLayers\.hang\(menu, 'foldmenu', closeFoldMenu/);
	assert.match(d, /function closeFoldMenu\(\) \{[\s\S]*?DaimondLayers\.done\('foldmenu'\)[\s\S]*?\n\t\}/);
});

test('every navigation leaves the menu that is up: show, mshow, hide, selectChat and selectDiamond', () => {
	const d = read('js', 'daimond.js');
	const body = (re) => {
		const m = d.match(re);
		assert.ok(m, 'no ' + re);
		const at = m.index, tabs = m[1];
		return d.slice(at, d.indexOf('\n' + tabs + '}\n', at));
	};
	const ms = body(/\n(\t)function mshow\(name, opts\) \{/);
	assert.ok(ms.indexOf('DaimondLayers.leave()') >= 0 && ms.indexOf('DaimondLayers.leave()') < ms.indexOf('return;'), 'mshow: leave() must come ahead of every early return');
	const sh = body(/\n(\t\t)function show\(id, opts\) \{/);
	const lv = sh.indexOf('if (!quiet) DaimondLayers.leave();');
	assert.ok(lv >= 0 && lv < sh.indexOf('if (open[id] && seated(id))'), 'show: a panel a person asks for must leave the menu, ahead of the already-open shortcut');
	assert.match(body(/\n(\t\t)function hide\(id\) \{/), /DaimondLayers\.leave\(\);/, 'hide leaves the menu up');
	for (const [ name, re ] of [ [ 'selectChat', /\n(\t)function selectChat\(chat\) \{/ ], [ 'selectDiamond', /\n(\t)async function selectDiamond\(f, view\) \{/ ] ]) {
		const s = body(re), lv2 = s.indexOf('DaimondLayers.leave();');
		assert.ok(lv2 >= 0 && lv2 < s.indexOf('moveComposerTo('), `${name}: leave() must come ahead of moveComposerTo, while the old chat is still current`);
	}
	assert.equal(count(d, /Files\.onLeave\(/g), 0, 'Files.onLeave is the stack\'s job now');
});

test('the chat on screen changes in one place, which leaves the menu up: setCurrent (MENUGATE, the LOW of runnerdoor QA)', () => {
	const d = read('js', 'daimond.js');
	// Every assignment to `current`, the shadowing `var current` of another function aside.
	const sets = [ ...d.matchAll(/(?<![.\w$])current\s*=(?!=)/g) ].filter((m) => !/var\s+$/.test(d.slice(m.index - 8, m.index)));
	const fn = d.match(/\n\tfunction setCurrent\(chat\) \{[\s\S]*?\n\t\}\n/);
	assert.ok(fn, 'no setCurrent: each change of the chat on screen is its own, and the one that forgets leave() leaves a menu bound to the old chat');
	assert.equal(sets.length, 1, sets.length + ' assignments to current; all but setCurrent\'s should call it');
	assert.ok(sets[0].index > fn.index && sets[0].index < fn.index + fn[0].length, 'the one assignment to current is not setCurrent\'s');
	assert.ok(fn[0].indexOf('DaimondLayers.leave();') >= 0 && fn[0].indexOf('DaimondLayers.leave();') < fn[0].indexOf('current = chat'),
		'setCurrent must leave the menu up while the old chat is still current');
	// The sync path: a merge that finds the open chat deleted elsewhere.
	assert.match(d, /if \(current && !chats\.some\(function \(c\) \{ return c\.id === current\.id; \}\)\) \{\n\t\t\tsetCurrent\(null\);/,
		'a remote deletion of the open chat goes through setCurrent');
});

