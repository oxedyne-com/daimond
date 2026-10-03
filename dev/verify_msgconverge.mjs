// gateway: none
// verify_msgconverge.mjs -- two devices holding different copies of one message end
// with the same copy, byte for byte, and keep it over a reload (the message law, r53).
//
// THE BUG (soak R4, `messagesRef.key`). `mergeMessages` kept the first copy of a
// message it met. Two devices holding different copies of one mid -- the prompt the
// phone wrote (with `iturn`) and the runner's graft of it (without); a placeholder the
// phone re-seated and the old seat another device still held -- each kept its own for
// good. Their transcript bytes never agreed, so every pull fetched and re-unioned the
// chat, and `continueTurn`/`answerAgain` gathered different messages on each device.
//
// THE PROPERTY, on two REAL devices over one shared cloud, through the real
// `applyChats` / `mergeChatRecords` / `mergeMessages` and real sync round trips:
//   1. the prompt pair: A holds the prompt with `iturn`, B its own copy without, the
//      chat records otherwise equal (so no count, flag or stamp of the chat moves);
//   2. the re-seat: both hold a placeholder, then A re-seats it (a stamped edit);
// after they sync both ways, each chat's transcript is the same on both devices --
// the copy with `iturn`, the new seat -- its content key is the same on both, and a
// reload of each device keeps it (the save did not skip the upgraded chat);
//   3. a tool result saved empty and then saved filled (r53 QA F1): the store holds the
//      empty copy and the filled one as the store cuts it (`slimMessages`, the app's
//      own), compaction runs on the second save, and the read -- before and after a
//      reload -- is the filled result; stamped (this build) and unstamped (an older
//      build's copies, which carry no `at`) alike.
//
// On release/r52 @ d8383871 (first-wins) the convergence checks fail. On fix/r53-wrec
// @ 6758a009 (the law with "not elided" above the stamp) the checks of 3. fail: the
// empty copy is served, and compaction keeps it.
// --break txpending serves a daimond.js whose save skips a chat whose stamp is
// unchanged even when its transcript differs from its chunks: the devices agree in
// memory, and the reload puts B's own copy back.
//
//   node dev/verify_msgconverge.mjs                   # the gate (must be green)
//   node dev/verify_msgconverge.mjs --break txpending # must redden the reload checks
//
// The cloud is stood up IN THIS PROCESS and shared by both contexts, as
// verify_chatmeta_sync does; no gateway or mock model is needed. Needs dev/serve.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER } from './harness.mjs';
import { makeWindow, sliceDaimond } from './syncprobe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (t) => console.log('        . ' + t);

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || dflt) : dflt; };
const BREAK = arg('--break', '');
if (BREAK && BREAK !== 'txpending') { console.error(`unknown break '${BREAK}'; only: txpending`); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') { console.error('--break serves an edited file through page.route; run it under Chromium.'); process.exit(2); }

const PATCHED = new Map();
if (BREAK === 'txpending') {
	const src = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
	const find = '&& disk[c.id] === stamp && !txPending(c)) return;';
	const n = src.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor appears ${n} times (expected 1)`); process.exit(2); }
	PATCHED.set('js/daimond.js', src.replace(find, '&& disk[c.id] === stamp) return;   // --break txpending'));
}
async function patchedSource(page) {
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
}

// ── The cloud, in this process, shared by both contexts ─────────────────
const cloud = { mailbox: null, chunks: new Map(), pushes: [] };
function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version, blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		cloud.pushes.push({ dev, version: cur + 1 });
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob)); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		if (body.op === 'commit') return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } };
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}

const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync && DaimondCore.chatStore
		&& window.DaimondSync && window.DaimondGateway && window.DaimondIdentity && window.DaimondStamp),
	null, { timeout: 20000 });
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(500); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(500); };
const settle = (s) => s.page.evaluate(() => window.DaimondCore.chatStore().settled());

const C1 = 'msg-prompt', C2 = 'msg-reseat', C3 = 'msg-fill-at', C4 = 'msg-fill-old';
// The store's cut, by the app's own `slimMessages` (lifted from the tree under test).
const { slimMessages } = sliceDaimond(makeWindow({ now: 1_000_000_000 }), ['slimMessages'], {}).fns;
const RESULT = 'R'.repeat(5000);
const T0 = 1758790000000;						// one fixed moment, so the two records are equal but for the message

// A transcript over `SYNC_FILE_MAX` (128 kB) cannot ride inline: it offloads, which is the only path with a content
// key and a manifest to compare. A small chat rightly rides inline since F3b-0 (its figures are kept across the
// save), so the chats of 1. and 2. carry fifteen older 10 kB messages ahead of the ones under test, 150 kB in all.
// The pad is identical on both devices, so the only difference between the copies is still the message itself.
const SYNC_FILE_MAX = 128 * 1024;
const pad = (tag) => Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
	content: tag + ' ' + i + ' ' + 'p'.repeat(10000), mid: tag + 'pad' + i, ts: T0 - 1000 + i }));

/// A chat's stored transcript, as the reader serves it, and its content key.
const chatState = (pg, id) => pg.evaluate(async (cid) => {
	const store = window.DaimondCore.chatStore();
	const rec = (store.stored() || []).find(c => c.id === cid) || null;
	if (!rec) return { present: false };
	let msgs = [];
	try { const got = await store.loadMessages(cid); msgs = (got && got.messages) || []; } catch (e) { msgs = []; }
	let key = '';
	try { const cur = window.DaimondCloud && DaimondCloud.contentGet ? DaimondCloud.contentGet('@c/' + cid) : null; key = (cur && cur.key) || ''; }
	catch (e) { key = ''; }
	return { present: true, bytes: JSON.stringify(msgs), msgs, key };
}, id);

/// Write one chat record straight into the store, as a device holding it would.
const putChat = (pg, rec) => pg.evaluate((r) => {
	const store = window.DaimondCore.chatStore();
	const list = store.stored().filter(c => c.id !== r.id);
	list.push(r);
	store.save(list);
	return store.settled();
}, rec);

const PROFILE_A = scratch('pw', 'msgconv-a-' + BROWSER + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'msgconv-b-' + BROWSER + (BREAK ? '-' + BREAK : ''));
for (const d of [PROFILE_A, PROFILE_B]) fs.rmSync(d, { recursive: true, force: true });

let A = null, B = null;
try {
	console.log(`\n-- the copies of one message converge (the message law)${BREAK ? '  [--break ' + BREAK + ']' : ''} --`);

	A = await open({ name: 'msgconv-a', profile: PROFILE_A, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(A); await signInAs(A, 'msgconv'); await ready(A);
	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await open({ name: 'msgconv-b', profile: PROFILE_B, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(B);
	await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(B); await signInAs(B, 'msgconv'); await ready(B);
	await wireCloud(A, 'A'); await wireCloud(B, 'B');

	const keys = { a: await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()), b: await B.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()) };
	check('two contexts hold ONE account', keys.a && keys.a === keys.b, keys.a === keys.b ? 'same key' : 'A!=B');

	// ── 1. The prompt pair: A's copy carries `iturn`, B's (a runner's graft) does not.
	// The records are otherwise identical, so only the message differs.
	const rec1 = (withIturn) => ({ id: C1, name: 'Prompt pair', model: 'mock/fast', provider: '', updatedAt: T0, metaAt: T0,
		messages: [...pad('c1'), withIturn
			? { role: 'user', content: 'what is three plus three', mid: 'u1', iturn: 'u1', ts: T0 - 5 }
			: { role: 'user', content: 'what is three plus three', mid: 'u1', ts: T0 - 5 }], session: null });
	await putChat(A.page, rec1(true));
	await putChat(B.page, rec1(false));

	// ── 2. The re-seat: both devices hold the placeholder, then A re-seats it.
	const place = { role: 'assistant', content: '', mid: 'p1', interrupted: true, why: 'dispatched', iturn: 'u2',
		itext: 'go', toDevice: 'desk-x', toName: 'Desk X', parkCount: 0, ts: T0 - 3 };
	const rec2 = { id: C2, name: 'Re-seat', model: 'mock/fast', provider: '', updatedAt: T0, metaAt: T0,
		messages: [...pad('c2'), { role: 'user', content: 'go', mid: 'u2', iturn: 'u2', ts: T0 - 4 }, place], session: null };
	await putChat(A.page, rec2);
	check('setup: the transcripts of 1. and 2. are over SYNC_FILE_MAX, so each offloads and has a content key',
		JSON.stringify(rec1(true).messages).length > SYNC_FILE_MAX && JSON.stringify(rec2.messages).length > SYNC_FILE_MAX,
		JSON.stringify(rec1(true).messages).length + ' and ' + JSON.stringify(rec2.messages).length + ' B');
	await push(A); await pull(B); await push(B); await pull(A);
	const b2 = await chatState(B.page, C2);
	check('B holds the placeholder before the re-seat', b2.present && /desk-x/.test(b2.bytes), b2.bytes && b2.bytes.slice(-160));
	await A.page.evaluate(async ({ cid }) => {
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		const r = list.find(c => c.id === cid);
		const got = await store.loadMessages(cid);
		const msgs = got.messages.map((m) => Object.assign({}, m));
		const p = msgs.find((m) => m.mid === 'p1');
		// What markTurnDispatched's re-seat writes: the seat moves, and the edit is stamped.
		p.toDevice = 'desk-y'; p.toName = 'Desk Y'; p.parkCount = 1; p.ts = Date.now();
		p.at = window.DaimondStamp.next(p.at);
		r.messages = msgs;
		r.updatedAt = window.DaimondStamp.next(r.updatedAt);		// touchChat
		store.save(list);
		await store.settled();
	}, { cid: C2 });

	// ── Sync both ways, twice over.
	await push(B); await pull(A); await push(A); await pull(B);
	await push(B); await pull(A); await push(A); await pull(B);
	await settle(A); await settle(B);

	const a1 = await chatState(A.page, C1), b1 = await chatState(B.page, C1);
	const a2 = await chatState(A.page, C2), b2b = await chatState(B.page, C2);
	note('prompt pair: A ' + a1.bytes.slice(-200));
	note('prompt pair: B ' + b1.bytes.slice(-200));
	check('1. the prompt pair: both devices hold ONE copy, byte for byte', a1.bytes === b1.bytes);
	check('1. and it is the copy with `iturn`', /"iturn":"u1"/.test(a1.bytes) && /"iturn":"u1"/.test(b1.bytes));
	check('1. the transcript content key is the same on both (no re-fetch on the next pull)',
		!!a1.key && a1.key === b1.key, `A ${a1.key.slice(0, 16)} B ${b1.key.slice(0, 16)}`);
	check('2. the re-seat: both devices hold the new seat, byte for byte',
		a2.bytes === b2b.bytes && /desk-y/.test(b2b.bytes) && !/desk-x/.test(b2b.bytes), 'B ' + b2b.bytes.slice(-220));
	check('2. the transcript content key is the same on both', !!a2.key && a2.key === b2b.key,
		`A ${a2.key.slice(0, 16)} B ${b2b.key.slice(0, 16)}`);

	// ── 3. A tool result saved empty, then saved filled (QA F1). Two saves of one chat,
	// as `persistChats` makes them around a tool run: the push (empty, no fill yet) and
	// the fill, which the save cuts. The second save leaves more copies on disk than
	// messages, so compaction runs on it (`compactChunks`), reducing by the reader's law.
	const fillRec = (cid, msgs) => ({ id: cid, name: 'Tool fill', model: 'mock/fast', provider: '', updatedAt: T0, metaAt: T0,
		messages: msgs, session: null });
	for (const [cid, stamped] of [[C3, true], [C4, false]]) {
		const u = { role: 'user', content: 'list it', mid: 'u3', iturn: 'u3', ts: T0 - 9 };
		const pend = { role: 'tool_log', content: '', mid: 't3', iturn: 'u3', name: 'ls', ts: T0 - 8 };
		const filled = Object.assign({}, pend, { content: RESULT, outcome: 'done' });
		if (stamped) { pend.at = T0 - 8; filled.at = T0 - 7; }
		const cut = slimMessages([filled])[0];
		await putChat(A.page, fillRec(cid, [u, pend]));
		await putChat(A.page, Object.assign(fillRec(cid, [u, cut]), { updatedAt: T0 + 1 }));
		const phys = await A.page.evaluate(async (c) => {
			const rows = await window.DaimondCore.chatStore().chunks(c);
			const out = [];
			rows.forEach((r) => (r.msgs || []).forEach((m) => { if (m.mid === 't3') out.push((m.content || '').length + (m.elided ? 'e' : '')); }));
			return out;
		}, cid);
		const st = await chatState(A.page, cid);
		const t = (st.msgs || []).find((m) => m.mid === 't3') || {};
		const tag = stamped ? '3. (stamped)' : '3. (unstamped, an older build\'s copies)';
		note(tag + ' copies of the tool log on disk after compaction: ' + JSON.stringify(phys));
		check(tag + ' the read serves the filled result, not the empty copy',
			t.outcome === 'done' && (t.content || '').length > 2000 && t.elided === 5000 - 2048,
			'got ' + JSON.stringify({ len: (t.content || '').length, outcome: t.outcome, elided: t.elided }));
		check(tag + ' compaction kept the filled copy (no empty copy left on disk)',
			phys.length >= 1 && phys.every((x) => x !== 0 && x !== '0'), JSON.stringify(phys));
	}

	// ── A reload of each device keeps what it converged on: the upgraded chat was saved.
	for (const [label, s] of [['A', A], ['B', B]]) {
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await ready(s); await signInAs(s, 'msgconv'); await ready(s);
	}
	const ra1 = await chatState(A.page, C1), rb1 = await chatState(B.page, C1);
	const ra2 = await chatState(A.page, C2), rb2 = await chatState(B.page, C2);
	check('after a reload: B still holds the prompt with `iturn` (the upgrade was written)',
		/"iturn":"u1"/.test(rb1.bytes) && rb1.bytes === ra1.bytes, 'B ' + rb1.bytes.slice(-200));
	check('after a reload: both hold the new seat', /desk-y/.test(rb2.bytes) && rb2.bytes === ra2.bytes, 'B ' + rb2.bytes.slice(0, 200));
	for (const cid of [C3, C4]) {
		const st = await chatState(A.page, cid);
		const t = (st.msgs || []).find((m) => m.mid === 't3') || {};
		check('after a reload: ' + cid + ' still reads the filled result',
			t.outcome === 'done' && (t.content || '').length > 2000, 'got ' + JSON.stringify({ len: (t.content || '').length, outcome: t.outcome }));
	}
} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	try { await B?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
