// verify_chatlife.mjs — what a chat is called, and how it leaves.
//
// The record half of this feature — the merge, the two clocks, the operator
// setting — is proved without a browser by dev/verify_chatexpiry.mjs, which is
// where the convergence claims live. This file is the other half: what the
// person actually sees, in the running app.
//
//   1. A NEW CHAT CARRIES NO NUMBER. `Chat-0025` is gone from the rail and from
//      the record. It was wrong twice: the counter was per DEVICE while the
//      chats it named were shared, so the numbers implied a chronology they did
//      not have; and an accession number is what a museum gives a thing it is
//      keeping, which a chat is not.
//
//   2. THE RAIL IS GROUPED BY DAY and each tile says when, relatively. The
//      fixture puts chats in three different days on purpose, so a check cannot
//      pass by finding one heading and stopping.
//
//   3. THE FIRST MESSAGE SHOWS, DIMMED, AND CAN BE TURNED OFF. Both halves:
//      the rail persists across every chat, so somebody who does not want their
//      own sentence on screen all day has to be able to say so, and the switch
//      has to actually take it away.
//
//   4. KEEP AS A DIAMOND makes a Diamond and CARRIES THE TRANSCRIPT IN. Not
//      "a Diamond appeared" — the conversation has to be inside it, as a file
//      and as a link, or the act has quietly lost the thing it was for.
//
//   5. A CHAT PAST ITS WINDOW IS TRASHED BY THE APP ITSELF, and one inside its
//      window is not. Driven through `DaimondExpiryTick`, the same function the
//      hourly clock calls, so what is exercised is the shipped path and not a
//      re-implementation of it in this file.
//
//   6. A CHAT WITH A LIVE RUN UNDER IT DOES NOT EXPIRE, however stale. A
//      dispatched worker's scratch belongs to the run, and "the chat expired"
//      must never be why somebody's work was lost.
//
//   7. THE BOOT SWEEP WAITS TO HEAR FROM THE OTHER DEVICES BEFORE DESTROYING
//      ANYTHING. This is the one that loses data if it is wrong, and it was
//      wrong until this release: retention destroys for good and lays a
//      tombstone, so a device sweeping on stale records can defeat a restore
//      made a month earlier on another device.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// damaged js/daimond.js to the real page through `page.route`; the run is then
// expected to FAIL. A break whose anchor does not appear exactly once aborts,
// so a break that has rotted cannot report a quiet pass.
//
//   node dev/verify_chatlife.mjs --break numbered    # 1: chats are named Chat-NNNN again
//   node dev/verify_chatlife.mjs --break noday       # 2: no day headings
//   node dev/verify_chatlife.mjs --break nowhen      # 2: tiles say nothing about when
//   node dev/verify_chatlife.mjs --break alwayspeek  # 3: the setting does not suppress it
//   node dev/verify_chatlife.mjs --break emptykeep   # 4: the Diamond is made without the transcript
//   node dev/verify_chatlife.mjs --break noexpiry    # 5: nothing ever expires
//   node dev/verify_chatlife.mjs --break expireall   # 5: everything expires, window or not
//   node dev/verify_chatlife.mjs --break takeslive   # 6: a chat with a live run expires anyway
//   node dev/verify_chatlife.mjs --break halflive    # 6: a queued run holds a chat, a RUNNING one does not
//   node dev/verify_chatlife.mjs --break sweepnow    # 7: the boot sweep destroys before it has heard
//   node dev/verify_chatlife.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/verify_chatlife.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'chatlife' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const DAY = 24 * 3600 * 1000;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The accession number comes back. This is the shape the app shipped with.
	numbered: [{
		file: 'js/daimond.js',
		find: "\t\t\tname: '',",
		with: "\t\t\tname: 'Chat-' + ('000' + ((storedChats().length || 0) + 1)).slice(-4),",
	}],
	// No day headings: the rail is one undifferentiated column again.
	noday: [{
		file: 'js/daimond.js',
		find: "\t\t\t\tsessionList.appendChild(h);",
		with: '',
	}],
	// The tile says nothing about when it was touched, so with no name and no
	// number there is nothing on it at all.
	nowhen: [{
		file: 'js/daimond.js',
		find: "\t\twhen.textContent = s.name || tileWhen(stamp);",
		with: "\t\twhen.textContent = s.name || '';",
	}],
	// The preview is drawn whatever the setting says — a switch that does not
	// switch, which is worse than no switch, because it is a promise.
	alwayspeek: [{
		file: 'js/daimond.js',
		find: "\t\tif (cfg.chatPreview !== false) {",
		with: '\t\tif (true) {',
	}],
	// The Diamond is created and the transcript never written into it. The act
	// looks like it worked: a Diamond appears on the rail with the right name.
	emptykeep: [{
		file: 'js/daimond.js',
		find: "\t\t\tawait Files.writeBytes(transcriptPath(id),\n"
			+ "\t\t\t\tnew TextEncoder().encode(transcriptDoc(chat, name)));\n"
			+ "\t\t\twrote = true;",
		with: '\t\t\twrote = true;',
	}],
	// Nothing ever expires.
	noexpiry: [{
		file: 'js/daimond.js',
		find: "\t\t\t\tif (now >= due && DaimondTrash.expire(c.id, 'chat', due)) moved++;",
		with: '',
	}],
	// Everything expires, whether its window has passed or not — the failure
	// that would take a chat somebody used an hour ago.
	expireall: [{
		file: 'js/daimond.js',
		find: "\t\t\t\tif (now >= due && DaimondTrash.expire(c.id, 'chat', due)) moved++;",
		with: "\t\t\t\tif (DaimondTrash.expire(c.id, 'chat', due)) moved++;",
	}],
	// The boot sweep runs without waiting to hear from the other devices —
	// which is what the app did before this release, and which destroys, for
	// good and with a tombstone, on records that may already have been restored
	// somewhere else.
	// The boot sweep stops waiting: the gate is still there in shape, but it
	// releases at once instead of on the first pull.
	//
	// The wait is shortened rather than the block deleted. Deleting it made the
	// boot destroy things before the surfaces they touch were built, and the
	// harness died on a missing function instead of failing a check — which is
	// the trap verify_chattiles names: a break that crashes the run proves no
	// more than a break that does nothing.
	sweepnow: [{
		file: 'js/daimond.js',
		find: '\tvar SWEEP_WAIT_MS = 20000;',
		with: '\tvar SWEEP_WAIT_MS = 0;',
	}],
	// A chat expires even with work still running under it.
	takeslive: [{
		file: 'js/daimond.js',
		find: "\t\tif (chatHasLiveWork(c.id)) return 0;",
		with: '',
	}],
	// The guard is still called, and still counts SOMETHING, but it has lost the
	// state the rule is mostly about: a worker actually running no longer holds
	// its chat, though one still waiting to start does. The half-right predicate
	// is the failure this check exists to catch — it looks alive from every
	// surface, and takes the scratch out from under a worker mid-answer.
	halflive: [{
		file: 'js/daimond.js',
		find: "\t\t\t\t\t&& (r.status === 'running' || r.status === 'queued');",
		with: "\t\t\t\t\t&& r.status === 'queued';",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The damaged files, ONE BODY PER FILE.
///
/// Every edit a break names for a file goes into the SAME body, in order, and
/// that one body is what the route serves. A `page.route` per edit spec does not
/// work and does not say so: Playwright hands a request to the LAST route
/// registered for its URL, so a two-edit break shipped only its second edit --
/// and still went red, for half the reason it claims, with nothing to notice it.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

// ── The fixture ──────────────────────────────────────────────────────
//
// Three chats in three different calendar days, each with a distinctive opening
// sentence so the preview check reads a real line rather than "some text
// appeared".
//
// ANCHORED TO THE START OF THE DAY, NOT TO ELAPSED HOURS, and that distinction
// is the whole of why this function exists. The first draft placed them "two
// hours ago" and "twenty-six hours ago", which is Today and Yesterday for most
// of the day and neither of those after midnight — so the verifier passed all
// evening and failed at 00:43, reporting three faults in correct code. A day
// heading is a claim about the reader's calendar, so the fixture has to be
// built out of calendar arithmetic.
//
// `startOfDay` is computed IN THE PAGE, in the browser's own zone, for the same
// reason: this script and the browser can disagree about the offset.
function seedRecords(anchors) {
	const mk = (id, at, opening) => ({
		id,
		name: '',
		messages: [{ role: 'user', content: opening, mid: id + '-m1', ts: at }],
		model: 'mock/fast', provider: 'mock', status: 'active',
		promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
		prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
		updatedAt: at,
	});
	return [
		mk('c-today', anchors.today, 'the pump seal on the boat'),
		mk('c-yest',  anchors.yest,  'a letter to the council about the verge'),
		mk('c-old',   anchors.old,   'quotes for the retaining wall'),
	];
}

async function seedChats(page, records) {
	await page.evaluate((recs) => new Promise((resolve, reject) => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
		};
		req.onsuccess = () => {
			const db = req.result;
			const t = db.transaction('chats', 'readwrite');
			const store = t.objectStore('chats');
			recs.forEach((r) => store.put(r));
			t.oncomplete = () => resolve();
			t.onerror = () => reject(t.error);
		};
		req.onerror = () => reject(req.error);
	}), records);
}

/// What the rail actually reads, top to bottom: headings and tiles in the one
/// list, so the GROUPING is visible to the check and not merely the membership.
const railRows = (page) => page.evaluate(() => {
	const out = [];
	const list = document.getElementById('session-list');
	if (!list) return out;
	for (const el of list.children) {
		if (el.classList.contains('rail-day')) { out.push({ kind: 'day', text: el.textContent.trim() }); continue; }
		if (!el.classList.contains('session-box')) continue;
		const when = el.querySelector('.tile-when');
		const prev = el.querySelector('.tile-preview');
		out.push({
			kind: 'tile',
			id:   el.dataset.id || '',
			when: when ? when.textContent.trim() : '',
			preview: prev ? prev.textContent.trim() : null,
		});
	}
	return out;
});

const s = await open({ name: 'chatlife', profile: PROFILE, connect: false, defaults: false });
const { page } = s;

if (BREAK) {
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'chatlife');
}

try {
	// The three anchors, computed in the page's own zone. Each is stated as an
	// offset from the START of a day, so every one lands in the calendar day it
	// is named after whatever the hour of the run.
	const anchors = await page.evaluate(() => {
		const now = Date.now();
		const d = new Date(now);
		const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		const HOUR = 3600 * 1000, DAY = 24 * HOUR;
		return {
			now,
			startOfToday,
			// Today: halfway through however much of today has elapsed, so it is
			// always today and always at least a moment old.
			today: startOfToday + Math.floor((now - startOfToday) / 2),
			// Yesterday, mid-afternoon.
			yest:  startOfToday - DAY + 14 * HOUR,
			// Four calendar days back, which is past a three-day window whatever
			// the time of day the run starts.
			old:   startOfToday - 4 * DAY + 14 * HOUR,
		};
	});
	await seedChats(page, seedRecords(anchors));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'chatlife');
	await page.waitForTimeout(1200);

	// ── 0. The gate ────────────────────────────────────────────────
	let rows = await railRows(page);
	let tiles = rows.filter((r) => r.kind === 'tile');
	check('all three seeded chats reached the rail', tiles.length === 3,
		`${tiles.length}: ${tiles.map((t) => t.id).join(', ')}`);
	if (tiles.length !== 3) {
		console.log('\nnothing to test against — refusing to report a vacuous pass.');
		await s.close();
		process.exit(1);
	}
	await shot(s, 'chatlife-rail' + (BREAK ? '-' + BREAK : ''));

	// ── 1. No number, on a chat the APP makes ─────────────────────
	//
	// Pressed through the real "+ New chat" control rather than seeded, because
	// the number came from `newChat` and seeding one would prove nothing about
	// the code that used to mint it.
	const madeOne = await page.evaluate(() => {
		const b = document.getElementById('new-session-btn');
		if (!b) return false;
		b.click();
		return true;
	});
	check('the "new chat" control is reachable', madeOne === true);
	await page.waitForTimeout(500);

	const fresh = await page.evaluate(() => new Promise((res) => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onsuccess = () => {
			const all = req.result.transaction('chats', 'readonly').objectStore('chats').getAll();
			all.onsuccess = () => {
				const seeded = ['c-today', 'c-yest', 'c-old'];
				res((all.result || []).filter((c) => seeded.indexOf(c.id) === -1)
					.map((c) => ({ id: c.id, name: c.name })));
			};
			all.onerror = () => res([]);
		};
		req.onerror = () => res([]);
	}));
	check('pressing "new chat" made exactly one chat', fresh.length === 1,
		JSON.stringify(fresh));
	check('and its stored name is EMPTY, not Chat-NNNN',
		fresh.length === 1 && fresh[0].name === '',
		fresh.length ? `name was "${fresh[0].name}"` : 'no chat to read');

	// And nothing anywhere in the rail wears the old shape. Asserted on the
	// rendered text, because the record being clean would not help if the tile
	// invented a number of its own.
	const railText = await page.evaluate(() => (document.getElementById('session-list') || {}).textContent || '');
	check('no tile in the rail reads "Chat-NNNN"', !/Chat-\d{3,}/.test(railText),
		(railText.match(/Chat-\d{3,}/g) || []).join(', '));

	// ── 2. Grouped by day, and each tile says when ────────────────
	rows = await railRows(page);
	const days = rows.filter((r) => r.kind === 'day').map((r) => r.text);
	check('the rail carries day headings', days.length >= 2, days.join(' | '));
	check('and the first is Today, where the newest chat is',
		days[0] === 'Today', days.join(' | '));
	check('and there are three distinct groups for three distinct days',
		new Set(days).size === 3, days.join(' | '));
	check('the headings are in newest-first order, matching the sort',
		JSON.stringify(days) === JSON.stringify(['Today', 'Yesterday', 'Earlier']),
		days.join(' | '));

	// Each seeded tile sits under the right heading. Read by walking the rows,
	// so what is asserted is MEMBERSHIP of a group and not merely that both
	// exist somewhere on the rail.
	const groupOf = {};
	let cur = '';
	for (const r of rows) {
		if (r.kind === 'day') { cur = r.text; continue; }
		groupOf[r.id] = cur;
	}
	check('the two-hour-old chat is under Today',    groupOf['c-today'] === 'Today',    groupOf['c-today']);
	check('the day-old chat is under Yesterday',     groupOf['c-yest'] === 'Yesterday', groupOf['c-yest']);
	check('the four-day-old chat is under Earlier',  groupOf['c-old'] === 'Earlier',    groupOf['c-old']);

	// The tile's own line. Every tile must say SOMETHING — with no name and no
	// number, a tile whose time was blank would be a row with nothing on it.
	const byId = Object.fromEntries(rows.filter((r) => r.kind === 'tile').map((r) => [r.id, r]));
	check('no tile is left with nothing to identify it',
		Object.values(byId).every((r) => r.when.length > 0),
		JSON.stringify(Object.values(byId).map((r) => r.when)));

	// THE EXACT WORDING IS TESTED AS THE PURE FUNCTION IT IS, at a fixed
	// instant, rather than through the DOM at whatever o'clock the suite runs.
	// `tileWhen` and `dayBucket` both take `now` for this reason. Doing it
	// through the rendered tile instead is what made this file report three
	// faults in correct code at 00:43, when "two hours ago" is really yesterday.
	const phrasing = await page.evaluate(() => {
		const HOUR = 3600 * 1000, DAY = 24 * HOUR;
		// Noon on a Wednesday, chosen so every offset below stays inside its own
		// calendar day and none of the answers depends on the hour of the run.
		const NOON = new Date(2026, 5, 10, 12, 0, 0).getTime();
		const w = (ms) => window.DaimondCore.railWhen(ms, NOON);
		const d = (ms) => window.DaimondCore.railDay(ms, NOON);
		return {
			justNow:  w(NOON - 20 * 1000),
			twelveMin: w(NOON - 12 * 60 * 1000),
			twoHr:    w(NOON - 2 * HOUR),
			// 23:00 the previous night: eleven hours before this instant, and
			// firmly YESTERDAY. An implementation counting elapsed hours would
			// call it today.
			lastNight: { day: d(NOON - 13 * HOUR), text: w(NOON - 13 * HOUR) },
			// 00:30 THIS MORNING: eleven and a half hours ago and still today.
			// The mirror of the case above, so a rule that simply moved the
			// boundary cannot satisfy both.
			smallHours: { day: d(NOON - 11.5 * HOUR), text: w(NOON - 11.5 * HOUR) },
			fourDays: { day: d(NOON - 4 * DAY), text: w(NOON - 4 * DAY) },
		};
	});
	check('under a minute reads as "just now"', phrasing.justNow === 'just now', phrasing.justNow);
	check('twelve minutes reads as minutes ago', phrasing.twelveMin === '12 min ago', phrasing.twelveMin);
	check('two hours reads as hours ago', phrasing.twoHr === '2 hr ago', phrasing.twoHr);
	check('eleven pm last night is YESTERDAY, not "13 hr ago"',
		phrasing.lastNight.day === 'yesterday' && !/ago/.test(phrasing.lastNight.text),
		JSON.stringify(phrasing.lastNight));
	check('half past midnight this morning is still TODAY, though it is further back in hours',
		phrasing.smallHours.day === 'today' && /ago/.test(phrasing.smallHours.text),
		JSON.stringify(phrasing.smallHours));
	check('four days back is Earlier, and says a date rather than a time',
		phrasing.fourDays.day === 'earlier' && !/ago/.test(phrasing.fourDays.text),
		JSON.stringify(phrasing.fourDays));

	// ── 3. The preview, and the switch that takes it away ─────────
	check('the tile shows the first thing said in the chat',
		byId['c-today'].preview === 'the pump seal on the boat',
		JSON.stringify(byId['c-today'].preview));
	check('each tile shows its OWN opening, not the newest chat\'s',
		byId['c-old'].preview === 'quotes for the retaining wall',
		JSON.stringify(byId['c-old'].preview));

	// Turned off through the menu item the user would actually press.
	const toggled = await page.evaluate(() => {
		const btn = document.getElementById('chats-menu-btn');
		if (!btn) return 'no menu button';
		btn.click();
		const item = [...document.querySelectorAll('.railhead-menu-item')]
			.find((b) => b.getAttribute('role') === 'menuitemcheckbox');
		if (!item) return 'no checkable item';
		const was = item.getAttribute('aria-checked');
		item.click();
		return was;
	});
	check('the preview switch is in the Chats menu and reads as ON',
		toggled === 'true', String(toggled));
	await page.waitForTimeout(400);
	rows = await railRows(page);
	check('turning it off takes the first message off every tile',
		rows.filter((r) => r.kind === 'tile').every((r) => r.preview === null),
		JSON.stringify(rows.filter((r) => r.kind === 'tile').map((r) => r.preview)));
	check('and the tiles still say when, so the rail is not left blank',
		rows.filter((r) => r.kind === 'tile').every((r) => r.when.length > 0));
	await shot(s, 'chatlife-nopreview' + (BREAK ? '-' + BREAK : ''));

	// Back on, so the rest of the run sees the shipped state.
	await page.evaluate(() => {
		document.getElementById('chats-menu-btn').click();
		const item = [...document.querySelectorAll('.railhead-menu-item')]
			.find((b) => b.getAttribute('role') === 'menuitemcheckbox');
		if (item) item.click();
	});
	await page.waitForTimeout(300);

	// ── 4. Keep as a Diamond carries the transcript ───────────────
	//
	// Driven through `DaimondCore.keepAsDiamond`, which is what the tile's
	// button and the Trash panel's row both call — one path, exercised once.
	// The name dialog is answered by driving the real dialog, so a change that
	// broke the prompt would be caught here rather than bypassed.
	const KEEPNAME = 'The retaining wall';
	const kept = await page.evaluate((name) => {
		const p = window.DaimondCore.keepAsDiamond('c-old');
		// The prompt is a real modal; fill it and press its OK.
		return new Promise((res) => {
			const t0 = Date.now();
			(function tick() {
				const card = [...document.querySelectorAll('.modal.dlg .dlg-card')]
					.find((c) => c.getClientRects().length);
				const input = card && card.querySelector('input');
				if (input) {
					input.value = name;
					input.dispatchEvent(new Event('input', { bubbles: true }));
					const okBtn = card.querySelector('.dlg-ok');
					if (okBtn) { okBtn.click(); p.then(res, () => res('')); return; }
				}
				if (Date.now() - t0 > 8000) { res('timeout: no name dialog'); return; }
				setTimeout(tick, 60);
			})();
		});
	}, KEEPNAME);
	check('Keep as a Diamond asked for a name and made one',
		typeof kept === 'string' && kept.length > 0 && !kept.startsWith('timeout'),
		String(kept));
	await page.waitForTimeout(900);

	const made = await page.evaluate(async (id) => {
		const app = window.DaimondCore.diamondApp();
		const list = JSON.parse(await app.list_diamonds());
		const d = list.find((x) => x.id === id) || null;
		let links = [];
		try { links = JSON.parse(await app.links_touching('diamond:' + id) || '[]'); }
		catch (e) { links = []; }
		// Read through the WASM file reader, not `run_tool('file_read')`, which is
		// the model-facing rendering: it numbers every line and wraps the path in
		// an envelope, so a check on the transcript's text would be asserting
		// against the envelope. Same trap mail.js records at its `readText`.
		let body = '';
		try { body = await window.DaimondCore.readFile('diamonds/' + id + '/transcript.md'); }
		catch (e) { body = ''; }
		return { name: d ? d.name : null, links: links.map((l) => ({ to: l.other || l.to, rel: l.rel })), body };
	}, kept);

	check('the Diamond exists and wears the name that was typed',
		made.name === KEEPNAME, JSON.stringify(made.name));
	check('the transcript was written into the Diamond\'s own directory',
		made.body.length > 0, `${made.body.length} bytes`);
	check('and it carries what was actually said in the chat, not a summary',
		made.body.indexOf('quotes for the retaining wall') !== -1,
		JSON.stringify(made.body.slice(0, 120)));
	check('the transcript is linked as an artefact the Diamond HOLDS',
		made.links.some((l) => /transcript\.md/.test(String(l.to)) && l.rel === 'holds'),
		JSON.stringify(made.links));

	// ── 5. Expiry, at the boundary, through the shipped tick ──────
	//
	// The window is set to three days and the fixture has a four-day-old chat
	// and a two-hour-old one, so one must go and the other must stay. A check
	// that only asserted the first would pass against code that trashed the lot.
	const before = await page.evaluate(() => ({
		old:   DaimondTrash.has('c-old'),
		today: DaimondTrash.has('c-today'),
	}));
	check('neither chat is in the trash before the tick', !before.old && !before.today,
		JSON.stringify(before));

	// The tick is published by `startExpiryClock`, which runs as one step of the
	// boot. Waited for rather than assumed: the sections above open a Diamond
	// and redraw, so how far the boot has got by the time the run reaches here
	// varies — and a bare call turns "the app was still starting" into a harness
	// crash, which reports nothing about the property under test.
	const tickReady = await page.waitForFunction(
		() => typeof window.DaimondExpiryTick === 'function', null, { timeout: 15000 },
	).then(() => true, () => false);
	check('the expiry clock published its tick', tickReady === true,
		'the app never finished booting, so nothing below could be measured');
	await page.evaluate(async () => {
		DaimondPolicy.set(3, 30);
		await window.DaimondExpiryTick();
	});
	await page.waitForTimeout(600);

	const after = await page.evaluate(() => ({
		old:    DaimondTrash.has('c-old'),
		yest:   DaimondTrash.has('c-yest'),
		today:  DaimondTrash.has('c-today'),
		oldAuto: DaimondTrash.isAuto('c-old'),
	}));
	check('the four-day-old chat, past a three-day window, is in the trash',
		after.old === true);
	check('the two-hour-old chat is NOT', after.today === false);
	check('nor is the day-old one, which is also inside the window',
		after.yest === false);
	check('and the trashed one is marked as the clock\'s doing, not a person\'s',
		after.oldAuto === true);

	// It has left the rail, which is the visible half of the same fact.
	rows = await railRows(page);
	check('the expired chat is off the rail', !rows.some((r) => r.id === 'c-old'),
		rows.filter((r) => r.kind === 'tile').map((r) => r.id).join(', '));

	// AND IT IS STILL PROMOTABLE. The Trash panel offers Keep beside Restore,
	// because the trash is where somebody meets a chat they had forgotten.
	const trashRow = await page.evaluate(async () => {
		const items = await window.DaimondCore.trashList();
		const it = items.find((x) => x.id === 'c-old');
		return it ? { found: true, kind: it.kind, auto: !!it.auto } : { found: false };
	});
	check('the expired chat is listed in the trash, as a chat, marked automatic',
		trashRow.found && trashRow.kind === 'chat' && trashRow.auto === true,
		JSON.stringify(trashRow));
	await shot(s, 'chatlife-expired' + (BREAK ? '-' + BREAK : ''));

	// ── 6. A live run keeps its chat, however stale ───────────────
	//
	// A dispatched worker's scratch belongs to the RUN, not to the chat, so the
	// chat has to outlive an untouched window while any of its workers is short
	// of a terminal state. Different in kind from the turn-in-flight exemptions:
	// a turn is over in seconds, a fan-out outlives the turn that started it,
	// and a chat can be genuinely untouched for days with work underneath it.
	//
	// `c-yest` is aged past the window and a worker is dispatched under it, so the
	// ONLY thing standing between it and the trash is this rule.
	const guarded = await page.evaluate(async () => {
		const rec = await new Promise((res) => {
			const req = indexedDB.open('daimond-chats', 1);
			req.onsuccess = () => {
				const st = req.result.transaction('chats', 'readwrite').objectStore('chats');
				const g = st.get('c-yest');
				g.onsuccess = () => {
					const c = g.result;
					if (!c) { res(null); return; }
					// TEN days: comfortably past the three-day window, and comfortably
					// INSIDE the three-plus-thirty at which a chat is expired and
					// destroyed in the same pass. Forty days did both at once — the
					// chat expired, its thirty-day retention had also elapsed, and
					// the sweep destroyed it on the spot — which is correct
					// behaviour and made this check read as a failure of the
					// worker rule it is actually about.
					c.updatedAt = Date.now() - 10 * 24 * 3600 * 1000;
					st.put(c);
					res(c.id);
				};
				g.onerror = () => res(null);
			};
			req.onerror = () => res(null);
		});
		return rec;
	});
	check('the chat to guard was aged well past the window', guarded === 'c-yest', String(guarded));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'chatlife');
	await page.waitForTimeout(1200);

	// Work is running. THE RUN IS A REAL ONE, dispatched through the call a
	// chat's turn makes — `Workers.dispatch` with no Diamond and the chat as
	// owner, exactly as `runTurn` does when the conductor asks for agents. It is
	// the chat id travelling on the run record that the predicate matches on, so
	// a stand-in that only set a global counter would prove nothing about it: an
	// earlier draft of this check did that, and went on passing after the
	// per-chat predicate replaced the counter it was setting.
	//
	// The pump is held first, so the fan-out is real without being paid for: a
	// held pump leaves the run `queued`, which is live by the same rule that
	// makes `running` live — the work is still going to happen — and no model is
	// called. Nothing here needs a provider, which is what lets this test go on
	// running with `connect: false`.
	const live = await page.evaluate(async () => {
		DaimondPolicy.set(3, 30);
		// Look at a DIFFERENT chat first. `chats` is rebuilt from IndexedDB in
		// id order, not in the rail's order, so the chat the boot happens to
		// open is not the top tile — and a chat on screen is exempt by design.
		// Without this the check would be measuring that exemption instead of
		// the worker one, and would read as a failure of the rule under test.
		const other = document.querySelector('.session-box[data-id="c-today"]');
		if (other) other.click();
		await new Promise((r) => setTimeout(r, 400));
		const W = window.DaimondCore.workers();
		if (!W) return 'no workers module';
		W.pauseAll();								// nothing spends while this runs
		W.dispatch('', '', [{ name: 'guard', task: 'hold the chat open' }], false,
			{ provider: 'mock', model: 'mock/fast' }, 0,
			{ chatId: 'c-yest', chatName: '' });
		const run = W.runs.find((r) => r.chatId === 'c-yest');
		// PROVE THE INSTRUMENT, twice, before anything is concluded from it. A
		// run this file cannot see, or one the predicate does not count, would
		// make every reading below vacuous — and `chatDueAt` is published for
		// exactly this: it says the chat is EXEMPT rather than leaving the
		// exemption to be inferred from a chat that happened not to move.
		const queuedLive = !!run && run.status === 'queued'
			&& W.liveFor('c-yest') === true
			&& window.DaimondCore.chatDueAt('c-yest') === 0;
		// And the state the headline case is about. `running` is what `start`
		// stamps the moment the pump releases; asserted separately because a
		// predicate that counted one of the two states and not the other would
		// sweep a chat out from under a worker mid-answer and still read green.
		if (run) run.status = 'running';
		const runningLive = !!run && W.liveFor('c-yest') === true
			&& window.DaimondCore.chatDueAt('c-yest') === 0;
		await window.DaimondExpiryTick();
		const held = !DaimondTrash.has('c-yest');
		// And it ends. Through the kill switch on the run rather than by editing
		// the record: `stopped` is terminal by the app's own reckoning, the same
		// as `done` and `error`. A queued run stopped this way never reaches
		// `start`, so no batch gathers and nothing writes a report back into the
		// chat — which matters, because delivering a report TOUCHES the chat, and
		// a chat touched a moment ago is not stale and would not be trashed for
		// reasons that have nothing to do with this rule.
		if (run) W.stop(run);
		const stillLive = W.liveFor('c-yest');
		await window.DaimondExpiryTick();
		return { queuedLive, runningLive, held, stillLive,
			status: run ? run.status : 'no run', afterDone: DaimondTrash.has('c-yest') };
	});
	check('a chat ten days untouched is NOT trashed while a run is live',
		live && live.queuedLive === true && live.runningLive === true && live.held === true,
		JSON.stringify(live));
	check('and it IS trashed once the last worker has finished',
		live && live.stillLive === false && live.afterDone === true, JSON.stringify(live));

	// ── 7. The boot sweep waits to hear from the other devices ────
	//
	// THE ONE THAT LOSES DATA IF IT IS WRONG. Retention destroys for good and
	// lays a tombstone, and a tombstone is honoured unconditionally by every
	// merge. A device that swept on its own records BEFORE reading the mailbox
	// could therefore destroy something the other device restored a month ago —
	// its own record still says trashed, because the restore is sitting unread
	// in a parcel it has not opened — and the restore would lose to a deletion
	// decided on stale information. The app did exactly this until now.
	//
	// Proved by putting something long overdue in the trash, reloading, and
	// asking whether it survived the first moment of the boot. It must; and it
	// must then go when the pull is announced.
	const gate = await page.evaluate(() => {
		const raw = JSON.parse(localStorage.getItem('daimond-trash') || '{}');
		if (!raw.items || !raw.items['c-old']) return 'no record to age';
		raw.items['c-old'].at = Date.now() - 400 * 24 * 3600 * 1000;
		localStorage.setItem('daimond-trash', JSON.stringify(raw));
		return 'aged';
	});
	check('there is a trashed chat long past its retention to sweep', gate === 'aged', String(gate));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'chatlife');
	await page.waitForTimeout(1500);
	const early = await page.evaluate(() => DaimondTrash.has('c-old'));
	check('it is STILL THERE moments after the boot — the sweep has not run yet',
		early === true, 'it was destroyed before this device had heard from any other');
	const afterPull = await page.evaluate(async () => {
		window.dispatchEvent(new Event('daimond:pulled'));
		await new Promise((r) => setTimeout(r, 1500));
		return DaimondTrash.has('c-old');
	});
	check('and once a pull has landed, the sweep destroys it',
		afterPull === false, 'the sweep never ran, so nothing is ever destroyed');
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) {
	console.log('failed: ' + bad.join('; '));
	if (BREAK) console.log(`\n(expected: --break ${BREAK} is meant to fail)`);
	process.exit(1);
}
if (BREAK) {
	console.log(`\nBREAK '${BREAK}' PASSED EVERYTHING — the checks above do not `
		+ 'actually test what they claim to.');
	process.exit(1);
}
process.exit(0);
