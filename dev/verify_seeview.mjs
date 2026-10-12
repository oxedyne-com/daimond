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

// ── THE FENCE (2026-10-12, FIRE-B QA F1/F3) ────────────────────────────────────────────────────────────────────────
// A capture draws the screen only while the daimon's OWN Diamond is on it and the app is visible: a turn started in A
// and left running while the person opened B photographed B's workspace into A's folder. And a path that climbs out of
// the workspace is refused before any consent prompt, as file_read refuses it, rather than asking to change a clamped
// path that is not the one asked for.
const newDiamond = async (name) => {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1200);
	await p.click('#dview-chat');
	await p.waitForTimeout(500);
};
const exists = (path) => p.evaluate(async (pa) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { await m.read_file(pa); return true; } catch (e) { return false; }
}, path);

// A turn in A whose capture lands after the person has moved to B's chat face.
clearMockLog();
const bgPath = 'diamonds/' + id + '/shots/bg.png';
await p.fill('#chat-input', '@rounds 2/5000 capture ' + JSON.stringify({ in: 'screen', path: bgPath }));
await p.click('#chat-send');
await sleep(400);
await newDiamond('Seeview B');
const idB = await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find((x) => x.name === 'Seeview B');
	return d ? d.id : '';
});
const bg = await answerTo('shots/bg.png', 30000);
ok(!!bg && !/^Photographed/.test(bg) && /in:"crystal"/.test(bg),
	'a capture from A while B is on screen is refused, pointing to in:"crystal"', bg.slice(0, 300));
ok(!(await exists(bgPath)), 'and nothing of B was written into A', bgPath);
await sleep(6000);	// the turn's last paced round

// The page's own door, asked directly: every way in to the screen (a view, a selector, the whole window) for A
// while B is up; and B's own capture, which must still draw.
const door = await p.evaluate(async ([a, b]) => {
	const out = {};
	const tryOne = async (k, req) => {
		try { out[k] = JSON.parse(await window.DaimondShot.capture(JSON.stringify(req))).ok ? 'drew' : 'no'; }
		catch (e) { out[k] = 'refused: ' + String(e && e.message || e).slice(0, 160); }
	};
	await tryOne('screenA', { in: 'screen', for: a });
	await tryOne('selectorA', { selector: '#chat-input', for: a });
	await tryOne('screenB', { in: 'screen', for: b });
	// The app off screen: nothing is the person's own view then, not even B's.
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
	await tryOne('hiddenB', { in: 'screen', for: b });
	delete document.visibilityState;
	return out;
}, [id, idB]);
ok(/^refused/.test(door.screenA) && /^refused/.test(door.selectorA),
	'the page refuses A every view of the screen while B is up', JSON.stringify(door));
ok(door.screenB === 'drew', 'B, on screen, still draws its own', JSON.stringify(door));
ok(/^refused: .*not on screen/.test(door.hiddenB || ''), 'nothing draws while the app is not on screen', JSON.stringify(door));

// ── EVERY VIEW HAS AN OWNER (CAPTURE-FENCE QA A F1/F2, rc-b rulings, 2026-10-12) ─────────────────────────────────────
// The fence guarded the centre only. A's .typ was open in Doc and Preview when the person opened B, and B's own
// `capture in:"preview"` saved A's document into B's folder; a capture of the screen or the rail drew every other
// Diamond's name and every other chat's title and last words. A file panel belongs to the conversation it was opened
// in and closes when the person opens another, as the Work panel follows it; the screen and the rail draw another
// conversation's rows blank. Every picture is serialised once, so the last serialisation is the picture's words.
const shoot = (b, reqs) => p.evaluate(async ([b, reqs]) => {
	const ser = XMLSerializer.prototype.serializeToString;
	let last = '';
	XMLSerializer.prototype.serializeToString = function (n) { last = ser.call(this, n); return last; };
	const out = { views: window.DaimondShot.views().join(',') };
	for (const [k, req] of reqs) {
		last = '';
		try { out[k] = JSON.parse(await window.DaimondShot.capture(JSON.stringify(Object.assign({ for: b }, req)))).ok ? 'drew' : 'no'; }
		catch (e) { out[k] = 'refused: ' + String(e && e.message || e).slice(0, 160); }
		// Text nodes only: a row's own words, not an attribute that happens to hold them.
		out[k + 'Words'] = (last.match(/>[^<]+</g) || []).map((x) => x.slice(1, -1).trim()).filter(Boolean);
	}
	XMLSerializer.prototype.serializeToString = ser;
	return out;
}, [b, reqs]);
const switched = await shoot(idB, [['preview', { in: 'preview' }], ['doc', { in: 'doc' }], ['screen', { in: 'screen' }]]);
ok(!/^drew/.test(switched.preview) && !/^drew/.test(switched.doc),
	'B cannot photograph the preview or the document A opened before the switch', JSON.stringify([switched.views, switched.preview, switched.doc]));
ok(!switched.screenWords.includes('Seeview') && switched.screenWords.includes('Seeview B'),
	'B\'s picture of the screen leaves out A\'s row and keeps its own', JSON.stringify(switched.screenWords.filter((w) => /Seeview/.test(w))));

// A chat whose title and last words are its own; then back to B, whose rail capture must show none of them.
await p.click('#new-session-btn');
await p.waitForTimeout(500);
clearMockLog();
await p.fill('#chat-input', 'SENTINELCCC hello from chat');
await p.click('#chat-send');
for (const t0 = Date.now(); Date.now() - t0 < 15000 && !mockLog().length; await sleep(250)) { /* the chat's turn reaches the mock */ }
await sleep(1500);
await p.click('.diamond-box[data-id="' + idB + '"]');
await p.waitForTimeout(700);
await p.click('#dview-chat').catch(() => {});
await p.waitForTimeout(500);
const back = await shoot(idB, [['rail', { in: 'rail' }], ['screen', { in: 'screen' }]]);
const theirs = (ws) => ws.filter((w) => /SENTINELCCC/.test(w) || w === 'Seeview');
ok(back.rail === 'drew' && theirs(back.railWords).length === 0 && back.railWords.includes('Seeview B'),
	'B\'s rail capture shows no other chat\'s or Diamond\'s words, and its own row', JSON.stringify([back.rail.slice(0, 80), theirs(back.railWords)]));
ok(back.screen === 'drew' && theirs(back.screenWords).length === 0,
	'nor does its picture of the whole screen', JSON.stringify([back.screen.slice(0, 80), theirs(back.screenWords)]));

// ── A SHOW FROM ANOTHER CONVERSATION'S TURN (CAPTURE-FENCE, lead ruling on rc-b's per-view owner, 2026-10-12) ──────
// A chat's turn left running while the person opened B called file_show. The show named no owner (a chat's daimon has
// no Diamond), so it took B's screen, and the Doc panel -- claimed for B at the switch -- let B's capture draw the
// chat's file. The show carries the TURN's keeper, so it waits for its own conversation, and the panel is stamped with it.
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file('notes/chatonly.md', '# SENTINELFFF\n\nThe chat\'s own file.\n');
});
const chatId = await p.evaluate(() => {
	const b = [...document.querySelectorAll('.session-box[data-id]:not(.diamond-box)')]
		.find((x) => /SENTINELCCC/.test(x.textContent));
	return b ? b.dataset.id : '';
});
ok(!!chatId, 'the chat is on the rail', chatId);
await p.click('.session-box[data-id="' + chatId + '"]');
await p.waitForTimeout(700);
clearMockLog();
await p.fill('#chat-input', '@rounds 2/5000 file_show ' + JSON.stringify({ path: 'notes/chatonly.md' }));
await p.click('#chat-send');
await sleep(400);
await p.click('.diamond-box[data-id="' + idB + '"]');
await p.waitForTimeout(700);
await p.click('#dview-chat').catch(() => {});
const shownBg = await answerTo('chatonly.md', 30000);
await sleep(1000);
const bgShow = await shoot(idB, [['doc', { in: 'doc' }], ['screen', { in: 'screen' }]]);
const ffs = (ws) => ws.filter((w) => /SENTINELFFF|chatonly/.test(w));
const onB = await p.evaluate(() => (document.getElementById('panel-doc') || {}).textContent || '');
ok(!!shownBg && !/SENTINELFFF/.test(onB),
	'the chat\'s show, made while B is up, does not take B\'s screen', shownBg.slice(0, 200));
ok(!/^drew/.test(bgShow.doc) || ffs(bgShow.docWords).length === 0,
	'B\'s capture of the Doc panel does not draw the chat\'s file', JSON.stringify([bgShow.doc.slice(0, 80), ffs(bgShow.docWords)]));
ok(ffs(bgShow.screenWords).length === 0,
	'nor does B\'s picture of the screen', JSON.stringify(ffs(bgShow.screenWords)));
await sleep(5000);	// the chat turn's last paced round
// Held for its own conversation: opening the chat puts the file in front of the person, once.
await p.click('.session-box[data-id="' + chatId + '"]');
await p.waitForTimeout(1500);
const atChat = await p.evaluate(() => {
	const pn = document.getElementById('panel-doc');
	return { open: !!(pn && pn.getClientRects().length), owner: pn ? pn.getAttribute('data-owner') : '',
		words: pn ? pn.textContent.includes('SENTINELFFF') : false };
});
ok(atChat.open && atChat.words && atChat.owner === 'chat:' + chatId,
	'and the show waits for the chat: opening it shows the file, in a panel stamped with the chat', JSON.stringify(atChat));

// ── THE GRAPH NAMES EVERY DIAMOND (CAPTURE-FENCE, lead ruling, 2026-10-12) ────────────────────────────────────────────
// The Graph panel draws a box per Diamond with its name, so it is other conversations' pixels as the rail is: a capture
// for B draws every other Diamond's box empty and keeps B's own.
await p.click('.diamond-box[data-id="' + idB + '"]');
await p.waitForTimeout(700);
await p.click('#dview-chat').catch(() => {});
await p.evaluate(() => { window.DaimondPanels.show('graph'); if (window.DaimondGraph) window.DaimondGraph.refresh(); });
await p.waitForTimeout(1500);
const named = await p.evaluate(() => [...document.querySelectorAll('#panel-graph .graph-node-name')].map((x) => x.textContent));
ok(named.includes('Seeview') && named.includes('Seeview B'), 'the Graph on screen names A and B', JSON.stringify(named));
const gr = await shoot(idB, [['graph', { in: 'graph' }], ['screen', { in: 'screen' }]]);
ok(gr.graph === 'drew' && !gr.graphWords.includes('Seeview') && gr.graphWords.includes('Seeview B'),
	'B\'s capture of the Graph leaves A\'s box empty and keeps its own', JSON.stringify([gr.graph.slice(0, 80), gr.graphWords.filter((w) => /Seeview/.test(w))]));
ok(gr.screen === 'drew' && !gr.screenWords.includes('Seeview'),
	'nor does its picture of the screen name A', JSON.stringify(gr.screenWords.filter((w) => /Seeview/.test(w))));
await p.evaluate(() => window.DaimondPanels.hide('graph'));

// A path that climbs out of the workspace: refused before any consent prompt.
clearMockLog();
const esc = '../' + id + '/shots/esc.png';
await p.fill('#chat-input', '@tool capture ' + JSON.stringify({ in: 'screen', path: esc }));
await p.click('#chat-send');
let asked = false, escSaid = '';
for (const t0 = Date.now(); Date.now() - t0 < 20000 && !escSaid; await sleep(250)) {
	asked = asked || await p.evaluate(() => [...document.querySelectorAll('.dlg-card')]
		.some((c) => c.getClientRects().length && c.querySelector('.dlg-pre')));
	if (asked) {
		await p.evaluate(() => { const c = [...document.querySelectorAll('.dlg-card .dlg-cancel')].pop(); if (c) c.click(); });
	}
	escSaid = await answerTo('shots/esc.png', 300);
}
ok(!asked, 'a workspace-escaping capture path asks no consent', esc);
// One sentence for every tool, quoting the path as written and saying nothing happened (CAPTURE-FENCE QA B F2).
ok(escSaid.includes("'" + esc + "' uses '..'") && /Nothing was read or changed/.test(escSaid),
	"and is refused in the one '..' sentence, quoting the path written", escSaid.slice(0, 240));

ok(errs.length === 0, 'nothing was thrown', errs.join(' | '));
console.log(bad ? `\nverify_seeview: ${bad} failed.` : '\nverify_seeview: all checks passed');
await s.close();
process.exit(bad ? 1 : 0);
