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
const YM    = ymd(new Date()).slice(0, 7);
const SHARD = 'log/body/' + YM + '.jsonl';
const ent = (kg, idn, h) => {
	const d = new Date(); d.setHours(h, 0, 0, 0);
	return JSON.stringify({ id: idn, at: iso(d), day: ymd(d), src: 'form', f: { kg }, w: Date.now() });
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
	await put(pa, id, SHARD, ent(81.3, 'a1', 6) + '\n');
	await pa.evaluate(() => { try { DaimondPanels.hide('guide'); DaimondPanels.hide('work'); DaimondPanels.show('ai'); } catch (e) {} });
	await pa.waitForTimeout(400);
	await pa.$$eval('.diamond-box', (els, n) => { const b = els.find(x => x.textContent.indexOf(n) >= 0); (b || els[0]).click(); }, NAME);
	check(await waitFrame('[data-a="lane"][data-v="body"]'), 'the Life log page is mounted on A');
	await toBody();
	check(/81[.,]3/.test(await frameText() || ''), 'and shows its one entry');

	// ══ 1. Looking, not typing ══════════════════════════════════════
	await markFrame();
	await fromB(id, bAppend, { shard: SHARD, line: ent(79.9, 'b1', 7) });
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
	await fromB(id, bAppend, { shard: SHARD, line: ent(79.4, 'b2', 8) });
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
