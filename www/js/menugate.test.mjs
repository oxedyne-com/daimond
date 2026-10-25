// menugate.test.mjs -- MENUGATE, at run time: the app's own menu builders, run against a stand-in DOM with the real
// layers.js, leave no menu on the body that DaimondLayers.hang did not put there.
//
//	node --test www/js/menugate.test.mjs
//
// layers.wiring.test.mjs holds the source to one route onto the body. This runs what the source does: each builder is
// cut out of daimond.js or workspace.js by name and called, and after every open the body is asked for strays
// (`DaimondLayers.strays()`: a role=menu child that hang did not put up). The last test plants a builder that skips
// hang, and the same check finds it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = { d: readFileSync(join(HERE, 'daimond.js'), 'utf8'), w: readFileSync(join(HERE, 'workspace.js'), 'utf8') };

/// The function `name` defined at `tabs` indentation in `src`, from its head to its closing brace.
function cut(src, name, tabs = '\t') {
	const re = new RegExp('\\n' + tabs + '(async )?function ' + name + '\\(', 'g');
	const hits = [ ...src.matchAll(re) ];
	assert.equal(hits.length, 1, name + ' is defined ' + hits.length + ' times at that depth');
	const i = hits[0].index, end = src.indexOf('\n' + tabs + '}\n', i + 1);
	return src.slice(i + 1, end + tabs.length + 2);
}

// ── A stand-in DOM: enough for the builders to make, place and remove their menus ──────
function world() {
	const byId = {};
	function el(tag) {
		const e = {
			tag, children: [], parentNode: null, attrs: {}, dataset: {}, style: {}, listeners: {}, hidden: false,
			className: '', textContent: '', title: '', type: '', disabled: false, offsetWidth: 120, offsetHeight: 80, isConnected: true,
			classList: {
				add(c) { if (!e.classList.contains(c)) e.className = (e.className + ' ' + c).trim(); },
				remove(c) { e.className = e.className.split(/\s+/).filter((x) => x !== c).join(' '); },
				contains(c) { return e.className.split(/\s+/).includes(c); },
				toggle(c, on) { if (on === undefined ? !e.classList.contains(c) : on) e.classList.add(c); else e.classList.remove(c); },
			},
			setAttribute(k, v) { e.attrs[k] = String(v); if (k === 'id') byId[v] = e; },
			getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; },
			removeAttribute(k) { delete e.attrs[k]; },
			addEventListener(t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
			appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = e; e.children.push(c); return c; },
			remove() { if (e.parentNode) e.parentNode.children.splice(e.parentNode.children.indexOf(e), 1); e.parentNode = null; },
			contains(x) { for (; x; x = x.parentNode) if (x === e) return true; return false; },
			focus() { doc.activeElement = e; },
			getBoundingClientRect: () => ({ left: 200, right: 300, top: 40, bottom: 60, width: 100, height: 20 }),
			getClientRects: () => [ {} ],
		};
		return e;
	}
	const body = el('body');
	const doc = {
		body, documentElement: el('html'), activeElement: body, listeners: [],
		createElement: el,
		getElementById: (id) => byId[id] || null,
		addEventListener(t, f, c) { doc.listeners.push([ t, f, c ]); },
		removeEventListener(t, f) { doc.listeners = doc.listeners.filter((l) => !(l[0] === t && l[1] === f)); },
	};
	const hist = { state: null, length: 1, pushState(s) { hist.state = s; hist.length++; }, replaceState(s) { hist.state = s; }, go() {}, back() {} };
	const win = { document: doc, history: hist, innerWidth: 390, innerHeight: 845, DaimondModels: {}, addEventListener() {}, removeEventListener() {} };
	new Function('window', readFileSync(join(HERE, 'layers.js'), 'utf8'))(win);
	return { el, doc, body, win, L: win.DaimondLayers, byId };
}

/// Run `bodies` (source text) with `deps` in scope, and hand back the functions `names`.
function load(bodies, deps, names) {
	const src = bodies.join('\n') + '\nreturn { ' + names.map((n) => n + ': ' + n).join(', ') + ' };';
	return new Function(...Object.keys(deps), src)(...Object.values(deps));
}

/// The app's body-hung menus, each opened in turn in one world.
function app(plant) {
	const W = world(), { el, doc, L } = W;
	const t = (k) => k, tOr = (k, f) => f;
	const deps = {
		document: doc, window: W.win, DaimondLayers: L, setTimeout, t, tOr, tn: (k, n) => k + n,
		// the source menu
		current: { id: 'c1' }, DaimondModels: {}, DaimondI18n: { fillPrices: (e) => e },
		sourceMenuRows: () => [ { id: 'credits', name: 'Daimond credits', checked: true }, { add: true } ],
		openSettings() {}, pickSource() {},
		// the Chats menu
		cfg: {}, readJson: () => ({}), CFG_KEY: 'cfg', localStorage: { setItem() {} }, renderSessionList() {}, chats: [], deleteAllChats() {},
		// the fold menu
		loadChatMessages: async () => {}, noticeDialog() {}, diamonds: [ { id: 'f1', name: 'Kitchen' } ], isBuiltInDiamond: () => false,
		foldChatIntoNew: async () => {}, foldChatInto: async () => {}, foldFailed() {},
		// the tag popover
		tagState: () => 'off', tagChip: (tag) => { const b = el('button'); b.textContent = tag; return b; }, cycleTagFilter() {},
	};
	const d = SRC.d;
	const bodies = [
		'var _sourceMenu = null, _chatsMenu = null, _foldMenu = null, _foldAnchor = null, _tagMore = null, pop = null;',
		cut(d, 'closeSourceMenu'), cut(d, 'onSourceMenuOutside'), cut(d, 'openSourceMenu'),
		cut(d, 'closeChatsMenu'), cut(d, 'onChatsMenuOutside'), cut(d, 'openChatsMenu'),
		cut(d, 'closeFoldMenu'), cut(d, 'onFoldOutside'), cut(d, 'openFoldPicker'),
		cut(d, 'closeTagMore'), cut(d, 'onTagMoreOutside'), cut(d, 'openTagMore'),
		cut(d, 'closePop', '\t\t'), cut(d, 'onPopOutside', '\t\t'), cut(d, 'openPop', '\t\t'),
	];
	const names = [ 'openSourceMenu', 'openChatsMenu', 'openFoldPicker', 'openTagMore', 'openPop' ];
	if (plant) { bodies.push(plant); names.push('openSeatMenu'); }
	const A = load(bodies, deps, names);
	// workspace.js's popovers: elements of the page, already on the body, one shown at a time.
	const wpop = el('div');
	wpop.setAttribute('role', 'dialog');
	W.body.appendChild(wpop);
	const WS = load([ cut(SRC.w, 'openPop') ], {
		document: doc, window: W.win, DaimondLayers: L, safeTop: () => 0,
		dismissPops(keep) { if (wpop !== keep) wpop.hidden = true; },
	}, [ 'openPop' ]);
	return { W, A, WS, wpop, btn: () => W.body.appendChild(el('button')) };
}

const tick = () => new Promise((f) => setTimeout(f, 5));

test('every menu the app hangs on the body went up through hang, and is the one menu up', async () => {
	const { W, A, WS, wpop, btn } = app();
	const opens = [
		[ 'sourcemenu', () => A.openSourceMenu(btn()) ],
		[ 'chatsmenu',  () => A.openChatsMenu(btn()) ],
		[ 'foldmenu',   () => A.openFoldPicker({ _loaded: true, messages: [ { role: 'user', content: 'hi' } ] }, btn()) ],
		[ 'tagmore',    () => A.openTagMore(btn(), [ 'a', 'b' ]) ],
		[ 'filesmenu',  () => A.openPop('head', btn(), 'Files', (item) => { item('x', 'X', () => {}); }) ],
		[ 'pop',        () => WS.openPop(wpop, btn()) ],
	];
	for (const [ id, open ] of opens) {
		await open();
		await tick();
		assert.deepEqual(W.L.strays(), [], id + ' left a menu on the body that hang did not put there');
		assert.equal(W.L.top(), id, id + ' is not the layer up');
		const menus = W.body.children.filter((c) => c.getAttribute('role') === 'menu');
		assert.ok(menus.length <= 1, 'one menu up at a time, and ' + id + ' found ' + menus.length);
		for (const m of menus) assert.ok(W.L.hung(m), id + ': a role=menu on the body not hung');
	}
	assert.ok(W.L.hung(wpop), 'the workspace popover went up through hang');
	assert.equal(wpop.getAttribute('role'), 'dialog', 'and keeps the role the page gave it');
	W.L.leave();
	assert.equal(W.body.children.filter((c) => c.getAttribute('role') === 'menu').length, 0, 'a navigation takes the menu that is up');
});

test('a builder that puts its menu on the body without hang is found, whatever its class', async () => {
	const plant = '\tfunction openSeatMenu(anchor) {\n\t\tvar menu = document.createElement(\'div\');\n'
		+ '\t\tmenu.classList.add(\'seat-picker\');\n\t\tmenu.setAttribute(\'role\', \'menu\');\n\t\tdocument.body.appendChild(menu);\n'
		+ '\t\tDaimondLayers.open(\'seatmenu\', function () { menu.remove(); DaimondLayers.done(\'seatmenu\'); }, anchor);\n\t}\n';
	const { W, A, btn } = app(plant);
	A.openSeatMenu(btn());
	const s = W.L.strays();
	assert.equal(s.length, 1, 'the planted menu is a stray');
	assert.ok(s[0].classList.contains('seat-picker'));
	W.L.leave();
	assert.equal(s[0].parentNode, W.body, 'and, not being a menu of the stack\'s, it outlives a navigation: the fault the gate exists for');
});

test('a remote deletion of the open chat (the merge\'s setCurrent(null)) takes the source menu bound to it', async () => {
	const { W, A, btn } = app();
	await A.openSourceMenu(btn());
	assert.equal(W.L.top(), 'sourcemenu');
	let cur = { id: 'c1' }, checks = 0;
	const S = load([ 'var current = cur;', cut(SRC.d, 'setCurrent') ], { DaimondLayers: W.L, cur, undoCheck() { checks++; } }, [ 'setCurrent' ]);
	S.setCurrent(null);
	assert.equal(W.body.children.filter((c) => c.classList.contains('source-menu')).length, 0, 'the source menu outlived its chat');
	assert.equal(W.L.top(), null);
	assert.equal(checks, 1, 'the undo bar is asked again, as every change of chat did');
});

