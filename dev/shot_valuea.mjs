// shot_valuea.mjs — the eight surfaces the 2026-09-15 presentation redesign touched,
// at 1440x900 and 390x844, so a before tree and an after tree can be put side by side.
//
// RUNS ON EITHER TREE. Nothing here asserts; every step tolerates a control that is not
// there, because half the point is to photograph the build where it is not. Pass the
// prefix through SHOT_TAG ('before' or 'after') and the directory through SHOT_DIR.
//
//   SHOT_TAG=before SHOT_DIR=/path node dev/shot_valuea.mjs
import fs from 'node:fs';
import path from 'node:path';
import { open, signInAs, connectMock } from './harness.mjs';

const TAG = process.env.SHOT_TAG || 'shot';
const DIR = process.env.SHOT_DIR || '/tmp';
fs.mkdirSync(DIR, { recursive: true });

const s = await open({ name: 'shotvaluea-' + TAG, signIn: false, connect: false });
const { page } = s;
const wide = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

const snap = async (label) => {
	const w = page.viewportSize();
	const size = (w && w.width === 390) ? '390' : '1440';
	await page.screenshot({ path: path.join(DIR, `${TAG}-${label}-${size}.png`), timeout: 9000 })
		.catch((e) => console.log('  (no shot ' + label + ': ' + e.message.slice(0, 60) + ')'));
	console.log('  ' + TAG + '-' + label + '-' + size);
};
const quiet = async (fn) => { try { await fn(); } catch (e) { console.log('  (skipped: ' + String(e.message).slice(0, 70) + ')'); } };

const CRYSTAL = {
	title:   'Life log',
	summary: 'Diet, gym and body, logged daily since the start of the month.',
	sections: [{ heading: 'Ground rules', body: 'Weigh in every morning, before breakfast.', hot: true }],
	facts:   [{ k: 'Started', v: 'this month' }, { k: 'Lanes', v: 'diet, gym, body' }],
	habits:  ['weigh in every morning', '8,000 steps a day'],
	people:  'partner — likes the gym at 6am',
};
const REQUIREMENTS = [
	'# Requirements', '', 'What this Diamond exists to do.', '',
	'## O1 Keep the log honest', '', '- [ ] T1 Log every weigh-in', '- [x] T2 Seed the lanes (v3)', '',
	'## O2 Make the trend legible', '', '- [ ] T3 Draw a weekly average', '- [ ] T4 Mark the rest days', '',
	'## Unfiled', '', '## Done', '',
].join('\n');

try {
	// ── The gate, on a phone and on a laptop ──────────────────────────
	await page.setViewportSize(phone);
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2500);
	await snap('gate');
	await page.setViewportSize(wide);
	await page.waitForTimeout(500);
	await snap('gate');

	await signInAs(s, 'shotvaluea');
	await page.waitForTimeout(1500);
	await snap('startcard');           // the empty centre, before a model

	await connectMock(s);
	await page.waitForTimeout(1800);
	await snap('strip');               // the rail's status strip on a fresh account

	// ── A new chat: the composer, or the gate over it ─────────────────
	await quiet(async () => {
		await page.evaluate(() => document.getElementById('new-session-btn').click());
		await page.waitForTimeout(1200);
	});
	await snap('newchat');

	// One turn, so the thread has a title to show and a System band to lead it.
	await quiet(async () => {
		const gate = page.locator('.pending-centre .empty-new-session').first();
		if (await gate.count()) await gate.click({ force: true });
		await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
		await page.fill('#chat-input', 'Plan a week of meals for two people on a budget');
		await page.click('#chat-send', { force: true });
		await page.waitForTimeout(4000);
	});
	await snap('thread');

	// ── The Life log Diamond, seeded ──────────────────────────────────
	await quiet(async () => {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', 'Life log');
		await page.click('.dlg-ok', { force: true });
		await page.waitForTimeout(2500);
		await page.evaluate(async (a) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Life log');
			if (!d) return;
			await app.run_tool('file_write', JSON.stringify({
				path: 'diamonds/' + d.id + '/crystal.json', content: a.crystal }));
			await app.run_tool('file_write', JSON.stringify({
				path: 'diamonds/' + d.id + '/REQUIREMENTS.md', content: a.req }));
		}, { crystal: JSON.stringify(CRYSTAL, null, 1), req: REQUIREMENTS });
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(3000);
		await page.$$eval('.diamond-box', els => {
			const d = els.find(e => /Life log/.test(e.textContent)); if (d) d.click();
		});
		await page.waitForTimeout(2500);
	});
	await snap('crystal');             // the crystal face, memory closed

	// The memory, opened — and in the BEFORE tree the capp's own dump as well.
	await quiet(async () => {
		await page.evaluate(() => {
			const b = document.querySelector('.crystal-memory');
			if (b) b.open = true;
			const f = document.getElementById('crystal-frame');
			if (f && f.contentDocument) {
				const d = f.contentDocument.querySelector('details.mem');
				if (d) d.open = true;
			}
		});
		await page.waitForTimeout(1200);
	});
	await snap('memory');

	// ── The Page action's effect on the composer ──────────────────────
	await quiet(async () => {
		await page.evaluate(() => {
			const b = [...document.querySelectorAll('.crystal-bar .crystal-act')]
				.find(x => /Page/i.test(x.textContent));
			if (b) b.click();
		});
		await page.waitForTimeout(600);
	});
	await snap('page');
	await quiet(async () => { await page.fill('#chat-input', ''); });

	// ── The roadmap ───────────────────────────────────────────────────
	await quiet(async () => {
		await page.evaluate(() => window.DaimondPanels.show('tracker'));
		await page.waitForTimeout(2500);
	});
	await snap('improve');

	// ── And every one of them at 390 ──────────────────────────────────
	await page.setViewportSize(phone);
	await page.waitForTimeout(1500);
	await snap('improve');
	await quiet(async () => {
		await page.evaluate(() => { if (window.DaimondPanels.hide) DaimondPanels.hide('tracker'); });
		await page.waitForTimeout(1200);
	});
	await snap('memory');
	await quiet(async () => {
		await page.evaluate(() => { if (window.mshow) window.mshow('ai'); });
		await page.waitForTimeout(1000);
	});
	await snap('thread');
} catch (e) {
	console.log('shot_valuea: ' + String(e && e.message || e));
} finally {
	await s.close?.().catch(() => {});
}
