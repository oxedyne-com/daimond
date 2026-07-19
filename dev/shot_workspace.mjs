// shot_workspace.mjs — the arranging controls: the chip row, the appearance
// menu, the panel gallery and the palette.
import { open, shot, signInAs, errors } from './harness.mjs';

const s = await open({ name: 'workspace-shot', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	await app.create_facet('Ship the launch');
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'workspace-shot');
await p.waitForTimeout(3000);

// The Agents panel hides until the first agent runs, which would keep it out of
// both the row and the gallery -- reveal it so the shots show the whole fleet.
await p.evaluate(() => {
	localStorage.setItem('daimond-agents-revealed', '1');
	document.body.classList.remove('agents-hidden');
	window.DaimondPanels.reflow();
});
await p.waitForTimeout(300);
await shot(s, 'ws-1-chips');

await p.click('#settings-menu-btn');
await p.waitForTimeout(400);
await shot(s, 'ws-2-menu');

// The widest tiling, which is the thing the dock grid was asked for.
await p.evaluate(() => window.DaimondPanels.setGrid('2x3'));
await p.waitForTimeout(300);
await p.evaluate(() => {
	['agents', 'mail', 'work', 'spend'].forEach(id => window.DaimondPanels.show(id));
});
await p.waitForTimeout(500);
await shot(s, 'ws-3-dock-2x3');

await p.keyboard.press('Escape');
await p.evaluate(() => {
	// Unpin two, so the row has to overflow and the gallery earns its place.
	window.DaimondPanels.setPinned('compose', false);
	window.DaimondPanels.setPinned('tools', false);
});
await p.waitForTimeout(400);
await shot(s, 'ws-4-overflow');

await p.click('#panel-more');
await p.waitForTimeout(400);
await shot(s, 'ws-5-gallery');

await p.keyboard.press('Escape');
await p.keyboard.press('Control+k');
await p.waitForTimeout(400);
await p.keyboard.type('spe');
await p.waitForTimeout(300);
await shot(s, 'ws-6-palette');

console.log('console errors:', JSON.stringify(errors(s)));
await s.close();
console.log('shots written');
