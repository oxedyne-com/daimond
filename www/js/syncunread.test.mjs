/* ============================================================
   Test — a version adopted without opening counts as merged here
   (FIRE SYNC-UNREAD, dc_diag.md fix 1).

   Five exits in pullOnce take the mailbox's version WITHOUT opening
   its parcel ("keep local state and let ours go over it"). They
   returned before `noteMergedAt`, so the push's merge gate
   (`serverVersion > 0 && !locMerged`, QFB4-1) re-pulled, met the
   same exit, and returned: a device whose mailbox top it cannot open
   never pushed again, and the promised recovery never ran.

   Each case below seeds the mailbox at v1 with a parcel this device
   cannot open, reaching one exit, and asserts that the next push
   lands v2 over it and that the location is recorded as merged at
   v1. Case 4 is the diagnosis's E1 seed: an empty blob.

   Drives the REAL www/js/sync.js in a simulated tab, as synckey.test.

   Run:  node www/js/syncunread.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const SELF = '00112233445566aa';
const LOC  = 'browser';					// the storage location `fileLoc` reports
const K_MERGED_AT = 'daimond-sync-merged-at';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const named = (msg, name) => Object.assign(new Error(msg), { name });

/// A rekey envelope around sealed bytes this device cannot open, as wrapEnvelope lays it out.
function envelope(rec) {
	const json = Buffer.from(JSON.stringify(rec), 'utf8');
	const head = Buffer.from([68, 82, 75, 49,
		(json.length >>> 24) & 255, (json.length >>> 16) & 255, (json.length >>> 8) & 255, json.length & 255]);
	return Buffer.concat([head, json, Buffer.from('not a sealed parcel', 'utf8')]).toString('base64');
}

function makeTab(id) {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const tab = {
		win, store,
		unlocked: false,
		epoch: id.epoch | 0,
		salt: id.salt || null,
		posts: [],
		gets: 0,
		mailbox: null,				// { version, blob }
		lockOnGet: false,			// the user presses Lock while the next GET is in flight
		failNext: null,				// an error the next unwrap throws once (an OOM, say)
		applied: [],				// the versions `applySync` merged
	};
	// A parcel this mock seals is base64 of 'P:' + plain; anything else will not open.
	const open = (blob) => {
		const s = Buffer.from(String(blob), 'base64').toString('utf8');
		if (!blob || !s.startsWith('P:')) throw named('will not open', 'OperationError');	// the GCM tag
		return s.slice(2);
	};
	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		wrap: async (plain) => b64('P:' + plain),
		unwrap: async (blob) => {
			if (!tab.unlocked) throw new Error('locked');				// requireUnlocked
			if (tab.failNext) { const e = tab.failNext; tab.failNext = null; throw e; }
			return open(blob);
		},
		unwrapPrev: async () => { throw new Error('no previous key'); },
		hasPrevKey: () => false,
		handle: () => '',
		deviceId: () => SELF,
		epoch: () => tab.epoch,
		saltB64: () => tab.salt,
		rekeyRecord: () => null,			// pushes travel bare; what is read is the point here
		verifyRecord: async () => true,
		adoptRekey: async (rec) => { tab.epoch = rec.epoch | 0; tab.salt = rec.salt; return { ok: true }; },
		adoptDiverged: async (rec) => { tab.salt = rec.salt; return { ok: true }; },
	};
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.unlocked }),
		gwFetch: async (path, opts) => {
			if (!opts || opts.method === 'GET') {
				tab.gets++;
				if (tab.lockOnGet) { tab.lockOnGet = false; tab.unlocked = false; }
				if (!tab.mailbox) return { status: 200, json: async () => ({ present: false, version: 0 }) };
				return { status: 200, json: async () => ({ present: true,
					version: tab.mailbox.version, blob: tab.mailbox.blob }) };
			}
			const body = JSON.parse(opts.body);
			const cur = tab.mailbox ? tab.mailbox.version : 0;
			if ((body.base_version | 0) !== cur) {
				return { status: 409, json: async () => ({ error: 'stale', version: cur }) };
			}
			tab.posts.push(body);
			tab.mailbox = { version: cur + 1, blob: body.blob };
			return { status: 200, json: async () => ({ ok: true, version: cur + 1 }) };
		},
	};
	win.DaimondCore = {
		collectSync: async () => ({ v: 3, chats: [{ id: 'c1', messages: ['local work'] }], files: {},
			filesComplete: true, devices: {}, ledger: [] }),
		syncSelfDeviceId: () => SELF,
		syncLoc: async () => LOC,
		busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false,
		syncCommitBlockedReason: () => 'tools are not up',
		applySync: async (st, v) => { tab.applied.push(v); return {}; },
	};
	win.DaimondCloud = {
		// Digested on this thread: `subtle.digest` runs on libuv's pool, in real time, so
		// under load it could outlast the test's settling and a step be read early.
		sha256: async (s) => createHash('sha256').update(s).digest('hex'),
	};
	const body = readFileSync(join(HERE, 'sync.js'), 'utf8');
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console',
		'with (window) {\n' + body + '\n}');
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		setTimeout, clearTimeout, () => 0, () => {},
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return tab;
}

const CASES = [
	// The control: a parcel that opens merges, and the push lands, with or without the fix.
	['0. control: an openable parcel',
		{ epoch: 0, salt: 'mm' }, b64('P:' + JSON.stringify({ v: 3, chats: [], files: {}, filesComplete: true, devices: {}, ledger: [] }))],
	['1. a newer epoch, adopted, whose parcel still will not open',
		{ epoch: 0, salt: 'mm' }, envelope({ v: 1, epoch: 1, salt: 'nn' })],
	['2. a diverged branch yielded to, whose parcel will not open',
		{ epoch: 1, salt: 'zz' }, envelope({ v: 1, epoch: 1, salt: 'aa' })],
	['3. a diverged branch this side wins (smaller salt)',
		{ epoch: 1, salt: 'aa' }, envelope({ v: 1, epoch: 1, salt: 'zz' })],
	['4. a corrupt blob at our own epoch (E1: the empty blob)',
		{ epoch: 0, salt: 'mm' }, ''],
	['5. an older-epoch blob with no previous key held',
		{ epoch: 1, salt: 'mm' }, b64('junk from a lagging device')],
];

console.log('\nan unopenable parcel at the mailbox top does not block the next push\n');

for (const [name, id, blob] of CASES) {
	const tab = makeTab(id);
	tab.mailbox = { version: 1, blob };
	tab.unlocked = true;
	await tab.win.DaimondSync.push();
	check(name + ': the push lands over it',
		tab.posts.length === 1 && tab.mailbox.version === 2,
		tab.posts.length + ' POST(s), mailbox v' + tab.mailbox.version);
	let merged = {};
	try { merged = JSON.parse(tab.store.get(K_MERGED_AT) || '{}'); } catch (e) { merged = {}; }
	check(name + ': this location is recorded at the version it reached',
		merged[LOC] === tab.mailbox.version, JSON.stringify(merged));
	check(name + ': and what landed opens', (() => {
		try { return JSON.parse(Buffer.from(tab.mailbox.blob, 'base64').toString('utf8').slice(2)).chats[0].id === 'c1'; }
		catch (e) { return false; }
	})());
}

// ── A parcel that could not be TRIED is not unopenable (QA r572w B N1) ──
//
// Another device lands a GOOD parcel at v1. This page's first read of it fails for a
// reason that says nothing about the parcel. It must not be taken as merged: the next
// push merges it first, and only then lands. A real decrypt failure is still adopted,
// and a version so adopted still merges when a later read can open it.

console.log('\na parcel that could not be tried is not adopted unopened\n');

const GOOD = b64('P:' + JSON.stringify({ v: 3, chats: [{ id: 'c2', messages: ['B work'] }], files: {},
	filesComplete: true, devices: {}, ledger: [] }));
const mergedHere = (tab) => {
	try { return JSON.parse(tab.store.get(K_MERGED_AT) || '{}')[LOC]; } catch (e) { return undefined; }
};
async function seeded() {
	const tab = makeTab({ epoch: 0, salt: 'mm' });
	tab.unlocked = true;
	await tab.win.DaimondSync.pull(true);			// an empty mailbox: this page has heard
	tab.mailbox = { version: 1, blob: GOOD };
	return tab;
}

for (const [name, spoil] of [
	['a. Lock pressed mid-pull', (tab) => { tab.lockOnGet = true; }],
	['b. out of memory in decrypt', (tab) => { tab.failNext = new RangeError('Out of memory'); }],
]) {
	const tab = await seeded();
	spoil(tab);
	const r = await tab.win.DaimondSync.pull(true);
	check(name + ': the read fails, and v1 is not recorded as merged',
		r < 0 && mergedHere(tab) !== 1, 'pull ' + r + ', mergedAt ' + mergedHere(tab));
	tab.unlocked = true;
	await tab.win.DaimondSync.push();
	check(name + ': the next push merges v1 before it lands',
		tab.applied.indexOf(1) >= 0 && tab.posts.length === 1 && tab.mailbox.version === 2,
		'applied ' + JSON.stringify(tab.applied) + ', ' + tab.posts.length + ' POST(s), mailbox v' + tab.mailbox.version);
}

{
	const name = 'c. a real decrypt failure (OperationError)';
	const tab = await seeded();
	tab.failNext = named('The operation failed for an operation-specific reason', 'OperationError');
	const r = await tab.win.DaimondSync.pull(true);
	check(name + ': is adopted unopened', r === 1 && mergedHere(tab) === 1 && tab.applied.length === 0,
		'pull ' + r + ', mergedAt ' + mergedHere(tab));
	await tab.win.DaimondSync.push();
	check(name + ': and the push still lands', tab.posts.length === 1 && tab.mailbox.version === 2,
		tab.posts.length + ' POST(s), mailbox v' + tab.mailbox.version);
}

{
	const name = 'd. a version adopted unopened that a later read can open';
	const tab = await seeded();
	tab.failNext = named('unparseable', 'SyntaxError');
	await tab.win.DaimondSync.pull(true);
	const before = tab.applied.length;
	await tab.win.DaimondSync.pull(true);
	check(name + ': is merged, never skipped as already adopted',
		before === 0 && tab.applied.indexOf(1) >= 0, 'applied ' + JSON.stringify(tab.applied));
}

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nall sync-unread checks passed\n');
process.exit(failures ? 1 : 0);
