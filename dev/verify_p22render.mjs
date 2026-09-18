// p22 render: the end-of-turn tail note ("[Daimond: this turn changed N files
// (vV): …]") must reach the transcript as a TOOL tile carrying the changed-files
// table — driven through the REAL app: harness open, mock provider, a real
// file_write turn, then assert on the live DOM (#chat-output).
//
// Defect this guards: v61's tool-tile change returned the tile early WITHOUT
// postToChat (nothing reached the transcript at all) and looked for
// '.chat-msg-content' inside a ctile whose body is '.ctile-body' (so even a
// posted tile would have shown no table). Source checks alone cannot see that —
// verify_p22table passed green while the render was broken — so this verifier
// drives the browser.
//
// Declared breaks (each must redden at least one check):
//   nopost   strip postToChat(d2) from the divert branch
//   noquery  point the table insert at '.chat-msg-content' (the wrong node)
//   usertile divert to buildTile('user', …) instead of 'tool'

import { readFileSync, writeFileSync } from 'node:fs';
import { open, chat, newChat, shot } from './harness.mjs';

const BIDX = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.slice(8) : (BIDX >= 0 ? (process.argv[BIDX + 1] || '') : '');

const JS = 'www/js/daimond.js';
let src = readFileSync(JS, 'utf8');
const ORIG = src;

if (BREAK === 'nopost') {
	src = src.replace('\t\t\ttilePeek(d2, text);\n\t\t\tpostToChat(d2);\n\t\t\tsetScrollTop(chatOutput.scrollHeight);\n\t\t\treturn d2;',
		'\t\t\ttilePeek(d2, text);\n\t\t\treturn d2;');
	if (src === ORIG) { console.log('break nopost: pattern not found'); process.exit(2); }
	writeFileSync(JS, src);
} else if (BREAK === 'noquery') {
	src = src.replace("var c = d2.querySelector('.ctile-body');", "var c = d2.querySelector('.chat-msg-content');");
	if (src === ORIG) { console.log('break noquery: pattern not found'); process.exit(2); }
	writeFileSync(JS, src);
} else if (BREAK === 'usertile') {
	src = src.replace("var d2 = buildTile('tool', { expanded: true, copy: text, ts: ts });",
		"var d2 = buildTile('user', { expanded: true, copy: text, ts: ts });");
	if (src === ORIG) { console.log('break usertile: pattern not found'); process.exit(2); }
	writeFileSync(JS, src);
}

let checks = 0, fails = 0;
const ck = (name, ok) => {
	checks++;
	if (!ok) { fails++; console.log('  FAIL ' + name); }
	else console.log('  ok   ' + name);
};

try {
	// 1. source shape: the divert exists, posts, and targets the ctile body
	const s = readFileSync(JS, 'utf8');
	const i = s.indexOf('function appendUserMessage');
	const branch = s.slice(i, i + 900);
	ck('divert branch present in appendUserMessage', /this turn changed /.test(branch) && /buildTile\('tool'/.test(branch));
	ck('divert posts the tile (postToChat)', /postToChat\(d2\)/.test(branch));
	ck('table lands in .ctile-body', branch.includes("d2.querySelector('.ctile-body')"));

	// 2. live render: a real turn that writes a file
	const sess = await open();
	await newChat(sess);
	const dir = await sess.page.evaluate(() => {
		const f = window.DaimondAttach.focus();
		return window.DaimondAttach.chatScratch(f.id);
	});
	const t0 = await chat(sess, `@tool file_write {"path":"${dir}/p22render.txt","content":"hello table\n"}`);
	const dom = await sess.page.evaluate(() => {
		const out = document.getElementById('chat-output');
		const tiles = out ? Array.from(out.querySelectorAll('.ctile')) : [];
		const noteTile = tiles.filter(t => (t.innerText || '').includes('this turn changed'));
		const first = noteTile[0] || null;
		return {
			count: noteTile.length,
			isTool: first ? first.dataset.t === 'tool' : false,
			hasTable: first ? !!first.querySelector('.turn-files') : false,
			rows: first ? first.querySelectorAll('.turn-file-row').length : 0,
			delta: first ? (first.querySelector('.turn-file-delta') || {}).textContent || '' : '',
			clickTarget: first ? !!first.querySelector('.turn-file-name') : false,
		};
	});
	ck('exactly one tail-note tile in the transcript', dom.count === 1);
	ck('tail-note tile is a TOOL tile', dom.isTool);
	ck('tail-note tile carries the changed-files table', dom.hasTable);
	ck('table has one row for the written file', dom.rows === 1);
	ck('row shows a +N delta (green additions)', /\+\d+/.test(dom.delta));
	ck('row name is a click target (opens the file)', dom.clickTarget);

	await shot(sess, 'p22-render');
	await sess.close();
} catch (e) {
	fails++;
	console.log('  FAIL harness run: ' + (e && e.message));
} finally {
	if (src !== ORIG) writeFileSync(JS, ORIG);
}

console.log(BREAK ? `break ${BREAK}: ${fails} FAIL of ${checks}` : `CLEAN            ${checks - fails} passed, ${fails} failed, exit ${fails ? 1 : 0}, 0 ms`);
process.exit(fails ? 1 : 0);
