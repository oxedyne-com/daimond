// langprobe.test.mjs -- the Settings Language select survives the locale probe.
//
//	node --test www/js/langprobe.test.mjs
//
// The probe of the locale files starts on the select's first focus or pointerdown. It used to answer by
// calling renderMenu(), which rebuilds the whole menu and so replaces the select the person is holding:
// on a phone the picker closed under the finger and the first press did nothing (the crawl's INERT
// `menu: settings-menu | select.settings-select[Language]`, 2026-10-05). The probe now updates the options
// of the select in hand. The shipped renderLanguage is cut out of workspace.js and run against stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src  = fs.readFileSync(path.join(HERE, 'workspace.js'), 'utf8');
const cut  = (s, from, to) => {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	assert.ok(a >= 0 && b > a, `cannot cut ${JSON.stringify(from)} .. ${JSON.stringify(to)}: the banners moved`);
	return s.slice(a, b);
};
const body = cut(src, '\tvar localesReady = null;', '\tfunction toggleMenu');
const later = () => new Promise((r) => setImmediate(r));

function node(tag) {
	const n = { tag, children: [], className: '', textContent: '', disabled: false, selected: false, value: '', hidden: false, attrs: new Map(), on: {} };
	n.options = n.children;
	n.setAttribute = (k, v) => { n.attrs.set(k, String(v)); };
	n.addEventListener = (ev, fn) => { (n.on[ev] = n.on[ev] || []).push(fn); };
	n.fire = async (ev) => { for (const fn of n.on[ev] || []) await fn({ type: ev }); };
	n.appendChild = (c) => { n.children.push(c); };
	return n;
}

const LOCALES = [ { code: 'en', name: 'English' }, { code: 'fr', name: 'Français' }, { code: 'de', name: 'Deutsch' } ];

function menu(opts = {}) {
	const box = node('div');
	const log = { renders: 0, probes: 0, set: [] };
	let answer;
	const I18n = {
		locales:    () => LOCALES,
		locale:     () => 'en',
		currencies: () => [ { code: 'USD', name: 'US dollar' } ],
		currency:   () => 'USD',
		ratesAsOf:  () => '2026-10-01',
		available:  () => { log.probes++; return new Promise((r) => { answer = r; }); },
		setLocale:  (c) => { log.set.push(c); return Promise.resolve(opts.setOk !== false); },
		setCurrency: () => {},
	};
	const el = (tag, cls, text) => { const e = node(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
	const t = (k) => '[' + k + ']';
	let m;
	// What the real renderMenu does for this part: clear the menu and draw it again, select and all.
	const renderMenu = () => { log.renders++; box.children.length = 0; m.renderLanguage(box); };
	const make = new Function('window', 'document', 'DaimondI18n', 'menuEl', 'el', 't', 'renderMenu',
		body + '; return { renderLanguage: renderLanguage, probeLocales: probeLocales };');
	const win = { DaimondI18n: I18n };
	m = make(win, { createElement: node }, I18n, box, el, t, renderMenu);
	m.renderLanguage(box);
	const lang = () => box.children.find((c) => c.className === 'set-pick').children[0];
	return { box, log, m, lang, answer: (codes) => answer(codes) };
}

const label = (o) => o.textContent;

test('before the probe every language is offered, and nothing is fetched', () => {
	const h = menu();
	assert.equal(h.log.probes, 0);
	assert.deepEqual(h.lang().options.map((o) => o.disabled), [ false, false, false ]);
});

test('the probe answers into the select the person is holding: same node, options updated, no redraw', async () => {
	const h = menu();
	const before = h.lang();
	await before.fire('focus');
	assert.equal(h.log.probes, 1);
	h.answer([ 'en', 'fr' ]);
	await later();
	const after = h.lang();
	assert.equal(after, before, 'the select is the same node after the probe answers');
	assert.equal(h.box.children.some((r) => r.children.includes(before)), true, 'and it is still in the menu');
	assert.equal(h.log.renders, 0, 'the menu was not rebuilt');
	assert.deepEqual(after.options.map((o) => o.disabled), [ false, false, true ]);
	assert.equal(label(after.options[2]), 'Deutsch — [menu.language_pending]');
	assert.equal(label(after.options[1]), 'Français');
	assert.equal(after.options[0].selected, true, 'the current language stays selected');
});

test('pointerdown starts the probe too, and a second reach for the picker does not repeat it', async () => {
	const h = menu();
	const s = h.lang();
	await s.fire('pointerdown');
	await s.fire('focus');
	await s.fire('pointerdown');
	assert.equal(h.log.probes, 1);
});

test('an answer that lands after the menu was redrawn marks the select now drawn', async () => {
	const h = menu();
	const old = h.lang();
	await old.fire('focus');
	// Something else redraws the menu while the probe is in flight (a theme press, say).
	h.box.children.length = 0;
	h.m.renderLanguage(h.box);
	const now = h.lang();
	assert.notEqual(now, old);
	h.answer([ 'en' ]);
	await later();
	assert.equal(h.lang(), now);
	assert.deepEqual(now.options.map((o) => o.disabled), [ false, true, true ]);
});

test('an answer that lands with the menu closed is kept for the next time it opens', async () => {
	const h = menu();
	const s = h.lang();
	await s.fire('focus');
	h.box.hidden = true;
	h.answer([ 'en', 'fr', 'de' ]);
	await later();
	assert.equal(h.log.renders, 0);
	assert.deepEqual(s.options.map((o) => o.disabled), [ false, false, false ]);
	h.box.hidden = false;
	h.box.children.length = 0;
	h.m.renderLanguage(h.box);
	assert.deepEqual(h.lang().options.map((o) => o.disabled), [ false, false, false ]);
});

test('choosing a language still redraws the menu in it', async () => {
	const h = menu();
	const s = h.lang();
	s.value = 'fr';
	await s.fire('change');
	await later();
	assert.deepEqual(h.log.set, [ 'fr' ]);
	assert.equal(h.log.renders, 1);
	assert.notEqual(h.lang(), s, 'a chosen language is a deliberate redraw, so the select is new');
});
