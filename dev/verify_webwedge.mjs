// gateway: none
// verify_webwedge.mjs -- the wasm boundary never trusts a JS value to be a Promise (UNBLOCK-7 F1).
//
// On 2026-10-14 every web_click and web_type in a browser tab crashed its turn: the engine asked
// `DaimondWeb.status()` for the page's address, the import was typed `-> js_sys::Promise`, and the
// real driver's `status` is SYNCHRONOUS (www/js/web.js), so `JsFuture::from` called `.then` on a
// plain object. The TypeError unwound through the wasm frames with no `catch`, abandoned the task's
// `RefCell` borrow, and the next wake panicked into `unreachable`. The turn never ended and the
// runner stayed busy for good (notes/daimond_argonaut_crash_20261014/diag.md).
//
// Every earlier check STUBBED the driver with `async` methods, which is exactly the case that works.
// This one drives the REAL web.js over a blob page, then breaks the driver on purpose:
//   1. web_click and web_type on the real driver return a result, and nothing traps.
//   2. a driver method that THROWS comes back as a refusal carrying its message, not a trap.
//   3. a method that returns a plain value, and one that returns a thenable, are both read.
//   4. after all that the same engine still answers -- an abandoned borrow would panic here.
import { open, errors } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'webwedge' });
const { page: p } = s;
await p.waitForFunction(() => !!window.DaimondWeb, null, { timeout: 20000 }).catch(() => {});

// A page of our own, as the local driver renders a page the agent wrote.
const opened = await p.evaluate(async () => {
	const html = '<html><body><h1>Wedge</h1><button id=go onclick="document.title=\'clicked\'">Go</button>'
		+ '<input id=q aria-label="Query"></body></html>';
	const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
	try { return { ok: true, res: await window.DaimondWeb.open(url) }; }
	catch (e) { return { ok: false, err: String(e && e.message || e) }; }
});
check('the real driver opens a blob page', opened.ok, JSON.stringify(opened).slice(0, 160));
check('and its status() is synchronous, which is the case under test',
	await p.evaluate(() => { const r = window.DaimondWeb.status(); return !!r && typeof r.then !== 'function'; }));

// The frame loads after open() returns, so the snapshot is asked until the page answers.
const refs = await p.evaluate(async () => {
	let last = '';
	for (let i = 0; i < 40; i++) {
		try {
			const sn = await window.DaimondWeb.snapshot();
			const nodes = (sn && sn.nodes) || [];
			const by = (f) => { const n = nodes.find(f); return n ? n.ref : null; };
			return { button: by(n => n.role === 'button'), box: by(n => /textbox|searchbox|combobox/.test(n.role || '')) };
		} catch (e) { last = String(e && e.message || e); }
		await new Promise(r => setTimeout(r, 250));
	}
	return { err: last };
});
check('the snapshot names a button and a text box', refs.button != null && refs.box != null, JSON.stringify(refs));

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__ww = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
});

/// Run one tool, time-boxed: a wedged task never settles, so "no answer in 10 s" is the red.
/// Any consent dialog is answered yes; this check is about the boundary, not the gate.
async function tool(name, args) {
	await p.evaluate(({ name, args }) => {
		window.__wwr = { done: false, text: '' };
		window.__ww.run_tool(name, JSON.stringify(args))
			.then((v) => { window.__wwr = { done: true, text: String(v) }; })
			.catch((e) => { window.__wwr = { done: true, text: 'THREW ' + (e && e.message || e) }; });
	}, { name, args });
	const end = Date.now() + 10000;
	for (;;) {
		const r = await p.evaluate(() => {
			const d = document.querySelector('.modal.dlg .dlg-ok');
			if (d) d.click();
			return window.__wwr;
		});
		if (r.done) return r;
		if (Date.now() > end) return { done: false, text: '(no answer in 10 s)' };
		await p.waitForTimeout(150);
	}
}
const trapped = () => errors(s).filter(e => /then is not a function|unreachable|RefCell|already borrowed/i.test(e));

// 1. The real driver.
let r = await tool('web_click', { ref: refs.button });
check('web_click on the real driver returns', r.done && !/^THREW/.test(r.text), r.text.slice(0, 160));
r = await tool('web_type', { ref: refs.box, text: 'hello' });
check('web_type on the real driver returns', r.done && !/^THREW/.test(r.text), r.text.slice(0, 160));
check('nothing trapped', trapped().length === 0, trapped().slice(0, 2).join(' | '));

// 2. A driver method that throws outright, and a status() that throws.
await p.evaluate(() => {
	window.__wwSaved = { click: window.DaimondWeb.click, status: window.DaimondWeb.status };
	window.DaimondWeb.click = () => { throw new Error('Driver exploded on purpose.'); };
});
r = await tool('web_click', { ref: refs.button });
check('a throwing click comes back as a refusal carrying its message',
	r.done && /Driver exploded on purpose/.test(r.text), r.text.slice(0, 160));
await p.evaluate(() => {
	window.DaimondWeb.click = window.__wwSaved.click;
	window.DaimondWeb.status = () => { throw new Error('Status exploded.'); };
});
r = await tool('web_click', { ref: refs.button });
check('a throwing status() does not stop the click', r.done && !/^THREW/.test(r.text), r.text.slice(0, 160));

// 3. A plain value and a thenable, each read as an answer.
await p.evaluate(() => {
	window.DaimondWeb.status = window.__wwSaved.status;
	window.DaimondWeb.click = () => ({ ok: true, plain: 'sync-click' });
});
r = await tool('web_click', { ref: refs.button });
check('a click that returns a plain value is read', r.done && /sync-click/.test(r.text), r.text.slice(0, 160));
await p.evaluate(() => {
	window.DaimondWeb.click = () => ({ then: (res) => res({ ok: true, plain: 'thenable-click' }) });
});
r = await tool('web_click', { ref: refs.button });
check('a click that returns a thenable is read', r.done && /thenable-click/.test(r.text), r.text.slice(0, 160));

// 4. The same engine still answers, after every case above.
await p.evaluate(() => { window.DaimondWeb.click = window.__wwSaved.click; });
r = await tool('web_click', { ref: refs.button });
check('the engine still answers afterwards', r.done && !/^THREW/.test(r.text), r.text.slice(0, 160));
check('and nothing trapped at any point', trapped().length === 0, trapped().slice(0, 2).join(' | '));

await s.close();
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
