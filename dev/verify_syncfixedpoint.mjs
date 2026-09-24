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
//   (vii) AND TWO MOUNTED DEVICES SHARING ONE FOLDER SETTLE. Since 2026-09-14 a device
//         with a real folder open sends what the user FLAGGED for sharing on a Diamond
//         -- a mark is the daimon's read grant, and the copy grant is its own flag on
//         the attachment -- and the owner has TWO such devices, kept identical by
//         Syncthing and therefore holding one file at two modification times.
//         Anything time-keyed in what travels makes their parcels
//         permanently different, and two devices that permanently differ push at each
//         other for ever. Two rounds, then the same ten simulated minutes, and nobody
//         pushes. `dev/verify_foldershare.mjs` is the rest of that feature.
//   (viii) AND A FILE HELD BY TWO DEVICES IS NAMED BY WHICHEVER COMMITS. Two devices
//         holding one file at identical bytes hold it at DIFFERENT ADDRESSES: an
//         address is the hash of ciphertext and the seal takes a fresh IV, so each
//         upload lands somewhere of its own. The merge kept our manifest and dropped
//         theirs, `chunks.js`'s commit builds the live set out of this index alone, and
//         the gateway sweeps every chunk the committing index does not name. That is
//         the whole of the phone's 222-file loss of 2026-09-13: a folder-mounted
//         desktop lost its directory handle mid-turn, became a committer, offloaded
//         its own copy of every workspace file, and its first commit swept the phone's
//         611 chunks. A file has a `.peer.<device>` slot of its own now, as a chat and
//         a Diamond already did.
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
//   node dev/verify_syncfixedpoint.mjs --break timekeyed
//   node dev/verify_syncfixedpoint.mjs --break nopeerfile
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, clearDiamonds, BROWSER, markHere } from './harness.mjs';

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
	// The shared folder's manifest carries the modification time again, which two
	// desktops kept identical by Syncthing disagree about while agreeing about every
	// byte. (vii) reddens: the parcels differ for ever and the pair never settles.
	timekeyed: [{
		file: 'js/cloud.js',
		find: '			mtime:  o.timeless ? 0 : (f ? f.lastModified : 0),',
		with: '			mtime:  f ? f.lastModified : 0,',
	}],
	// A file's peer slot is never written, so the merge keeps our manifest, drops
	// theirs, and the next commit sweeps the other device's copy of the same bytes.
	// (viii) reddens on the sweep.
	nopeerfile: [{
		file: 'js/cloud.js',
		find: '		unadopted.forEach(function (e) { notePeerFile(out, e[0], e[1], e[2], fromDev, selfDev); });',
		with: '		if (0) unadopted.forEach(function (e) { notePeerFile(out, e[0], e[1], e[2], fromDev, selfDev); });',
	}],
	// A file manifest whose file is in the mounted folder is classed `reoffload`
	// and forgotten, on a device whose `collectFiles` returns nothing -- so it is
	// named by nobody and never uploaded again. (vi) reddens on the drain.
	forgetfiles: [{
		file: 'js/daimond.js',
		find: "				reason = (f && canReoffloadFiles) ? 'reoffload' : (f ? 'no-file-sync' : 'no-local-file');",
		with: "				reason = f ? 'reoffload' : 'no-local-file';",
	}],
	// A version already fully merged is re-applied anyway, which is where `pullOnce`
	// stood until 2026-09-14: every idle catch-up pull pays for a full files-section
	// merge -- a folder walk on a folder-mounted desktop -- to learn nothing changed.
	// The (iii, cont.) cell reddens on A's `file_list` count, not the trail line --
	// `section('files', ...)` logs its start unconditionally, so a version already
	// adopted and a version genuinely re-applied both leave exactly one such line.
	reapplyadopted: [{
		file: 'js/sync.js',
		find: `		if (j.version === serverVersion && noted === serverVersion && pulledOk && reapplyTries === 0) {
			// ONE TRAIL LINE STANDS IN FOR THE SECTION THIS PULL DID NOT RUN. Skipping
			// \`applyParcel\` outright means \`applySync\`'s own \`section('files', …)\` never
			// fires, and a trail that goes silent here is exactly the failure mode its own
			// comment warns against -- a merge nobody can tell was ever looked at. This
			// names the version and says why, in the same 'sync files' slot the walk would
			// have logged into, but without the walk.
			trail('sync files', 'v' + (j.version | 0) + ' already adopted, no walk');
			lastFailed = [];
		} else {
			lastFailed = await applyParcel(state);
		}`,
		with: `		lastFailed = await applyParcel(state);		// BROKEN: always re-applies, even when nothing changed`,
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
	{ file: 'js/daimond.js', want: 'SYNC_FOLDER_SHARE_MAX',
	  why: 'a folder-mounted device shares nothing, so (vii) would measure two empty censuses' },
	{ file: 'js/daimond.js', want: 'if (!a.share) return;',
	  why: 'a mark shares the folder again, so (vii) would pass without the flag it now needs' },
	{ file: 'js/cloud.js', want: 'o.timeless ? 0 :',
	  why: 'a shared folder\'s manifest still carries a clock, which is what (vii) is about' },
	{ file: 'js/cloud.js', want: 'function notePeerFile',
	  why: 'a file has no peer slot, so (viii) would measure a sweep nothing could stop' },
	{ file: 'js/sync.js', want: "already adopted, no walk",
	  why: 'a version already fully merged is re-applied anyway, so (iii, cont.) would measure a walk every idle pull' },
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
// (iii, cont.) A PUSH WITH NOTHING NEW DOES NOT RE-WALK THE FILES SECTION
// ═══════════════════════════════════════════════════════════════════════
// The version this device is about to push is already the version it last fully
// merged, so `push`'s own idle-catch-up pull (nothing to SEND, but still worth a
// LOOK) must not re-apply what it reads back -- every section's merge is
// idempotent, so re-running it changes nothing, but the files section pays for a
// folder walk to find that out, and that walk is the whole cost of a round on a
// folder-mounted desktop. `IDLE_PULL_MIN_MS` gates whether `push` even attempts
// the look, so the wait below is not padding -- without it `push` would skip the
// pull outright and the assertion below would pass for the wrong reason.
console.log('\n— (iii) a push with nothing new does not re-apply —');

// BOTH SIDES FULLY CONVERGED FIRST. Without this, A's own idle-catch-up pull can
// legitimately meet a version it has never seen -- B pushed since A last pulled --
// and applying THAT is correct, not the defect: the guard below is for a version
// this device has already fully merged, and only two full rounds guarantee that.
for (let i = 0; i < 2; i++) { await pull(A); await push(A); await pull(B); await push(B); }

// `section('files', ...)` logs ITS OWN START unconditionally -- the trail always
// carries one 'sync files' line whether or not anything inside it ran, so a count
// of THAT line cannot tell a skip from a full re-apply. `file_list` calls can: A is
// the folder-mounted desktop from guard (vii) above, and re-applying is precisely
// the walk this lane exists to stop paying for on an unchanged version. B has no
// folder and is carried alongside for the settle-quiet half only -- a sandboxed
// device's own `file_list` traffic (fonts, the typeset view) is not this guard's
// business, and asserting zero on it would be measuring the wrong thing.
for (const [label, s] of [['A', A], ['B', B]]) {
	await s.page.evaluate(() => { try { window.DaimondTrail.clear(); } catch (e) {} });
	await new Promise((r) => setTimeout(r, 5500));		// past IDLE_PULL_MIN_MS
	const res = await s.page.evaluate(async () => {
		const mod  = await import('/pkg/oxedyne_daimond.js');
		const orig = mod.DaimondApp.prototype.run_tool_outcome;
		let calls  = 0;
		mod.DaimondApp.prototype.run_tool_outcome = function (name, argsJson) {
			if (name === 'file_list') calls++;
			return orig.call(this, name, argsJson);
		};
		window.DaimondSync.push();
		const t0 = Date.now();
		let quiet = false;
		try {
			while (Date.now() - t0 < 10000) {
				quiet = window.DaimondSync.state().quiet === true;
				if (quiet) break;
				await new Promise((r) => setTimeout(r, 200));
			}
		} finally { mod.DaimondApp.prototype.run_tool_outcome = orig; }
		return { quiet: quiet, calls: calls };
	});
	check(`${label}: a push with nothing new settles quiet within 10s`,
		res.quiet === true, `quiet=${res.quiet}`);
	if (label === 'A') {
		check(`${label}: and the files section does not walk the folder — no re-apply of a version already adopted`,
			res.calls === 0, `${res.calls} 'file_list' call(s) since the push`);
	} else {
		note(`${label}: ${res.calls} 'file_list' call(s) since the push — sandboxed, not this guard's concern`);
	}
	const filesLines = await s.page.evaluate(
		() => (window.DaimondTrail.rows() || []).filter((r) => r.w === 'sync files').length);
	note(`${label}: ${filesLines} 'sync files' trail line(s) since the push — the section always logs its start`);
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

// ═══════════════════════════════════════════════════════════════════════
// (vii) TWO MOUNTED DESKTOPS AND A PHONE
// ═══════════════════════════════════════════════════════════════════════
//
// The owner's fleet, exactly: argonaut and gilgamesh both hold the book in a real folder
// and Syncthing keeps them byte-identical, which leaves the two files with DIFFERENT
// modification times. A manifest carrying one of those times differs between two devices
// that agree about every byte, and `push` skips the wire only when the parcel matches
// what this device last sent -- so each side always has news, and the pair pushes at each
// other for ever at the debounce. What travels is therefore keyed on content
// (`put(..., { timeless: true })`, js/cloud.js) and the modification time stays on the
// device that observed it.
console.log('\n— (vii) two desktops sharing one folder, and the phone —');

if (!OPFS) {
	skipped.push('(vii), which needs two folder mounts and an OPFS to mount');
	console.log('        · not on this engine: there is no OPFS to mount as a folder');
} else {

const SCOPE = 'book';
// Two files over `SYNC_FILE_MAX` so they offload and there are manifests to compare, and
// two under it so there is an inline section to compare byte for byte.
const SEED = [
	['book/chap_one.typ', '= One\n' + 'a line of the chapter\n'.repeat(400)],
	['book/chap_two.typ', '= Two\n' + 'another line entirely\n'.repeat(500)],
	['book/assets/big_a.dat', 'A'.repeat(300 * 1024)],
	['book/assets/big_b.dat', 'B'.repeat(180 * 1024)],
];

/// Mount an OPFS subdirectory as the real folder, by the panel's own chip.
async function mountFolder(s) {
	await s.page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const dir  = await root.getDirectoryHandle('mounted', { create: true });
		dir.queryPermission   = async () => 'granted';
		dir.requestPermission = async () => 'granted';
		window.showDirectoryPicker = async () => dir;
	});
	await s.page.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work'));
	await s.page.waitForTimeout(700);
	await s.page.evaluate(() => {
		const chips = [...document.querySelectorAll('.files-mode-chip')];
		const machine = chips.find(c => /machine/.test(c.className)
			|| c.querySelector('[data-icon="machine"]')) || chips[1];
		if (machine) machine.click();
	});
	await s.page.waitForTimeout(1500);
}

/// Write the seed into whatever folder this device has open.
const seedFolder = (s) => s.page.evaluate(async (files) => {
	const root = window.DaimondFiles.folder();
	for (const [p, text] of files) {
		const segs = p.split('/');
		let d = root;
		for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i], { create: true });
		const fh = await d.getFileHandle(segs[segs.length - 1], { create: true });
		const w = await fh.createWritable();
		await w.write(new TextEncoder().encode(text));
		await w.close();
	}
	const st = [];
	for (const [p] of files) {
		const segs = p.split('/');
		let d = root;
		for (let i = 0; i < segs.length - 1; i++) d = await d.getDirectoryHandle(segs[i]);
		const f = await (await d.getFileHandle(segs[segs.length - 1])).getFile();
		st.push({ p, size: f.size, mtime: f.lastModified });
	}
	return st;
}, files_(SEED));
function files_(x) { return x; }

// A1 IS THE DEVICE ALREADY MOUNTED. It has no Diamond holding the folder yet, which is
// why everything above it saw an empty census; a mark AND the flag beside it are what
// turn a folder into a share -- the mark alone is the daimon's grant to read it.
const A2 = await open({ name: 'syncfp-a2', profile: scratch('pw', 'syncfp-a2-' + BROWSER),
	signIn: false, connect: false, defaults: false, route: patchedSource });
await ready(A2);
await A2.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
await A2.page.reload({ waitUntil: 'domcontentloaded' });
await ready(A2);
await signInAs(A2, 'syncfp');
await ready(A2);
await clearDiamonds(A2);
await ready(A2);
await wireCloud(A2, 'A2');
await mountFolder(A2);

const st1 = await seedFolder(A);
// A DELIBERATE GAP, so the two copies are written at genuinely different times. This is
// what Syncthing leaves behind: identical bytes, and a modification time per machine.
await A.page.waitForTimeout(1200);
const st2 = await seedFolder(A2);
check('(vii) the two desktops hold identical bytes at DIFFERENT times — the Syncthing case',
	st1.length === st2.length
	&& st1.every((f, i) => f.size === st2[i].size)
	&& st1.some((f, i) => f.mtime !== st2[i].mtime),
	`sizes ${st1.map(f => f.size).join(',')}; times differ on `
	+ st1.filter((f, i) => f.mtime !== st2[i].mtime).length + ' of ' + st1.length);

// The mark and the flag, made once on A and carried to the other mounted device by the
// ordinary parcel: the Diamond travels, its links travel inside it -- the flag is a
// field on the link. THE MARK ITSELF DOES NOT (owner ruling, 2026-09-23): a machine
// reference now names the device it was made on, so A2 receives A's mark inactive --
// exactly the state a mark synced from another desktop is in everywhere else -- and
// brings it into force with the same one-press confirm the notice above the composer
// offers. Only then do both devices compute the same shared roots.
const book = await A.page.evaluate(async (scope) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const id = await app.create_diamond('The Book');
	const ref = window.DaimondAttach.ref('dir', scope);
	const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');
	await window.DaimondCore.loadDiamonds();
	return { id, linkId, ref };
}, SCOPE);
const bookId = book.id;
// R2/O2: pressed AND ⇄'d here, on A -- the raw wasm `add_link` above does not
// auto-press the way the paperclip's own door does, and a confirmation never
// carries the share flag, so both writes are `markHere`'s.
await markHere(A, bookId, book.ref, { linkId: book.linkId, share: true });
await A.page.evaluate(() => window.DaimondCore.syncClearWalkCache());
await push(A); await pull(A2); await pull(B);
await A2.page.evaluate(() => window.DaimondCore.loadDiamonds());
const confirmedOnA2 = await A2.page.evaluate(
	({ id, scope }) => window.DaimondAttach.confirmHere(id, 'dir:' + scope),
	{ id: bookId, scope: SCOPE });
check('(vii) A2 confirms the mark A made, brought in by the ordinary parcel',
	confirmedOnA2 === true, String(confirmedOnA2));
// R2/O2: A2's OWN ⇄. The row already carries the flag -- confirming above never
// inherits it, since sharing does not travel and is its own press per device.
await markHere(A2, bookId, 'dir:' + SCOPE, { linkId: book.linkId, press: false, share: true });
await A2.page.evaluate(() => window.DaimondCore.syncClearWalkCache());

const shares = {
	a1: await A.page.evaluate(() => window.DaimondCore.syncFolderShare()),
	a2: await A2.page.evaluate(() => window.DaimondCore.syncFolderShare()),
};
check('(vii) both mounted devices share the same folder, from one flag neither was told about twice',
	shares.a1.folder && shares.a2.folder
	&& shares.a1.roots.join() === SCOPE && shares.a2.roots.join() === SCOPE
	&& shares.a1.bytes === shares.a2.bytes,
	`A1 ${shares.a1.files} files/${shares.a1.bytes} B, A2 ${shares.a2.files} files/${shares.a2.bytes} B`);

/// One full round over all three.
async function settle3(n) {
	for (let i = 0; i < n; i++) {
		await push(A);  await pull(A2); await pull(B);
		await push(A2); await pull(A);  await pull(B);
		await push(B);  await pull(A);  await pull(A2);
	}
}
// FOUR ROUNDS, NOT TWO, and the extra two are what the peer slots cost. A slot is
// derived from a PAIR of indices, so every device has to have seen every other before
// the set of them stops moving -- and a device whose chunks the committer swept before
// it had seen that device's index re-offloads under fresh addresses, which moves the
// slot again. Both settle; neither settles in one exchange. Two rounds left the mesh
// mid-convergence and the quiet window below then measured the tail of it as churn.
await settle3(4);

const sections = {
	a1: await A.page.evaluate(async () => {
		const c = await window.DaimondCore.collectSync();
		return { files: JSON.stringify(c.files), complete: c.filesComplete };
	}),
	a2: await A2.page.evaluate(async () => {
		const c = await window.DaimondCore.collectSync();
		return { files: JSON.stringify(c.files), complete: c.filesComplete };
	}),
};
check('(vii) the two desktops\' INLINE sections are byte-identical — content, not enumeration',
	sections.a1.files === sections.a2.files && sections.a1.files.length > 100
	&& sections.a1.complete === true && sections.a2.complete === true,
	sections.a1.files === sections.a2.files
		? `${sections.a1.files.length} bytes each`
		: `A1 ${sections.a1.files.length} B, A2 ${sections.a2.files.length} B`);

// AND THE MANIFESTS AGREE ABOUT THE CONTENT AND CARRY NO CLOCK. They cannot agree about
// their ADDRESSES: an address is the hash of ciphertext and the seal takes a fresh IV per
// device, so two devices sealing identical bytes land them in different places. That is
// by design and is what the `.peer` slot exists for; what must agree is the identity of
// the file, and what must be absent is any time at all.
// A SIDECAR IS NOT A MANIFEST. `<path>.peer.<device>` is another device's addresses
// for the same file and `<path>.synced` is the version a divergence preserved; neither
// has a content key, because neither is this device's record of a file's identity.
// Counting them here read the peer slots added on 2026-09-14 as two manifests that
// disagreed about their key.
const manis = async (s) => s.page.evaluate((scope) => {
	const ix = window.DaimondCloud.index(), out = {};
	Object.keys(ix).filter(k => k.indexOf(scope + '/') === 0)
		.filter(k => !ix[k].peer && !/\.synced$/.test(k)).sort().forEach(k => {
		out[k] = { key: ix[k].key, size: ix[k].size, bytes: ix[k].bytes,
			mtime: ix[k].mtime | 0, at: ix[k].at | 0 };
	});
	return out;
}, SCOPE);
const m1 = await manis(A), m2 = await manis(A2);
const paths1 = Object.keys(m1);
check('(vii) every shared manifest agrees on its content key, and carries no time at all',
	paths1.length > 0 && paths1.join() === Object.keys(m2).join()
	&& paths1.every(p => m1[p].key && m1[p].key === m2[p].key && m1[p].size === m2[p].size)
	&& paths1.every(p => !m1[p].mtime && !m1[p].at && !m2[p].mtime && !m2[p].at),
	`${paths1.length} manifest(s); `
	+ (paths1.filter(p => !m2[p] || m1[p].key !== m2[p].key).length || 'no') + ' key mismatch, '
	+ (paths1.filter(p => m1[p].mtime || m1[p].at || (m2[p] && (m2[p].mtime || m2[p].at))).length || 'no')
	+ ' stamped');

// AND NOBODY PUSHES. The same ten simulated minutes as (iv), over three devices.
const before3 = cloud.pushes.length;
for (let tick = 0; tick < 2; tick++) {
	await ageRoster(A, FIVE_MIN);
	await ageRoster(A2, FIVE_MIN);
	await ageRoster(B, FIVE_MIN);
	await push(A);  await pull(A2); await pull(B);
	await push(A2); await pull(A);  await pull(B);
	await push(B);  await pull(A);  await pull(A2);
}
check('(vii) ten SIMULATED minutes over two mounted desktops and a phone move NOTHING',
	cloud.pushes.length === before3,
	`${cloud.pushes.length - before3} push(es), mailbox v${cloud.mailbox.version}`);

await A2.close().catch(() => {});

}

// ═══════════════════════════════════════════════════════════════════════
// (viii) TWO COMMITTERS, ONE FILE, TWO SETS OF ADDRESSES
// ═══════════════════════════════════════════════════════════════════════
//
// A and B above are a folder-mounted desktop and a phone, which is the owner's
// topology and the one where only one device commits. This is the other one, and it
// is the one that cost 222 files: TWO devices that may both commit, holding one file
// at identical bytes. Identical bytes are not identical addresses -- an address is the
// hash of CIPHERTEXT and the seal takes a fresh IV per device -- so each device's
// index names a set of its own, the merge kept ours and dropped theirs, and the
// gateway sweeps every chunk the committing index does not name.
console.log('\n— (viii) two committers, one file, two sets of addresses —');

if (!OPFS) {
	skipped.push('(viii), which needs an OPFS to hold a workspace file in');
	console.log('        · not on this engine: there is no OPFS to write the file into');
} else {

const XP = 'w/x.txt';
// Past `SYNC_FILE_MAX` (128 kB), so it can only travel as a manifest.
const XT = '= x\n' + 'the same line, on both devices, byte for byte\n'.repeat(6500);

// CLEARED FIRST, as A and B are at the top of this file. A profile left by the last
// run holds that run's chunk index, and its peer slots are keyed by that run's device
// ids -- so this device opened with a slot for a device that no longer exists and the
// count below read two where one was written.
const PROFILE_C = scratch('pw', 'syncfp-c-' + BROWSER + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE_C, { recursive: true, force: true });
const C = await open({ name: 'syncfp-c', profile: PROFILE_C, signIn: false,
	connect: false, defaults: false, route: patchedSource });
await ready(C);
await C.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
await C.page.reload({ waitUntil: 'domcontentloaded' });
await ready(C);
await signInAs(C, 'syncfp');
await ready(C);
await clearDiamonds(C);
await ready(C);
await wireCloud(C, 'C');

const devC = await C.page.evaluate(() => window.DaimondCore.syncSelfDeviceId());
const mayBoth = {
	b: await B.page.evaluate(() => window.DaimondCore.syncMayCommitChunks()),
	c: await C.page.evaluate(() => window.DaimondCore.syncMayCommitChunks()),
};
check('(viii) both devices may commit the account\'s live set — the topology that swept it',
	mayBoth.b === true && mayBoth.c === true, `B ${mayBoth.b}, C ${mayBoth.c}`);

/// Write the file and offload it, WITHOUT pushing: each device uploads its own copy
/// under addresses of its own, which is the state the merge then has to reason about.
const seedX = (s) => s.page.evaluate(async (a) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool_outcome('file_write', JSON.stringify({ path: a.p, content: a.text }));
	await window.DaimondCore.collectSync();
	const m = window.DaimondCloud.index()[a.p] || null;
	return m ? { key: m.key, hash: m.hash, addrs: (m.chunks || []).map(c => c.addr).sort() } : null;
}, { p: XP, text: XT });
const mB = await seedX(B);
await B.page.waitForTimeout(400);
const mC = await seedX(C);
await C.page.waitForTimeout(400);
check('(viii) one file, the same content key on both devices, at DIFFERENT addresses',
	!!mB && !!mC && mB.key === mC.key && mB.addrs.length > 0
	&& mB.addrs.join() !== mC.addrs.join(),
	!mB || !mC ? 'one of them offloaded nothing'
		: `key ${String(mB.key).slice(0, 10)}…, ${mB.addrs.length} vs ${mC.addrs.length} addresses, `
		+ (mB.addrs.filter(a => mC.addrs.indexOf(a) >= 0).length || 'no') + ' in common');

// B PUSHES AND COMMITS FIRST, and C has never sent a parcel. Nothing of C's is
// declared, so this commit sweeps C's upload -- and no peer slot could have stopped
// it: a device cannot name addresses it has never been told about. It is taken first
// deliberately, because what is under test is the OTHER sweep, by a device that HAS
// seen the other's index. C notices on its next collect that its chunks are gone and
// re-offloads them, which is the pre-existing repair and is why the addresses below
// are read again rather than remembered from above.
await push(B);
await pull(C);
const sweptFirst = mC.addrs.filter(a => !cloud.chunks.has(a)).length;
check('(viii) a committer that has never seen the other device\'s index sweeps it — the state to repair',
	sweptFirst === mC.addrs.length, `${sweptFirst} of ${mC.addrs.length} of C's first upload swept`);
const slotOnC = await C.page.evaluate((a) => {
	const ix = window.DaimondCloud.index();
	const key = Object.keys(ix).filter(k => k.indexOf(a.p + '.peer.') === 0);
	return { keys: key, mine: (ix[a.p] && (ix[a.p].chunks || []).map(c => c.addr).sort()) || [],
		slot: key.length ? (ix[key[0]].chunks || []).map(c => c.addr).sort() : [],
		peer: key.length ? ix[key[0]].peer === true : false };
}, { p: XP });
check('(viii) C keeps its own manifest and opens a slot named for B — `<path>.peer.<32 hex>`',
	slotOnC.keys.length === 1 && /\.peer\.[0-9a-f]{32}$/.test(slotOnC.keys[0])
	&& slotOnC.keys[0] === XP + '.peer.' + devIds.b && slotOnC.peer === true,
	slotOnC.keys.join(', ') || 'no slot at all');
check('(viii) and the slot holds B\'s addresses, not C\'s',
	slotOnC.slot.length > 0 && slotOnC.slot.join() === mB.addrs.join()
	&& slotOnC.mine.join() === mC.addrs.join(),
	`${slotOnC.slot.length} address(es) in the slot, ${slotOnC.mine.length} of its own`);

// AND NOW C COMMITS. The live set it declares has to be the UNION, or the gateway
// sweeps B's copy of a file both devices are holding.
await push(C);
const addrsC = await C.page.evaluate((p) => {
	const m = window.DaimondCloud.index()[p] || {};
	return (m.chunks || []).map(c => c.addr).sort();
}, XP);
check('(viii) C re-offloaded what was swept, under addresses of its own',
	addrsC.length > 0 && addrsC.join() !== mB.addrs.join()
	&& addrsC.every(a => cloud.chunks.has(a)),
	`${addrsC.length} address(es), all held: ${addrsC.every(a => cloud.chunks.has(a))}`);
const afterC = await B.page.evaluate(async (a) => {
	const pr = await window.DaimondChunks.presence(a.addrs);
	return { missing: (pr && pr.missing) || [], held: !!window.DaimondCloud.index()[a.p] };
}, { addrs: mB.addrs, p: XP });
check('(viii) C\'s commit leaves every one of B\'s addresses in place — the 222-file loss, closed',
	afterC.missing.length === 0 && afterC.held === true,
	afterC.missing.length ? `${afterC.missing.length} of ${mB.addrs.length} swept` : 'all held');

// AND BACK THE OTHER WAY, because a scheme that works once in one direction is a
// coincidence: B pulls C's parcel, opens a slot for C, and its own commit spares C's.
await pull(B);
const slotOnB = await B.page.evaluate((a) => {
	const ix = window.DaimondCloud.index();
	return Object.keys(ix).filter(k => k.indexOf(a.p + '.peer.') === 0);
}, { p: XP });
check('(viii) and B opens one for C, and never one for itself',
	slotOnB.length === 1 && slotOnB[0] === XP + '.peer.' + devC,
	slotOnB.join(', ') || 'no slot');
await push(B);
const afterB = await C.page.evaluate(async (a) => {
	const pr = await window.DaimondChunks.presence(a.addrs);
	return (pr && pr.missing) || [];
}, { addrs: addrsC });
check('(viii) B\'s commit leaves every one of C\'s addresses in place — the sweep, closed',
	afterB.length === 0,
	afterB.length ? `${afterB.length} of ${addrsC.length} swept` : 'all held');

// AND THE FEED SAYS SO ON BOTH, which is the number the owner reads: a round where
// nothing is missing is a round where nothing has to be put back. Two full exchanges,
// because the first sweep above left C's old manifest naming addresses nothing holds
// and one round is what it takes to notice and repair that.
for (let r = 0; r < 2; r++) {
	await pull(C); await push(C); await pull(B); await push(B);
}
// ASKED OF THIS FILE, AND SAID RATHER THAN QUIETLY NARROWED. Every section of this
// verifier shares ONE mailbox and ONE chunk store, and B and C are the only devices
// in this one: their commits name what THEY hold, so the Diamond, the chat and the
// two desktops' book that sections (i) to (vii) offloaded from contexts now closed
// are swept here and stand missing for the rest of the run. That is this file's own
// arrangement rather than a property of anything, and a whole-index count reads it as
// a fault. What (viii) is about is one file held by two committers, so the question is
// put about that file: every address either device names FOR IT, on both of them.
const refs = {};
for (const [label, s_] of [['B', B], ['C', C]]) {
	refs[label] = await s_.page.evaluate(async (p) => {
		const ix = window.DaimondCloud.index();
		const keys = Object.keys(ix).filter(k => k === p || k.indexOf(p + '.') === 0);
		const addrs = [];
		keys.forEach(k => ((ix[k] || {}).chunks || []).forEach(c => { if (c && c.addr) addrs.push(c.addr); }));
		const r = addrs.length ? await window.DaimondChunks.presence([...new Set(addrs)]) : { missing: [] };
		return { keys: keys.length, addrs: new Set(addrs).size, missing: (r.missing || []).length };
	}, XP);
}
check('(viii) and after two more rounds every address either device names for that file is held',
	refs.B.missing === 0 && refs.C.missing === 0
	&& refs.B.addrs >= 4 && refs.C.addrs >= 4,
	`B ${refs.B.keys} key(s)/${refs.B.addrs} addresses, ${refs.B.missing} missing; `
	+ `C ${refs.C.keys} key(s)/${refs.C.addrs} addresses, ${refs.C.missing} missing`);

await C.close().catch(() => {});

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
