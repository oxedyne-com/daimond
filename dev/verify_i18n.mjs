// verify_i18n.mjs — every locale is whole, and the engine can serve it.
//
// Two halves. The MECHANICAL half loads each www/i18n/<code>.js in a stub
// window and diffs it against en.js: same key set, same {placeholder}
// multiset per key, same HTML-tag multiset per key. This is what stops a
// translation drifting as en.js grows -- a missing key falls back to English
// silently in the app, so only a census can see it.
//
// The BROWSER half drives the real page: setLocale for every registered
// locale, open the Admin drawer (the largest translated surface), and prove
// the engine resolved every key it was asked for -- the engine warns once per
// missing key, so the console is the census; a literal {placeholder} or a
// key-shaped token in the drawer text is caught as well.
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
	? '\ni18n: every locale is whole, and the engine serves each without a gap.'
	: `\ni18n: ${failures} check(s) failed.`);
process.exit(failures ? 1 : 0);
