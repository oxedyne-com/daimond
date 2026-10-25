// mailbeat.test.mjs -- what a device holds of each mail folder, said on the lens heartbeat
// as metadata only, so a sync can be proven without his session.
//
//	node --test www/js/mailbeat.test.mjs
//
// After mailfix went live (26 Oct 2026), "the 21:57 Kraig email is in [Gmail]/Sent Mail" could
// not be proven: the gateway names no folder and the lens carried no mail state. jarrah also
// showed hello@oxedyne.com pulling the same four messages twice. `DaimondMail.beat()` is what
// debugshare.js puts on the feed: per mailbox and folder `{role, count, newest, dups}`, where
// `dups` is how many Message-IDs the folder holds more than once. This drives the REAL mail.js
// against a scripted gateway and an in-memory file store, as mailsent.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

const NOW  = 1_700_000_000_000;
const ADDR = 'hoogland@gmail.com';
const KEYS = ['count', 'dups', 'f', 'mb', 'newest', 'role'];

const GMAIL = [
	{ name: 'INBOX',               selectable: true },
	{ name: 'Clients/Kraig Smith', selectable: true },
	{ name: '[Gmail]/Sent Mail',   selectable: true, role: 'sent' },
	{ name: '[Gmail]/Trash',       selectable: true, role: 'trash' },
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
		under(dir) { return [...this.files.keys()].filter((k) => k.startsWith(dir + '/')); },
	};
}

/// A gateway. `ignoreSince` answers every message whatever `since_uid` says, which is what
/// jarrah's "pulled 4 messages" twice in fifteen minutes looks like from the page.
function gateway(list) { return { list, serve: {}, ignoreSince: false }; }

function page(ls, gw, fs) {
	const w = makeWindow({ now: NOW, ls });
	w.setTimeout   = () => 1;
	w.clearTimeout = () => {};
	w.document.createElement  = () => elem();
	const panel = { querySelector: () => null };
	w.document.getElementById = (id) => (id === 'panel-mail' ? panel : elem());
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
				const since = gw.ignoreSince ? 0 : (body.since_uid || 0);
				return ok({ messages: (gw.serve[body.mailbox] || []).filter((m) => m.uid > since),
					uid_validity: 7, held_back: 0 });
			}
			return ok({ unlocked: true, accounts: [] });
		},
	};
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
	return {
		M, w,
		async sync(folder) {
			await M.selectFolder(folder);
			await settle();
			M.sync();
			await settle();
		},
	};
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

function stored() {
	const ls = makeWindow().localStorage;
	ls.setItem('daimond-mail', JSON.stringify({ sel: ADDR, accounts: [{
		address: ADDR, host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
		user: ADDR, pass: 'w', refresh: { INBOX: 900 }, folder: 'INBOX', touched: NOW - 1000,
	}] }));
	return ls;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const raw = (id, subj, date) => 'Message-ID: ' + id + '\r\nDate: ' + (date || 'Mon, 26 Oct 2026 21:57:35 +0800')
	+ '\r\nFrom: ' + ADDR + '\r\nTo: kraig@k.test\r\nSubject: ' + subj + '\r\n\r\nHi Kraig.\r\n';
const msg = (uid, id, subj, flags, date) => ({ uid, flags: flags || ['\\Seen'], raw: b64(raw(id, subj, date)) });

async function gmail() {
	const gw = gateway(GMAIL), fs = store(), ls = stored();
	const p = page(ls, gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	return { gw, fs, ls, p };
}

const row = (beat, f) => beat.find((r) => r.mb === ADDR && r.f === f);

// ── The shape ────────────────────────────────────────────────────────────────

test('each synced folder is one fixed-shape row: role, count, newest date, dups', async () => {
	const { gw, p } = await gmail();
	gw.serve.INBOX = [
		msg(1, '<a@x>', 'Earlier', null, 'Sun, 25 Oct 2026 08:00:00 +0000'),
		msg(2, '<b@x>', 'Later',   null, 'Mon, 26 Oct 2026 09:30:00 +0000'),
	];
	gw.serve['[Gmail]/Sent Mail'] = [msg(40, '<kraig@x>', 'Hello Kraig')];
	await p.sync('INBOX');
	await p.sync('[Gmail]/Sent Mail');
	const beat = p.M.beat();
	const inbox = row(beat, 'INBOX'), sent = row(beat, '[Gmail]/Sent Mail');
	assert.ok(inbox && sent, 'both synced folders are on the beat: ' + JSON.stringify(beat));
	beat.forEach((r) => assert.deepEqual(Object.keys(r).sort(), KEYS, 'fixed shape: ' + JSON.stringify(r)));
	assert.deepEqual(inbox, { mb: ADDR, f: 'INBOX', role: 'inbox', count: 2, newest: '2026-10-26', dups: 0 });
	assert.deepEqual(sent, { mb: ADDR, f: '[Gmail]/Sent Mail', role: 'sent', count: 1, newest: '2026-10-26', dups: 0 },
		'the 21:57 AWST message is the sent folder\'s newest, by its UTC date');
	assert.equal(row(beat, '[Gmail]/Trash'), undefined, 'a folder never synced says nothing');
});

test('dups counts each Message-ID the folder holds more than once', async () => {
	const { gw, p } = await gmail();
	gw.serve.INBOX = [
		msg(1, '<same@x>', 'One'), msg(2, '<same@x>', 'One again'),
		msg(3, '<also@x>', 'Two'), msg(4, '<also@x>', 'Two again'), msg(5, '<also@x>', 'Two thrice'),
		msg(6, '<alone@x>', 'Three'),
	];
	await p.sync('INBOX');
	const inbox = row(p.M.beat(), 'INBOX');
	assert.equal(inbox.count, 6);
	assert.equal(inbox.dups, 2, 'two ids are held more than once, however many copies each');
});

test('a folder of his own is named by a hash, never by what he called it', async () => {
	const { gw, p } = await gmail();
	gw.serve['Clients/Kraig Smith'] = [msg(9, '<c@x>', 'Invoice')];
	await p.sync('Clients/Kraig Smith');
	const beat = p.M.beat();
	const mine = beat.find((r) => r.role === '' && r.mb === ADDR);
	assert.ok(mine, 'the folder is on the beat: ' + JSON.stringify(beat));
	assert.match(mine.f, /^#[0-9a-z]+$/);
	assert.equal(mine.count, 1);
	assert.ok(!JSON.stringify(beat).includes('Kraig'), 'his folder name does not travel');
});

test('metadata only: no subject, sender, recipient or body leaves on the beat', async () => {
	const { gw, p } = await gmail();
	gw.serve.INBOX = [msg(1, '<secret-id@x>', 'Quarterly salary review')];
	gw.serve['[Gmail]/Sent Mail'] = [msg(40, '<kraig@x>', 'Hello Kraig')];
	await p.sync('INBOX');
	await p.sync('[Gmail]/Sent Mail');
	const text = JSON.stringify(p.M.beat());
	for (const bad of ['salary', 'Hello', 'kraig', 'k.test', 'secret-id', 'Hi Kraig', '21:57']) {
		assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), bad + ' must not be on the beat: ' + text);
	}
	const addrs = text.match(/[^\s"@]+@[^\s"@]+/g) || [];
	assert.deepEqual([...new Set(addrs)], [ADDR], 'no address but the mailbox\'s own');
});

test('a reload still reports what the folders held, with no sync yet', async () => {
	const { gw, ls, p } = await gmail();
	gw.serve.INBOX = [msg(1, '<a@x>', 'A'), msg(2, '<b@x>', 'B')];
	await p.sync('INBOX');
	const again = page(ls, gateway(GMAIL), store());
	assert.deepEqual(row(again.M.beat(), 'INBOX'),
		{ mb: ADDR, f: 'INBOX', role: 'inbox', count: 2, newest: '2026-10-26', dups: 0 });
});

test('bounded: at most twenty folders a mailbox, the inbox and role folders first', async () => {
	const many = [{ name: 'INBOX', selectable: true }, { name: '[Gmail]/Sent Mail', selectable: true, role: 'sent' }];
	for (let i = 0; i < 25; i++) many.push({ name: 'Box ' + String(i).padStart(2, '0'), selectable: true });
	const gw = gateway(many), fs = store();
	const p = page(stored(), gw, fs);
	await p.M.loadFolders(ADDR, true);
	await settle();
	for (const f of many) {
		gw.serve[f.name] = [msg(1, '<' + f.name.replace(/\W/g, '') + '@x>', 'x')];
		await p.sync(f.name);
	}
	const beat = p.M.beat().filter((r) => r.mb === ADDR);
	assert.equal(beat.length, 20);
	assert.equal(beat[0].f, 'INBOX');
	assert.equal(beat[1].role, 'sent');
});

test('signing out leaves nothing to report', async () => {
	const { gw, p } = await gmail();
	gw.serve.INBOX = [msg(1, '<a@x>', 'A')];
	await p.sync('INBOX');
	p.M.clear();
	assert.deepEqual(p.M.beat(), []);
});

// ── A re-pull after a reload ─────────────────────────────────────────────────

test('a re-pull of the same message, flags unchanged, overwrites rather than copies', async () => {
	const { gw, fs, ls, p } = await gmail();
	gw.serve.INBOX = [msg(1, '<a@x>', 'A'), msg(2, '<b@x>', 'B'), msg(3, '<c@x>', 'C'), msg(4, '<d@x>', 'D')];
	await p.sync('INBOX');
	gw.ignoreSince = true;				// the gateway hands the same four back
	const again = page(ls, gw, fs);
	await again.sync('INBOX');
	assert.equal(fs.under(again.M.folderDir(ADDR, 'INBOX') + '/cur').length, 4);
	assert.equal(row(again.M.beat(), 'INBOX').dups, 0);
});

// Was skipped as a mail.js defect; fixed by RESET-GEN part 3 (mail/resetgen c7a2acb69).
// `maildirName` puts the flags in the file name, so the same uid re-pulled with its flags
// changed on the server in between (read in Gmail's web view) is written under a SECOND name
// and the first is never removed: one message, two files, the folder count one too high. The
// beat's `dups` reports it, which is how it will be seen on a live device. Remove `skip` when
// syncOne replaces a uid's existing file whatever its flags.
test('a re-pull after reload, flags changed on the server, stores no second copy', async () => {
	const { gw, fs, ls, p } = await gmail();
	gw.serve.INBOX = [msg(1, '<a@x>', 'A', [])];
	await p.sync('INBOX');
	gw.ignoreSince = true;
	gw.serve.INBOX = [msg(1, '<a@x>', 'A', ['\\Seen'])];
	const again = page(ls, gw, fs);
	await again.sync('INBOX');
	assert.equal(fs.under(again.M.folderDir(ADDR, 'INBOX') + '/cur').length, 1,
		'one message, one file: ' + fs.under(again.M.folderDir(ADDR, 'INBOX') + '/cur'));
	assert.equal(row(again.M.beat(), 'INBOX').dups, 0);
});

// The same scenario, not skipped, asserting what the beat says TODAY, so the instrument is
// proven to see the defect it exists to see.
test('the beat sees the copy a changed-flags re-pull leaves', async () => {
	const { gw, fs, ls, p } = await gmail();
	gw.serve.INBOX = [msg(1, '<a@x>', 'A', [])];
	await p.sync('INBOX');
	gw.ignoreSince = true;
	gw.serve.INBOX = [msg(1, '<a@x>', 'A', ['\\Seen'])];
	const again = page(ls, gw, fs);
	await again.sync('INBOX');
	const held = fs.under(again.M.folderDir(ADDR, 'INBOX') + '/cur').length;
	assert.equal(row(again.M.beat(), 'INBOX').dups, held > 1 ? 1 : 0, held + ' file(s) held');
});
