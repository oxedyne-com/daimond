// shot_guide_workspace.mjs — regenerate the guide's Workspace screenshot.
//
// The guide now describes three chips and a file that lives in cloud storage
// rather than on this device, so the picture beside that prose has to show them.
// The old shot predates all of it: it showed "OPFS (sandbox)" and a single
// "Open a folder…" button, and sat directly above text describing something
// else. A screenshot that contradicts its own caption is worse than none.
//
// Needs dev/serve.mjs and a gateway on :9002 — the cloud-only row is real
// rather than staged: a file is genuinely offloaded, then freed.
import { open, signInAs } from './harness.mjs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'www', 'guide', 'shots');

const s = await open({ name: 'Alex', connect: false, signIn: true });
const p = s.page;
await p.waitForFunction(
	() => !!window.DaimondCloud && !!window.DaimondCore && !!window.DaimondSync,
	null, { timeout: 15000 },
).catch(() => {});

// A small workspace showing every residency at once: ordinary files, one pinned
// to the device, and one that lives in cloud storage alone.
await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const bulk = (n) => { let b = ''; while (b.length < n) b += 'the draft continues, at length, for some pages. '; return b; };
	await app.run_tool('file_write', JSON.stringify({ path: 'notes.md', content: '# Notes\n\nA short file.\n' }));
	await app.run_tool('file_write', JSON.stringify({ path: 'proposal.typ', content: bulk(3 * 1024) }));
	await app.run_tool('file_write', JSON.stringify({ path: 'interviews.txt', content: bulk(300 * 1024) }));
	await app.run_tool('file_write', JSON.stringify({ path: 'report-draft.txt', content: bulk(200 * 1024) }));
	await window.DaimondSync.push();
	window.DaimondCloud.pin('report-draft.txt', true);
	await window.DaimondCloud.evict('interviews.txt');
});

await p.evaluate(() => { try { DaimondPanels.open('work'); } catch (e) { /* already open */ } });
await p.waitForTimeout(700);
await p.click('#panel-work [data-act="refresh"]').catch(() => {});
await p.waitForTimeout(1400);

const clip = await p.evaluate(() => {
	const el = document.querySelector('#panel-work');
	if (!el) return null;
	const r = el.getBoundingClientRect();
	// The head and the tree; not the empty tail of a tall panel.
	return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: 340 };
});
if (!clip) {
	console.log('  SKIP — the Workspace panel is not on screen');
} else {
	await p.screenshot({ path: path.join(OUT, 'workspace.png'), clip });
	console.log(`  wrote workspace.png (${clip.width}x${clip.height})`);
}
await s.browser.close();
