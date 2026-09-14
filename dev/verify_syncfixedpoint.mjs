// verify_syncfixedpoint.mjs — two devices that are both up to date send nothing.
//
// The reported fault was "the phone and the desktops sync every two minutes all
// night". The archive says it is not a timer at all: two idle desktops DO settle,
// and the loop starts the moment a third device commits the chunk index for them.
// This drives the real thing -- two paired contexts on one account, over one
// shared cloud -- and asserts the fixed point the whole engine rests on.
//
// THE TOPOLOGY IS THE FAULT, so it is the fixture. The owner's account has
// FOLDER-MOUNTED desktops, which hold no mergeable chunk index and therefore
// never commit one (`syncMayCommitChunks` is false: dev/verify_dataloss.mjs
// proves that is correct), and a device that DOES commit. So:
//
//   A — folder-mounted. Offloads its chats and Diamonds; commits nothing, and
//       its file census is empty, so it cannot put a file back either.
//   B — the sandbox. Unions A's content, and commits the account's live set.
//
// Six properties, in the order they broke:
//
//   (i)   A'S CHUNKS SURVIVE B'S COMMIT. Two devices that compute the same union
//         land it at different addresses (a fresh IV per seal), so B's index
//         names only its own -- unless it also names A's, which is what a
//         `.peer.<device>` slot is for. The gateway sweeps every chunk the
//         committing index does not name, so without that slot B's commit
//         deletes A's uploads the same minute they land.
//   (ii)  AND THE SLOT SURVIVES THE COLLECT THAT COMMITS IT. `contentReap` runs
//         over `@c/` with the live CHAT IDS, and a slot key is not a chat id: it
//         is kept only because `peerOwner` recognises the device segment. It did
//         not -- `PEER_RE` admitted 16-hex ids and every roster id is 32 -- so
//         every slot was deleted by the very collect that was about to declare it.
//   (iii) THE PARCEL IS A FIXED POINT. Two idle collects, byte-identical, on both
//         sides. `push` skips the wire on exactly this comparison.
//   (iv)  AND IT STAYS ONE WHILE TIME PASSES. `touchSelfDevice` moves a roster
//         `seen` stamp every five minutes whether or not anything else moved, and
//         a pull merges the PEER's moved stamp -- so a mask over this device's own
//         line alone still left each side with news for the other. Ten simulated
//         minutes of that, then a real quiet window, and the version must not move.
//   (v)   NOTHING IS RE-OFFLOADED AND NOTHING IS MISSING. After the second round
//         the feed says `refs_missing: 0` and no chunk is uploaded again. The
//         desktops re-offloaded the same five items every round for hours.
//   (vi)  AND A LOSS NOTHING CAN HEAL IS LET GO OF. A file manifest whose chunks
//         the gateway no longer holds is kept once -- one sweep is not a verdict
//         -- and dropped on the second answered sighting. It used to be either
//         carried for ever (the drop waited for a peer to name the same
//         addresses, which no file manifest can ever have) or forgotten at once
//         on the promise of a re-offload the device could not make.
//
// The cloud is stood up in THIS PROCESS and shared by both contexts: a mailbox
// with the gateway's version guard, a content-addressed chunk store, and the
// commit sweep exactly as the gateway performs it -- everything the committing
// index does not name is deleted, with no age grace. That is the harsh form, on
// purpose: the grace (`CHUNK_NOTE_GRACE_SECS`, gateway/src/schema.rs) closes the
// upload-vs-commit RACE, and this file must prove the client no longer needs it.
//
// Both pages are stubbed at `DaimondGateway.gwFetch`, which is one late-bound
// function on a global and NOT a `page.route`: Playwright's request interception
// does not fire under WebKit, and the engine the owner's phone runs is half of
// what this file is for.
//
//   eval "$(bash dev/world.sh 31 --env)"
//   node dev/verify_syncfixedpoint.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_syncfixedpoint.mjs
//   node dev/verify_syncfixedpoint.mjs --quiet 600      # the plan's ten real minutes
//   node dev/verify_syncfixedpoint.mjs --break narrowpeer
//   node dev/verify_syncfixedpoint.mjs --break selfmask
//   node dev/verify_syncfixedpoint.mjs --break nodrop
//   node dev/verify_syncfixedpoint.mjs --break forgetfiles
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, clearDiamonds, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

const arg = (flag, dflt) => {
	const i = process.argv.indexOf(flag);
	return i > 0 ? String(process.argv[i + 1] || dflt) : dflt;
};
const BREAK = arg('--break', '');
// The real quiet window, in seconds. The plan asks for ten minutes; the default
// is two, because the ten are also asserted in SIMULATED form below -- where the
// stamp that moves is moved by hand rather than waited for -- and a suite that
// spends twenty minutes of wall clock twice over is a suite nobody runs. Pass
// `--quiet 600` for the literal reading.
const QUIET_SECS = Math.max(30, Number(arg('--quiet', '120')) || 120);

// ── The breaks: each one is a fix undone, and reddens its own checks ──

const BREAKS = {
	// `PEER_RE` back to 16-hex ids, which is every version before 2026-09-14.
	// Every peer slot the app writes is keyed by a 32-hex roster id, so none of
	// them is recognised: the collect that commits deletes them, and B's commit
	// sweeps A's chunks. (i), (ii) and (v) redden.
	narrowpeer: [{
		file: 'js/cloud.js',
		find: 'var PEER_RE = /\\.peer(?:\\.([0-9a-f]{16}|[0-9a-f]{32}))?$/;',
		with: 'var PEER_RE = /\\.peer(?:\\.([0-9a-f]{16}))?$/;',
	}],
	// The comparison key masks this device's own `seen` and no other line's, which
	// is where it stood between 2026-09-12 and 2026-09-14. A pull merges the peer's
	// moved stamp and the next idle collect differs, so each side pushes at the
	// other for ever. (iv) reddens.
	selfmask: [{
		file: 'js/sync.js',
		find: `		if (!state || !state.devices || typeof state.devices !== 'object') return plain;
		var src = state.devices, devs = {};
		Object.keys(src).forEach(function (k) {
			var line = src[k];
			if (!line || typeof line !== 'object') { devs[k] = line; return; }
			var copy = {};`,
		with: `		if (!state || !state.devices || typeof state.devices !== 'object') return plain;
		var self_ = '';
		try { if (DaimondCore.syncSelfDeviceId) self_ = String(DaimondCore.syncSelfDeviceId() || ''); } catch (e) { self_ = ''; }
		var src = state.devices, devs = {};
		Object.keys(src).forEach(function (k) {
			var line = src[k];
			if (!line || typeof line !== 'object' || k !== self_) { devs[k] = line; return; }
			var copy = {};`,
	}],
	// The drop waits for a PEER to name the same addresses, which is where it stood
	// until 2026-09-14 -- and no file manifest can ever have a peer slot, because
	// there is no peer mechanism for files. So a standing loss was carried in the
	// parcel for ever and `dropped_refs` was 0 on every round. (vi) reddens.
	nodrop: [{
		file: 'js/daimond.js',
		find: '			if (rounds > 1) {',
		with: '			if (rounds > 1 && false) {		// the peer-named gate, which a file could never satisfy',
	}],
	// A file manifest whose file is in the mounted folder is classed `reoffload`
	// and forgotten, on a device whose `collectFiles` returns nothing -- so it is
	// named by nobody and never uploaded again. (vi) reddens on the drain.
	forgetfiles: [{
		file: 'js/daimond.js',
		find: "				reason = (f && canReoffloadFiles) ? 'reoffload' : (f ? 'no-file-sync' : 'no-local-file');",
		with: "				reason = f ? 'reoffload' : 'no-local-file';",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
if (BREAK && BROWSER !== 'chromium') {
	console.error(`--break serves an edited file through page.route, which does not fire under `
		+ `${BROWSER}: the run would exercise the unbroken app and report that the defect is `
		+ `absent. Run the breaks under Chromium; the ordinary run routes nothing and works on `
		+ `both engines.`);
	process.exit(2);
}

// ── Seams: the fixes must be present, or a green run would prove nothing ──

const SEAM = [
	{ file: 'js/cloud.js', want: '[0-9a-f]{32}',
	  why: 'PEER_RE does not admit a 32-hex device id, so no peer slot is recognised' },
	{ file: 'js/daimond.js', want: 'canReoffloadFiles',
	  why: 'a folder-mounted device still promises to re-offload files it cannot' },
	{ file: 'js/daimond.js', want: 'if (rounds > 1) {',
	  why: 'an unrestorable manifest is never dropped, so refs_missing can never reach 0' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length && !BREAK) {
		console.error('the sync fixes are not in this tree, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}
requireSeams();

// ── A BREAK IS SERVED, AND ONLY CHROMIUM CAN BE SERVED ──────────────────
//
// The edited file goes to the page through `page.route`, which is the mechanism
// every other verifier here uses -- and which does NOT fire under
// Playwright-WebKit. So a `--break` run is refused under WebKit rather than
// quietly running the unedited app and reporting that the defect is not there.
// Nothing in the ORDINARY run routes anything, which is why that run works on
// both engines.

function edit(src, spec, what) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`${what}: the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const PATCHED = new Map();
if (BREAK) {
	for (const spec of BREAKS[BREAK]) {
		const src = PATCHED.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		PATCHED.set(spec.file, edit(src, spec, `break '${BREAK}'`));
	}
}

// ═══════════════════════════════════════════════════════════════════════
// THE CLOUD, in this process, shared by both contexts.
// ═══════════════════════════════════════════════════════════════════════

const cloud = {
	mailbox: null,				// { version, blob, device }
	chunks:  new Map(),			// addr -> b64url ciphertext
	live:    new Set(),			// what the last commit declared
	pushes:  [],				// { dev, version }
	commits: [],				// { dev, live, swept }
	puts:    [],				// { dev, n }
	gets:    0,
};

/// One request, answered the way the gateway answers it.
///
/// The sweep is the un-graced form: everything the committing index does not name
/// goes, whoever uploaded it and however recently. That is what the gateway did
/// on 2026-09-13 and what it still does outside the fifteen-minute grace.
function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};

	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version,
				blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) {
			return { status: 409, json: { ok: false, version: cur } };
		}
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		cloud.pushes.push({ dev, version: cur + 1 });
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}

	if (p === '/api/chunk') {
		if (body.op === 'put') {
			(body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob));
			cloud.puts.push({ dev, n: (body.chunks || []).length });
			return { status: 200, json: { ok: true } };
		}
		if (body.op === 'have') {
			return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		}
		if (body.op === 'get') {
			cloud.gets++;
			const blob = cloud.chunks.get(body.addr);
			return { status: 200, json: blob ? { present: true, blob } : { present: false } };
		}
		if (body.op === 'commit') {
			const live = new Set((body.chunks || []).map(c => c.addr));
			let swept = 0;
			for (const a of [...cloud.chunks.keys()]) {
				if (!live.has(a)) { cloud.chunks.delete(a); swept++; }
			}
			cloud.live = live;
			cloud.commits.push({ dev, live: live.size, swept });
			return { status: 200, json: { ok: true, swept, free_allowance: 0, paid_bytes: 0 } };
		}
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}

// ═══════════════════════════════════════════════════════════════════════
// The two devices.
// ═══════════════════════════════════════════════════════════════════════

const PROFILE_A = scratch('pw', 'syncfp-a-' + BROWSER + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'syncfp-b-' + BROWSER + (BREAK ? '-' + BREAK : ''));
for (const d of [PROFILE_A, PROFILE_B]) fs.rmSync(d, { recursive: true, force: true });

/// Serve the break's edited file in place of the real one.
async function patchedSource(page) {
	if (!PATCHED.size) return;
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body }));
	}
}

/// Point a page's whole gateway at the cloud above, and tell it it is signed in.
///
/// `gwFetch` is the one door /api/sync and /api/chunk both leave by, and it is a
/// property on a global read at call time -- so replacing it IS the code path.
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.__lines = [];
		window.__ds = [];
		const realDebug = console.debug;
		console.debug = function (...a) { window.__lines.push(a.join(' ')); realDebug.apply(console, a); };
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const method = (opts && opts.method) || 'GET';
			const body   = (opts && opts.body) || '';
			const r = await window.__cloudCall(String(p), method, String(body));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}

/// Wait until the app's sync seams are on the page.
const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync
		&& window.DaimondSync && window.DaimondChunks && window.DaimondChunks.offloadBytes
		&& window.DaimondCloud && DaimondCloud.contentGet && window.DaimondGateway
		&& window.DaimondIdentity),
	null, { timeout: 20000 });

let A = null, B = null;

/// Whether this engine has an origin-private filesystem at all. Playwright's
/// Linux WebKit does not expose `navigator.storage`, so the workspace store the
/// wasm side keeps there is unavailable and a Diamond cannot even be created
/// (`src/wasm/opfs.rs:281` says so in as many words). Real iOS Safari has had
/// OPFS since 15.2, so this is a limit of the test engine and not of the product
/// -- which is exactly why what it costs is printed rather than skipped quietly.
let OPFS = false;
const skipped = [];

try {

console.log(`\n— two devices, one account, ${BROWSER}${BREAK ? ', break ' + BREAK : ''} —`);

A = await open({ name: 'syncfp-a', profile: PROFILE_A, signIn: false, connect: false,
	defaults: false, route: patchedSource });
await ready(A);
await signInAs(A, 'syncfp');
await ready(A);

// B ADOPTS A'S IDENTITY, which is what pairing does and the only way two profiles
// can read one mailbox: the key is derived from the passphrase and the SALT, and a
// second profile that merely typed the same passphrase would derive a different
// key and decrypt nothing (`exportBundle`, js/identity.js).
const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
B = await open({ name: 'syncfp-b', profile: PROFILE_B, signIn: false, connect: false,
	defaults: false, route: patchedSource });
await ready(B);
await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
await B.page.reload({ waitUntil: 'domcontentloaded' });
await ready(B);
await signInAs(B, 'syncfp');
await ready(B);

// THE TWO DEFAULT DIAMONDS GO. The app seeds them on a first boot, each device
// seeds its OWN pair, and this file counts what the pair holds and what is
// offloaded -- so four Diamonds nobody made would be four sources of churn in a
// measurement of churn.
if (await A.page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory))) {
	await clearDiamonds(A);
	await clearDiamonds(B);
	await ready(A);
	await ready(B);
}

const keys = {
	a: await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()),
	b: await B.page.evaluate(() => window.DaimondIdentity.publicKeyB64url()),
};
check('two contexts hold ONE account — the same key, so one mailbox opens for both',
	!!keys.a && keys.a === keys.b, keys.a === keys.b ? 'same key' : 'A≠B');

await wireCloud(A, 'A');
await wireCloud(B, 'B');

const devIds = {
	a: await A.page.evaluate(() => window.DaimondCore.syncSelfDeviceId()),
	b: await B.page.evaluate(() => window.DaimondCore.syncSelfDeviceId()),
};
check('and two DEVICE ids, 32 hex each — the width a peer slot is keyed by',
	devIds.a !== devIds.b && /^[0-9a-f]{32}$/.test(devIds.a) && /^[0-9a-f]{32}$/.test(devIds.b),
	`A ${devIds.a.slice(0, 12)}…, B ${devIds.b.slice(0, 12)}…`);

// ── A STOPS BEING A COMMITTER, which is the topology the fault needs ──
//
// The owner's desktops are FOLDER-MOUNTED: a real root is open, so `collectFiles`
// returns nothing, the chunk index cannot be merged, and `syncMayCommitChunks` is
// false (dev/verify_dataloss.mjs proves that refusal is correct). The recipe is
// the one that file established -- a directory handle out of OPFS, handed to the
// picker, granted the way a user grants it.
//
// AND PLAYWRIGHT'S WEBKIT HAS NO OPFS AT ALL. `navigator.storage` is undefined in
// the Linux WPE build -- not the API missing, the whole object -- while real iOS
// Safari has had it since 15.2. So on that engine the folder cannot be mounted,
// and A is stood down the other way the app itself names: with the tools absent
// (`offloadBlockedReason` -> `tools-missing`), which gives the same two
// properties this fixture needs -- an empty file census and a device that may not
// commit. What is NOT covered there is said in as many words at the end, rather
// than passing quietly.
OPFS = await A.page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory));
if (OPFS) {
	await A.page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const dir  = await root.getDirectoryHandle('mounted', { create: true });
		dir.queryPermission   = async () => 'granted';
		dir.requestPermission = async () => 'granted';
		window.showDirectoryPicker = async () => dir;
	});
	await A.page.evaluate(() => window.DaimondPanels && window.DaimondPanels.open && window.DaimondPanels.open('work'));
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => {
		const chips = [...document.querySelectorAll('.files-mode-chip')];
		const machine = chips.find(c => /machine/.test(c.className)
			|| c.querySelector('[data-icon="machine"]')) || chips[1];
		if (machine) machine.click();
	});
	await A.page.waitForTimeout(1500);
} else {
	skipped.push('the folder mount (A stands down as tools-missing instead)');
	await A.page.evaluate(() => { delete window.DaimondTools; });
}

const aMode = await A.page.evaluate(async (opfs) => {
	const mode = opfs ? (await import('/pkg/oxedyne_daimond.js')).workspace_mode() : 'n/a';
	return { mode, mayCommit: window.DaimondCore.syncMayCommitChunks(),
		why: window.DaimondCore.syncCommitBlockedReason() };
}, OPFS);
check('A commits NOTHING — the reported topology, one device declaring for both',
	aMode.mayCommit === false && (OPFS ? aMode.mode === 'folder' : aMode.why === 'tools-missing'),
	`mode=${aMode.mode} mayCommit=${aMode.mayCommit} why=${aMode.why}`);
const bMay = await B.page.evaluate(() => window.DaimondCore.syncMayCommitChunks());
check('B holds the sandbox and commits for the account',
	bMay === true, `mayCommit=${bMay}`);

// ── A seeds content large enough to offload ───────────────────────────

const CID = 'fixedpoint-chat';
if (!OPFS) skipped.push('the offloaded DIAMOND — this engine cannot create one at all');
const seeded = await A.page.evaluate(async ({ cid, opfs }) => {
	let did = '';
	if (opfs) {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		did = await app.create_diamond('Fixed-Point');
		let html = '<h1>Fixed Point</h1>';
		while (html.length < 220 * 1024) html += '<p>a paragraph at ' + html.length + ' of ordinary prose</p>';
		await app.write_crystal_page(did, html);
	}

	const store = window.DaimondCore.chatStore();
	const list = store.stored();
	const msgs = [];
	for (let i = 0; i < 380; i++) {
		msgs.push({ role: i % 2 ? 'assistant' : 'user',
			content: 'message ' + i + ' ' + 'w'.repeat(400), mid: 'fp' + i, ts: 1000 + i });
	}
	// NOW, not a fixture constant. Chats expire on their own, the harness pins the
	// window at ten years, and a stamp of 5000 is 1970 -- so a seeded chat with a
	// tidy little number in it is swept to the trash twenty seconds into the run
	// and the parcel carries nothing. It cost an afternoon to see that.
	list.push({ id: cid, name: 'Fixed Point', model: 'mock/fast', updatedAt: Date.now(),
		messages: msgs, session: null });
	store.save(list);
	return { did };
}, { cid: CID, opfs: OPFS });
note(`A seeded ${seeded.did ? 'Diamond ' + seeded.did.slice(0, 12) + '… and ' : ''}chat ${CID}`);

/// One device's push, awaited to the point where the engine has stopped.
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(450); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(450); };
const version = (s) => s.page.evaluate(() => window.DaimondSync.state().version | 0);

/// Everything the index names under a prefix, as addresses.
const addrsUnder = (s, prefix) => s.page.evaluate((pfx) => {
	const ix = window.DaimondCloud.index(), out = [];
	Object.keys(ix).forEach(k => {
		if (k.indexOf(pfx) !== 0) return;
		((ix[k] || {}).chunks || []).forEach(c => { if (c && c.addr) out.push(c.addr); });
	});
	return out;
}, prefix);

await push(A);
await pull(B);
await push(B);

// ── AND BOTH DEVICES HOLD THE SAME CHAT, WHICH IS THE WHOLE FIXTURE ──
//
// A device that had no copy of an arriving chat ADOPTS the sender's manifest
// (`adoptedAsOwn`, applyChats) -- one copy at one set of addresses, and nothing
// to protect. The reported account is the other case: both devices hold the
// conversation, so each computes a UNION, and a union is a third transcript that
// each seals for itself. Two sets of addresses for identical words, and the
// committing device names one of them. So B says something of its own first.
await B.page.evaluate(async (cid) => {
	const store = window.DaimondCore.chatStore();
	const list  = store.stored();
	const rec   = list.find(c => c.id === cid);
	const got   = await store.loadMessages(cid);
	const msgs  = (got.messages || []).slice();
	for (let i = 0; i < 20; i++) {
		msgs.push({ role: 'user', content: 'said on B ' + i + ' ' + 'z'.repeat(400),
			mid: 'onB' + i, ts: Date.now() + i });
	}
	rec.messages  = msgs;
	rec.updatedAt = Date.now();
	store.save(list);
}, CID);
await push(B);
await pull(A);					// A unions, and notes B's addresses
await push(A);
await pull(B);					// B unions, and notes A's
await push(B);
await pull(A);
await push(A);

const bHas = await B.page.evaluate(async ({ cid, opfs }) => {
	const store = window.DaimondCore.chatStore();
	const c = (store.stored() || []).find(x => x.id === cid) || null;
	let ds = [];
	if (opfs) {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		ds = JSON.parse(await app.list_diamonds());
	}
	return { chat: !!c, msgs: c ? ((c.messages || []).length || (c.msgCount | 0) || (c.chatMsgCount | 0)) : 0,
		diamonds: ds.length };
}, { cid: CID, opfs: OPFS });
check('B has the account\'s content — there is something for both devices to hold',
	bHas.chat === true && (!OPFS || bHas.diamonds > 0),
	`chat=${bHas.chat} msgs=${bHas.msgs}` + (OPFS ? ` diamonds=${bHas.diamonds}` : ''));

// ═══════════════════════════════════════════════════════════════════════
// (ii) THE SLOT — B names A's addresses, and the collect that commits keeps it
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— (ii) the committing index names the peer\'s slot —');

const slot = await B.page.evaluate(async (dev) => {
	await window.DaimondCore.collectSync();			// the collect that reaps, then commits
	const ix = window.DaimondCloud.index();
	const keys = Object.keys(ix).filter(k => k.indexOf('.peer.') > 0);
	const mine = keys.filter(k => k.slice(-32) === dev);
	return { keys, mine, owner: mine.length ? window.DaimondCloud.peerOwner(mine[0]) : null,
		addrs: mine.reduce((n, k) => n + ((ix[k].chunks || []).length), 0) };
}, devIds.a);
check('B\'s index holds `@c/<id>.peer.<A 32-hex>` AFTER collectSync() — the reap kept it',
	slot.mine.length > 0 && slot.owner === devIds.a,
	slot.mine.length ? slot.mine.map(k => k.slice(0, 26) + '…').join(', ')
		: `no peer slot (all keys: ${slot.keys.length})`);
check('and the slot names chunks — a slot with nothing in it declares nothing',
	slot.addrs > 0, `${slot.addrs} address(es)`);

// ═══════════════════════════════════════════════════════════════════════
// (i) A'S CHUNKS SURVIVE B'S COMMIT
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— (i) A\'s addresses survive B\'s commit —');

// A's OWN addresses, taken off its own manifests -- not a peer slot's, which are
// B's copies and would prove the opposite of what is wanted here.
const aAddrs = await A.page.evaluate(() => {
	const ix = window.DaimondCloud.index(), out = [];
	Object.keys(ix).forEach(k => {
		if (k.indexOf('.peer') > 0) return;
		if (k.indexOf('@c/') !== 0 && k.indexOf('@d/') !== 0) return;
		((ix[k] || {}).chunks || []).forEach(c => { if (c && c.addr) out.push(c.addr); });
	});
	return [...new Set(out)];
});
note(`A names ${aAddrs.length} content address(es) of its own`);

// B MAKES A CHANGE AND PUSHES, which is the only way a commit happens: a push
// with nothing to send takes the idle pull instead and declares nothing. The
// change is B's own new Diamond, so A's manifests are untouched and what the
// commit does to them is the whole of what is measured.
const commitsBefore = cloud.commits.length;
await B.page.evaluate(async (opfs) => {
	if (opfs) {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.create_diamond('B-Own');
		return;
	}
	// No workspace store on this engine: B's own change is a chat of its own,
	// which reaches the same push and the same commit.
	const store = window.DaimondCore.chatStore();
	const list  = store.stored();
	list.push({ id: 'b-own-chat', name: 'B Own', model: 'mock/fast', updatedAt: Date.now(),
		messages: [{ role: 'user', content: 'a line of B\'s own', mid: 'bown0', ts: Date.now() }],
		session: null });
	store.save(list);
}, OPFS);
await push(B);								// B commits, and the gateway sweeps
const committed = cloud.commits.length - commitsBefore;

const presence = await A.page.evaluate(async (addrs) => {
	const r = await window.DaimondChunks.presence(addrs);
	return { ok: r.ok, missing: r.missing.length };
}, aAddrs);
check('after B\'s commit NOT ONE of A\'s addresses is missing — the sweep left them',
	aAddrs.length > 0 && presence.ok === true && presence.missing === 0,
	`${presence.missing} of ${aAddrs.length} missing, ${committed} commit(s), `
	+ `last swept ${(cloud.commits[cloud.commits.length - 1] || {}).swept}`);

// ═══════════════════════════════════════════════════════════════════════
// (iii) THE PARCEL IS A FIXED POINT ON BOTH SIDES
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— (iii) two idle collects, byte-identical —');

for (const [label, s] of [['A', A], ['B', B]]) {
	const same = await s.page.evaluate(async () => {
		const one = JSON.stringify(await window.DaimondCore.collectSync());
		const two = JSON.stringify(await window.DaimondCore.collectSync());
		if (one === two) return { same: true, moved: [] };
		const a = JSON.parse(one), b = JSON.parse(two);
		const moved = [...new Set([...Object.keys(a), ...Object.keys(b)])]
			.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
		return { same: false, moved };
	});
	check(`${label}: the parcel stringifies identically on two idle collects`,
		same.same === true, same.same ? '' : 'moved: ' + same.moved.join(', '));
}

// ═══════════════════════════════════════════════════════════════════════
// (iv) THE VERSION STAYS FLAT
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— (iv) ten simulated minutes, then a real quiet window —');

/// Settle both sides: push and pull until the mailbox stops moving, bounded.
async function settle(rounds) {
	for (let i = 0; i < rounds; i++) {
		await pull(A); await push(A);
		await pull(B); await push(B);
	}
}
await settle(2);
const vAfterRounds = { a: await version(A), b: await version(B), mailbox: cloud.mailbox.version };
note(`after two settling rounds: A v${vAfterRounds.a}, B v${vAfterRounds.b}, mailbox v${vAfterRounds.mailbox}`);

/// Age every roster line by `ms`, which is exactly what the passage of time does
/// to the stamp `touchSelfDevice` refreshes every SEEN_REFRESH_MS. The parcel
/// then differs from the one last sent -- on this device's own line AND on the
/// peer's, which is the half the mask used to leave out.
const ageRoster = (s, ms) => s.page.evaluate((ms) => {
	const raw = localStorage.getItem('daimond-devices');
	if (!raw) return 0;
	const r = JSON.parse(raw);
	let n = 0;
	Object.keys(r).forEach(k => {
		if (r[k] && typeof r[k].seen === 'number') { r[k].seen -= ms; n++; }
	});
	localStorage.setItem('daimond-devices', JSON.stringify(r));
	return n;
}, ms);

const before = cloud.pushes.length;
const FIVE_MIN = 5 * 60 * 1000;
for (let tick = 0; tick < 2; tick++) {			// ten minutes, five at a time
	await ageRoster(A, FIVE_MIN);
	await ageRoster(B, FIVE_MIN);
	await push(A);
	await pull(B); await push(B);
	await pull(A); await push(A);
}
const simPushes = cloud.pushes.length - before;
check('ten SIMULATED minutes of the seen-refresh move the version NOT AT ALL',
	simPushes === 0 && (await version(A)) === vAfterRounds.a && (await version(B)) === vAfterRounds.b,
	`${simPushes} push(es), A v${await version(A)}, B v${await version(B)}`);

const quietFrom = cloud.pushes.length;
const samples = [];
const every = Math.max(10, Math.round(QUIET_SECS / 6));
for (let t = 0; t < QUIET_SECS; t += every) {
	await A.page.waitForTimeout(every * 1000);
	samples.push(cloud.mailbox.version);
}
const flat = samples.every(v => v === vAfterRounds.mailbox);
check(`and a REAL quiet window of ${QUIET_SECS}s leaves it flat — nothing on a timer moves it`,
	flat && cloud.pushes.length === quietFrom,
	`versions ${[...new Set(samples)].join(',')} over ${samples.length} samples, `
	+ `${cloud.pushes.length - quietFrom} push(es)`);

// ═══════════════════════════════════════════════════════════════════════
// (v) NOTHING MISSING, NOTHING RE-OFFLOADED
// ═══════════════════════════════════════════════════════════════════════
console.log('\n— (v) refs_missing 0, and no upload after round 2 —');

for (const [label, s] of [['A', A], ['B', B]]) {
	const seen = await s.page.evaluate(async () => {
		window.__lines = []; window.__ds = [];
		await window.DaimondCore.collectSync();
		const miss = window.__ds.filter(e => e.payload && e.payload.refs_missing !== undefined)
			.map(e => e.payload.refs_missing);
		return { miss, offloaded: window.__lines.filter(l => l.indexOf('offloaded ') >= 0) };
	});
	// ASKED OF THE STORE AS WELL AS OF THE FEED. `verifyManifestPresence` says
	// nothing at all when nothing is stale, so a run where every manifest had been
	// swept and a run where none had would both show an empty feed. The presence
	// query is the fact; the feed line is what the owner would have read.
	const held = await s.page.evaluate(async () => {
		const ix = window.DaimondCloud.index(), addrs = [];
		Object.keys(ix).forEach(k => ((ix[k] || {}).chunks || [])
			.forEach(c => { if (c && c.addr) addrs.push(c.addr); }));
		if (!addrs.length) return { addrs: 0, missing: 0, ok: true };
		const r = await window.DaimondChunks.presence([...new Set(addrs)]);
		return { addrs: new Set(addrs).size, missing: r.missing.length, ok: r.ok };
	});
	check(`${label}: every address its index names is still held — refs_missing 0`,
		held.ok === true && held.missing === 0 && seen.miss.every(n => n === 0),
		`${held.missing} of ${held.addrs} missing`
		+ (seen.miss.length ? ', feed refs_missing ' + seen.miss.join(',') : ''));
	check(`${label}: and NOTHING is offloaded again — the same bytes are not re-uploaded`,
		seen.offloaded.length === 0,
		seen.offloaded.slice(0, 2).join(' | ') || '0 lines');
}

const putsAfter = cloud.puts.length;
await settle(1);
check('a further round uploads nothing at all — the pair is at rest',
	cloud.puts.length === putsAfter,
	`${cloud.puts.length - putsAfter} put batch(es)`);

// ═══════════════════════════════════════════════════════════════════════
// (vi) A DEVICE THAT CANNOT RE-OFFLOAD A FILE DOES NOT PROMISE TO
// ═══════════════════════════════════════════════════════════════════════
//
// `verifyManifestPresence` asks the gateway whether the chunks a reused manifest
// names are still held, and a file manifest whose file is still ON DISK was
// classed `reoffload` and FORGOTTEN -- on the reasoning that the next collect
// will upload it again. On a folder-mounted device it will not: `collectFiles`
// returns nothing at all there, so the manifest went and the upload never came,
// and the file was named by nobody. 417 of them drained off the owner's desktop
// in one round on 2026-09-13, the index falling from 264 KB to 160 KB.
//
// `fileAt` reads the OPFS SANDBOX whatever mode the workspace is in, which is
// why the two can disagree at all: the file really is there, and this device
// really cannot send it.
console.log('\n— (vi) a file manifest a folder-mounted device cannot heal —');

if (!OPFS) {
	skipped.push('(vi), which needs an OPFS file for `fileAt` to find');
	console.log('        · not on this engine: there is no OPFS to hold the file');
} else {

const FPATH = 'notes/standing.md';
const filed = await A.page.evaluate(async (path) => {
	let body = '# standing\n';
	while (body.length < 200 * 1024) body += 'a line of the file at ' + body.length + '\n';
	await window.DaimondCloud.writeText(path, body);
	const mani = await window.DaimondChunks.offloadFile
		? await window.DaimondChunks.offloadFile(path, new Blob([new TextEncoder().encode(body)]))
		: await window.DaimondChunks.offloadBytes(path, new TextEncoder().encode(body));
	await window.DaimondCloud.put(path, mani, mani.key);
	const f = await window.DaimondCloud.fileAt(path);
	return { addrs: (mani.chunks || []).map(c => c.addr), onDisk: !!f,
		syncable: (await window.DaimondCore.collectSync()).filesComplete };
}, FPATH);
check('A holds a file manifest for a file that is really on disk, and cannot send the file',
	filed.addrs.length > 0 && filed.onDisk === true && filed.syncable === false,
	`${filed.addrs.length} chunk(s), on disk ${filed.onDisk}, census complete ${filed.syncable}`);

// The chunks go, which is what another device's commit does to them.
for (const a of filed.addrs) cloud.chunks.delete(a);

const first = await A.page.evaluate(async (path) => {
	window.__ds = [];
	await window.DaimondCore.collectSync();
	const ev = (window.__ds.find(e => e.payload && e.payload.refs_missing) || { payload: {} }).payload;
	return { held: !!window.DaimondCloud.index()[path], missing: ev.refs_missing | 0,
		dropped: ev.dropped_refs | 0, kinds: ev.miss_kinds || null };
}, FPATH);
check('(vi) the FIRST sighting keeps the manifest — one sweep is not a verdict',
	first.held === true && first.missing > 0,
	`held=${first.held} refs_missing=${first.missing} dropped_refs=${first.dropped}`);

const putsBeforeHeal = cloud.puts.length;
const second = await A.page.evaluate(async (path) => {
	window.__ds = [];
	await window.DaimondCore.collectSync();
	const ev = (window.__ds.find(e => e.payload && e.payload.refs_missing !== undefined) || { payload: {} }).payload;
	return { held: !!window.DaimondCloud.index()[path], dropped: ev.dropped_refs | 0 };
}, FPATH);
check('(vi) the SECOND drops it, and says so — the parcel stops carrying dead addresses',
	second.held === false && second.dropped > 0,
	`held=${second.held} dropped_refs=${second.dropped}`);
check('(vi) and nothing was uploaded in between — the "re-offload" it used to promise',
	cloud.puts.length === putsBeforeHeal, `${cloud.puts.length - putsBeforeHeal} put batch(es)`);

}

} catch (e) {
	console.log('  FAIL the run itself — ' + (e && e.message ? e.message : e));
	bad.push('the run itself');
} finally {
	if (A) await A.close().catch(() => {});
	if (B) await B.close().catch(() => {});
}

// WHAT THIS RUN COULD NOT LOOK AT, on the line that reports the count -- a skip
// nobody reads is a skip nobody knows about.
for (const s_ of skipped) console.log('  --   not covered on ' + BROWSER + ': ' + s_);
console.log(`\n${ok.length} ok, ${bad.length} failed`
	+ (skipped.length ? `, ${skipped.length} not covered on ${BROWSER}` : ''));
if (bad.length) process.exit(1);
