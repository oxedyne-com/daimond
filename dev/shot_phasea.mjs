// shot_phasea.mjs — photograph every surface phase A touched, so it can be LOOKED at.
//
// Not a verifier: it asserts nothing. It drives the app to each changed surface,
// takes a full-panel shot and a magnified crop of the ink that matters, and
// prints where each one landed. The judging is done by a person (or a model with
// eyes) reading the files.
//
//   node dev/shot_phasea.mjs [outdir]
//
// Needs dev/serve.mjs on :8777 and dev/mockllm.mjs on :9099.
import fs from 'node:fs';
import path from 'node:path';
import { open, signInAs, newChat, chat, scratch } from './harness.mjs';

const OUT = process.argv[2] || scratch('phasea');
fs.mkdirSync(OUT, { recursive: true });

const shots = [];
async function shot(page, label, opts = {}) {
	const p = path.join(OUT, label + '.png');
	try {
		if (opts.sel) {
			const el = await page.$(opts.sel);
			if (!el) { console.log('  MISS  ' + label + ' — no ' + opts.sel); return; }
			await el.screenshot({ path: p, timeout: 8000 });
		} else if (opts.clip) {
			await page.screenshot({ path: p, clip: opts.clip, timeout: 8000 });
		} else {
			await page.screenshot({ path: p, fullPage: false, timeout: 8000 });
		}
		shots.push(p);
		console.log('  shot  ' + label);
	} catch (e) { console.log('  MISS  ' + label + ' — ' + (e.message || e).split('\n')[0]); }
}

/// A magnified crop around one element, so the INK can be judged rather than the box.
/// Playwright cannot zoom a screenshot, so the page itself is zoomed and the element
/// re-measured at that scale.
async function zoomShot(page, label, sel, factor = 4, pad = 14) {
	const found = await page.$(sel);
	if (!found) { console.log('  MISS  ' + label + ' — no ' + sel); return; }
	// Zoom the page, then bring the element back into view before photographing it:
	// a clip computed against the unzoomed layout lands outside the viewport, which
	// is how the first version of this file produced nothing but MISS.
	await page.evaluate((f) => { document.body.style.zoom = String(f); }, factor);
	await page.waitForTimeout(250);
	await page.evaluate((q) => {
		const el = document.querySelector(q);
		if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
	}, sel);
	await page.waitForTimeout(250);
	const el = await page.$(sel);
	const box = el ? await el.boundingBox().catch(() => null) : null;
	if (box) {
		const vw = page.viewportSize();
		await shot(page, label, { clip: {
			x: Math.max(0, box.x - pad),
			y: Math.max(0, box.y - pad),
			width:  Math.min(box.width  + pad * 2, vw.width  - Math.max(0, box.x - pad)),
			height: Math.min(box.height + pad * 2, vw.height - Math.max(0, box.y - pad)),
		} });
	}
	await page.evaluate(() => { document.body.style.zoom = ''; });
	await page.waitForTimeout(200);
}

const s = await open({ name: 'phasea', profile: scratch('pw', 'phasea') });
const { page } = s;
await page.waitForTimeout(1200);

// ── The rail: the search box is gone ────────────────────────────
await shot(page, '01-rail-no-search', { sel: '#panel-rail' });

// ── A chat, for the composer and the copy icon ──────────────────
await newChat(s);
await page.waitForTimeout(500);
await chat(s, 'A short question, so the bubble is one line.').catch(() => {});
await page.waitForTimeout(1200);

await shot(page, '02-composer', { sel: '.chat-input-bar' });
await zoomShot(page, '03-composer-chevrons-8x', '#chat-jump', 8, 10);

// The copy control only exists under the pointer.
const userMsg = await page.$('.chat-msg-user');
if (userMsg) {
	await userMsg.hover();
	await page.waitForTimeout(400);
	await shot(page, '04-copy-hover', { sel: '.chat-msg-user' });
	await zoomShot(page, '05-copy-gap-6x', '.chat-msg-user .msg-copy', 6, 16);
}

// ── The Agents panel, empty ─────────────────────────────────────
await page.evaluate(() => { try { DaimondPanels.show('agents'); } catch (e) {} });
await page.waitForTimeout(700);
await shot(page, '06-agents-empty', { sel: '#panel-agents' });

// ── The Doc panel header, with its new line-number toggle ───────
await page.evaluate(() => { try { DaimondPanels.show('doc'); } catch (e) {} });
await page.waitForTimeout(700);
await shot(page, '07-doc-panel', { sel: '#panel-doc' });
await zoomShot(page, '08-doc-header-6x', '#panel-doc .chead', 6, 6);

// ── The rail dialogs the CSS audit could not see ────────────────
await page.evaluate(() => { try { DaimondPanels.show('rail'); } catch (e) {} });
await page.waitForTimeout(400);
for (const [label, act] of [
	['09-admin-home',    () => document.getElementById('user-row')?.click()],
	['10-admin-models',  () => document.getElementById('astat-model')?.click()],
	['11-admin-credits', () => document.getElementById('astat-account')?.click()],
]) {
	await page.evaluate(act).catch(() => {});
	await page.waitForTimeout(700);
	await shot(page, label, { sel: '#admin-drawer, #settings-modal, .admin-body' });
	await shot(page, label + '-full');
}

console.log('\n' + shots.length + ' shots in ' + OUT);
await s.close();
