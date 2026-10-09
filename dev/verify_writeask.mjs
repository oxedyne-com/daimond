// gateway: none
// verify_writeask.mjs — a write is asked for on first use (Workspace round 2, E2 + E3).
//
// A model's write outside what its Diamond may change used to be refused with a line
// telling the user to open a panel and mark the folder. Now the engine asks in the
// moment, through the consent door: "Let <Diamond> change <narrowest folder>?", the
// path shown, Allow / Not now.
//
// What is pinned, through a real daimon turn (`steer_crystal`) against this world's
// mock provider, with the bounds the page itself would hand the turn
// (`DaimondDiamond.bounds`):
//
//   1. A REFUSED WRITE IS A CARD (`data-ask="place"`) naming the narrowest folder
//      holding the file, not its parent and not the file.
//   2. ALLOW WRITES IT: the file lands, and the yes is a mark in force here (the
//      same `holds` row the ◈ writes).
//   3. AND IS NEVER ASKED AGAIN UNDER IT: the next turn writes deeper under that
//      folder with no card.
//   4. NOT NOW REFUSES: the file is not written and the daimon reads why.
//   5. AND ASKS AGAIN NEXT TIME: a no is not remembered.
//   6. A MARK WAITING ON THIS DEVICE IS ASKED AS ITSELF: "… here too?", with the
//      device it was allowed on.
//   7. A TOOLCHAIN ANSWERED "NOT NOW" IS A GHOST (E3): the Toolchains row draws it
//      dashed, one press from granted, and the press grants it.
//
// Needs a world for the mock provider (`eval "$(bash dev/world.sh N --env)"`).
//
//	node dev/verify_writeask.mjs
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const OTHER = '0123456789abcdef';	// a device that is not this one
// Signed in: a mark is recorded on this device only while the identity is unlocked.
const s = await open({ name: 'writeask', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

const ids = await p.evaluate(async () => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	window.__mod = mod;
	const app = DaimondCore.diamondApp();
	const ids = {};
	for (const [k, n] of [['yes', 'Write ask yes'], ['no', 'Write ask no'],
		['wait', 'Write ask waiting'], ['kit', 'Write ask kit']])
	{
		ids[k] = await app.create_diamond(n);
	}
	await DaimondCore.loadDiamonds();
	return ids;
});

// One daimon turn with the page's own bounds, left running so a card can be answered.
const start = (id, tool, args, attached) => p.evaluate(async (a) => {
	window.__seen = [];
	const b = await DaimondDiamond.bounds(a.id);
	if (a.attached) b.attached = a.attached;
	const app = new window.__mod.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
	window.__turn = app.steer_crystal(a.id, '@tool ' + a.tool + ' ' + JSON.stringify(a.args),
		JSON.stringify(b.attached || []), JSON.stringify(b.read_only || []),
		JSON.stringify(b.toolkits || []), [],
		(ev) => { if (ev.type === 'tool_result') window.__seen.push(String(ev.content || '')); },
		JSON.stringify(b.unconfirmed || []))
		.then(() => 'done', (e) => 'threw ' + String(e && e.message || e));
	return true;
}, { id, tool, args, attached, mock: MOCK });
const write = (id, path) => start(id, 'file_write', { path, content: 'written by ' + id });
const finish = () => p.evaluate(async () => ({ end: await window.__turn, seen: window.__seen }));
const card = (ask, ms = 15000) => p.waitForSelector(`.modal.dlg[data-ask="${ask}"]`, { timeout: ms })
	.then(() => true, () => false);
const cardText = (ask) => p.evaluate((a) => {
	const c = [...document.querySelectorAll(`.modal.dlg[data-ask="${a}"] .dlg-card`)].pop();
	return c ? c.textContent.replace(/\s+/g, ' ').trim() : '';
}, ask);
const answer = async (ask, yes) => {
	await p.waitForSelector('.dlg-card .dlg-ok:not([disabled])', { timeout: 3000 }).catch(() => {});
	await p.evaluate((a) => {
		const c = [...document.querySelectorAll(`.modal.dlg[data-ask="${a.ask}"] .dlg-card`)].pop();
		c.querySelector(a.yes ? '.dlg-ok' : '.dlg-cancel').click();
	}, { ask, yes });
};
const gone = (ask) => p.waitForSelector(`.modal.dlg[data-ask="${ask}"]`, { state: 'detached', timeout: 5000 })
	.catch(() => {});
const read = (path) => p.evaluate(async (path) => {
	try {
		const v = await window.__mod.read_file(path);
		return typeof v === 'string' ? v : new TextDecoder().decode(v);
	} catch (e) { return null; }
}, path);
const bounds = (id) => p.evaluate(async (id) => {
	await DaimondCore.loadDiamonds();
	return await DaimondDiamond.bounds(id);
}, id);
const refused = (r) => r.seen.some((t) => /^Refused/.test(t));

// ── Allow ───────────────────────────────────────────────────────────────

await write(ids.yes, 'docs/plans/a.md');
const a1 = await card('place');
const t1 = a1 ? await cardText('place') : '';
check('1. a refused write is a card naming the narrowest folder',
	a1 && /Let Write ask yes change docs\/plans\?/.test(t1) && t1.includes('docs/plans/a.md'),
	t1.slice(0, 160));
if (a1) await answer('place', true);
const r1 = await finish();
const f1 = await read('docs/plans/a.md');
check('2. Allow writes it', f1 === 'written by ' + ids.yes && !refused(r1),
	JSON.stringify(f1) + ' | ' + (r1.seen[0] || '').slice(0, 160) + ' | ' + r1.end);
const b1 = await bounds(ids.yes);
check('   and the yes is a mark in force here on that folder',
	(b1.attached || []).includes('docs/plans'), JSON.stringify(b1.attached));

await write(ids.yes, 'docs/plans/deeper/b.md');
const a2 = await card('place', 4000);
if (a2) await answer('place', false);
const r2 = await finish();
const f2 = await read('docs/plans/deeper/b.md');
check('3. the next write under it is not asked, and lands',
	!a2 && f2 === 'written by ' + ids.yes && !refused(r2),
	'asked=' + a2 + ' ' + JSON.stringify(f2) + ' | ' + (r2.seen[0] || '').slice(0, 160));

// ── Not now ─────────────────────────────────────────────────────────────

await write(ids.no, 'drafts/x.md');
const a3 = await card('place');
if (a3) await answer('place', false);
const r3 = await finish();
const f3 = await read('drafts/x.md');
check('4. Not now refuses: nothing written and the daimon reads why',
	a3 && f3 === null && r3.seen.some((t) => /not now/.test(t)),
	'asked=' + a3 + ' ' + JSON.stringify(f3) + ' | ' + (r3.seen[0] || '').slice(0, 160));
const b3 = await bounds(ids.no);
check('   and no mark is made', !(b3.attached || []).includes('drafts'), JSON.stringify(b3.attached));
await gone('place');

await write(ids.no, 'drafts/x.md');
const a4 = await card('place');
if (a4) await answer('place', false);
await finish();
check('5. and the next write asks again', a4);
await gone('place');

// ── A mark waiting on this device ───────────────────────────────────────

const made = await p.evaluate(async (a) => {
	try {
		await DaimondCore.diamondApp().add_link(a.id, 'diamond:' + a.id,
			'dir:[browser:@' + a.dev + ']notes', 'holds', '', 'user');
		await DaimondCore.loadDiamonds();
		return 'ok';
	} catch (e) { return 'threw ' + String(e && e.message || e); }
}, { id: ids.wait, dev: OTHER });
const b5 = await bounds(ids.wait);
check('   (a mark made on another device waits here)',
	made === 'ok' && (b5.unconfirmed || []).includes('notes'), made + ' ' + JSON.stringify(b5.unconfirmed));
await write(ids.wait, 'notes/deep/n.md');
const a5 = await card('place');
const t5 = a5 ? await cardText('place') : '';
check('6. a write under a waiting mark asks for that mark, here too, with its device',
	a5 && /Let Write ask waiting change notes here too\?/.test(t5) && /Allowed on /.test(t5),
	t5.slice(0, 200));
if (a5) await answer('place', true);
const r5 = await finish();
const f5 = await read('notes/deep/n.md');
const b6 = await bounds(ids.wait);
check('   and Allow brings the mark into force and writes',
	f5 === 'written by ' + ids.wait && (b6.attached || []).includes('notes'),
	JSON.stringify(f5) + ' ' + JSON.stringify(b6.attached) + ' | ' + (r5.seen[0] || '').slice(0, 120));
await gone('place');

// ── E3: a toolchain answered "Not now" is a ghost ───────────────────────

await p.evaluate(() => {
	window.DaimondHand = {
		hasHand: () => true,
		status:  async () => JSON.stringify({ paired: true, link: 1, transport: 'machine',
			machine: 'test', os: 'linux', root: '/home/u/ws', home: '/home/u',
			caps: ['fence:linux', 'root:/home/u/ws', 'home:/home/u', 'meter:deletes'] }),
		run:     async () => JSON.stringify({ t: 'exec_result', exit: 0, stdout: '', stderr: '',
			out_bytes: 0, err_bytes: 0, timed_out: false }),
		runs: async () => '[]', held: async () => '{}', signal: async () => '{}',
	};
});
await start(ids.kit, 'run', { argv: ['cargo', '--version'], cwd: 'code' }, ['code']);
const a7 = await card('toolkit');
if (a7) await answer('toolkit', false);
await finish();
await p.evaluate(() => { delete window.DaimondHand; });
await p.evaluate((name) => {
	const b = [...document.querySelectorAll('.diamond-box')].find((x) => x.textContent.includes(name));
	if (b) b.click();
}, 'Write ask kit');
await sleep(1200);
await p.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
await sleep(1200);
// The ghost is a row under the focus section's Can change (E3 on ws2 P2): kind
// `kitghost` until granted, then an ordinary `kit` row.
const chip = () => p.evaluate(() => {
	const c = document.querySelector('#panel-work .files-focus .r[data-kit="rust"]');
	const dm = c && c.querySelector('.dm');
	return c ? { text: c.textContent.trim(), kind: c.dataset.kind, title: dm ? dm.title : '',
		ghost: !!(dm && dm.classList.contains('ghost')) } : null;
});
const c7 = await chip();
check('7. a toolchain answered "Not now" is drawn as a ghost',
	a7 && !!c7 && c7.kind === 'kitghost' && c7.ghost && /asked for and not granted/.test(c7.title),
	'asked=' + a7 + ' ' + JSON.stringify(c7));
await p.evaluate(() => {
	const b = document.querySelector('#panel-work .files-focus .r[data-kit="rust"] button.dm');
	if (b) b.click();
});
await sleep(1500);
const c8 = await chip();
const b8 = await bounds(ids.kit);
check('   and one press grants it, and the ghost goes',
	!!c8 && c8.kind === 'kit' && !c8.ghost && (b8.toolkits || []).includes('rust'),
	JSON.stringify(c8) + ' ' + JSON.stringify(b8.toolkits));

await p.evaluate(async (ids) => {
	for (const id of Object.values(ids)) {
		try { await DaimondCore.diamondApp().delete_diamond(id); } catch (e) { /* left */ }
	}
}, ids);
await s.close();
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
