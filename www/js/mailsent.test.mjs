// mailsent.test.mjs -- what he sends shows in Sent at once, Sent is the folder the server names Sent,
// and nothing about a send fails silently.
//
//	node --test www/js/mailsent.test.mjs
//
// On 26 Oct 2026 a message to Kraig from hoogland@gmail.com went out, and Sent showed nothing:
// Daimond's copy went to `mail/<addr>/sent/`, which no view shows, and a failed copy was
// swallowed. His Gmail also holds a top-level label "Sent", filed once by Thunderbird, beside
// `[Gmail]/Sent Mail`, which carries `\Sent`; only the role says which is which. This drives the
// REAL mail.js against a scripted gateway and an in-memory file store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

const NOW  = 1_700_000_000_000;
const ADDR = 'hoogland@gmail.com';

// His Gmail, as the gateway's folders door answers it.
const GMAIL = [
	{ name: 'INBOX',             selectable: true },
	{ name: 'Sent',              selectable: true },
	{ name: '[Gmail]',           selectable: false },
	{ name: '[Gmail]/All Mail',  selectable: true, role: 'all' },
	{ name: '[Gmail]/Drafts',    selectable: true, role: 'drafts' },
	{ name: '[Gmail]/Sent Mail', selectable: true, role: 'sent' },
	{ name: '[Gmail]/Spam',      selectable: true, role: 'junk' },
	{ name: '[Gmail]/Trash',     selectable: true, role: 'trash' },
];

// A server that names no roles at all, with the dot separator Courier uses.
const BARE = [
	{ name: 'INBOX',               selectable: true, delimiter: '.' },
	{ name: 'INBOX.Sent Items',    selectable: true, delimiter: '.' },
	{ name: 'INBOX.Drafts',        selectable: true, delimiter: '.' },
	{ name: 'INBOX.Deleted Items', selectable: true, delimiter: '.' },
	{ name: 'INBOX.Spam',          selectable: true, delimiter: '.' },
	{ name: 'INBOX.Archive',       selectable: true, delimiter: '.' },
	{ name: 'INBOX.Clients',       selectable: true, delimiter: '.' },
];

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

/// A file store with the two doors mail.js uses: bytes in and out, and the file tools.
function store() {
	const files = new Map();
	const dec = new TextDecoder();
	return {
		files,
		failWrites: null,			// a path test: writes it matches fail
		async writeBytes(path, bytes) {
			if (this.failWrites && this.failWrites.test(path)) throw new Error('quota exceeded');
			files.set(path, dec.decode(bytes));
		},
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
			if (name === 'file_move' || name === 'file_rename') {
				files.set(args.to || args.dest, files.get(args.from || args.path));
				files.delete(args.from || args.path);
				return { outcome: 'done', text: '' };
			}
			return { outcome: 'done', text: '' };
		},
		under(dir) { return [...this.files.keys()].filter((k) => k.startsWith(dir + '/')); },
	};
}

/// A page with the Mail panel over `fs`, a gateway that answers from `gw`, and storage `ls`.
function page(ls, gw, fs) {
	const w = makeWindow({ now: gw.at, ls });
	w.setTimeout   = () => 1;
	w.clearTimeout = () => {};
	w.document.createElement  = () => elem();
	const panel = { querySelector: () => null };
	w.document.getElementById = (id) => (id === 'panel-mail' ? panel : elem());
	// The key, then what was put into it, so a test can see the reason reach the words.
	const say = (k, v) => k + (v ? ' ' + Object.values(v).join(' ') : '');
	w.DaimondI18n = new Proxy({ t: say, tn: (k, n, v) => say(k, v) }, { get: (o, k) => o[k] || (() => undefined) });
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = {
		state: () => ({ authed: true }),
		noteBalance() {},
		gwFetch: async (path, init) => {
			const body = init && init.body ? JSON.parse(init.body) : {};
			const ok = (j) => ({ status: 200, ok: true, json: async () => Object.assign({ ok: true }, j) });
			if (path === '/api/mail/folders') return ok({ folders: gw.list });
			if (path === '/api/mail/sync') {
				gw.synced.push(body.mailbox);
				return ok({ messages: (gw.serve[body.mailbox] || []).filter((m) => m.uid > (body.since_uid || 0)),
					uid_validity: 7, held_back: 0 });
			}
			if (path === '/api/mail/send') {
				gw.sent.push(body);
				if (gw.hold) await gw.hold;
				if (gw.sendFails) {
					return { status: 502, ok: false,
						json: async () => ({ ok: false, error: gw.sendFails }) };
				}
				return ok({});
			}
			return ok({ unlocked: true, accounts: [] });
		},
	};
	loadScript(w, 'quiet.js');
	loadScript(w, 'mail.js');
	const M = w.DaimondMail;
	let compose = null;
	M.init({
		showCompose: (v) => { compose = v; },
		writeBytes: (p, b) => fs.writeBytes(p, b),
		readText:   (p) => fs.readText(p),
		runTool:    (n, a) => fs.runTool(n, a),
		openFile() {}, refreshFiles() {}, showDoc() {},
	});
	return {
		M, w,
		/// Press Send on a message to Kraig, as the compose panel does.
		async send(fields) {
			M.compose();
			return compose.send(Object.assign({ from: ADDR, to: 'kraig@k.test', cc: '',
				subject: 'Hello Kraig', body: 'Hi.', attachments: [] }, fields || {}));
		},
		compose: () => compose,
	};
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

function gateway(list) { return { at: NOW, list, synced: [], sent: [], serve: {}, sendFails: '' }; }

/// Storage holding one mailbox, as an existing install has, and marked new so it seeds its follows.
function stored(seed) {
	const ls = makeWindow().localStorage;
	ls.setItem('daimond-mail', JSON.stringify({ sel: ADDR, accounts: [{
		address: ADDR, host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
		user: ADDR, pass: 'w', refresh: { INBOX: 900 }, folder: 'INBOX', touched: NOW - 1000,
		seed: seed ? 1 : undefined,
	}] }));
	return ls;
}

// ── 1. The folder the server names Sent is Sent ─────────────────────────────

test('a Gmail list with a "Sent" label and [Gmail]/Sent Mail: the role wins, for following and for display', async () => {
	const gw = gateway(GMAIL), fs = store();
	const p = page(stored(true), gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.sentFolder(ADDR), '[Gmail]/Sent Mail', 'Sent is the folder with role sent');
	assert.ok(p.M.refreshOf(ADDR, '[Gmail]/Sent Mail') > 0, '[Gmail]/Sent Mail is followed');
	assert.equal(p.M.refreshOf(ADDR, 'Sent'), 0, 'the Thunderbird label is not followed');
	assert.equal(p.M.refreshOf(ADDR, '[Gmail]/All Mail'), 0, 'All Mail is not followed');
	const shown = p.M.folders(ADDR);
	const at = (n) => shown.findIndex((f) => f.name === n);
	assert.equal(shown[at('[Gmail]/Sent Mail')].role, 'sent');
	assert.equal(shown[at('Sent')].role, '', 'the label carries no role it was not given');
	assert.ok(at('[Gmail]/Sent Mail') < at('Sent'), 'the role folder sits in the Sent place, above the label');
	assert.equal(p.M.label(ADDR, '[Gmail]/Sent Mail'), 'mail.folder.sent', 'the role folder is called Sent');
});

test('a server that names no roles at all falls back to the names', async () => {
	const gw = gateway(BARE), fs = store();
	const p = page(stored(true), gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.sentFolder(ADDR), 'INBOX.Sent Items');
	const role = (n) => p.M.folders(ADDR).find((f) => f.name === n).role;
	assert.equal(role('INBOX.Drafts'), 'drafts');
	assert.equal(role('INBOX.Deleted Items'), 'trash');
	assert.equal(role('INBOX.Spam'), 'junk');
	assert.equal(role('INBOX.Archive'), 'archive');
	assert.equal(role('INBOX.Clients'), '');
	assert.ok(p.M.refreshOf(ADDR, 'INBOX.Sent Items') > 0, 'the named Sent is followed');
	assert.ok(p.M.refreshOf(ADDR, 'INBOX.Archive') > 0, 'the named Archive is followed');
	assert.equal(p.M.refreshOf(ADDR, 'INBOX.Spam'), 0);
});

test('one role on the list turns the name fallback off', async () => {
	const gw = gateway([
		{ name: 'INBOX', selectable: true },
		{ name: 'Sent',  selectable: true },
		{ name: 'Outbox Copies', selectable: true, role: 'sent' },
	]), fs = store();
	const p = page(stored(true), gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.sentFolder(ADDR), 'Outbox Copies');
	assert.equal(p.M.refreshOf(ADDR, 'Sent'), 0);
});

// Dovecot as hello@oxedyne.com's server lists it: every role declared.
const DOVECOT = [
	{ name: 'INBOX',   selectable: true },
	{ name: 'Sent',    selectable: true, role: 'sent' },
	{ name: 'Drafts',  selectable: true, role: 'drafts' },
	{ name: 'Trash',   selectable: true, role: 'trash' },
	{ name: 'Junk',    selectable: true, role: 'junk' },
	{ name: 'Archive', selectable: true, role: 'archive' },
];

test('a Dovecot list: every declared role is honoured', async () => {
	const gw = gateway(DOVECOT), fs = store();
	const p = page(stored(true), gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.sentFolder(ADDR), 'Sent');
	assert.deepEqual(p.M.folders(ADDR).map((f) => f.name + ':' + f.role),
		['INBOX:', 'Drafts:drafts', 'Sent:sent', 'Archive:archive', 'Junk:junk', 'Trash:trash']);
	assert.ok(p.M.refreshOf(ADDR, 'Sent') > 0 && p.M.refreshOf(ADDR, 'Archive') > 0);
	for (const n of ['Drafts', 'Trash', 'Junk']) assert.equal(p.M.refreshOf(ADDR, n), 0, n);
	assert.equal(p.M.label(ADDR, 'Sent'), 'mail.folder.sent');
});

test('hoogland@, added before Sent was followed, with its inbox polling: its Sent is followed, no step from him', async () => {
	const gw = gateway(GMAIL), fs = store();
	const p = page(stored(false), gw, fs);			// refresh { INBOX: 900 }, no seed: set long ago
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.refreshOf(ADDR, '[Gmail]/Sent Mail'), 900, 'Sent follows on the inbox schedule');
	assert.equal(p.M.refreshOf(ADDR, 'Sent'), 0, 'the label is not');
	assert.equal(p.M.refreshOf(ADDR, '[Gmail]/All Mail'), 0);
	assert.equal(p.M.refreshOf(ADDR, 'INBOX'), 900, 'the inbox is untouched');
});

test('a Sent set to Manual by hand stays Manual on an existing mailbox', async () => {
	const ls = stored(false);
	const rec = JSON.parse(ls.getItem('daimond-mail'));
	rec.accounts[0].refresh['[Gmail]/Sent Mail'] = 0;
	ls.setItem('daimond-mail', JSON.stringify(rec));
	const p = page(ls, gateway(GMAIL), store());
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.refreshOf(ADDR, '[Gmail]/Sent Mail'), 0);
});

test('a role-less folder spelt like a role is told apart from the role folder on screen', async () => {
	const p = page(stored(true), gateway(GMAIL), store());
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(p.M.label(ADDR, 'Sent'), 'mail.own_folder Sent', 'two rows reading "Sent" are not offered');
});

// ── 2. The sent copy shows in Sent at once, and the server's copy replaces it ──

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const raw = (id, subj) => 'Message-ID: ' + id + '\r\nDate: Mon, 26 Oct 2026 21:57:35 +0800\r\n'
	+ 'From: ' + ADDR + '\r\nTo: kraig@k.test\r\nSubject: ' + subj + '\r\n\r\nHi.\r\n';
const idOf = (text) => (/^Message-ID: (.*)$/mi.exec(text) || [])[1].trim();

/// His Gmail with its folders listed, and one old message in the Thunderbird "Sent" label.
async function gmailPage() {
	const gw = gateway(GMAIL), fs = store();
	const p = page(stored(false), gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	fs.files.set(p.M.folderDir(ADDR, 'Sent') + '/cur/1.7.daimond:2,S', raw('<old@tb>', 'From 2019'));
	return { gw, fs, p };
}

test('a sent message shows in [Gmail]/Sent Mail at once, and nowhere else', async () => {
	const { gw, fs, p } = await gmailPage();
	await p.send();
	assert.equal(gw.sent.length, 1, 'one send reached the gateway');
	const dir = p.M.folderDir(ADDR, '[Gmail]/Sent Mail');
	const held = fs.under(dir + '/cur');
	assert.equal(held.length, 1, 'the copy is in the role-sent folder: ' + [...fs.files.keys()]);
	const wire = Buffer.from(gw.sent[0].raw, 'base64').toString('utf8');
	assert.equal(idOf(fs.files.get(held[0])), idOf(wire), 'the copy carries the Message-ID that went out');
	assert.equal(fs.under(p.M.folderDir(ADDR, 'Sent') + '/cur').length, 1, 'the label holds its one old message');
	assert.equal(fs.under('mail/' + ADDR + '/sent').length, 0, 'nothing in the retired place');
	assert.equal(p.M.counts(ADDR)['[Gmail]/Sent Mail'].count, 1, 'the Sent row counts it');
	await p.M.selectFolder('[Gmail]/Sent Mail');
	assert.equal(p.M.shown().length, 1, 'the Sent view shows it');
	assert.equal(p.M.shown()[0].subject, 'Hello Kraig');
});

test('when Sent syncs, the server copy with the same Message-ID replaces the local one', async () => {
	const { gw, fs, p } = await gmailPage();
	await p.send();
	const id = idOf(Buffer.from(gw.sent[0].raw, 'base64').toString('utf8'));
	gw.serve['[Gmail]/Sent Mail'] = [
		{ uid: 40, flags: ['\\Seen'], raw: b64(raw('<earlier@x>', 'Earlier')) },
		{ uid: 41, flags: ['\\Seen'], raw: b64(raw(id, 'Hello Kraig')) },
	];
	await p.M.selectFolder('[Gmail]/Sent Mail');
	p.M.sync();
	await settle();
	const held = fs.under(p.M.folderDir(ADDR, '[Gmail]/Sent Mail') + '/cur');
	assert.deepEqual(held.map((f) => f.split('/').pop()).sort(),
		['40.7.daimond:2,S', '41.7.daimond:2,S'], 'no duplicate: ' + held);
	assert.equal(p.M.counts(ADDR)['[Gmail]/Sent Mail'].count, 2);
});

test('a server that files no copy leaves the local one standing', async () => {
	const { gw, fs, p } = await gmailPage();
	await p.send();
	gw.serve['[Gmail]/Sent Mail'] = [{ uid: 40, flags: ['\\Seen'], raw: b64(raw('<other@x>', 'Other')) }];
	await p.M.selectFolder('[Gmail]/Sent Mail');
	p.M.sync();
	await settle();
	assert.equal(fs.under(p.M.folderDir(ADDR, '[Gmail]/Sent Mail') + '/cur').length, 2);
});

test('mail/<addr>/sent/ is moved into the role-sent folder, and the agent still finds what was sent', async () => {
	const gw = gateway(GMAIL), fs = store();
	const old = 'mail/' + ADDR + '/sent';
	fs.files.set(old + '/abc.eml', raw('<kraig-1@gmail.com>', 'Quote for Kraig'));
	fs.files.set(old + '/def.eml', raw('<on-server@gmail.com>', 'Already filed'));
	const p = page(stored(false), gw, fs);
	const sm = p.M.folderDir(ADDR, '[Gmail]/Sent Mail');
	fs.files.set(sm + '/cur/9.7.daimond:2,S', raw('<on-server@gmail.com>', 'Already filed'));
	await p.M.loadFolders(ADDR, true);
	await settle();
	assert.equal(fs.under(old).length, 0, 'the retired place is emptied');
	assert.equal(fs.under(sm + '/cur').length, 2, 'moved, and the one the server holds not doubled');
	const said = await p.M.toolList(JSON.stringify({ address: ADDR, folder: '[Gmail]/Sent Mail' }));
	assert.match(said, /Quote for Kraig/, 'mail_list on Sent answers "what did I send"');
	assert.match(said, /\[Gmail\]\/Sent Mail — 2 message\(s\) synced \(Sent\)/, 'and the listing says which folder is Sent');
});

// ── 3. Nothing fails silently ───────────────────────────────────────────────

const drafts = async (p) => { await p.M.refreshDrafts(); return p.M.drafts(); };

test('a send that fails stays as an unsent row with the true reason, and Retry sends it', async () => {
	const { gw, fs, p } = await gmailPage();
	gw.sendFails = '535 5.7.8 Username and Password not accepted';
	await assert.rejects(p.send(), /535/);
	let ds = await drafts(p);
	assert.equal(ds.length, 1, 'the message is kept, not lost with the compose panel');
	assert.match(ds[0].failed, /535 5\.7\.8 Username and Password not accepted/, 'the true reason');
	assert.equal(ds[0].subject, 'Hello Kraig');
	gw.sendFails = '';
	await p.M.retry(ds[0].path);
	await settle();
	assert.equal(gw.sent.length, 2);
	const wire = Buffer.from(gw.sent[1].raw, 'base64').toString('utf8');
	assert.doesNotMatch(wire, /X-Daimond/i, 'the failure mark never goes on the wire');
	assert.equal(idOf(wire), idOf(Buffer.from(gw.sent[0].raw, 'base64').toString('utf8')),
		'the retry is the same message');
	assert.equal((await drafts(p)).length, 0, 'sent, so no longer unsent');
	assert.equal(fs.under(p.M.folderDir(ADDR, '[Gmail]/Sent Mail') + '/cur').length, 1, 'and in Sent');
});

test('a retry that fails again keeps the row, with the new reason', async () => {
	const { gw, p } = await gmailPage();
	gw.sendFails = 'first';
	await assert.rejects(p.send());
	const path = (await drafts(p))[0].path;
	gw.sendFails = 'second';
	await p.M.retry(path);
	await settle();
	const ds = await drafts(p);
	assert.equal(ds.length, 1);
	assert.match(ds[0].failed, /second/);
	assert.match(p.M.said().err, /second/, 'and the panel says so');
});

test('a message being sent is visible as unsent until it has gone, and survives a reload meanwhile', async () => {
	const { gw, fs, p } = await gmailPage();
	let let_go;
	gw.hold = new Promise((r) => { let_go = r; });
	const going = p.send();
	await settle();
	const ds = await drafts(p);
	assert.equal(ds.length, 1, 'held as unsent while it is on its way');
	const q = page(stored(false), gateway(GMAIL), fs);	// the tab closed and opened again
	assert.equal((await drafts(q)).length, 1, 'still there after a reload');
	let_go();
	await going;
	assert.equal((await drafts(p)).length, 0, 'gone once sent');
});

test('a sent copy that cannot be written is said, not swallowed', async () => {
	const { gw, fs, p } = await gmailPage();
	fs.failWrites = /\/cur\/local\./;
	const j = await p.send();
	assert.equal(gw.sent.length, 1, 'the mail went');
	assert.match(j.copyErr || '', /quota exceeded/, 'the send answers why the copy is missing');
	p.compose().sent('Sent to kraig@k.test.');
	await settle();
	assert.match(p.M.said().err, /quota exceeded/, 'the panel shows it');
});
