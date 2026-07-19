// shot_artefacts.mjs — a look at the artefact strip, open and closed.
import { open, signInAs, shot } from './harness.mjs';

const s = await open({ name: 'artefacts-shot', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const id = await app.create_diamond('Ship the launch');
	const tl = (name, args) => ({ role: 'tool_log', name, args: JSON.stringify(args) });
	await window.DaimondArtefacts.harvest(id, { sourceRun: { messages: [
		tl('file_write', { path: 'notes/pricing.md' }),
		tl('file_edit',  { path: 'notes/launch-copy.md' }),
		tl('web_open',   { url: 'https://stripe.com/docs/billing' }),
		tl('file_write', { path: 'notes/budget-2026.csv' }),
	] } });
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'artefacts-shot');
await p.waitForTimeout(3000);

await p.evaluate(async () => {
	const row = Array.from(document.querySelectorAll('#diamond-list .diamond-box'))
		.find(e => /Ship the launch/.test(e.textContent));
	if (row) row.click();
	await new Promise(r => setTimeout(r, 1200));
});
await shot(s, 'artefacts-closed');

await p.evaluate(async () => {
	document.getElementById('arte-strip').click();
	await new Promise(r => setTimeout(r, 700));
});
await shot(s, 'artefacts-open');

await s.close();
console.log('shots written');
