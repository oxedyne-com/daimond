// mailgen.test.mjs -- a folder holds one UIDVALIDITY generation of its mail, never two.
//
//	node --test www/js/mailgen.test.mjs
//
// On 26 Oct 2026 Steel on karri was redeployed and alerts@oxegen.io's UIDVALIDITY rose, so
// argonaut's page rebuilt the inbox: it re-fetched UIDs 1-4 under the new generation and left
// the old generation's four files beside them, and the folder showed each message twice
// (hello@oxedyne.com the same at 02:50). The reset rule: once the new generation is written,
// the old one's copies go; before it is written, nothing goes, so a failed rebuild loses nothing.
// This drives the REAL mail.js against a scripted gateway and an in-memory file store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

const NOW  = 1_700_000_000_000;
const ADDR = 'alerts@oxegen.io';
const DIR  = 'mail/' + ADDR + '/INBOX/cur';

function elem() {
	const p = new Proxy(function () { return p; }, {
		get: (t, k) => {
			if (k === Symbol.toPrimitive) return () => '';
			if (k === 'then') return undefined;
			if (k === 'firstElementChild') return undefined;
			if (k === 'length') return 0;
			return p;
		},
		set: () => true,
		apply: () => p,
	});
	return p;
}

function store() {
	const files = new Map();
	const dec = new TextDecoder();
	return {
		files,
		async writeBytes(path, bytes) { files.set(path, dec.decode(bytes)); },
		async readText(path) {
			if (!files.has(path)) throw new Error('not found: ' + path);
			return files.get(path);
		},
		async runTool(name, args) {
			if (name === 'file_list') {
				const pre = args.path.replace(/\/$/, '') + '/';
				const names = [...files.keys()].filter((k) => k.startsWith(pre))
					.map((k) => k.slice(pre.length)).filter((k) => !k.includes('/'));
				return { outcome: 'done', text: names.map((n) => '- ' + n + ' (12 bytes)').join('\n') };
			}
			if (name === 'file_delete') { files.delete(args.path); return { outcome: 'done', text: '' }; }
			if (name === 'file_write')  { files.set(args.path, args.content); return { outcome: 'done', text: '' }; }
			return { outcome: 'done', text: '' };
		},
		held() { return [...files.keys()].filter((k) => k.startsWith(DIR + '/')).map((k) => k.slice(DIR.length + 1)).sort(); },
	};
}

const raw = (id, subject) => 'Message-ID: ' + id + '\r\nFrom: steel@karri\r\nSubject: ' + subject
	+ '\r\nDate: Thu, 22 Oct 2026 08:54:00 +0800\r\n\r\nBody.\r\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const msg = (uid, n) => ({ uid, flags: ['\\Seen'], raw: b64(raw('<alert-' + n + '@karri>', 'Alert ' + n)) });

/// The gateway: the folder at generation `v`, its messages `serve`; `refetchFails` fails the from-0 re-fetch.
function gateway(v, serve) {
	return { v, serve, held_back: 0, refetchFails: false, calls: [] };
}

/// A page over `fs`, with alerts@ held at generation 7 (UIDs 1-2) unless `folder` says otherwise.
function page(gw, fs, folder) {
	const ls = makeWindow().localStorage;
	ls.setItem('daimond-mail', JSON.stringify({ sel: ADDR, accounts: [{
		address: ADDR, host: 'mail.oxegen.io', port: 993, user: ADDR, pass: 'w',
		refresh: { INBOX: 900 }, folder: 'INBOX', touched: NOW - 1000,
		folders: { INBOX: Object.assign({ dir: 'INBOX', uidValidity: 7, lastUid: 2, firstUid: 1,
			heldBack: 0, limit: 0, lastSync: NOW - 1000, lastTry: NOW - 1000, count: 2 }, folder || {}) },
	}] }));
	const w = makeWindow({ now: NOW, ls });
	w.setTimeout   = () => 1;
	w.clearTimeout = () => {};
	w.document.createElement  = () => elem();
	const panel = { querySelector: () => null };
	w.document.getElementById = (id) => (id === 'panel-mail' ? panel : elem());
	const say = (k) => k;
	w.DaimondI18n = new Proxy({ t: say, tn: say }, { get: (o, k) => o[k] || (() => undefined) });
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = {
		state: () => ({ authed: true }),
		noteBalance() {},
		gwFetch: async (path, init) => {
			const body = init && init.body ? JSON.parse(init.body) : {};
			const ok = (j) => ({ status: 200, ok: true, json: async () => Object.assign({ ok: true }, j) });
			if (path === '/api/mail/folders') return ok({ folders: [{ name: 'INBOX', selectable: true }] });
			if (path === '/api/mail/sync') {
				gw.calls.push(body.since_uid || 0);
				if (gw.refetchFails && gw.calls.length > 1) {
					return { status: 502, ok: false, json: async () => ({ ok: false, error: 'connection dropped' }) };
				}
				return ok({ messages: gw.serve.filter((m) => m.uid > (body.since_uid || 0)),
					uid_validity: gw.v, held_back: gw.held_back });
			}
			return ok({ unlocked: true, accounts: [] });
		},
	};
	const arrived = [];
	// The probe's `dispatchEvent` drops every event, so without this an arrival assertion holds vacuously.
	w.dispatchEvent = (ev) => { if (ev.type === 'daimond:mail-arrived') arrived.push(ev.detail); return true; };
	loadScript(w, 'quiet.js');
	loadScript(w, 'mail.js');
	const M = w.DaimondMail;
	M.init({
		showCompose() {},
		writeBytes: (p, b) => fs.writeBytes(p, b),
		readText:   (p) => fs.readText(p),
		runTool:    (n, a) => fs.runTool(n, a),
		openFile() {}, refreshFiles() {}, showDoc() {},
	});
	return { M, w, arrived };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

/// The disk as the page left it before the bump: generation 7, UIDs 1 and 2.
function gen7(fs) {
	fs.files.set(DIR + '/1.7.daimond:2,S', raw('<alert-1@karri>', 'Alert 1'));
	fs.files.set(DIR + '/2.7.daimond:2,S', raw('<alert-2@karri>', 'Alert 2'));
}

// ── 1. A rebuild keeps one generation ───────────────────────────────────────

test('a rebuild for a new UIDVALIDITY leaves only the new generation on disk, and announces nothing', async () => {
	const fs = store(); gen7(fs);
	const gw = gateway(9, [msg(1, 1), msg(2, 2)]);
	const p = page(gw, fs);
	await settle();
	p.M.sync();
	await settle();
	assert.deepEqual(gw.calls, [2, 0], 'asked from the mark, then rebuilt from 0');
	assert.deepEqual(fs.held(), ['1.9.daimond:2,S', '2.9.daimond:2,S'], 'two generations held: ' + fs.held());
	assert.equal(p.M.counts(ADDR).INBOX.count, 2, 'the folder counts each message once');
	assert.equal(p.M.shown().length, 2, 'the panel shows each message once');
	assert.deepEqual(p.arrived, [], 'a rebuild is not an arrival');
});

test('a rebuild whose re-fetch fails loses nothing: the old generation stays until the new one is written', async () => {
	const fs = store(); gen7(fs);
	const gw = gateway(9, [msg(1, 1), msg(2, 2)]);
	gw.refetchFails = true;
	const p = page(gw, fs);
	await settle();
	p.M.sync();
	await settle();
	assert.deepEqual(fs.held(), ['1.7.daimond:2,S', '2.7.daimond:2,S']);
	// And opening the panel on the next load does not take them either: generation 9 is still unwritten.
	page(gateway(9, []), fs).M.onOpen();
	await settle();
	assert.deepEqual(fs.held(), ['1.7.daimond:2,S', '2.7.daimond:2,S']);
});

test('a rebuild the byte cap cut short takes only the old copies it has replaced', async () => {
	const fs = store(); gen7(fs);
	const gw = gateway(9, [msg(1, 1)]);		// UID 2 held back by the cap
	gw.held_back = 1;
	const p = page(gw, fs);
	await settle();
	p.M.sync();
	await settle();
	assert.deepEqual(fs.held(), ['1.9.daimond:2,S', '2.7.daimond:2,S'], 'alert 2 is kept until it is re-fetched');
});

// ── 2. A folder loaded holding two generations keeps the current one ───────────

test('a folder loaded with stale-generation copies beside the current ones keeps only the current', async () => {
	const fs = store(); gen7(fs);
	fs.files.set(DIR + '/1.9.daimond:2,S', raw('<alert-1@karri>', 'Alert 1'));
	fs.files.set(DIR + '/2.9.daimond:2,S', raw('<alert-2@karri>', 'Alert 2'));
	fs.files.set(DIR + '/local.1699999999000.abc.daimond:2,S', raw('<sent-1@karri>', 'Sent'));
	const p = page(gateway(9, []), fs, { uidValidity: 9 });
	p.M.onOpen();							// the panel opened: the folder is read
	await settle();
	assert.deepEqual(fs.held(), ['1.9.daimond:2,S', '2.9.daimond:2,S', 'local.1699999999000.abc.daimond:2,S'],
		'stale generation kept: ' + fs.held());
	assert.equal(p.M.counts(ADDR).INBOX.count, 3);
});

test('a folder whose current generation holds nothing yet keeps what it has', async () => {
	const fs = store(); gen7(fs);
	page(gateway(9, []), fs, { uidValidity: 9, lastUid: 0, firstUid: 0 }).M.onOpen();
	await settle();
	assert.deepEqual(fs.held(), ['1.7.daimond:2,S', '2.7.daimond:2,S']);
});

// ── 3. An interrupted rebuild announces no arrivals when it completes ─────────

test('a rebuild whose re-fetch failed is completed by the next sync, which announces nothing; a new message after still is', async () => {
	const fs = store(); gen7(fs);
	const gw = gateway(9, [msg(1, 1), msg(2, 2)]);
	gw.refetchFails = true;
	const p = page(gw, fs);
	await settle();
	p.M.sync();							// the new UIDVALIDITY is saved, the re-fetch fails
	await settle();
	assert.deepEqual(p.arrived, [], 'the failed rebuild announced nothing');
	gw.refetchFails = false;
	gw.calls = [];
	p.M.sync();							// completes the rebuild: the whole folder comes back
	await settle();
	assert.deepEqual(gw.calls, [0], 'the completing sync fetches the folder from 0');
	assert.deepEqual(p.arrived, [], 'completing a rebuild is not an arrival: ' + JSON.stringify(p.arrived));
	assert.deepEqual(fs.held(), ['1.9.daimond:2,S', '2.9.daimond:2,S'], 'one generation held: ' + fs.held());
	// Guard: a message delivered after the rebuild is an arrival as ever.
	gw.serve.push(msg(3, 3));
	p.M.sync();
	await settle();
	assert.equal(p.arrived.length, 1, 'the new message is announced');
	assert.deepEqual(p.arrived[0].uids, [3]);
});

// ── 4. One held file per (UIDVALIDITY, UID) ──────────────────────────────────

const flagged = (uid, n, flags) => Object.assign(msg(uid, n), { flags });

test('a flag change on the server renames the held file, both ways; a local copy is untouched', async () => {
	const fs = store();
	fs.files.set(DIR + '/1.7.daimond:2,', raw('<alert-1@karri>', 'Alert 1'));
	fs.files.set(DIR + '/local.1699999999000.abc.daimond:2,S', raw('<sent-1@karri>', 'Sent'));
	const gw = gateway(7, [flagged(1, 1, ['\\Seen'])]);
	const p = page(gw, fs, { lastUid: 0, firstUid: 0 });	// re-pulls uid 1 at every sync
	await settle();
	p.M.sync();
	await settle();
	assert.deepEqual(fs.held(), ['1.7.daimond:2,S', 'local.1699999999000.abc.daimond:2,S'], 'read: ' + fs.held());
	gw.serve = [flagged(1, 1, ['\\Flagged'])];
	const q = page(gw, fs, { lastUid: 0, firstUid: 0 });
	await settle();
	q.M.sync();
	await settle();
	assert.deepEqual(fs.held(), ['1.7.daimond:2,F', 'local.1699999999000.abc.daimond:2,S'], 'unread, flagged: ' + fs.held());
});

test('a re-pull with no flag change writes nothing', async () => {
	const fs = store(); gen7(fs);
	const writes = [];
	const wb = fs.writeBytes.bind(fs);
	fs.writeBytes = async (path, b) => { if (path.startsWith(DIR + '/')) writes.push(path); return wb(path, b); };
	const p = page(gateway(7, [msg(1, 1), msg(2, 2)]), fs, { lastUid: 0, firstUid: 0 });
	await settle();
	p.M.sync();
	await settle();
	assert.deepEqual(writes, [], 'rewrote: ' + writes);
	assert.deepEqual(fs.held(), ['1.7.daimond:2,S', '2.7.daimond:2,S']);
});

test('a folder loaded holding two copies of one message keeps the one with the later flags', async () => {
	const fs = store(); gen7(fs);
	fs.files.set(DIR + '/1.7.daimond:2,', raw('<alert-1@karri>', 'Alert 1'));	// before it was read
	fs.files.set(DIR + '/local.1699999999000.abc.daimond:2,S', raw('<sent-1@karri>', 'Sent'));
	const p = page(gateway(7, []), fs);
	p.M.onOpen();
	await settle();
	assert.deepEqual(fs.held(), ['1.7.daimond:2,S', '2.7.daimond:2,S', 'local.1699999999000.abc.daimond:2,S'],
		'pair kept: ' + fs.held());
	assert.equal(p.M.counts(ADDR).INBOX.count, 3);
});
