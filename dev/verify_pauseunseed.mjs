// verify_pauseunseed.mjs — a pause stands however it reaches a device, and catches a turn
// that is already running.
//
// The two findings this holds shut (`~/usr/code/ai/claude/specs/daimond_fu_qa_20260924.md`):
//
//   FA  the Optimiser's repair (`releaseSeededSelf`) ran at boot, before the first pull, and
//       played its `self` with `DaimondPause.set`, which stamps the WHOLE record with the
//       clock. A device that had not yet pulled a Pause all pressed on another one wrote a
//       record later than it, its own pull lost to that record, and its next push undid the
//       Pause all on every device. Now the repair waits for the first pull and takes the leaf
//       back with `unseed`, one past the stamp held here.
//   FB  the pause was asked when a turn started and never again, so a turn on the person's
//       own key went on reaching the provider round after round once paused. Now
//       `brakeHeld` aborts every turn a pause holds, the turn is handed back as paused (not
//       as an error), and its Continue is refused until play is pressed.
//
// Three sessions, each a fresh profile:
//
//   U  (no gateway) an account an earlier build seeded with `self` held, reopened here, where a
//      Pause all made on another device is newer than anything it holds: the repair does not
//      out-date it, and once it arrives it holds -- chat, Optimiser and a typed turn.
//   B  (no gateway) a paced multi-round turn paused part way, in a chat and in a Diamond:
//      at most the request already in flight after the press, a paused badge and no error,
//      Continue refused while held and running once played.
//   G  (only with the world's gateway up) two devices, one account, through the real sync:
//      B closed, A presses Pause all, B reopens without the road for its first 12 s. B holds
//      the Pause all, and A still does after B's next change has synced.
//
//   eval "$(bash dev/world.sh N --up)"          # plus the world's gateway for G
//   node dev/verify_pauseunseed.mjs [U] [B] [G]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, connectMock, newChat, scratch, mockLog, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const want = process.argv.slice(2);
const on = (k) => !want.length || want.includes(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 400) : ''));
};
const OPT = '0da1000000f2';							// the Optimiser's fixed id
const SELF = 'root/diamonds/' + OPT + '/self';

async function connect(s) {
	for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
		await s.page.keyboard.press('Escape').catch(() => {});
		await sleep(1500);
		try { await connectMock(s); } catch (e) { console.log('  note connectMock ' + (i + 1) + ': ' + String(e.message || e).slice(0, 100)); }
	}
}
async function waitOptimiser(p) {
	for (let i = 0; i < 60; i++) {
		if (await p.evaluate((id) => !!document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]'), OPT).catch(() => false)) return true;
		await sleep(500);
	}
	return false;
}
// pause.js reads and writes `daimond-pause` raw; accounts.js namespaces it, so the page's own
// localStorage is the right door for both.
const readRec = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('daimond-pause') || 'null'));
const writeRec = (p, rec) => p.evaluate((r) => { localStorage.setItem('daimond-pause', JSON.stringify(r)); }, rec);
/// What an earlier build left: `self` seeded held beside the action, and no repair yet.
const seedAsBefore = (p) => p.evaluate((n) => {
	localStorage.removeItem('daimond-default-self-played');
	window.DaimondPause.seedPaused(n);
}, SELF);
const errorCount = (p) => p.evaluate(() => document.querySelectorAll('.chat-msg-error').length);
const badge = (p) => p.evaluate(() => {
	const b = [...document.querySelectorAll('.turn-interrupted .ti-label')];
	return b.length ? b[b.length - 1].textContent : '';
});

async function typeIn(p, text, ms = 6000) {
	const before = mockLog().length;
	await p.fill('#chat-input', text);
	await p.click('#chat-send', { force: true });
	await sleep(ms);
	return mockLog().length - before;
}

// ── U. the repair is not a press ──────────────────────────────────────────────────────────
if (on('U')) {
	console.log('\nU. the Optimiser\'s repair on a device that has not yet heard of a Pause all');
	const s = await open({ name: 'pauseunseed-u', connect: false, profile: scratch('pw', 'pauseunseed-u-' + process.pid) });
	await connect(s);
	const p = s.page;
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
	check('U0: the Optimiser is seeded', await waitOptimiser(p));
	const cid = await newChat(s);
	await sleep(800);
	await seedAsBefore(p);
	const L0 = await readRec(p);
	check('U0: seeded as an earlier build seeded it, self held', (L0 && L0.paused || []).includes(SELF), JSON.stringify(L0));
	// "Another device" presses Pause all: the record it carries, made with the app's own verb,
	// then this device's own record put back as it was -- it never heard of it.
	await sleep(1200);
	const R = await p.evaluate(() => { window.DaimondPause.set(window.DaimondPause.ROOT, false); return window.DaimondPause.snapshot(); });
	const chatLeaf = await p.evaluate((c) => window.DaimondPause.id('root', 'chats', c), cid);
	await writeRec(p, L0);
	await sleep(1500);
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
	await waitOptimiser(p);
	// This profile has an identity and the world may have no gateway: the repair then goes
	// ahead when its wait for the first pull runs out, on the record it holds.
	let ran = false;
	for (let i = 0; i < 70 && !ran; i++) {
		ran = await p.evaluate(() => localStorage.getItem('daimond-default-self-played') === '1');
		if (!ran) await sleep(500);
	}
	const L1 = await readRec(p);
	check('U1: the repair ran and played the Optimiser\'s own conversation',
		ran && !(L1 && L1.paused || []).includes(SELF), 'ran=' + ran + ' ' + JSON.stringify(L1));
	check('U2: and did not stamp itself later than a Pause all it has not seen',
		(L1 && L1.stamp || 0) < R.stamp, 'local ' + (L1 && L1.stamp) + ' vs the Pause all ' + R.stamp);
	// The pull arrives: what sync.js `applyParcel` does with the parcel's `pause`.
	await p.evaluate((r) => window.DaimondPause.adopt(r), R);
	const after = await p.evaluate(({ c }) => ({
		all:  window.DaimondPause.heldByHand(window.DaimondPause.ROOT),
		chat: window.DaimondPause.isPaused(c),
	}), { c: chatLeaf });
	const selfNow = await p.evaluate((n) => window.DaimondPause.isPaused(n), SELF);
	check('U3: the Pause all holds once it arrives -- everything, the chat and the Optimiser',
		after.all && after.chat && selfNow, JSON.stringify({ ...after, self: selfNow }));
	await p.evaluate((c) => { const b = document.querySelector('#chat-list [data-id="' + c + '"], .session-box[data-id="' + c + '"]'); if (b) b.click(); }, cid);
	await sleep(1200);
	const n = await typeIn(p, 'pauseunseed U4 ' + Date.now());
	check('U4: and a typed turn in the chat it paused reaches no provider', n === 0, 'requests=' + n);
	await p.evaluate(() => window.DaimondPause.set(window.DaimondPause.ROOT, true)).catch(() => {});
	await s.close();
}

// ── B. a turn already running when pause is pressed ───────────────────────────────────────
if (on('B')) {
	console.log('\nB. pause pressed during a multi-round turn, own key');
	const s = await open({ name: 'pauseunseed-b', connect: false, defaults: false, profile: scratch('pw', 'pauseunseed-b-' + process.pid) });
	await connect(s);
	const p = s.page;
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
	const cid = await newChat(s);
	await sleep(600);
	const leaf = await p.evaluate((c) => window.DaimondPause.id('root', 'chats', c), cid);
	// CONTROL: the same turn, nobody pausing, runs every round it was asked for.
	const c0 = mockLog().length;
	await p.fill('#chat-input', '@rounds 8/800 file_list {"path":"."}');
	await p.click('#chat-send', { force: true });
	await sleep(10000);
	check('B0: control -- unpaused, the paced turn runs all its rounds', mockLog().length - c0 >= 7, 'requests ' + (mockLog().length - c0));
	const e0 = await errorCount(p);
	const before = mockLog().length;
	await p.fill('#chat-input', '@rounds 14/1500 file_list {"path":"."}');
	await p.click('#chat-send', { force: true });
	await sleep(5200);
	const n0 = mockLog().length - before;
	check('B0: the turn is running round after round', n0 >= 2, 'requests so far ' + n0);
	await p.evaluate((l) => window.DaimondPause.set(l, false), leaf);
	await sleep(12000);
	const n1 = mockLog().length - before;
	check('B1: after the chat is paused, no request but the one already in flight', n1 - n0 <= 1,
		'requests at pause ' + n0 + ', 12 s later ' + n1);
	const st = await p.evaluate((c) => { const x = (window.DaimondCore.chatStore().stored() || []).find((y) => y.id === c); return x ? !!x._generating : null; }, cid).catch(() => null);
	check('B2: and the turn has ended', st === false, 'generating=' + st);
	const said = await badge(p);
	check('B3: it is handed back as paused, saying what to press', /paused/i.test(said) && /play/i.test(said), JSON.stringify(said));
	check('B3: and not as an error', (await errorCount(p)) === e0, 'error lines ' + e0 + ' -> ' + (await errorCount(p)));
	// Continue, still paused: refused, and the badge stays.
	const k0 = mockLog().length;
	await p.click('.turn-interrupted .ti-continue', { force: true }).catch(() => {});
	await sleep(3000);
	check('B4: Continue while the chat is paused reaches no provider', mockLog().length - k0 === 0, 'requests=' + (mockLog().length - k0));
	check('B4: and the badge stays for after play', /paused/i.test(await badge(p)), JSON.stringify(await badge(p)));
	await p.evaluate((l) => window.DaimondPause.set(l, true), leaf);
	await sleep(500);
	const k1 = mockLog().length;
	await p.click('.turn-interrupted .ti-continue', { force: true }).catch(() => {});
	await sleep(4000);
	check('B5: played, Continue runs the turn on', mockLog().length - k1 > 0, 'requests=' + (mockLog().length - k1));
	await p.evaluate(() => { const b = document.getElementById('chat-send'); if (b && b.classList.contains('stop')) b.click(); }).catch(() => {});
	await sleep(3000);

	// The same through "Pause all", on a Diamond's own turn (`runSteer`, the Diamond's app).
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 8000 });
	const dname = 'Brake ' + Date.now().toString(36).slice(-4);
	await p.fill('.dlg-input', dname);
	await p.click('.dlg-ok', { force: true });
	await p.waitForSelector('#chat-input', { timeout: 15000 });
	await sleep(600);
	const tab = p.locator('#dview-chat');
	if (await tab.count()) { await tab.click({ force: true }); await sleep(500); }
	const e1 = await errorCount(p);
	const d0 = mockLog().length;
	await p.fill('#chat-input', '@rounds 14/1500 file_list {"path":"."}');
	await p.click('#chat-send', { force: true });
	await sleep(5200);
	const m0 = mockLog().length - d0;
	check('B6: a Diamond\'s turn is running round after round', m0 >= 2, 'requests so far ' + m0);
	await p.evaluate(() => window.DaimondPause.set(window.DaimondPause.ROOT, false));
	await sleep(12000);
	const m1 = mockLog().length - d0;
	check('B7: after Pause all, no request but the one already in flight', m1 - m0 <= 1,
		'requests at pause ' + m0 + ', 12 s later ' + m1);
	const ending = await p.evaluate(() => {
		const e = [...document.querySelectorAll('.chat-msg-ended .end-line')];
		return e.length ? e[e.length - 1].textContent : '';
	});
	check('B8: its ending says paused, not an error', /paused/i.test(ending) && (await errorCount(p)) === e1,
		JSON.stringify(ending) + ' errors ' + e1 + ' -> ' + (await errorCount(p)));
	await p.evaluate(() => window.DaimondPause.set(window.DaimondPause.ROOT, true)).catch(() => {});
	await s.close();
}

// ── G. two devices through the gateway ────────────────────────────────────────────────────
const gwUp = !!process.env.DAIMOND_GW_PORT && await fetch('http://127.0.0.1:' + process.env.DAIMOND_GW_PORT + '/api/health')
	.then(() => true, () => false);
if (on('G') && !gwUp) console.log('\nG. skipped: this world has no gateway up');
if (on('G') && gwUp) {
	console.log('\nG. two devices: B reopens with its first 12 s off the road, after a Pause all on A');
	const GW_URL = 'http://127.0.0.1:' + process.env.DAIMOND_GW_PORT;
	const GWDIR = path.join(HERE, '..', 'gateway');
	const acct = 'pun-' + Date.now().toString(36).slice(-5);
	const profA = scratch('pw', acct + '-a'), profB = scratch('pw', acct + '-b');
	const settle = (pg) => pg.waitForFunction(() => { try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; } }, null, { timeout: 30000 }).catch(() => {});
	const authed = (x) => x.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && window.DaimondGateway.state().authed, null, { timeout: 60000 }).then(() => true).catch(() => false);
	const gateUp = (x) => x.page.waitForFunction(() => { const b = document.getElementById('id-primary'); if (b && b.offsetParent !== null) return true; try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
	const state = (x) => x.page.evaluate(() => ({ all: window.DaimondPause.heldByHand(window.DaimondPause.ROOT),
		stamp: window.DaimondPause.snapshot().stamp, ids: window.DaimondPause.snapshot().paused })).catch((e) => ({ err: String(e.message || e), ids: [] }));
	const keeps = (st, ref) => (ref.ids || []).every((k) => (st.ids || []).includes(k));
	const brief = (st) => JSON.stringify({ all: st.all, stamp: st.stamp, n: (st.ids || []).length });
	const pull = (x) => x.page.evaluate(() => window.DaimondSync.pull(true).then(() => 'ok', (e) => 'err ' + e.message)).catch((e) => 'err ' + e.message);
	const slow = async (page) => { page.setDefaultNavigationTimeout(120000); };

	const a = await open({ name: acct + '-a', signIn: false, connect: false, profile: profA, route: slow });
	await gateUp(a); await signInAs(a, acct);
	check('G0: A signed in', await authed(a));
	await makePagePro(a.page, GWDIR, GW_URL);
	await connect(a);
	await waitOptimiser(a.page);
	await newChat(a);
	await settle(a.page);
	const b = await open({ name: acct + '-b', signIn: false, connect: false, profile: profB, route: slow });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 120000 }).catch(() => {});
	const code = await a.page.evaluate(() => window.DaimondPairing.create());
	const red = await b.page.evaluate((c) => window.DaimondPairing.redeem(c).then(() => 'ok', (e) => 'err: ' + e.message), code && code.code);
	check('G0: B paired with A', red === 'ok', red);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(b); await signInAs(b, acct);
	check('G0: B signed in', await authed(b));
	await makePagePro(b.page, GWDIR, GW_URL);
	await sleep(3000);
	// B as an earlier build left it: `self` seeded held, no repair yet. It travels to A too.
	await waitOptimiser(b.page);
	await seedAsBefore(b.page);
	for (let i = 0; i < 3; i++) { await pull(b); await settle(b.page); await pull(a); await settle(a.page); await sleep(1000); }
	await b.close();
	await a.page.evaluate(() => window.DaimondPause.set(window.DaimondPause.ROOT, false));
	await settle(a.page);
	await sleep(2000); await pull(a); await settle(a.page);
	const sa1 = await state(a);
	check('G0: A holds Pause all and has pushed it', sa1.all, brief(sa1));
	await sleep(2000);
	const b2 = await open({ name: acct + '-b', signIn: false, connect: false, profile: profB,
		route: async (page) => { await slow(page); await page.route('**/api/**', (r) => r.abort('internetdisconnected')); } });
	await gateUp(b2); await signInAs(b2, acct);
	await waitOptimiser(b2.page);
	await sleep(12000);
	const sOff = await state(b2);
	check('G1: off the road, B\'s repair wrote nothing that could out-date the Pause all', (sOff.stamp || 0) < sa1.stamp,
		brief(sOff) + ' vs the Pause all ' + brief(sa1));
	await b2.page.unroute('**/api/**');
	await b2.page.evaluate(() => window.DaimondGateway.bootstrap().then(() => 'ok', (e) => 'err ' + e.message)).catch(() => {});
	check('G0: B signed in again', await authed(b2));
	await sleep(8000);
	for (let i = 0; i < 3; i++) { await pull(b2); await settle(b2.page); await pull(a); await settle(a.page); await sleep(1500); }
	const sb2 = await state(b2), sa2 = await state(a);
	check('G2: B, reopened, holds the Pause all A pressed while it was closed', keeps(sb2, sa1), brief(sb2));
	check('G3: and A still holds it once B has synced', keeps(sa2, sa1), brief(sa2));
	await newChat(b2).catch(() => {});
	await sleep(3000);
	for (let i = 0; i < 3; i++) { await settle(b2.page); await pull(b2); await settle(b2.page); await pull(a); await settle(a.page); await sleep(1500); }
	const sa3 = await state(a);
	check('G4: after B\'s next ordinary change has synced, A holds every leaf its Pause all held', keeps(sa3, sa1), brief(sa3));
	await b2.close(); await a.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { console.log('FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
