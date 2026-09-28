// gateway: none
// verify_transcriptlaw.mjs — a chat that cannot be read costs only itself (DL-2, 2026-09-27).
//
// THE FAULT, live on 5.2 and 5.2.1. A pulled parcel's chat this device had never held
// was adopted with no look at its transcript. `[null]` was stored and reported merged;
// every later pull from that sender then refused the `chats` section, so sync.js held
// back every push of this device's own; and once the person opened that chat, the
// store's union threw inside an IndexedDB handler, which aborts the transaction every
// chat of the save rides in: "Your conversations are not being saved", and the new
// turns were gone at the next reload. A transcript that was a string was not stored,
// but its write threw half way down the list: every new chat after it in the parcel
// never landed, and the alarm stood although this device's own chats did save.
//
// WHAT THIS HOLDS, on the real page and the real IndexedDB:
//
//   A. THE SYNC DOOR. A parcel carries new chats whose transcripts are not lists of
//      records ([null], a list with a null among real messages, a string, an
//      array-like object), a copy of a chat this device HOLDS whose transcript is a
//      string, and a good new chat after all of them. Applied twice, as every later
//      pull from the same sender is: each bad chat is REFUSED by name (`refused`,
//      not a failed `chats` section, so the version is adopted), none is stored, the
//      held chat keeps every message, the good chat lands, and no alarm is raised.
//
//   B. THE STORE. A row a 5.2.1 page could have left -- `[null]`, with its summary --
//      and one whose transcript is a string with no summary are put straight into
//      the chat database. After a reload the page still boots on its chats, the
//      person opens the `[null]` chat, starts a new chat and takes a turn: no alarm,
//      and after another reload that turn is still there.
//
//   C. THE RESTORE. A backup carrying the same bad chats and a good one is restored:
//      the dialog says how many could not be read, the bad ones are left out, the
//      good one comes back, and this device's own chats are as they were.
//
// EACH PART IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a damaged
// daimond.js to the page (`page.route`) and the run must FAIL:
//
//   node dev/verify_transcriptlaw.mjs --break nolaw      # applyChats takes any transcript (the base)
//   node dev/verify_transcriptlaw.mjs --break section    # a bad chat refuses the whole section
//   node dev/verify_transcriptlaw.mjs --break storethrow # the store's union handler as it was
//   node dev/verify_transcriptlaw.mjs --break restore    # the restore takes any transcript
//   node dev/verify_transcriptlaw.mjs                    # and then, clean
//
// Needs dev/serve.mjs and the mock only. No gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, newChat, signInAs, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const LAW_IF = '\t\t\tif (!transcriptOk(r.messages)) {\n\t\t\t\tif (!tombs[r.id]) refused.push(r.id);';
const HANDLER_NEW = [
	'\t\t\t\t\t\t\t\tg.onsuccess = function () {',
	'\t\t\t\t\t\t\t\t\ttry {',
	'\t\t\t\t\t\t\t\t\t\tvar old = g.result;',
	'\t\t\t\t\t\t\t\t\t\tif (old && !transcriptOk(old.messages)) {',
	'\t\t\t\t\t\t\t\t\t\t\tskip(id, \'the stored transcript is \' + transcriptShape(old.messages));',
	'\t\t\t\t\t\t\t\t\t\t\treturn;',
	'\t\t\t\t\t\t\t\t\t\t}',
	'\t\t\t\t\t\t\t\t\t\trec = slimChat(rec);',
	'\t\t\t\t\t\t\t\t\t\tif (old && ((old.messages || []).length || old.session)) {',
	'\t\t\t\t\t\t\t\t\t\t\trec.messages = slimMessages(mergeMessages(old.messages, rec.messages, id, mtombs));',
	'\t\t\t\t\t\t\t\t\t\t\tif (!rec.session && old.session) rec.session = old.session;',
	'\t\t\t\t\t\t\t\t\t\t\tput[id] = stampOf(rec);         // the stamp of what ACTUALLY lands',
	'\t\t\t\t\t\t\t\t\t\t}',
	'\t\t\t\t\t\t\t\t\t\tcsS.put(rec);',
	'\t\t\t\t\t\t\t\t\t\tsuS.put(summaryLite(rec));',
	'\t\t\t\t\t\t\t\t\t} catch (e) {',
	'\t\t\t\t\t\t\t\t\t\tfail(id, e);',
	'\t\t\t\t\t\t\t\t\t}',
	'\t\t\t\t\t\t\t\t};',
].join('\n');
const HANDLER_OLD = [
	'\t\t\t\t\t\t\t\tg.onsuccess = function () {',
	'\t\t\t\t\t\t\t\t\tvar old = g.result;',
	'\t\t\t\t\t\t\t\t\trec = slimChat(rec);',
	'\t\t\t\t\t\t\t\t\tif (old && ((old.messages || []).length || old.session)) {',
	'\t\t\t\t\t\t\t\t\t\trec.messages = slimMessages(mergeMessages(old.messages, rec.messages, id, mtombs));',
	'\t\t\t\t\t\t\t\t\t\tif (!rec.session && old.session) rec.session = old.session;',
	'\t\t\t\t\t\t\t\t\t\tput[id] = stampOf(rec);',
	'\t\t\t\t\t\t\t\t\t}',
	'\t\t\t\t\t\t\t\t\tcsS.put(rec);',
	'\t\t\t\t\t\t\t\t\tsuS.put(summaryLite(rec));',
	'\t\t\t\t\t\t\t\t};',
].join('\n');
const BREAKS = {
	// The base: a chat's transcript is taken as it came.
	nolaw: [{ file: 'js/daimond.js', find: LAW_IF, with: '\t\t\tif (false) {\n\t\t\t\tif (!tombs[r.id]) refused.push(r.id);' }],
	// The near-fix TRI-1d first described: refuse the whole section. The good chat
	// behind a bad one never lands, and the section fails on every pull.
	section: [{ file: 'js/daimond.js', find: LAW_IF,
		with: '\t\t\tif (!transcriptOk(r.messages)) {\n\t\t\t\tthrow new Error(\'refused \' + r.id);' }],
	// The store's union handler as it shipped: a throw in it aborts every chat's save.
	storethrow: [{ file: 'js/daimond.js', find: HANDLER_NEW, with: HANDLER_OLD }],
	// The restore as it shipped: a bad chat adopted or merged as it came.
	restore: [{ file: 'js/daimond.js', find: '\t\t\t\t\tif (!chatIdOk(r.id) || !transcriptOk(r.messages)) {\n\t\t\t\t\t\tunreadable++;',
		with: '\t\t\t\t\tif (false) {\n\t\t\t\t\t\tunreadable++;' }],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, so nothing was broken.`);
		process.exit(2);
	}
}
async function breakInto(page) {
	if (!BREAK) return;
	const bodies = {};
	for (const spec of BREAKS[BREAK]) {
		damaged(spec);
		bodies[spec.file] = (bodies[spec.file] || fs.readFileSync(path.join(WWW, spec.file), 'utf8'))
			.replace(spec.find, spec.with);
	}
	for (const file of Object.keys(bodies)) {
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: bodies[file],
		}));
	}
}

// ── Reading the truth ────────────────────────────────────────────────
const ALARM = /not being saved/i;
/// Every chat the store holds, id -> message count, read through `loadMessages`: what a
/// reload would show, not what the page has in memory.
const storeCounts = (page) => page.evaluate(async () => {
	const store = window.DaimondCore.chatStore();
	try { await store.settled(); } catch (e) { /* none queued */ }
	const o = {};
	for (const c of store.stored()) {
		if (c && c.id) o[c.id] = ((await store.loadMessages(c.id)).messages || []).length;
	}
	return o;
});
const alarmText = (page) => page.evaluate((re) => (document.body.innerText.match(new RegExp('[^\\n]*' + re + '[^\\n]*', 'i')) || [''])[0], ALARM.source);

const PROFILE = scratch('pw', 'transcriptlaw' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'tlaw', profile: PROFILE, defaults: false, route: breakInto });
const P = s.page;

// The shapes a transcript can arrive in that are not a list of records.
const SHAPES = {
	nullElem: [null],
	mixed:    [{ role: 'user', content: 'readable', mid: 'tl-mx1', ts: 1 }, null],
	string:   'not-a-list',
	object:   { 0: { role: 'user', content: 'array-like', mid: 'tl-ob1', ts: 1 } },
};

try {
	// ── The fixture: a chat of this device's own ─────────────────────
	await chat(s, 'a chat of this device\'s own');
	await P.waitForTimeout(1200);
	const before = await storeCounts(P);
	const ownId = Object.keys(before).find((id) => before[id] > 0) || '';
	check('a chat of this device\'s own is stored', !!ownId && before[ownId] >= 2, JSON.stringify(before));

	// ── A. The sync door ─────────────────────────────────────────────
	const A = await P.evaluate(async ([own, shapes]) => {
		const core = window.DaimondCore, now = Date.now();
		const parcel = await core.collectSync();
		const extra = Object.keys(shapes).map((k) => ({ id: 'tl-bad-' + k, name: 'bad ' + k,
			messages: shapes[k], messagesRef: null, updatedAt: now, metaAt: now }));
		extra.push({ id: 'tl-good', name: 'good', messagesRef: null, updatedAt: now, metaAt: now, messages: [
			{ role: 'user', content: 'hello from elsewhere', mid: 'tl-g1', ts: now },
			{ role: 'assistant', content: 'hi', mid: 'tl-g2', ts: now + 1 }] });
		parcel.chats = (parcel.chats || []).map((c) => (c && c.id === own)
			? Object.assign({}, c, { messages: 'not-a-list', messagesRef: null, updatedAt: now + 5000, name: 'poisoned' })
			: c).concat(extra);
		const out = {};
		for (const round of ['first', 'second']) {
			try { out[round] = await core.applySync(JSON.parse(JSON.stringify(parcel))); }
			catch (e) { out[round] = { threw: String(e && e.message || e) }; }
			await new Promise((r) => setTimeout(r, 600));
		}
		return out;
	}, [ownId, SHAPES]);
	const afterA = await storeCounts(P);
	for (const round of ['first', 'second']) {
		const rep = A[round] || {};
		const refusedIds = (rep.refused && rep.refused.chats) || [];
		check(`A ${round} apply: the chats section is not failed (the version is adopted)`,
			Array.isArray(rep.failed) && rep.failed.indexOf('chats') === -1, JSON.stringify(rep).slice(0, 300));
		check(`A ${round} apply: every bad chat, and the poisoned held chat, is REFUSED by name`,
			Object.keys(SHAPES).every((k) => refusedIds.indexOf('tl-bad-' + k) !== -1) && refusedIds.indexOf(ownId) !== -1,
			JSON.stringify(refusedIds));
	}
	check('A: no bad chat was stored', Object.keys(SHAPES).every((k) => !('tl-bad-' + k in afterA)), JSON.stringify(afterA));
	check('A: the good chat after them landed whole', afterA['tl-good'] === 2, JSON.stringify(afterA));
	check('A: this device\'s own chat kept every message', afterA[ownId] === before[ownId],
		before[ownId] + ' -> ' + afterA[ownId]);
	check('A: and no alarm says the conversations are not being saved', (await alarmText(P)) === '', await alarmText(P));
	// WHAT THIS DEVICE SENDS ON: its next parcel carries none of the refused chats, and its
	// own copy of the held one as a list of records -- so an older page it syncs with is
	// handed nothing it would take in unchecked (the mixed-version half this page owns).
	const sent = await P.evaluate(async ([own, names]) => {
		const parcel = await window.DaimondCore.collectSync();
		const ids = (parcel.chats || []).map((c) => c && c.id);
		const mine = (parcel.chats || []).find((c) => c && c.id === own) || null;
		const ownOk = !!mine && (mine.messagesRef ? true : (Array.isArray(mine.messages)
			&& mine.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m))));
		return { carriesBad: names.filter((n) => ids.indexOf(n) !== -1), ownOk, ref: !!(mine && mine.messagesRef) };
	}, [ownId, Object.keys(SHAPES).map((k) => 'tl-bad-' + k)]);
	check('A: the next parcel this device sends carries no refused chat, and its own copy of the held one is a list of records',
		sent.carriesBad.length === 0 && sent.ownOk, JSON.stringify(sent));
	const syncState = await P.evaluate(() => (window.DaimondSync && DaimondSync.state) ? DaimondSync.state() : null);
	check('A: the sync engine can say which chats it left out',
		!syncState || Array.isArray(syncState.refusedChats), JSON.stringify(syncState && syncState.refusedChats));

	// ── B. The store: rows a 5.2.1 page could have left ──────────────
	const planted = await P.evaluate(async () => {
		const ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || '';
		const name = ns ? 'daimond-chats-' + ns : 'daimond-chats';
		const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
		const now = Date.now();
		const row = (id, messages) => ({ id, name: id, messages, model: '', provider: '', status: 'active', session: null,
			holds: [], updatedAt: now, metaAt: now });
		const sum = { id: 'tl-poison', v: 1, name: 'tl-poison', model: '', provider: '', diamondId: '', status: 'active',
			holds: [], updatedAt: now, metaAt: now, msgCount: 1, standing: 'p0f0i0', opening: '', chunks: 1,
			hasSession: false, sessionMsgs: 0, iturns: [], fp: '', bytes: 6 };
		await new Promise((res, rej) => {
			const t = db.transaction(['chats', 'chatsum'], 'readwrite');
			t.objectStore('chats').put(row('tl-poison', [null]));
			t.objectStore('chatsum').put(sum);
			t.objectStore('chats').put(row('tl-poison-str', 'not-a-list'));	// no summary: boot derives one
			t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
		});
		db.close();
		return name;
	});
	console.log('  (planted two rows in ' + planted + ')');
	await P.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'tlaw');
	await P.waitForTimeout(2500);
	const booted = await P.evaluate(() => (window.DaimondCore.chatStore().stored() || []).map((c) => c && c.id));
	check('B: the page still boots on its chats with the two rows in the store',
		booted.indexOf(ownId) !== -1 && booted.indexOf('tl-good') !== -1, JSON.stringify(booted));
	let opened = false;
	try {
		await P.click('#session-list .session-box[data-id="tl-poison"]', { timeout: 5000 });
		opened = true;
	} catch (e) { /* reported below */ }
	await P.waitForTimeout(1500);
	check('B: the person opened the [null] chat', opened);
	await newChat(s);
	await chat(s, 'my own turn after opening that chat');
	await P.waitForTimeout(2500);
	const seen = await P.evaluate(() => window.DaimondCore.chatResidency().map((r) => r.id + ':' + r.msgCount));
	check('B: no alarm says the conversations are not being saved', (await alarmText(P)) === '', await alarmText(P));
	await P.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'tlaw');
	await P.waitForTimeout(3000);
	const back = await storeCounts(P);
	const lost = seen.filter((r) => {
		const i = r.lastIndexOf(':'), id = r.slice(0, i), n = Number(r.slice(i + 1));
		return !id.startsWith('tl-') && !((back[id] || 0) >= n);
	});
	check('B: after a reload, nothing of this device\'s own is lost (the new turn is there)',
		lost.length === 0 && Object.keys(back).some((id) => !id.startsWith('tl-') && id !== ownId && back[id] >= 2),
		'lost=' + JSON.stringify(lost) + ' back=' + JSON.stringify(back));

	// ── C. The restore ───────────────────────────────────────────────
	await P.click('#user-row');
	await P.waitForTimeout(400);
	const dl = P.waitForEvent('download', { timeout: 15000 });
	await P.click('button.admin-item:has-text("Export a backup")');
	const bkPath = scratch('transcriptlaw-backup' + (BREAK ? '-' + BREAK : '') + '.json');
	await (await dl).saveAs(bkPath);
	const backup = JSON.parse(fs.readFileSync(bkPath, 'utf8'));
	const now = Date.now();
	backup.chats = (backup.chats || []).map((c) => (c && c.id === ownId)
		? Object.assign({}, c, { messages: 'not-a-list', updatedAt: now + 9000, name: 'poisoned in the backup' }) : c)
		.concat(Object.keys(SHAPES).map((k) => ({ id: 'tl-rbad-' + k, name: 'restore bad ' + k, messages: SHAPES[k],
			updatedAt: now, metaAt: now })))
		.concat([{ id: 'tl-rgood', name: 'restore good', updatedAt: now, metaAt: now, messages: [
			{ role: 'user', content: 'from the backup', mid: 'tl-r1', ts: now },
			{ role: 'assistant', content: 'restored', mid: 'tl-r2', ts: now + 1 }] }]);
	fs.writeFileSync(bkPath, JSON.stringify(backup));
	const ownBefore = (await storeCounts(P))[ownId];
	await P.click('#user-row');
	await P.waitForTimeout(400);
	const ch = P.waitForEvent('filechooser', { timeout: 15000 });
	await P.click('button.admin-item:has-text("Import a backup")');
	await (await ch).setFiles(bkPath);
	let said = '';
	try {
		await P.waitForSelector('.dlg-ok', { timeout: 20000 });
		said = await P.evaluate(() => document.body.innerText);
		await P.click('.dlg-ok');
	} catch (e) { said = '(no dialog: ' + String(e.message).split('\n')[0] + ')'; }
	check('C: the restore finished and said how many conversations could not be read',
		/4 conversations in that backup could not be read/.test(said) || /5 conversations in that backup could not be read/.test(said),
		(said.match(/[^\n]*could not be read[^\n]*/) || [said.slice(0, 160)])[0]);
	await signInAs(s, 'tlaw');
	await P.waitForTimeout(3000);
	const afterC = await storeCounts(P);
	check('C: no bad chat from the backup was stored',
		Object.keys(SHAPES).every((k) => !('tl-rbad-' + k in afterC)), JSON.stringify(afterC));
	check('C: the good chat in the backup came back', afterC['tl-rgood'] === 2, JSON.stringify(afterC));
	check('C: this device\'s own chat kept every message', afterC[ownId] === ownBefore, ownBefore + ' -> ' + afterC[ownId]);
	check('C: and no alarm', (await alarmText(P)) === '', await alarmText(P));
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `break '${BREAK}' was CAUGHT, which is what this run had to prove.`
		: `break '${BREAK}' PASSED — the checks do not discriminate and prove nothing.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
