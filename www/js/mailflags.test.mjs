// mailbeat.test.mjs -- what a device holds of each mail folder: the re-pull cases.
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
//
// RESET-GEN part 3 (D-20261026-01) brings only the changed-flags re-pull test here from
// daimond-b's `fire/mailbeat` (bac88235e), where it was skipped as a mail.js defect, with the
// helpers it needs. `beat()` lives on that branch, so its `dups` assertion runs only where
// mail.js has it; the file count is the defect's own measure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

const NOW  = 1_700_000_000_000;
const ADDR = 'hoogland@gmail.com';

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

// ── A re-pull after a reload ─────────────────────────────────────────────────

// `maildirName` puts the flags in the file name, so the same uid re-pulled with its flags
// changed on the server in between (read in Gmail's web view) was written under a SECOND name
// and the first never removed: one message, two files, the folder count one too high.
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
	if (again.M.beat) assert.equal(row(again.M.beat(), 'INBOX').dups, 0);
});
