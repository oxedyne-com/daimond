// verify_tiledatetime.mjs — local Holocene datetime on every chat transcript tile header.
//
// The owner, 2026-09-15: "we should have local datetime in format e.g.
// 12026-09-15 13:12, using Holocene calendar, on the headers of all chat
// transcript tiles" — local (the device's zone), 24-hour, minutes, no seconds,
// no zone suffix on the tile itself (the full ISO instant with its offset is
// the hover title).
//
// The formatting itself is unit-tested directly (`node www/js/time.test.mjs`,
// no DOM, no zone the test does not choose for itself). This drives the real
// page instead, because what the formatting proves nothing about is WHERE the
// figure lands and under WHICH zone the browser is actually running: a tile
// header built from a stored message on reload, one built live as a turn
// streams in, a message with no `ts` at all (a record predating this feature),
// and the same instant read through two different device clocks.
//
//   eval "$(bash dev/world.sh 33 --env)"
//   node dev/verify_tiledatetime.mjs
//   node dev/verify_tiledatetime.mjs --break noholocene
//   node dev/verify_tiledatetime.mjs --break utc
//   node dev/verify_tiledatetime.mjs --break seconds
//   node dev/verify_tiledatetime.mjs --break missingts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, signInAs, newChat, chat } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || '') : ''; };
const BREAK = argAt('--break');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Seams: the fix must be in the file, or a green run proves nothing ──

const SEAM = [
	{ file: 'js/time.js', want: "function holoceneYear(d) { return d.getFullYear() + 10000; }",
	  why: 'the Holocene offset is no longer on the local year' },
	{ file: 'js/time.js', want: "pad2(d.getHours()) + ':' + pad2(d.getMinutes());",
	  why: 'the tile string no longer reads the LOCAL hour and minute' },
	{ file: 'js/daimond.js', want: 'if (!ts || !window.DaimondTime) return null;',
	  why: 'a tile with no timestamp would no longer draw nothing' },
];

// ── The breaks: each puts ONE named bug back ──

const BREAKS = {
	// The Gregorian year, undisguised — `verify_year` (check B) reddens.
	noholocene: [{
		file: 'js/time.js',
		find: 'function holoceneYear(d) { return d.getFullYear() + 10000; }',
		with: 'function holoceneYear(d) { return d.getFullYear(); }',
	}],
	// UTC getters where the whole point is the device's own zone — check B (the
	// two-zone comparison) reddens for whichever session's zone is not UTC's.
	utc: [{
		file: 'js/time.js',
		find: "return holoceneYear(d) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())\n\t\t\t+ ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());\n\t}\n\n\t/// The same instant",
		with: "return holoceneYear(d) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())\n\t\t\t+ ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());\n\t}\n\n\t/// The same instant",
	}, {
		// `holoceneYear` itself stays local -- only fmtHolocene's OWN getters are
		// broken, isolating the break to the one function the tiles actually call.
		file: 'js/time.js',
		find: 'function fmtHolocene(ts) {\n\t\tif (!isInstant(ts)) return \'\';\n\t\tvar d = new Date(ts);\n\t\treturn holoceneYear(d)',
		with: 'function fmtHolocene(ts) {\n\t\tif (!isInstant(ts)) return \'\';\n\t\tvar d = new Date(ts);\n\t\tvar holoceneYear = function (dd) { return dd.getUTCFullYear() + 10000; };\n\t\treturn holoceneYear(d)',
	}],
	// Seconds put back on the tile string — check C reddens.
	seconds: [{
		file: 'js/time.js',
		find: "return holoceneYear(d) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())\n\t\t\t+ ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());\n\t}\n\n\t/// The same instant",
		with: "return holoceneYear(d) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())\n\t\t\t+ ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());\n\t}\n\n\t/// The same instant",
	}],
	// A message with no `ts` gets one invented at draw time — check D reddens.
	missingts: [{
		file: 'js/daimond.js',
		find: 'function tileTimeEl(ts) {\n\t\tif (!ts || !window.DaimondTime) return null;',
		with: 'function tileTimeEl(ts) {\n\t\tif (!window.DaimondTime) return null;\n\t\tif (!ts) ts = Date.now();\t\t// broken: a missing ts should draw nothing',
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
		console.error('the tile-datetime seams are not in the source, so this run would prove nothing:');
		for (const m of missing) console.error(m);
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

// ── An independent oracle: the LOCAL reading of an epoch in a NAMED zone, read
// through Node's own Intl rather than anything this feature wrote. ──────────

function localParts(epochMs, timeZone) {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone, hour12: false,
		year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
	});
	const p = {};
	for (const part of dtf.formatToParts(epochMs)) p[part.type] = part.value;
	// Some ICU builds print midnight as "24" under hour12:false.
	if (p.hour === '24') p.hour = '00';
	return p;
}
function expectHolocene(epochMs, timeZone) {
	const p = localParts(epochMs, timeZone);
	return String(Number(p.year) + 10000) + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
}

// ── The fixture: one chat, four messages, one of them with no `ts` at all ──

const FIXED_TS = Date.UTC(2026, 8, 15, 23, 0, 0);		// 2026-09-15 23:00:00 UTC

function fixtureChat() {
	return {
		id: 'tiledt1', name: 'Tile datetime fixture',
		model: 'mock/fast', provider: 'mock', status: 'active',
		promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
		prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
		updatedAt: Date.now(),
		messages: [
			{ role: 'user', mid: 'u1', ts: FIXED_TS,
			  content: 'MARK_USER a message with a known timestamp' },
			{ role: 'assistant', mid: 'a1', ts: FIXED_TS + 60000,
			  content: 'MARK_ASST an assistant reply with a known timestamp' },
			{ role: 'tool_log', mid: 'to1', ts: FIXED_TS + 120000, name: 'run_shell_command',
			  args: '{"cmd":"echo MARK_TOOL hi && echo a rather longer line to give the peek something to clip"}',
			  outcome: 'done', callId: 'c1', content: 'hi\na rather longer line to give the peek something to clip' },
			// NO `ts` AT ALL -- the shape of a record from before this feature shipped.
			// `hydrateChat`/`stampMessages` normalises the absent field to `ts: 0` on
			// load, which is why this is asserted by CONTENT below rather than by
			// position: a `0` sorts to the front of a merge in time order, so this
			// message -- last in the array -- is not necessarily the last tile drawn.
			{ role: 'user', mid: 'u2',
			  content: 'MARK_NOTS a legacy message with no timestamp' },
		],
	};
}

function seed(page, rec) {
	return page.evaluate((r) => new Promise((res, rej) => {
		const req = indexedDB.open('daimond-chats');
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
		};
		req.onsuccess = () => {
			const db = req.result;
			const t = db.transaction('chats', 'readwrite');
			t.objectStore('chats').put(r);
			t.oncomplete = () => res(); t.onerror = () => rej(t.error);
		};
		req.onerror = () => rej(req.error);
	}), rec);
}

const openChatByName = (page, name) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, name);

// A tile's own `.ctile-time` reading, for the tile whose BODY carries `needle`
// -- content is the stable key, not DOM position: a message with no `ts`
// sorts to wherever `stampMessages`/`mergeMessages` puts a normalised `ts: 0`,
// which is not necessarily where it was written in the fixture array (see the
// note on the fixture above). Answers the full-form text (what a wide header
// shows), the short-form text (the narrow-phone fallback) and the hover
// title -- or `time: null` on a tile that carries no time element at all.
const tileTimeByText = (page, needle) => page.evaluate((n) => {
	const tiles = [...document.querySelectorAll('#chat-output .ctile')];
	const el = tiles.find((t) => (t.querySelector('.ctile-body') || {}).textContent.includes(n));
	if (!el) return { found: false };
	const tm = el.querySelector('.ctile-time');
	if (!tm) return { found: true, type: el.dataset.t, time: null };
	const full  = tm.querySelector('.ctile-time-full');
	const short = tm.querySelector('.ctile-time-short');
	return {
		found: true, type: el.dataset.t,
		time: {
			full:  full  ? full.textContent  : '',
			short: short ? short.textContent : '',
			title: tm.title || '',
		},
	};
}, needle);

// The LAST tile of a given type currently in the transcript -- used only for
// the LIVE session, whose messages are never touched by the ts-normalising
// merge above (every one of them is freshly stamped with a real `Date.now()`
// as it is sent).
const lastTileTime = (page, type) => page.evaluate((ty) => {
	const tiles = [...document.querySelectorAll(`#chat-output .ctile[data-t="${ty}"]`)];
	const el = tiles[tiles.length - 1];
	if (!el) return { found: false };
	const tm = el.querySelector('.ctile-time');
	if (!tm) return { found: true, time: null };
	const full = tm.querySelector('.ctile-time-full');
	return { found: true, time: { full: full ? full.textContent : '' } };
}, type);

let a, b, live;
try {
	const PA = scratch('pw', 'tiledatetime-a' + (BREAK ? '-' + BREAK : ''));
	const PB = scratch('pw', 'tiledatetime-b' + (BREAK ? '-' + BREAK : ''));
	const PL = scratch('pw', 'tiledatetime-live' + (BREAK ? '-' + BREAK : ''));
	fs.rmSync(PA, { recursive: true, force: true });
	fs.rmSync(PB, { recursive: true, force: true });
	fs.rmSync(PL, { recursive: true, force: true });

	// ── Two sessions, two zones, the SAME fixture ──────────────────────
	// India (+5:30, no DST) and Los Angeles (-7 in September, DST): the fixed
	// instant above crosses midnight in the first and not the second, so a
	// build that fell back to UTC — or dropped the zone offset entirely —
	// reads the SAME date+hour in both, which is exactly what check B catches.
	const ZONE_A = 'Asia/Kolkata';
	const ZONE_B = 'America/Los_Angeles';

	a = await open({ name: 'tiledtA', profile: PA, defaults: true, connect: true,
		timezoneId: ZONE_A, route: FILES.size ? serveBroken : null });
	await seed(a.page, fixtureChat());
	await a.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(a, 'tiledtA');
	await a.page.waitForTimeout(600);
	check('A opens the fixture chat', await openChatByName(a.page, 'Tile datetime fixture'));
	await a.page.waitForTimeout(500);

	b = await open({ name: 'tiledtB', profile: PB, defaults: true, connect: true,
		timezoneId: ZONE_B, route: FILES.size ? serveBroken : null });
	await seed(b.page, fixtureChat());
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'tiledtB');
	await b.page.waitForTimeout(600);
	check('B opens the same fixture chat under a different zone',
		await openChatByName(b.page, 'Tile datetime fixture'));
	await b.page.waitForTimeout(500);

	// ── (A) Headers show the string — user, assistant, tool ────────────
	const FMT_RE = /^\d{4,}-\d\d-\d\d \d\d:\d\d$/;
	const userT = await tileTimeByText(a.page, 'MARK_USER');
	const asstT = await tileTimeByText(a.page, 'MARK_ASST');
	const toolT = await tileTimeByText(a.page, 'MARK_TOOL');
	check('(A) the user tile header carries a time', !!(userT.time && FMT_RE.test(userT.time.full)),
		JSON.stringify(userT));
	check('(A) the assistant tile header carries a time', !!(asstT.time && FMT_RE.test(asstT.time.full)),
		JSON.stringify(asstT));
	check('(A) the tool tile header carries a time', !!(toolT.time && FMT_RE.test(toolT.time.full)),
		JSON.stringify(toolT));

	// ── (B) The year is Gregorian+10000, and the LOCAL zone is respected ──
	const wantA = expectHolocene(FIXED_TS, ZONE_A);
	const wantB = expectHolocene(FIXED_TS, ZONE_B);
	check('(B) session A (Asia/Kolkata) reads the instant in ITS OWN zone',
		userT.time && userT.time.full === wantA, `got ${userT.time && userT.time.full}, want ${wantA}`);
	const userTb = await tileTimeByText(b.page, 'MARK_USER');
	check('(B) session B (America/Los_Angeles) reads the SAME instant differently',
		userTb.time && userTb.time.full === wantB, `got ${userTb.time && userTb.time.full}, want ${wantB}`);
	check('(B) the two zones actually disagree, so this is testing something',
		wantA !== wantB, `A=${wantA} B=${wantB}`);
	const yearA = Number(wantA.slice(0, 5));
	check('(B) the year is the Gregorian year plus ten thousand',
		yearA === (new Date(FIXED_TS).getUTCFullYear() + 10000) || yearA === (new Date(FIXED_TS).getUTCFullYear() + 1 + 10000),
		'holocene year ' + yearA);

	// ── (C) No seconds, ever ────────────────────────────────────────────
	check('(C) the tile string carries no seconds field',
		!!(userT.time && /^\d{4,}-\d\d-\d\d \d\d:\d\d$/.test(userT.time.full)
			&& !/:\d\d:\d\d$/.test(userT.time.full)),
		userT.time && userT.time.full);
	check('(C) the hover title DOES carry seconds and a zone (the one place a full instant belongs)',
		!!(userT.time && /^\d{4,}-\d\d-\d\dT\d\d:\d\d:\d\d([Z]|[+-]\d\d:\d\d)$/.test(userT.time.title)),
		userT.time && userT.time.title);

	// ── (D) A tile with no timestamp shows nothing ──────────────────────
	const legacyT = await tileTimeByText(a.page, 'MARK_NOTS');
	check('(D) the legacy message (no `ts` field) draws NO time element at all',
		legacyT.found && legacyT.time === null, JSON.stringify(legacyT));

	// ── (E) The live path: a real turn, drawn as it streams, shows a time too ──
	live = await open({ name: 'tiledtLive', profile: PL, defaults: true, connect: true,
		route: FILES.size ? serveBroken : null });
	await newChat(live);
	const dir = await live.page.evaluate(() => {
		const f = window.DaimondAttach && window.DaimondAttach.focus();
		return f ? window.DaimondAttach.chatScratch(f.id) : '';
	});
	const beforeLive = Date.now();
	await chat(live, `@tool file_write {"path":"${dir}/tiledt.txt","content":"hi"}`);
	await live.page.waitForTimeout(500);
	const afterLive = Date.now();
	const liveUser  = await lastTileTime(live.page, 'user');
	const liveAsst  = await lastTileTime(live.page, 'reply');
	const liveTool  = await lastTileTime(live.page, 'tool');
	const inWindow = (full) => {
		if (!full || !FMT_RE.test(full)) return false;
		// Rebuild the epoch this minute string names in THIS process's own zone
		// (the live session was opened with no timezoneId override, so it kept
		// the host's) and check it falls inside the turn's own wall-clock window.
		const mm = full.match(/^(\d+)-(\d\d)-(\d\d) (\d\d):(\d\d)$/);
		if (!mm) return false;
		const t = new Date(Number(mm[1]) - 10000, Number(mm[2]) - 1, Number(mm[3]), Number(mm[4]), Number(mm[5])).getTime();
		return t >= beforeLive - 60000 && t <= afterLive + 60000;
	};
	check('(E) a LIVE user tile (drawn as it happened, not on reload) carries a time',
		liveUser.time && inWindow(liveUser.time.full), JSON.stringify(liveUser));
	check('(E) a LIVE assistant tile carries a time',
		liveAsst.time && inWindow(liveAsst.time.full), JSON.stringify(liveAsst));
	check('(E) a LIVE tool tile carries a time',
		liveTool.time && inWindow(liveTool.time.full), JSON.stringify(liveTool));

	// ── (F) The phone header: does the full string fit at 390px? ───────
	await a.page.setViewportSize({ width: 390, height: 844 });
	await a.page.waitForTimeout(400);
	const fit = await a.page.evaluate(() => {
		const out = [];
		for (const tile of document.querySelectorAll('#chat-output .ctile')) {
			const lbl = tile.querySelector(':scope > .ctile-lbl');
			const tm  = tile.querySelector('.ctile-time');
			if (!lbl || !tm) continue;
			const lr = lbl.getBoundingClientRect(), tr = tm.getBoundingClientRect();
			const ctl = tile.querySelector('.ctile-ctl');
			const cr  = ctl ? ctl.getBoundingClientRect() : null;
			out.push({
				type: tile.dataset.t,
				overflowsRight: tr.right > lr.right + 0.5,
				overlapsControls: !!(cr && tr.right > cr.left + 0.5),
				visibleText: getComputedStyle(tm.querySelector('.ctile-time-full')).display !== 'none'
					? 'full' : 'short',
			});
		}
		return { rows: out, bodyScrolls: document.documentElement.scrollWidth > window.innerWidth + 1 };
	});
	check('(F) the page never scrolls horizontally at 390px', !fit.bodyScrolls, JSON.stringify(fit));
	const clipped = fit.rows.filter((r) => r.overflowsRight || r.overlapsControls);
	check('(F) no tile header\u2019s time clips or overlaps the copy/checkbox controls at 390px',
		clipped.length === 0, JSON.stringify(fit.rows));

} catch (e) {
	console.error('the run threw: ' + (e && (e.stack || e.message) || e));
	bad.push('the run threw');
} finally {
	try { await a?.close?.(); } catch {}
	try { await b?.close?.(); } catch {}
	try { await live?.close?.(); } catch {}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed' + (BREAK ? '  (break: ' + BREAK + ')' : ''));
if (bad.length) for (const n of bad) console.log('  FAILED: ' + n);
process.exit(bad.length ? 1 : 0);
