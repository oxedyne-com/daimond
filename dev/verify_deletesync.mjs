// verify_deletesync.mjs — a file deleted on one device is deleted on the other, over a real sync.
//
// Two faults of the same class as the soak's R1 (`specs/daimond_offline_tomb_20260925.md`), each
// driven here between two paired devices of one account through a real gateway:
//
//   L. A LARGE FILE (one offloaded to the chunk store) deleted on one device never deleted on the
//      other. The delete took the path out of the deleting device's index and said nothing more,
//      and `cloud.js merge` keeps a path only one side holds, in both directions: the other device
//      kept its manifest, pushed it, and the deleting device adopted it back as a file in cloud
//      storage. The fix records the deletion as a stamped tombstone that travels and is joined
//      (`chunkedTombs`), and the receiving device deletes its own copy while it is still the
//      content that was deleted.
//        L1  A deletes two large files; B's index drops both, and B's own copy of the one it
//            holds is deleted.
//        L2  B's next push does not bring them back to A.
//        L3  A deletion made on B reaches A the same way.
//        L4  A file written again after its deletion, byte for byte, comes back everywhere (the
//            tombstone is add-wins).
//        L5  Converged, the parcel is a fixed point.
//   F. A DELETION MADE WHILE A PUSH IS IN FLIGHT CAME BACK AFTER A 409. The landed push set the
//      fork point from a fresh walk of the workspace rather than from the parcel that landed, so
//      the deleted path left the fork point unsent and no tombstone was ever written; the next
//      push's 409 pulled the account's copy and the merge adopted it as new. Here A's POST is
//      held at the network while the file is deleted, B moves the mailbox on, and A's next push
//      meets the 409.
//        F1  The fork point after the landing still holds the path (it is what landed).
//        F2  The 409's pull does not write the file back on A.
//        F3  B deletes it too.
//
//   node dev/verify_deletesync.mjs
//
// Needs the dev stack: the app (DAIMOND_PORT), the mock, and a gateway on DAIMOND_GW_PORT. Sync is
// Pro-gated, so the account is granted Pro the way the gateway trusts (dev/pro.mjs). Checks marked
// `[ctl]` are controls; the others fail on release/r51 @ 1b819652.
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail, kind = 'route') => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + (kind === 'control' ? '[ctl] ' : '') + name
		+ (detail ? ' — ' + String(detail).slice(0, 400) : ''));
};
const control = (name, pass, detail) => check(name, pass, detail, 'control');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

const NAME  = 'delsync';
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const PROFILE = (x) => scratch('pw', 'delsync-' + x + '-' + process.pid);

// Over a desktop's 1 MiB inline ceiling, so each is offloaded to the chunk store.
const BIG = (tag) => '# ' + tag + '\n\n' + (tag + ' ').repeat(Math.ceil((1300 * 1024) / (tag.length + 1)));
const ONE = BIG('one'), TWO = BIG('two'), THREE = BIG('three');
const X = '# x.md\n\nsmall, inline, deleted while a push is in flight\n';

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});

const tool = (s, name, args) => s.page.evaluate(async (a) => {
	const r = await DaimondCore.toolsApp().run_tool_outcome(a.name, JSON.stringify(a.args));
	return r ? r.outcome : 'none';
}, { name, args });
const write = (s, path, content) => s.page.evaluate(async ([p, c]) => { await (await import('/pkg/oxedyne_daimond.js')).write_file(p, c); return true; }, [path, content]);
const del = (s, path) => tool(s, 'file_delete', { path });
const held = (s, path) => s.page.evaluate((p) => DaimondCloud.isHeld(p), path);
const read = (s, path) => s.page.evaluate(async (p) => { try { return await DaimondCloud.readText(p); } catch (e) { return null; } }, path);
// The workspace paths this device's index names, without content keys, peer slots or sidecars.
const paths = (s) => s.page.evaluate(() => Object.keys(DaimondCloud.index())
	.filter((k) => !DaimondCloud.isContentKey(k) && !/\.peer(\.[0-9a-f]+)?$/.test(k) && !/\.synced$/.test(k)).sort());
const away = (s) => s.page.evaluate(() => Object.keys(DaimondCloud.awayPaths()).sort());
const forkPoint = (s) => s.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}'); } catch (e) { return {}; } });

const push = (s) => s.page.evaluate(() => (window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push())).catch(() => {});
const pull = (s) => s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
async function round(from, to, until, ms = 60000) {
	const t0 = Date.now();
	do {
		await push(from);
		await pull(to);
		await sleep(600);
		if (!until || await until()) return true;
	} while (Date.now() - t0 < ms);
	return false;
}
const settle = async (x, y) => { await round(x, y, null); await round(y, x, null); await round(x, y, null); };

/// A second device of the account, paired with `lead`.
async function pairedDevice(lead, label) {
	const d = await open({ name: NAME + '-' + label, signIn: false, connect: false, defaults: false, profile: PROFILE(label) });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, NAME);
	await ready(d);
	await sleep(2500);
	return d;
}

let A = null, B = null;
try {
	A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a') });
	await ready(A);
	const pro = await makePagePro(A.page, GWDIR, GW_URL);
	control('the account holds Pro, so sync can run at all', pro.pro === true, J(pro));
	B = await pairedDevice(A, 'b');
	const devA = await A.page.evaluate(() => DaimondIdentity.deviceId()), devB = await B.page.evaluate(() => DaimondIdentity.deviceId());
	control('B is paired with its own device id', !!devB && devA !== devB, J({ devA, devB }));

	// ═══ L: large files ═══════════════════════════════════════════════════════
	for (const [p, c] of [['big/one.txt', ONE], ['big/two.txt', TWO], ['big/three.txt', THREE]]) await write(A, p, c);
	const want = ['big/one.txt', 'big/three.txt', 'big/two.txt'];
	const offA = await round(A, B, async () => J((await paths(A)).filter((p) => p.startsWith('big/'))) === J(want)
		&& J((await paths(B)).filter((p) => p.startsWith('big/'))) === J(want), 150000);
	control('setup: the three large files are offloaded on A and named in B\'s index', offA,
		J({ a: await paths(A), b: await paths(B) }));
	await settle(A, B);
	// B holds one.txt; two.txt is freed on B, so B holds only the reference to it.
	if (!(await held(B, 'big/one.txt'))) await B.page.evaluate(() => DaimondCloud.fetch('big/one.txt'));
	await B.page.evaluate(() => DaimondCloud.evict('big/two.txt'));
	await settle(A, B);
	control('setup: B holds one.txt, and not two.txt', await held(B, 'big/one.txt') && !(await held(B, 'big/two.txt')),
		J({ one: await held(B, 'big/one.txt'), two: await held(B, 'big/two.txt') }));

	// L1. A deletes two of them.
	control('A deletes one.txt and two.txt through the editor\'s door',
		(await del(A, 'big/one.txt')) === 'done' && (await del(A, 'big/two.txt')) === 'done');
	await settle(A, B);
	const b1 = await paths(B);
	check('L1. B\'s index no longer names the two files A deleted', !b1.includes('big/one.txt') && !b1.includes('big/two.txt'), J(b1));
	check('L1. and B\'s own copy of one.txt is deleted', !(await held(B, 'big/one.txt')), '');
	check('L1. three.txt, deleted nowhere, is still on B', b1.includes('big/three.txt'), J(b1));

	// L2. B's push does not bring them back.
	await settle(B, A);
	const a2 = await paths(A), aw2 = await away(A);
	check('L2. after B pushes, A\'s index does not name them again', !a2.includes('big/one.txt') && !a2.includes('big/two.txt'), J(a2));
	check('L2. and A\'s file list does not show them in cloud storage', !aw2.includes('big/one.txt') && !aw2.includes('big/two.txt'), J(aw2));

	// L3. B deletes three.txt.
	control('B deletes three.txt', (await del(B, 'big/three.txt')) === 'done');
	await settle(B, A);
	const a3 = await paths(A);
	check('L3. a deletion made on B reaches A: A\'s index drops three.txt', !a3.includes('big/three.txt'), J(a3));
	check('L3. and A\'s own copy of three.txt is deleted', !(await held(A, 'big/three.txt')), '');
	await settle(A, B);
	control('L3. and it stays deleted on B after A pushes', !(await paths(B)).includes('big/three.txt'), J(await paths(B)));

	// L4. Written again, byte for byte: it comes back everywhere.
	await write(A, 'big/two.txt', TWO);
	const back = await round(A, B, async () => (await paths(B)).includes('big/two.txt'), 150000);
	control('L4. a file written again after its deletion, byte for byte, reaches B', back, J(await paths(B)));
	await settle(B, A);
	control('L4. and stays on A after B pushes', (await paths(A)).includes('big/two.txt') && await held(A, 'big/two.txt'), J(await paths(A)));

	// L5. Fixed point.
	await settle(A, B);
	const col = (s) => s.page.evaluate(async () => { const st = await DaimondCore.collectSync(); return JSON.stringify([st.chunked, st.chunkedTombs || null, st.files]); });
	const c1 = await col(A), c2 = await col(A);
	control('L5. two collects on A agree (the parcel is a fixed point)', c1 === c2);

	// ═══ F: a deletion while a push is in flight, then a 409 ═══════════════════
	await write(A, 'small/x.md', X);
	const gotX = await round(A, B, async () => (await read(B, 'small/x.md')) === X, 60000);
	await settle(A, B);
	control('setup: x.md is on both devices and in A\'s fork point', gotX && !!(await forkPoint(A))['small/x.md'],
		J({ gotX, fork: !!(await forkPoint(A))['small/x.md'] }));

	// Every POST A makes waits here until let go.
	const heldPosts = [];
	let holding = true;
	await A.page.route('**/api/sync**', async (route) => {
		const req = route.request();
		if (req.method() !== 'POST' || !holding) return route.continue();
		await new Promise((res) => heldPosts.push({ res, route }));
		return route.continue().catch(() => {});
	});
	const letGo = () => { const h = heldPosts.shift(); if (h) h.res(); return !!h; };
	const waitHeld = async (n, ms = 30000) => { const t0 = Date.now(); while (heldPosts.length < n && Date.now() - t0 < ms) await sleep(200); return heldPosts.length >= n; };

	await write(A, 'small/y.md', '# y.md\n\nthe change A is pushing\n');
	await A.page.evaluate(() => { window.__dsPush = Promise.resolve(window.DaimondSync.push()).catch(() => {}); });
	control('A\'s push is on the wire and held there', await waitHeld(1), 'held ' + heldPosts.length);
	control('x.md is deleted on A while that push flies', (await del(A, 'small/x.md')) === 'done');
	letGo();
	await A.page.evaluate(() => window.__dsPush);
	await sleep(500);
	const f1 = await forkPoint(A);
	check('F1. the landed push leaves x.md in A\'s fork point: it is what landed, and its deletion is unsent',
		!!f1['small/x.md'], J(Object.keys(f1).filter((p) => p.startsWith('small/'))));

	// B moves the mailbox on, carrying x.md as it holds it.
	await write(B, 'small/z.md', '# z.md\n\nB\'s change, which moves the mailbox on\n');
	await pull(B);
	await push(B);
	await sleep(500);
	control('B still holds x.md (it has not heard of the deletion)', (await read(B, 'small/x.md')) === X);

	// A's next push meets the 409.
	holding = false;
	while (letGo()) { /* every held POST goes */ }
	await A.page.unroute('**/api/sync**');
	await push(A);
	await sleep(800);
	check('F2. the 409\'s pull does not write x.md back on A', (await read(A, 'small/x.md')) === null,
		String(await read(A, 'small/x.md')).slice(0, 60));
	await settle(A, B);
	check('F2. and after the rounds settle it is still gone from A', (await read(A, 'small/x.md')) === null, '');
	check('F3. B deletes it too', (await read(B, 'small/x.md')) === null, String(await read(B, 'small/x.md')).slice(0, 60));
	control('B\'s own change reached A', (await read(A, 'small/z.md')) !== null);
} catch (e) {
	check('the run completes', false, (e && e.stack) || e);
} finally {
	if (B) await B.close().catch(() => {});
	if (A) await A.close().catch(() => {});
}

console.log(bad.length === 0 ? `\nall ${ok.length} checks passed` : `\n${bad.length} check(s) FAILED, ${ok.length} passed`);
process.exit(bad.length === 0 ? 0 : 1);
