// The agent builds a page in the workspace and opens it: it must render in the
// sandboxed local driver (operable), not become a dead https://page.html frame.
import { open, chat, shot, errors } from './harness.mjs';

const s = await open({ name: 'localpage' });

// Agent writes an HTML page, then opens it.
await chat(s, '@tool file_write {"path":"built.html","content":"<html><body><h1 id=hi>Hello from the agent</h1><button id=go>Go</button></body></html>"}');

const r = await s.page.evaluate(async () => {
	const res = await window.DaimondWeb.open('built.html');
	// Peek at what the panel actually loaded.
	const frame = document.getElementById('web-frame');
	let framed = '';
	try { framed = frame && frame.src ? frame.src.slice(0, 12) : ''; } catch (e) {}
	return { driver: res.driver, url: res.url, note: res.note, frameSrcScheme: framed };
});
console.log('open result:', JSON.stringify(r));
await s.page.waitForTimeout(500);
await shot(s, 'localpage-open');

// snapshot() should see the page's own elements (proves it is operable, not a dead frame).
let snap = null;
try {
	snap = await s.page.evaluate(async () => {
		const sn = await window.DaimondWeb.snapshot();
		return { nodes: (sn.nodes||[]).length, hasButton: (sn.nodes||[]).some(n => /go|Go/.test(n.name||'') || n.role==='button') };
	});
} catch (e) { snap = { err: String(e).slice(0,120) }; }
console.log('snapshot:', JSON.stringify(snap));

console.log('\nOPENED AS LOCAL DRIVER (not frame to https://built.html):',
	r.driver === 'local' && r.frameSrcScheme.startsWith('blob:'));
console.log('errors:', errors(s));
await s.close();
