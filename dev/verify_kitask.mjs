// gateway: none
// verify_kitask.mjs — a toolchain is asked for on first use (Workspace round 2, E1).
//
// A Diamond with no Rust toolkit used to run `cargo` inside a fence that had no
// ~/.cargo in it, so the command failed "not found" and the daimon told the user
// to open a panel. Now the engine asks before the command runs: a card naming the
// Diamond and the toolkit, the command shown as it will run, Allow / Not now.
//
// What is pinned, through a real daimon turn (`steer_crystal`) against this
// world's mock provider and a stand-in hand that writes down what it is sent:
//
//   1. THE CARD APPEARS, as the toolkit question (`data-ask="toolkit"`), before the
//      hand is asked anything.
//   2. ALLOW RUNS IT WITH THE TOOLKIT: the hand receives the exec with "rust" in
//      its toolkits, and the yes is written to the Diamond.
//   3. A SECOND RUN DOES NOT ASK: the next turn, given the Diamond's toolkits as
//      the page gives them, runs with no card.
//   4. NOT NOW REFUSES: nothing is sent to the hand, the daimon reads the refusal,
//      and the Diamond holds no grant.
//   5. AND ASKS AGAIN NEXT TIME: a no is not remembered beyond the command.
//   6. A WRAPPER IS ASKED ABOUT AFTER THE FACT: `./build.sh` is one program to the
//      question before the run, so the shell's own "cargo: command not found"
//      raises the same card, and a yes tells the daimon to run it again.
//   7. A YES THAT COULD NOT BE SAVED SAYS SO: the command still runs with the
//      toolkit, and a toast names the failure rather than letting the user believe
//      the grant was kept.
//
// Needs a world for the mock provider (`eval "$(bash dev/world.sh N --env)"`).
//
//	node dev/verify_kitask.mjs
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const s = await open({ name: 'kitask', signIn: false, connect: false });
const p = s.page;
await p.waitForTimeout(1500);

const ids = await p.evaluate(async () => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	window.__mod = mod;
	window.__sent = [];
	window.DaimondHand = {
		hasHand: () => true,
		status:  async () => JSON.stringify({ paired: true, link: 1, transport: 'machine',
			machine: 'test', os: 'linux', root: '/home/u/ws', home: '/home/u',
			caps: ['fence:linux', 'root:/home/u/ws', 'home:/home/u', 'meter:deletes'] }),
		run:     async (spec) => {
			window.__sent.push(JSON.parse(spec));
			return JSON.stringify(window.__reply || { t: 'exec_result', exit: 0,
				stdout: 'cargo 1.90.0', stderr: '', out_bytes: 12, err_bytes: 0, timed_out: false });
		},
		runs: async () => '[]', held: async () => '{}', signal: async () => '{}',
	};
	const a = await DaimondCore.diamondApp().create_diamond('Kit ask yes');
	const b = await DaimondCore.diamondApp().create_diamond('Kit ask no');
	const c = await DaimondCore.diamondApp().create_diamond('Kit ask wrapper');
	const d = await DaimondCore.diamondApp().create_diamond('Kit ask unsaved');
	await DaimondCore.loadDiamonds();
	return { yes: a, no: b, wrap: c, unsaved: d };
});

// One daimon turn, started and left running so the card can be answered from here.
const start = (id, argv = ['cargo', '--version']) => p.evaluate(async (a) => {
	window.__sent = [];
	window.__seen = [];
	let kits = '[]';
	try { kits = JSON.stringify((await DaimondDiamond.bounds(a.id)).toolkits || []); } catch (e) { /* none */ }
	const app = new window.__mod.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
	window.__turn = app.steer_crystal(a.id,
		'@tool run ' + JSON.stringify({ argv: a.argv, cwd: 'code' }),
		JSON.stringify(['code']), '[]', kits, [],
		(ev) => { if (ev.type === 'tool_result') window.__seen.push(String(ev.content || '')); })
		.then(() => 'done', (e) => 'threw ' + String(e && e.message || e));
	return kits;
}, { id, argv, mock: MOCK });
const finish = () => p.evaluate(async () => ({
	end: await window.__turn, sent: window.__sent, seen: window.__seen }));
const card = () => p.waitForSelector('.modal.dlg[data-ask="toolkit"]', { timeout: 15000 })
	.then(() => true, () => false);
const answer = async (yes) => {
	await p.waitForSelector('.dlg-card .dlg-ok:not([disabled])', { timeout: 3000 }).catch(() => {});
	await p.evaluate((y) => {
		const c = [...document.querySelectorAll('.modal.dlg[data-ask="toolkit"] .dlg-card')].pop();
		c.querySelector(y ? '.dlg-ok' : '.dlg-cancel').click();
	}, yes);
};
const held = (id) => p.evaluate(async (id) => {
	await DaimondCore.loadDiamonds();
	try { return (await DaimondDiamond.bounds(id)).toolkits || []; } catch (e) { return ['?' + e]; }
}, id);
const execs = (r) => r.sent.filter((x) => x.t === 'exec');

// ── Allow ───────────────────────────────────────────────────────────────

await start(ids.yes);
const asked1 = await card();
check('1. the toolkit card appears before the command runs', asked1);
const before = await p.evaluate(() => window.__sent.filter((x) => x.t === 'exec').length);
check('   and the hand has been sent nothing while it waits', before === 0, 'sent ' + before);
if (asked1) await answer(true);
const r1 = await finish();
const x1 = execs(r1);
check('2. Allow runs it, with the rust toolkit sent to the hand',
	x1.length === 1 && (x1[0].toolkits || []).includes('rust'),
	JSON.stringify(x1.map((x) => ({ argv: x.argv, toolkits: x.toolkits }))) + ' | ' + r1.end);
const kits1 = await held(ids.yes);
check('   and the yes is written to the Diamond', kits1.includes('rust'), JSON.stringify(kits1));

await start(ids.yes);
const asked2 = await p.waitForSelector('.modal.dlg[data-ask="toolkit"]', { timeout: 4000 })
	.then(() => true, () => false);
const r2 = await finish();
const x2 = execs(r2);
check('3. a second run does not ask, and runs with rust',
	!asked2 && x2.length === 1 && (x2[0].toolkits || []).includes('rust'),
	'asked=' + asked2 + ' ' + JSON.stringify(x2.map((x) => x.toolkits)) + ' | ' + r2.end);

// ── Not now ─────────────────────────────────────────────────────────────

await start(ids.no);
const asked3 = await card();
if (asked3) await answer(false);
const r3 = await finish();
check('4. Not now refuses: nothing reaches the hand and the daimon reads why',
	asked3 && execs(r3).length === 0 && r3.seen.some((t) => /not now/.test(t)),
	'asked=' + asked3 + ' sent=' + execs(r3).length + ' | ' + (r3.seen[0] || '').slice(0, 160));
const kits3 = await held(ids.no);
check('   and the Diamond holds no grant', !kits3.includes('rust'), JSON.stringify(kits3));

await start(ids.no);
const asked4 = await card();
if (asked4) await answer(false);
await finish();
check('5. and the next command asks again', asked4);

// ── After the fact ──────────────────────────────────────────────────────

await p.evaluate(() => { window.__reply = { t: 'exec_result', exit: 127, stdout: '',
	stderr: './build.sh: line 2: cargo: command not found', out_bytes: 0, err_bytes: 44,
	timed_out: false }; });
await start(ids.wrap, ['./build.sh']);
const asked6 = await card();
if (asked6) await answer(true);
const r6 = await finish();
await p.evaluate(() => { window.__reply = null; });
check('6. a wrapper\'s "not found" raises the card after the run, and a yes says run it again',
	asked6 && execs(r6).length === 1 && r6.seen.some((t) => /run '\.\/build\.sh' again/.test(t)),
	'asked=' + asked6 + ' sent=' + execs(r6).length + ' | ' + (r6.seen[0] || '').slice(-200));
const kits6 = await held(ids.wrap);
check('   and that yes is written to the Diamond', kits6.includes('rust'), JSON.stringify(kits6));

// ── A yes that could not be saved ───────────────────────────────────────

await p.evaluate(() => {
	document.querySelectorAll('.daimond-toast').forEach((t) => t.remove());
	DaimondCore.diamondApp().set_toolkits = () => Promise.reject(new Error('the store is full'));
});
await start(ids.unsaved);
const asked7 = await card();
if (asked7) await answer(true);
const r7 = await finish();
const toast7 = await p.evaluate(() => [...document.querySelectorAll('.daimond-toast')]
	.map((t) => t.textContent).join(' | '));
await p.evaluate(() => { delete DaimondCore.diamondApp().set_toolkits; });
const x7 = execs(r7);
check('7. a yes that could not be saved still runs it with rust',
	asked7 && x7.length === 1 && (x7[0].toolkits || []).includes('rust'),
	'asked=' + asked7 + ' ' + JSON.stringify(x7.map((x) => x.toolkits)));
check('   and the failure is shown, not swallowed',
	/this turn only/.test(toast7) && /store is full/.test(toast7), toast7.slice(0, 200));

await p.evaluate(async (ids) => {
	for (const id of Object.values(ids)) {
		try { await DaimondCore.diamondApp().delete_diamond(id); } catch (e) { /* left */ }
	}
}, ids);
await s.close();
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
