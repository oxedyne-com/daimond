// gateway: none
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
//   A — tools absent. Offloads its chats and Diamonds; commits nothing, and
//       its file census is empty, so it cannot put a file back either. It runs
//       the RANDOM-IV seal (see `oldSeal`): a device not yet upgraded.
//   B — the sandbox. Unions A's content, and commits the account's live set.
//
// Six properties, in the order they broke:
//
//   (i)   A'S CHUNKS SURVIVE B'S COMMIT. Two devices that compute the same union
//         land it at different addresses when one seals with a fresh IV (every
//         device before UNBLOCK-4, and any not yet reloaded since), so B's index
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
//   (vi), (vii) the folder-mounted device and two desktops sharing one folder: gone with the
//         browser Machine folder (G5, D-20261031-11).
//   (viii) AND A FILE HELD BY TWO DEVICES IS NAMED BY WHICHEVER COMMITS. Two devices
//         holding one file at identical bytes held it at DIFFERENT ADDRESSES: an
//         address is the hash of ciphertext and the seal took a fresh IV, so each
//         upload landed somewhere of its own. The convergent seal (UNBLOCK-4) ends
//         that for new uploads, but not for the copies already up there, so this
//         is driven by a random-IV device and then UPGRADED: its next offload must
//         land on the other device's addresses, and both slots must close. The merge kept our manifest and dropped
//         theirs, `chunks.js`'s commit builds the live set out of this index alone, and
//         the gateway sweeps every chunk the committing index does not name. That is
//         the whole of the phone's 222-file loss of 2026-09-13: a folder-mounted
//         desktop lost its directory handle mid-turn, became a committer, offloaded
//         its own copy of every workspace file, and its first commit swept the phone's
//         611 chunks. A file has a `.peer.<device>` slot of its own now, as a chat and
//         a Diamond already did.
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
//   node dev/verify_syncfixedpoint.mjs --break nopeerfile
//   node dev/verify_syncfixedpoint.mjs --break nofix      # (ix): collect drops `burst` from a rating
//   node dev/verify_syncfixedpoint.mjs --break novia      # (x): collect drops `via` from the records of a files_log and a file rating
//   node dev/verify_syncfixedpoint.mjs --break appfirst   # (xi): collect writes `app` as a user message's first key
import { readPage } from './pagesrc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, clearDiamonds, BROWSER } from './harness.mjs';
import { guardRan } from './verdict.mjs';

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
	// A file's peer slot is never written, so the merge keeps our manifest, drops
	// theirs, and the next commit sweeps the other device's copy of the same bytes.
	// (viii) reddens on the sweep.
	nopeerfile: [{
		file: 'js/cloud.js',
		find: '			if (!Object.prototype.hasOwnProperty.call(conflicts, e[0])) notePeerFile(out, e[0], e[1], e[2], fromDev, selfDev);',
		with: '			if (0) notePeerFile(out, e[0], e[1], e[2], fromDev, selfDev);',
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
	// The collect copies a rating without its `burst`, so the parcel carries a record that is not the one
	// the chat holds (U2 of the per-product rating, the sync proofs). A rating's bytes are its identity: a
	// drawn Rating tile is grouped by `burst`, and a record that left the device without it lands on the
	// other as a different record under the same `mid` (first copy wins, so the loss is permanent).
	// (ix) reddens.
	nofix: [{
		file: 'js/daimond.js',
		find: '				entryI.messages = gotI.messages || [];',
		with: `				entryI.messages = (gotI.messages || []).map(function (m) {		// BROKEN: collect drops burst
					if (!m || m.role !== 'rating_log' || !m.rating) return m;
					var r = {}; Object.keys(m.rating).forEach(function (k) { if (k !== 'burst') r[k] = m.rating[k]; });
					var o = {}; Object.keys(m).forEach(function (k) { o[k] = k === 'rating' ? r : m[k]; });
					return o;
				});`,
	}],
	// U3 (5.3.0, V2 of the U3+U4 plan): the collect copies a message's records without their `via`, so a `files_log` and a
	// file rating leave the device as v1 records, and the other device holds different bytes under the same `mid` (first
	// copy wins, so the loss stands). (x) reddens; (ix) does not, because the U2 fixture's records are v1 and have no `via`.
	novia: [{
		file: 'js/daimond.js',
		find: '				entryI.messages = gotI.messages || [];',
		with: `				entryI.messages = (gotI.messages || []).map(function (m) {		// BROKEN: collect drops via from every record
					if (!m) return m;
					var strip = function (p) { if (!p || typeof p !== 'object') return p; var q = {}; Object.keys(p).forEach(function (k) { if (k !== 'via') q[k] = p[k]; }); return q; };
					var o = {}; Object.keys(m).forEach(function (k) { o[k] = m[k]; });
					if (Array.isArray(m.prod)) o.prod = m.prod.map(strip);
					if (m.rating && m.rating.prod) { var r = {}; Object.keys(m.rating).forEach(function (k) { r[k] = k === 'prod' ? strip(m.rating.prod) : m.rating[k]; }); o.rating = r; }
					return o;
				});`,
	}],
	// U4 (5.3.0, V3c of the U3+U4 plan): the collect writes a preset's `app` mark as the first key of its message, where the
	// page set it last. The record means the same and a reader would never see the difference, but its bytes are not the
	// chat's, so first copy wins on `mid` and the other device holds a record that is not the sender's. A parcel that is
	// not the chat's own bytes is a parcel the push-skip cannot compare. (xi) reddens; (ix) and (x) do not, because their
	// fixtures hold no `app`.
	appfirst: [{
		file: 'js/daimond.js',
		find: '				entryI.messages = gotI.messages || [];',
		with: `				entryI.messages = (gotI.messages || []).map(function (m) {		// BROKEN: collect puts app first
					if (!m || m.app !== true) return m;
					var o = { app: true }; Object.keys(m).forEach(function (k) { if (k !== 'app') o[k] = m[k]; });
					return o;
				});`,
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
	{ file: 'js/cloud.js', want: 'function notePeerFile',
	  why: 'a file has no peer slot, so (viii) would measure a sweep nothing could stop' },
	{ file: 'js/sync.js', want: "already adopted, no walk",
	  why: 'a version already fully merged is re-applied anyway, so (iii, cont.) would measure a walk every idle pull' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = readPage(path.join(WWW, s.file), 'utf8');
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
		const src = PATCHED.get(spec.file) ?? readPage(path.join(WWW, spec.file), 'utf8');
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
		// The side doors on the same path (`?presence=1`, `?removed=1`, `?lease=1`) are not the mailbox:
		// answered as accepted and never written over the parcel. A beat on an empty mailbox otherwise
		// lands as a blobless v1 that no device can open, and none is whole again.
		if (method !== 'GET' && String(rawPath).indexOf('?') !== -1) return { status: 200, json: { ok: true } };
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
	await installCloud(s, dev);
}

/// The in-page half of `wireCloud`, again after a reload: an exposed function
/// survives a navigation, and the page's own globals do not.
async function installCloud(s, dev) {
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

// ── THE RANDOM-IV BUILD, ON ONE DEVICE ──────────────────────────────────
//
// Until UNBLOCK-4 (2026-10-15) every chunk was sealed under a fresh IV, so two
// devices holding identical bytes held them at two sets of addresses. The
// convergent seal (`wrapChunk`) ends that for new uploads, but every device in the
// field already holds random-IV copies and a map naming them, and a fleet part way
// through the upgrade has both kinds of device at once. Two current devices can no
// longer produce the divergent state that (i), (ii) and (viii) repair, so one
// device in each runs the old seal: its page's `wrapChunk` IS `wrapBytes`, as
// `www/js/sivchunk.test.mjs`'s B1 arm builds it. In the page, not a served edit,
// because `page.route` does not fire under WebKit.
const oldSeal = (s) => s.page.evaluate(() => {
	window.DaimondIdentity.wrapChunk = window.DaimondIdentity.wrapBytes;
});

/// Upgrade an old-seal device to this build. The map it wrote moves to the random-IV
/// build's key, which is what that build left on disk, and the page reloads into the
/// real seal: the new `chunks.js` must drop that map and offload again.
async function upgradeSeal(s, dev) {
	const had = await s.page.evaluate(() => {
		const m = localStorage.getItem('daimond-chunk-map-v2');
		if (m === null) return false;
		localStorage.removeItem('daimond-chunk-map-v2');
		localStorage.setItem('daimond-chunk-map', m);
		return true;
	});
	if (!had) throw new Error(`${dev} has no 'daimond-chunk-map-v2': chunks.js's map key moved, so the upgrade below would prove nothing`);
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(s);
	await signInAs(s, 'syncfp');
	await ready(s);
	await installCloud(s, dev);
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
await oldSeal(A);		// a desktop still on the random-IV build: see `oldSeal`

const devIds = {
	a: await A.page.evaluate(() => window.DaimondCore.syncSelfDeviceId()),
	b: await B.page.evaluate(() => window.DaimondCore.syncSelfDeviceId()),
};
check('and two DEVICE ids, 32 hex each — the width a peer slot is keyed by',
	devIds.a !== devIds.b && /^[0-9a-f]{32}$/.test(devIds.a) && /^[0-9a-f]{32}$/.test(devIds.b),
	`A ${devIds.a.slice(0, 12)}…, B ${devIds.b.slice(0, 12)}…`);

// ── A STOPS BEING A COMMITTER, which is the topology the fault needs ──
//
// A device that may not commit: with the tools absent (`offloadBlockedReason` ->
// `tools-missing`) its file census is empty and `syncMayCommitChunks` is false, the two
// properties this fixture needs (dev/verify_dataloss.mjs proves that refusal is correct).
// The owner's desktops once stood here folder-mounted; that mode went with G5
// (D-20261031-11). OPFS is still asked after, for (viii)'s workspace file.
OPFS = await A.page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory));
await A.page.evaluate(() => { delete window.DaimondTools; });

const aMode = await A.page.evaluate(async () => {
	return { mayCommit: window.DaimondCore.syncMayCommitChunks(),
		why: window.DaimondCore.syncCommitBlockedReason() };
});
check('A commits NOTHING — the reported topology, one device declaring for both',
	aMode.mayCommit === false && aMode.why === 'tools-missing',
	`mayCommit=${aMode.mayCommit} why=${aMode.why}`);
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
// the folder-mounted desktop, and re-applying is precisely
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

// (vi) and (vii), the folder-mounted device's manifests and two desktops sharing one folder,
// went with the browser Machine folder (G5, D-20261031-11).

// ═══════════════════════════════════════════════════════════════════════
// (viii) TWO COMMITTERS, ONE FILE, TWO SETS OF ADDRESSES
// ═══════════════════════════════════════════════════════════════════════
//
// A and B above are a folder-mounted desktop and a phone, which is the owner's
// topology and the one where only one device commits. This is the other one, and it
// is the one that cost 222 files: TWO devices that may both commit, holding one file
// at identical bytes. Identical bytes were not identical addresses -- an address is the
// hash of CIPHERTEXT and the seal took a fresh IV per device -- so each device's
// index named a set of its own, the merge kept ours and dropped theirs, and the
// gateway swept every chunk the committing index did not name. C is that device: it
// runs the random-IV seal (`oldSeal`) until the end of the section, where it is
// upgraded and must converge on B's addresses.
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
await oldSeal(C);

// C'S SIGN-IN ROUND FINISHES BEFORE ANYTHING IS SEEDED. Wired in, C completes its unlock
// against this cloud, and three things in that nudge sync: the models store opening, the
// `daimond:authed` round (`onAuthed`: a pull, then `schedule()`), and the pulled rail's
// `bumpDiamonds`. Together they arm one push on the 2.5 s debounce, and no step of this
// file sends it. Left armed, it fires wherever the steps below have reached. On a quiet
// machine that was about half a second after the scripted push(C), where it did nothing.
// On a loaded one it lands inside the sequence. Between pull(C) and the slot read, its
// collect re-offloads C's swept copy, so C's own addresses are no longer the ones seeded.
// Before push(B), its commit sweeps B's upload before B has declared it: the
// upload-vs-commit race, which this cloud leaves ungraced on purpose. Both read as a
// sweep of a seen index and neither is one (2026-09-25: red only under load, and red
// every time the slot read is held back 1.5 s). So this waits for C's
// first pull and then for `quiet`, which is also the premise verify_sync's second device
// states: a device with a round armed is not yet the device the section is about.
for (const [label, s_] of [['B', B], ['C', C]]) {
	const settled = await s_.page.waitForFunction(() => {
		const st = window.DaimondSync.state();
		return (st.version | 0) > 0 && st.quiet;
	}, null, { timeout: 30000 }).then(() => true, () => false);
	if (!settled) {
		const why = await s_.page.evaluate(() => window.DaimondSync.state().busyWith || 'no pull landed');
		throw new Error(`${label} never went quiet before (viii) was seeded: ${why}`);
	}
}

// TWO COMMITTERS, BY PREMISE. Since COMMIT-MERGED (2026-09-27) a device commits only an index known to
// be the account's whole one at the version it stands at (daimond.js "A commit declares only an index
// merged in full"). This account has two folder desktops beside the phone, and their parcels are never
// whole, so neither B nor the new C can be known whole: that is the gate's own corner
// (specs/daimond_fixbrief_r53_commitmerged_20260927.md, decision 1; QCMG's two-desktop fleet), and
// the gate holding here is its subject, not this section's. This section is about what two devices
// that DO commit do with one file at two sets of addresses, so both are stated whole where they stand,
// which is the topology the rule before COMMIT-MERGED gave every sandbox device.
for (const s_ of [B, C]) {
	await s_.page.evaluate(() => window.DaimondCloud.noteWhole(window.DaimondSync.version() | 0));
}
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
check('(viii) one file, the same content key on both devices, at DIFFERENT addresses — C seals with a fresh IV',
	!!mB && !!mC && mB.key === mC.key && mB.addrs.length > 0
	&& mB.addrs.join() !== mC.addrs.join(),
	!mB || !mC ? 'one of them offloaded nothing'
		: `key ${String(mB.key).slice(0, 10)}…, ${mB.addrs.length} vs ${mC.addrs.length} addresses, `
		+ (mB.addrs.filter(a => mC.addrs.indexOf(a) >= 0).length || 'no') + ' in common');

// B PUSHES AND COMMITS FIRST, and C has never declared this file: its one parcel so far
// is its sign-in round's, sent before the file was written. Nothing of C's copy is
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
// the files that sections (i) to (vi) offloaded from contexts now closed
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

// AND C IS UPGRADED, which is the step every device in the field takes. Its first
// load of the convergent build drops the random-IV map and owes one re-offload, and
// that re-offload must land on B's addresses: one copy of the file for the account,
// both peer slots closed, and C's random-IV copy let go by the next commit.
await upgradeSeal(C, 'C');
for (let r = 0; r < 2; r++) {
	await push(C); await pull(B); await push(B); await pull(C);
}
const up = {};
for (const [label, s_] of [['B', B], ['C', C]]) {
	up[label] = await s_.page.evaluate((p) => {
		const ix = window.DaimondCloud.index();
		return { addrs: ((ix[p] || {}).chunks || []).map(c => c.addr).sort(),
			slots: Object.keys(ix).filter(k => k.indexOf(p + '.peer.') === 0),
			oldMap: localStorage.getItem('daimond-chunk-map') !== null };
	}, XP);
}
check('(viii) upgraded, C drops the random-IV map',
	up.C.oldMap === false, up.C.oldMap ? '`daimond-chunk-map` still there' : 'gone');
check('(viii) and re-seals the file at B\'s addresses — one copy for the account',
	up.C.addrs.length > 0 && up.C.addrs.join() === mB.addrs.join() && up.B.addrs.join() === mB.addrs.join(),
	`C ${up.C.addrs.length} address(es), B ${up.B.addrs.length}, `
	+ (up.C.addrs.join() === up.B.addrs.join() ? 'the same' : 'different'));
check('(viii) and both peer slots for that file close — nothing of the other\'s is novel',
	up.B.slots.length === 0 && up.C.slots.length === 0,
	`B ${up.B.slots.length} slot(s), C ${up.C.slots.length}`);
const conv = await B.page.evaluate(async (a) => {
	const pr = await window.DaimondChunks.presence(a.mine.concat(a.old));
	const miss = (pr && pr.missing) || [];
	return { mine: a.mine.filter(x => miss.indexOf(x) >= 0).length,
		old: a.old.filter(x => miss.indexOf(x) < 0).length };
}, { mine: mB.addrs, old: addrsC });
check('(viii) every address of the one copy is held, and C\'s random-IV copy is let go',
	conv.mine === 0 && conv.old === 0,
	`${conv.mine} of ${mB.addrs.length} missing; ${conv.old} of ${addrsC.length} old address(es) still held`);

await C.close().catch(() => {});

}

// ═══════════════════════════════════════════════════════════════════════
// (ix) A RATED CHAT IS A FIXED POINT: THE THREE `rating_log` MESSAGES SURVIVE A COLLECT BYTE FOR BYTE
// ═══════════════════════════════════════════════════════════════════════
//
// U2 of the per-product rating writes a rating as a `rating_log` message at the end of its chat and adds no
// sync path of its own: the legacy `chats` section carries it, by union on `mid`. That is enough only if
// `collectSync` hands the message over exactly as the chat holds it. A copy that lost or reordered a key
// would still be a rating the other device could read, but it would not be the SAME record: first copy wins
// on `mid`, so the difference would stand for ever, and the push-skip would never see it (the parcel is
// the same bytes on every later round). The fixture is `dev/fixtures/rating_u2.json`, the three records of
// plan section 2.3: a tap, a popup with tags, dims and a note, and a withdrawal. `burst` is the key a
// careless copy loses first, which is what `--break nofix` does.
console.log('\n— (ix) a chat of the three fixture ratings collects byte for byte —');

const FIXTURE = readPage(path.join(HERE, 'fixtures', 'rating_u2.json'), 'utf8');
const RATED   = 'rating-fixture';
/// Where two strings first differ, with a few characters either side, for a failure line that says what was lost.
const diffAt = (got, want) => {
	got = String(got || ''); let i = 0;
	while (i < got.length && i < want.length && got[i] === want[i]) i++;
	return got === want ? '' : `first difference at ${i}: got ${JSON.stringify(got.slice(Math.max(0, i - 12), i + 24))}, wanted ${JSON.stringify(want.slice(Math.max(0, i - 12), i + 24))}`;
};
const storedOf = (s, id) => s.page.evaluate(async (id) => {
	const g = await window.DaimondCore.chatStore().loadMessages(id);
	return JSON.stringify((g && g.messages) || []);
}, id);
// A chat the collect has not seen before has no known size, so its first collect offloads it as a ref and
// records the size; the second carries it inline, which is how every chat but a brand-new one travels.
// The first is therefore thrown away.
const collectedOf = (s, id) => s.page.evaluate(async (id) => {
	await window.DaimondCore.collectSync();
	const c = await window.DaimondCore.collectSync();
	const e = (c.chats || []).find((x) => x && x.id === id);
	return e ? { present: true, inline: Array.isArray(e.messages), messages: Array.isArray(e.messages) ? JSON.stringify(e.messages) : null, ref: !!e.messagesRef } : { present: false };
}, id);

// BOTH SIDES AT REST FIRST, so that the pushes counted below belong to this chat and to nothing earlier.
for (let i = 0; i < 3; i++) { await pull(A); await push(A); await pull(B); await push(B); }

await A.page.evaluate(async ({ id, fixture }) => {
	const store = window.DaimondCore.chatStore();
	const list = store.stored();
	list.push({ id: id, name: 'Rated', model: 'mock/fast', updatedAt: Date.now(),
		messages: JSON.parse(fixture), session: null });
	store.save(list);
}, { id: RATED, fixture: FIXTURE });

check('(ix) the fixture is the three messages of plan 2.3, and A\'s store holds them byte for byte',
	FIXTURE.length > 1500 && JSON.parse(FIXTURE).length === 3 && JSON.parse(FIXTURE).every((m) => m.role === 'rating_log')
	&& (await storedOf(A, RATED)) === FIXTURE, `${FIXTURE.length} bytes of fixture`);
const cA = await collectedOf(A, RATED);
check('(ix) A\'s collect carries the chat inline, its three messages byte-identical to the fixture',
	cA.present && cA.inline && cA.messages === FIXTURE,
	cA.present ? (cA.inline ? (cA.messages === FIXTURE ? 'inline, identical' : diffAt(cA.messages, FIXTURE)) : 'carried as a ref') : 'the chat is not in the collect');

await push(A);
await pull(B);
let gotB = false;
for (let i = 0; i < 30 && !gotB; i++) {
	gotB = await B.page.evaluate((id) => window.DaimondCore.chatStore().stored().some((c) => c.id === id), RATED);
	if (!gotB) await new Promise((r) => setTimeout(r, 500));
}
check('(ix) B applies the parcel and holds the chat', gotB, '');
check('(ix) B\'s store holds the three messages byte-identical to the fixture', (await storedOf(B, RATED)) === FIXTURE,
	diffAt(await storedOf(B, RATED), FIXTURE) || 'identical');
const cB = await collectedOf(B, RATED);
if (cB.present && cB.inline) {
	check('(ix) B\'s collect after the apply carries them byte-identical, as A\'s does', cB.messages === FIXTURE && cB.messages === cA.messages, '');
} else {
	note('B carries the chat as ' + (cB.ref ? 'a ref (a sealed chunk), so its inline bytes are not compared; the store above is' : 'nothing') + ' (cB ' + JSON.stringify(cB) + ')');
	check('(ix) B\'s collect names the chat, as a ref it can restore', cB.present && cB.ref, JSON.stringify(cB));
}

// AND THE PAIR SETTLES. Rounds until both are quiet, then one more of each must send nothing: the
// push-skip compares the parcel with the last one sent, and a rating that came back from the other
// device in other bytes would keep it moving.
for (let i = 0; i < 3; i++) { await pull(A); await push(A); await pull(B); await push(B); }
const pushedBefore = cloud.pushes.length;
await new Promise((r) => setTimeout(r, 5500));		// past IDLE_PULL_MIN_MS
await push(A); await push(B); await push(A); await push(B);
check('(ix) the pair settles: another round of pushes sends nothing', cloud.pushes.length === pushedBefore,
	`${cloud.pushes.length - pushedBefore} push(es), mailbox v${cloud.mailbox.version}`);
check('(ix) and after it A\'s store and B\'s still hold the fixture byte for byte', (await storedOf(A, RATED)) === FIXTURE && (await storedOf(B, RATED)) === FIXTURE,
	'A ' + (diffAt(await storedOf(A, RATED), FIXTURE) || 'identical') + '; B ' + (diffAt(await storedOf(B, RATED), FIXTURE) || 'identical'));

// ═══════════════════════════════════════════════════════════════════════
// (x) A CHAT OF THE U3 FIXTURE IS A FIXED POINT: A FILE RATING, A `files_log` AND A `pre` SURVIVE A COLLECT BYTE FOR BYTE
// ═══════════════════════════════════════════════════════════════════════
//
// 5.3.0 adds four synced fields and no path to carry them (plan section 7): `prod.via`, the `files_log` message, a user
// message's `pre`, and the manifest's `by.via`. Each rides the legacy `chats` union and is written once, so the one thing
// to prove here is that `collectSync` hands the chat over exactly as it holds it. `dev/fixtures/rating_u3.json` is the page
// builder's own bytes: a file `rating_log` whose `prod` is a v2 record, a `files_log` of two records (one credited through a
// command, `via: 'command'`) and a user message carrying `pre`. `--break novia` strips `via` from every record on the way out.
console.log('\n— (x) a chat of the U3 fixture collects byte for byte —');

// The fixture lists its rating before the files_log it rates, and a chat is held in time order (ts), so the messages are put in
// that order here, once, and the chat is seeded and compared in it. The bytes of each message are the fixture's own.
const FIXTURE3 = JSON.stringify(JSON.parse(readPage(path.join(HERE, 'fixtures', 'rating_u3.json'), 'utf8'))
	.sort((x, y) => (x.ts - y.ts) || (x.mid < y.mid ? -1 : 1)));
const FILED    = 'rating-u3-fixture';
const ROLES3   = ['files_log', 'rating_log', 'user'];

for (let i = 0; i < 3; i++) { await pull(A); await push(A); await pull(B); await push(B); }

await A.page.evaluate(async ({ id, fixture }) => {
	const store = window.DaimondCore.chatStore();
	const list = store.stored();
	list.push({ id: id, name: 'Filed', model: 'mock/fast', updatedAt: Date.now(),
		messages: JSON.parse(fixture), session: null });
	store.save(list);
}, { id: FILED, fixture: FIXTURE3 });

check('(x) the fixture is a file rating, a files_log and a user message with pre, and A\'s store holds them byte for byte',
	JSON.stringify(JSON.parse(FIXTURE3).map((m) => m.role)) === JSON.stringify(ROLES3) && FIXTURE3.includes('"via":"command"') && FIXTURE3.includes('"pre":')
	&& (await storedOf(A, FILED)) === FIXTURE3, `${FIXTURE3.length} bytes of fixture`);
const cA3 = await collectedOf(A, FILED);
check('(x) A\'s collect carries the chat inline, its three messages byte-identical to the fixture',
	cA3.present && cA3.inline && cA3.messages === FIXTURE3,
	cA3.present ? (cA3.inline ? (cA3.messages === FIXTURE3 ? 'inline, identical' : diffAt(cA3.messages, FIXTURE3)) : 'carried as a ref') : 'the chat is not in the collect');

await push(A);
await pull(B);
let gotB3 = false;
for (let i = 0; i < 30 && !gotB3; i++) {
	gotB3 = await B.page.evaluate((id) => window.DaimondCore.chatStore().stored().some((c) => c.id === id), FILED);
	if (!gotB3) await new Promise((r) => setTimeout(r, 500));
}
check('(x) B applies the parcel and holds the chat', gotB3, '');
check('(x) B\'s store holds the three messages byte-identical to the fixture', (await storedOf(B, FILED)) === FIXTURE3,
	diffAt(await storedOf(B, FILED), FIXTURE3) || 'identical');
const cB3 = await collectedOf(B, FILED);
if (cB3.present && cB3.inline) {
	check('(x) B\'s collect after the apply carries them byte-identical, as A\'s does', cB3.messages === FIXTURE3 && cB3.messages === cA3.messages, '');
} else {
	note('B carries the chat as ' + (cB3.ref ? 'a ref (a sealed chunk), so its inline bytes are not compared; the store above is' : 'nothing') + ' (cB ' + JSON.stringify(cB3) + ')');
	check('(x) B\'s collect names the chat, as a ref it can restore', cB3.present && cB3.ref, JSON.stringify(cB3));
}

for (let i = 0; i < 3; i++) { await pull(A); await push(A); await pull(B); await push(B); }
const pushedBefore3 = cloud.pushes.length;
await new Promise((r) => setTimeout(r, 5500));		// past IDLE_PULL_MIN_MS
await push(A); await push(B); await push(A); await push(B);
check('(x) the pair settles: another round of pushes sends nothing', cloud.pushes.length === pushedBefore3,
	`${cloud.pushes.length - pushedBefore3} push(es), mailbox v${cloud.mailbox.version}`);
check('(x) and after it A\'s store and B\'s still hold the fixture byte for byte', (await storedOf(A, FILED)) === FIXTURE3 && (await storedOf(B, FILED)) === FIXTURE3,
	'A ' + (diffAt(await storedOf(A, FILED), FIXTURE3) || 'identical') + '; B ' + (diffAt(await storedOf(B, FILED), FIXTURE3) || 'identical'));

// ═══════════════════════════════════════════════════════════════════════
// (xi) THE WHOLE OF 5.3.0'S RECORDS IN ONE CHAT: `files_log` WITH `delta`, `pre`, `app`, AND TWO FILE RATINGS
// ═══════════════════════════════════════════════════════════════════════
//
// (x) holds one of each of the page builder's own records. U4 adds a mark of its own, `app: true` on a user message the app
// made (a preset, a trigger, a gather round), and a person's message can carry a `pre` beside it in the same chat. So this
// chat holds the lot: the fixture's `files_log` with its `delta`, a file `rating_log` and the user message with `pre`
// (all three from `rating_u3.json`, byte for byte), and beside them a second file rating, a second user message whose `pre`
// carries the kinds of byte the wire has to carry, and a preset with `app: true`, built here in the key order the page
// writes them (`pushUserRecord` sets `app` and `pre` after `ts`). The chat is collected, applied and settled as (x)'s was,
// and every byte is compared. `--break appfirst` moves `app` to a message's first key and reddens this section alone.
console.log('\n— (xi) a chat of every 5.3.0 record collects byte for byte —');

const FIXTURE4 = (() => {
	const base = JSON.parse(readPage(path.join(HERE, 'fixtures', 'rating_u3.json'), 'utf8'));
	const rate = base.find((m) => m.role === 'rating_log');
	// A second file rating on another row of the files_log's turn, an up where the fixture's is a down.
	const rate2 = JSON.parse(JSON.stringify(rate));
	rate2.mid = 'r-mfq3c0d9-u1v2w'; rate2.ts = rate.ts + 50;
	rate2.rating.h = 'p1:file:chat:c7/v2/n.md'; rate2.rating.hash = 'cd'.repeat(32);
	rate2.rating.s = 1; rate2.rating.tags = []; rate2.rating.note = ''; rate2.rating.burst = rate2.mid;
	rate2.rating.dims = { correct: 1, followed: 1, length: 0, style: 0 };
	rate2.rating.prod = Object.assign({}, rate.rating.prod, { h: rate2.rating.h, hash: rate2.rating.hash, via: 'command' });
	// A person's next message, with a note of the kinds of byte the wire has to carry.
	const said = { role: 'user', content: 'Better. Keep going.', mid: 'mfq3d-1-bcdef', iturn: 'mfq3d-1-bcdef', ts: 1790000900000,
		pre: '[Daimond: the user rated the file chat:c7/v2/n.md +1.]  Étape ✓ "q" \\ \n tab\there' };
	// The app's own message, as a preset or a trigger is pushed: no note, and the mark last.
	const preset = { role: 'user', content: '@text Check the lexer tests.', mid: 'mfq3e-0-cdefg', iturn: 'mfq3e-0-cdefg', ts: 1790001000000, app: true };
	return JSON.stringify(base.concat([rate2, said, preset]).sort((x, y) => (x.ts - y.ts) || (x.mid < y.mid ? -1 : 1)));
})();
const ALLED   = 'rating-u4-fixture';
const ROLES4  = ['files_log', 'rating_log', 'rating_log', 'user', 'user', 'user'];

for (let i = 0; i < 3; i++) { await pull(A); await push(A); await pull(B); await push(B); }

await A.page.evaluate(async ({ id, fixture }) => {
	const store = window.DaimondCore.chatStore();
	const list = store.stored();
	list.push({ id: id, name: 'Everything', model: 'mock/fast', updatedAt: Date.now(),
		messages: JSON.parse(fixture), session: null });
	store.save(list);
}, { id: ALLED, fixture: FIXTURE4 });

const m4 = JSON.parse(FIXTURE4);
check('(xi) the fixture holds a files_log with delta, two file ratings, a user message with pre and one with app, and A\'s store holds it byte for byte',
	JSON.stringify(m4.map((m) => m.role)) === JSON.stringify(ROLES4)
	&& m4.some((m) => m.role === 'files_log' && Array.isArray(m.delta) && m.delta.length > 0)
	&& m4.filter((m) => m.role === 'rating_log' && m.rating && m.rating.prod && m.rating.prod.k === 'file').length === 2
	&& m4.some((m) => m.role === 'user' && typeof m.pre === 'string' && m.pre) && m4.some((m) => m.role === 'user' && m.app === true)
	&& JSON.stringify(Object.keys(m4.find((m) => m.app === true))) === JSON.stringify(['role', 'content', 'mid', 'iturn', 'ts', 'app'])
	&& (await storedOf(A, ALLED)) === FIXTURE4, `${FIXTURE4.length} bytes of fixture`);
const cA4 = await collectedOf(A, ALLED);
check('(xi) A\'s collect carries the chat inline, its six messages byte-identical to the fixture',
	cA4.present && cA4.inline && cA4.messages === FIXTURE4,
	cA4.present ? (cA4.inline ? (cA4.messages === FIXTURE4 ? 'inline, identical' : diffAt(cA4.messages, FIXTURE4)) : 'carried as a ref') : 'the chat is not in the collect');

await push(A);
await pull(B);
let gotB4 = false;
for (let i = 0; i < 30 && !gotB4; i++) {
	gotB4 = await B.page.evaluate((id) => window.DaimondCore.chatStore().stored().some((c) => c.id === id), ALLED);
	if (!gotB4) await new Promise((r) => setTimeout(r, 500));
}
check('(xi) B applies the parcel and holds the chat', gotB4, '');
check('(xi) B\'s store holds the six messages byte-identical to the fixture', (await storedOf(B, ALLED)) === FIXTURE4,
	diffAt(await storedOf(B, ALLED), FIXTURE4) || 'identical');
const cB4 = await collectedOf(B, ALLED);
if (cB4.present && cB4.inline) {
	check('(xi) B\'s collect after the apply carries them byte-identical, as A\'s does', cB4.messages === FIXTURE4 && cB4.messages === cA4.messages, '');
} else {
	note('B carries the chat as ' + (cB4.ref ? 'a ref (a sealed chunk), so its inline bytes are not compared; the store above is' : 'nothing') + ' (cB ' + JSON.stringify(cB4) + ')');
	check('(xi) B\'s collect names the chat, as a ref it can restore', cB4.present && cB4.ref, JSON.stringify(cB4));
}

for (let i = 0; i < 3; i++) { await pull(A); await push(A); await pull(B); await push(B); }
const pushedBefore4 = cloud.pushes.length;
await new Promise((r) => setTimeout(r, 5500));		// past IDLE_PULL_MIN_MS
await push(A); await push(B); await push(A); await push(B);
check('(xi) the pair settles: another round of pushes sends nothing', cloud.pushes.length === pushedBefore4,
	`${cloud.pushes.length - pushedBefore4} push(es), mailbox v${cloud.mailbox.version}`);
check('(xi) and after it A\'s store and B\'s still hold the fixture byte for byte', (await storedOf(A, ALLED)) === FIXTURE4 && (await storedOf(B, ALLED)) === FIXTURE4,
	'A ' + (diffAt(await storedOf(A, ALLED), FIXTURE4) || 'identical') + '; B ' + (diffAt(await storedOf(B, ALLED), FIXTURE4) || 'identical'));

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
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed`
	+ (skipped.length ? `, ${skipped.length} not covered on ${BROWSER}` : ''));
if (bad.length) process.exit(1);
