// The agent builds a page in the workspace and opens it: it must render in the
// sandboxed local driver (operable), not become a dead https://page.html frame.
//
// THE PAGE IS BUILT IN THE CHAT'S OWN SCRATCH. Until 2026-08-12 the agent was asked
// to write `built.html` at the workspace ROOT; since the chat fence landed a chat is
// confined to `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js) and `Tool::guard`
// (src/tools.rs:5490) refuses a root path before anything is written. Nothing threw:
// the refusal came back as an ordinary tool result, `DaimondWeb.open` then had no such
// page, and the checks below measured an error path rather than the local driver.
// The scratch is chosen over an out-of-band seed BECAUSE THE AGENT BUILDING THE PAGE
// IS HALF THE PROPERTY -- "drive the page you made" is what the local driver is for,
// and a page seeded from outside would not prove the agent could produce one.
import { open, chat, newChat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'localpage' });
await newChat(s);

const dir = await s.page.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return f && f.id ? window.DaimondAttach.chatScratch(f.id) : '';
});
check('the chat has a scratch folder to build in', !!dir, dir || '(no chat in focus)');
const PAGE = dir + '/built.html';

// Agent writes an HTML page, then opens it.
const wrote = await chat(s, `@tool file_write {"path":"${PAGE}","content":"<html><body><h1 id=hi>Hello from the agent</h1><button id=go>Go</button></body></html>"}`);
check('the agent really built the page — a refused write leaves nothing to open',
	!/Refused/.test(wrote) && /Wrote \d+ bytes/.test(wrote),
	wrote.slice(-160).replace(/\n/g, ' | '));

let r;
try {
	r = await s.page.evaluate(async (p) => {
		const res = await window.DaimondWeb.open(p);
		// Peek at what the panel actually loaded.
		const frame = document.getElementById('web-frame');
		let framed = '';
		try { framed = frame && frame.src ? frame.src.slice(0, 12) : ''; } catch (e) {}
		return { driver: res.driver, url: res.url, note: res.note, frameSrcScheme: framed };
	}, PAGE);
} catch (e) { r = { err: String(e).split('\n')[0] }; }
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

check('OPENED AS LOCAL DRIVER (not a frame to https://built.html)',
	r.driver === 'local' && String(r.frameSrcScheme || '').startsWith('blob:'),
	JSON.stringify(r));
// The other half: a frame that loaded is not a page that can be driven, and the
// whole point of the local driver is that the agent can operate what it built.
check('and the page is OPERABLE — its own elements come back from a snapshot',
	!!(snap && snap.nodes > 0 && snap.hasButton), JSON.stringify(snap));

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
