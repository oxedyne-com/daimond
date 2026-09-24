// verify_pausemerge.mjs — a press speaks for the node pressed, and no other (R3 QA, M-merge).
//
// Until the R3 QA of 2026-09-24 the pause record was one set and one stamp, merged whole with
// the later stamp winning (`~/usr/code/ai/claude/specs/daimond_r3_qa_pause_20260924.md`). A
// device that had not pulled a Pause all and paused one chat five seconds later sent a record
// that replaced it on every device; a hand-off runner adopting an errand's pause snapshot lost
// its own Pause all the same way. The record is now one entry per node, merged id by id
// (`www/js/pause.js`, "The record").
//
// Drives the app in a real page as device A, and plays device B in the same page on a second
// copy of pause.js over its own storage and clock -- the page's own copy, or the old build's
// from git -- passing records the way the sync and an errand do (`snapshot` out, `adopt` in):
//
//   M  M1/M2: A presses Pause all; B, not yet pulled, pauses one chat 5 s later; both sync.
//      Pause all holds on both, and a typed turn in another chat reaches no provider.
//   E  the runner: A holds Pause all and runs a hand-off whose sender pressed one leaf since.
//      The errand is refused as paused, and A still holds everything afterwards.
//   O  M again with B on the OLD build (BASE, live Release 3): the upgrade's mixed fleet.
//   U  the upgrade in place: a store an old build wrote -- a chat a person paused -- read by
//      this build: the chat is held, a typed turn in it reaches no provider, and the next write
//      keeps the old fields beside the new record.
//   W  a hold on the workers that arrives (an old build's, the app's) reaches the pump and is
//      NOT written back as this device's press: the pump's own reconcile writes nothing.
//
//   eval "$(bash dev/world.sh N --up)"
//   node dev/verify_pausemerge.mjs [M] [E] [O] [U] [W]      # BASE=81309ed6 by default
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, connectMock, newChat, scratch, mockLog } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || '81309ed6';
const OLD = execFileSync('git', ['-C', path.dirname(HERE), 'show', BASE + ':www/js/pause.js'], { maxBuffer: 1 << 26 }).toString();
const want = process.argv.slice(2);
const on = (k) => !want.length || want.includes(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [], bad = [];
const check = (n, pass, d) => {
	(pass ? ok : bad).push(n);
	console.log((pass ? '  ok   ' : '  FAIL ') + n + (d !== undefined && d !== '' ? ' -- ' + String(d).slice(0, 500) : ''));
};
const OPT = '0da1000000f2';

async function session(name, defaults) {
	const s = await open({ name, profile: scratch('pw', name + '-' + process.pid), connect: false, defaults });
	for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
		await s.page.keyboard.press('Escape').catch(() => {});
		await sleep(1500);
		try { await connectMock(s); } catch (e) { console.log('  note connectMock ' + e.message); }
	}
	await s.page.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
	return s;
}

/// Device B in the page: `src` (null for the page's own pause.js) over its own storage, with
/// its own device id, its clock `off` ms ahead of the page's.
const peer = (p, name, src, off) => p.evaluate(async ({ name, src, off }) => {
	const body = src || await (await fetch('/js/pause.js', { cache: 'no-store' })).text();
	const m = new Map();
	const ls = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
		removeItem: (k) => { m.delete(k); } };
	const win = { localStorage: ls, addEventListener() {}, dispatchEvent() { return true; },
		DaimondIdentity: { deviceId: () => name } };
	new Function('window', 'localStorage', 'CustomEvent', 'Date', body)(win, ls,
		function CustomEvent(t) { this.type = t; }, { now: () => Date.now() + off });
	(window.__peers = window.__peers || {})[name] = win.DaimondPause;
	return true;
}, { name, src, off });

/// Type into the chat on screen and count what reached the provider.
async function type(p, text, ms = 6000) {
	const before = mockLog().length;
	await p.fill('#chat-input', text + ' ' + Date.now());
	await p.click('#chat-send', { force: true });
	await sleep(ms);
	return mockLog().length - before;
}
const openChat = (p, c) => p.evaluate((c) => {
	const b = document.querySelector('#chat-list [data-id="' + c + '"], .session-box[data-id="' + c + '"]');
	if (b) b.click();
}, c);

// ── M and O: a later pause of one chat elsewhere, against a Pause all here ─────
for (const [sec, src, label] of [['M', null, 'this build'], ['O', OLD, 'the old build (' + BASE + ')']]) {
	if (!on(sec)) continue;
	console.log('\n' + sec + '. A presses Pause all; B, on ' + label + ', pauses one chat 5 s later, unpulled');
	const s = await session('pausemerge-' + sec.toLowerCase(), false);
	const p = s.page;
	const a = await newChat(s); await sleep(600);
	const x = await newChat(s); await sleep(600);
	await peer(p, 'B', src, 5000);
	const r = await p.evaluate(({ a, x }) => {
		const P = window.DaimondPause, B = window.__peers.B;
		B.adopt(P.snapshot());						// B was in step before the press
		P.set(P.ROOT, false);						// A: Pause all
		const heldAll = P.heldByHand(P.ROOT);
		const ids = P.pausedIds().filter((k) => k !== P.ROOT && k.indexOf('root/') === 0);
		B.set(P.id('root', 'chats', x), false);		// B: pauses chat X, 5 s later
		const moved = P.adopt(B.snapshot());		// A pulls B
		B.adopt(P.snapshot());						// B pulls A
		return { heldAll, moved, n: ids.length,
			aRoot: P.heldByHand(P.ROOT), aChat: window.DaimondModels.held(P.id('root', 'chats', a)),
			bAll: ids.every((k) => B.isPaused(k)), bMissing: ids.filter((k) => !B.isPaused(k)) };
	}, { a, x });
	check(sec + '0: Pause all held everything here before B\'s record arrived', r.heldAll && r.n > 0, JSON.stringify(r));
	check(sec + '1: after both have synced, Pause all still holds on A', r.aRoot && r.aChat, JSON.stringify(r));
	check(sec + '1: and on B', r.bAll, JSON.stringify(r.bMissing));
	await openChat(p, a);
	await sleep(800);
	const n = await type(p, 'pausemerge ' + sec + '2 after pause all');
	check(sec + '2: a typed turn in a chat the Pause all held reaches no provider', n === 0, 'requests=' + n);
	await p.evaluate(() => window.DaimondPause.set(window.DaimondPause.ROOT, true));
	await s.close();
}

// ── E: the runner of a hand-off ────────────────────────────────────────
if (on('E')) {
	console.log('\nE. a runner holding Pause all is sent an errand by a sender who pressed one leaf since');
	const s = await session('pausemerge-e', true);
	const p = s.page;
	for (let i = 0; i < 60; i++) {
		if (await p.evaluate((o) => !!document.querySelector('#diamond-list .diamond-box[data-id="' + o + '"]'), OPT)) break;
		await sleep(500);
	}
	await sleep(1500);
	await peer(p, 'S', null, 5000);
	const before = mockLog().length;
	const r = await p.evaluate(async (o) => {
		const P = window.DaimondPause, S = window.__peers.S, Peer = window.DaimondPeer;
		S.adopt(P.snapshot());						// the sender was in step before the press
		P.set(P.ROOT, false);						// the runner: Pause all
		S.set('root/web', false);					// the sender, 5 s later, unpulled: one leaf
		const posted = [];
		const orig = window.DaimondPost.post;
		window.DaimondPost.post = async (b) => { posted.push(b); return { ok: true }; };
		try {
			const chat = window.DaimondDiamond.conversation(o);
			const tid = Date.now().toString(36) + '-pmerge';
			const plan = Peer.buildDispatch(chat, { turnId: tid, diamondId: o, prompt: 'from the sender',
				model: { provider: chat.provider || '', model: chat.model || '', url: '' },
				scope: [], pause: S.snapshot(), dispatchedBy: 'feedfacefeedface', parkCount: 0 });
			const body = await Peer.sealForSelf(plan.errand(0));
			const obj = await Peer.peek(body.envelope);
			const res = await Peer.absorb(obj, { ts: Math.floor(Date.now() / 1000), seq: 1 });
			return { res: res && res.result, root: P.heldByHand(P.ROOT),
				self: P.isPaused(P.id('root', 'diamonds', o, 'self')), web: P.isPaused('root/web') };
		} catch (e) {
			return { threw: String(e && e.message || e) };
		} finally {
			window.DaimondPost.post = orig;
		}
	}, OPT);
	await sleep(3000);
	const reqs = mockLog().length - before;
	check('E1: the errand is refused as paused, and reaches no provider',
		!!r.res && r.res.ran === false && r.res.why === 'paused' && reqs === 0, JSON.stringify(r) + ' requests=' + reqs);
	check('E2: the runner still holds everything afterwards', r.root && r.self && r.web, JSON.stringify(r));
	await p.evaluate(() => window.DaimondPause.set(window.DaimondPause.ROOT, true));
	await s.close();
}

// ── U: the upgrade in place ───────────────────────────────────────────
if (on('U')) {
	console.log('\nU. a store the old build wrote, read by this one');
	const s = await session('pausemerge-u', false);
	const p = s.page;
	const c = await newChat(s); await sleep(600);
	const other = await newChat(s); await sleep(600);
	const leaf = await p.evaluate((c) => window.DaimondPause.id('root', 'chats', c), c);
	const S = Date.now() - 60000;
	await p.evaluate(({ leaf, S }) => {
		localStorage.setItem('daimond-pause', JSON.stringify({ paused: [leaf], stamp: S }));
	}, { leaf, S });
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
	await sleep(2000);
	const st = await p.evaluate(({ leaf, o }) => ({ held: window.DaimondPause.isPaused(leaf),
		other: window.DaimondPause.isPaused(o) }), { leaf, o: 'root/chats/' + other });
	check('U1: the chat a person paused on the old build is held here, and only it', st.held && !st.other, JSON.stringify(st));
	await openChat(p, c);
	await sleep(1000);
	const n = await type(p, 'pausemerge U2 typed into the chat paused on the old build');
	check('U2: a typed turn in it reaches no provider', n === 0, 'requests=' + n);
	await p.evaluate(() => window.DaimondPause.set('root/web', false));
	const rec = await p.evaluate(() => JSON.parse(localStorage.getItem('daimond-pause') || 'null'));
	check('U3: the next write keeps what the old build reads, beside the record',
		!!rec && rec.v === 2 && rec.paused.includes(leaf) && rec.paused.includes('root/web') && rec.stamp > S,
		JSON.stringify(rec).slice(0, 400));
	await p.evaluate((leaf) => { window.DaimondPause.set(leaf, true); window.DaimondPause.set('root/web', true); }, leaf);
	await s.close();
}

// ── W: a workers hold that arrives is not turned into a press ───────────
if (on('W')) {
	console.log('\nW. an old build\'s hold on the workers arrives');
	const s = await session('pausemerge-w', false);
	const p = s.page;
	await sleep(1500);
	const before = await p.evaluate(() => ({ held: window.DaimondPause.isPaused('root/workers'),
		pump: window.DaimondPause.isPaused('root/workers') }));
	check('W0: the workers play here to begin with', !before.held, JSON.stringify(before));
	await p.evaluate(() => window.DaimondPause.adopt({ paused: ['root/workers'], stamp: Date.now() }));
	await sleep(1500);
	const after = await p.evaluate(() => ({ held: window.DaimondPause.isPaused('root/workers'),
		entry: window.DaimondPause.entry ? window.DaimondPause.entry('root/workers') : null,
		paused: (window.DaimondPause.snapshot().leaves || {})['root/workers'] || null }));
	check('W1: the hold reaches the workers', after.held, JSON.stringify(after));
	check('W2: and stays the old build\'s, not a press this device made', !!after.entry && after.entry[2] === 'a:legacy',
		JSON.stringify(after));
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.join(', ') : ''));
process.exit(bad.length ? 1 : 0);
