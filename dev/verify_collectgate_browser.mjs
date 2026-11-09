// gateway: none
// verify_collectgate_browser.mjs -- COLLECT-GATE end to end in a real browser (QA ruling (a), UNBLOCK-111;
// the probe notes/quality_x/live_collect_diag_20261108.md "Proved and inferred" asks for).
//
// THE FAULT. A device whose chat store errors on the boot read unlocks on the legacy mirror. Nothing new is
// in the mailbox, so the next push passes every gate, and its collect reaps the `@c/` entry of every chat it
// did not read, and commits that index: the gateway then sweeps those transcripts.
//
// THE PROPERTY, on one real device (headless Chromium, its own profile) with a cloud stood up in this process:
//   1. five offloaded chats pushed and committed: the index holds @c/c1..c5 (the seed, not a check);
//   2. reloaded with every indexedDB.open of the chat database failing (onerror), the boot read does not land;
//   3. he renames a chat, and the device pulls and pushes as it does in life while the store still fails: no @c/
//      entry is dropped, and every commit made after the reload names all five chats' manifests;
//   4. the store answers again, and his next save is read back, synced and committed (no stuck state);
//   5. reloaded with the boot read failing once and the store answering after it, with no save and no Try
//      again: the device's own pulls read the store and its pushes are not held (PD3 r4 F1).
//
// --break base serves chatstore.js, parcel_apply.js, parcel_collect.js and sync.js with
// dev/red/collectgate/base.patch applied (this branch without COLLECT-GATE): the two step-3 checks go
// red (an @c/ entry dropped, a commit that leaves a manifest out), and nothing else. --break noreread
// serves parcel_apply.js with dev/red/pd3r4/m1_pullnoreread.patch (a pull refuses an unread store without
// reading it): the two step-5 checks go red, and nothing else.
//
//   node dev/verify_collectgate_browser.mjs                # green
//   node dev/verify_collectgate_browser.mjs --break base   # 2 red, both step 3
//   node dev/verify_collectgate_browser.mjs --break noreread   # 2 red, both step 5
//   CGPROBE_BREAK=base dk arms <env> collectgate_browser   # the same, as a dk arm
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (t) => console.log('        . ' + t);
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || dflt) : dflt; };
const BREAK = arg('--break', process.env.CGPROBE_BREAK || '');	// the env form is how dk arms runs the base arm
const BREAKS = { base: 'red/collectgate/base.patch', noreread: 'red/pd3r4/m1_pullnoreread.patch' };
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; only: ` + Object.keys(BREAKS).join(', ')); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') { console.error('--break serves edited files through page.route; run it under Chromium.'); process.exit(2); }

// ── The base, served on request ─────────────────────────────────────────
const PATCHED = new Map();
if (BREAK) {
	// Every file the patch names is served, so a re-cut that reaches a further file still applies.
	const SERVED = [...fs.readFileSync(path.join(HERE, BREAKS[BREAK]), 'utf8').matchAll(/^\+\+\+ b\/(\S+)/gm)].map(m => m[1]);
	const dir = scratch('cgprobe', 'base-' + process.pid);
	fs.rmSync(dir, { recursive: true, force: true });
	for (const f of SERVED) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); }
	execFileSync('patch', ['-s', '-p1', '-d', dir, '-i', path.join(HERE, BREAKS[BREAK])]);
	for (const f of SERVED) PATCHED.set(f.replace(/^www\//, ''), fs.readFileSync(path.join(dir, f), 'utf8'));
	fs.rmSync(dir, { recursive: true, force: true });
}
async function routes(page) {
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f + '*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
	// The boot read's failure: once the probe arms it, every open of the chat database fires onerror until the probe
	// lets the store answer (window.__cgFail = false). Failing only the first open is not enough: PD3's re-read on the
	// store's next answer reads it whole before any save, and the window closes on base and head alike.
	await page.addInitScript(() => {
		if (localStorage.getItem('cgprobe-fail') !== '1') return;
		localStorage.removeItem('cgprobe-fail');
		window.__opens = [];
		window.__cgFail = true;
		const real = IDBFactory.prototype.open;
		IDBFactory.prototype.open = function (name) {
			window.__opens.push(String(name));
			if (window.__cgFail && /^daimond-chats/.test(String(name))) {
				const req = { result: undefined, error: new DOMException('probe: the backing store would not open', 'UnknownError') };
				setTimeout(() => { if (typeof req.onerror === 'function') req.onerror({ target: req }); }, 0);
				window.__failedOpen = String(name);
				return req;
			}
			return real.apply(this, arguments);
		};
	});
}

// ── The cloud, in this process ──────────────────────────────────────────
const cloud = { mailbox: null, chunks: new Map(), commits: [] };
function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		// The side doors on the same path (`?presence=1`, `?removed=1`, `?lease=1`) are not the mailbox:
		// answered as accepted and never written over the parcel. A beat on an empty mailbox otherwise
		// lands as a blobless v1 that no device can open, and none is whole again.
		if (method !== 'GET' && String(rawPath).indexOf('?') !== -1) return { status: 200, json: { ok: true } };
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version, blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob)); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		if (body.op === 'commit') {
			cloud.commits.push({ at: body.blob_version, addrs: (body.chunks || []).map(c => c.addr) });
			return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } };
		}
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function patchCloud(s, dev) {
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}
const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.chatStore && window.DaimondCloud && window.DaimondSync),
	null, { timeout: 20000 });

const SEED_ROUNDS = 8;	// a quiet device settles in one round; the rest is room for a loaded host
const IDS = ['cg-c1', 'cg-c2', 'cg-c3', 'cg-c4', 'cg-c5'];
const T0 = 1758790000000;
const pad = (tag) => Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
	content: tag + ' ' + i + ' ' + 'p'.repeat(10000), mid: tag + 'pad' + i, ts: T0 - 1000 + i }));
const rec = (id) => ({ id, name: 'Collect gate ' + id, model: 'mock/fast', provider: '', updatedAt: T0, metaAt: T0, messages: pad(id), session: null });

// A round as the app runs one: a pull, then a flush (a push that collects and, if it may, commits).
const round = (pg) => pg.evaluate(async () => {
	const out = {};
	try { await DaimondSync.pull(); } catch (e) { out.pull = String(e && e.message || e); }
	try { await DaimondSync.flush(); } catch (e) { out.flush = String(e && e.message || e); }
	return out;
});
const why = (pg) => pg.evaluate(() => ({ why: DaimondCore.syncCommitBlockedReason ? DaimondCore.syncCommitBlockedReason() : '?',
	whole: DaimondCloud.wholeAt ? DaimondCloud.wholeAt() : '?', v: DaimondSync.version(), reaps: window.__reaps || [] }));
// Every reap of the chat index, with what the store had read when it ran.
const watchReaps = (pg) => pg.evaluate(() => {
	window.__reaps = [];
	const real = DaimondCloud.contentReap;
	DaimondCloud.contentReap = function (pre, live) {
		if (pre === '@c/') window.__reaps.push({ live: Object.keys(live || {}).length, read: DaimondCore.chatStore().read() });
		return real.apply(this, arguments);
	};
});
// A rename from the chat's tile, as he makes one.
async function rename(pg, cid, name) {
	await pg.evaluate(() => { const x = document.querySelector('.modal.dlg:not([hidden]) .dlg-cancel, .tile-dlg .tile-dlg-x'); if (x) x.click(); });
	await pg.evaluate((id) => document.querySelector('.chat-box[data-id="' + id + '"] .tile-cog').click(), cid);
	await pg.waitForSelector('.tile-dlg-name-input', { timeout: 8000 });
	await pg.fill('.tile-dlg-name-input', name);
	await pg.evaluate(() => document.querySelector('.tile-dlg-name-input').dispatchEvent(new Event('change')));
	await pg.keyboard.press('Escape').catch(() => {});
}
const cIndex = (pg) => pg.evaluate(() => {
	const ix = DaimondCloud.index() || {};
	const out = {};
	Object.keys(ix).filter(k => k.startsWith('@c/')).forEach(k => { out[k] = (ix[k].chunks || []).map(c => c.addr); });
	return out;
});
const storeState = (pg) => pg.evaluate(() => {
	const st = DaimondCore.chatStore();
	return { read: typeof st.read === 'function' ? st.read() : null, ids: st.stored().map(c => c.id),
		failedOpen: window.__failedOpen || '', opens: (window.__opens || []).length };
});

const PROFILE = scratch('pw', 'cgprobe-' + BROWSER + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });
let A = null;
try {
	console.log(`\n-- an unread chat store collects, reaps and commits nothing (COLLECT-GATE ruling (a))${BREAK ? '  [--break ' + BREAK + ']' : ''} --`);
	A = await open({ name: 'cgprobe', profile: PROFILE, signIn: false, connect: false, defaults: false, route: routes });
	await ready(A); await signInAs(A, 'cgprobe'); await ready(A);
	await A.page.exposeFunction('__cloudCall', async (p, method, body) => serve('A', p, method, body));
	await patchCloud(A, 'A');

	// ── 1. Five offloaded chats, pushed and committed.
	await A.page.evaluate(async (recs) => { const st = DaimondCore.chatStore(); st.save(st.stored().concat(recs)); await st.settled(); }, IDS.map(rec));
	// The seed is the probe's own set-up, not a product check: it runs rounds until the device is
	// whole at the mailbox version and its last commit names all five chats, or stops the probe.
	let seeded = null, ix0 = {};
	const named = () => cloud.commits.length > 0 && IDS.every(id => (ix0['@c/' + id] || []).length
		&& ix0['@c/' + id].every(a => cloud.commits[cloud.commits.length - 1].addrs.includes(a)));
	for (let i = 0; i < SEED_ROUNDS && !seeded; i++) {
		await round(A.page);
		const w = await why(A.page);
		ix0 = await cIndex(A.page);
		if (w.whole === w.v && w.v > 0 && named()) seeded = Object.assign({ rounds: i + 1 }, w);
	}
	if (!seeded) throw new Error('the seed did not settle in ' + SEED_ROUNDS + ' rounds: ' + JSON.stringify(Object.assign({ commits: cloud.commits.length }, await why(A.page))));
	note('seeded: ' + JSON.stringify(seeded));
	const v0 = cloud.mailbox ? cloud.mailbox.version : 0;

	// ── 2. Reload with the boot read failing once. The legacy archive (an older build's) holds c1, so
	// the rail shows a chat to rename, as on a device that migrated from localStorage.
	await A.page.evaluate((r) => {
		localStorage.setItem('daimond-chats-legacy', JSON.stringify([{ id: r.id, name: r.name, model: r.model, provider: '', updatedAt: r.updatedAt, metaAt: r.metaAt, messages: [] }]));
		localStorage.setItem('cgprobe-fail', '1');
	}, rec(IDS[0]));
	const nCommits = cloud.commits.length;
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(A); await signInAs(A, 'cgprobe'); await ready(A); await patchCloud(A, 'A');
	await watchReaps(A.page);
	await A.page.waitForTimeout(500);
	const s1 = await storeState(A.page);
	note('after the reload: ' + JSON.stringify(s1));
	check('2. the boot\'s open of the chat database failed and the store is unread', !!s1.failedOpen && s1.read === false, JSON.stringify({ failedOpen: s1.failedOpen, read: s1.read }));

	// ── 3. He renames c1 from its tile; the device pulls and pushes as in life.
	const cid = s1.ids.includes(IDS[0]) ? IDS[0] : (s1.ids[0] || '');
	await rename(A.page, cid, 'Renamed after a failed boot');
	note('at the rename: ' + JSON.stringify(Object.assign(await storeState(A.page), await why(A.page))));
	note('rounds after the rename: ' + JSON.stringify([await round(A.page), await round(A.page)]) + ' ' + JSON.stringify(await why(A.page)));
	const ix1 = await cIndex(A.page);	// while the store still fails
	const dropped = Object.keys(ix0).filter(k => !ix1[k]);
	const after = cloud.commits.slice(nCommits);
	const thin = after.filter(c => IDS.some(id => (ix0['@c/' + id] || []).some(a => !c.addrs.includes(a))));
	note('@c/ entries ' + Object.keys(ix0).length + ' -> ' + Object.keys(ix1).length + '; commits after the reload: ' + after.length);
	check('3. AND NO @c/ ENTRY OF AN UNREAD CHAT IS DROPPED', dropped.length === 0, JSON.stringify(dropped));
	check('3. AND NO COMMIT AFTER THE RELOAD LEAVES A CHAT\'S MANIFEST OUT', thin.length === 0,
		thin.length + ' of ' + after.length + ' commits leave some out');

	// ── 4. The store answers again; his next save lands, the store is read, and the save travels.
	await A.page.evaluate(() => { window.__cgFail = false; });
	await rename(A.page, cid, 'Renamed once the store answers');
	await A.page.waitForFunction(() => DaimondCore.chatStore().read() === true, null, { timeout: 30000 }).catch(() => {});
	note('rounds after the store answers: ' + JSON.stringify([await round(A.page)]) + ' ' + JSON.stringify(await why(A.page)));
	const s2 = await storeState(A.page);
	const blob = cloud.mailbox ? cloud.mailbox.version : 0;
	check('4. the store is read again and holds every chat', s2.read === true && IDS.every(id => s2.ids.includes(id)), JSON.stringify({ read: s2.read, n: s2.ids.length }));
	check('4. and the rename was pushed (the mailbox moved)', blob > v0, 'v' + v0 + ' -> v' + blob);
	const last = cloud.commits[cloud.commits.length - 1];
	check('4. and the device commits again, naming all five chats', cloud.commits.length > nCommits && IDS.every(id => (ix0['@c/' + id] || []).every(a => last.addrs.includes(a))),
		(cloud.commits.length - nCommits) + ' commits after the reload');

	// ── 5. Reload with the boot read failing once; the store answers from then on, and he saves nothing.
	await A.page.evaluate(() => localStorage.setItem('cgprobe-fail', '1'));
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(A); await signInAs(A, 'cgprobe'); await ready(A); await patchCloud(A, 'A');
	await A.page.waitForTimeout(500);
	const s5 = await storeState(A.page);
	note('step 5, after the reload: ' + JSON.stringify(s5));
	if (!(s5.failedOpen && s5.read === false)) throw new Error('step 5: the boot read did not fail: ' + JSON.stringify(s5));
	await A.page.evaluate(() => { window.__cgFail = false; });
	const flushes = [];
	for (let i = 0; i < 3; i++) {
		flushes.push(await A.page.evaluate(async () => {
			try { await DaimondSync.pull(); } catch (e) { /* the flush says what held */ }
			try { return await DaimondSync.flush(); } catch (e) { return String(e); }
		}));
		await A.page.waitForTimeout(500);
	}
	const s6 = await storeState(A.page);
	note('step 5, flushes with the store answering and no save: ' + JSON.stringify(flushes));
	check('5. the store is read without a save or Try again', s6.read === true && IDS.every(id => s6.ids.includes(id)), JSON.stringify({ read: s6.read, n: s6.ids.length }));
	check('5. and no flush is held', flushes.every(f => !(f && f.ok === false)), JSON.stringify(flushes));
} catch (e) {
	console.log('VERIFIER THREW:', e && (e.stack || e.message || e));
	bad.push('verifier threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	fs.rmSync(PROFILE, { recursive: true, force: true });
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break ' + BREAK + ': the 2 step-' + (BREAK === 'base' ? 3 : 5) + ' checks must FAIL)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
