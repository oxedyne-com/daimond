// maillist.test.mjs -- the message list never says "(unknown)", a message in cloud storage opens,
// and a discarded draft leaves the list at once (UNBLOCK-79, D-20261101).
//
//	node --test www/js/maillist.test.mjs
//
// On 1 Nov 2026 his Gmail inbox on gilgamesh drew dozens of rows reading only "(unknown)", with
// no subject or date, and pressing one said "That message could not be read." Those were
// messages in cloud storage, not on that device: `readMailbox` folded them in from the listing
// with every field blank, the row printed the blank sender as "(unknown)", and `openMessage`
// read the file through the raw byte reader, which knows nothing of cloud storage. They also
// lacked `local`, so the sort's comparator answered -1 both ways round against a fetched
// message. A draft discarded from the editor stayed in "Drafts · 1": the list was refreshed and
// never drawn. This drives the REAL mail.js over an in-memory store with a cloud half, and a
// list element that records what it was given to draw. Red on 646455bc0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { wasm } from '../../dev/wasmpkg.mjs';

const W = await wasm();

const NOW  = 1_700_000_000_000;
const ADDR = 'hoogland@gmail.com';
const CUR  = 'mail/' + ADDR + '/INBOX/cur';

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

/// An element that keeps what it is given, and answers everything else as `elem` does.
function rec() {
	const o = { kids: [], html: '', on: {}, attrs: {}, textContent: '', className: '', title: '' };
	const own = {
		appendChild(c) { o.kids.push(c); return c; },
		addEventListener(k, f) { (o.on[k] = o.on[k] || []).push(f); },
		setAttribute(k, v) { o.attrs[k] = String(v); },
		getAttribute(k) { return o.attrs[k]; },
		querySelector() { return null; },
		firstElementChild: undefined,
	};
	const p = new Proxy(o, {
		get: (t, k) => {
			if (k === 'innerHTML') return t.html;
			if (k in own) return own[k];
			if (k in t) return t[k];
			if (k === 'then') return undefined;
			if (k === Symbol.toPrimitive) return () => '';
			return elem();
		},
		set: (t, k, v) => {
			if (k === 'innerHTML') { t.html = String(v); t.kids = []; } else t[k] = v;
			return true;
		},
	});
	return p;
}
const text = (e) => (e && e.html !== undefined)
	? e.html + ' ' + e.textContent + ' ' + e.kids.map(text).join(' ') : '';
/// Every element under `e` whose class list holds `cls`.
function find(e, cls) {
	if (!e || !e.kids) return [];
	const here = String(e.className || '').split(/\s+/).includes(cls) ? [e] : [];
	return here.concat(...e.kids.map((k) => find(k, cls)));
}

function msg(from, subject, date) {
	return 'From: ' + from + '\r\nTo: ' + ADDR + '\r\nSubject: ' + subject + '\r\nDate: ' + date
		+ '\r\nMessage-ID: <' + subject.replace(/\W/g, '') + '@k.test>\r\n\r\nHi.\r\n';
}

/// A file store with the doors mail.js uses, and a cloud half: a path in `away` is listed as in
/// cloud storage and cannot be read until `DaimondCloud.fetch` brings it here.
function store() {
	const files = new Map(), away = new Map();
	const dec = new TextDecoder();
	return {
		files, away, fetchFails: '', deleteFails: '',
		async writeBytes(path, bytes) { files.set(path, dec.decode(bytes)); },
		async readText(path) {
			if (!files.has(path)) throw new Error('not found: ' + path);
			return files.get(path);
		},
		async readBytes(path) {
			if (!files.has(path)) throw new Error('not found: ' + path);
			return new TextEncoder().encode(files.get(path));
		},
		async fetch(path) {
			if (!away.has(path)) return 'Error: ' + path + ' is not in cloud storage.';
			if (this.fetchFails) return 'Error: ' + this.fetchFails;
			files.set(path, away.get(path)); away.delete(path);
			return 'OK: ' + path + ' fetched.';
		},
		async runTool(name, args) {
			if (name === 'file_list') {
				const pre = args.path.replace(/\/$/, '') + '/';
				const of = (m, tail) => [...m.keys()].filter((k) => k.startsWith(pre))
					.map((k) => k.slice(pre.length)).filter((k) => !k.includes('/'))
					.map((n) => '- ' + n + ' (12 bytes' + tail + ')');
				return { outcome: 'done', text: of(files, '').concat(of(away, ', in cloud storage')).join('\n') };
			}
			if (name === 'file_delete') {
				if (this.deleteFails) return { outcome: 'failed', text: this.deleteFails };
				files.delete(args.path); return { outcome: 'done', text: '' };
			}
			if (name === 'file_write') { files.set(args.path, args.content); return { outcome: 'done', text: '' }; }
			return { outcome: 'done', text: '' };
		},
	};
}

function page(fs, folders) {
	const ls = makeWindow().localStorage;
	ls.setItem('daimond-mail', JSON.stringify({ sel: ADDR, accounts: [{
		address: ADDR, host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
		// Stored on another folder, so opening INBOX reads it (`selectFolder` skips the one shown).
		user: ADDR, pass: 'w', folder: 'Sent', touched: NOW - 1000,
	}] }));
	const w = makeWindow({ now: NOW, ls });
	w.setTimeout   = () => 1;
	w.clearTimeout = () => {};
	w.document.createElement = () => rec();
	const list  = rec();
	const fols  = rec();
	const panel = { querySelector: () => null };
	w.document.getElementById = (id) => (id === 'panel-mail' ? panel : id === 'mail-list' ? list
		: id === 'mail-folders' ? fols : elem());
	const say = (k, v) => k + (v ? ' ' + Object.values(v).join(' ') : '');
	w.DaimondI18n = new Proxy({ t: say, tn: (k, n, v) => say(k, v) }, { get: (o, k) => o[k] || (() => undefined) });
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = {
		state: () => ({ authed: true }),
		noteBalance() {},
		// The server's folder list, where the test gives one.
		gwFetch: async (path) => ({ status: 200, ok: true, json: async () => (path === '/api/mail/folders'
			? { ok: true, folders: folders || [] } : { ok: true, unlocked: true, accounts: [] }) }),
	};
	w.DaimondCloud = { fetch: (p) => fs.fetch(p) };
	// The rows that come into view, as the browser would report them.
	const seen = [];
	w.IntersectionObserver = function (cb) {
		this.observe    = (el) => seen.push({ el, cb, ob: this });
		this.unobserve  = () => {};
		this.disconnect = () => { seen.length = 0; };
	};
	loadScript(w, 'quiet.js');
	loadScript(w, 'mail.js');
	const M = w.DaimondMail;
	let compose = null, shown = null;
	M.init({
		showCompose: (v) => { compose = v; },
		showMessage: (v) => { shown = v; },
		writeBytes: (p, b) => fs.writeBytes(p, b),
		readText:   (p) => fs.readText(p),
		readBytes:  (p) => fs.readBytes(p),
		confirm:    async () => true,
		wasm:       W,
		runTool:    (n, a) => fs.runTool(n, a),
		openFile() {}, refreshFiles() {}, showDoc() {},
	});
	return {
		M, w, list, fols,
		shown: () => shown,
		compose: () => compose,
		/// Bring every row the list is watching into view.
		async scroll() {
			const now = seen.splice(0);
			now.forEach((s) => s.cb([{ isIntersecting: true, target: s.el }], s.ob));
			await settle();
		},
	};
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

async function opened(fs, folders) {
	const p = page(fs, folders);
	await p.M.reload();
	await p.M.selectFolder('INBOX');
	await settle();
	return p;
}

/// His inbox, as gilgamesh held it: two messages here, three in cloud storage, interleaved.
function inbox() {
	const fs = store();
	fs.files.set(CUR + '/101.7.daimond:2,S', msg('Kraig <k@k.test>', 'Gutters', 'Mon, 26 Oct 2026 21:57:00 +0800'));
	fs.away.set(CUR + '/102.7.daimond:2,', msg('Ann <a@a.test>', 'Invoice', 'Tue, 27 Oct 2026 09:00:00 +0800'));
	fs.files.set(CUR + '/103.7.daimond:2,S', msg('Bob <b@b.test>', 'Lunch', 'Wed, 28 Oct 2026 12:00:00 +0800'));
	fs.away.set(CUR + '/104.7.daimond:2,', msg('Cat <c@c.test>', 'Tickets', 'Thu, 29 Oct 2026 08:00:00 +0800'));
	fs.away.set(CUR + '/105.7.daimond:2,', msg('Dan <d@d.test>', 'Visit', 'Sat, 31 Oct 2026 18:00:00 +0800'));
	return fs;
}

// ── 1. No row says "(unknown)" ──────────────────────────────────────────────

test('a message in cloud storage is never drawn as "(unknown)": it says where it is, with a Fetch', async () => {
	const p = await opened(inbox());
	const drawn = text(p.list);
	assert.ok(!/mail\.unknown_sender|\(unknown\)/.test(drawn), 'no row is "(unknown)": ' + drawn.slice(0, 300));
	const away = find(p.list, 'away');
	assert.equal(away.length, 3, 'the three cloud rows say they are in cloud storage');
	away.forEach((r) => {
		assert.match(text(r), /mail\.row\.away/);
		assert.equal(find(r, 'mail-row-fetch').length, 1, 'each has a Fetch of its own');
	});
});

test('a cloud row coming into view is fetched and shows its sender, subject and date', async () => {
	const fs = inbox();
	const p = await opened(fs);
	await p.scroll();
	const v = p.M.rowView(CUR + '/104.7.daimond:2,');
	assert.equal(v.state, '', 'fetched, so nothing left to say about it');
	assert.equal(v.from, 'Cat <c@c.test>');
	assert.equal(v.subject, 'Tickets');
	assert.match(v.date, /29 Oct 2026/);
	assert.ok(!find(p.list, 'away').length, 'no row is left waiting');
});

test('a fetch that fails says why on the row, and Retry brings it', async () => {
	const fs = inbox();
	fs.fetchFails = 'cloud storage no longer holds all of its parts.';
	const p = await opened(fs);
	await p.scroll();
	const failed = find(p.list, 'failed');
	assert.equal(failed.length, 3);
	assert.match(text(failed[0]), /mail\.row\.failed cloud storage no longer holds/);
	const retry = find(failed[0], 'mail-row-fetch')[0];
	assert.match(retry.textContent, /mail\.retry/);
	fs.fetchFails = '';
	retry.on.click[0]({ stopPropagation() {} });
	await settle();
	assert.equal(find(p.list, 'failed').length, 2, 'the retried row came back');
});

test('what the last digest knew of a cloud message is shown, and kept when the digest is rebuilt', async () => {
	const fs = inbox();
	fs.files.set('mail/' + ADDR + '/INBOX/index.md', [
		'# ' + ADDR + ' — INBOX', '',
		'| UID | Date | From | Subject | File |',
		'|----:|------|------|---------|------|',
		'| 105 | Sat, 31 Oct 2026 18:00:00 +0800 | Dan <d@d.test> | Visit \\| plans | `' + CUR + '/105.7.daimond:2,` |',
	].join('\n') + '\n');
	const p = await opened(fs);
	const v = p.M.rowView(CUR + '/105.7.daimond:2,');
	assert.equal(v.from, 'Dan <d@d.test>');
	assert.equal(v.subject, 'Visit | plans');
	assert.equal(v.state, '', 'known, so drawn as any other row');
	await p.M.sync();
	await settle();
	const idx = fs.files.get('mail/' + ADDR + '/INBOX/index.md');
	assert.match(idx, /Dan <d@d\.test> \| Visit \\\| plans/, 'the rebuilt digest still knows it: ' + idx);
});

test('messages here and in cloud storage sort by arrival, newest first', async () => {
	const p = await opened(inbox());
	const uids = p.M.shown().map((m) => m.uid);
	assert.deepEqual(uids, [101, 102, 103, 104, 105]);
});

// ── 1b. His inbox, in the shape his page showed it ──────────────────────────

/// dev/fixtures/maillist/gilgamesh_inbox_20261101.txt: his Inbox count, and how many rows his page drew "(unknown)",
/// as his screenshot and the lens recorded them. Every message is listed as in cloud storage, as the top of his list was.
const OWNER = Object.fromEntries(readFileSync(new URL('../../dev/fixtures/maillist/gilgamesh_inbox_20261101.txt', import.meta.url), 'utf8')
	.split('\n').slice(1).filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));

function hisInbox() {
	const fs = store();
	const cur = 'mail/' + OWNER.account + '/INBOX/cur';
	for (let i = 0; i < Number(OWNER.inbox); i++) {
		const day = new Date(Date.UTC(2026, 9, 31) - i * 3_600_000).toUTCString().replace('GMT', '+0000');
		fs.away.set(cur + '/' + (1000 + i) + '.7.daimond:2,', msg('Sender ' + i + ' <s' + i + '@s.test>', 'Subject ' + i, day));
	}
	return { fs, cur };
}

test('his inbox of ' + OWNER.inbox + ' messages in cloud storage draws no "(unknown)" row, and the first one opens', async () => {
	assert.equal(OWNER.account, ADDR, 'the fixture is his Gmail account');
	const { fs, cur } = hisInbox();
	const p = await opened(fs);
	const drawn = text(p.list);
	assert.ok(!/mail\.unknown_sender|\(unknown\)/.test(drawn), 'his ' + OWNER.unknown_rows + '+ "(unknown)" rows are gone: ' + drawn.slice(0, 300));
	assert.ok(find(p.list, 'away').length >= Number(OWNER.unknown_rows), 'each of the top rows says it is in cloud storage');
	await p.M.open(p.M.shown()[0]);
	await settle();
	assert.ok(!p.M.said().err.includes(OWNER.banner), 'pressing it no longer says ' + OWNER.banner + ': ' + p.M.said().err);
	assert.equal(p.M.said().err, '', 'no error');
	assert.ok(p.shown() && /^Subject \d+$/.test(p.shown().subject), 'the reader shows the message');
	assert.ok(p.M.shown()[0].file.startsWith(cur), 'from his inbox');
});

// ── 2. A message in cloud storage opens ─────────────────────────────────────

/// The list's own record of a message, as its row hands it to `open`.
const row = (p, file) => p.M.shown().find((m) => m.file === file);

test('pressing a message in cloud storage fetches it and opens it, rather than "could not be read"', async () => {
	const p = await opened(inbox());
	await p.M.open(row(p, CUR + '/102.7.daimond:2,'));
	await settle();
	assert.equal(p.M.said().err, '', 'no error: ' + p.M.said().err);
	assert.ok(p.shown(), 'the reader was shown');
	assert.equal(p.shown().subject, 'Invoice');
});

test('a message that cannot be fetched says why, not only that it could not be read', async () => {
	const fs = inbox();
	fs.fetchFails = 'the allowance is used up.';
	const p = await opened(fs);
	await p.M.open(row(p, CUR + '/102.7.daimond:2,'));
	await settle();
	assert.match(p.M.said().err, /mail\.err\.msg_fetch_failed the allowance is used up/);
});

// ── 3. A discarded draft goes ───────────────────────────────────────────────

function withDraft() {
	const fs = inbox();
	fs.files.set('mail/' + ADDR + '/drafts/draft-1.eml',
		'From: ' + ADDR + '\r\nTo: emma@example.com\r\nSubject: Test email\r\nDate: Sun, 01 Nov 2026 09:30:00 +0800\r\n\r\nHi.\r\n');
	return fs;
}

/// The Drafts row of the folder list, as drawn.
const draftsRow = (p) => p.fols.kids.flatMap((k) => k.kids || [])
	.find((r) => r.attrs && r.attrs['data-role'] === 'drafts');
const press = async (row) => { row.on.click[0]({ stopPropagation() {}, preventDefault() {} }); await settle(); };

/// Open the Drafts folder from its row in the folder list, as he would.
async function inDrafts(fs, folders) {
	const p = await opened(fs, folders);
	await p.M.loadFolders(ADDR, true);
	await settle();
	await p.M.refreshDrafts();
	p.M.reload();
	await settle();
	await press(draftsRow(p));
	return p;
}

test('an unsent draft is not drawn above the inbox: it is in the Drafts folder, whose row counts it', async () => {
	const fs = withDraft();
	const p = await opened(fs);
	await p.M.refreshDrafts();
	p.M.reload();
	await settle();
	assert.ok(!/Test email/.test(text(p.list)), 'the inbox shows only its own mail');
	assert.ok(!/drafts_head/.test(text(p.list)), 'and no "Drafts · 1" section');
	const row = draftsRow(p);
	assert.ok(row, 'the folder list has a Drafts folder, though the server declares none');
	assert.equal(find(row, 'mail-drafts-n')[0].textContent, '1', 'counting the draft in it');
	await press(row);
	assert.match(text(p.list), /Test email/, 'the draft is in the Drafts folder');
	assert.ok(!/Gutters/.test(text(p.list)), 'and the inbox is not');
	assert.equal(find(p.list, 'mail-draft-discard').length, 1, 'with its Discard');
	await press(find(p.fols, 'mail-folder')[0]);
	assert.match(text(p.list), /Gutters/, 'the inbox again');
	assert.ok(!/Test email/.test(text(p.list)), 'without the draft');
});

test("the server's Drafts folder is found by its role, never by its name, and holds the drafts", async () => {
	const fs = withDraft();
	const p = await inDrafts(fs, [
		{ name: 'INBOX', role: '', selectable: true, delimiter: '/' },
		{ name: 'Drafts', role: '', selectable: true, delimiter: '/' },	// a label of his own
		{ name: '[Gmail]/Entwürfe', role: 'drafts', selectable: true, delimiter: '/' },
	]);
	assert.equal(p.M.folder(), '[Gmail]/Entwürfe', 'the \\Drafts folder is the one opened');
	assert.equal(find(p.fols, 'mail-folder-local').length, 0, 'no second Drafts of this device');
	assert.match(text(p.list), /Test email/, 'the draft is drawn there');
	assert.deepEqual(find(draftsRow(p), 'mail-count').map((c) => c.textContent), ['1'],
		'its row counts the draft once, in one number');
});

test('discarding a draft in the editor takes it out of the Drafts folder at once', async () => {
	const fs = withDraft();
	const p = await inDrafts(fs);
	assert.match(text(p.list), /Test email/, 'the draft is drawn');
	await p.M.openDraft('mail/' + ADDR + '/drafts/draft-1.eml');
	await p.compose().discard();
	await settle();
	assert.ok(!fs.files.has('mail/' + ADDR + '/drafts/draft-1.eml'), 'the file is gone');
	assert.ok(!/Test email/.test(text(p.list)), 'and so is its row');
	assert.equal(find(draftsRow(p), 'mail-drafts-n').length, 0, 'and its count');
});

test('a draft row has its own Discard, and a discard that fails is said', async () => {
	const fs = withDraft();
	const p = await inDrafts(fs);
	const x = find(p.list, 'mail-draft-discard');
	assert.equal(x.length, 1, 'the draft row has a Discard handle');
	fs.deleteFails = 'the folder is read-only.';
	x[0].on.click[0]({ stopPropagation() {} });
	await settle();
	assert.match(p.M.said().err, /mail\.err\.discard_failed the folder is read-only/);
	assert.match(text(p.list), /Test email/, 'a draft not deleted is still shown');
	fs.deleteFails = '';
	find(p.list, 'mail-draft-discard')[0].on.click[0]({ stopPropagation() {} });
	await settle();
	assert.ok(!/Test email/.test(text(p.list)), 'discarded from its row');
});
