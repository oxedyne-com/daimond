// shot_guide.mjs — regenerate the guide screenshots that show the rail.
//
// Only the shots that carry the renamed word need remaking: the two full-window ones, the
// rail crop of a fold in progress, and the Models blurb that names what a new chat starts
// on. The other guide shots are panel crops with no Diamond in them and are left alone.
//
// Needs dev/serve.mjs and dev/mockllm.mjs up. Writes straight into www/guide/shots/.
import { open, signInAs, connectMock, newChat, chat } from './harness.mjs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'www', 'guide', 'shots');
const s = await open({ name: 'Alex', connect: false, signIn: false });
const p = s.page;
await p.waitForTimeout(1200);
await signInAs(s, 'Alex');
await p.waitForTimeout(1500);
await connectMock(s);
await p.waitForTimeout(1200);

const clipOf = async (sel) => p.evaluate((sel) => {
	const el = document.querySelector(sel);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}, sel);

const grab = async (name, sel) => {
	const clip = sel ? await clipOf(sel) : null;
	if (sel && (!clip || !clip.width || !clip.height)) {
		console.log(`  SKIP ${name} — ${sel} is not on screen`); return;
	}
	await p.screenshot({ path: path.join(OUT, name), clip: clip || undefined, timeout: 10000 });
	console.log(`  wrote ${name}${clip ? ` (${clip.width}x${clip.height})` : ' (full window)'}`);
};

// ── getting-started.png — the whole window, guide open at "The interface" ──
await p.evaluate(async () => {
	const g = document.querySelector('#panel-web') ? null : null;
	if (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide('interface.html');
	await new Promise(r => setTimeout(r, 1500));
});
await p.waitForTimeout(1500);
await grab('getting-started.png', null);

// ── models-form.png — the Models view, which names what a new chat starts on ──
await p.evaluate(async () => {
	// The status row opens the thing it names; the gear only opens the panel.
	const row = document.getElementById('astat-model');
	if (row) row.click();
	await new Promise(r => setTimeout(r, 900));
});
await p.waitForTimeout(900);
await grab('models-form.png', '#admin-models');

// ── diamond-fold.png — the rail, mid-fold, with the picker open ──
await p.evaluate(async () => {
	const close = document.getElementById('admin-close');
	if (close) close.click();
	await new Promise(r => setTimeout(r, 400));
});
await newChat(s).catch(() => {});
await p.waitForTimeout(1200);
// The picker refuses an empty chat, and an empty chat also reads "0 tok" on the tile.
// One real turn through the mock gives the shot something true to show.
await chat(s, 'How do I open a folder on my real disk?').catch(() => {});
await p.waitForTimeout(1500);
await p.evaluate(async () => {
	const fold = document.querySelector('.session-box .tile-fold');
	if (fold) fold.click();
	await new Promise(r => setTimeout(r, 800));
});
await p.waitForTimeout(800);
await grab('diamond-fold.png', '#panel-rail');

// ── accounts-switch.png — the whole window with the account list showing ──
await p.evaluate(async () => {
	const btn = document.getElementById('settings-btn');
	if (btn) btn.click();                       // the admin panel home, where accounts live
	await new Promise(r => setTimeout(r, 1000));
});
await p.waitForTimeout(1000);
await grab('accounts-switch.png', null);

await s.close();
console.log('guide shots done');
