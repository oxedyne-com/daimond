// verify_scrollstable.mjs — a sync must not move the reader's place in the chat.
//
// The owner, 2026-09-14: "syncs often cause chat content to scroll slightly up or
// down". Measured here rather than argued about: two paired contexts on one
// account, device B collecting a parcel through the real `collectSync` and device
// A merging it through the real `applySync` — the door `sync.js` itself calls when
// a pull lands (js/sync.js, `DaimondCore.applySync(state)`) — with A's transcript
// open and the position of one named tile watched frame by frame across the merge.
//
// Three mechanisms were found, and each has its own break below.
//
//   THE SYSTEM BAND. `renderWire` took `#wire-head` down as its FIRST line and put
//   it back only after an await into the engine. The band sits at the HEAD of the
//   thread, so for that window the transcript was one band shorter and everything
//   in it sat one band higher — and `renderHistory`'s scroll writes land in exactly
//   that window. A reader at the live end was pinned to a scrollHeight 36px short
//   and stayed 36px above the end, every pull, for ever.
//
//   THE SEAT LINE. It sits under the composer, outside the thread, and appears and
//   disappears on a presence beat — which is what a pull delivers. `#chat-output`
//   is the flexible row of that column, so the line arriving takes 25px off the
//   thread's own box; a scroll container keeps its scrollTop when it shrinks, so a
//   reader at the live end was left 25px above it. The composer does the same when
//   the attach prefix is reseeded and its autosize runs.
//
//   THE PER-TURN PIN. The append path draws the new tail through
//   `drawHistoryMessage`, and `appendUserMessage` pins the thread to the bottom for
//   every question it draws — which is what a live turn wants, and is why a reader
//   scrolled up was hauled 599px down the moment another device's turn merged.
//
// Six cases, each asserted in pixels:
//
//   (1) A PULL THAT CHANGES NOTHING leaves the open transcript's DOM untouched —
//       the same element nodes, in the same order — and does not move the thread.
//       This is the owner's own case: both desktops idle, the parcels differing
//       only in the chunk index.
//   (2) A PULL THAT TOUCHES ANOTHER CHAT does the same to the one on screen.
//   (3) A MESSAGE APPENDED to the open chat while the reader is SCROLLED UP leaves
//       the tile they are reading exactly where it was, and the message arrives.
//   (4) A MESSAGE APPENDED while the reader is AT THE LIVE END keeps them there.
//   (5) FURNITURE ARRIVING AROUND THE TRANSCRIPT during the pull — the seat line —
//       keeps a reader at the live end there, and does not move one scrolled up.
//   (6) And the composer growing when the attach prefix is reseeded, which is the
//       same mechanism reaching the thread by the other door.
//
// Every case also watches every animation frame of the merge, so a place that is
// restored after a visible jump fails as well as a place that is lost: "the number
// is the same afterwards" was true of the old code in three of these six.
//
//   eval "$(bash dev/world.sh 36 --env)"
//   node dev/verify_scrollstable.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_scrollstable.mjs --mobile
//   node dev/verify_scrollstable.mjs --break eagerwire
//   node dev/verify_scrollstable.mjs --break rawtop
//   node dev/verify_scrollstable.mjs --break seatresize

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, signInAs, newChat, connectMock, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || '') : ''; };
const BREAK  = argAt('--break');
const MOBILE = process.argv.includes('--mobile');
const TOL    = 1;								// the pixel the owner would not see

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Seams: the fix must be in the file, or a green run proves nothing ──

const SEAM = [
	{ file: 'js/daimond.js', want: 'if (!_wireOn || !current) { dropWire(); return; }',
	  why: 'the System band is still taken down before its replacement exists' },
	{ file: 'js/daimond.js', want: 'function takeAnchor()',
	  why: 'there is no tile anchor, so the place is still only a number' },
	{ file: 'js/daimond.js', want: 'if (_wasAtEnd) setScrollTop(chatOutput.scrollHeight);',
	  why: 'a resize of the thread no longer re-pins a reader at the live end' },
];

// ── The breaks: each puts ONE half of the fix back the way it was ──

const BREAKS = {
	// `renderWire` takes the band down first and awaits, exactly as it did. (1), (3)
	// and (4) redden; (5) is untouched.
	eagerwire: [{
		file: 'js/daimond.js',
		find: '\t\tif (!_wireOn || !current) { dropWire(); return; }',
		with: '\t\tdropWire();\n\t\tif (!_wireOn || !current) return;',
	}, {
		file: 'js/daimond.js',
		find: '\t\tvar heldWire = sameChat ? document.getElementById(\'wire-head\') : null;',
		with: '\t\tvar heldWire = null;\t\t// held back by the break',
	}, {
		file: 'js/daimond.js',
		find: '\t\t\t&& nextSigs.length === _renderedSigs.length && isAppendOf(_renderedSigs, nextSigs)) {\n\t\t\trenderHistoryFurniture();\n\t\t\treturn;\n\t\t}',
		with: '\t\t\t&& false) {\n\t\t\trenderHistoryFurniture();\n\t\t\treturn;\n\t\t}',
	}],
	// The rebuild restores the raw scrollTop and holds nothing, as it did. The
	// transcript-DOM cases still pass; the moving ones redden.
	rawtop: [{
		file: 'js/daimond.js',
		find: '\t\t\tif (!applyAnchor(anchor)) anchor = null;\n\t\t\tholdAnchor(anchor);',
		with: '\t\t\tanchor = null;\t\t// the anchor restore severed by the break',
	}, {
		file: 'js/daimond.js',
		find: '\t\t\t\tif (wasDown) { setScrollTop(chatOutput.scrollHeight); holdBottom(); }\n\t\t\t\telse { if (!applyAnchor(anchor)) anchor = null; holdAnchor(anchor); }',
		with: '\t\t\t\tif (wasDown) setScrollTop(chatOutput.scrollHeight);',
	}],
	// The thread's box may resize under a reader at the live end without their
	// being put back on it. Only (5) reddens.
	seatresize: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tif (_wasAtEnd) setScrollTop(chatOutput.scrollHeight);',
		with: '\t\t\t\tif (false) setScrollTop(chatOutput.scrollHeight);',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const FILES = new Map();
function edit(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}
function build() {
	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const src = FILES.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
			FILES.set(spec.file, edit(src, spec));
		}
	}
	const missing = [];
	for (const s of SEAM) {
		const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the place-keeping seams are not in the source, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}
build();

async function serveBroken(page) {
	for (const [p, body] of FILES) {
		await page.route('**/' + p, r => r.fulfill({ status: 200,
			contentType: 'application/javascript', body }));
	}
}

// ── Reading the thread ─────────────────────────────────────

/// Stamp every direct child of the thread, so a rebuild is detectable by identity
/// rather than by a count that a faithful rebuild would also satisfy.
/// The TILES, not the band: `#wire-head` is redrawn from the engine on every render
/// by design and is not part of the transcript.
const stamp = (pg) => pg.evaluate(() => {
	const o = document.getElementById('chat-output');
	let n = 0;
	for (const k of o.querySelectorAll(':scope > .ctile[data-turn], :scope > .crollup[data-turn]')) {
		k.setAttribute('data-probe', String(n++));
	}
	return n;
});
const stamps = (pg) => pg.evaluate(() => Array.from(document.getElementById('chat-output')
	.querySelectorAll(':scope > .ctile[data-turn], :scope > .crollup[data-turn]'))
	.map((k) => k.getAttribute('data-probe')).join(','));

/// Mark the tile the reader is looking at, by its own text, and start sampling
/// where it sits — every animation frame, for as long as the merge can take.
const watch = (pg, ms) => pg.evaluate((ms) => {
	// KEYED BY TURN AND ORDINAL, not by text: the mock answers every question with
	// the same words, so a text key finds the FIRST tile that says them and reports
	// a different tile's position as this one having moved 600px. The key has to be
	// something a faithful rebuild reproduces and two tiles cannot share.
	const key = (o) => {
		const seen = {}, out = new Map();
		for (const k of o.children) {
			if (!k.dataset || k.dataset.turn == null) continue;
			const t = String(k.dataset.turn);
			seen[t] = (seen[t] || 0) + 1;
			out.set(t + '#' + seen[t], k);
		}
		return out;
	};
	const o = document.getElementById('chat-output');
	const or = o.getBoundingClientRect();
	let mark = '';
	for (const [k, el] of key(o)) {				// the first tile still on screen
		if (el.getBoundingClientRect().bottom - or.top > 1) { mark = k; break; }
	}
	window.__mark = mark;
	window.__samples = [];
	const t0 = performance.now();
	const tick = () => {
		const oo = document.getElementById('chat-output');
		const el = key(oo).get(window.__mark) || null;
		const oor = oo.getBoundingClientRect();
		window.__samples.push({
			t:    Math.round(performance.now() - t0),
			top:  el ? Math.round((el.getBoundingClientRect().top - oor.top) * 100) / 100 : null,
			st:   oo.scrollTop,
			gap:  oo.scrollHeight - oo.scrollTop - oo.clientHeight,
		});
		if (performance.now() - t0 < ms) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return window.__mark;
}, ms);

const samples = (pg) => pg.evaluate(() => window.__samples || []);

/// The worst the marked tile moved at ANY frame, and where it ended.
function movement(ss) {
	const seen = ss.filter((s) => s.top !== null);
	if (!seen.length) return { worst: null, end: null, first: null };
	const first = seen[0].top;
	let worst = 0;
	for (const s of seen) worst = Math.max(worst, Math.abs(s.top - first));
	return { worst: Math.round(worst * 100) / 100, end: seen[seen.length - 1].top, first };
}
const gapEnd = (ss) => (ss.length ? ss[ss.length - 1].gap : null);

const scrollTo = (pg, where) => pg.evaluate((w) => {
	const o = document.getElementById('chat-output');
	o.scrollTop = w === 'mid' ? Math.floor((o.scrollHeight - o.clientHeight) / 2)
		: w === 'bot' ? o.scrollHeight : o.scrollHeight - o.clientHeight - 20;
	return { st: o.scrollTop, max: o.scrollHeight - o.clientHeight };
}, where);

/// B's parcel into A, through the two doors a real pull uses.
async function pull(a, b) {
	const parcel = await b.page.evaluate(() => window.DaimondCore.collectSync());
	await a.page.evaluate((p) => window.DaimondCore.applySync(p), parcel);
}

let a, b;
try {
	const PA = scratch('pw', 'scrollstable-a' + (BREAK ? '-' + BREAK : ''));
	const PB = scratch('pw', 'scrollstable-b' + (BREAK ? '-' + BREAK : ''));
	fs.rmSync(PA, { recursive: true, force: true });
	fs.rmSync(PB, { recursive: true, force: true });

	a = await open({ name: 'scrollA', profile: PA, route: FILES.size ? serveBroken : null });
	await connectMock(a);
	await newChat(a);
	// A transcript with enough in it to scroll, and an equation in every answer so
	// the layout has something that settles after the tiles are drawn.
	for (let i = 0; i < 6; i++) {
		await chat(a, 'turn ' + (i + 1) + ': answer in several lines, with an equation '
			+ '$\\sum_{i=1}^{n} x_i^2$ in the middle of it');
	}
	await a.page.waitForTimeout(800);
	// A PHONE'S OWN SHAPE, and only now: at 390px wide the rail's new-chat button is
	// off screen, so the chat is made at the window the harness opened and the thread
	// is then measured at the height the owner reads it on.
	if (MOBILE) { await a.page.setViewportSize({ width: 390, height: 844 }); await a.page.waitForTimeout(600); }
	const openId = await a.page.evaluate(() => {
		const f = window.DaimondAttach && window.DaimondAttach.focus();
		return f && f.kind === 'chat' ? String(f.id) : '';
	});
	check('A has a chat open with a transcript that overflows the window',
		!!openId && await a.page.evaluate(() => {
			const o = document.getElementById('chat-output');
			return o.scrollHeight - o.clientHeight > 80;
		}), 'chat ' + openId);

	b = await open({ name: 'scrollB', profile: PB, signIn: false, connect: false });
	await signInAs(b, 'scrollA');
	await b.page.waitForTimeout(1500);
	await connectMock(b);
	// B is given A's account state the same way it would receive it: through applySync.
	await b.page.evaluate((p) => window.DaimondCore.applySync(p),
		await a.page.evaluate(() => window.DaimondCore.collectSync()));
	await b.page.waitForTimeout(1200);
	check('B holds the same chat, so its parcel is about the thread A has open',
		await b.page.evaluate((id) => window.DaimondCore.chatResidency().some((c) => c.id === id), openId));

	// ── (1) A pull that changes nothing ────────────────────────
	// ONE SETTLING PULL FIRST, and it is not a formality. A live turn reaches the
	// thread without `renderHistory` (the tiles are drawn as the answer streams), so
	// the first render after one normalises what is standing -- a full rebuild, by
	// design. The owner's case is two IDLE desktops, which is the state AFTER that:
	// so the settle is made here, its own effect on the reader is asserted, and the
	// measured pull is the second one.
	await scrollTo(a.page, 'mid');
	await a.page.waitForTimeout(400);
	await watch(a.page, 2000);
	await pull(a, b);
	await a.page.waitForTimeout(2400);
	const m0 = movement(await samples(a.page));
	check('(0) the settling pull after a live turn does not move the reader either',
		m0.worst !== null && m0.worst <= TOL, 'worst ' + m0.worst + 'px');

	await scrollTo(a.page, 'mid');
	await a.page.waitForTimeout(400);
	await stamp(a.page);
	const ids1 = await stamps(a.page);
	const mark1 = await watch(a.page, 2000);
	await pull(a, b);
	await a.page.waitForTimeout(2400);
	const s1 = await samples(a.page), m1 = movement(s1);
	check('(1) an unchanged pull leaves the transcript\'s own element nodes standing',
		await stamps(a.page) === ids1 && ids1.length > 0,
		'before=' + ids1 + ' after=' + await stamps(a.page));
	check('(1) and does not move the tile the reader is on, at any frame',
		m1.worst !== null && m1.worst <= TOL,
		'marked ' + JSON.stringify(mark1.slice(0, 24)) + ', worst ' + m1.worst + 'px, '
		+ 'ended ' + m1.end + ' from ' + m1.first);

	// ── (2) A pull that touches ANOTHER chat ───────────────────
	await b.page.evaluate(() => { window.__before = null; });
	await newChat(b);
	await chat(b, 'a turn in a different chat entirely');
	await b.page.waitForTimeout(600);
	await scrollTo(a.page, 'mid');
	await a.page.waitForTimeout(400);
	await stamp(a.page);
	const ids2 = await stamps(a.page);
	await watch(a.page, 2000);
	await pull(a, b);
	await a.page.waitForTimeout(2400);
	const m2 = movement(await samples(a.page));
	check('(2) a pull that touches another chat leaves this transcript\'s nodes standing',
		await stamps(a.page) === ids2, 'before=' + ids2 + ' after=' + await stamps(a.page));
	check('(2) and does not move the thread on screen',
		m2.worst !== null && m2.worst <= TOL, 'worst ' + m2.worst + 'px');

	// ── (3) A message appended while the reader is scrolled up ──
	// B opens the SAME chat and runs a turn in it, so what arrives is a real turn
	// merged by the real union rather than a record written for the test.
	await b.page.click('.session-box[data-id="' + openId + '"] .tile-label', { force: true });
	await b.page.waitForTimeout(600);
	check('B has the same chat in focus, so its next turn lands in A\'s open thread',
		await b.page.evaluate(() => {
			const f = window.DaimondAttach && window.DaimondAttach.focus();
			return f && f.kind === 'chat' ? String(f.id) : '';
		}) === openId);
	await chat(b, 'a turn added from the other device while the reader is scrolled up');
	await b.page.waitForTimeout(600);
	await scrollTo(a.page, 'mid');
	await a.page.waitForTimeout(400);
	const mark3 = await watch(a.page, 2500);
	const n3 = await a.page.evaluate(() => document.querySelectorAll('#chat-output .ctile').length);
	await pull(a, b);
	await a.page.waitForTimeout(3000);
	const m3 = movement(await samples(a.page));
	check('(3) the appended turn reaches A',
		await a.page.evaluate(() => (document.getElementById('chat-output').innerText || '')
			.includes('while the reader is scrolled up'))
		|| await a.page.evaluate(() => document.querySelectorAll('#chat-output .ctile').length) > n3,
		'tiles ' + n3 + ' -> ' + await a.page.evaluate(() => document.querySelectorAll('#chat-output .ctile').length));
	check('(3) and the tile the reader was on does not move, at any frame',
		m3.worst !== null && m3.worst <= TOL,
		'marked ' + JSON.stringify(mark3.slice(0, 24)) + ', worst ' + m3.worst + 'px, '
		+ 'ended ' + m3.end + ' from ' + m3.first);

	// ── (4) A message appended while the reader is at the live end ──
	await chat(b, 'and one more turn, for the reader who is at the live end');
	await b.page.waitForTimeout(600);
	await scrollTo(a.page, 'bot');
	await a.page.waitForTimeout(400);
	await watch(a.page, 2500);
	await pull(a, b);
	await a.page.waitForTimeout(3000);
	const s4 = await samples(a.page);
	check('(4) a reader at the live end is still at the live end after the pull',
		gapEnd(s4) !== null && Math.abs(gapEnd(s4)) <= TOL,
		'ended ' + gapEnd(s4) + 'px from the end');
	check('(4) and the new turn is the thing they are looking at',
		await a.page.evaluate(() => (document.getElementById('chat-output').innerText || '')
			.includes('at the live end')));

	// ── (5) Furniture arriving around the transcript during the pull ──
	// The seat line is the one that moves on a sync: it is written from the presence
	// beats a pull delivers, it sits outside the thread, and the thread is the
	// flexible row of the column it sits in.
	const seatable = await a.page.evaluate(() => !!document.getElementById('seat-line'));
	await scrollTo(a.page, 'bot');
	await a.page.waitForTimeout(400);
	await watch(a.page, 2000);
	await a.page.evaluate(() => { document.getElementById('seat-line').hidden = true; });
	await a.page.waitForTimeout(300);
	await a.page.evaluate(() => { document.getElementById('seat-line').hidden = false; });
	await a.page.waitForTimeout(1400);
	const s5 = await samples(a.page);
	check('(5) the seat line coming and going leaves a reader at the live end on it',
		seatable && gapEnd(s5) !== null && Math.abs(gapEnd(s5)) <= TOL,
		'ended ' + gapEnd(s5) + 'px from the end');
	await scrollTo(a.page, 'mid');
	await a.page.waitForTimeout(400);
	await watch(a.page, 2000);
	await a.page.evaluate(() => { document.getElementById('seat-line').hidden = true; });
	await a.page.waitForTimeout(300);
	await a.page.evaluate(() => { document.getElementById('seat-line').hidden = false; });
	await a.page.waitForTimeout(1400);
	const m5 = movement(await samples(a.page));
	check('(5) and does not move a reader who is scrolled up',
		m5.worst !== null && m5.worst <= TOL, 'worst ' + m5.worst + 'px');

	// ── (6) The composer growing under the thread ──────────────
	// The other thing a pull resizes: `syncComposerAttachPrefix` reseeds the box and
	// dispatches an `input` event, and the autosize on that event makes the composer
	// as tall as its text. The same mechanism as the seat line reaching the thread by
	// a different door, so it is asserted rather than argued from that one.
	await scrollTo(a.page, 'bot');
	await a.page.waitForTimeout(400);
	await watch(a.page, 2000);
	const grew = await a.page.evaluate(() => {
		const i = document.getElementById('chat-input'), o = document.getElementById('chat-output');
		const h0 = o.clientHeight;
		i.value = 'Read one.txt\nRead two.txt\nRead three.txt\nRead four.txt';
		i.dispatchEvent(new Event('input', { bubbles: true }));
		return { h0: h0, h1: o.clientHeight };
	});
	await a.page.waitForTimeout(1400);
	const s6 = await samples(a.page);
	check('(6) the composer growing under the thread leaves a reader at the live end on it',
		grew.h1 < grew.h0 && gapEnd(s6) !== null && Math.abs(gapEnd(s6)) <= TOL,
		'thread ' + grew.h0 + ' -> ' + grew.h1 + 'px tall, ended ' + gapEnd(s6) + 'px from the end');
	await a.page.evaluate(() => {
		const i = document.getElementById('chat-input');
		i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
	});
} catch (e) {
	console.error('the run threw: ' + (e && (e.stack || e.message) || e));
	bad.push('the run threw');
} finally {
	try { await a?.close?.(); } catch {}
	try { await b?.close?.(); } catch {}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed'
	+ (BREAK ? '  (break: ' + BREAK + ')' : '') + (MOBILE ? '  (mobile viewport)' : ''));
if (bad.length) for (const n of bad) console.log('  FAILED: ' + n);
process.exit(bad.length ? 1 : 0);
