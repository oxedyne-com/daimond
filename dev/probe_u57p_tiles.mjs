// probe_u57p_tiles.mjs -- the Pending tiles of the Optimiser's proposals (Rating U7b), drawn in a real page and pressed.
// Not the plan's OP1-OP5 (lane V's verify_optimiser). This is lane P's own reading of three things the node test cannot see:
// the drawing (heights, overflow, overlap at 390px, the same control drawn the same), every press wired (none inert), and the
// Edit dialog (the live lint withholds Add). The note file is U6b's; a stand-in `DaimondNotes` (the names lane S's log fixes, and U7c's
// `switched`, which a Switch press writes first) counts writes. U7c adds the fifth tile, the review of a switch (`back`).
//   eval "$(bash dev/world.sh 87 --env)"; RC_SLOT=<slot> node dev/probe_u57p_tiles.mjs
import { open, checker } from './harness.mjs';

const { bad, check } = checker();
const s = await open({ name: 'u57p-tiles' });
const p = s.page;
const SHOTS = process.env.CONS_OUT || '';
const shot = async (n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/u57p_${n}.png` }).catch(() => {}); };
const LINE = 'Keep answers under about 200 words unless asked for detail.';
const tiles = (kind, i) => ({ id: 'px' + i, diamondId: kind === 'note3' ? '' : 'D1', diamondName: kind === 'note3' ? 'Your account' : 'Thesis',
	headline: kind + ' headline', detail: '7 of 20 rated answers were rated down.', kind: 'steer', priority: 'low', at: Date.now(),
	steer: { id: kind + '|' + i, kind: kind.replace(/\d/, ''), level: kind === 'note3' ? 3 : 2, scope: kind === 'note3' ? '' : 'D1', name: 'Thesis', key: 'glm-5.2',
		tag: kind === 'switch' || kind === 'back' ? '' : 'long', to: kind === 'switch' || kind === 'back' ? 'kimi-k3' : '', evidence: kind === 'back' ? { note: 'n-sw1', n: 36, up: 30, down: 6 } : {},
		line: kind === 'switch' || kind === 'back' ? '' : LINE, lineKey: '', at: { t: 7, n: 20 } } });
async function seed(list) {
	await p.evaluate((list) => {
		window.__writes = 0;
		window.DaimondNotes = { list: async () => [], add: async () => { window.__writes++; return {}; }, dismiss: async () => { window.__writes++; return {}; },
			keep: async () => { window.__writes++; return {}; }, retire: async () => { window.__writes++; return {}; },
			switched: async () => { window.__writes++; return {}; } };
		const pre = (window.DaimondAccounts && DaimondAccounts.prefix && DaimondAccounts.prefix()) || '';
		localStorage.setItem(pre + 'daimond-pending', JSON.stringify(list));
		window.dispatchEvent(new StorageEvent('storage', { key: pre + 'daimond-pending' }));
		DaimondPanels.show('pending');
	}, list);
	await p.waitForTimeout(300);
}
const kinds = ['switch', 'note2', 'note3', 'review', 'back'];
const all = kinds.map((k, i) => tiles(k, i));
const measure = () => p.evaluate(() => {
	const out = { tiles: [], overflow: false, overlap: false };
	const list = document.getElementById('pending-list');
	out.overflow = list.scrollWidth > list.clientWidth + 1;
	for (const card of list.querySelectorAll('.pend-card')) {
		const bs = [...card.querySelectorAll('.pend-act')];
		const r = bs.map((b) => b.getBoundingClientRect());
		for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right - 0.5 && r[j].left < r[i].right - 0.5 && r[i].top < r[j].bottom - 0.5 && r[j].top < r[i].bottom - 0.5) out.overlap = true;
		const cs = (b) => { const c = getComputedStyle(b); return { fs: c.fontSize, h: Math.round(b.getBoundingClientRect().height), br: c.borderTopWidth, ol: c.outlineStyle, bg: c.backgroundColor, rad: c.borderTopLeftRadius }; };
		out.tiles.push({ id: card.dataset.id, labels: bs.map((b) => b.textContent), draw: bs.map(cs), cardOver: card.scrollWidth > card.clientWidth + 1,
			line: !!card.querySelector('.pend-steer-line'), lineText: (card.querySelector('.pend-steer-line') || {}).textContent || '' });
	}
	return out;
});
for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
	await p.setViewportSize(vp);
	await seed(all);
	const m = await measure();
	await shot(name);
	check(`${name}: the five tiles are drawn, each with its own presses`, JSON.stringify(m.tiles.map((t) => t.labels)) === JSON.stringify([
		['Switch', 'Dismiss'], ['Add', 'Edit', 'Dismiss'], ['Add', 'Edit', 'Dismiss'], ['Keep', 'Remove'], ['Keep', 'Switch Back']]), JSON.stringify(m.tiles.map((t) => t.labels)));
	check(`${name}: the line Add would write is in view on every note and review tile, and not on a switch or its review`, m.tiles.map((t) => t.line).join() === 'false,true,true,true,false' && m.tiles.slice(1, 4).every((t) => t.lineText === LINE));
	check(`${name}: no horizontal overflow and no overlap between presses`, !m.overflow && !m.overlap && m.tiles.every((t) => !t.cardOver));
	const draws = m.tiles.flatMap((t) => t.draw);
	const same = (k) => new Set(draws.map((d) => d[k])).size === 1;
	check(`${name}: one drawing for every press (size, border, outline, radius)`, ['fs', 'br', 'ol', 'rad'].every(same), JSON.stringify(draws[0]));
	const min = Math.min(...draws.map((d) => d.h));
	check(`${name}: tap height ${vp.width < 500 ? 'is at least 44px' : '(desktop, recorded)'}`, vp.width < 500 ? min >= 44 : true, `min ${min}px`);
	check(`${name}: no outline on a press at rest`, draws.every((d) => d.ol === 'none' || d.br === '0px' || d.br === '1px'), JSON.stringify(draws[0]));
}
await p.setViewportSize({ width: 1440, height: 900 });

// No press is inert: each one, on a page whose figures do not support the proposal, takes its tile down and writes nothing.
for (const [k, btn] of [['switch', 'Switch'], ['switch', 'Dismiss'], ['note2', 'Add'], ['note2', 'Dismiss'], ['review', 'Keep'], ['review', 'Remove'], ['back', 'Keep'], ['back', 'Switch Back']]) {
	await seed([tiles(k, 9)]);
	await p.locator('#pending-list .pend-card .pend-act', { hasText: new RegExp('^' + btn + '$') }).first().click({ force: true });
	await p.waitForTimeout(700);
	const left = await p.evaluate(() => DaimondPendingView.items().filter((x) => x.kind === 'steer').length);
	const w = await p.evaluate(() => window.__writes);
	check(`${btn} on a ${k} tile does something: the tile goes (the figures no longer make it), and nothing is written`, left === 0 && w === 0, `${left} left, ${w} written`);
}

// Edit: the line in a field, linted live; Add withheld on an empty field; Escape writes nothing.
await seed([tiles('note2', 7)]);
await p.locator('#pending-list .pend-card .pend-act', { hasText: /^Edit$/ }).first().click({ force: true });
await p.waitForSelector('.dlg .dlg-input', { timeout: 5000 });
const st = async () => p.evaluate(() => ({ v: document.querySelector('.dlg .dlg-input').value, ok: document.querySelector('.dlg .dlg-ok').disabled, err: document.querySelector('.dlg .dlg-err').textContent }));
const a = await st();
check('Edit opens the proposed line in the field, Add is available', a.v === LINE && a.ok === false && a.err === '', JSON.stringify(a));
await p.fill('.dlg .dlg-input', '');
const b = await st();
check('an empty field withholds Add and says why', b.ok === true && b.err.length > 0, JSON.stringify(b));
await p.fill('.dlg .dlg-input', 'Be brief.');
const c = await st();
check('a line it may take restores Add', c.ok === false && c.err === '', JSON.stringify(c));
await shot('edit');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
check('Escape closes the dialog and writes nothing', (await p.locator('.dlg').count()) === 0 && (await p.evaluate(() => window.__writes)) === 0);
await s.close();
console.log(bad.length ? `\nprobe_u57p_tiles: ${bad.length} check(s) failed.` : '\nprobe_u57p_tiles: all checks pass.');
process.exit(bad.length ? 1 : 0);
