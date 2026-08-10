// verify_i18n.mjs — every locale is whole, and every surface follows a switch.
//
// Three halves, and the third exists because the first two were blind in the
// same place.
//
// The MECHANICAL half loads each www/i18n/<code>.js in a stub window and diffs
// it against en.js: same key set, same {placeholder} multiset per key, same
// HTML-tag multiset per key. This is what stops a translation drifting as en.js
// grows -- a missing key falls back to English silently in the app, so only a
// census can see it.
//
// The OPEN-AFTER half drives the real page: setLocale for every registered
// locale, THEN open the Admin drawer, and prove the engine resolved every key
// it was asked for. A literal {placeholder} or a key-shaped token is caught too.
//
// The SWITCH-WHILE-OPEN half is the one that was missing, and its absence is a
// bug in its own right. Every check above opens a surface AFTER the switch, so
// every surface it looks at is built fresh in the new language and a surface
// that was ALREADY ON SCREEN when the language changed is untested by
// construction. On 2026-08-10 the Admin drawer, left open, stayed in Spanish
// through a switch to Japanese and to Chinese; nothing here could see it, and
// the same shape had already shipped once before. So: open the surface, switch,
// and read it back WITHOUT closing it.
//
// The reading is done by comparing what is on screen against the outgoing
// table, so it names no surface: anything showing a string that only the
// language we just left produces has not repainted, whether it is a panel that
// existed when this was written or one added tomorrow.
//
//   node dev/verify_i18n.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway and no model.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const I18NDIR = path.join(HERE, '..', 'www', 'i18n');
const OUT     = path.join(os.homedir(), '.cache/daimond/i18n-shots');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

// ── Mechanical: every locale file against en.js ─────────────────────
const loadTable = (file) => {
	let table = null;
	const sandbox = { window: { DaimondI18n: { register: (c, t2) => { table = t2; } } } };
	const src = fs.readFileSync(path.join(I18NDIR, file), 'utf8');
	new Function('window', src)(sandbox.window);
	return table;
};
const multiset = (s, re) => (String(s).match(re) || []).sort().join(',');

const en = loadTable('en.js');
const codes = fs.readdirSync(I18NDIR)
	.filter(f => f.endsWith('.js') && f !== 'en.js')
	.map(f => f.slice(0, -3));
check(en && Object.keys(en).length > 0, 'en.js loads', Object.keys(en || {}).length + ' keys');
check(codes.length >= 7, 'all locale files present', codes.join(' '));

for (const code of codes) {
	const t2 = loadTable(code + '.js');
	const ek = Object.keys(en), tk2 = Object.keys(t2 || {});
	const missing  = ek.filter(k => !(k in t2));
	const invented = tk2.filter(k => !(k in en));
	const ph  = ek.filter(k => k in t2 && multiset(en[k], /\{\w+\}/g)   !== multiset(t2[k], /\{\w+\}/g));
	const tag = ek.filter(k => k in t2 && multiset(en[k], /<\/?\w+/g)   !== multiset(t2[k], /<\/?\w+/g));
	check(missing.length === 0,  code + ': no missing keys',  missing.length ? missing.slice(0, 4).join(' ') : ek.length + '/' + ek.length);
	check(invented.length === 0, code + ': no invented keys', invented.slice(0, 4).join(' ') || undefined);
	check(ph.length === 0,       code + ': placeholders match',  ph.slice(0, 4).join(' ') || undefined);
	check(tag.length === 0,      code + ': HTML tags match',     tag.slice(0, 4).join(' ') || undefined);
}

// ── Browser: the engine serves each locale without a gap ────────────
// Opening AFTER the switch. Everything below this that opens after a switch is
// blind to the class of bug the switch-while-open half exists for.
const s = await open({ name: 'i18n' + Date.now() });
const p = s.page;
const missingSince = (mark) => [...new Set(s.logs.slice(mark)
	.filter(l => /i18n: no string for/.test(l))
	.map(l => (l.match(/"([^"]+)"/) || [])[1]))].sort();

for (const code of ['en'].concat(codes)) {
	const mark = s.logs.length;
	const loaded = await p.evaluate(c => window.DaimondI18n.setLocale(c), code);
	await p.waitForTimeout(300);
	await p.evaluate(() => { try { document.getElementById('settings-btn').click(); } catch (e) {} });
	await p.waitForTimeout(700);
	const txt = await p.evaluate(() => {
		const el = document.getElementById('admin-body');
		return el ? el.innerText : '(no admin-body)';
	});
	const braces = (txt.match(/\{[a-z_]+\}/gi) || []);
	const gone = missingSince(mark);
	check(loaded === true, code + ': setLocale loads');
	check(gone.length === 0, code + ': no missing-key warnings', gone.slice(0, 4).join(' ') || undefined);
	check(braces.length === 0, code + ': no literal placeholders on screen', braces.join(',') || undefined);
	await p.screenshot({ path: path.join(OUT, `verify-${code}-admin.png`) });
	await p.evaluate(() => { try { document.getElementById('admin-close').click(); } catch (e) {} });
	await p.waitForTimeout(200);
}
// ── Switch while open: a surface on screen shows the new language ───
//
// The rule: open the surface, switch, read it back WITHOUT closing it.
//
// What counts as "still in the old language" is decided from the locale FILES,
// not from anything the app says about itself — a string the outgoing table
// produces for some key, which the incoming table renders differently, and
// which the incoming table does not produce for ANY key. That last clause is
// what keeps a word two languages happen to share out of the result.
//
// Nothing here names a surface in its assertion, which is the point: the check
// sweeps whatever is on screen, so a panel added after this was written is
// covered by it as it stands.

/// Strings only `from` produces. Text on screen that is one of these, after a
/// switch to `to`, is a surface that did not repaint.
const outgoingOf = (from, to) => {
	const out = {};
	const held = new Set(Object.values(to));
	for (const k of Object.keys(from)) {
		const v = from[k];
		if (typeof v !== 'string' || v.trim().length < 2) continue;
		if (v === to[k] || held.has(v)) continue;
		if (!(v in out)) out[v] = k;
	}
	return out;
};

/// What is showing, and should not be: the outgoing table's strings, and any
/// key rendered raw because the table had no entry for it (`t` returns the key,
/// so a repaint that reaches for a missing key prints `search.head` on screen
/// where a fresh mount printed nothing).
const SWEEP = ([sel, outgoing, keys]) => {
	const roots = sel ? [...document.querySelectorAll(sel)] : [document.body];
	const keySet = new Set(keys);
	const stale = [], raw = [];
	const where = (n) => {
		let e = n.nodeType === 1 ? n : n.parentElement;
		const parts = [];
		while (e && e !== document.body) {
			if (e.id) { parts.unshift('#' + e.id); break; }
			if (typeof e.className === 'string' && e.className.trim()) parts.unshift('.' + e.className.trim().split(/\s+/)[0]);
			e = e.parentElement;
		}
		return parts.join(' ') || '(body)';
	};
	let shown = 0;
	for (const root of roots) {
		if (!root.getClientRects || !root.getClientRects().length) continue;
		shown++;
		const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let n;
		while ((n = walk.nextNode())) {
			const v = (n.nodeValue || '').trim();
			if (!v) continue;
			const e = n.parentElement;
			if (!e || !e.getClientRects().length) continue;
			if (outgoing[v]) stale.push(outgoing[v] + ' @' + where(n));
			else if (keySet.has(v)) raw.push(v + ' @' + where(n));
		}
		// A control's spoken name is as much a string as its label, and one fixed
		// at mount in the language of the day is the same defect unheard.
		for (const a of ['title', 'aria-label', 'placeholder', 'alt', 'data-label']) {
			const list = [...root.querySelectorAll('[' + a + ']')];
			if (root.hasAttribute(a)) list.push(root);
			for (const e of list) {
				if (!e.getClientRects().length) continue;
				const v = (e.getAttribute(a) || '').trim();
				if (!v) continue;
				if (outgoing[v]) stale.push(a + ' ' + outgoing[v] + ' @' + where(e));
				else if (keySet.has(v)) raw.push(a + ' ' + v + ' @' + where(e));
			}
		}
	}
	return { shown, stale: [...new Set(stale)], raw: [...new Set(raw)] };
};

{
	const tables = Object.fromEntries(['en'].concat(codes).map(c => [c, loadTable(c + '.js')]));
	const ring   = ['en'].concat(codes);          // the locales, in a cycle
	const enKeys = Object.keys(en);

	/// Open `surface`, switch from `from` to `to`, and read it back where it
	/// stands. Returns whether it was on screen at all, so a surface the layout
	/// declined to seat is reported rather than counted as a pass.
	const switchWhileOpen = async ({ name, sel, show }, from, to) => {
		await p.evaluate(c => window.DaimondI18n.setLocale(c), from);
		await p.waitForTimeout(250);
		try { await show(); } catch (e) { /* a surface this build has no room for */ }
		await p.waitForTimeout(700);
		const out    = outgoingOf(tables[from], tables[to]);
		const before = await p.evaluate(SWEEP, [sel, out, enKeys]);
		if (!before.shown) { console.log('  --   ' + name + ' — not on screen, nothing switched under it'); return false; }
		// Whether the surface was showing anything that TELLS the two languages
		// apart. If it was not, the switch below proves nothing about it, and
		// saying "ok" would be the same kind of lie this half exists to stop. The
		// whole-document ring after this catches such a surface anyway: it is
		// stale in exactly one language, and every language takes a turn as the
		// one being left.
		if (!before.stale.length) {
			console.log('  --   ' + name + ` — nothing on it distinguishes ${from} from ${to}; the ring below covers it`);
			return false;
		}
		const mark = s.logs.length;
		await p.evaluate(c => window.DaimondI18n.setLocale(c), to);
		await p.waitForTimeout(700);
		const after = await p.evaluate(SWEEP, [sel, out, enKeys]);
		const gone  = missingSince(mark);
		check(after.stale.length === 0,
			`${name}: open in ${from}, switched to ${to} — shows ${to}`,
			after.stale.slice(0, 6).join('  ') || undefined);
		check(after.raw.length === 0,
			`${name}: the repaint asked for no key the table lacks`,
			after.raw.slice(0, 6).join('  ') || undefined);
		check(gone.length === 0,
			`${name}: no missing-key warnings during the repaint`,
			gone.slice(0, 4).join(' ') || undefined);
		return true;
	};

	// The panels come from the layout engine, which reads them off the DOM — so
	// this list is the app's, not a copy of it kept here to go stale.
	const panels = await p.evaluate(() => window.DaimondPanels.panels().map(x => x.id));
	const surfaces = panels.map(id => ({
		name: 'panel ' + id,
		sel:  '#panel-' + id,
		show: () => p.evaluate(i => window.DaimondPanels.show(i), id),
	})).concat([
		{ name: 'drawer home',    sel: '#admin', show: () => p.evaluate(() => window.DaimondAdmin.home()) },
		{ name: 'drawer models',  sel: '#admin', show: () => p.evaluate(() => window.DaimondAdmin.settings('')) },
		{ name: 'drawer credits', sel: '#admin', show: () => p.evaluate(() => window.DaimondAdmin.credits('')) },
		{ name: 'drawer version', sel: '#admin', show: () => p.evaluate(() => window.DaimondAdmin.release()) },
		{ name: 'drawer push',    sel: '#admin', show: () => p.evaluate(() => window.DaimondAdmin.push()) },
		{
			// A form is a question a caller is waiting on, so it is opened and
			// answered rather than left standing.
			name: 'drawer form', sel: '#admin',
			show: () => p.evaluate(() => {
				window.DaimondAdmin.form({
					title: window.DaimondI18n.t('drawer.admin'),
					message: window.DaimondI18n.t('home.change_name'),
					fields: [{ name: 'n', label: window.DaimondI18n.t('common.save'), value: '' }],
				});
			}),
		},
	]);

	// Each surface takes a different pair off the ring, so the sweep covers every
	// language it ships without running every surface against every one of them.
	let swept = 0;
	for (let i = 0; i < surfaces.length; i++) {
		const from = ring[i % ring.length];
		const to   = ring[(i + 1) % ring.length];
		if (await switchWhileOpen(surfaces[i], from, to)) swept++;
	}
	await p.evaluate(() => { try { window.DaimondAdmin.close(); } catch (e) {} });
	check(swept > 0, 'switch-while-open: surfaces were actually on screen for a switch', swept + ' swept');

	// And the whole document, through every language in turn, with the drawer
	// standing open the entire time — the exact shape of the report: a drawer
	// opened once and a language changed under it, again and again.
	await p.evaluate(() => window.DaimondAdmin.home());
	await p.waitForTimeout(500);
	for (let i = 0; i < ring.length; i++) {
		const from = ring[i], to = ring[(i + 1) % ring.length];
		await p.evaluate(c => window.DaimondI18n.setLocale(c), from);
		await p.waitForTimeout(450);
		await p.evaluate(c => window.DaimondI18n.setLocale(c), to);
		await p.waitForTimeout(750);
		const after = await p.evaluate(SWEEP, [null, outgoingOf(tables[from], tables[to]), enKeys]);
		check(after.stale.length === 0,
			`drawer left open, ${from} → ${to}: nothing on the page is still ${from}`,
			after.stale.slice(0, 6).join('  ') || undefined);
	}
	await p.screenshot({ path: path.join(OUT, 'verify-switch-while-open.png') });
	await p.evaluate(() => { try { window.DaimondAdmin.close(); } catch (e) {} });
}

// ── Reload: a remembered language survives without the picker ───────
// Every other check goes through setLocale, which loads the table itself.
// A RELOADED page only has the stored code -- the engine must fetch the
// table unprompted, and surfaces drawn before it arrives must repaint.
// This gap shipped once: every reload came back English until the picker
// was touched again, and no setLocale-based check could see it.
{
	const frTable = loadTable('fr.js');
	const s2 = await open({ name: 'i18nreload' + Date.now() });
	const p2 = s2.page;
	await p2.evaluate(() => window.DaimondI18n.setLocale('fr'));
	await p2.waitForTimeout(400);
	await p2.reload({ waitUntil: 'domcontentloaded' });
	await p2.waitForTimeout(2000);
	await p2.evaluate(() => {
		const pass = document.getElementById('id-pass');
		if (pass && pass.getClientRects().length) {
			pass.value = 'testpass1234';
			pass.dispatchEvent(new Event('input', { bubbles: true }));
			document.getElementById('id-primary').click();
		}
	});
	await p2.waitForTimeout(2600);
	const state = await p2.evaluate(() => ({
		tChatNew: window.DaimondI18n.t('chat.new'),
		btn: (document.querySelector('.empty-new-session') || {}).textContent || '(absent)',
	}));
	check(state.tChatNew === frTable['chat.new'],
		'reload: the remembered locale table loads unprompted', state.tChatNew);
	check(state.btn === frTable['chat.new'],
		'reload: surfaces drawn before the table arrived repaint', state.btn);
	await s2.close();
}
await s.close();

console.log(failures === 0
	? '\ni18n: every locale is whole, and a surface open when the language changes shows the new one.'
	: `\ni18n: ${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
