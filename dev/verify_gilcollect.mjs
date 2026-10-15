// gateway: none
// verify_gilcollect.mjs -- a quiet collect loads nothing on a folder-mounted, non-committing device
// (UNBLOCK-4, D-20261013-06; diag ~/usr/code/ai/claude/notes/daimond_gilgamesh_oom_20261013/diag.md).
//
// THE BUG. On gilgamesh (folder-mounted, so it never commits the chunk index) every sync collect
// re-loaded every chat from IndexedDB, serialised and hashed it -- +28 to +53 transcript loads per
// collect, ~26 MB -- although every summary carried `bytes` and `fp`. The changed chat's offload
// then wrapped its in-memory bytes in `new Blob([bytes])`, a copy held in the browser process until
// a GC the small JS heap never prompts. Renderer and browser rose ~0.5-1.2 GB together on every
// collect of a turn, and systemd-oomd killed Chrome.
//
// THE WORLD. One real device, folder-mounted through the panel's own door (`standInFolders`), with
// a chunk store stood up in this process. Forty chats in gilgamesh's size profile -- 9.2, 5.9, 4.9
// and 1.4 MB, three of ~1 MB and 33 small -- seeded, then the page RELOADED so the mirror holds
// summaries only, as it does after a boot.
//
// THE PROPERTY.
//   0. the device is folder-mounted and refuses to commit, and the first collect offloads;
//   1. ten quiet collects: `chatStore().loadCount()` moves by 0 on each;
//   2. ten busy collects, each after one round appended to the 5.9 MB chat: at most 1 load each,
//      and the parcel names the moved transcript;
//   3. across all twenty, no `new Blob` of in-memory bytes (Uint8Array / ArrayBuffer parts) on the
//      offload path.
//
//   eval "$(bash dev/world.sh 93 --up)"; node dev/verify_gilcollect.mjs
//
// Options: --scale F shrinks every transcript by F (default 1, the real sizes).
// Needs dev/serve.mjs and Chromium; no gateway or mock model.
import fs from 'node:fs';
import { open, signInAs, scratch, standInFolders } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (t) => console.log('        . ' + t);
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || dflt) : dflt; };
const SCALE = parseFloat(arg('--scale', '1'));

// ── The cloud, in this process ──────────────────────────────────────────
const cloud = { mailbox: null, chunks: new Map(), puts: 0 };
function serve(rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version, blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || 'G' };
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach(c => { cloud.chunks.set(c.addr, c.blob); cloud.puts++; }); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		if (body.op === 'commit') return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } };
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function patchCloud(s) {
	await s.page.evaluate(() => {
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
		// Every `new Blob` whose parts hold bytes already in memory, counted while `__blobOn` is set.
		if (!window.__blobWrapped) {
			const B = window.Blob;
			window.__blobs = { n: 0, bytes: 0 };
			window.Blob = class extends B {
				constructor(parts, o) {
					super(parts, o);
					if (window.__blobOn && Array.isArray(parts) && parts.some(x => x instanceof Uint8Array || x instanceof ArrayBuffer
						|| (x && x.buffer instanceof ArrayBuffer))) { window.__blobs.n++; window.__blobs.bytes += this.size; }
				}
			};
			window.__blobWrapped = true;
		}
	});
}
const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.chatStore && window.DaimondCloud && window.DaimondStamp),
	null, { timeout: 20000 });

// ── Gilgamesh's profile ─────────────────────────────────────────────────
const T0 = 1758790000000;
const MB = 1024 * 1024;
const BIG = { 'gil-c92': 9.2 * MB, 'gil-life': 5.9 * MB, 'gil-c49': 4.9 * MB, 'gil-c14': 1.4 * MB, 'gil-c10a': 1.0 * MB, 'gil-c10b': 1.0 * MB, 'gil-c10c': 1.0 * MB };
const LIFE = 'gil-life';
const specs = Object.entries(BIG).map(([id, b]) => ({ id, bytes: Math.round(b * SCALE), len: 1900 }));
for (let i = 0; i < 33; i++) specs.push({ id: 'gil-s' + i, bytes: Math.round((2 + (i * 37) % 90) * 1024 * SCALE), len: 400 });

// Built inside the page, so twenty-odd MB of transcript never crosses the wire.
const seed = (pg) => pg.evaluate(async ({ specs, T0 }) => {
	const store = window.DaimondCore.chatStore();
	const list = store.stored().slice();
	specs.forEach((sp, k) => {
		const n = Math.max(2, Math.round(sp.bytes / (sp.len + 90)));
		const fill = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(sp.len / 27)).slice(0, sp.len);
		const messages = Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: sp.id + ' ' + i + ' ' + fill,
			mid: sp.id + '-m' + i, ts: T0 - 100000 + i }));
		list.push({ id: sp.id, name: 'Gil ' + sp.id, model: 'mock/fast', provider: '', updatedAt: T0 + k, metaAt: T0, messages, session: null });
	});
	store.save(list);
	await store.settled();
	return store.stored().length;
}, { specs, T0 });

// One collect, measured: the loads it made (and of which chats), the Blob copies, the chunk puts.
const collect = (pg) => pg.evaluate(async (LIFE) => {
	const store = window.DaimondCore.chatStore();
	await store.settled();
	if (window.DaimondCloud.settle) await window.DaimondCloud.settle();
	const pre = store.stored().filter(c => typeof c.bytes !== 'number').length;
	const preFp = store.stored().filter(c => !c.fp).length;
	const ids = [];
	const real = store.loadMessages;
	store.loadMessages = function (id) { ids.push(id); return real.apply(this, arguments); };
	store.resetLoadCount();
	window.__blobs.n = 0; window.__blobs.bytes = 0; window.__blobOn = true;
	let parcel;
	try { parcel = await window.DaimondCore.collectSync(); }
	finally { window.__blobOn = false; store.loadMessages = real; }
	const e = (parcel.chats || []).find(c => c.id === LIFE) || null;
	const sum = store.stored().find(c => c.id === LIFE) || {};
	return { loads: store.loadCount(), ids, pre, preFp, blobs: window.__blobs.n, blobBytes: window.__blobs.bytes,
		refs: (parcel.chats || []).filter(c => c.messagesRef).length, inline: (parcel.chats || []).filter(c => Array.isArray(c.messages)).length,
		lifeKey: e && e.messagesRef ? e.messagesRef.key : '', lifeFp: sum.fp || '', lifeSeed: sum.seed || '' };
}, LIFE);

// One round onto the 5.9 MB chat, saved with no figures, as `persistChats` and `applyChats` save. An
// even round is a turn in the open chat (resident, so `carryChatFigures` measures it); an odd one is
// a peer's round merged into a copy not resident here, which leaves the chat with no `bytes`.
const appendRound = (pg, k) => pg.evaluate(async ({ LIFE, k, T0 }) => {
	const store = window.DaimondCore.chatStore();
	await store.settled();
	const got = await store.loadMessages(LIFE);
	const mirror = store.stored();
	const r = mirror.find(c => c.id === LIFE);
	const msgs = (got.messages || []).concat([
		{ role: 'user', content: 'round ' + k + ' question', mid: 'busy-u' + k, ts: T0 + 1000 + 2 * k },
		{ role: 'assistant', content: 'round ' + k + ' answer '.repeat(40), mid: 'busy-a' + k, ts: T0 + 1001 + 2 * k }]);
	const r2 = Object.assign({}, r, { messages: msgs, updatedAt: (r.updatedAt || 0) + 10, _loaded: k % 2 === 0 });
	delete r2.fp; delete r2.bytes; delete r2.seed;
	store.save(mirror.map(c => c.id === LIFE ? r2 : c));
	await store.settled();
	return msgs.length;
}, { LIFE, k, T0 });

const PROFILE = scratch('pw', 'gilcollect');
fs.rmSync(PROFILE, { recursive: true, force: true });
let G = null;
try {
	console.log('\n-- a quiet collect loads nothing on a folder-mounted, non-committing device (UNBLOCK-4) --');
	G = await open({ name: 'gilcollect', profile: PROFILE, signIn: false, connect: false, defaults: false });
	await ready(G); await signInAs(G, 'gilcollect'); await ready(G);
	await G.page.exposeFunction('__cloudCall', async (p, method, body) => serve(p, method, body));
	await patchCloud(G);
	const n = await seed(G.page);
	note('seeded ' + n + ' chats, ' + (specs.reduce((a, s) => a + s.bytes, 0) / MB).toFixed(1) + ' MB of transcript');

	// A boot: the mirror holds summaries only.
	await G.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(G); await signInAs(G, 'gilcollect'); await ready(G); await patchCloud(G);
	const folders = await standInFolders(G, { tag: 'gilcol', which: ['a'], dirs: ['notes'] });
	const picked = await folders.pick('a');
	await patchCloud(G);
	const why = await G.page.evaluate(() => (window.DaimondCore.syncCommitBlockedReason && DaimondCore.syncCommitBlockedReason()) || '');
	const first = await collect(G.page);
	note('first collect: ' + JSON.stringify({ loads: first.loads, refs: first.refs, inline: first.inline, blobs: first.blobs }));
	check('0. the device is folder-mounted and may not commit, and the first collect offloads',
		picked.landed && why === 'folder-mounted' && first.refs >= 7 && !!first.lifeKey, JSON.stringify({ landed: picked.landed, why, refs: first.refs }));
	// The second collect may still settle what the first measured; the quiet arm starts after it.
	const second = await collect(G.page);
	note('second collect: loads ' + second.loads);

	const quiet = [];
	for (let i = 0; i < 10; i++) quiet.push(await collect(G.page));
	const qLoads = quiet.map(q => q.loads);
	note('quiet unmeasured/no-fp before each: ' + quiet.map(q => q.pre + '/' + q.preFp).join(' '));
	note('quiet loads per collect: ' + qLoads.join(' ') + '; first ids: ' + quiet[0].ids.slice(0, 6).join(','));
	check('1. ten quiet collects each load 0 transcripts', qLoads.every(x => x === 0), 'loads ' + qLoads.join(' '));
	check('1. and name the same transcript for the 5.9 MB chat', quiet.every(q => q.lifeKey === quiet[0].lifeKey && !!q.lifeKey));

	const busy = [];
	let keyPrev = quiet[quiet.length - 1].lifeKey, moved = true;
	for (let i = 0; i < 10; i++) {
		await appendRound(G.page, i);
		const b = await collect(G.page);
		if (!b.lifeKey || b.lifeKey === keyPrev) moved = false;
		keyPrev = b.lifeKey;
		busy.push(b);
	}
	const bLoads = busy.map(b => b.loads);
	note('busy unmeasured/no-fp before each: ' + busy.map(q => q.pre + '/' + q.preFp).join(' '));
	note('busy loads per collect: ' + bLoads.join(' ') + '; first ids: ' + busy[0].ids.slice(0, 6).join(','));
	check('2. ten busy collects each load at most 1 transcript', bLoads.every(x => x <= 1), 'loads ' + bLoads.join(' '));
	check('2. and each names the moved transcript of the 5.9 MB chat', moved);
	const blobs = quiet.concat(busy).map(c => c.blobs);
	const blobMB = quiet.concat(busy).reduce((a, c) => a + c.blobBytes, 0) / MB;
	check('3. no new Blob of in-memory bytes across the twenty collects', blobs.every(x => x === 0),
		'blobs ' + blobs.join(' ') + ' (' + blobMB.toFixed(1) + ' MB)');
	await folders.tidy();
} catch (e) {
	console.log('VERIFIER THREW:', e && (e.stack || e.message || e));
	bad.push('verifier threw: ' + (e && e.message));
} finally {
	try { await G?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
