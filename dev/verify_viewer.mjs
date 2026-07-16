// A file open in the Workspace viewer must not go stale when an agent edits it.
// Open a file, have the agent rewrite it on the next turn, and confirm the
// viewer reloads to the agent's new content rather than showing the old.
import { open, chat, newChat, shot, errors } from './harness.mjs';

const s = await open({ name: 'viewer' });

// 1. Agent creates a file.
await chat(s, '@tool file_write {"path":"live.txt","content":"ORIGINAL CONTENT"}');

// 2. Open the Workspace panel and the file in its viewer.
await s.page.evaluate(() => {
	// Open the Workspace dock panel the real way, so DaimondPanels registers it
	// as open (which the panel's own isOpen() gate checks).
	if (window.DaimondPanels && DaimondPanels.show) DaimondPanels.show('work');
});
await s.page.waitForTimeout(500);
// Click the file row named live.txt.
const opened = await s.page.evaluate(async () => {
	const rows = [...document.querySelectorAll('#panel-work .files-row')];
	const row = rows.find(r => /live\.txt/.test(r.textContent));
	if (!row) return { ok: false, rows: rows.map(r => r.textContent.trim()) };
	row.click();
	await new Promise(r => setTimeout(r, 600));
	const body = document.querySelector('#panel-work .files-view-body');
	return { ok: true, body: body ? body.textContent : '(no body)' };
});
console.log('opened viewer:', JSON.stringify(opened).slice(0, 200));

// 3. Agent rewrites the file on a fresh turn (triggers Files.refresh()).
await chat(s, '@tool file_write {"path":"live.txt","content":"AGENT REWROTE THIS"}');
await s.page.waitForTimeout(600);

// 4. The viewer should now show the agent's new content.
const after = await s.page.evaluate(() => {
	const body = document.querySelector('#panel-work .files-view-body');
	const msg  = document.querySelector('#panel-work .files-view-msg');
	return { body: body ? body.textContent : '(none)', msg: msg ? msg.textContent : '' };
});
await shot(s, 'viewer-after-agent-edit');
console.log('viewer after agent edit:', JSON.stringify(after));
console.log('\nVIEWER RELOADED:', /AGENT REWROTE THIS/.test(after.body));
console.log('errors:', errors(s));
await s.close();
