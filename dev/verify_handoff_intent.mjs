// gateway: live
// verify_handoff_intent.mjs — a handed-off turn opens its files on the device that ASKED (D-20261006-27).
//
// WHAT HAPPENED. A turn asked on one device and run on another opened its files on
// the RUNNER, over whatever was on that desk, while the person who asked sat at the
// first device with nothing new in front of them; and the model was told the file
// had gone to "another Diamond", which it repeated to the user.
//
// THE PROPERTIES:
//
//   (1) A hands B a turn that writes a note and a PDF and shows both.
//   (2) The files reach A's own store by the account's workspace sync, so A can open
//       them from where it keeps everything else.
//   (3) On A, the Doc panel holds the note and the Preview panel is open on the PDF,
//       in front: the two share the stage, and the file shown last is the one in view.
//   (4) B's screen is left exactly as it was.
//   (5) The model on B is told the file is going to A's screen, by A's name, as "the
//       device they asked from" -- never "another Diamond".
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_intent.mjs

import {
	checker,
	pair,
	until,
	storedMsgs,
	placeholders,
	send,
	freshChat,
} from './handoffpair.mjs';
import { mockLog } from './harness.mjs';

const CLAIM_MS = 30000;			// B claims the turn this soon
const FILES_MS = 60000;			// and its files reach A's store
const PANEL_MS = 45000;			// and A's panels hold them, once there
const { ok, bad, check } = checker();

/// What a person sees in the Doc and Preview panels.
const screen = (s) => s.page.evaluate(() => {
	const seen = (id) => {
		const el = document.getElementById(id);
		if (!el) return false;
		const cs = getComputedStyle(el);
		return el.getClientRects().length > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
	};
	const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : ''; };
	return { doc: seen('panel-doc'), docName: txt('doc-name'), pv: seen('panel-preview'), pvName: txt('pv-name') };
}).catch((e) => ({ error: String(e) }));

/// Does A's own store hold `path`, by the account's sandbox?
const holds = (s, path) => s.page.evaluate(async (p) => {
	try { return !!(await window.DaimondCloud.fileAt(p)); } catch (e) { return false; }
}, path).catch(() => false);

let a, b;
try {
	({ a, b } = await pair(check, 'intentlead', 'intentmate'));
	for (const s of [a, b]) {
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'intent'); } catch (e) { /* none */ } });
	}
	const tag = Math.random().toString(36).slice(2, 8);

	// A chat's files live in its own workspace, `chats/<id>/work`, so the chat is opened
	// with a first turn and its id read back before the turn that writes is sent.
	await freshChat(a);
	await send(a.page, '@text opening ' + tag);
	let cid = '';
	for (const t0 = Date.now(); !cid && Date.now() - t0 < 60000; ) {
		cid = await a.page.evaluate(async (t) => {
			const cs = window.DaimondCore.chatStore();
			for (const sum of cs.stored()) {
				let got = null;
				try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
				const ms = (got && got.messages) || [];
				const at = ms.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(t));
				if (at >= 0 && ms.slice(at + 1).some((m) => m && m.role === 'assistant' && String(m.content || '').trim())) return sum.id;
			}
			return '';
		}, 'opening ' + tag).catch(() => '');
		if (!cid) await a.page.waitForTimeout(500);
	}
	check('(0) A\'s chat is open and answered', !!cid, cid || 'no answer in 60 s');
	const dir = 'chats/' + cid + '/work/uc4/';
	const note = dir + 'n' + tag + '.md', pdf = dir + 'p' + tag + '.pdf';
	const body = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
		+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
	const prompt = '@seq file_write ' + JSON.stringify({ path: note, content: '# Note ' + tag + '\n\nFor the asker.\n' })
		+ ' ;; file_write ' + JSON.stringify({ path: pdf, content: body })
		+ ' ;; file_show ' + JSON.stringify({ path: note })
		+ ' ;; file_show ' + JSON.stringify({ path: pdf });

	// ── (1) The turn goes to B ─────────────────────────────────
	console.log('\n(1) A hands B a turn that shows two files');
	await b.page.setViewportSize({ width: 1280, height: 900 });
	const before = await screen(b);
	const sent = Date.now();
	await send(a.page, prompt);
	let ph = null;
	for (let i = 0; i < 120 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes('n' + tag + '.md')) || null;
		if (!ph) await a.page.waitForTimeout(250);
	}
	const tid = ph ? String(ph.iturn) : '';
	check('(1) A handed the turn off', !!tid, tid || 'no dispatched placeholder');
	const claimed = tid ? await until(b.page, (t) => {
		try { return window.DaimondDiag.rows().some((r) => r.tag === 'collect CLAIMED' && String(r.data).includes(t)); }
		catch (e) { return false; }
	}, tid, CLAIM_MS) : false;
	check('(1) B claimed it', claimed, claimed ? 'at +' + (Date.now() - sent) + 'ms' : 'no claim in ' + CLAIM_MS + 'ms');
	// The person looks at A as a desk would: a phone's width folds Preview into the Doc sheet.
	await a.page.setViewportSize({ width: 1280, height: 900 });

	// ── (2) The files reach A by sync ──────────────────────────
	console.log('\n(2) B\'s files reach A\'s own store');
	let got = 0;
	while (!got && Date.now() - sent < FILES_MS) {
		if (await holds(a, note) && await holds(a, pdf)) got = Date.now() - sent;
		else await a.page.waitForTimeout(500);
	}
	check('(2) A holds both files', got > 0, got ? 'at +' + got + 'ms' : 'not in ' + FILES_MS + 'ms');
	if (!got) {
		// Where the files are, so a red here says which leg of the sync did not run.
		console.log('  ..    B holds note/pdf: ' + await holds(b, note) + '/' + await holds(b, pdf)
			+ '  A: ' + await holds(a, note) + '/' + await holds(a, pdf));
		const wrote = [];
		for (const r of mockLog()) for (const m of (r.messages || [])) {
			const c = String((m && m.content) || '');
			if (m && m.role === 'tool' && c.includes(tag) && !wrote.includes(c)) wrote.push(c);
		}
		for (const c of wrote.slice(0, 4)) console.log('  ..    tool: ' + c.slice(0, 200).replace(/\s+/g, ' '));
		for (const [n, s] of [['A', a], ['B', b]]) {
			const d = await s.page.evaluate(() => {
				try {
					return window.DaimondDiag.rows().filter((r) => /sync|push|pull|files/i.test(String(r.tag)))
						.map((r) => String(r.tag) + ' ' + String(r.data).slice(0, 100)).slice(-6);
				} catch (e) { return []; }
			}).catch(() => []);
			for (const r of d) console.log('  ..    ' + n + ': ' + r);
		}
	}

	// ── (3) A's panels hold them ───────────────────────────────
	console.log('\n(3) A\'s panels open on them');
	let onA = null, at = 0;
	for (const t0 = Date.now(); Date.now() - t0 < PANEL_MS; ) {
		onA = await screen(a);
		if (onA.docName.includes('n' + tag) && onA.pv && onA.pvName.includes('p' + tag)) { at = Date.now() - sent; break; }
		await a.page.waitForTimeout(500);
	}
	check('(3) A\'s Doc panel holds the note', !!(onA && onA.docName.includes('n' + tag)), JSON.stringify(onA));
	check('(3) A\'s Preview panel is open on the PDF', !!(onA && onA.pv && onA.pvName.includes('p' + tag)),
		at ? 'at +' + at + 'ms' : JSON.stringify(onA));

	// ── (4) B's screen is untouched ────────────────────────────
	console.log('\n(4) B\'s screen is as it was');
	const after = await screen(b);
	check('(4) B\'s Doc and Preview panels are unchanged', JSON.stringify(after) === JSON.stringify(before),
		JSON.stringify(before) + ' -> ' + JSON.stringify(after));

	// ── (5) What the model was told ────────────────────────────
	console.log('\n(5) the model on B is told whose screen it is');
	const said = [];
	for (const r of mockLog()) {
		const msgs = (r && (r.messages || (r.body && r.body.messages))) || [];
		for (const m of msgs) {
			const c = typeof (m && m.content) === 'string' ? m.content : JSON.stringify((m && m.content) || '');
			if (m && m.role === 'tool' && (c.includes('n' + tag) || c.includes('p' + tag)) && /screen|show|open/i.test(c)
				&& !said.includes(c)) said.push(c);
		}
	}
	const shows = said.filter((c) => /going to|open|screen/i.test(c) && !/^(Wrote|Written)/i.test(c));
	const named = shows.filter((c) => /on ([^,]+), the device they asked from/.test(c));
	for (const c of shows.slice(0, 2)) console.log('  ..    ' + c.slice(0, 220).replace(/\s+/g, ' '));
	check('(5) the show results name the asking device', shows.length >= 2 && named.length === shows.length,
		named.length + ' of ' + shows.length + ' name it');
	check('(5) and never "another Diamond"', !said.some((c) => /another Diamond/i.test(c)));
	const rows = await a.page.evaluate(() => {
		try {
			return window.DaimondDiag.rows().filter((r) => String(r.tag).startsWith('handoff panel'))
				.map((r) => String(r.tag) + ' ' + String(r.data).slice(0, 120));
		} catch (e) { return []; }
	}).catch(() => []);
	for (const r of rows.slice(-4)) console.log('  ..    A: ' + r);
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
