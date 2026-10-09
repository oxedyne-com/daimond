// gateway: none
// verify_calendar.mjs — the person chooses Holocene or Common Era (D-20261006-34, D-20261006-30b).
//
// Drives the real page: the Calendar row in the Appearance menu, beside
// Language and Currency; a new account on Common Era; a choice that holds over a
// reload; the row fitting a phone; and a Diamond page reading the same calendar in
// its own sandboxed frame, under the real policy (so the browser, not a stub, says
// whether the inline clock may run).
//
//   eval "$(bash dev/world.sh 88 --env)"
//   node dev/verify_calendar.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_calendar.mjs
//   node dev/verify_calendar.mjs --break norow       the row is not drawn
//   node dev/verify_calendar.mjs --break noframe     the page frame gets no clock

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, signInAs, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || '') : ''; };
const BREAK = argAt('--break');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks: each puts ONE named bug back ──
const BREAKS = {
	norow:   { file: 'js/workspace.js', find: "if (!window.DaimondTime || !DaimondTime.setCalendar) return;",
	           with: 'return;' },
	noframe: { file: 'js/crystal.js', find: 'var add = CSP_META + timeTag() + (extra || \'\');',
	           with: 'var add = CSP_META + (extra || \'\');' },
};
let served = null;
if (BREAK) {
	const b = BREAKS[BREAK];
	if (!b) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
	const src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	if (src.split(b.find).length !== 2) { console.error(`break '${BREAK}': anchor not found once in ${b.file}`); process.exit(2); }
	served = { file: b.file, body: src.replace(b.find, b.with) };
}
const route = served ? async (page) => {
	await page.route('**/' + served.file, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: served.body }));
} : null;

const Y = new Date().getFullYear();

async function openMenu(page) {
	await page.evaluate(() => { const m = document.getElementById('settings-menu'); if (m && !m.hidden) document.getElementById('settings-menu-btn').click(); });
	await page.click('#settings-menu-btn');
	await page.waitForSelector('#settings-menu', { state: 'visible', timeout: 8000 });
}

/// What the row says, read from the page as drawn.
const rowState = (page) => page.evaluate(() => {
	const sel = document.getElementById('calendar-select');
	if (!sel) return null;
	const head = sel.closest('.set-pick') && sel.closest('.set-pick').previousElementSibling;
	const heads = [...document.querySelectorAll('#settings-menu .pop-head')].map((h) => h.textContent);
	const r = sel.getBoundingClientRect(), m = document.getElementById('settings-menu').getBoundingClientRect();
	return {
		value: sel.value, head: head ? head.textContent : '', heads,
		options: [...sel.options].map((o) => o.value + '=' + o.textContent),
		inside: r.left >= m.left - 0.5 && r.right <= m.right + 0.5 && r.width > 40,
		scrollsX: document.documentElement.scrollWidth > window.innerWidth,
	};
});

/// A Diamond page made the way crystal.js makes every one, run in a sandboxed frame, asked
/// what its own `DaimondTime` says. The page posts the answer itself.
const frameSays = (page) => page.evaluate(() => new Promise((res) => {
	const html = window.DaimondCrystal._armour('<!doctype html><html><body><script>'
		+ 'parent.postMessage({ calprobe: 1, out: (typeof DaimondTime === "object") '
		+ '? DaimondTime.calendar() + "|" + DaimondTime.fmtDate("2026-10-09") : "none" }, "*");'
		+ '<\/script></body></html>', '').html;
	const f = document.createElement('iframe');
	f.setAttribute('sandbox', 'allow-scripts');
	f.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px';
	const done = (v) => { window.removeEventListener('message', on); f.remove(); res(v); };
	const on = (e) => { if (e.data && e.data.calprobe) done(e.data.out); };
	window.addEventListener('message', on);
	setTimeout(() => done('timeout'), 6000);
	f.src = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
	document.body.appendChild(f);
}));

// ── The date surfaces (F-C3): each drawn from real data, read as the person sees it ──
const RELEASE_LOG = 'data:text/plain,' + encodeURIComponent([0, 1].map((i) => JSON.stringify({
	seq: i, ts: '2026-0' + (i + 2) + '-03T12:00:00.000Z', build: (i ? 'b' : 'a').repeat(12), note: 'Build ' + i,
	bundle: 'x'.repeat(64), prev: '0'.repeat(64), entry: 'e'.repeat(64) })).join('\n'));

/// Every date surface's text, drawn afresh under the calendar of the moment.
async function surfaces(page) {
	return page.evaluate(async (log) => {
		const out = {};
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		// Release notes: the history panel's own render, from a fixed log.
		try {
			let m = document.querySelector('meta[name="daimond-log"]');
			if (!m) { m = document.createElement('meta'); m.name = 'daimond-log'; document.head.appendChild(m); }
			m.content = log;
			window.DaimondRelease.reset();
			let host = document.getElementById('rel-list');
			if (!host) { host = document.createElement('div'); host.id = 'rel-list'; document.body.appendChild(host); }
			await window.DaimondRelease.render(host);
			await wait(200);
			out.release = [...host.querySelectorAll('.rel-when')].map((e) => e.textContent).join(' | ');
		} catch (e) { out.release = 'threw: ' + e.message; }
		// Trash: the panel's own render, over one item the bin holds until a fixed day.
		try {
			const core = window.DaimondCore, real = core.trashList;
			core.trashList = async () => [{ id: 'fc3', kind: 'chat', name: 'A binned chat', bytes: 2048,
				at: Date.parse('2026-10-01T12:00:00Z'), due: Date.parse('2026-11-01T12:00:00Z') }];
			window.DaimondPanels.show('trash');
			await wait(300);
			try { await window.DaimondTrashPanel.render(); } finally { core.trashList = real; }
			await wait(200);
			out.trash = [...document.querySelectorAll('#trash-list .arte-row')].map((e) => e.textContent).join(' | ');
		} catch (e) { out.trash = 'threw: ' + e.message; }
		// Every shape the formatter offers, through the page's own copy.
		const ts = Date.parse('2026-10-09T12:00:00Z');
		out.shapes = ['day', 'dayLong', 'weekday', 'whenFull'].map((k) => window.DaimondTime.fmtLocal(ts, k)).join(' | ');
		return out;
	}, RELEASE_LOG);
}

/// Which year a drawn text carries: 'he', 'ce', 'both', or 'none'.
const yearIn = (txt) => {
	const he = /(^|[^0-9])120\d\d([^0-9]|$)/.test(txt), ce = /(^|[^0-9])20\d\d([^0-9]|$)/.test(txt);
	return he && ce ? 'both' : he ? 'he' : ce ? 'ce' : 'none';
};

async function surfacesAre(page, cal, label) {
	const s = await surfaces(page);
	for (const k of ['release', 'trash', 'shapes']) check(label + ': ' + k + ' reads ' + cal, yearIn(s[k]) === cal, String(s[k]).slice(0, 160));
}

console.log(`verify_calendar on ${BROWSER}${BREAK ? ' (break: ' + BREAK + ')' : ''}`);
let s = null;
try {
	s = await open({ name: 'calA', profile: scratch('calendar-' + BROWSER + '-' + process.pid), defaults: false, connect: false, route });
	await signInAs(s, 'calA');
	const { page } = s;
	await page.setViewportSize({ width: 1280, height: 860 });
	await page.waitForTimeout(400);

	await openMenu(page);
	let st = await rowState(page);
	check('the Calendar row is in the menu', !!st, JSON.stringify(st));
	if (st) {
		const iCur = st.heads.indexOf('Currency'), iCal = st.heads.indexOf('Calendar');
		check('it sits after Language and Currency', st.head === 'Calendar' && iCal > iCur && iCur > st.heads.indexOf('Language'), st.heads.join(' / '));
		check('it offers both calendars, each with this year as it would read',
			st.options.length === 2 && st.options[0] === `ce=Common Era (${Y})` && st.options[1] === `he=Holocene (${Y + 10000})`, st.options.join(', '));
		check('a new account is on the Common Era', st.value === 'ce', st.value);
		check('the row fits the menu', st.inside);
	}
	check('a page frame reads the Common Era from its own DaimondTime', (await frameSays(page)) === 'ce|2026-10-09');

	if (st) {
		await page.selectOption('#calendar-select', 'he');
		await page.waitForTimeout(200);
		const rec = await page.evaluate(() => ({ cal: window.DaimondTime.calendar(), stored: localStorage.getItem('daimond-calendar') }));
		check('choosing Holocene takes at once and is stored as the account’s record',
			rec.cal === 'he' && /"cal":"he"/.test(String(rec.stored)), JSON.stringify(rec));
		check('a page frame made after it reads Holocene', (await frameSays(page)) === 'he|12026-10-09');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(s, 'calA');
		await page.waitForTimeout(400);
		await openMenu(page);
		st = await rowState(page);
		check('the choice holds over a reload', !!st && st.value === 'he', st && st.value);

		// The switch, both ways, on every date surface (F-C3).
		await page.setViewportSize({ width: 1280, height: 860 });
		await page.waitForTimeout(300);
		await surfacesAre(page, 'he', 'Holocene');
		await openMenu(page);
		await page.selectOption('#calendar-select', 'ce');
		await page.waitForTimeout(200);
		await surfacesAre(page, 'ce', 'switched to Common Era');
		await openMenu(page);
		await page.selectOption('#calendar-select', 'he');
		await page.waitForTimeout(200);
		await surfacesAre(page, 'he', 'and back to Holocene');

		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(300);
		// Below 760px Settings folds into Help (PH-01); open it from there.
		await page.evaluate(() => { const m = document.getElementById('settings-menu'); if (m && !m.hidden) { const c = m.querySelector('.ui-close'); if (c) c.click(); } });
		await page.evaluate(() => { const b = document.getElementById('settings-menu-btn'); if (b) b.click(); });
		await page.waitForSelector('#settings-menu', { state: 'visible', timeout: 8000 }).catch(() => {});
		st = await rowState(page);
		check('at 390px the row fits and the page does not scroll sideways', !!st && st.inside && !st.scrollsX, JSON.stringify(st && { inside: st.inside, scrollsX: st.scrollsX }));
	}
} catch (e) {
	console.error('the run threw: ' + (e && (e.stack || e.message) || e));
	bad.push('the run threw');
} finally {
	try { await s?.close?.(); } catch {}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed' + (BREAK ? '  (break: ' + BREAK + ')' : ''));
if (bad.length) for (const n of bad) console.log('  FAILED: ' + n);
process.exit(bad.length ? 1 : 0);
