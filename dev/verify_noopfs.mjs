// verify_noopfs.mjs -- a device whose browser cannot hold files (no OPFS, or an OPFS that throws)
// still syncs what it holds, says plainly what it cannot, and does not loop against the gateway.
//
// Found by the reopen rehearsal (specs/daimond_reopen_rehearsal_20260925.md): Playwright's WebKit
// has no `navigator.storage.getDirectory`, and the iPhone there was refused `POST /api/sync` 409 up
// to 48 times a minute, 365 requests in its busiest minute, while its own chats and three stale
// hand-offs never left it and the chip said nothing. A real iPhone has OPFS, but OPFS can be missing
// or fail on one: private browsing, storage evicted, an older iOS, a quota refusal. A storm of that
// shape is what got the owner's home network blocked once.
//
// Two devices on one account, one real gateway (fresh store) and the world's app server:
//
//   A  Chromium desktop with OPFS: a chat, and a workspace file over the inline ceiling, so the
//      account's chunk index names a workspace path (the merge's `refreshPaths` asks whether this
//      device holds it, which is the call that reaches OPFS).
//   P  the device under test (`--phone`):
//        webkit          Playwright's WebKit, which has no OPFS at all;
//        chromium-absent Chromium with `getDirectory` taken away (OPFS disabled);
//        chromium-throw  Chromium whose `getDirectory` rejects, as a private window or an evicted
//                        store does;
//        chromium-quota  Chromium whose store opens and refuses every write (QuotaExceededError),
//                        as a full disk does;
//        chromium        Chromium with OPFS, the control.
//      P pairs, runs a chat of its own, then sits for `--minutes` while A changes the account once a
//      minute, as a person using another device does.
//
// Asserted on P:
//   STORM   no minute with more than 30 gateway refusals, and no more than 40 requests in any minute
//           while nothing is typed on P (the rehearsal's own thresholds);
//   SENDS   P's chat reaches A, and A's chat reaches P;
//   SAYS    P's sync chip names the standing refusal in words when files cannot travel, and P's
//           `state()` reports it; the control says nothing of the kind.
//
//   eval "$(bash dev/world.sh 27 --up)"
//   RC_SLOT=claude-rc-2-r52o node dev/verify_noopfs.mjs --phone webkit [--minutes 4] [--gw <bin>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PW, CHROME, SCRATCH, signInAs, connectMock, newChat } from './harness.mjs';
import { cleanDisplayEnv } from './display.mjs';
import { makePagePro } from './pro.mjs';

const { chromium, webkit } = await import(pathToFileURL(PW).href);
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PHONE   = arg('--phone', 'webkit');
const MINUTES = Number(arg('--minutes', '4'));
const ACTIVE  = Number(arg('--active', '2'));
const GW_BIN  = arg('--gw', path.join(os.homedir(), '.cache/cargo-targets/claude-rc-2/lane-gw6-mr5/release/daimond_gateway'));
const OUT     = arg('--out', '');
if (!['webkit', 'chromium-absent', 'chromium-throw', 'chromium-quota', 'chromium'].includes(PHONE)) {
	console.log('refusing to run: --phone is webkit, chromium-absent, chromium-throw, chromium-quota or chromium');
	process.exit(2);
}
const PORT    = Number(process.env.DAIMOND_PORT || 0);
const GW_PORT = Number(process.env.DAIMOND_GW_PORT || 0);
const APP     = process.env.DAIMOND_APP || '';
if (!PORT || !GW_PORT || !APP) {
	console.log('refusing to run: eval "$(bash dev/world.sh N --up)" first');
	process.exit(2);
}
if (!fs.existsSync(GW_BIN)) { console.log('refusing to run: no gateway at ' + GW_BIN); process.exit(2); }

const RUN  = Date.now().toString(36);
const ROOT = path.join(SCRATCH, 'noopfs', RUN);
fs.mkdirSync(ROOT, { recursive: true });
const ACCOUNT = 'noopfs-' + RUN;
const MIN = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

const ok = [], bad = [], notes = [];
function check(name, pass, detail) {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
}
function note(s) { notes.push(s); console.log('  note ' + s); }

// ── The gateway: the live binary, a fresh store ────────────────────────────
let gwProc = null;
async function startGateway() {
	const cwd = path.join(ROOT, 'gwcwd');
	fs.mkdirSync(cwd, { recursive: true });
	execFileSync('bash', ['dev/devgw.sh'], { cwd: TREE, env: Object.assign({}, process.env, { DAIMOND_GW_PORT: String(GW_PORT) }) });
	fs.copyFileSync(path.join(TREE, 'dev/devgw/app.jdat'), path.join(cwd, 'app.jdat'));
	if (!fs.readFileSync(path.join(cwd, 'app.jdat'), 'utf8').includes(`(u16|${GW_PORT})`)) throw new Error('gateway config is not on ' + GW_PORT);
	fs.symlinkSync(fs.realpathSync(path.join(TREE, 'gateway/keys')), path.join(cwd, 'keys'));
	const out = fs.openSync(path.join(ROOT, 'gateway.out'), 'a');
	gwProc = spawn(GW_BIN, [], { cwd, stdio: ['ignore', out, out], env: Object.assign({}, process.env, { APP_MODE: 'sandbox' }) });
	for (let i = 0; i < 60; i++) {
		try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/health`); if (r.ok) return; } catch (e) { /* not yet */ }
		await sleep(500);
	}
	throw new Error('the gateway did not come up on ' + GW_PORT);
}
function stopGateway() { try { gwProc && gwProc.kill('SIGTERM'); } catch (e) { /* gone */ } }
process.on('exit', stopGateway);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopGateway(); process.exit(130); });

// ── Devices ────────────────────────────────────────────────────────────────
function device(key, label, engine, opfs) {
	return { key, label, engine, opfs, profile: path.join(ROOT, 'pw-' + key), reqs: [], resps: [], warns: [], ctx: null, page: null };
}
const A = device('a', 'desktop A', 'chromium', 'real');
const P = device('p', 'device P (' + PHONE + ')', PHONE === 'webkit' ? 'webkit' : 'chromium',
	PHONE === 'chromium-absent' ? 'absent' : PHONE === 'chromium-throw' ? 'throw' : PHONE === 'chromium-quota' ? 'quota'
		: PHONE === 'webkit' ? 'engine' : 'real');

async function launch(d) {
	const env = cleanDisplayEnv(process.env);
	delete env.DISPLAY;
	fs.mkdirSync(d.profile, { recursive: true });
	const viewport = { width: 1280, height: 860 };
	if (d.engine === 'webkit') {
		d.ctx = await webkit.launchPersistentContext(d.profile, { headless: true, env, viewport });
	} else {
		d.ctx = await chromium.launchPersistentContext(d.profile, {
			executablePath: CHROME, headless: false, env, viewport,
			args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
		});
	}
	// OPFS taken away, or made to refuse, before any script of the app runs. The prototype, so the
	// wasm's own binding (web_sys calls `StorageManager.prototype.getDirectory`) meets it too.
	if (d.opfs === 'absent') {
		await d.ctx.addInitScript(() => { try { delete StorageManager.prototype.getDirectory; } catch (e) { /* none */ } });
	} else if (d.opfs === 'quota') {
		// The store opens, and every write into it is refused as a full disk refuses it --
		// until `window.__DAIMOND_QUOTA_FULL__` is set false, as freeing space on the real
		// disk would. Re-run on every document this context loads (the reload below
		// included), so it starts full again each time and the toggle is the test's own.
		await d.ctx.addInitScript(() => {
			try {
				window.__DAIMOND_QUOTA_FULL__ = true;
				const orig = FileSystemFileHandle.prototype.createWritable;
				FileSystemFileHandle.prototype.createWritable = function () {
					if (window.__DAIMOND_QUOTA_FULL__) {
						return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
					}
					return orig.apply(this, arguments);
				};
			} catch (e) { /* none */ }
		});
	} else if (d.opfs === 'throw') {
		await d.ctx.addInitScript(() => {
			try {
				StorageManager.prototype.getDirectory = function () {
					return Promise.reject(new DOMException('The request is not allowed by the user agent or the platform in the current context.', 'SecurityError'));
				};
			} catch (e) { /* none */ }
		});
	}
	await d.ctx.addInitScript(() => {
		try { localStorage.setItem('daimond-policy', JSON.stringify({ v: 1, expire: 3650, retain: 30, high: 30 })); }
		catch (e) { /* private mode */ }
	});
	d.ctx.on('request', (r) => {
		let u; try { u = new URL(r.url()); } catch (e) { return; }
		if (!u.pathname.startsWith('/api')) return;
		let op = '';
		if (u.pathname === '/api/chunk') { try { op = (JSON.parse(r.postData() || '{}').op) || ''; } catch (e) { op = '?'; } }
		d.reqs.push({ t: Date.now(), k: r.method() + ' ' + u.pathname + (op ? ':' + op : '') });
	});
	d.ctx.on('response', (r) => {
		let u; try { u = new URL(r.url()); } catch (e) { return; }
		if (!u.pathname.startsWith('/api')) return;
		d.resps.push({ t: Date.now(), k: r.request().method() + ' ' + u.pathname + ' ' + r.status(), status: r.status() });
	});
	d.page = d.ctx.pages()[0] || await d.ctx.newPage();
	d.page.on('console', (m) => {
		const tx = m.text();
		if (/merge failed in section|\[sync\]/.test(tx) && (m.type() === 'warning' || m.type() === 'error')) d.warns.push(tx.slice(0, 300));
	});
	d.page.on('dialog', (dl) => { dl.dismiss().catch(() => {}); });
	d.page.setDefaultTimeout(60000);
	d.s = { page: d.page, errs: [], logs: [], net: [], name: ACCOUNT, foreign: [], browser: d.ctx };
	await d.page.goto(APP, { waitUntil: 'domcontentloaded' });
}
const E = (d, fn, a) => d.page.evaluate(fn, a);
const ready = (d, ms = 90000) => d.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore
	&& window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: ms }).then(() => true).catch(() => false);
async function gateUp(d) {
	await d.page.waitForFunction(() => {
		const b = document.getElementById('id-primary');
		if (b && b.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 120000 }).catch(() => {});
}

async function typeTurn(d, text, wait = 45000) {
	await d.page.waitForSelector('#chat-input', { timeout: 20000 });
	await d.page.fill('#chat-input', text);
	await E(d, () => document.getElementById('chat-send').click());
	await sleep(400);
	for (const t0 = Date.now(); Date.now() - t0 < wait; ) {
		const busy = await E(d, () => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			return /stop/i.test((b.getAttribute('title') || '') + (b.className || '')) || b.disabled;
		}).catch(() => false);
		if (!busy) break;
		await sleep(300);
	}
	await sleep(500);
}
async function syncRound(devs) {
	for (const d of devs) await E(d, () => (window.DaimondSync.flush ? DaimondSync.flush() : DaimondSync.push())).catch(() => {});
	for (const d of devs) await E(d, () => DaimondSync.pull()).catch(() => {});
	await sleep(1500);
}
/// Does the device's chat store hold a message carrying `needle`?
const holds = (d, needle) => E(d, async (n) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		for (const m of ((got && got.messages) || [])) {
			const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
			if (c.indexOf(n) >= 0) return true;
		}
	}
	return false;
}, needle).catch(() => false);
const chip = (d) => E(d, () => {
	const c = document.getElementById('sync-chip');
	const st = window.DaimondSync && DaimondSync.state ? DaimondSync.state() : null;
	return { shown: !!(c && c.style.display !== 'none'), state: c ? c.dataset.state || '' : '',
		text: c ? (c.textContent || '').trim() : '', title: c ? (c.getAttribute('title') || '') : '', sync: st };
}).catch((e) => ({ error: String(e) }));

// ── Rates ──────────────────────────────────────────────────────────────────
function rate(d, from, to) {
	const inWin = d.reqs.filter((r) => r.t >= from && r.t < to);
	const per = {}, errPer = {}, top = {}, ans = {};
	for (const r of inWin) {
		const k = Math.floor((r.t - from) / MIN);
		per[k] = (per[k] || 0) + 1;
		top[r.k] = (top[r.k] || 0) + 1;
	}
	for (const r of d.resps.filter((r) => r.t >= from && r.t < to)) {
		ans[r.k] = (ans[r.k] || 0) + 1;
		if (r.status >= 400 && r.status !== 401 && r.status !== 402) { const k = Math.floor((r.t - from) / MIN); errPer[k] = (errPer[k] || 0) + 1; }
	}
	const mins = Math.max(1, Math.ceil((to - from) / MIN));
	const perMin = [], errMin = [];
	for (let i = 0; i < mins; i++) { perMin.push(per[i] || 0); errMin.push(errPer[i] || 0); }
	const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '×' + v).join(', ');
	return { n: inWin.length, perMin, errMin, max: Math.max(0, ...perMin), errMax: Math.max(0, ...errMin),
		top: sort(top), answered: sort(ans) };
}

const record = { run: RUN, phone: PHONE, app: APP, tree: TREE, gw: GW_BIN, minutes: MINUTES };
try {
	await startGateway();
	const served = await (await fetch(APP + '/build.json', { cache: 'no-store' })).json().catch(() => ({}));
	record.build = served.build || '';
	note(`run ${RUN}: app ${APP} build ${record.build}, gateway :${GW_PORT} fresh store, P is ${PHONE}`);

	// ═══ A: the account, a chat, a large workspace file ═════════════════════
	await launch(A);
	await gateUp(A);
	await signInAs(A.s, ACCOUNT);
	check('A signed in and reached the gateway', await ready(A));
	const pro = await makePagePro(A.page, path.join(TREE, 'gateway'), `http://127.0.0.1:${GW_PORT}`);
	check('the account holds Pro, so sync runs', pro.pro === true, J(pro));
	await connectMock(A.s);
	await newChat(A.s);
	await typeTurn(A, '@text NOOPFS-A-1 from the desktop');
	check('A holds its own chat', await holds(A, 'NOOPFS-A-1'));
	// Over the inline ceiling (128 KiB), so it travels as chunks and the index names its path.
	// A small one too (well under the ceiling), which travels inline in `remote.files` and is
	// what a quota-refused P must adopt through `writeSyncFile` (see the QUOTA section below).
	const big = await E(A, async () => {
		const M = await import('/pkg/oxedyne_daimond.js');
		const line = 'The large workspace file that travels as chunks. ';
		await M.store_write('notes/big.txt', line.repeat(Math.ceil(200 * 1024 / line.length)));
		await M.store_write('notes/small.txt', 'NOOPFS-SMALL-1 an inline file synced from the desktop');
		return true;
	}).catch((e) => String(e));
	for (let i = 0; i < 3; i++) await syncRound([A]);
	const ixA = await E(A, () => Object.keys(DaimondCloud.index()));
	check('A\'s chunk index names the workspace path', ixA.includes('notes/big.txt'), J({ big, keys: ixA.slice(0, 12) }));

	// ═══ P: paired, a chat of its own ════════════════════════════════════════
	await launch(P);
	await P.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 120000 }).catch(() => {});
	const opfs = await E(P, async () => {
		if (!(navigator.storage && navigator.storage.getDirectory)) return 'absent';
		try { await navigator.storage.getDirectory(); return 'works'; } catch (e) { return 'throws: ' + (e && e.name); }
	});
	note('P\'s OPFS: ' + opfs);
	check('P\'s OPFS is as the mode says', (PHONE === 'chromium' || PHONE === 'chromium-quota') ? opfs === 'works' : opfs !== 'works', opfs);
	const code = await E(A, () => DaimondPairing.create());
	const red = await E(P, (c) => DaimondPairing.redeem(c).then(() => 'ok', (e) => 'err: ' + e.message), code && code.code);
	check('P paired with A', red === 'ok', red);
	await P.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(P);
	await signInAs(P.s, ACCOUNT);
	check('P signed in and reached the gateway', await ready(P));
	await connectMock(P.s);
	await newChat(P.s);
	await typeTurn(P, '@text NOOPFS-P-1 from the device without OPFS');
	check('P holds its own chat', await holds(P, 'NOOPFS-P-1'));

	// ═══ QUOTA only: a refused OPFS write is not silent, and it clears (reopen rehearsal, ════
	// "Left" item 1). A's small inline file must travel to P through `writeSyncFile`, which
	// `--phone chromium-quota`'s every `createWritable` refuses with `QuotaExceededError`
	// while `window.__DAIMOND_QUOTA_FULL__` stands: on the base page the file is silently
	// dropped and the chip goes on reading "Synced"; on the fix the standing files alarm
	// names it, and it clears once space frees and a write lands.
	//
	// A REFUSED `createWritable` still leaves an empty file behind: `getFileHandle(…,
	// {create:true})` is not what this test overrides, so the write's failed FIRST attempt at
	// `notes/small.txt` can itself leave a 0-byte file there -- a real quota refusal can do the
	// same. `applyFiles` then reads that path as changed on both sides and files the real bytes
	// beside it as `notes/small.txt.synced` rather than overwriting it (the same-path conflict
	// rule, `www/js/daimond.js`), so a second, UNTOUCHED path (`notes/small2.txt`, written only
	// once quota clears) is what proves a write "lands" here -- not a re-check of the first path.
	if (PHONE === 'chromium-quota') {
		const readFile = (d, p) => E(d, async (path) => {
			try { const M = await import('/pkg/oxedyne_daimond.js'); return await M.store_read(path); }
			catch (e) { return null; }
		}, p).catch(() => null);
		const alarmBox = (d) => E(d, () => {
			const box = document.querySelector('.storage-alarm');
			const why = box ? (box.querySelector('.storage-alarm-why') || {}).textContent || '' : '';
			return { shown: !!box, why: why };
		}).catch((e) => ({ error: String(e) }));

		await E(P, () => DaimondSync.pull()).catch(() => {});
		await sleep(2000);
		const beforeWrite = await readFile(P, 'notes/small.txt');
		check('QUOTA: the small synced file\'s real bytes are NOT written while storage reads full',
			!(typeof beforeWrite === 'string' && beforeWrite.indexOf('NOOPFS-SMALL-1') >= 0), J(beforeWrite));
		const raised = await alarmBox(P);
		record.quotaAlarmRaised = raised;
		note('P\'s storage alarm while full: ' + J(raised));
		// Round 2 (lane K, 2026-09-25): the files source now falls back to `store.full`,
		// the app's existing storage-full wording (owner ruling: one message for one
		// condition, not lane H's bespoke `store.files_full` prose) -- "no room left",
		// not the word "full" itself.
		check('QUOTA: the storage alarm is raised, naming this browser\'s storage out of room',
			raised.shown && /storage/i.test(raised.why) && /no room left/i.test(raised.why), J(raised));

		// Space frees up, as it would on a real device: the next write that lands clears it.
		// `pullOnce` skips `applyParcel` outright at an unchanged, already-adopted version
		// (`www/js/sync.js` ~2070), so a bare re-pull would not retry the write; a genuine new
		// version from A is what a real pull earns, same as any other retry here.
		await E(P, () => { window.__DAIMOND_QUOTA_FULL__ = false; return true; });
		await E(A, async () => {
			const M = await import('/pkg/oxedyne_daimond.js');
			await M.store_write('notes/small2.txt', 'NOOPFS-SMALL-2 a second inline file, untouched by the first refusal');
			return true;
		}).catch(() => {});
		await syncRound([A]);
		await E(P, () => DaimondSync.pull()).catch(() => {});
		await sleep(2000);
		const afterWrite = await readFile(P, 'notes/small2.txt');
		check('QUOTA: a file synced once storage has room lands with its real bytes',
			typeof afterWrite === 'string' && afterWrite.indexOf('NOOPFS-SMALL-2') >= 0, J(afterWrite));
		const cleared = await alarmBox(P);
		record.quotaAlarmCleared = cleared;
		note('P\'s storage alarm after the write landed: ' + J(cleared));
		check('QUOTA: the alarm clears once the write lands',
			!cleared.shown || !/storage/i.test(cleared.why) || !/full/i.test(cleared.why), J(cleared));
	}

	// ═══ In use: P sends a turn every 15 s, each followed by the flush a hand-off's ════
	// dispatcher makes (daimond.js `dispatchTurn` flushes the parcel on every hand-off), for
	// ACTIVE minutes, while A changes the account once a minute.
	const ta = Date.now();
	for (let k = 0; k < ACTIVE * 4; k++) {
		const tk = Date.now();
		if (k % 4 === 0) {
			await typeTurn(A, `@text NOOPFS-A-busy-${k} a change on the desktop`);
			await E(A, () => (window.DaimondSync.flush ? DaimondSync.flush() : DaimondSync.push())).catch(() => {});
		}
		await typeTurn(P, `@text NOOPFS-P-busy-${k} a turn on the device`);
		await E(P, () => { window.DaimondSync.flush().catch(() => {}); return true; }).catch(() => {});
		await sleep(Math.max(0, 15000 - (Date.now() - tk)));
	}
	const tb = Date.now();
	const ra = rate(P, ta, tb);
	record.rateActive = ra;
	note(`P in use, per minute ${J(ra.perMin)}, refused per minute ${J(ra.errMin)}; ${ra.top}`);
	note(`P in use, answered: ${ra.answered}`);
	check('STORM: in use, no minute on P with more than 30 gateway refusals', ra.errMax <= 30, `refused at most ${ra.errMax}/min`);

	// ═══ The watch: P left alone, A changing the account once a minute ══════
	const t0 = Date.now();
	for (let m = 0; m < MINUTES; m++) {
		const tm = Date.now();
		if (m < MINUTES - 1) {
			await typeTurn(A, `@text NOOPFS-A-tick-${m} another change on the desktop`);
			await E(A, () => (window.DaimondSync.flush ? DaimondSync.flush() : DaimondSync.push())).catch(() => {});
		}
		await sleep(Math.max(0, MIN - (Date.now() - tm)));
	}
	const t1 = Date.now();
	const r = rate(P, t0, t1);
	record.rate = r;
	record.rateA = rate(A, t0, t1);
	note(`P per minute ${J(r.perMin)}, refused per minute ${J(r.errMin)}; ${r.top}`);
	note(`P answered: ${r.answered}`);
	note(`A per minute ${J(record.rateA.perMin)}`);
	check('STORM: no minute on P with more than 30 gateway refusals', r.errMax <= 30, `refused at most ${r.errMax}/min`);
	check('STORM: no minute on P with more than 40 requests, nobody typing on it', r.max <= 40, `busiest minute ${r.max}, ${r.n} in ${Math.round((t1 - t0) / 1000)} s`);

	// ═══ What travelled ═══════════════════════════════════════════════════════
	await E(A, () => DaimondSync.pull()).catch(() => {});
	await sleep(1500);
	check('SENDS: P\'s chat reached A', await holds(A, 'NOOPFS-P-1'));
	check('SENDS: P\'s turns in use reached A', await holds(A, `NOOPFS-P-busy-${ACTIVE * 4 - 1}`));
	check('SENDS: A\'s chat reached P', await holds(P, 'NOOPFS-A-1'));
	check('SENDS: A\'s latest change reached P', await holds(P, `NOOPFS-A-tick-${Math.max(0, MINUTES - 2)}`));
	const keptA = await E(A, async () => {
		const f = await DaimondCloud.fileAt('notes/big.txt').catch(() => null);
		return { indexed: Object.keys(DaimondCloud.index()).includes('notes/big.txt'), bytes: f ? f.size : -1 };
	}).catch((e) => ({ error: String(e) }));
	check('LOST: A still holds its large file and the index still names it', keptA.indexed && keptA.bytes > 128 * 1024, J(keptA));
	const said = await chip(P);
	record.chip = said;
	note('P\'s chip: ' + J({ shown: said.shown, state: said.state, text: said.text, title: said.title }));
	note('P\'s sync state: ' + J(said.sync));
	if (P.opfs === 'real' || P.opfs === 'quota') {
		check('SAYS: the control device reports no file refusal', !(said.sync && said.sync.filesHeld === false), J(said.sync && said.sync.filesWhy));
	} else {
		check('SAYS: P\'s state reports that files cannot be held here', !!(said.sync && said.sync.filesHeld === false), J(said.sync && { filesHeld: said.sync.filesHeld, filesWhy: said.sync.filesWhy }));
		check('SAYS: P\'s chip names it in words', said.shown && /file/i.test(said.text + ' ' + said.title), J({ text: said.text, title: said.title }));
	}
	check('P\'s sync is not stalled on a merge', !(said.sync && said.sync.stalledWhy === 'merge') && !((said.sync && said.sync.failedParts) || []).length,
		J(said.sync && { stalledWhy: said.sync.stalledWhy, failedParts: said.sync.failedParts, busyWith: said.sync.busyWith }));
	record.warns = P.warns.slice(0, 20);
	if (P.warns.length) note('P warned: ' + J([...new Set(P.warns)].slice(0, 6)));
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
} finally {
	for (const d of [A, P]) { try { await d.ctx?.close(); } catch (e) { /* gone */ } }
	stopGateway();
	record.ok = ok; record.bad = bad; record.notes = notes;
	if (OUT) fs.writeFileSync(OUT, JSON.stringify(record, null, 1));
	console.log(`\n${ok.length} passed, ${bad.length} failed (run ${RUN}, ${PHONE})`);
	// Only this run's own directory, and only when it is where this file put it.
	if (!argv.includes('--keep') && SCRATCH && ROOT.startsWith(path.join(SCRATCH, 'noopfs') + path.sep) && ROOT.endsWith(RUN)) {
		try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* kept */ }
	}
	process.exit(bad.length ? 1 : 0);
}
