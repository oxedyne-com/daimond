// settingsgroups.test.mjs -- Settings opens on the weekly stop and six doors (D-20261024-16).
//
//	node --test www/js/settingsgroups.test.mjs
//
// The drawer was a wall of about forty rows under twelve headings that followed history, not
// intent. It now opens on Models and Credits, six doors (one per intent), then Lock, Log out and
// Forget. Every row the drawer drew is still there, behind the door of its group. This drives
// the real settingsgroups.js over a drawer drawn as renderHomeBody draws it, in a small DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, process.env.SG_FILE || 'settingsgroups.js'), 'utf8');

// A DOM just big enough: nodes move when appended, `innerHTML = ''` empties, ids are found.
function dom() {
	const all = new Set();
	function node(tag) {
		const n = {
			tagName: tag.toUpperCase(), children: [], parentNode: null, id: '', hidden: false,
			className: '', dataset: {}, _text: '', listeners: {},
			get classList() {
				const self = this;
				return {
					add(...c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); self.className = [...s].join(' '); },
					contains(c) { return self.className.split(/\s+/).includes(c); },
				};
			},
			get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
			set textContent(v) { this._text = v; this.children.forEach(c => { c.parentNode = null; }); this.children = []; },
			set innerHTML(v) { this.textContent = ''; },
			appendChild(c) {
				if (c.isFrag) { c.children.slice().forEach(x => this.appendChild(x)); return c; }
				if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
				c.parentNode = this; this.children.push(c); return c;
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
	const document = {
		createElement: node,
		createDocumentFragment() { const f = node('#frag'); f.isFrag = true; return f; },
		createTextNode(s) { const n = node('#text'); n._text = s; return n; },
		getElementById(id) {
			if (id === 'admin') return { classList: { contains: c => c === 'admin-open' } };
			for (const n of all) if (n.id === id && (n.parentNode || n === detail || n === home)) return n;
			return null;
		},
	};
	const home = node('div'); home.id = 'admin-home';
	const detail = node('div'); detail.id = 'astat-detail';
	return { document, node, home, detail, walk };
}

// The drawer as renderHomeBodyInner + mountStatusDetail draw it; `t` is absent, so text is the key.
const DRAWN = [
	['sec', 'home.sec_account'], ['row', 'Fingerprint'], ['row', 'Change name…'], ['row', 'Change passphrase…'],
	['row', 'home.export_backup'], ['row', 'home.import_backup'],
	['sec', 'home.sec_devices'], ['row', 'This device'], ['row', 'devices.runner_mint'], ['row', 'Operator console'],
	['sec', 'home.sec_prompts'], ['row', 'Edit the Chat prompt…'], ['row', 'Edit the Helper prompt…'],
	['sec', 'home.sec_running'], ['row', 'home.limits'], ['row', 'Search…'], ['row', 'Folders…'],
	['sec', 'home.sec_push'], ['row', 'Set up git push…'], ['row', 'Social settings…', 'admin-social-settings'],
	['sec', 'home.sec_sync'], ['row', 'Send a report'], ['row', 'safe.turn_off'], ['row', 'Copy the trail'], ['note', 'A safe-to-share log'],
	['sec', 'home.sec_diag'], ['row', 'Turn diagnostics on'], ['row', 'Open debug panel'],
	['sec', 'home.sec_debugshare'], ['row', 'Share all data'],
	['sec', 'home.sec_lens'], ['row', 'Allow Lens screenshots'],
	['sec', 'home.sec_accounts'], ['row', 'Switch to Other'], ['row', '+ Add another account'],
	['row', 'home.lock'], ['row', 'home.log_out'], ['row', 'identity.forget'],
	['sec', 'home.sec_status'],
];
const STATUS = ['astat-model', 'astat-account', 'astat-byok', 'astat-pro', 'astat-tools', 'astat-hand', 'astat-release', 'astat-store', 'astat-sync'];

// Where each row must be found: the inventory's six groups (dev/settings_ia/inventory.md).
const WANT = {
	models:  ['astat-byok', 'astat-pro', 'home.limits'],
	tools:   ['astat-tools', 'astat-hand', 'devices.runner_mint', 'Search…', 'Folders…', 'Set up git push…'],
	you:     ['Fingerprint', 'Change name…', 'Change passphrase…', 'This device', 'Operator console', 'Social settings…', 'Allow Lens screenshots', 'Switch to Other', '+ Add another account'],
	prompts: ['Edit the Chat prompt…', 'Edit the Helper prompt…'],
	data:    ['home.export_backup', 'home.import_backup', 'safe.turn_off', 'astat-store', 'astat-sync'],
	help:    ['astat-release', 'Send a report', 'Copy the trail', 'Turn diagnostics on', 'Open debug panel', 'Share all data'],
};
const ID = { 'Social settings…': 'admin-social-settings' };
const DOORS = ['models', 'tools', 'you', 'prompts', 'data', 'help'];
const FOOT  = ['home.lock', 'home.log_out', 'identity.forget'];

function setup() {
	const d = dom();
	STATUS.forEach(id => { const r = d.node('button'); r.id = id; r.className = 'astat-row'; d.detail.appendChild(r); });
	const draw = () => {
		d.home.innerHTML = '';
		DRAWN.forEach(([kind, text, id]) => {
			const n = d.node(kind === 'row' ? 'button' : 'div');
			n.className = kind === 'sec' ? 'admin-sec' : kind === 'note' ? 'admin-note' : 'admin-item';
			n.textContent = text;
			if (id) n.id = id;
			d.home.appendChild(n);
		});
		d.home.appendChild(d.detail);
	};
	const win = { document: d.document, location: { search: '' }, URLSearchParams };
	win.window = win;
	win.DaimondAdmin = { homeContent() { draw(); win.DaimondSettingsGroups.apply(d.home, title); } };
	const title = d.node('div');
	vm.runInNewContext(SRC, win);
	assert.ok(win.DaimondSettingsGroups, 'settingsgroups.js exposes DaimondSettingsGroups');
	win.DaimondAdmin.homeContent();
	return { d, win, title };
}
// What a person sees: visible nodes, by id or by text.
function seen(d, root) {
	const out = [];
	(function go(n) { if (n.hidden) return; if (n.id) out.push(n.id); else if (n.tagName === 'BUTTON' && n._text) out.push(n._text); n.children.forEach(go); })(root);
	return out;
}

test('the top level is Models, Credits, six doors, then Lock, Log out and Forget', () => {
	const { d } = setup();
	const doors = d.walk(d.home).filter(n => n.dataset.sgroup && !n.hidden);
	assert.deepEqual(doors.map(n => n.dataset.sgroup), DOORS);
	const ids = seen(d, d.home).filter(x => !String(x).startsWith('admin-home'));
	const quick = ids.slice(0, 2);
	assert.deepEqual(quick, ['astat-model', 'astat-account']);
	assert.deepEqual(ids.slice(-3), FOOT);
	// Nothing else stands at the top level: the other rows wait behind their doors.
	assert.equal(ids.length, 2 + 3, `top level shows only the stop, the doors and the foot: ${ids}`);
});

test('every drawn row is reachable, in one door, behind its own group', () => {
	const { d, title } = setup();
	for (const g of DOORS) {
		const door = d.walk(d.home).find(n => n.dataset.sgroup === g);
		door.click();
		const page = seen(d, d.home);
		for (const r of WANT[g]) assert.ok(page.includes(r) || page.includes(ID[r]), `${r} is in ${g}: ${page}`);
		for (const other of DOORS.filter(x => x !== g)) for (const r of WANT[other]) assert.ok(!page.includes(r) && !page.includes(ID[r]), `${r} is not also in ${g}`);
		assert.notEqual(title.textContent, '', 'the page names its group');
		const back = d.walk(d.home).find(n => n.className.includes('back'));
		assert.ok(back, `${g} has a way back`);
		back.click();
	}
	assert.deepEqual(d.walk(d.home).filter(n => n.dataset.sgroup).map(n => n.dataset.sgroup), DOORS, 'back returns to the doors');
});

test('no dev switch: the layout is not behind ?settings=', () => {
	assert.ok(!/settings=|URLSearchParams|MODE/.test(SRC), 'settingsgroups.js reads no query switch');
	assert.ok(!/drawB|sia-b/.test(SRC), 'variant b is gone');
});
