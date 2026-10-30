// dev/shot_stack.mjs -- the live phone page beside the Stack mock, frame by frame (D-20261029-01).
//
//   eval "$(bash dev/world.sh N --up)"     # a world this caller holds the lease of
//   DAIMOND_STACK_MOCK=<dir> node dev/shot_stack.mjs <frame> <look,look,...> <outdir>
//
// For each look it writes `<frame>_<look>_app.png` (the page, WebKit 390x844, touch,
// an iPhone's UA) and `<frame>_<look>_pair.png`: the page on the left, the mock's own
// PNG on the right, composed in the same WebKit context as two <img>s, so no image
// library is needed. A Stack unit reads both pairs and lists every difference.
//
// `<frame>` is a step file, `dev/stack_frames/<frame>.mjs`, exporting `drive(s)`: each
// later unit owns its frame's file. The account is `dev/stack_frames/seed.json`, the
// mock's own names. `DAIMOND_STACK_MOCK` is the directory of the mock's PNGs, laid out
// `<look>/<frame>.png` as its render.mjs writes them.
//
// It refuses to run on a world this caller does not hold: the world is
// DAIMOND_WORLD, its lease is asked of `world.sh --status`, and DAIMOND_APP must be
// that world's own app, so a page from somebody else's world is never shot.
//
// A look is `<skin>-<tone>` as the mock names it. The page has one skin since
// D-20260929-02 (Daylight), so only the tone carries over; the skin is a kept
// difference until a ruling says otherwise.

import { open, signInAs, APP } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// fixed: the mock's two themes (kit.css: Ember dark, Paper light), as the page's palette ids.
const PALETTE = { dark: 'dark', light: 'light' };
// fixed: the mock's frame, an iPhone at 390x844 points.
const VIEW = { width: 390, height: 844 };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const die = (msg) => { console.error('shot_stack: ' + msg); process.exit(2); };

const [frame, lookArg, outArg] = process.argv.slice(2);
if (!frame || !lookArg || !outArg) die('usage: node dev/shot_stack.mjs <frame> <look,look,...> <outdir>');
if (!/^b[0-9]+[a-z]?$/.test(frame)) die(`frame '${frame}' is not a mock frame id (b1 .. b10, b6b)`);
const looks = lookArg.split(',').filter(Boolean);
for (const l of looks) {
	const tone = l.split('-')[1];
	if (!PALETTE[tone]) die(`look '${l}' is not <skin>-<dark|light>`);
}
const out = path.resolve(outArg.replace(/^~(?=\/)/, process.env.HOME || '~'));

// ── The lease ────────────────────────────────────────────────────
const world = process.env.DAIMOND_WORLD;
if (!world || !/^[0-9]+$/.test(world)) die('DAIMOND_WORLD is not set: eval "$(bash dev/world.sh N --up)" on a world you hold first');
const ws = (...a) => execFileSync('bash', [path.join(HERE, 'world.sh'), world, ...a], { encoding: 'utf8' });
const status = ws('--status');
if (!/^world [0-9]+: claim this caller's/m.test(status)) {
	const line = (status.match(/^world [0-9]+: claim .*$/m) || ['(no claim line)'])[0];
	die(`world ${world} is not this caller's lease (${line}); claim one with bash dev/world.sh --free "<purpose>"`);
}
const own = (ws('--env').match(/^export DAIMOND_APP=(.*)$/m) || [])[1];
if (!own || own !== APP) die(`DAIMOND_APP is ${APP}, not world ${world}'s ${own || '(none)'}`);

// ── The mock and the frame ───────────────────────────────────────
const mockDir = process.env.DAIMOND_STACK_MOCK;
if (!mockDir) die('DAIMOND_STACK_MOCK is not set: the directory of the mock PNGs, <look>/<frame>.png');
for (const l of looks) {
	const f = path.join(mockDir, l, frame + '.png');
	if (!existsSync(f)) die(`no mock PNG ${f}`);
}
const stepFile = path.join(HERE, 'stack_frames', frame + '.mjs');
if (!existsSync(stepFile)) die(`no step file ${stepFile}`);
const step = await import(pathToFileURL(stepFile).href);
if (typeof step.drive !== 'function') die(`${stepFile} exports no drive(s)`);
const seed = JSON.parse(readFileSync(path.join(HERE, 'stack_frames', 'seed.json'), 'utf8'));
mkdirSync(out, { recursive: true });

// ── The account, once: Diamonds (OPFS, where the browser has it) and chats ──
const s = await open({ name: 'stackshot' + (Date.now() % 100000), browser: 'webkit', touch: true, ua: UA,
	connect: false, defaults: false, viewport: VIEW });
const p = s.page;
await p.waitForFunction(() => !!window.DaimondCore, null, { timeout: 30000 });
const seeded = await p.evaluate(async (sd) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	let d = 0;
	for (const n of sd.diamonds) { try { await app.create_diamond(n); d++; } catch (e) { /* no OPFS in this browser */ } }
	const c = await new Promise((res) => {
		const now = Date.now();
		const rows = sd.chats.map((nm, i) => ({ id: 'stackseed' + i, name: nm, createdAt: now - i * sd.chatStepMs,
			updatedAt: now - i * sd.chatStepMs, messages: [], msgCount: 2, model: 'mock/fast' }));
		const r = indexedDB.open('daimond-chats');
		r.onsuccess = () => {
			let t;
			try { t = r.result.transaction('chats', 'readwrite'); } catch (e) { res(0); return; }
			rows.forEach((x) => t.objectStore('chats').put(x));
			t.oncomplete = () => { try { localStorage.setItem('daimond-chats-count', String(rows.length)); } catch (e) { /* private */ } res(rows.length); };
			t.onerror = () => res(0);
		};
		r.onerror = () => res(0);
	});
	return { d, c };
}, seed);
console.log(`shot_stack: world ${world}, seeded ${seeded.d}/${seed.diamonds.length} Diamonds, ${seeded.c}/${seed.chats.length} chats`);

// ── Each look: the page, then the pair ───────────────────────────
const pair = await s.browser.newPage();
const b64 = (buf) => 'data:image/png;base64,' + buf.toString('base64');
let made = 0;
for (const look of looks) {
	await p.evaluate((pal) => localStorage.setItem('daimond-theme', pal), PALETTE[look.split('-')[1]]);
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	await p.waitForFunction((n) => document.querySelectorAll('#session-list .session-box').length >= n,
		seeded.c, { timeout: 20000 }).catch(() => console.log('shot_stack: the Chats list did not fill'));
	// This world has no gateway, so the pools are stood in for, as verify_railheight does.
	const pools = await p.evaluate(async (pl) => {
		try { DaimondAdmin.closeModal(); } catch (e) { /* none open */ }
		const gs = DaimondGateway.state.bind(DaimondGateway);
		DaimondGateway.state = () => Object.assign({}, gs(), { authed: true, credits: pl.creditsCents, currency: pl.currency });
		DaimondModels.providers = () => pl.providers;
		DaimondLedger.record(Object.assign({ ts: Date.now() }, pl.today));
		DaimondI18n.setCurrency(pl.currency);
		await new Promise((r) => setTimeout(r, 400));
		return document.querySelectorAll('#spend-row .evp').length;
	}, seed.pools);
	await p.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
	await step.drive(s);
	const appPng = await p.screenshot({ timeout: 15000 });
	const appFile = path.join(out, `${frame}_${look}_app.png`);
	writeFileSync(appFile, appPng);
	const mockPng = readFileSync(path.join(mockDir, look, frame + '.png'));
	const gap = 12;
	await pair.setViewportSize({ width: VIEW.width * 2 + gap * 3, height: VIEW.height + gap * 2 });
	await pair.setContent('<body style="margin:0;background:#777;display:flex;gap:' + gap + 'px;padding:' + gap + 'px">'
		+ '<img src="' + b64(appPng) + '" style="width:' + VIEW.width + 'px;height:' + VIEW.height + 'px">'
		+ '<img src="' + b64(mockPng) + '" style="width:' + VIEW.width + 'px;height:' + VIEW.height + 'px"></body>');
	// `complete` is not painted: WebKit decodes a large data URL off the main thread, and a
	// screenshot taken on `complete` drew the second look's mock as nothing. Decode, then a frame.
	const drawn = await pair.evaluate(async () => {
		await Promise.all([...document.images].map((i) => i.decode()));
		await new Promise((k) => requestAnimationFrame(() => requestAnimationFrame(k)));
		return [...document.images].every((i) => i.naturalWidth > 0);
	});
	if (!drawn) die(`the ${look} pair did not decode both images`);
	const pairFile = path.join(out, `${frame}_${look}_pair.png`);
	await pair.screenshot({ path: pairFile });
	made++;
	console.log(`shot_stack: ${look} pools ${pools}  app ${appFile}  pair ${pairFile}`);
}
const errs = (s.errs || []).length;
// The distinct page errors, a few: a pair drawn over a broken page is not a comparison.
for (const e of [...new Set((s.errs || []).map((x) => String(x.message || x).split('\n')[0]))].slice(0, 4)) console.log('shot_stack: page error: ' + e);
await s.browser.close().catch(() => {});
console.log(`shot_stack: ${frame} (${step.about || ''}) ${made}/${looks.length} pair(s), ${errs} page error(s)`);
process.exit(made === looks.length ? 0 : 1);
