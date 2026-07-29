// verify_mailfolders.mjs — a mailbox is not an inbox.
//
// Until now the client asked the server for INBOX and nothing else, so every
// other folder a person has — Sent, Archive, the one they filed a project in —
// was unreachable from Daimond. The gateway grew `POST /api/mail/folders`
// (a LIST, free, same gates as a sync); this drives the client side of it.
//
// Two halves, because one fixture cannot pose both questions:
//
//   A. THE REAL WIRE. fe2o3's imap_test_server now serves seven folders, five
//      of them carrying an RFC 6154 role, one of them an ordinary nested name
//      with a space in it. Everything here goes through the real route, the
//      real IMAP conversation and the real per-folder Maildir on disk.
//
//   B. THE GMAIL SHAPE, which the fixture cannot produce: a `\Noselect`
//      container, a folder whose NAME is in another language but whose ROLE is
//      not, and All Mail. The route is stubbed for this half only; everything
//      below the fetch — the shaping, the ordering, the labelling, the picker
//      — is the real code.
//
// Needs: the gateway with `dev_insecure` on the mail routes (dev/devgw.sh), the
// IMAP fixture on 127.0.0.1:1143, and the `email` entitlement plus Pro on the
// harness's fixed account. run_all's phase 2 provisions all of that.
import { open, shot, scratch } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'compose', connect: false, profile: scratch('compose-profile') });
const p = s.page;

// Start from a mailbox with no folders on disk, so what appears was fetched by
// this run rather than left by the last one.
await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	try {
		const mail = await root.getDirectoryHandle('mail');
		await mail.removeEntry('alice@test.local', { recursive: true });
	} catch (e) { /* no mailbox yet, which is the state being asked for */ }
});

// Seed the account the way the add-dialog would, but pointed at the fixture:
// the dialog infers security from the port and offers no plaintext, so a
// loopback test server can only be reached by seeding the record.
await p.evaluate(async () => {
	const pass = await window.DaimondIdentity.wrap('test-app-password');
	localStorage.setItem('daimond-mail', JSON.stringify({
		accounts: [{
			address: 'alice@test.local',
			host: '127.0.0.1', port: 1143, security: 'plain',
			smtpHost: '127.0.0.1', smtpPort: 1587, smtpSecurity: 'plain',
			user: 'alice@test.local', pass,
			folder: 'INBOX', folders: {}, lastSync: 0,
		}],
		sel: 'alice@test.local',
	}));
	window.DaimondMail.reload();
	window.DaimondPanels.show('mail');
	window.DaimondMail.onOpen();
});

// ── A. The real wire ─────────────────────────────────────────────────

await p.waitForFunction(
	() => window.DaimondMail.folders('alice@test.local').length > 1,
	{ timeout: 25000 },
).catch(() => {});
const got = await p.evaluate(() => window.DaimondMail.folders('alice@test.local'));
check('the server is asked what folders it has', got.length >= 7,
	got.length + ': ' + got.map(f => f.name).join(', '));

const byName = Object.fromEntries(got.map(f => [f.name, f]));
check('the inbox is there',        !!byName.INBOX);
check('a role comes back with it', byName.Sent && byName.Sent.role === 'sent',
	byName.Sent ? byName.Sent.role : 'no Sent');
check('every special-use folder is named by its role',
	['Sent', 'Drafts', 'Archive', 'Junk', 'Trash']
		.every(n => byName[n] && byName[n].role),
	['Sent', 'Drafts', 'Archive', 'Junk', 'Trash']
		.map(n => n + '=' + ((byName[n] || {}).role || '-')).join(' '));
check('an ordinary folder comes back by its own name',
	!!byName['Projects/Bourke Street'],
	Object.keys(byName).join(' | '));

// The picker itself: what a person sees and can click.
const rows = await p.$$eval('#mail-folders .mail-folder', els => els.map(e => ({
	name:  e.getAttribute('data-folder'),
	role:  e.getAttribute('data-role') || '',
	label: e.textContent.trim(),
	on:    e.classList.contains('on'),
	off:   e.getAttribute('aria-disabled') === 'true',
})));
check('the picker offers every folder', rows.length >= 7,
	rows.length + ' rows: ' + rows.map(r => r.label).join(', '));
check('a role-labelled folder reads in the interface language, not the server\'s',
	rows.some(r => r.name === 'Sent' && r.label === 'Sent')
		&& rows.some(r => r.name === 'Trash' && r.label === 'Bin')
		&& rows.some(r => r.name === 'Junk' && r.label === 'Spam'),
	rows.map(r => r.name + '→' + r.label).join(', '));
check('an ordinary folder keeps the server\'s own spelling',
	rows.some(r => r.name === 'Projects/Bourke Street'
		&& r.label === 'Projects/Bourke Street'));
check('the inbox is the one selected', rows.filter(r => r.on).length === 1
	&& rows.find(r => r.on).name === 'INBOX',
	rows.filter(r => r.on).map(r => r.name).join(', ') || 'none');
check('the inbox is listed first', rows[0] && rows[0].name === 'INBOX',
	rows[0] ? rows[0].name : 'no rows');

// Sync the inbox, so there is something to tell one folder from another by.
await p.evaluate(() => window.DaimondMail.sync());
await p.waitForSelector('.mail-msg', { timeout: 25000 }).catch(() => {});
const inboxSubjects = await p.$$eval('.mail-msg .mail-subj', els => els.map(e => e.textContent));
check('the inbox syncs', inboxSubjects.length >= 3, inboxSubjects.join(' | '));

// ── Switching folder ─────────────────────────────────────────────────

const clicked = await p.evaluate(() => {
	const row = [...document.querySelectorAll('#mail-folders .mail-folder')]
		.find(e => e.getAttribute('data-folder') === 'Sent');
	if (!row) return false;
	row.click();
	return true;
});
check('Sent can be clicked in the picker', clicked,
	clicked ? '' : 'no row for it — the picker is not drawn');
await p.waitForFunction(
	() => window.DaimondMail.folder() === 'Sent'
		&& [...document.querySelectorAll('.mail-msg .mail-subj')]
			.some(e => /Thursday works/.test(e.textContent)),
	{ timeout: 25000 },
).catch(() => {});
const sentSubjects = await p.$$eval('.mail-msg .mail-subj', els => els.map(e => e.textContent));
check('choosing a folder fetches THAT folder',
	sentSubjects.some(t => /Thursday works/.test(t))
		&& !sentSubjects.some(t => /Your statement is ready/.test(t)),
	sentSubjects.join(' | ') || 'empty');
check('the picker follows the choice',
	await p.evaluate(() => {
		const on = document.querySelector('#mail-folders .mail-folder.on');
		return !!on && on.getAttribute('data-folder') === 'Sent';
	}));

// Two folders, two places on disk, two watermarks. A single shared `lastUid`
// would make the second folder's first sync ask for mail newer than a UID that
// belongs to a different mailbox entirely.
const disk = await p.evaluate(async () => {
	const walk = async (dir, path) => {
		const out = [];
		for await (const [name, h] of dir.entries()) {
			if (h.kind === 'directory') out.push(...await walk(h, path + name + '/'));
			else out.push(path + name);
		}
		return out;
	};
	const root = await navigator.storage.getDirectory();
	const mail = await root.getDirectoryHandle('mail');
	return await walk(mail, 'mail/');
});
check('each folder has its own Maildir',
	disk.some(f => /^mail\/alice@test\.local\/INBOX\/cur\//.test(f))
		&& disk.some(f => /^mail\/alice@test\.local\/Sent\/cur\//.test(f)),
	disk.filter(f => /cur\//.test(f)).slice(0, 6).join(', '));
check('each folder has its own digest for the agents',
	disk.includes('mail/alice@test.local/INBOX/index.md')
		&& disk.includes('mail/alice@test.local/Sent/index.md'),
	disk.filter(f => /index\.md$/.test(f)).join(', '));

const marks = await p.evaluate(() => {
	const j = JSON.parse(localStorage.getItem('daimond-mail'));
	const a = j.accounts[0];
	return Object.fromEntries(Object.entries(a.folders)
		.map(([k, v]) => [k, { dir: v.dir, lastUid: v.lastUid, uidValidity: v.uidValidity }]));
});
check('the UID watermarks are kept per folder',
	marks.INBOX && marks.Sent && marks.INBOX.lastUid > 0 && marks.Sent.lastUid > 0,
	JSON.stringify(marks));

// A name with a slash and a space in it cannot be a directory. It must still
// land somewhere, and somewhere that another name cannot collide with.
await p.evaluate(() => window.DaimondMail.selectFolder('Projects/Bourke Street'));
// `selectFolder` returns as soon as the choice is made; the mail behind it is a
// round trip away, so wait for the mail, not for the choice.
await p.waitForFunction(
	() => window.DaimondMail.folder() === 'Projects/Bourke Street'
		&& [...document.querySelectorAll('.mail-msg .mail-subj')]
			.some(e => /The new place/.test(e.textContent)),
	{ timeout: 25000 },
).catch(() => {});
const projDir = await p.evaluate(() => window.DaimondMail.folderDir(null, 'Projects/Bourke Street'));
check('an awkward folder name is flattened onto a path safely',
	/^mail\/alice@test\.local\/[A-Za-z0-9._-]+$/.test(projDir) && !/[/ ]/.test(projDir.split('/')[2]),
	projDir);
const projSubjects = await p.$$eval('.mail-msg .mail-subj', els => els.map(e => e.textContent));
check('and its mail arrives under it',
	projSubjects.some(t => /The new place/.test(t)), projSubjects.join(' | ') || 'empty');

await p.evaluate(() => window.DaimondMail.selectFolder('INBOX'));
await p.waitForTimeout(1200);
await shot(s, 'mailfolders-dark');
await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await p.waitForTimeout(400);
await shot(s, 'mailfolders-light');
await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'lollypop'));
await p.waitForTimeout(400);
await shot(s, 'mailfolders-lollypop');
await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

// ── B. The Gmail shape ───────────────────────────────────────────────
//
// Gmail's folder list is the awkward one: `[Gmail]` is a container that holds
// no mail, the names underneath it are in the account's own language, and All
// Mail is a copy of everything. Only the fetch is stubbed.
await p.evaluate(() => {
	const real = window.fetch;
	window.fetch = function (url, opts) {
		if (String(url).indexOf('/api/mail/folders') === 0) {
			return Promise.resolve(new Response(JSON.stringify({
				ok: true,
				folders: [
					{ name: 'INBOX',              selectable: true,  attrs: ['\\HasNoChildren'], delimiter: '/' },
					{ name: '[Gmail]',            selectable: false, attrs: ['\\Noselect', '\\HasChildren'], delimiter: '/' },
					{ name: '[Gmail]/Gesendet',   selectable: true,  attrs: ['\\Sent'],    delimiter: '/', role: 'sent' },
					{ name: '[Gmail]/Entwürfe',   selectable: true,  attrs: ['\\Drafts'],  delimiter: '/', role: 'drafts' },
					{ name: '[Gmail]/Papierkorb', selectable: true,  attrs: ['\\Trash'],   delimiter: '/', role: 'trash' },
					{ name: '[Gmail]/Alle Nachrichten', selectable: true, attrs: ['\\All'], delimiter: '/', role: 'all' },
					{ name: 'Rechnungen',         selectable: true,  attrs: ['\\HasNoChildren'], delimiter: '/' },
				],
			}), { status: 200, headers: { 'content-type': 'application/json' } }));
		}
		return real.apply(this, arguments);
	};
});
await p.evaluate(() => window.DaimondMail.loadFolders('alice@test.local', true));
await p.waitForFunction(
	() => window.DaimondMail.folders('alice@test.local').some(f => f.role === 'all'),
	{ timeout: 15000 },
).catch(() => {});

const g = await p.$$eval('#mail-folders .mail-folder', els => els.map(e => ({
	name:  e.getAttribute('data-folder'),
	role:  e.getAttribute('data-role') || '',
	label: e.textContent.trim(),
	on:    e.classList.contains('on'),
	off:   e.getAttribute('aria-disabled') === 'true',
})));
const find = n => g.find(r => r.name === n) || {};
check('a folder named in another language is known by its role',
	find('[Gmail]/Gesendet').label === 'Sent'
		&& find('[Gmail]/Papierkorb').label === 'Bin',
	g.map(r => r.name + '→' + r.label).join(', '));
check('a container is shown but cannot be chosen', find('[Gmail]').off === true,
	JSON.stringify(find('[Gmail]')));
check('every other folder can be chosen',
	g.filter(r => r.name !== '[Gmail]').every(r => r.off !== true));
check('All Mail is offered', !!find('[Gmail]/Alle Nachrichten').name
	&& find('[Gmail]/Alle Nachrichten').label === 'All mail',
	find('[Gmail]/Alle Nachrichten').label);
check('but All Mail is NOT what the panel opens on',
	g.filter(r => r.on).length === 1 && g.find(r => r.on).name === 'INBOX',
	g.filter(r => r.on).map(r => r.name).join(', ') || 'none');
check('All Mail sorts last, where a duplicate of everything belongs',
	g[g.length - 1] && g[g.length - 1].name === '[Gmail]/Alle Nachrichten',
	g.map(r => r.name).join(' > '));
// The picture of the Gmail shape, taken BEFORE the next check replaces the
// folder list with one holding nothing but the inbox.
await shot(s, 'mailfolders-gmail');

check('a folder the server no longer offers stops being the selected one',
	await p.evaluate(async () => {
		await window.DaimondMail.selectFolder('Rechnungen');
		await new Promise(r => setTimeout(r, 800));
		const before = window.DaimondMail.folder();
		// The next answer drops it.
		const real = window.fetch;
		window.fetch = function (url) {
			if (String(url).indexOf('/api/mail/folders') === 0) {
				return Promise.resolve(new Response(JSON.stringify({
					ok: true, folders: [{ name: 'INBOX', selectable: true, attrs: [] }],
				}), { status: 200, headers: { 'content-type': 'application/json' } }));
			}
			return real.apply(this, arguments);
		};
		await window.DaimondMail.loadFolders('alice@test.local', true);
		await new Promise(r => setTimeout(r, 800));
		return before === 'Rechnungen' && window.DaimondMail.folder() === 'INBOX';
	}));

console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404/.test(e)).slice(0, 5));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
