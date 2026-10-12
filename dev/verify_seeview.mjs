// gateway: none
// verify_seeview — a daimon editing a .typ document can see its preview by naming the view (2026-10-12).
//
// WHY THIS EXISTS. On the recipe-card drive (D-20261011-34) every one of a daimon's nine `capture` calls failed: it
// guessed selectors that do not exist (`.doc-viewer`, `#document-viewer`, ...) or took the whole page, over the cap. Even
// the right selector drew an empty box, because the Typst pages are an <svg> in a shadow root that a clone does not copy.
// `capture` now takes a view name: a panel on screen (`preview`, `doc`, ...), `screen`, or `crystal`.
//
// Arms: a real .typ compiled into the live preview; the daimon's own `capture` in:"preview" through the engine comes back
// with a picture; the same capture drawn in the page has ink on it (many colours, dark pixels), not a blank box; a guessed
// view is refused, naming the views on screen.
//
//   DAIMOND_WORLD=<n> node dev/verify_seeview.mjs
import { open, connectMock, mockLog, clearMockLog, contentText } from './harness.mjs';

let bad = 0;
const ok = (c, why, d) => { console.log((c ? '  ok   ' : '  FAIL ') + why + (d != null ? ' — ' + d : '')); if (!c) bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAIN = `#set page(width: 120mm, height: 160mm, margin: 12mm)
#set text(size: 11pt)
= Recipe card
*Serves* four. Whisk the eggs, fold in the flour, and bake for twenty minutes.
#lorem(60)
`;

const s = await open({ name: 'seeview', defaults: false,
	route: async (p) => { await p.setViewportSize({ width: 1900, height: 1000 }); } });
const p = s.page;
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await connectMock(s);

await p.evaluate(() => document.getElementById('new-diamond-btn').click());
await p.waitForSelector('.dlg-card', { timeout: 8000 });
await p.evaluate(() => {
	const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
	const inp = card.querySelector('input.dlg-input');
	inp.value = 'Seeview';
	inp.dispatchEvent(new Event('input', { bubbles: true }));
	card.querySelector('.dlg-ok').click();
});
await p.waitForTimeout(1200);
await p.click('#dview-chat');
await p.waitForTimeout(700);
const id = await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find((x) => x.name === 'Seeview');
	return d ? d.id : '';
});

await p.evaluate(async (text) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file('card/main.typ', text);
}, MAIN);
await p.evaluate(() => window.DaimondDoc.show('card/main.typ'));
await p.waitForTimeout(1200);
await p.click('[data-act="compile"]', { force: true }).catch(() => {});
let st = {};
for (let i = 0; i < 90; i++) {
	st = await p.evaluate(() => (window.DaimondTypstWatch ? window.DaimondTypstWatch.state() : {}));
	if (st.drawn) break;
	await sleep(500);
}
// The Doc panel's own line says why a compile did not happen (a compiler that would not load, a refusal), so it rides the detail.
const said = await p.evaluate(() => ((document.querySelector('.files-view-msg') || {}).textContent || '').slice(0, 200));
ok(!!st.drawn, 'the .typ is compiled into the live preview', JSON.stringify({ mode: st.mode, drawn: st.drawn, pages: st.pages, said }));

const views = await p.evaluate(() => window.DaimondShot.views());
ok(views.includes('preview'), 'the preview is a view on screen', views.join(', '));

// The page's own capture, decoded: ink, not an empty box.
const ink = await p.evaluate(async () => {
	const j = JSON.parse(await window.DaimondShot.capture(JSON.stringify({ in: 'preview' })));
	const img = new Image();
	await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = 'data:image/png;base64,' + j.png_b64; });
	const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
	const g = c.getContext('2d'); g.drawImage(img, 0, 0);
	const d = g.getImageData(0, 0, c.width, c.height).data;
	const cols = new Set(); let dark = 0;
	for (let i = 0; i < d.length; i += 16) {
		cols.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
		if (d[i] + d[i + 1] + d[i + 2] < 200) dark++;
	}
	return { w: j.w, h: j.h, bytes: j.bytes, cols: cols.size, dark };
}).catch((e) => ({ err: String(e && e.message || e).slice(0, 300) }));
ok(!ink.err && ink.w > 100 && ink.h > 100, 'in:"preview" draws a picture the size of the panel', JSON.stringify(ink));
ok(!ink.err && ink.cols >= 4 && ink.dark > 50, 'with the document on it, not a blank box', JSON.stringify(ink));

const say = async (text, ms = 7000) => {
	await p.fill('#chat-input', text);
	await p.click('#chat-send');
	await p.waitForTimeout(ms);
};
/// The tool result answering THIS call: the one whose arguments carry `needle`, waited for. The last tool
/// message of the last request is not it -- a turn's first request carries the previous turn's result in its
/// history, which is how the refusal check came to read the preview's photograph (2026-10-12).
const answerTo = async (needle, ms = 20000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) {
		for (const r of mockLog().slice().reverse()) {
			// Paired by position as well as id: the mock numbers its calls afresh each turn.
			const msgs = (r && r.messages) || [];
			for (let i = msgs.length - 1; i >= 0; i--) {
				const c = (msgs[i].tool_calls || []).find((x) => String(x.function && x.function.arguments).includes(needle));
				if (!c) continue;
				const t = msgs.slice(i + 1).find((m) => m.role === 'tool' && m.tool_call_id === c.id);
				if (t) return contentText(t.content);
			}
		}
	}
	return '';
};

clearMockLog();
await say('@tool capture ' + JSON.stringify({ in: 'preview', path: 'diamonds/' + id + '/shots/preview.png' }));
const got = await answerTo('shots/preview.png');
ok(/preview\.png/.test(got) && !/refus|could not|Nothing on the page/i.test(got),
	'the daimon\'s own capture in:"preview" comes back with the picture', got.slice(0, 240));

clearMockLog();
await say('@tool capture ' + JSON.stringify({ in: 'document-viewer' }));
const no = await answerTo('document-viewer');
ok(/Views on screen now: .*\bpreview\b/.test(no), 'a guessed view is refused, naming the views on screen', no.slice(0, 240));

ok(errs.length === 0, 'nothing was thrown', errs.join(' | '));
console.log(bad ? `\nverify_seeview: ${bad} failed.` : '\nverify_seeview: all checks passed');
await s.close();
process.exit(bad ? 1 : 0);
