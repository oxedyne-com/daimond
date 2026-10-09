// gateway: none
// verify_crystalupdate.mjs — a forked capp page is offered its template's fix as a
// three-way merge (#12, D-20261006-22/-23).
//
// `verify_cappdelivery.mjs` proves a page the person has changed is KEPT. This proves
// what comes after: the kept page is not frozen. The record's hash names the page it
// came from, the bundle serves that page at `base/<sha256>.html`, and the template's
// change is brought in around the person's own. What is asserted:
//
//   * a clean fix is OFFERED, not written: the stored page is the fork until Update;
//   * the kept note no longer names the page, because the offer says it instead;
//   * "Not now" removes the offer and is remembered at that version;
//   * where both changed the same lines the offer shows BOTH, and Update keeps the
//     person's lines and brings in everything else;
//   * after Update the record's base is the new template, so a LATER fix merges
//     against it and does not bring back the line the person kept over it.
//
// Every marker is a `//` line inserted after a unique statement line of the page's
// one classic script, so each version is still a page that runs.
//
//   node dev/verify_crystalupdate.mjs --base   # RED: r544's daimond.js and versions.js
//   node dev/verify_crystalupdate.mjs          # GREEN
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, connectMock, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TPL  = path.join(ROOT, 'www', 'capps', 'lifelog');
const BASE = process.argv.includes('--base');
const BASE_REF = 'release/r544';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const REAL = fs.readFileSync(path.join(TPL, 'crystal.html'), 'utf8');
const MAN  = JSON.parse(fs.readFileSync(path.join(TPL, 'capp.json'), 'utf8'));
const V0   = MAN.v;
const H0   = sha(REAL);

// ── Anchors ─────────────────────────────────────────────────────────
//
// A statement line of the script, unique in the page, outside any template literal,
// at about `frac` of the way down. A `//` line after it changes nothing the page does.
const LINES = REAL.split('\n');
const SCRIPT_AT = LINES.findIndex(l => /^<script>\s*$/.test(l));
const anchor = (frac) => {
	let ticks = 0;
	for (let i = 0; i < LINES.length; i++) {
		const l = LINES[i];
		if (i > SCRIPT_AT && i >= Math.floor(frac * LINES.length) && i < LINES.length - 1
			&& ticks % 2 === 0 && !l.includes('`') && /;\s*$/.test(l) && l.trim().length > 15
			&& LINES.filter(x => x === l).length === 1) return l;
		ticks += (l.match(/`/g) || []).length;
	}
	throw new Error('no anchor at ' + frac);
};
const AT = { A: anchor(0.10), B: anchor(0.50), C: anchor(0.80), D: anchor(0.95) };

/// `text` with `mark` as a line of its own after the line `at`.
const plant = (text, at, mark) => {
	const ls = text.split('\n');
	const i = ls.indexOf(at);
	if (i < 0 || ls.indexOf(at, i + 1) >= 0) throw new Error('anchor not unique: ' + at);
	ls.splice(i + 1, 0, mark);
	return ls.join('\n');
};
const M = {
	mineA: '// mine A: the person moved this',
	fixB:  '// fix B: the template fixed this',
	mineC: '// mine C: the person changed this line',
	fixC:  '// fix C: the template changed the same line',
	fixD:  '// fix D: a later fix',
};

const FORK  = plant(REAL, AT.A, M.mineA);
const T1    = plant(REAL, AT.B, M.fixB);
const T2    = plant(T1, AT.C, M.fixC);
const FORK2 = plant(FORK, AT.C, M.mineC);
const T3    = plant(T2, AT.D, M.fixD);

/// What the bundle serves, when this file wants it to be something else.
let plan = null;

const s = await open({
	name:    'crystalupdate',
	profile: scratch('pw', 'crystalupdate-' + process.pid),
	route:   async (page) => {
		if (BASE) {
			// The app before this change: everything else is the tree's.
			for (const f of ['js/daimond.js', 'js/versions.js']) {
				const body = execFileSync('git', ['-C', ROOT, 'show', BASE_REF + ':www/' + f],
					{ encoding: 'utf8', maxBuffer: 64 << 20 });
				await page.route('**/' + f, (r) => r.fulfill({
					status: 200, contentType: 'application/javascript', body,
				}));
			}
		}
		await page.route('**/capps/lifelog/**', async (r) => {
			if (!plan) return r.continue();
			const rel = new URL(r.request().url()).pathname.replace(/^.*\/capps\/lifelog\//, '');
			if (rel === 'capp.json') {
				return r.fulfill({
					status: 200, contentType: 'application/json',
					body: JSON.stringify({ v: plan.v, files: MAN.files }),
				});
			}
			if (plan.files[rel] != null) {
				return r.fulfill({ status: 200, contentType: 'text/plain', body: plan.files[rel] });
			}
			return r.continue();
		});
	},
});
const p = s.page;

const diamonds = () => p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return JSON.parse(await app.list_diamonds()); } catch (e) { return []; }
});

const storedPage = (id) => p.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return await app.read_crystal_page(id); } catch (e) { return null; }
}, id);

/// The page written as the daimon or the person writes it.
const writePage = (id, page) => p.evaluate(async ({ id, page }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_page(id, page);
	return true;
}, { id, page });

const record = (id) => p.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	let t = '';
	try { t = await m.store_read('diamonds/' + id + '/capp.json'); } catch (e) { return null; }
	try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}, id);

const answer = async (yes) => {
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((y) => {
		const c = [...document.querySelectorAll('.dlg-card')].filter(x => x.getClientRects().length).pop();
		const b = c.querySelector(y ? '.dlg-ok' : '.dlg-cancel') || c.querySelector('.dlg-ok');
		b.click();
	}, yes);
	await p.waitForTimeout(1500);
};

const pressInGuide = async () => {
	const f = p.frames().find(fr => /guide\/capps\.html/.test(fr.url()));
	if (!f) throw new Error('the guide frame is not showing capps.html');
	await f.click('#make-lifelog');
};

/// Off the face and back onto it: the real open, through `selectDiamond`.
const reopen = async () => {
	await p.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await p.waitForTimeout(500);
	await p.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
	await p.waitForTimeout(2200);
};

/// What is on screen about the template: the offer, its conflicts, the kept note.
const face = () => p.evaluate(() => {
	const o = document.getElementById('capp-offer');
	const n = document.getElementById('capp-note');
	const c = o ? o.querySelector('.capp-conflicts') : null;
	return {
		offer:     !!(o && o.getClientRects().length),
		ok:        !!(o && o.querySelector('.capp-offer-ok')),
		later:     !!(o && o.querySelector('.capp-offer-later')),
		conflicts: c ? (c.textContent || '') : null,
		text:      o ? (o.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) : '',
		note:      n ? (n.textContent || '').trim() : '',
		frame:     !!document.querySelector('#crystal-frame-wrap'),
	};
});

const press = async (sel) => {
	await p.evaluate((sel) => { const b = document.querySelector('#capp-offer ' + sel); if (b) b.click(); }, sel);
	await p.waitForTimeout(2200);
};

const has = (t, mark) => String(t || '').split('\n').includes(mark);

try {
	console.log('  ' + (BASE ? 'BASE (' + BASE_REF + ')' : 'tree') + ', template v' + V0 + ', anchors at lines '
		+ Object.values(AT).map(a => LINES.indexOf(a) + 1).join(', ') + ' of ' + LINES.length);
	await connectMock(s);
	await p.evaluate(() => DaimondWeb.guide('capps.html'));
	await p.waitForTimeout(2500);
	await pressInGuide();
	await answer(true);
	const made = (await diamonds()).filter(d => d.name === 'Log Life');
	check(made.length === 1, 'a Log Life is delivered', made.length + ' found');
	const id = made.length ? made[0].id : '';
	const rec0 = await record(id);
	check(!!rec0 && rec0.files && rec0.files['crystal.html'] === H0,
		'its record names the delivered page as the base', rec0 && rec0.files && rec0.files['crystal.html']);

	// ══ 1. A clean fix to a forked page is offered, and "Not now" holds ══
	await writePage(id, FORK);
	plan = { v: V0 + 1, files: { 'crystal.html': T1, ['base/' + H0 + '.html']: REAL } };
	await reopen();
	const f1 = await face();
	console.log('  offer: ' + f1.text + (f1.note ? ' | note: ' + f1.note : ''));
	check(String(await storedPage(id)) === FORK, 'the forked page is not rewritten on open');
	check(f1.offer && f1.ok && f1.later, 'A NEWER TEMPLATE IS OFFERED to the forked page, with Update and Not now');
	check(f1.conflicts === null, 'a clean merge lists no conflicts');
	check(!/crystal\.html/.test(f1.note), 'and the kept note does not also name the page', f1.note);
	check(f1.frame, 'the page is mounted beneath the offer');
	await p.screenshot({ path: scratch('crystalupdate-offer.png') });

	await press('.capp-offer-later');
	check(!(await face()).offer, '"Not now" takes the offer away');
	const rec1 = await record(id);
	check(!!rec1 && rec1.declined === V0 + 1, 'and is remembered at the version offered', rec1 && rec1.declined);
	await reopen();
	check(!(await face()).offer, 'it is not offered again at the same version');
	check(String(await storedPage(id)) === FORK, 'and the page is still the fork');

	// ══ 2. Both changed the same line: shown, then Update keeps the person's ══
	await writePage(id, FORK2);
	plan = { v: V0 + 2, files: { 'crystal.html': T2, ['base/' + H0 + '.html']: REAL } };
	await reopen();
	const f2 = await face();
	console.log('  offer: ' + f2.text);
	check(f2.offer, 'the next version is offered again');
	check(f2.conflicts != null && f2.conflicts.includes(M.mineC) && f2.conflicts.includes(M.fixC),
		'WHERE BOTH CHANGED THE SAME LINE, BOTH ARE SHOWN', f2.conflicts == null ? 'no conflicts block' : '');
	check(String(await storedPage(id)) === FORK2, 'nothing is written while the offer is on screen');
	await p.screenshot({ path: scratch('crystalupdate-conflict.png') });

	await press('.capp-offer-ok');
	const pg2 = await storedPage(id);
	check(has(pg2, M.mineA) && has(pg2, M.fixB) && has(pg2, M.mineC),
		'UPDATE BRINGS IN THE FIX AND KEEPS THE PERSON\'S CHANGES',
		['mineA', 'fixB', 'mineC'].filter(k => !has(pg2, M[k])).join(',') || null);
	check(!has(pg2, M.fixC), 'and at the conflict the person\'s line stays, not the template\'s');
	const rec2 = await record(id);
	check(!!rec2 && rec2.files && rec2.files['crystal.html'] === sha(T2),
		'the record\'s base moves to the template merged in');
	check(!!rec2 && rec2.v === V0 + 2, 'at its version', rec2 && rec2.v);
	const f2b = await face();
	check(!f2b.offer, 'and nothing is offered once it is taken');
	check(f2b.frame, 'with the merged page mounted');

	// ══ 3. A later fix merges against the new base ══
	plan = { v: V0 + 3, files: { 'crystal.html': T3, ['base/' + sha(T2) + '.html']: T2 } };
	await reopen();
	const f3 = await face();
	check(f3.offer && f3.conflicts === null,
		'A LATER FIX IS OFFERED CLEAN: the line kept over the template is not re-contested', f3.text);
	await press('.capp-offer-ok');
	const pg3 = await storedPage(id);
	check(has(pg3, M.mineA) && has(pg3, M.fixB) && has(pg3, M.mineC) && has(pg3, M.fixD) && !has(pg3, M.fixC),
		'and Update leaves the person\'s lines, both fixes, and not the line they kept out',
		['mineA', 'fixB', 'mineC', 'fixD'].filter(k => !has(pg3, M[k])).join(',') || null);
	const rec3 = await record(id);
	check(!!rec3 && rec3.files && rec3.files['crystal.html'] === sha(T3), 'the base moves again');
	await p.screenshot({ path: scratch('crystalupdate-done.png') });
} catch (e) {
	console.log('  FAIL threw — ' + (e && e.message));
	failures++;
} finally {
	const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway|gateway/i.test(e));
	if (errs.length) console.log('  console errors: ' + errs.slice(0, 6).join(' | '));
	await s.close();
}
console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
