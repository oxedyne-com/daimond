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
import { IMAP_PORT, SMTP_PORT } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'compose', connect: false, profile: scratch('compose-profile') });
const p = s.page;

// Start from a mailbox with no folders on disk, so what appears was fetched by
// this run rather than left by the last one.
//
// THROUGH `DaimondCloud.opfsRoot()`, NOT `navigator.storage.getDirectory()`. The
// two are different directories for every account but the primary: the app's
// files live under `d~<id>/`, and this profile's account is not the primary. So
// this wipe hit an empty top-level `mail/` and left the real one untouched — for
// every run this file has ever had.
//
// What that cost: `Sent` kept one message from the first run that ever synced it,
// `selectFolder` correctly declined to fetch a folder that already had mail on
// screen, and the watermark check below therefore read 0/0 and was blamed on the
// product. It also meant EVERY other check here was reading whatever the last run
// left, so a green line proved nothing about this one. Nine generations of the
// same message were on disk by the time it was measured.
const wiped = await p.evaluate(async () => {
	// BOTH copies. Deleting the local one alone is not a wipe: the account holds this
	// mailbox on the server as well, and the next pull puts the old run's copy
	// straight back — under its ORIGINAL name, so it reads as a message that arrived
	// rather than one that was restored. A small message rides inline in the sync
	// parcel and a large attachment is offloaded to cloud storage, so both have to go.
	const wipeOnce = async () => {
		let forgotten = 0;
		try {
			Object.keys(DaimondCloud.index() || {}).forEach((path) => {
				if (path.indexOf('mail/alice@test.local/') === 0) {
					DaimondCloud.forget(path); forgotten++;
				}
			});
		} catch (e) { /* no cloud on this profile, which is also a clean slate */ }
		const root = await DaimondCloud.opfsRoot();
		let mail;
		try { mail = await root.getDirectoryHandle('mail'); }
		catch (e) { return { how: 'no mail dir', forgotten }; }
		try { await mail.removeEntry('alice@test.local', { recursive: true }); }
		catch (e) { return { how: 'no mailbox yet', forgotten }; }
		// Prove it: a wipe that silently did nothing is what put this file wrong.
		for await (const [n] of mail.entries()) if (n === 'alice@test.local') return { how: 'STILL THERE', forgotten };
		return { how: 'wiped', forgotten };
	};
	const held = async () => {
		try {
			const root = await DaimondCloud.opfsRoot();
			await (await root.getDirectoryHandle('mail')).getDirectoryHandle('alice@test.local');
			return true;
		} catch (e) { return false; }
	};
	// AND THE COPY ON THE SERVER, which is the half that was missing. Every Maildir
	// message is a workspace file, and workspace files ride in the sync parcel; the
	// gateway holds the last one this account pushed. So the pull that follows this
	// wipe finds files the device no longer has and adopts them — `applyFiles` in
	// daimond.js, "only remote: adopt" — under their ORIGINAL names, carrying the
	// PREVIOUS run's uidValidity. That is right of the product: a file missing here
	// and present there is a file this device has not seen yet, and there is no
	// tombstone to say otherwise. It is only wrong of a fixture that deleted it
	// behind the app's back.
	//
	// A push is what makes the deletion true on both sides: the census it carries is
	// complete and no longer names the mailbox, so the parcel the gateway keeps stops
	// holding it and no later pull can put it back. Looped, because a pull already in
	// flight can restore between the wipe and the push, and because `push` declines
	// while another is running rather than queueing.
	//
	// WITHOUT THIS the run reads the last run's mail: `selectFolder` correctly
	// declines to fetch a folder that already has mail on screen, so Sent is never
	// synced, its watermarks stay at zero, and the check below is read as a defect in
	// the product. Measured on 2026-08-24: one run against a fresh profile passed
	// 28/28, a second against the same profile failed on exactly that check.
	// AND THE ENGINE IS QUIET BEFORE AND AFTER, WHICH IS WHAT CLOSES THE RACE.
	//
	// Sleeping 1200ms and asking whether the mailbox came back only NARROWS the window: a
	// pull already in flight when the loop exits lands afterwards, adopts the previous
	// run's mail back -- correctly, since a file the gateway holds and this device does
	// not is one this device has not seen -- and every check below then reads it. Measured
	// on 2026-08-24 over eight consecutive cold runs: six passed, and runs 4 and 5 failed
	// with two and three uidValidity generations on disk. BOTH failures reported
	// `wiped (0 forgotten)` with no `came back, wiping again`, so the loop was satisfied
	// when it exited and the restore arrived after it. A wait cannot see a round it does
	// not know about, so `DaimondSync.state().quiet` was added (www/js/sync.js) to say
	// whether one is running OR armed, and this waits for it rather than for a clock.
	const quiet = async (ms) => {
		const until = Date.now() + ms;
		for (;;) {
			let st;
			try { st = DaimondSync.state(); } catch (e) { return 'no sync here'; }
			if (st.quiet) return '';
			if (Date.now() > until) return 'still ' + (st.busyWith || 'busy');
			await new Promise((r) => setTimeout(r, 100));
		}
	};
	let last = { how: 'no mail dir', forgotten: 0 }, note = [];
	// FIRST: nothing may be in flight when the wipe begins, or the wipe races the round
	// that is already reading the mailbox it is about to delete.
	const before = await quiet(20000);
	if (before) note.push('did not go quiet before the wipe (' + before + ')');
	// THE LOOP MAKES THE RESTORE HAPPEN RATHER THAN WAITING TO SEE IF IT WILL.
	//
	// Waiting for quiet is not enough and was measured not to be: 6 of 8 cold runs on
	// 2026-08-24, with the two failures reporting `wiped (0 forgotten)` and no complaint
	// from `quiet` at all. A pull can be BEGUN after this device went quiet -- the wake
	// channel hears a version it has not got and starts one -- so "nothing is running"
	// is not "nothing is coming", and no amount of waiting makes it so.
	//
	// So each turn of the loop deletes, pushes, and then PULLS ON PURPOSE. If the gateway
	// still holds the mailbox, that pull adopts it back HERE, inside the loop, where the
	// next turn deletes it again; if it does not, the mailbox stays gone and the loop ends
	// on a device that has just pulled and still has no mail. That is a fixed point rather
	// than a quiet moment, and a later pull can restore nothing because there is nothing
	// at the far end to restore.
	for (let i = 0; i < 6; i++) {
		last = await wipeOnce();
		if (last.how === 'STILL THERE') break;
		if (!window.DaimondSync || !DaimondSync.push) { note.push('no sync here'); break; }
		try { await DaimondSync.push(); } catch (e) { note.push('push threw'); }
		const after = await quiet(20000);
		if (after) note.push('did not go quiet after the push (' + after + ')');
		// WHAT THE PUSH ACTUALLY SENT, recorded because it decides whether the far end may
		// drop the mailbox at all: only a COMPLETE census entitles the receiver to delete by
		// absence (`collectSync`, `applyFiles`). An incomplete one leaves the gateway holding
		// what this device just deleted, and no number of pushes will take it away.
		try {
			const par = await DaimondSync.parcel();
			if (par && par.filesComplete !== true) note.push('census INCOMPLETE at push ' + (i + 1));
		} catch (e) { /* nothing to say about a parcel that could not be built */ }
		// The restore, forced.
		try { await DaimondSync.pull(); } catch (e) { note.push('pull threw'); }
		const pulled = await quiet(20000);
		if (pulled) note.push('did not go quiet after the pull (' + pulled + ')');
		if (!await held()) break;
		note.push('came back, wiping again');
	}
	const settled = await quiet(20000);
	if (settled) note.push('did not settle (' + settled + ')');
	const back = await held();
	return last.how + ' (' + last.forgotten + ' forgotten'
		+ (note.length ? '; ' + note.join('; ') : '') + ')'
		+ (back ? ' — AND THE SERVER PUT IT BACK' : '');
});
check('the mailbox on disk is cleared before the run, in the root the app uses',
	/^(wiped|no mail dir|no mailbox yet)/.test(wiped) && !/PUT IT BACK/.test(wiped), wiped);

// Seed the account the way the add-dialog would, but pointed at the fixture:
// the dialog infers security from the port and offers no plaintext, so a
// loopback test server can only be reached by seeding the record.
await p.evaluate(async (PORTS) => {
	const pass = await window.DaimondIdentity.wrap('test-app-password');
	localStorage.setItem('daimond-mail', JSON.stringify({
		accounts: [{
			address: 'alice@test.local',
			host: '127.0.0.1', port: PORTS.imap, security: 'plain',
			smtpHost: '127.0.0.1', smtpPort: PORTS.smtp, smtpSecurity: 'plain',
			user: 'alice@test.local', pass,
			folder: 'INBOX', folders: {}, lastSync: 0,
		}],
		sel: 'alice@test.local',
	}));
	window.DaimondMail.reload();
	window.DaimondPanels.show('mail');
	window.DaimondMail.onOpen();
}, { imap: IMAP_PORT, smtp: SMTP_PORT });

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
//
// `label` reads `.mail-addr`, the span holding the NAME, and not the row -- see
// the note at the second reader below. There are two of these blocks in this
// file and they must agree; fixing only the other one moved the failure from
// "All Mail is offered" to "an ordinary folder keeps the server's own spelling"
// and taught nothing.
const rows = await p.$$eval('#mail-folders .mail-folder', els => els.map(e => ({
	name:  e.getAttribute('data-folder'),
	role:  e.getAttribute('data-role') || '',
	label: (e.querySelector('.mail-addr') || e).textContent.trim(),
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
// WHOSE MAIL IS THIS? A Maildir name is `<uid>.<uidValidity>.daimond:2,`, and the
// fixture mints a fresh `uidValidity` every time it starts — so a file stamped with
// a generation this run never saw is a file from a previous run.
//
// That is not hypothetical. The wipe above empties the directory, and older
// generations reappeared during the run anyway: the pull that follows adopts every
// mail file the gateway's parcel still held, which is why the wipe above now clears
// the server's copy too. Every check above was otherwise reading whatever the last
// run left, and a green line proved nothing about this one.
//
// Checked rather than tolerated, because the failure it caused was invisible: with
// one stale message already in `Sent`, `selectFolder` correctly declines to fetch a
// folder that has mail on screen — so Sent was never synced, its watermarks stayed
// at zero, and the check below was read as a defect in the product for two
// sessions running.
// `%3A`, NOT `:`. A colon is not a legal OPFS name, so `src/fsname.rs` escapes it
// and every message on disk is `<uid>.<uidValidity>.daimond%3A2,`. This read
// `\.daimond:2,` and therefore matched NOTHING, in every run this file has ever
// had: it reported "0 uidValidity generations on disk" and passed while the check
// three lines above was listing two of them. The one guard against a run reading
// the last run's mail was inert for the whole of its life. Both spellings are
// accepted because the tolerance in `diskNameIn` means either can be met.
const gens = new Set(disk.filter(f => /\.daimond(?::|%3A)2,/.test(f))
	.map(f => (f.split('/').pop() || '').split('.')[1]).filter(Boolean));
check('the mail on disk is from THIS run, not restored from an earlier one',
	gens.size <= 1,
	gens.size + ' uidValidity generations on disk: ' + [...gens].join(', ')
		+ (gens.size > 1 ? ' — cloud residency is putting earlier runs back; every check '
			+ 'in this file above is reading them' : ''));

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

// The NAME is `.mail-addr`, not the row. Phase G put a count and an age beside
// it, so the row's own textContent reads `All mailnever—` and every label check
// here failed against an app that was drawing the name correctly. Reading the
// element that holds the thing being asserted is the fix; the count phrase is
// `verify_mailrefresh`'s to prove, and it does so against broken code.
const g = await p.$$eval('#mail-folders .mail-folder', els => els.map(e => ({
	name:  e.getAttribute('data-folder'),
	role:  e.getAttribute('data-role') || '',
	label: (e.querySelector('.mail-addr') || e).textContent.trim(),
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
