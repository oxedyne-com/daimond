// eyetoggle.test.mjs -- every secret he types wears the one eye (EYE-TOGGLE, D-20261025-10).
//
//	node --test www/js/eyetoggle.test.mjs
//
// "the user should be able to toggle an eye icon to show/hide the password." The app had one
// eye, on the identity screen's two passphrase fields; the mailbox password, the provider keys,
// the push token, the search key, the passphrase prompts, the change-passphrase pair, the settle
// voice, the posting name and the console's keys had none. www/js/secret.js is the one control.
//
// Two halves. COVERAGE reads every script and page under www and refuses a secret field that is
// made without the eye: a `type="password"` input, or a text field masked by `installSecretMask`.
// BEHAVIOUR runs secret.js against a small stand-in DOM: the eye flips the field and says so in
// `aria-pressed` and its label, it is a real button (so the keyboard works it), and the field
// goes back to hidden when it is emptied or submitted, without its autocomplete being touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW  = join(HERE, '..');

function walk(dir, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { if (!/^(vendor|assets|i18n)$/.test(e.name)) walk(p, out); }
		else if (/\.(js|html)$/.test(e.name) && !/\.test\.|\.min\./.test(e.name)) out.push(p);
	}
	return out;
}
const FILES = walk(WWW).map((p) => ({ p: relative(WWW, p), s: readFileSync(p, 'utf8') }));
const lineOf = (s, i) => s.slice(0, i).split('\n').length;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const eyed = (s, v) => new RegExp('(?:secretEye|DaimondSecret\\.eye)\\(\\s*' + esc(v) + '\\s*\\)').test(s);

// The ids the served pages' secret fields carry, given their eye at boot in daimond.js.
const DJS = FILES.find((f) => f.p === 'js/daimond.js').s;
const BOOT = (() => {
	const m = DJS.match(/\[([^\]]*)\]\.forEach\(function \(fid\) \{\s*secretEye\(document\.getElementById\(fid\)\);/);
	return m ? m[1].match(/'[^']+'/g).map((x) => x.slice(1, -1)) : [];
})();

test('every type="password" input in a page is given the eye', () => {
	const bad = [];
	for (const f of FILES.filter((f) => f.p.endsWith('.html'))) {
		for (const m of f.s.matchAll(/<input\b[^>]*\btype="password"[^>]*>/g)) {
			const id = (m[0].match(/\bid="([^"]+)"/) || [])[1];
			if (!id || !BOOT.includes(id)) bad.push(`${f.p}:${lineOf(f.s, m.index)} #${id || '(no id)'}`);
		}
	}
	assert.deepEqual(bad, [], 'password inputs with no eye: ' + bad.join(', '));
});

test('every password input a script builds is given the eye', () => {
	const bad = [];
	for (const f of FILES.filter((f) => f.p.endsWith('.js') && f.p !== 'js/secret.js')) {
		for (const m of f.s.matchAll(/([\w$.]+)\.type\s*=\s*'password'/g)) {
			if (!eyed(f.s, m[1])) bad.push(`${f.p}:${lineOf(f.s, m.index)} ${m[1]}`);
		}
	}
	assert.deepEqual(bad, [], 'built password inputs with no eye: ' + bad.join(', '));
});

test('every field masked as a secret is given the eye', () => {
	const bad = [];
	let n = 0;
	for (const f of FILES.filter((f) => f.p.endsWith('.js') && f.p !== 'js/secret.js')) {
		for (const m of f.s.matchAll(/installSecretMask\(\s*(document\.getElementById\('([^']+)'\)|[\w$]+)\s*,/g)) {
			n++;
			const ok = m[2] ? BOOT.includes(m[2]) : eyed(f.s, m[1]);
			if (!ok) bad.push(`${f.p}:${lineOf(f.s, m.index)} ${m[2] || m[1]}`);
		}
	}
	assert.ok(n >= 5, `expected the five masked fields, found ${n}`);
	assert.deepEqual(bad, [], 'masked fields with no eye: ' + bad.join(', '));
});

test('the eye is one component: no page draws its own', () => {
	const bad = [];
	for (const f of FILES) {
		for (const m of f.s.matchAll(/class="[^"]*\bpass-eye\b|className\s*=\s*'[^']*\bpass-eye\b/g)) {
			if (f.p !== 'js/secret.js') bad.push(`${f.p}:${lineOf(f.s, m.index)}`);
		}
	}
	assert.deepEqual(bad, [], 'an eye drawn outside secret.js: ' + bad.join(', '));
});

// ── A stand-in DOM, as much of one as secret.js touches ────────────────
function dom() {
	const listeners = {};
	class El {
		constructor(tag) {
			this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
			this.style = {}; this.on = {}; this.value = ''; this.type = ''; this.id = ''; this.title = ''; this.innerHTML = '';
			const self = this;
			this.classList = { contains: (c) => (self.className || '').split(/\s+/).includes(c) };
		}
		setAttribute(k, v) { this.attrs[k] = String(v); }
		getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
		appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
		removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; }
		insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c; }
		addEventListener(k, fn) { (this.on[k] = this.on[k] || []).push(fn); }
		fire(k, ev = {}) { ev.preventDefault = () => {}; ev.target = this; (this.on[k] || []).forEach((fn) => fn(ev)); }
		focus() {}
		setSelectionRange() {}
		querySelectorAll(sel) { const out = []; const go = (e) => e.children.forEach((c) => { if (sel === 'input' && c.tagName === 'INPUT') out.push(c); go(c); }); go(this); return out; }
	}
	const document = {
		createElement: (t) => new El(t),
		addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); },
		submit: (form) => (listeners.submit || []).forEach((fn) => fn({ target: form })),
	};
	const window = { DaimondI18n: { t: (k) => ({ 'common.show_secret': 'Show', 'common.hide_secret': 'Hide' })[k] || k } };
	window.window = window; window.document = document;
	vm.runInNewContext(readFileSync(join(HERE, 'secret.js'), 'utf8'), window);
	return { S: window.DaimondSecret, document, El };
}

test('the eye shows and hides a password field, and says which it will do', () => {
	const { S, document } = dom();
	const row = document.createElement('div');
	const inp = document.createElement('input');
	inp.type = 'password'; inp.id = 'k'; inp.autocomplete = 'current-password'; inp.value = 'hunter2';
	row.appendChild(inp);
	const box = S.eye(inp);
	assert.equal(box.className, 'pass-wrap');
	assert.equal(inp.parentNode, box, 'the field is wrapped where it stood');
	assert.equal(box.parentNode, row);
	const b = box.children[1];
	assert.equal(b.tagName, 'BUTTON');
	assert.equal(b.type, 'button', 'a real button: Enter and Space work it, and it never submits');
	assert.equal(b.id, 'k-eye');
	assert.equal(b.getAttribute('aria-controls'), 'k');
	assert.equal(b.getAttribute('aria-pressed'), 'false');
	assert.equal(b.getAttribute('aria-label'), 'Show');
	assert.equal(b.getAttribute('data-i18n-aria-label'), 'common.show_secret');
	b.fire('click');
	assert.equal(inp.type, 'text');
	assert.equal(b.getAttribute('aria-pressed'), 'true');
	assert.equal(b.getAttribute('aria-label'), 'Hide');
	assert.equal(b.title, 'Hide');
	assert.equal(inp.autocomplete, 'current-password', 'revealing never touches autocomplete');
	b.fire('click');
	assert.equal(inp.type, 'password');
	assert.equal(b.getAttribute('aria-label'), 'Show');
	assert.equal(S.eye(inp), box, 'a second call adds no second eye');
	assert.equal(box.children.length, 2);
});

test('a masked field reveals the value it holds, and keeps its manager attributes', () => {
	const { S, document } = dom();
	const inp = document.createElement('input');
	inp.type = 'text';
	S.mask(inp, 'sk-abc');
	const box = S.eye(inp);
	assert.equal(inp.value, '••••••');
	const before = JSON.stringify(inp.attrs);
	box.children[1].fire('click');
	assert.equal(inp.value, 'sk-abc');
	assert.equal(inp.type, 'text');
	assert.equal(JSON.stringify(inp.attrs), before);
	box.children[1].fire('click');
	assert.equal(inp.value, '••••••');
	assert.equal(S.get(inp), 'sk-abc');
});

test('it goes back to hidden when the field is emptied or submitted', () => {
	const { S, document } = dom();
	const form = document.createElement('form');
	const mk = () => { const i = document.createElement('input'); i.type = 'password'; i.value = 'x'; form.appendChild(i); S.eye(i); return i; };
	const show = (i) => { S.reveal(i, true); assert.equal(i.type, 'text'); };

	const a = mk(); show(a); a.value = ''; a.fire('input');
	assert.equal(a.type, 'password', 'typed away to nothing');
	const b = mk(); show(b); S.set(b, '');
	assert.equal(b.type, 'password', 'cleared by the caller');
	const c = mk(); show(c); c.fire('keydown', { key: 'Enter' });
	assert.equal(c.type, 'password', 'submitted with Enter');
	const d = mk(); show(d); document.submit(form);
	assert.equal(d.type, 'password', 'the form submitted');
	const e = mk(); show(e); S.hide(e);
	assert.equal(e.type, 'password', 'the caller\'s Save');
	assert.equal(e._eye.getAttribute('aria-pressed'), 'false', 'and the eye says so');
	const m = document.createElement('input'); m.type = 'text'; S.mask(m, 'k'); S.eye(m); show(m); S.set(m, '');
	assert.equal(m._revealed, false, 'a masked field too');
});

test('a field not yet in the page comes back in its box, its margins with it', () => {
	const { S, document } = dom();
	const inp = document.createElement('input');
	inp.type = 'password'; inp.style.marginTop = '8px';
	const box = S.eye(inp);
	assert.equal(box.parentNode, null);
	assert.equal(box.children[0], inp);
	assert.equal(box.style.marginTop, '8px');
	assert.equal(inp.style.marginTop, '');
});

test('Show and Hide are in all eight locales', () => {
	const dir = join(WWW, 'i18n');
	const locs = readdirSync(dir).filter((f) => f.endsWith('.js'));
	assert.equal(locs.length, 8);
	for (const f of locs) {
		const s = readFileSync(join(dir, f), 'utf8');
		for (const k of ['common.show_secret', 'common.hide_secret']) {
			assert.match(s, new RegExp(`'${esc(k)}':\\s*'[^']+'`), `${f} lacks ${k}`);
		}
	}
});
