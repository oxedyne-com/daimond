// gateway: none
// The Agents panel as approved (AGENT-GRID, D-20261015-10, rulings §15): a grid of squares
// above, and below ONLY the agents a person pressed.
//
//   - three dispatched workers are three squares, and NO tile opens on its own;
//   - a question parked for one of them turns ITS square amber (.wait) and still opens nothing;
//   - a press pins that tile below (with Allow / Deny), a second press pins another;
//   - the close cross unpins it, and its square loses the pin mark.
//
// Desktop (1920x961) or phone (393x793, --phone: the pins are a sideways sheet with a dot each).
// Failing-first: on d26e2aaa (before the grid) every tile opens by itself and there are no squares.
//
//   node dev/verify_agentgrid.mjs [--phone]
import { open, shot, errors } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const phone = process.argv.includes('--phone');
const tag = (phone ? 'phone' : 'desk') + '-' + (process.env.DAIMOND_BROWSER || 'chromium');
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// Under WebKit a phone is said by its UA string (the harness refuses isMobile there).
const WK = /webkit/i.test(process.env.DAIMOND_BROWSER || '');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const s = await open({ name: 'agentgrid', viewport: phone ? { width: 393, height: 793 } : { width: 1920, height: 961 },
	...(phone ? (WK ? { ua: IPHONE_UA, touch: true } : { isMobile: true }) : {}) });
const { page } = s;
if (phone) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }

const look = () => page.evaluate(() => ({
	squares: [...document.querySelectorAll('#agents-grid .agsq:not(.o)')].map((b) => ({
		id: b.dataset.run, st: [...b.classList].filter((c) => /^(run|que|wait|fail|done|stop)$/.test(c))[0] || '',
		pin: b.classList.contains('pin') })),
	tiles: [...document.querySelectorAll('#agents-list .acard')].map((c) => ({ id: c.dataset.run || '',
		wait: !!c.querySelector('.pill.wait'), allow: !!c.querySelector('.abtn-go'), x: !!c.querySelector('.acard-x') })),
	dots: document.querySelectorAll('#agents-dots i').length,
}));

await page.evaluate(() => document.getElementById('new-diamond-btn').click());
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Grid Test');
await page.click('.dlg-ok');
await page.waitForTimeout(1000);
await page.fill('#chat-input', '@tools ' + ['alpha', 'beta', 'gamma']
	.map((n) => `spawn_agent {"name":"${n}","task":"do ${n}"}`).join(' ;; '));
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
if (phone) {
	// A person reaches the panel by the bottom bar's Agents chip (spawn_agent raises it as well).
	await page.evaluate(() => { if (document.body.dataset.mpanel !== 'agents') {
		const c = document.querySelector('#panel-tags .ptag[data-panel="agents"]');
		if (c) { c.scrollIntoView({ inline: 'center', block: 'nearest' }); c.click(); } } });
} else await page.evaluate(() => window.DaimondPanels.show('agents'));
await page.waitForTimeout(6500);
if (phone) console.log('mpanel:', await page.evaluate(() => document.body.dataset.mpanel));

let v = await look();
console.log('dispatched:', JSON.stringify(v));
check('THREE WORKERS ARE THREE SQUARES', v.squares.length === 3, `${v.squares.length} squares`);
check('AND NO TILE OPENED ON ITS OWN', v.tiles.length === 0, `${v.tiles.length} tiles below`);
await shot(s, `agentgrid-1-grid-${tag}`);

const first = v.squares[0] && v.squares[0].id;
await page.evaluate((id) => window.DaimondPendingView.add({ kind: 'consent', headline: 'Run typst?',
	detail: 'Wants to run ~/.local/bin/typst, outside the workspace', priority: 'high', runId: id }), first || 'none');
await page.waitForTimeout(800);
v = await look();
const sq = v.squares.find((x) => x.id === first) || {};
check('A PARKED QUESTION TURNS ITS SQUARE AMBER', sq.st === 'wait', `square ${first}: ${sq.st || '(none)'}`);
await shot(s, `agentgrid-1b-wait-${tag}`);
if (phone) {
	// On a phone a high-priority question raises the Pending sheet over the chat (the app's own
	// rule, not the panel's): a person closes it and goes back to Agents by the bottom bar.
	await page.evaluate(() => { const x = document.getElementById('msheet-close'); if (x) x.click(); });
	await page.waitForTimeout(300);
	await page.evaluate(() => { const c = document.querySelector('#panel-tags .ptag[data-panel="agents"]');
		if (c) { c.scrollIntoView({ inline: 'center', block: 'nearest' }); c.click(); } });
	await page.waitForTimeout(400);
}
check('AND STILL OPENS NOTHING BELOW', v.tiles.length === 0, `${v.tiles.length} tiles`);

if (first) await page.click(`#agents-grid .agsq[data-run="${first}"]`, { force: true });
await page.waitForTimeout(400);
v = await look();
check('A PRESS PINS THAT TILE', v.tiles.length === 1 && v.tiles[0].id === first, JSON.stringify(v.tiles));
check('the pinned tile says waiting, offers Allow, and has a close cross',
	!!(v.tiles[0] && v.tiles[0].wait && v.tiles[0].allow && v.tiles[0].x), JSON.stringify(v.tiles[0] || {}));
check('its square carries the pin mark', !!(v.squares.find((x) => x.id === first) || {}).pin);

const second = v.squares[1] && v.squares[1].id;
if (second) await page.click(`#agents-grid .agsq[data-run="${second}"]`, { force: true });
await page.waitForTimeout(400);
v = await look();
check('A SECOND PRESS PINS A SECOND TILE', v.tiles.length === 2, `${v.tiles.length} tiles`);
if (phone) {
	check('the phone sheet shows a dot per tile', v.dots === 2, `${v.dots} dots`);
	console.log('geom:', await page.evaluate(() => { const p = document.getElementById('panel-agents'), q = document.getElementById('agents-sheet'); const cs = getComputedStyle(p); return [cs.paddingLeft, cs.paddingRight, JSON.stringify(q.getBoundingClientRect())].join(' '); }));
}
// ── THE BUDGET (think pass §3): every run carries its turn's cap; the tile reads "$x of $cap" ──
const meter = await page.evaluate((id) => {
	const run = window.DaimondWorkers.runs.find((r) => String(r.id) === id) || {};
	const m = document.querySelector(`#agents-list .acard[data-run="${id}"] .meter`);
	// Where the provider stated no cost the tile's tag is the table's estimate, and the meter reads that same figure.
	const tagN = parseFloat(((document.querySelector(`#agents-list .acard[data-run="${id}"] .tagb-n`) || {}).textContent || '').replace(/[^0-9.]/g, '')) || 0;
	const spent = (run.costUsd || 0) > 0 ? Math.max(0, run.costUsd - (run.priorCost || 0)) : tagN;
	const want = window.DaimondI18n.billed(spent) + ' of ' + window.DaimondI18n.billed(run.capUsd || 0, 'whole');
	return { cap: run.capUsd, text: m ? m.textContent : null, want, tagN, bar: m && m.querySelector('.bar b') ? m.querySelector('.bar b').style.width : null };
}, second || 'none');
check('A TILE\'S METER READS "$x OF $cap" AGAINST THE CAP THE RUN WAS SENT WITH',
	meter.cap === 5 && meter.text === meter.want && /%$/.test(meter.bar || ''), JSON.stringify(meter));
check('...AND ITS $x IS THE FIGURE ON THE TILE\'S OWN PRICE TAG, NOT $0 BESIDE IT',
	meter.tagN > 0 && !/^\$0 /.test(meter.text || ''), JSON.stringify(meter));
check('...AND A WHOLE CAP READS "$5", NOT "$5.00", AS THE MOCK WRITES IT',
	/ of \$5$/.test(meter.text || ''), JSON.stringify(meter.text));
// A running square fills bottom-up by its turn's spend over its cap (mock .sq.run --f).
const fill = await page.evaluate(async (id) => {
	const W = window.DaimondWorkers, run = W.runs.find((r) => String(r.id) === id);
	const was = { status: run.status, costUsd: run.costUsd, priorCost: run.priorCost, app: run.app };
	Object.assign(run, { status: 'running', costUsd: 2, priorCost: 0, app: null });
	W.render(); await new Promise((r) => requestAnimationFrame(() => r()));
	const sq = document.querySelector(`#agents-grid .agsq[data-run="${id}"]`);
	const out = { f: sq ? sq.style.getPropertyValue('--f') : null, bg: sq ? getComputedStyle(sq).backgroundImage : '' };
	Object.assign(run, was); W.render();
	return out;
}, second || 'none');
check('A RUNNING SQUARE FILLS BOTTOM-UP BY ITS SPEND OVER ITS CAP', fill.f === '40%' && /linear-gradient/.test(fill.bg), JSON.stringify(fill));
await page.evaluate(() => { const l = document.getElementById('agents-list'); if (l) l.scrollLeft = 0; });
await page.waitForTimeout(300);
await shot(s, `agentgrid-2-pinned-${tag}`);

await page.click(`#agents-list .acard[data-run="${first}"] .acard-x`, { force: true }).catch(() => {});
await page.waitForTimeout(400);
v = await look();
check('THE CLOSE CROSS UNPINS IT', v.tiles.length === 1 && v.tiles[0].id === second, JSON.stringify(v.tiles));
check('and its square loses the pin mark', !(v.squares.find((x) => x.id === first) || {}).pin);

// ── THE LENS (think pass §2): one grid, four questions; the squares do not move ──
const lensLook = () => page.evaluate(() => {
	const g = document.getElementById('agents-grid');
	return { cls: [...g.classList].filter((c) => c.startsWith('lens-')),
		ids: [...g.querySelectorAll('.agsq:not(.o)')].map((b) => b.dataset.run).join(','),
		k: [...g.querySelectorAll('.agsq:not(.o)')].map((b) => b.style.getPropertyValue('--k')),
		pressed: [...document.querySelectorAll('#agents-lens [data-lens]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.lens) };
});
// Where the lens sits (mock): beside the fuel figure on the desk, on a row of its own on a phone.
const lensRow = await page.evaluate(() => {
	const f = document.querySelector('#agents-fuel .spendh').getBoundingClientRect(), l = document.getElementById('agents-lens').getBoundingClientRect();
	return { below: l.top >= f.bottom - 1, left: Math.round(l.left - f.left), fb: Math.round(f.bottom), lt: Math.round(l.top) };
});
check(phone ? 'ON A PHONE THE LENS BUTTONS TAKE A ROW OF THEIR OWN UNDER THE FUEL FIGURE' : 'ON THE DESK THE LENS SITS BESIDE THE FUEL FIGURE',
	phone ? (lensRow.below && Math.abs(lensRow.left) <= 1) : !lensRow.below, JSON.stringify(lensRow));
const before = await lensLook();
check('THE LENS SWITCH READS State | Cost | Rating | Device, State pressed',
	before.pressed.join() === 'state' && before.cls.join() === 'lens-state'
	&& await page.evaluate(() => [...document.querySelectorAll('#agents-lens [data-lens]')].map((b) => b.textContent).join('|')) === 'State|Cost|Rating|Device',
	JSON.stringify(before.pressed));
await page.click('#agents-lens [data-lens="cost"]');
await page.waitForTimeout(200);
const cost = await lensLook();
check('THE COST LENS RECOLOURS EVERY SQUARE AND MOVES NONE',
	cost.cls.join() === 'lens-cost' && cost.ids === before.ids && cost.k.every((k) => /color-mix/.test(k)),
	JSON.stringify(cost.k.slice(0, 2)));
await page.click('#agents-lens [data-lens="device"]');
await page.waitForTimeout(200);
const dev = await lensLook();
check('the Device lens gives this device one colour for all three',
	dev.k.length === 3 && new Set(dev.k).size === 1 && /hsl/.test(dev.k[0]), JSON.stringify(dev.k));
await shot(s, `agentgrid-3-lens-device-${tag}`);
await page.click('#agents-lens [data-lens="state"]');
await page.waitForTimeout(200);
check('and State puts the state colours back', (await lensLook()).k.every((k) => !k));

// ── THE WORKING SET (think pass): a finished square fades over 24 h, then leaves the grid ──
const day = await page.evaluate(async () => {
	const W = window.DaimondWorkers, H = 3600e3, done = W.runs.filter((r) => r.status === 'done');
	const stamped = done.every((r) => r.endedAt > 0);
	const keep = done.map((r) => r.endedAt);
	done[0].endedAt = Date.now() - 25 * H; done[1].endedAt = Date.now() - 2 * H;
	W.render(); await new Promise((r) => requestAnimationFrame(() => r()));
	const sq = (r) => document.querySelector(`#agents-grid .agsq[data-run="${r.id}"]`);
	const out = { stamped, gone: !sq(done[0]), fade: sq(done[1]) ? sq(done[1]).style.getPropertyValue('--fade') : null };
	done.forEach((r, i) => { r.endedAt = keep[i]; }); W.render();
	return out;
});
check('A FINISHED SQUARE FADES BY ITS AGE AND LEAVES THE GRID AFTER A DAY',
	day.stamped && day.gone && day.fade === '0.8', JSON.stringify(day));

// ── THE FUEL FIGURE (think pass §2): what the last hour cost, from the ledger ──
const fuel = await page.evaluate(() => {
	const f = document.getElementById('agents-spendh'), lab = document.querySelector('#agents-fuel .spendh .lab');
	const want = window.DaimondI18n.billed(window.DaimondAgentGrid.lastHourUsd(window.DaimondLedger.entries(), Date.now()));
	return { fig: f ? f.textContent : null, lab: lab ? lab.textContent : null, want,
		first: (document.getElementById('agents-fuel').firstElementChild || {}).className || '' };
});
check('"$x LAST HOUR" HEADS THE FUEL ROW AND MATCHES THE LEDGER',
	fuel.fig === fuel.want && fuel.lab === 'last hour' && /spendh/.test(fuel.first), JSON.stringify(fuel));

// ── NESTED ORCHESTRATORS (mock 'o'): a later turn that sends work opens its group with its own diamond ──
if (phone) { await page.evaluate(() => { const c = document.querySelector('#panel-tags .ptag[data-panel="ai"]'); if (c) c.click(); }); await page.waitForTimeout(400); }
await page.fill('#chat-input', '@tools spawn_agent {"name":"delta","task":"do delta"}');
await page.keyboard.press('Enter');
await page.waitForTimeout(6500);
if (phone) await page.evaluate(() => { if (document.body.dataset.mpanel !== 'agents') {
	const c = document.querySelector('#panel-tags .ptag[data-panel="agents"]');
	if (c) { c.scrollIntoView({ inline: 'center', block: 'nearest' }); c.click(); } } });
else await page.evaluate(() => window.DaimondPanels.show('agents'));
await page.waitForTimeout(400);
const nest = await page.evaluate(() => {
	const row = document.querySelector('#agents-grid .agrow');
	return row ? [...row.children].map((b) => b.classList.contains('o') ? 'o' : (b.dataset.run || '?')).join(' ') : '';
});
check('A SECOND TURN\'S WORK OPENS WITH ITS OWN DIAMOND AFTER THE FIRST TURN\'S',
	/^o w1 w2 w3 o w4$/.test(nest), nest);
await shot(s, `agentgrid-4-nested-${tag}`);

// ── THE THREAD DIAMOND IS PRESSABLE: it opens the conversation the row's work came from ──
await page.evaluate(() => document.getElementById('new-session-btn').click());
await page.waitForTimeout(800);
const away = await page.evaluate(() => (window.DaimondDiamond.current() || {}).name || null);
if (phone) await page.evaluate(() => { const c = document.querySelector('#panel-tags .ptag[data-panel="agents"]');
	if (c) { c.scrollIntoView({ inline: 'center', block: 'nearest' }); c.click(); } });
else await page.evaluate(() => window.DaimondPanels.show('agents'));
await page.waitForTimeout(400);
const diamonds = await page.evaluate(() => [...document.querySelectorAll('#agents-grid .agrow:first-child .agsq.o')]
	.map((o) => ({ tag: o.tagName, label: o.getAttribute('aria-label') || '' })));
await page.click('#agents-grid .agrow:first-child .agsq.o', { force: true });
await page.waitForTimeout(900);
const opened = await page.evaluate(() => ({ name: (window.DaimondDiamond.current() || {}).name || null,
	mpanel: document.body.dataset.mpanel || '' }));
check('EVERY DIAMOND IN THE ROW IS A BUTTON NAMING THE THREAD IT OPENS',
	diamonds.length === 2 && diamonds.every((d) => d.tag === 'BUTTON' && /^Open Grid Test$/.test(d.label)), JSON.stringify(diamonds));
check('PRESSING THE THREAD DIAMOND OPENS THAT DIAMOND\'S CONVERSATION',
	away !== 'Grid Test' && opened.name === 'Grid Test' && (!phone || opened.mpanel === 'ai'), JSON.stringify({ away, opened }));

// The gateway's calls answer 502 with no gateway, and 401 or 402 with one (the harness signs no one in, and buys no sync): none is the grid's.
const errs = errors(s).filter((e) => !/502|Bad Gateway/.test(e) && !/status of 40[12] \((Unauthorized|Payment Required)\)/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
await s.close();
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach((x) => console.log('  FAILED: ' + x)); process.exit(1); }
