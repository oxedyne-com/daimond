// verify_q6.mjs — the Optimiser's repair leaves a person's pause alone, and a pause's refusal
// is said as a pause (R3 QA, `~/usr/code/ai/claude/specs/daimond_r3_qa_optimiser_20260924.md`).
//
//   Q6-1  `releaseSeededSelf` ran once on every device new to an account -- its flag is per
//         device and never travels -- and took back a pause the person had made on another
//         device, one past its stamp, which then won on every device. It now runs only on a
//         device that ran the old seed (`DEFAULTS_KEY` set at load), and never over a hold
//         that is a person's, however it arrived.
//   Q6-2  ticking a proposal dropped its tile before the steer that a pause then refused.
//   Q6-3  that refusal, and a typed turn's, was drawn as a fault with "Report this".
//
// Sections, each on a fresh profile (world app and mock; no gateway):
//
//   N  the person pauses the Optimiser's light; a new device boots with that record.
//   D  the same, by the Diamonds branch light.
//   B  a device that DID run the old seed (its `self` held by the seed, the repair still owed)
//      pulls a pause of the Diamonds branch made elsewhere: B1 pressed on this build, B2 as a
//      build before this one recorded it. The repair must leave `self` held.
//   P  a proposal ticked while the Optimiser is paused keeps its tile and says why; ticked
//      again after play, it steers and the tile goes.
//   R  a turn a pause refuses -- typed into the paused Optimiser, and into a paused chat -- is
//      drawn as a note: no danger colour, no "Report this", no support report armed, and a
//      reload draws it the same way.
//
//   eval "$(bash dev/world.sh N --up)"
//   node dev/verify_q6.mjs [N] [D] [B] [P] [R]
import { open, connectMock, scratch, mockLog, newChat } from './harness.mjs';

const want = process.argv.slice(2);
const on = (k) => !want.length || want.includes(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [], bad = [];
const check = (n, pass, d) => {
	(pass ? ok : bad).push(n);
	console.log((pass ? '  ok   ' : '  FAIL ') + n + (d !== undefined && d !== '' ? ' -- ' + String(d).slice(0, 500) : ''));
};
const OPT = '0da1000000f2';
const BASE = 'root/diamonds/' + OPT;
const SELF = BASE + '/self';
const FLAGS = ['daimond-default-self-played', 'daimond-defaults-seeded-2', 'daimond-trig-here-notice'];

async function session(name) {
	const s = await open({ name, profile: scratch('pw', name + '-' + process.pid), connect: false });
	for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
		await s.page.keyboard.press('Escape').catch(() => {});
		await sleep(1500);
		try { await connectMock(s); } catch (e) { console.log('  note connectMock ' + e.message); }
	}
	return s;
}
async function boot(p) {
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
	for (let i = 0; i < 60; i++) {
		if (await p.evaluate((o) => !!document.querySelector(`#diamond-list .diamond-box[data-id="${o}"]`), OPT)) break;
		await sleep(500);
	}
	await sleep(1500);
}
async function reload(p) {
	await p.reload({ waitUntil: 'domcontentloaded' });
	await boot(p);
}
// The repair waits for the session's first pull; this world has an identity and no gateway,
// so it goes ahead when that wait runs out.
async function repaired(p) {
	for (let i = 0; i < 70; i++) {
		if (await p.evaluate(() => localStorage.getItem('daimond-default-self-played') === '1')) return true;
		await sleep(500);
	}
	return false;
}
const rec = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('daimond-pause') || 'null'));
const isPaused = (p, n) => p.evaluate((x) => window.DaimondPause.isPaused(x), n);
async function openOptimiser(p) {
	await p.evaluate((o) => { const b = document.querySelector(`#diamond-list .diamond-box[data-id="${o}"]`); if (b) b.click(); }, OPT);
	await sleep(1200);
	const tab = p.locator('#dview-chat');
	if (await tab.count()) { await tab.click({ force: true }); await sleep(600); }
}
async function type(p, text, ms = 7000) {
	const before = mockLog().length;
	await p.fill('#chat-input', text + ' ' + Date.now());
	await p.click('#chat-send', { force: true });
	await sleep(ms);
	return mockLog().length - before;
}
/// A spy on the support report's arming, the side effect of drawing an error line.
const spyArm = (p) => p.evaluate(() => {
	window.__arms = [];
	const S = window.DaimondSupport;
	if (S && !S.__spied) {
		const orig = S.arm;
		S.arm = function (why) { window.__arms.push(why); return orig.apply(this, arguments); };
		S.__spied = true;
	}
});
/// The last line the app said in the thread: its register and its words.
const lastLine = (p) => p.evaluate(() => {
	const rows = [...document.querySelectorAll('#chat-output .chat-msg')];
	const r = rows[rows.length - 1];
	if (!r) return null;
	return {
		cls: r.className,
		text: (r.querySelector('.chat-msg-content') || r).textContent.trim().slice(0, 200),
		report: !!r.querySelector('.chat-err-report'),
		danger: /danger/.test((r.querySelector('.chat-msg-content') || {}).getAttribute
			? (r.querySelector('.chat-msg-content').getAttribute('style') || '') : ''),
		arms: (window.__arms || []).slice(),
	};
});

// ── N and D: a new device meets a pause made elsewhere ──────────────────
for (const [sec, node, label] of [['N', BASE, 'the Optimiser\'s own light'], ['D', 'root/diamonds', 'the Diamonds branch light']]) {
	if (!on(sec)) continue;
	console.log('\n' + sec + '. ' + label + ' pressed on "device A"; a new device (no flags) boots with that record');
	const s = await session('q6v-' + sec.toLowerCase());
	const p = s.page;
	await boot(p);
	check(sec + '0: the repair flag is set on this first boot', await repaired(p));
	await p.evaluate((n) => window.DaimondPause.set(n, false), node);
	await sleep(800);
	const R = await rec(p);
	check(sec + '0: the press holds self', await isPaused(p, SELF), JSON.stringify(R).slice(0, 300));
	// The new device: no per-device flags (it never booted), and the account's record, as its
	// first pull leaves it.
	await p.evaluate((f) => { f.forEach((k) => localStorage.removeItem(k)); }, FLAGS);
	await reload(p);
	const ran = await repaired(p);
	await sleep(1000);
	const R2 = await rec(p);
	check(sec + '1: a new device keeps the person\'s pause of the Optimiser (self stays held)',
		ran && await isPaused(p, SELF), 'ran=' + ran + ' ' + JSON.stringify(R2).slice(0, 300));
	check(sec + '2: and writes nothing later than the person\'s press', JSON.stringify(R2) === JSON.stringify(R),
		JSON.stringify(R).slice(0, 200) + ' -> ' + JSON.stringify(R2).slice(0, 200));
	check(sec + '3: the light the person pressed still reads held',
		await p.evaluate((n) => window.DaimondPause.heldByHand(n), node));
	await openOptimiser(p);
	const n = await type(p, 'q6 ' + sec + ' typed while paused');
	check(sec + '4: a typed turn in the Optimiser reaches no provider', n === 0, 'requests=' + n);
	await s.close();
}

// ── B: a device that ran the old seed pulls a Diamonds-branch pause ─────
if (on('B')) {
	console.log('\nB. a device the old seed held `self` on, repair owed, pulls a Diamonds-branch pause');
	const s = await session('q6v-b');
	const p = s.page;
	await boot(p);
	await repaired(p);
	// What the old seed left: `self` held by the app beside its action.
	const oldSeed = () => p.evaluate((n) => {
		localStorage.removeItem('daimond-default-self-played');
		window.DaimondPause.seedPaused(n);
	}, SELF);
	// B1: another device on this build pressed the Diamonds branch; the pull brought it.
	await oldSeed();
	await p.evaluate(() => window.DaimondPause.set('root/diamonds', false));
	check('B1: set up -- self held, the repair owed, DEFAULTS set',
		await isPaused(p, SELF) && await p.evaluate(() => localStorage.getItem('daimond-defaults-seeded-2') === '1'
			&& localStorage.getItem('daimond-default-self-played') === null));
	await reload(p);
	check('B1: the repair ran', await repaired(p));
	check('B1: and the Diamonds-branch pause still holds self', await isPaused(p, SELF)
		&& await p.evaluate(() => window.DaimondPause.heldByHand('root/diamonds')), JSON.stringify(await rec(p)).slice(0, 300));
	// B2: the same pause as a build before this one recorded it -- every leaf under the branch,
	// in the old shape, with nothing to say who held them.
	await p.evaluate(() => window.DaimondPause.set('root/diamonds', true));
	// Every Diamond's own conversation and the Optimiser's action: what "pause the Diamonds"
	// wrote before a press was kept where it was made.
	const branchLeaves = await p.evaluate(() => [...document.querySelectorAll('#diamond-list .diamond-box[data-id]')]
		.map((b) => window.DaimondPause.id('root', 'diamonds', b.dataset.id, 'self')));
	await p.evaluate(({ ids, trig }) => {
		localStorage.removeItem('daimond-default-self-played');
		localStorage.setItem('daimond-pause', JSON.stringify({ paused: ids.concat([trig]).sort(), stamp: Date.now() }));
	}, { ids: branchLeaves, trig: BASE + '/triggers/activity-1' });
	await reload(p);
	check('B2: set up -- every Diamond held, in the old shape', await p.evaluate(() => window.DaimondPause.heldByHand('root/diamonds')),
		JSON.stringify(branchLeaves));
	check('B2: the repair ran', await repaired(p));
	check('B2: and the Diamonds-branch pause from an older build still holds self', await isPaused(p, SELF),
		JSON.stringify(await rec(p)).slice(0, 300));
	await s.close();
}

// ── P: a proposal ticked while the Optimiser is paused ──────────────────
if (on('P')) {
	console.log('\nP. a proposal ticked while the Optimiser is paused');
	const s = await session('q6v-p');
	const p = s.page;
	await boot(p);
	await p.evaluate((n) => window.DaimondPause.set(n, false), BASE);
	await sleep(600);
	const id = await p.evaluate((o) => window.DaimondPendingView.add({ kind: 'proposal', diamondId: o,
		diamondName: 'Daimond Optimiser', headline: 'Q6 headline', detail: 'Q6 evidence line' }), OPT);
	await sleep(800);
	const tick = () => p.evaluate((id) => {
		const box = [...document.querySelectorAll('#pending-list .pend-card')].find((b) => b.dataset.id === id);
		if (!box) return false;
		box.querySelector('.pend-go').click();
		return true;
	}, id);
	const toasts = () => p.evaluate(() => [...document.querySelectorAll('.daimond-toast')].map((e) => e.textContent));
	let before = mockLog().length;
	const clicked = await tick();
	await sleep(1500);
	const said = await toasts();
	await sleep(4500);
	const sent = mockLog().length - before;
	const left = await p.evaluate(() => window.DaimondPendingView.items().map((i) => i.kind + ':' + i.headline));
	check('P1: the tick reaches no provider', clicked && sent === 0, 'clicked=' + clicked + ' requests=' + sent);
	check('P2: the proposal is still there to tick once play is pressed', left.some((x) => /Q6 headline/.test(x)), JSON.stringify(left));
	check('P3: and a toast says the Optimiser is paused, by name', said.some((x) => /Daimond Optimiser/.test(x) && /paused/i.test(x)),
		JSON.stringify(said));
	await p.evaluate((n) => window.DaimondPause.set(n, true), BASE);
	await sleep(600);
	before = mockLog().length;
	const again = await tick();
	await sleep(8000);
	const sent2 = mockLog().length - before;
	const left2 = await p.evaluate(() => window.DaimondPendingView.items().map((i) => i.kind + ':' + i.headline));
	check('P4: after play the same tick steers the Optimiser', again && sent2 > 0, 'clicked=' + again + ' requests=' + sent2);
	check('P5: and the tile goes', !left2.some((x) => /Q6 headline/.test(x)), JSON.stringify(left2));
	await s.close();
}

// ── R: a refusal is said as a pause, not a fault ──────────────────────
if (on('R')) {
	console.log('\nR. a turn a pause refuses is drawn as a note, not an error');
	const s = await session('q6v-r');
	const p = s.page;
	await boot(p);
	// The Optimiser's own conversation (`runSteer`).
	await p.evaluate((n) => window.DaimondPause.set(n, false), BASE);
	await openOptimiser(p);
	await spyArm(p);
	const n1 = await type(p, 'q6 R daimon while paused');
	const L1 = await lastLine(p);
	check('R1: a typed turn in the paused Optimiser reaches no provider', n1 === 0, 'requests=' + n1);
	check('R2: its refusal names the Optimiser and says paused', !!L1 && /Daimond Optimiser/.test(L1.text) && /paused/i.test(L1.text),
		JSON.stringify(L1));
	check('R3: drawn as a note -- no error line, no danger colour, no "Report this", nothing armed',
		!!L1 && !/chat-msg-error/.test(L1.cls) && !L1.danger && !L1.report && !L1.arms.includes('chat.error'), JSON.stringify(L1));
	await p.evaluate((n) => window.DaimondPause.set(n, true), BASE);
	// A loose chat (`runTurn`).
	const cid = await newChat(s);
	await sleep(800);
	await p.evaluate((c) => window.DaimondPause.set(window.DaimondPause.id('root', 'chats', c), false), cid);
	await spyArm(p);
	const n2 = await type(p, 'q6 R chat while paused');
	const L2 = await lastLine(p);
	check('R4: a typed turn in a paused chat reaches no provider', n2 === 0, 'requests=' + n2);
	check('R5: and its refusal is a note too', !!L2 && /paused/i.test(L2.text) && !/chat-msg-error/.test(L2.cls)
		&& !L2.report && !L2.arms.includes('chat.error'), JSON.stringify(L2));
	await sleep(1500);				// the chat store is written behind the turn
	const stored = await p.evaluate(async (c) => {
		const got = await window.DaimondCore.chatStore().loadMessages(c);
		return ((got && got.messages) || []).slice(-1).map((m) => m.role);
	}, cid).catch((e) => 'unread: ' + e.message);
	check('R6: it is stored as the app\'s note, not an error', Array.isArray(stored) && stored[0] === 'note_log',
		JSON.stringify(stored));
	await reload(p);
	await p.evaluate((c) => { const b = document.querySelector('#chat-list [data-id="' + c + '"], .session-box[data-id="' + c + '"]'); if (b) b.click(); }, cid);
	await sleep(1500);
	const L3 = await lastLine(p);
	check('R7: a reload draws it the same way', !!L3 && /paused/i.test(L3.text) && !/chat-msg-error/.test(L3.cls) && !L3.report,
		JSON.stringify({ L3, stored }));
	await p.evaluate((c) => window.DaimondPause.set(window.DaimondPause.id('root', 'chats', c), true), cid);
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.join(', ') : ''));
process.exit(bad.length ? 1 : 0);
