// verify_chatmeta_sync.mjs — S-SYNC #5, the two-device rename-vs-turn live driver.
//
// THE BUG. Chat scalars were record-level last-writer-wins on ONE stamp,
// `updatedAt`, which `touchChat` bumps on ~31 paths — a turn among them. So a
// rename made on the phone (a small bump of `updatedAt`) was clobbered the moment
// a dispatched turn landed from the runner with a larger `updatedAt`: the
// transcript unioned fine, but the name snapped back — "the rename didn't stick".
// One stamp cannot tell a rename from a turn.
//
// THE FIX (committed 10e476e4). Split the stamp: `updatedAt` stays the
// turn/transcript stamp; a new `metaAt` stamps the user-facing scalars (name,
// model, status, fold, holds…). `touchChat` moves `updatedAt` only;
// `touchChatMeta` moves both. `mergeChatRecords` resolves transcript+turn fields
// by `updatedAt` and the metadata scalars by `metaAt`, at every apply/merge site.
//
// THE PROPERTY, on two REAL devices over one shared cloud, through the real
// `applyChats` / `mergeChatRecords` and a real sync round-trip:
//   A RENAMES a chat (touchChatMeta — a high metaAt, a modest updatedAt) at the
//   same time B takes a TURN on it (touchChat — a high updatedAt, metaAt
//   untouched). After they sync both ways:
//     * the name is A's rename on BOTH devices (the metadata winner governs it) —
//       no lost rename;
//     * the transcript holds B's turn message on both — no lost turn;
//     * a reload of each device shows the same (the merge is durable).
//
// --break lww serves a daimond.js in which `mergeChatRecords` resolves the name
// from the TURN winner again (record-level LWW): B's later turn then reverts A's
// rename, exactly as the bug did. It reddens the no-lost-rename assertions.
//
//   node dev/verify_chatmeta_sync.mjs             # the gate (must be green)
//   node dev/verify_chatmeta_sync.mjs --break lww # pre-fix LWW (must redden)
//
// The cloud is stood up IN THIS PROCESS and shared by both contexts (a mailbox
// with the gateway's version guard, and a content store), so no dev gateway and no
// mock LLM are needed — a "turn" here is a message appended with `touchChat`'s
// stamp, which is what the runner's landed turn is to the merge. Needs dev/serve.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || dflt) : dflt; };
const BREAK = arg('--break', '');
if (BREAK && BREAK !== 'lww') { console.error(`unknown break '${BREAK}'; only: lww`); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') {
	console.error(`--break serves an edited file through page.route, which does not fire under ${BROWSER}. Run the break under Chromium.`);
	process.exit(2);
}

// ── The seam must be present, or a green run would prove nothing ──────
const SEAM = [
	{ want: 'out.name           = metaNewer.name;', why: 'the metadata scalar resolution is missing' },
	{ want: 'var metaNewer = DaimondStamp.beats(am, ', why: 'the metaAt merge winner is missing' },
];
{
	const src = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
	for (const s of SEAM) if (!src.includes(s.want) && !BREAK) { console.error(`seam missing: ${s.why}`); process.exit(2); }
}

// ── The break: mergeChatRecords resolves the name from the TURN winner ──
const PATCHED = new Map();
if (BREAK === 'lww') {
	const src = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
	const find = 'out.name           = metaNewer.name;';
	const n = src.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor appears ${n} times (expected 1)`); process.exit(2); }
	PATCHED.set('js/daimond.js', src.replace(find,
		'out.name           = turnNewer.name;   // --break lww: record-level LWW, the rename reverts'));
}
async function patchedSource(page) {
	if (!PATCHED.size) return;
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
}

// ═══════════════════════════════════════════════════════════════════════
// THE CLOUD, in this process, shared by both contexts.
// ═══════════════════════════════════════════════════════════════════════
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
		if (body.op === 'commit') { const live = new Set((body.chunks || []).map(c => c.addr)); for (const a of [...cloud.chunks.keys()]) if (!live.has(a)) cloud.chunks.delete(a); return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } }; }
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev; window.__ds = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}

const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync && DaimondCore.chatStore
		&& window.DaimondSync && window.DaimondGateway && window.DaimondIdentity),
	null, { timeout: 20000 });
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(500); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(500); };

const CID = 'meta-chat';

/// The chat as it is stored: its name, its metaAt/updatedAt, and its message ids.
const chatState = (pg, id) => pg.evaluate(async (cid) => {
	const store = window.DaimondCore.chatStore();
	const rec = (store.stored() || []).find(c => c.id === cid) || null;
	if (!rec) return { present: false };
	let msgs = [];
	try { const got = await store.loadMessages(cid); msgs = (got && got.messages) || rec.messages || []; }
	catch (e) { msgs = rec.messages || []; }
	return { present: true, name: rec.name, metaAt: rec.metaAt || 0, updatedAt: rec.updatedAt || 0,
		mids: msgs.map(m => m.mid) };
}, id);

const PROFILE_A = scratch('pw', 'cmeta-a-' + BROWSER + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'cmeta-b-' + BROWSER + (BREAK ? '-' + BREAK : ''));
for (const d of [PROFILE_A, PROFILE_B]) fs.rmSync(d, { recursive: true, force: true });

let A = null, B = null;
try {
	console.log(`\n— S-SYNC #5: a rename on A concurrent with a turn on B${BREAK ? '  [--break ' + BREAK + ']' : ''} —`);

	A = await open({ name: 'cmeta-a', profile: PROFILE_A, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(A); await signInAs(A, 'cmeta'); await ready(A);
	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await open({ name: 'cmeta-b', profile: PROFILE_B, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(B);
	await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(B); await signInAs(B, 'cmeta'); await ready(B);
	await wireCloud(A, 'A'); await wireCloud(B, 'B');

	const keys = { a: await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()), b: await B.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()) };
	check('two contexts hold ONE account', keys.a && keys.a === keys.b, keys.a === keys.b ? 'same key' : 'A≠B');

	// ── A creates a chat both devices will agree on ──
	await A.page.evaluate((cid) => {
		const store = window.DaimondCore.chatStore();
		const now = Date.now();
		const list = store.stored();
		list.push({ id: cid, name: 'Original', model: 'mock/fast', provider: '', updatedAt: now, metaAt: now,
			messages: [{ role: 'user', content: 'the opening message', mid: 'm0', ts: now }], session: null });
		store.save(list);
	}, CID);
	await push(A); await pull(B); await push(B); await pull(A);
	const b0 = await chatState(B.page, CID);
	check('B adopted the chat before either edits it', b0.present && b0.name === 'Original' && b0.mids.indexOf('m0') !== -1,
		`present=${b0.present} name=${b0.name} mids=${JSON.stringify(b0.mids)}`);

	// ── A RENAMES the chat: touchChatMeta bumps BOTH stamps (metaAt high) ──
	await A.page.evaluate((cid) => {
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		const rec = list.find(c => c.id === cid);
		const now = Date.now();
		rec.name = 'Renamed by A';
		rec.updatedAt = now; rec.metaAt = now;   // touchChatMeta: both stamps move
		store.save(list);
	}, CID);
	const aRen = await chatState(A.page, CID);

	// ── B takes a TURN slightly later: touchChat bumps updatedAt ONLY (metaAt untouched) ──
	await B.page.waitForTimeout(60);
	await B.page.evaluate(async (cid) => {
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		const rec = list.find(c => c.id === cid);
		const got = await store.loadMessages(cid);
		const msgs = ((got && got.messages) || rec.messages || []).slice();
		msgs.push({ role: 'assistant', content: 'the runner turn answer', mid: 'm1', ts: Date.now() });
		rec.messages = msgs;
		rec.updatedAt = Date.now();               // touchChat: only the turn stamp moves; metaAt stays
		store.save(list);
	}, CID);
	const bTurn = await chatState(B.page, CID);
	check('the rename holds the larger metaAt; the turn holds the larger updatedAt',
		aRen.metaAt > bTurn.metaAt && bTurn.updatedAt > aRen.updatedAt,
		`A metaAt=${aRen.metaAt} > B metaAt=${bTurn.metaAt}; B updatedAt=${bTurn.updatedAt} > A updatedAt=${aRen.updatedAt}`);

	// ── Sync both ways: each device pulls the other's parcel ──
	await push(B); await pull(A); await push(A); await pull(B);
	await push(A); await pull(B); await push(B); await pull(A);

	const a = await chatState(A.page, CID);
	const b = await chatState(B.page, CID);
	note(`after sync: A name=${a.name} mids=${JSON.stringify(a.mids)}; B name=${b.name} mids=${JSON.stringify(b.mids)}`);

	// ═══ THE S-SYNC #5 GATE ═══
	check('#5 no lost rename — A keeps its rename after B\'s turn lands', a.name === 'Renamed by A', 'A name=' + a.name);
	check('#5 no lost rename — B ADOPTS the rename it never made (name resolves by metaAt)', b.name === 'Renamed by A', 'B name=' + b.name);
	check('#5 no lost turn — A holds B\'s turn message', a.mids.indexOf('m1') !== -1 && a.mids.indexOf('m0') !== -1, 'A mids=' + JSON.stringify(a.mids));
	check('#5 no lost turn — B holds the full transcript', b.mids.indexOf('m1') !== -1 && b.mids.indexOf('m0') !== -1, 'B mids=' + JSON.stringify(b.mids));
	check('#5 both devices converge on ONE name', a.name === b.name, `A=${a.name} B=${b.name}`);

	// ── Durability: a reload of each device shows the same merged record ──
	for (const [label, s] of [['A', A], ['B', B]]) {
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await ready(s); await signInAs(s, 'cmeta'); await ready(s);
		const r = await chatState(s.page, CID);
		check(`#5 ${label}: the rename and the turn both survive a reload`,
			r.name === 'Renamed by A' && r.mids.indexOf('m1') !== -1,
			`name=${r.name} mids=${JSON.stringify(r.mids)}`);
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
