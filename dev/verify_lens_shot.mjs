// gateway: own
// verify_lens_shot — the Lens takes a picture of one of the owner's own devices, and of nothing else (D-20261006-14).
//
// The owner runs `node dev/lens.mjs shot --device D` and gets a PNG of what D shows. What is held here:
//
//   1. the page carries `DaimondLensShot`, and Settings offers "Allow Lens screenshots on this device" to the
//      owner and to nobody else;
//   2. with the setting off the owner's device is not pictured: the ask goes unanswered, no toast, no file;
//   3. a non-owner who turns it on anyway (from the console, not the UI) is refused by the gateway (403) and
//      is never pictured;
//   4. with it on, a toast is shown and the picture is filed, pulled and archived by the Lens, and it holds the
//      visible Diamond page's own content (a page filled with one colour, which the labelled stand-in box
//      would not have);
//   5. a second ask inside 60 s is refused with the time to wait, and the device is not troubled;
//   6. the Lens's copies are kept 7 days: `pull` drops an 8-day-old picture from the mirror and the archive.
//
// Its own gateway (an empty store, its debug-trace directory in scratch) and its own front door, on the ports
// of world DAIMOND_WORLD (default 99): app 8777+N, gateway 9700+N. The world must be DOWN.
//
//   DAIMOND_WORLD=99 node dev/verify_lens_shot.mjs

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, GWBIN, GWDIR, openBeta, procLog,
	stopGatewayCleanly } from './gwbin.mjs';

const HERE     = path.dirname(fileURLToPath(import.meta.url));
const ROOT     = path.join(HERE, '..');
const WORLD    = Number(process.env.DAIMOND_WORLD || 99);
const APP_PORT = 8777 + WORLD;
const GW_PORT  = 9700 + WORLD;
const APP_URL  = `http://localhost:${APP_PORT}`;
const GW_URL   = `http://127.0.0.1:${GW_PORT}`;
const SCRATCH  = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK     = path.join(SCRATCH, 'verify_lens_shot');
const GWWORK   = path.join(WORK, 'gw');
const TRACES   = path.join(WORK, 'traces');	// the gateway's debug-trace directory
const LENS     = path.join(WORK, 'lens');		// the Lens's own home
const PROFILE  = path.join(WORK, 'profile-own');
const GW_LOG   = procLog('verify_lens_shot');
const SRV_LOG  = procLog('verify_lens_shot', 'server');
const PAGE_RGB = [255, 0, 170];			// the Diamond page's one colour

process.env.DAIMOND_PORT = String(APP_PORT);
const { open, signInAs, errors } = await import('./harness.mjs');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, gap = 200) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) { /* not yet */ }
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}
async function held(port) {
	try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); return true; }
	catch (e) { return false; }
}

/// `dev/lens.mjs` against this run's gateway directory, as the owner would run it.
///
/// Asynchronous on purpose: the harness serves the pages' requests from this process, so a
/// synchronous child held every page's fetch for the whole wait, and no device could ever
/// have answered (nor been seen not to).
function lens(args) {
	return new Promise((resolve) => {
		execFile(process.execPath, [path.join(HERE, 'lens.mjs'), ...args, '--json'], {
			cwd: ROOT, encoding: 'utf8', timeout: 180000,
			env: { ...process.env, DAIMOND_LENS_HOME: LENS, DAIMOND_LENS_REMOTE: TRACES + '/' },
		}, (e, stdout, stderr) => {
			const out = e ? String(stdout || '') + String(stderr || '') : String(stdout);
			const code = !e ? 0 : (typeof e.code === 'number' ? e.code : -1);
			resolve({ code, out, j: lastJson(out) });
		});
	});
}
function lastJson(out) {
	const ls = String(out).trim().split('\n').reverse();
	for (const l of ls) { try { return JSON.parse(l); } catch (e) { /* not this line */ } }
	return null;
}

let gw = null, srv = null;
function startGateway(owner) {
	gw = spawn(GWBIN, [], {
		cwd: GWWORK,
		env: { ...process.env, APP_MODE: 'sandbox', DAIMOND_DEBUG_TRACE_DIR: TRACES,
			...(owner ? { DAIMOND_OWNER_ACCOUNTS: owner } : {}) },
		stdio: GW_LOG.stdio,
	});
	return waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok, 30000);
}
function cleanup() {
	for (const p of [gw, srv]) { try { if (p) p.kill(); } catch (e) { /* gone */ } }
	gw = null; srv = null;
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

function buildWork() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(GWWORK, 'keys'), { recursive: true });
	fs.mkdirSync(TRACES, { recursive: true });
	fs.mkdirSync(LENS, { recursive: true });
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(GWWORK, 'keys', k));
	}
	let cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${GW_PORT})`);
	if (!cfg.includes(`(u16|${GW_PORT})`)) {
		console.log('  FAIL could not set the listen port in the copied app.jdat');
		process.exit(1);
	}
	fs.writeFileSync(path.join(GWWORK, 'app.jdat'), openBeta(cfg, 'verify_lens_shot'));
}

/// The device's account and Lens id, once it has a gateway session.
async function who(s) {
	return s.page.evaluate(async () => {
		try { await window.DaimondGateway.bootstrap(); } catch (e) { /* read the state */ }
		const st = window.DaimondGateway.state();
		return { acct: String(st.accountId || ''), dev: String(window.DaimondIdentity.deviceId() || '') };
	});
}

/// Every toast the page shows from now on, by its text.
async function watchToasts(s) {
	await s.page.evaluate(() => {
		window.__toasts = [];
		new MutationObserver((ms) => {
			for (const m of ms) for (const n of m.addedNodes) {
				if (n.classList && n.classList.contains('daimond-toast')) window.__toasts.push(n.textContent);
			}
		}).observe(document.body, { childList: true });
	});
}
const toasts = (s) => s.page.evaluate(() => window.__toasts || []);

/// Opens the Home drawer and says whether the Lens item is in it.
async function drawerHasItem(s) {
	const { page } = s;
	await page.evaluate(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
	await page.waitForTimeout(400);
	await page.click('#user-row', { force: true });
	// The role is asked when the drawer is drawn, and the drawer redraws on the answer.
	await page.waitForTimeout(2500);
	const secs = await page.$$eval('.admin-sec', els => els.length);
	const item = await page.$('[data-lensshot]');
	return { open: secs > 0, item };
}

async function makePageDiamond(page) {
	// Made through the app's own store call, as `createDiamond` does after its dialog: the
	// dialog is not under test, and with no model connected it rightly refuses to create.
	const html = '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:rgb('
		+ PAGE_RGB.join(',') + ')}</style></head><body><h1 style="color:#fff">Lens</h1>'
		// The Crystal protocol's handshake: a page that never says `ready` is replaced by the fallback.
		+ '<script>function post(o){o.dc=1;o.v=1;parent.postMessage(o,"*");}'
		+ 'addEventListener("message",function(e){var m=e.data;if(!m||m.dc!==1||m.cmd!=="data")return;'
		+ 'post({cmd:"rendered",keys:Object.keys(m.data).filter(function(k){return k[0]!=="_";})});});'
		+ 'post({cmd:"ready"});<\/script></body></html>';
	return page.evaluate(async (html) => {
		try {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			const id = await app.create_diamond('LensShotPage');
			// A Crystal with no data has no keys and is never mounted, page or not.
			await app.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + id + '/crystal.json', content: JSON.stringify({ title: 'Lens' }) }));
			await app.write_crystal_page(id, html);
			return { id, why: id };
		} catch (e) { return { id: '', why: String(e && e.message || e) }; }
	}, html);
}

async function showCrystal(page) {
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(700);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	const up = await waitFor(async () => {
		const st = await page.evaluate(() => window.DaimondCrystal ? DaimondCrystal._state() : null);
		return st && st.mode === 'frame' && st.keys.length;
	}, 10000, 250);
	await page.waitForTimeout(800);
	return up;
}

/// The share of the frame's rectangle that is the page's colour, read in a browser from the PNG.
async function pageShare(page, file, rect) {
	const b64 = fs.readFileSync(file).toString('base64');
	return page.evaluate(async ({ b64, rect, rgb }) => {
		const img = new Image();
		await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
		const k = img.width / Math.max(1, window.innerWidth);
		const cv = document.createElement('canvas');
		cv.width = img.width; cv.height = img.height;
		const g = cv.getContext('2d');
		g.drawImage(img, 0, 0);
		const x = Math.round(rect.x * k), y = Math.round(rect.y * k);
		const w = Math.max(1, Math.round(rect.w * k)), h = Math.max(1, Math.round(rect.h * k));
		const d = g.getImageData(x, y, w, h).data;
		let hit = 0;
		for (let i = 0; i < d.length; i += 4) {
			if (Math.abs(d[i] - rgb[0]) < 12 && Math.abs(d[i + 1] - rgb[1]) < 12 && Math.abs(d[i + 2] - rgb[2]) < 12) hit++;
		}
		return { share: hit / (w * h), w: img.width, h: img.height };
	}, { b64, rect, rgb: PAGE_RGB });
}

(async () => {
	requireFreshGateway();
	for (const p of [APP_PORT, GW_PORT]) {
		if (await held(p)) {
			console.log(`  FAIL :${p} is already answering. World ${WORLD} must be down (dev/world.sh ${WORLD} --down).`);
			process.exit(1);
		}
	}
	buildWork();
	check('this run\'s own gateway is up, on an empty store', await startGateway(''), GW_URL);
	srv = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
		cwd: ROOT,
		env: { ...process.env, DAIMOND_PORT: String(APP_PORT), DAIMOND_GW_PORT: String(GW_PORT) },
		stdio: SRV_LOG.stdio,
	});
	check('and its own front door', await waitFor(async () => (await fetch(`${APP_URL}/index.html`)).ok), APP_URL);

	let A = null, B = null;
	try {
		A = await open({ name: 'lensown', connect: false, profile: PROFILE });
		B = await open({ name: 'lensother', connect: false });
		const a = await who(A), b = await who(B);
		check('both devices hold an account and a device id', !!(a.acct && a.dev && b.acct && b.dev),
			`A ${a.acct.slice(0, 8)}/${a.dev.slice(0, 8)} B ${b.acct.slice(0, 8)}/${b.dev.slice(0, 8)}`);

		// An owner is named by account id, known only now, so the gateway restarts with A's.
		const note = await stopGatewayCleanly(gw, `${GW_URL}/api/health`);
		if (note) console.log(note);
		check('the gateway restarts with A as its owner', await startGateway(a.acct));
		// A real owner's gateway has owner_accounts from its start; these pages asked
		// `whoami` of the owner-less one and were rightly told 'none'. Reloaded, they
		// boot against the gateway as it now stands (a reload lands on the lock screen).
		for (const s of [A, B]) {
			await s.page.reload({ waitUntil: 'domcontentloaded' });
			await signInAs(s, s.name);
			await who(s);
		}
		// What the pages logged while this run took their gateway away is the restart's, not theirs.
		const quiet = new Map([A, B].map(s => [s, errors(s).length]));

		// ── 1. the page and the Settings item ────────────────────────────
		console.log('\n1. the page carries the Lens picture, and only the owner is offered it');
		const has = await A.page.evaluate(() => !!window.DaimondLensShot);
		check('the page carries DaimondLensShot (js/lensshot.js is in index.html)', has);
		const dA = await drawerHasItem(A);
		check('the owner\'s Settings offer "Allow Lens screenshots on this device"', dA.open && !!dA.item,
			dA.item ? await dA.item.textContent() : 'no [data-lensshot] item');
		const dB = await drawerHasItem(B);
		check('a non-owner\'s Settings do not', dB.open && !dB.item, dB.open ? '' : 'the drawer did not open');
		check('and it is off until turned on', has && !(await A.page.evaluate(() => DaimondLensShot.enabled())));

		// ── 2. opt-in off ────────────────────────────────────────────────
		console.log('\n2. off: the owner\'s device is not pictured');
		await watchToasts(A);
		const off = await lens(['shot', '--device', a.dev, '--wait', '15']);
		check('an ask to a device with the setting off goes unanswered, and is withdrawn',
			off.code !== 0 && !!off.j && off.j.timeout === true && off.j.withdrawn === true, off.out.trim().split('\n').pop());
		check('and no toast was shown', (await toasts(A)).length === 0, JSON.stringify(await toasts(A)));

		// ── 3. non-owner ─────────────────────────────────────────────────
		console.log('\n3. a non-owner who turns it on anyway is refused');
		await watchToasts(B);
		await B.page.evaluate(() => { if (window.DaimondLensShot) DaimondLensShot.setEnabled(true); });
		const st403 = await B.page.evaluate(async (dev) => {
			const r = await fetch('/api/lens-shot?device=' + encodeURIComponent(dev), {
				credentials: 'same-origin', headers: { 'x-daimond-api': '2' } });
			return r.status;
		}, b.dev);
		check('the gateway answers the non-owner 403', st403 === 403, 'status ' + st403);
		const nb = await lens(['shot', '--device', b.dev, '--wait', '12']);
		check('and an ask to it goes unanswered', nb.code !== 0 && !!nb.j && nb.j.timeout === true, nb.out.trim().split('\n').pop());
		check('with no toast', (await toasts(B)).length === 0, JSON.stringify(await toasts(B)));

		// ── 4. on ────────────────────────────────────────────────────────
		console.log('\n4. on: a toast, and a picture holding the Diamond page');
		if (dA.item) {
			// The drawer was redrawn by B's checks only on B; A's item is still live.
			await dA.item.click({ force: true }).catch(() => {});
		}
		const on = await A.page.evaluate(() => !!(window.DaimondLensShot && DaimondLensShot.enabled()));
		check('the Settings item turns it on', on);
		const made = await makePageDiamond(A.page);
		const did = made.id;
		check('a Diamond with a one-colour page exists', !!did, made.why);
		// The frame draws itself only when the device was opted in before the page opened.
		// And opened on it, the way the app comes back to the Diamond a person left open.
		await A.page.evaluate((id) => { try { localStorage.setItem('daimond-open-diamond', id); } catch (e) { /* none */ } }, did);
		await A.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(A, 'lensown');
		const shown = await showCrystal(A.page);
		const why = await A.page.evaluate((id) => JSON.stringify({
			mine: !!document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]'),
			ids: [...document.querySelectorAll('#diamond-list .diamond-box')].map(b => (b.dataset.id || '').slice(0, 6)),
			lens: !!(window.DaimondLensShot && DaimondLensShot.enabled()), hidden: document.hidden,
			dev: (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId() || '').slice(0, 8),
			unlocked: !!(window.DaimondIdentity && DaimondIdentity.isUnlocked && DaimondIdentity.isUnlocked()),
			box: !!document.querySelector('#diamond-list .diamond-box'),
			crystal: window.DaimondCrystal ? (({ mode, keys }) => ({ mode, keys: (keys || []).length }))(DaimondCrystal._state() || {}) : null }), did);
		check('its page is on screen in a frame', !!shown, why);
		const rect = await A.page.evaluate(() => {
			const f = document.querySelector('iframe.crystal-frame');
			if (!f) return null;
			const r = f.getBoundingClientRect();
			return { x: r.left, y: r.top, w: r.width, h: r.height };
		});
		await watchToasts(A);
		const t0 = Date.now();
		const got = await lens(['shot', '--device', a.dev, '--wait', '40']);
		const took = Date.now() - t0;
		const file = got.j && got.j.file;
		check('the Lens gets a picture back', got.code === 0 && !!file && fs.existsSync(file),
			`${got.out.trim().split('\n').pop()} in ${took} ms`);
		const ts = await toasts(A);
		const want = await A.page.evaluate(() => (window.t ? t('lens.shot_toast') : ''));
		check('a toast said so on the device', ts.length >= 1 && (!want || ts.includes(want)), JSON.stringify(ts));
		const archived = !!file && path.dirname(file) === path.join(LENS, 'archive', 'shots');
		check('the picture is kept in the Lens archive', archived, file || '');
		if (file && fs.existsSync(file)) {
			const head = fs.readFileSync(file).subarray(0, 8).toString('hex');
			check('it is a PNG', head === '89504e470d0a1a0a', head);
			if (rect) {
				const px = await pageShare(A.page, file, rect);
				check('and the Diamond page\'s own content is drawn in its frame, not a stand-in box',
					px.share > 0.5, `${Math.round(px.share * 100)}% of the frame is the page's colour; picture ${px.w}x${px.h}`);
			} else check('and the Diamond page\'s own content is drawn in its frame', false, 'no frame on screen');
		}

		// ── 5. 60 s limit ────────────────────────────────────────────────
		console.log('\n5. one a minute');
		const n0 = (await toasts(A)).length;
		const again = await lens(['shot', '--device', a.dev, '--wait', '20']);
		check('a second ask inside a minute is refused with the time to wait',
			again.code !== 0 && !!again.j && /^rate: /.test(String(again.j.refused || '')), again.out.trim().split('\n').pop());
		check('and the device was not troubled (no second toast)', (await toasts(A)).length === n0);

		// ── 6. 7-day expiry ──────────────────────────────────────────────
		console.log('\n6. kept seven days');
		const st = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
		const old = `${st(Date.now() - 8 * 86400000)}.acct.${a.dev.slice(0, 16)}.Lold.png`;
		const young = `${st(Date.now() - 6 * 86400000)}.acct.${a.dev.slice(0, 16)}.Lyoung.png`;
		const mirror = path.join(LENS, 'traces', 'shots'), arch = path.join(LENS, 'archive', 'shots');
		// Its own directories, so this section stands whether or not 4 archived anything.
		for (const d of [mirror, arch]) fs.mkdirSync(d, { recursive: true });
		for (const d of [mirror, arch]) for (const n of [old, young]) fs.writeFileSync(path.join(d, n), 'x');
		await lens(['pull', '--no-rsync']);
		check('an 8-day-old picture is dropped from the mirror and the archive',
			!fs.existsSync(path.join(mirror, old)) && !fs.existsSync(path.join(arch, old)));
		check('a 6-day-old one is kept', fs.existsSync(path.join(mirror, young)) && fs.existsSync(path.join(arch, young)));
		const ex = await lens(['pull']);
		check('pull does not mirror the gateway\'s asks or hand-out record',
			!fs.existsSync(path.join(LENS, 'traces', 'shots', 'want')) && !fs.existsSync(path.join(LENS, 'traces', 'shots', 'out')),
			ex.out.trim().split('\n').pop());

		for (const s of [A, B]) {
			const thrown = errors(s).slice(quiet.get(s) || 0).filter(e => !/Failed to load resource/.test(e));
			check(`${s.name || 'device'} threw nothing`, thrown.length === 0, thrown.slice(0, 2).join(' | '));
		}
	} catch (e) {
		check('the run completed', false, String((e && e.stack) || e));
	} finally {
		for (const s of [A, B]) { try { if (s) await s.close(); } catch (e) { /* gone */ } }
	}
	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) { GW_LOG.report(); SRV_LOG.report(8); }
	cleanup();
	process.exit(bad.length ? 1 : 0);
})();
