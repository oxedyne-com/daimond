// phonesettings.test.mjs -- on a phone, Settings is a page with Appearance moved in (Stack A3, frame b5).
//
//	node --test www/js/phonesettings.test.mjs
//
// The phone's top bar loses its Appearance button, and the Appearance menu itself MOVES into
// Settings' Appearance group: one `#settings-menu` node, drawn by the one `renderMenu`, never a
// copy. Settings opens on the signed-in member's row, the other five doors of D-20261024-16 in
// their order, then Appearance. This runs the real settingsgroups.js and the real Appearance code
// cut out of workspace.js (mountAppearance .. renderMenu) against a small DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SG   = readFileSync(join(HERE, 'settingsgroups.js'), 'utf8');
const WS   = readFileSync(join(HERE, 'workspace.js'), 'utf8');
const cut  = (s, from, to) => {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	assert.ok(a >= 0 && b > a, `cannot cut ${JSON.stringify(from)} .. ${JSON.stringify(to)} from workspace.js`);
	return s.slice(a, b);
};

function dom() {
	const all = new Set();
	function node(tag) {
		const n = {
			tagName: tag.toUpperCase(), children: [], parentNode: null, id: '', hidden: false, title: '',
			className: '', dataset: {}, style: {}, attrs: {}, _text: '', listeners: {},
			get classList() {
				const self = this;
				return {
					add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); self.className = [...s].join(' '); },
					contains(c) { return self.className.split(/\s+/).includes(c); },
				};
			},
			get firstChild() { return this.children[0] || null; },
			get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
			set textContent(v) { this._text = v; this.children.forEach(c => { c.parentNode = null; }); this.children = []; },
			set innerHTML(v) { this.textContent = ''; },
			setAttribute(k, v) { this.attrs[k] = String(v); },
			getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
			appendChild(c) { return this.insertBefore(c, null); },
			insertBefore(c, ref) {
				if (c.isFrag) { c.children.slice().forEach(x => this.insertBefore(x, ref)); return c; }
				if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
				c.parentNode = this;
				const at = ref ? this.children.indexOf(ref) : -1;
				if (at < 0) this.children.push(c); else this.children.splice(at, 0, c);
				return c;
			},
			insertAdjacentHTML() {},
			addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
			click() { (this.listeners.click || []).forEach(f => f({})); },
			querySelector(sel) { return sel === '[id]' ? walk(this).find(x => x !== this && x.id) || null : null; },
		};
		all.add(n);
		return n;
	}
	function walk(n) { return [n].concat(...n.children.map(walk)); }
	const body = node('body');
	const menu = node('div'); menu.id = 'settings-menu'; menu.className = 'pop'; menu.hidden = true;
	body.appendChild(menu);
	const home = node('div'); home.id = 'admin-home';
	const detail = node('div'); detail.id = 'astat-detail';
	const document = {
		body, styleSheets: [],
		createElement: node,
		createDocumentFragment() { const f = node('#frag'); f.isFrag = true; return f; },
		createTextNode(s) { const n = node('#text'); n._text = s; return n; },
		getElementById(id) {
			if (id === 'admin') return { classList: { contains: c => c === 'admin-open' } };
			for (const n of all) if (n.id === id && (n.parentNode || n === detail || n === home)) return n;
			return null;
		},
	};
	return { document, node, home, detail, menu, body, walk };
}

// The drawer as renderHomeBodyInner draws it, cut down to one row a group; `t` is absent, so text is the key.
const DRAWN = [
	['sec', 'home.sec_account'], ['row', 'Change name…'],
	['sec', 'home.sec_prompts'], ['row', 'Edit the Chat prompt…'],
	['sec', 'home.sec_running'], ['row', 'home.limits'], ['row', 'Search…'],
	['row', 'home.export_backup'],
	['sec', 'home.sec_diag'], ['row', 'Turn diagnostics on'],
	['row', 'home.lock'], ['row', 'home.log_out'],
];
const DOORS = ['models', 'tools', 'prompts', 'data', 'help'];	// "you" is the member's row

function setup({ phone = true } = {}) {
	const d = dom();
	const log = { theme: [], view: [], pushed: 0, groups: [] };
	const draw = () => {
		d.home.innerHTML = '';
		DRAWN.forEach(([kind, text]) => {
			const n = d.node(kind === 'row' ? 'button' : 'div');
			n.className = kind === 'sec' ? 'admin-sec' : 'admin-item';
			n.textContent = text;
			d.home.appendChild(n);
		});
		d.home.appendChild(d.detail);
	};
	const THEMES = { porcelain: 'light', mist: 'light', sage: 'mid', obsidian: 'dark', midnight: 'dark' };
	let theme = 'obsidian';
	const win = {
		document: d.document,
		DaimondIdentity: { exists: () => true, isUnlocked: () => true, displayName: () => 'Ada' },
		DaimondTheme: {
			get: () => theme, spec: (n) => ({ tone: THEMES[n] }), tones: () => ['light', 'mid', 'dark'],
			inTone: (tone) => Object.keys(THEMES).filter(k => THEMES[k] === tone),
			set: (n) => { log.theme.push(n); theme = n; },
		},
		DaimondView: { get: () => 'simple', set: (v) => log.view.push(v) },
	};
	win.window = win;
	// The Appearance code, as shipped, with stand-ins for what the rest of workspace.js gives it.
	const body = cut(WS, '\t// ── Appearance in Settings, on a phone', '\t// ── Language and currency');
	const el = (tag, cls, text) => { const e = d.node(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
	const make = new Function('window', 'document', 'DaimondTheme', 'DaimondView', 'el', 't', 'tn', 'has', 'P',
		'STEPS', 'scale', 'setScale', 'stepName', 'closerHead', 'closeMenu', 'renderLanguage', 'VIEW_IDS',
		'var menuEl = null;' + body + '; return { mountAppearance: mountAppearance, unmountAppearance: unmountAppearance };');
	const P = () => ({ model: () => ({ cols: 1, rows: 1 }), grids: () => ({ auto: {} }), grid: () => 'auto', setGrid() {} });
	win.DaimondWorkspace = make(win, d.document, win.DaimondTheme, win.DaimondView, el, (k) => k, (k) => k, () => false, P,
		[0.85, 1, 1.15, 1.3], () => 1, () => {}, (i) => 'size.' + i,
		(title) => el('div', 'pop-closer', title), () => {}, () => {}, ['simple', 'max']);
	const pageTitle = d.node('div');
	const groupPage = d.node('section');
	const host = {
		group(title, frag) { log.groups.push(title); groupPage.innerHTML = ''; if (frag) groupPage.appendChild(frag); },
		// The page's stack draws the group its top page names (admin.js followStack): push, then show.
		push(id) { log.pushed++; if (this.show) this.show(id); },
	};
	const title = d.node('div');
	vm.runInNewContext(SG, win);
	win.DaimondAdmin = { homeContent() { draw(); win.DaimondSettingsGroups.apply(d.home, title, phone ? host : null); } };
	win.DaimondAdmin.homeContent();
	return { d, win, log, title, groupPage, pageTitle };
}
const byClass = (d, root, c) => d.walk(root).filter(n => n.className.split(/\s+/).includes(c));
const menus = (d) => d.walk(d.body).concat(d.walk(d.home)).filter(n => n.id === 'settings-menu');

test('on a phone, Settings has an Appearance group holding the menu node itself, one instance', () => {
	const { d, win } = setup();
	const group = byClass(d, d.home, 'sg-appearance')[0];
	assert.ok(group, 'Settings draws an Appearance group');
	assert.equal(group.children[0], d.menu, 'the group holds the moved #settings-menu, not a copy');
	assert.ok(!d.body.children.includes(d.menu), 'the menu left its popover home');
	assert.equal(d.menu.hidden, false, 'it stands open in Settings');
	assert.ok(!byClass(d, d.menu, 'pop-closer').length, 'in Settings it has no closer of its own');
	win.DaimondAdmin.homeContent();	// a redraw moves it again; it never doubles
	assert.equal(new Set(menus(d)).size, 1, 'one #settings-menu after a redraw');
	assert.equal(byClass(d, d.home, 'sg-appearance')[0].children[0], d.menu);
	const head = byClass(d, d.home, 'sg-head')[0];
	assert.equal(head && head.textContent, 'topbar.appearance', 'the group is headed Appearance');
});

test('its controls call the existing setters: tone and swatch set the theme, the view sets the view', () => {
	const { d, log } = setup();
	const rows = byClass(d, d.menu, 'ap-row').map(r => r.children[0].textContent);
	assert.deepEqual(rows.slice(0, 2), ['menu.theme', 'menu.text_size'], 'Theme, then Text size, as the mock');
	const tone = byClass(d, d.menu, 'ap-tone')[0];
	assert.deepEqual(tone.children.map(b => b.textContent), ['menu.tone_light', 'menu.tone_mid', 'menu.tone_dark']);
	tone.children[0].click();
	assert.deepEqual(log.theme, ['porcelain'], 'a tone wears its first palette, through DaimondTheme.set');
	const sw = byClass(d, d.menu, 'ap-swatch');
	assert.deepEqual(sw.map(b => b.attrs['aria-label']), ['menu.theme_porcelain', 'menu.theme_mist'], 'the swatches are the tone\'s palettes');
	sw[1].click();
	assert.deepEqual(log.theme, ['porcelain', 'mist']);
	const view = d.walk(d.menu).find(n => n.textContent === 'menu.view_max' && n.tagName === 'BUTTON');
	view.click();
	assert.deepEqual(log.view, ['max']);
});

test('the member row comes first and opens You; the five other doors follow in order and push their page', () => {
	const { d, log } = setup();
	const ident = byClass(d, d.home, 'sg-ident')[0];
	assert.ok(ident, 'the member row is drawn');
	assert.ok(ident.textContent.includes('Ada'), 'it names the signed-in member from identity state');
	assert.ok(ident.textContent.includes('settings.group_you_what'), 'its line says what is behind it');
	const doors = d.walk(d.home).filter(n => n.dataset.sgroup && n.dataset.sgroup !== 'you');
	assert.deepEqual(doors.map(n => n.dataset.sgroup), DOORS);
	doors[1].click();
	assert.equal(log.pushed, 1, 'a door pushes its group page');
	assert.equal(log.groups.at(-1), 'settings.group_tools', 'the page is named for its group');
	ident.click();
	assert.equal(log.groups.at(-1), 'settings.group_you');
});

test('off a phone nothing changes: no Appearance group, the menu stays a popover', () => {
	const { d } = setup({ phone: false });
	assert.ok(!byClass(d, d.home, 'sg-appearance').length);
	assert.ok(d.body.children.includes(d.menu));
	assert.equal(d.menu.hidden, true);
});
