// dev/verify_crystalsync.mjs -- a crystal changed on another device reaches the page on
// screen without taking anything the person is in the middle of (D-20261006-07, QA B
// r543 F-B1..F-B5).
//
// Two browsers, two devices. A shows a Life log; B holds the same Diamond, changes it,
// and A takes B's export through `import_diamond` and the `daimond-diamonds-rev` storage
// event: the two halves of the real sync arrival (`applyDiamonds`). B always starts from
// A's latest export, so every arrival is a one-sided pull, as sync makes it.
//
//   1  B logs a weight while A looks at the Body lane: A shows it, same mount.
//   2  B logs a weight while A is half-way through a Weigh-in entry: A keeps its typing
//      and caret, through a log change and a crystal.json change, and after Log it holds
//      both entries, on screen and in the shard.
//   3  A's Edit form saves over a key B did not touch: the two are merged per key.
//   4  Both changed the summary: nothing is written and "Changed on another device" is
//      shown; Keep mine then writes A's.
//   5  Typing in the memory panel, an arrival, and the panel folded: the typing stays.
//   6  Edit pressed while an arrival that changes the page is being drawn (by the clock,
//      and at each of the redraw's reads of the page): the form is not wiped.
//   7  A redraw in the middle of a re-read leaves another device's newer set value
//      alone (r545 F1-2).
//   8  A set typed and not ticked survives a log arrival and then a page arrival; the
//      page arrival is drawn after the tick (r545 QA B F-B1).
//   9  "Update the Page" on a forked page waits for a typed set too (r545 QA B F-B2).
//
// Fail-first: RED on dfd760b3 (the r543 repaint, which remounts) and on 08b15694 (no
// repaint at all); GREEN on fire/crysync.
//
//   eval "$(bash dev/world.sh 99 --up)"; node dev/verify_crystalsync.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR  = path.join(HERE, '..', 'www', 'capps', 'lifelog');
const MAN  = JSON.parse(fs.readFileSync(path.join(DIR, 'capp.json'), 'utf8'));
const NAME = 'Sync log';

let bad = 0;
const check = (cond, name, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? ' -- ' + detail : ''));
	if (!cond) bad++;
};

const p2  = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const iso = d => {
	const o = -d.getTimezoneOffset(), sg = o < 0 ? '-' : '+', a = Math.abs(o);
	return ymd(d) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':00' + sg + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
};

/// A weight logged `k` steps before now (k = 3, 2, 1: oldest first), on the day the page
/// itself would file it under. Seeded at fixed hours of today, the entries were in the
/// future before 08:00 and, before the Body lane's day turns (`dayStart`, 04:00), on a day
/// the page was not showing yet: the run was red from midnight (r545 QA B F-B3; the nightly
/// runs it about 05:00). Kept inside the page's current day, so one shard holds them all.
const DS    = JSON.parse(fs.readFileSync(path.join(DIR, 'lanes', 'body.json'), 'utf8')).dayStart || 0;
const dayOf = (t) => ymd(new Date(t - DS * 60e3));
const NOW0  = Date.now();
const DAY0  = (() => { const d = new Date(NOW0 - DS * 60e3); d.setHours(0, 0, 0, 0); return d.getTime() + DS * 60e3; })();
const SHARD = 'log/body/' + dayOf(NOW0).slice(0, 7) + '.jsonl';
const agoAt = (k) => new Date(Math.max(DAY0, NOW0 - k * 5 * 60e3));
const ent = (kg, idn, k) => {
	const d = agoAt(k);
	return JSON.stringify({ id: idn, at: iso(d), day: dayOf(d.getTime()), src: 'form', f: { kg }, w: Date.now() });
};

const mk = (who) => open({ name: 'crysync' + who, profile: scratch('pw', 'crysync' + who + '-' + process.pid),
	signIn: true, connect: true, defaults: false,
	route: async (page) => { await page.setViewportSize({ width: 1280, height: 1400 }); } });
const A = await mk('A');
const B = await mk('B');
const pa = A.page, pb = B.page;

// The store, the app and a free DaimondApp on either side.
const lib = (p) => p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	window.__m = m;
	window.__free = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
});
const put = (p, id, rel, content) => p.evaluate(async (a) => {
	await window.__m.store_write('diamonds/' + a.id + '/' + a.rel, a.content);
	await window.__m.touch_diamond(a.id);
}, { id, rel, content });
const get = (p, id, rel) => p.evaluate(async (a) => {
	try { return await window.__m.store_read('diamonds/' + a.id + '/' + a.rel); } catch (e) { return null; }
}, { id, rel });
const crystal = (p, id) => p.evaluate(async (id) => {
	try { return JSON.parse(await window.__free.read_crystal_data(id)); } catch (e) { return null; }
}, id);
const exportOf = (p, id) => p.evaluate((id) => window.__free.export_diamond(id), id);

const fr = () => pa.frames().find(f => f.url().indexOf('blob:') === 0);
const inFrame = async (fn, arg) => {
	const f = fr(); if (!f) return null;
	try { return await f.evaluate(fn, arg); } catch (e) { return null; }
};
const frameText = () => inFrame(() => document.body.innerText);
const waitFrame = async (sel) => {
	for (let k = 0; k < 30; k++) {
		if (await inFrame((s) => !!document.querySelector(s), sel)) return true;
		await pa.waitForTimeout(300);
	}
	return false;
};
const reopen = async () => {
	await pa.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await pa.waitForTimeout(500);
	await pa.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
	await waitFrame('[data-a="lane"]');
};
const toBody = async () => {
	await inFrame(() => { const b = document.querySelector('[data-a="lane"][data-v="body"]'); if (b) b.click(); });
	await pa.waitForTimeout(700);
};
const markFrame = () => inFrame(() => { window.__syncMark = 'same'; });
const frameMark = async () => (await inFrame(() => window.__syncMark || 'remounted')) || 'no frame';

/// B takes A as it now is, changes it with `fn(id, arg)` (run in B's page), and A takes B's
/// export the way sync delivers it. `after` runs in A's page in the same tick as the event.
const fromB = async (id, fn, arg, after) => {
	const mine = await exportOf(pa, id);
	await pb.evaluate((j) => window.__free.import_diamond(j, false), mine);
	await pb.evaluate(new Function('a', 'return (' + fn + ')(a);'), Object.assign({ id }, arg || {}));
	await pb.evaluate((id) => window.__m.touch_diamond(id), id);
	const theirs = await exportOf(pb, id);
	await pa.evaluate(async (a) => {
		await window.__free.import_diamond(a.theirs, false);
		window.dispatchEvent(new StorageEvent('storage', { key: 'daimond-diamonds-rev', newValue: String(Date.now()) }));
		if (a.after) (new Function(a.after))();
	}, { theirs, after: after || '' });
};
const bAppend = String(async (a) => {
	const p = 'diamonds/' + a.id + '/' + a.shard;
	let t = '';
	try { t = await window.__m.store_read(p) || ''; } catch (e) { t = ''; }
	await window.__m.store_write(p, t + a.line + '\n');
});
const bCrystal = String(async (a) => {
	const d = JSON.parse(await window.__free.read_crystal_data(a.id));
	Object.assign(d, a.set);
	await window.__free.write_crystal_data(a.id, JSON.stringify(d, null, 2));
});
const bPage = String(async (a) => {
	const h = await window.__free.read_crystal_page(a.id);
	await window.__free.write_crystal_page(a.id, h + '\n<!-- ' + a.tag + ' -->\n');
});

const barEdit = () => pa.evaluate(() => {
	const b = [...document.querySelectorAll('#crystal-body .crystal-bar button')].find(x => /Edit/.test(x.textContent));
	if (b) b.click();
	return !!b;
});
const formSave = () => pa.evaluate(() => {
	const b = document.querySelector('#crystal-body .crystal-bar .crystal-act.primary');
	if (b) b.click();
	return !!b;
});

try {
	await Promise.all([lib(pa), lib(pb)]);
	if (!await pa.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory))) {
		console.log('  NOT COVERED: no OPFS in this engine'); process.exit(0);
	}

	// ── The Life log, on A ────────────────────────────────────────
	await pa.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
	await pa.waitForTimeout(900);
	await pa.fill('.dlg-input', NAME).catch(() => {});
	await pa.click('.dlg-ok', { force: true }).catch(() => {});
	await pa.waitForTimeout(2500);
	const id = await pa.evaluate(async (n) => {
		const d = JSON.parse(await window.__free.list_diamonds()).find(x => x.name === n);
		return d ? d.id : '';
	}, NAME);
	check(!!id, 'a Diamond was made on A', id);
	if (!id) throw new Error('no Diamond');
	await put(pa, id, 'crystal.json', JSON.stringify({ title: NAME, summary: 'What I weigh.' }, null, 2));
	await put(pa, id, 'crystal.html', fs.readFileSync(path.join(DIR, 'crystal.html'), 'utf8'));
	for (const rel of MAN.files.filter(f => f !== 'crystal.html')) {
		await put(pa, id, rel, fs.readFileSync(path.join(DIR, rel), 'utf8'));
	}
	await put(pa, id, SHARD, ent(81.3, 'a1', 3) + '\n');
	await pa.evaluate(() => { try { DaimondPanels.hide('guide'); DaimondPanels.hide('work'); DaimondPanels.show('ai'); } catch (e) {} });
	await pa.waitForTimeout(400);
	await pa.$$eval('.diamond-box', (els, n) => { const b = els.find(x => x.textContent.indexOf(n) >= 0); (b || els[0]).click(); }, NAME);
	check(await waitFrame('[data-a="lane"][data-v="body"]'), 'the Life log page is mounted on A');
	await toBody();
	check(/81[.,]3/.test(await frameText() || ''), 'and shows its one entry');

	// ══ 1. Looking, not typing ══════════════════════════════════════
	await markFrame();
	await fromB(id, bAppend, { shard: SHARD, line: ent(79.9, 'b1', 2) });
	await pa.waitForTimeout(2500);
	const t1 = await frameText() || '';
	check(/79[.,]9/.test(t1), '1: an entry logged on B appears on A\'s open page', '79.9 shown=' + /79[.,]9/.test(t1));
	check(await frameMark() === 'same', '1: without remounting the page', await frameMark());

	// ══ 2. Half-way through a Weigh-in entry ════════════════════════
	const opened = await inFrame(() => {
		const t = [...document.querySelectorAll('[data-a="tile"]')].find(x => /Weigh in/.test(x.textContent));
		if (t) t.click();
		return !!t;
	});
	await pa.waitForTimeout(600);
	const f = fr();
	let typed = false;
	if (opened && f) {
		await f.fill('[data-in="kg"]', '80.5').catch(() => {});
		await f.click('[data-in="_note"]').catch(() => {});
		await pa.keyboard.type('HALF TYPED', { delay: 15 });
		typed = !!(await inFrame(() => {
			const i = document.querySelector('[data-in="_note"]');
			i.setSelectionRange(4, 4);
			return i.value === 'HALF TYPED' && document.activeElement === i;
		}));
	}
	check(typed, '2: A has the Weigh-in form open, half typed');
	await markFrame();
	await fromB(id, bAppend, { shard: SHARD, line: ent(79.4, 'b2', 1) });
	await pa.waitForTimeout(3000);
	const st2 = await inFrame(() => {
		const i = document.querySelector('[data-in="_note"]'), k = document.querySelector('[data-in="kg"]');
		return { note: i ? i.value : null, kg: k ? k.value : null, focus: document.activeElement === i,
			caret: i ? i.selectionStart : -1 };
	}) || {};
	check(await frameMark() === 'same', '2: the page was not remounted under the typing', await frameMark());
	check(st2.note === 'HALF TYPED' && st2.kg === '80.5', '2: the typing is kept', JSON.stringify(st2));
	check(st2.focus && st2.caret === 4, '2: and so are the focus and the caret', JSON.stringify(st2));
	// The crystal's own memory moving under the same typing (QA B L2).
	await fromB(id, bCrystal, { set: { summary: 'What I weigh, says B.' } });
	await pa.waitForTimeout(3000);
	const st2b = await inFrame(() => {
		const i = document.querySelector('[data-in="_note"]');
		return { note: i ? i.value : null, focus: document.activeElement === i, caret: i ? i.selectionStart : -1 };
	}) || {};
	check(await frameMark() === 'same' && st2b.note === 'HALF TYPED' && st2b.focus && st2b.caret === 4,
		'2: a crystal.json change from B leaves the page, the typing and the caret', await frameMark() + ' ' + JSON.stringify(st2b));
	await inFrame(() => { const b = document.querySelector('[data-a="commit"]'); if (b) b.click(); });
	await pa.waitForTimeout(1500);
	await toBody();
	const t2 = await frameText() || '';
	check(/79[.,]4/.test(t2) && /80[.,]5/.test(t2), '2: after Log it, A shows B\'s entry and its own',
		'79.4=' + /79[.,]4/.test(t2) + ' 80.5=' + /80[.,]5/.test(t2));
	const sh = String(await get(pa, id, SHARD) || '');
	check(/"b2"/.test(sh) && /80\.5/.test(sh), '2: and the shard holds both', sh.split('\n').length - 1 + ' lines');

	// ══ 3. The Edit form, saved over a key only B moved ═════════════
	await reopen();
	check(await barEdit(), '3: A opens Edit');
	await pa.waitForTimeout(500);
	await pa.fill('#crystal-f-title', 'Weights A').catch(() => {});
	await fromB(id, bCrystal, { set: { summary: 'Summary from B.' } });
	await pa.waitForTimeout(2000);
	check(!!(await pa.$('#crystal-f-title')), '3: the form is still open after the arrival');
	await formSave();
	await pa.waitForTimeout(2000);
	const c3 = await crystal(pa, id) || {};
	check(c3.title === 'Weights A' && c3.summary === 'Summary from B.', '3: the save is merged per key',
		JSON.stringify({ title: c3.title, summary: c3.summary }));

	// ══ 4. Both moved the summary ═══════════════════════════════════
	await reopen();
	await barEdit();
	await pa.waitForTimeout(500);
	await pa.fill('#crystal-f-summary', 'Summary from A.').catch(() => {});
	await fromB(id, bCrystal, { set: { summary: 'Summary again from B.' } });
	await pa.waitForTimeout(2000);
	await formSave();
	await pa.waitForTimeout(2000);
	const box = await pa.evaluate(() => {
		const b = document.querySelector('#crystal-body .crystal-conflict');
		return b && b.getClientRects().length ? b.textContent.replace(/\s+/g, ' ') : '';
	});
	const c4 = await crystal(pa, id) || {};
	check(/Changed on another device/.test(box), '4: a both-sides change shows "Changed on another device"', box.slice(0, 120));
	check(c4.summary === 'Summary again from B.', '4: and writes nothing', c4.summary);
	await pa.evaluate(() => {
		const b = [...document.querySelectorAll('#crystal-body .crystal-conflict button')].find(x => /Keep mine/.test(x.textContent));
		if (b) b.click();
	});
	await pa.waitForTimeout(2000);
	const c4b = await crystal(pa, id) || {};
	check(c4b.summary === 'Summary from A.' && c4b.title === 'Weights A', '4: Keep mine writes A\'s, merged with the rest', c4b.summary);

	// ══ 5. The memory panel holds typing, then folds ════════════════
	await reopen();
	const tp = await pa.evaluate(() => {
		const mem = document.querySelector('#crystal-body .crystal-memory');
		if (!mem) return false;
		mem.open = true;
		const rb = mem.querySelector('.mem-raw-btn'); if (rb) rb.click();
		const ta = mem.querySelector('.crystal-memory-ta');
		if (!ta) return false;
		ta.value = ta.value.replace('{', '{\n  "typed": "UNSAVED",');
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	});
	check(tp, '5: A types into the memory panel');
	await fromB(id, bCrystal, { set: { summary: 'Summary while A typed.' } });
	await pa.waitForTimeout(1500);
	await pa.evaluate(() => { const mem = document.querySelector('#crystal-body .crystal-memory'); if (mem) mem.open = false; });
	await pa.waitForTimeout(2500);
	const ta5 = await pa.evaluate(() => {
		const ta = document.querySelector('#crystal-body .crystal-memory .crystal-memory-ta');
		return ta ? ta.value : null;
	});
	check(/UNSAVED/.test(String(ta5)), '5: folding the panel after an arrival keeps the unsaved typing',
		ta5 === null ? 'no panel' : 'typed=' + /UNSAVED/.test(ta5));

	// ══ 6. Edit pressed the instant a page change arrives ═══════════
	// By the clock, and then exactly inside the window: the redraw's Nth read of the page
	// resolves only after Edit has been pressed, so the redraw resumes over an open form.
	// The read is the app's own `DaimondApp.read_crystal_page`, wrapped on the prototype.
	await pa.evaluate(() => {
		const P = window.__m.DaimondApp.prototype, orig = P.read_crystal_page;
		if (P.__wrapped) return;
		P.__wrapped = true;
		P.read_crystal_page = async function (id) {
			const out = await orig.call(this, id);
			const w = window.__editAt;
			if (w && ++w.seen === w.n) {
				const b = [...document.querySelectorAll('#crystal-body .crystal-bar button')].find(x => /Edit/.test(x.textContent));
				if (b) { b.click(); const t = document.getElementById('crystal-f-title'); if (t) t.value = w.label; }
				w.pressed = !!b;
			}
			return out;
		};
	});
	const EDIT = 'var b = [].slice.call(document.querySelectorAll("#crystal-body .crystal-bar button"))'
		+ '.find(function (x) { return /Edit/.test(x.textContent); }); if (b) b.click();'
		+ ' var t = document.getElementById("crystal-f-title"); if (t) t.value = "LABEL";';
	const cases = [['0 ms', 'setTimeout(function () {' + EDIT + '}, 0);'],
		['200 ms', 'setTimeout(function () {' + EDIT + '}, 200);']];
	for (const n of [1, 2, 3]) cases.push(['at page read ' + n, 'window.__editAt = { n: ' + n + ', seen: 0, label: "LABEL" };']);
	for (const [when, js] of cases) {
		await reopen();
		await pa.evaluate(() => { window.__editAt = null; const mem = document.querySelector('#crystal-body .crystal-memory'); if (mem) mem.open = false; });
		await fromB(id, bPage, { tag: 'from B ' + when }, js.replace('LABEL', 'EDIT ' + when));
		await pa.waitForTimeout(3500);
		const v = await pa.evaluate(() => { const t = document.getElementById('crystal-f-title'); return t ? t.value : null; });
		const pressed = await pa.evaluate(() => window.__editAt ? !!window.__editAt.pressed : true);
		if (!pressed) { console.log('  note 6 (' + when + '): no such read after the arrival; not a case here'); }
		else check(v === 'EDIT ' + when, '6: Edit pressed ' + when + ' after a page-changing arrival is not wiped', v === null ? 'form gone' : v);
		await pa.evaluate(() => { window.__editAt = null; });
		await pa.evaluate(() => {
			const b = [...document.querySelectorAll('#crystal-body .crystal-bar button')].find(x => /Cancel/.test(x.textContent));
			if (b) b.click();
		});
		await pa.waitForTimeout(1500);
	}

	// ── The gym: a set row, pending, typed into and not ticked ──────
	const GYM = 'log/gym/' + ymd(new Date()).slice(0, 7) + '.jsonl';
	const tile = (re) => inFrame((r) => {
		const t = [...document.querySelectorAll('[data-a="tile"]')].find(x => new RegExp(r).test(x.textContent));
		if (t) t.click();
		return !!t;
	}, re);
	const setKeys = () => inFrame(() => [...document.querySelectorAll('[data-set$="|kg"]')].map(i => i.getAttribute('data-set')));
	const kgOf = (key) => inFrame((k) => {
		const i = [...document.querySelectorAll('[data-set]')].find(x => x.getAttribute('data-set') === k);
		return i ? i.value : null;
	}, key);
	/// A new pending squat set on the open page; answers its `data-set` key for kg.
	const pendingSet = async () => {
		await inFrame(() => { const b = document.querySelector('[data-a="lane"][data-v="gym"]'); if (b) b.click(); });
		await pa.waitForTimeout(900);
		const before = await setKeys() || [];
		if (!(await tile('Add exercises'))) { await tile('Start a workout'); await pa.waitForTimeout(1000); await tile('Add exercises'); }
		await pa.waitForTimeout(900);
		await inFrame(() => { const b = document.querySelector('[data-a="ptoggle"][data-v="sq"]'); if (b) b.click(); });
		await pa.waitForTimeout(300);
		await inFrame(() => { const b = document.querySelector('[data-a="padd"]'); if (b) b.click(); });
		await pa.waitForTimeout(1200);
		return ((await setKeys()) || []).find(k => before.indexOf(k) < 0) || '';
	};
	const typeSet = async (key, v) => {
		const loc = fr().locator('[data-set="' + key + '"]');
		await loc.fill(v);
		await pa.waitForTimeout(200);
		await inFrame(() => document.activeElement && document.activeElement.blur());
		await pa.waitForTimeout(300);
	};
	const busy = () => pa.evaluate(() => { try { return window.DaimondCrystal.busy(); } catch (e) { return null; } });

	// ══ 7. A theme redraw in the middle of a re-read (r545 F1-2) ═════
	// B moves a pending set A has not typed into. A redraw landing while A re-reads (here:
	// after each shard is read, which is what a theme change does at the wrong moment)
	// must not write the old value in A's row over B's newer one.
	await reopen();
	const k7 = await pendingSet();
	check(!!k7, '7: A has a pending squat set', k7);
	const e7 = String(await get(pa, id, GYM) || '').split('\n').filter(Boolean).map(x => JSON.parse(x)).filter(e => e.id === k7.split('|')[0]).pop();
	if (e7) {
		const nb = Object.assign({}, e7, { f: Object.assign({}, e7.f, { kg: '99' }), w: Date.now() + 1 });
		// The page's functions are private to its closure, so the redraw is driven from outside,
		// as a person's resize or theme change would: the frame's width flips every 40 ms through
		// the whole arrival, and each flip redraws (ResizeObserver) whatever re-read is in flight.
		await markFrame();
		await fromB(id, bAppend, { shard: GYM, line: JSON.stringify(nb) });
		let flips = 0;
		for (const t0 = Date.now(); Date.now() - t0 < 3000; flips++) {
			await pa.setViewportSize({ width: flips % 2 ? 1180 : 1280, height: 1400 });
			await pa.waitForTimeout(40);
		}
		await pa.setViewportSize({ width: 1280, height: 1400 });
		await pa.waitForTimeout(800);
		const v7 = await kgOf(k7);
		check(v7 === '99', '7: B\'s newer value for the set stands through redraws mid re-read',
			'row shows ' + JSON.stringify(v7) + ' was ' + JSON.stringify(e7.f) + ', ' + flips + ' redraws');
		check(await frameMark() === 'same', '7: same mount', await frameMark());
	} else check(false, '7: the pending set is on disk', k7);

	// ══ 8. A typed, unticked set through a log arrival and a page arrival (r545 F-B1) ══
	await typeSet(k7, '142.5');
	check(await busy() === true, '8: typed and blurred, the page is busy', String(await busy()));
	await fromB(id, bAppend, { shard: SHARD, line: ent(78.8, 'b3', 1) });
	await pa.waitForTimeout(2500);
	check(await busy() === true, '8: still busy after another device\'s log arrives', String(await busy()));
	// The person taps the field again and taps away, typing nothing.
	await fr().locator('[data-set="' + k7 + '"]').click().catch(() => {});
	await pa.waitForTimeout(200);
	await inFrame(() => document.activeElement && document.activeElement.blur());
	await pa.waitForTimeout(500);
	await markFrame();
	await fromB(id, bPage, { tag: 'page from B (8)' });
	await pa.waitForTimeout(4000);
	const v8 = await kgOf(k7);
	check(await frameMark() === 'same' && v8 === '142.5',
		'8: a page arrival waits, and the typed set is still there', await frameMark() + ' ' + JSON.stringify(v8));
	await inFrame((k) => { const b = document.querySelector('[data-a="tick"][data-v="' + k + '"]'); if (b) b.click(); }, k7.split('|')[0]);
	await pa.waitForTimeout(1500);
	check(/142\.5/.test(String(await get(pa, id, GYM) || '')), '8: the tick writes it');
	let m8 = 'same';
	for (let k = 0; k < 10 && m8 === 'same'; k++) { await pa.waitForTimeout(500); m8 = await frameMark(); }
	check(m8 === 'remounted', '8: and then the page that arrived is drawn', m8);

	// ══ 9. "Update the Page" with a set typed and not ticked (r545 F-B2) ══
	// A forked page of a past template that says when it is mid-entry, and its record.
	const BASES = path.join(DIR, 'base');
	const bf = fs.existsSync(BASES) ? fs.readdirSync(BASES).filter(f => /^[0-9a-f]{64}\.html$/.test(f)) : [];
	const b9 = bf.map(f => ({ f, t: fs.readFileSync(path.join(BASES, f), 'utf8') }))
		.filter(x => x.t.indexOf("cmd: 'dirty'") >= 0).sort((x, y) => y.t.length - x.t.length)[0];
	check(!!b9, '9: a served base page that reports mid-entry', bf.length + ' bases');
	if (b9) {
		await put(pa, id, 'crystal.html', b9.t + '\n<!-- forked here -->\n');
		await put(pa, id, 'capp.json', JSON.stringify({ capp: 'lifelog', v: MAN.v - 1, files: { 'crystal.html': b9.f.slice(0, 64) } }));
		await reopen();
		await pa.waitForTimeout(1500);
		check(!!(await pa.$('#capp-offer .capp-offer-ok')), '9: the forked page is offered the template\'s fix');
		const k9 = await pendingSet();
		await typeSet(k9, '77.5');
		await markFrame();
		await pa.click('#capp-offer .capp-offer-ok').catch(() => {});
		await pa.waitForTimeout(3000);
		const v9 = await kgOf(k9);
		const note9 = await pa.evaluate(() => { const e = document.getElementById('capp-offer'); return e ? e.textContent : ''; });
		check(await frameMark() === 'same' && v9 === '77.5', '9: Update the Page waits for the typed set',
			await frameMark() + ' ' + JSON.stringify(v9));
		check(/entry you are typing/.test(note9), '9: and says why nothing has moved yet', note9.slice(0, 120));
		await inFrame((k) => { const b = document.querySelector('[data-a="tick"][data-v="' + k + '"]'); if (b) b.click(); }, k9.split('|')[0]);
		let m9 = 'same';
		for (let k = 0; k < 10 && m9 === 'same'; k++) { await pa.waitForTimeout(500); m9 = await frameMark(); }
		// The mark flips as the old frame goes; the new one's scripts may not have run yet.
		let fixd = false, fr9 = [];
		for (let k = 0; k < 20 && !fixd; k++) {
			fr9 = [];
			for (const f of pa.frames().filter(f => f.url().indexOf('blob:') === 0)) {
				// The page's functions are closure-private: the drawn frame is measured by its source.
				fr9.push(await f.evaluate(() => {
					const h = document.documentElement.outerHTML;
					return (/function anyTyped\(/.test(h) ? 'fix' : 'nofix') + (/forked here/.test(h) ? '+fork' : '') + ' ' + h.length;
				}).catch(() => 'err'));
			}
			fixd = fr9.some(x => /^fix/.test(x));
			if (!fixd) await pa.waitForTimeout(250);
		}
		const pg9 = await pa.evaluate((id) => window.__free.read_crystal_page(id), id);
		const set9 = /77\.5/.test(String(await get(pa, id, GYM) || ''));
		check(m9 === 'remounted' && fixd && /forked here/.test(pg9) && set9,
			'9: after the tick the merged page is drawn, the fork kept and the set written',
			JSON.stringify({ m9, fixd, fr9, inPage: /function anyTyped/.test(pg9), fork: /forked here/.test(pg9), set9 }));
	}
	await pa.screenshot({ path: scratch('crystalsync-end.png') });
} catch (e) {
	console.log('  FAIL threw: ' + (e && e.stack || e));
	bad++;
} finally {
	await A.close().catch(() => {});
	await B.close().catch(() => {});
}
console.log(bad ? `RED: ${bad} failure(s)` : 'GREEN: 0 failures');
process.exit(bad ? 1 : 0);
