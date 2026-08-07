// verify_mailsync.mjs — a mailbox configured on one device works on the other.
//
// Sync carried the chats, the Diamonds, the workspace and the provider keys, and
// left the mail behind: a paired device showed an empty Mail panel and the user
// had to find their app password again and type the whole account back in. The
// accounts travel now, WORKING — the wrapped password goes with them, because
// both devices hold the same identity and what opens here opens there, and the
// parcel is sealed over the top of it exactly as the sealed provider keys are.
//
// What must NOT travel is the per-folder state. Every UID, uidvalidity and
// watermark under `folders` describes what is on THIS device's disk; carried
// across it would tell the other device it already holds mail it has never
// downloaded. It is rebuilt in one sync per folder and cannot be wrong.
//
// And a deletion has to travel as a DELETION. The merge is a union, so a mailbox
// removed here and still held there comes straight back on the next pull, with
// its password, and the seat given up at the gateway is taken again. That is what
// the tombstone is for.
//
//   node dev/verify_mailsync.mjs
//
// Needs the app (DAIMOND_PORT, default 8777) and the gateway on :9002 (sync is Pro-
// gated, so the account is granted Pro the one way the gateway grants it).
import { open, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Push, and wait until the parcel has actually LANDED. A push that finds
/// another in flight only reschedules, so awaiting it proves nothing; the server
/// version advancing is the only honest signal one made it.
async function pushLanded(pg) {
	const landed = await pg.evaluate(async () => {
		const v0 = window.DaimondSync.state().version;
		const t0 = Date.now();
		while (window.DaimondSync.state().version <= v0 && Date.now() - t0 < 8000) {
			await window.DaimondSync.push();
			await new Promise(r => setTimeout(r, 150));
		}
		return window.DaimondSync.state().version > v0;
	});
	if (!landed) console.log('  note  pushLanded: version did not advance within 8s');
	return landed;
}

const ADDR = 'sync-alice@example.com';
const PW   = 'app-password-' + '3141';

const s = await open({ name: 'mailsync', signIn: true, connect: true });
const { page } = s;

await page.waitForFunction(
	() => !!window.DaimondSync && !!window.DaimondCore && !!window.DaimondMail
		&& !!window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
	const lic = await makePagePro(page, GWDIR);
	check('the account holds Pro, so mail and sync are both open to it',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);

	// ── 1. The module offers the parcel at all ────────────────────────
	const api = await page.evaluate(() => ({
		exportSync: typeof window.DaimondMail.exportSync === 'function',
		applySync:  typeof window.DaimondMail.applySync  === 'function',
	}));
	check('mail.js offers exportSync/applySync for the parcel',
		api.exportSync && api.applySync, JSON.stringify(api));
	if (!api.exportSync || !api.applySync) throw new Error('no mail sync API to test');

	// ── 2. Add a mailbox the way a person does ────────────────────────
	// Through the panel's own button and the real dialog, so what is measured
	// below is what the add path actually writes — including the stamp the merge
	// decides on, which a hand-seeded record would simply be given.
	await page.evaluate(() => {
		window.DaimondPanels.show('mail');
		window.DaimondMail.onOpen();
	});
	await page.waitForTimeout(1200);
	await page.click('[data-act="mail-add"]', { force: true });
	await page.waitForSelector('#admin-form .dlg-input', { timeout: 8000 });
	const fields = await page.$$('#admin-form .dlg-input');
	check('the add-a-mailbox form asks for the six things a mailbox needs',
		fields.length === 6, fields.length + ' fields');
	// Address first: typing it guesses the servers, and a guess must not land on
	// top of something already typed.
	await fields[0].fill(ADDR);
	await page.waitForTimeout(200);
	await fields[1].fill(PW);
	await fields[2].fill('imap.example.com');
	await fields[3].fill('993');
	await fields[4].fill('smtp.example.com');
	await fields[5].fill('587');
	await page.click('#admin-form .dlg-ok', { force: true });
	await page.waitForTimeout(1200);

	const added = await page.evaluate(async (addr) => {
		const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const a = (j.accounts || []).find(x => x.address === addr);
		if (!a) return { present: false };
		return {
			present:  true,
			touched:  a.touched || 0,
			host:     a.host,
			port:     a.port,
			user:     a.user,
			wrapped:  !!a.pass,
			opens:    await window.DaimondIdentity.unwrap(a.pass).then(v => !!v).catch(() => false),
		};
	}, ADDR);
	check('the mailbox was added through the real dialog', added.present === true,
		JSON.stringify(added).slice(0, 120));
	check('and carries a stamp for the merge to decide on',
		added.touched > 0, 'touched=' + added.touched);

	// ── 3. What the export carries, and what it leaves behind ─────────
	const ex = await page.evaluate((addr) => {
		const M = window.DaimondMail;
		// Give the account some folder state, which is exactly what must NOT travel.
		const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const a = (j.accounts || []).find(x => x.address === addr);
		a.folders = { INBOX: { dir: 'INBOX', uidValidity: 42, lastUid: 9001, firstUid: 12,
			heldBack: 3, limit: 50, lastSync: Date.now() } };
		a.folder = 'Archive';
		a.lastSync = Date.now();
		localStorage.setItem('daimond-mail', JSON.stringify(j));
		M.reload();
		const e1 = JSON.stringify(M.exportSync());
		const e2 = JSON.stringify(M.exportSync());
		const row = M.exportSync().accounts.find(x => x.address === addr) || {};
		return {
			deterministic: e1 === e2,
			bytes:         e1.length,
			row:           row,
			keys:          Object.keys(row),
			plaintext:     e1.indexOf('app-password-' + '3141') !== -1,
			hasFolders:    e1.indexOf('uidValidity') !== -1 || e1.indexOf('9001') !== -1,
			hasSel:        typeof M.exportSync().sel === 'string',
		};
	}, ADDR);
	check('two exports of one mailbox list are byte-identical', ex.deterministic === true);
	check('the export carries the server configuration',
		ex.row.host === 'imap.example.com' && ex.row.port === 993
		&& ex.row.smtpHost === 'smtp.example.com' && ex.row.smtpPort === 587
		&& ex.row.user === ADDR, JSON.stringify(ex.row).slice(0, 140));
	check('it carries the WRAPPED password, and no readable one',
		!!ex.row.pass && ex.plaintext === false, 'pass len=' + String(ex.row.pass || '').length);
	check('the per-folder Maildir state is left behind (it is this device’s)',
		ex.hasFolders === false && ex.keys.indexOf('folders') === -1, ex.keys.join(','));
	check('and so is the folder on screen — a fresh device starts in INBOX',
		ex.keys.indexOf('folder') === -1 && ex.keys.indexOf('lastSync') === -1, ex.keys.join(','));
	check('which mailbox is selected does travel', ex.hasSel === true);
	console.log('  note  the mail section adds ~' + ex.bytes + ' bytes to the parcel');

	// ── 4. Through the real gateway, onto a second device ─────────────
	// The parcel goes out sealed, the local mail state is wiped as a fresh device
	// would have it, and the pull has to put a WORKING mailbox back.
	await pushLanded(page);
	// The mailbox server holds it, and holds it as ciphertext: the address is in
	// there, and must not be readable in there. (The version is not asserted to
	// have MOVED -- adding an account already triggers the engine's own push, so
	// by the time this runs there may be nothing left to send.)
	const landed = await page.evaluate(async (addr) => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return { present: !!j.present, version: j.version || 0,
			leaks: String(j.blob || '').indexOf(addr) !== -1 };
	}, ADDR);
	check('the parcel with the mailbox in it is on the server', landed.present && landed.version >= 1,
		JSON.stringify(landed));
	check('and the mailbox address is not readable in it',
		landed.leaks === false);

	const second = await page.evaluate(async (addr) => {
		localStorage.removeItem('daimond-mail');
		localStorage.removeItem('daimond-sync-version');
		window.DaimondMail.reload();
		await window.DaimondSync.pull();
		const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const a = (j.accounts || []).find(x => x.address === addr);
		if (!a) return { arrived: false };
		let opened = '';
		try { opened = await window.DaimondIdentity.unwrap(a.pass); } catch (e) { opened = ''; }
		return {
			arrived:  true,
			address:  a.address,
			host:     a.host,
			port:     a.port,
			user:     a.user,
			smtpHost: a.smtpHost,
			smtpPort: a.smtpPort,
			// The secret itself is never reported: only whether it opened, and
			// whether it is the one that was typed.
			opens:    opened.length > 0,
			samePass: opened === 'app-password-' + '3141',
			folder:   a.folder,
			folders:  Object.keys(a.folders || {}),
			lastUid:  ((a.folders || {}).INBOX || {}).lastUid || 0,
			sel:      j.sel,
			panel:    [...document.querySelectorAll('#mail-accounts .mail-addr')].map(e => e.textContent),
		};
	}, ADDR);
	check('a device with no mail of its own pulls the mailbox in',
		second.arrived === true && second.address === ADDR, JSON.stringify(second).slice(0, 120));
	check('with the server configuration intact',
		second.host === 'imap.example.com' && second.port === 993
		&& second.user === ADDR && second.smtpHost === 'smtp.example.com' && second.smtpPort === 587,
		JSON.stringify(second).slice(0, 160));
	check('and the password still OPENS — the mailbox works, it is not just listed',
		second.opens === true && second.samePass === true,
		'opens=' + second.opens + ' matches=' + second.samePass);
	check('the per-folder state did NOT travel: the folders rebuild here',
		second.lastUid === 0 && JSON.stringify(second.folders) === JSON.stringify(['INBOX']),
		'folders=' + JSON.stringify(second.folders) + ' lastUid=' + second.lastUid);
	check('the arriving mailbox starts in its inbox', second.folder === 'INBOX', second.folder);
	check('and the panel shows it without a reload',
		second.panel.indexOf(ADDR) !== -1, JSON.stringify(second.panel));

	// ── 5. A mailbox changed HERE is not overwritten by an older copy ──
	const diverged = await page.evaluate(async (addr) => {
		const M = window.DaimondMail;
		const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const a = (j.accounts || []).find(x => x.address === addr);
		const stamp = Date.now();
		a.host = 'imap.moved.example.com';
		a.touched = stamp;
		localStorage.setItem('daimond-mail', JSON.stringify(j));
		M.reload();
		// The other device's copy, as it was before the change.
		await M.applySync({ v: 1, sel: addr, accounts: [{
			address: addr, host: 'imap.example.com', port: 993,
			smtpHost: 'smtp.example.com', smtpPort: 587, user: addr,
			pass: 'STALE-WRAPPED', touched: stamp - 60000,
		}] });
		const older = M.exportSync().accounts.find(x => x.address === addr) || {};
		// An equal stamp keeps what is here, so an unchanged mailbox is not
		// rewritten on every pull.
		await M.applySync({ v: 1, accounts: [{
			address: addr, host: 'imap.equal.example.com', port: 993,
			smtpHost: 'smtp.example.com', smtpPort: 587, user: addr,
			pass: 'EQUAL-WRAPPED', touched: stamp,
		}] });
		const equal = M.exportSync().accounts.find(x => x.address === addr) || {};
		// A fresher one wins.
		await M.applySync({ v: 1, accounts: [{
			address: addr, host: 'imap.fresh.example.com', port: 993,
			smtpHost: 'smtp.example.com', smtpPort: 587, user: addr,
			pass: 'FRESH-WRAPPED', touched: stamp + 60000,
		}] });
		const fresh = M.exportSync().accounts.find(x => x.address === addr) || {};
		// A mailbox only the other device has arrives whole, and this one's survives.
		await M.applySync({ v: 1, accounts: [{
			address: 'other@example.com', host: 'imap.other.example.com', port: 143,
			smtpHost: 'smtp.other.example.com', smtpPort: 465, user: 'other@example.com',
			pass: 'OTHER-WRAPPED', touched: Date.now(), security: 'starttls',
		}] });
		const both = M.exportSync().accounts.map(x => x.address).sort();
		const other = M.exportSync().accounts.find(x => x.address === 'other@example.com') || {};
		return { older: older, equal: equal, fresh: fresh, both: both, other: other };
	}, ADDR);
	check('an older copy from another device does not clobber a mailbox changed here',
		diverged.older.host === 'imap.moved.example.com' && diverged.older.pass !== 'STALE-WRAPPED',
		diverged.older.host);
	check('an equally-stamped copy keeps what is here (the comparison is strict)',
		diverged.equal.host === 'imap.moved.example.com', diverged.equal.host);
	check('a fresher copy wins', diverged.fresh.host === 'imap.fresh.example.com'
		&& diverged.fresh.pass === 'FRESH-WRAPPED', diverged.fresh.host);
	check('a mailbox only the other device has arrives, and this one survives',
		JSON.stringify(diverged.both) === JSON.stringify(['other@example.com', ADDR].sort()),
		JSON.stringify(diverged.both));
	check('how the connection is dialled travels with it',
		diverged.other.security === 'starttls' && diverged.other.port === 143,
		JSON.stringify(diverged.other).slice(0, 100));

	// ── 6. A deletion travels as a deletion ───────────────────────────
	// Through the panel's own × and its confirmation, so every UI path that
	// removes a mailbox is the path under test.
	await page.evaluate(() => { window.DaimondMail.onOpen(); });
	await page.waitForTimeout(400);
	const rows = await page.$$('#mail-accounts .mail-acct');
	check('both mailboxes are on the panel to be removed from it', rows.length === 2,
		rows.length + ' rows');
	const target = await page.evaluateHandle((addr) => {
		const row = [...document.querySelectorAll('#mail-accounts .mail-acct')]
			.find(r => (r.querySelector('.mail-addr') || {}).textContent === addr);
		return row ? row.querySelector('.mail-del') : null;
	}, ADDR);
	await target.asElement().click({ force: true });
	await page.waitForSelector('.modal.dlg .dlg-ok', { timeout: 5000 });
	await page.click('.modal.dlg .dlg-ok', { force: true });
	await page.waitForTimeout(600);

	const buried = await page.evaluate(async (addr) => {
		const M = window.DaimondMail;
		const e = M.exportSync();
		const gone = !e.accounts.some(x => x.address === addr);
		const tombed = !!(e.tombs && e.tombs[addr]);
		// The other device still holds it, and hands it back: it must not come.
		await M.applySync({ v: 1, accounts: [{
			address: addr, host: 'imap.example.com', port: 993,
			smtpHost: 'smtp.example.com', smtpPort: 587, user: addr,
			pass: 'RESURRECTED', touched: (e.tombs[addr] || Date.now()) - 60000,
		}] });
		const back = M.exportSync().accounts.some(x => x.address === addr);
		// A deletion made on the OTHER device reaches this one: its tombstone
		// arrives without the account, and the account here goes.
		const other = 'other@example.com';
		await M.applySync({ v: 1, accounts: [], tombs: { [other]: Date.now() } });
		const otherGone = !M.exportSync().accounts.some(x => x.address === other);
		// And a mailbox re-added AFTER the deletion is not buried by the old tomb.
		const readd = Date.now() + 1000;
		await M.applySync({ v: 1, accounts: [{
			address: addr, host: 'imap.readded.example.com', port: 993,
			smtpHost: 'smtp.example.com', smtpPort: 587, user: addr,
			pass: 'READDED', touched: readd,
		}] });
		const row = M.exportSync().accounts.find(x => x.address === addr) || null;
		return { gone, tombed, back, otherGone, readd: row ? row.host : '' };
	}, ADDR);
	check('removing a mailbox in the panel takes it off this device',
		buried.gone === true);
	check('and leaves a tombstone in the parcel, so the other device removes it too',
		buried.tombed === true);
	check('a deleted mailbox handed back by the other device does not come back',
		buried.back === false);
	check('a mailbox deleted on the other device is deleted here',
		buried.otherGone === true);
	check('a mailbox re-added after the deletion survives the next merge',
		buried.readd === 'imap.readded.example.com', buried.readd || '(gone)');

	// ── 7. A device that predates all this ────────────────────────────
	const old = await page.evaluate(async () => {
		const M = window.DaimondMail;
		let threw = '';
		const before = M.exportSync().accounts.length;
		try {
			await M.applySync(undefined);
			await M.applySync(null);
			await M.applySync({});
			await M.applySync({ v: 1 });
		} catch (e) { threw = String((e && e.message) || e); }
		return { threw, before, after: M.exportSync().accounts.length };
	});
	check('a parcel with no mail section applies as a no-op',
		old.threw === '' && old.after === old.before,
		old.threw || (old.before + ' → ' + old.after));

	// The whole point of carrying the mailboxes is that the parcel from a device
	// that HAS them is still the parcel the core collects.
	const inParcel = await page.evaluate(async () => {
		const p = await window.DaimondCore.collectSync();
		return { has: Object.prototype.hasOwnProperty.call(p, 'mail'),
			accounts: (p.mail && p.mail.accounts || []).length };
	});
	check('the core parcel carries the mail section', inParcel.has === true,
		JSON.stringify(inParcel));

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|409|413|426|502|Unauthorized/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_mailsync ran without throwing', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
