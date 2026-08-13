// verify_mailrefresh.mjs — folders refresh themselves, say how much they hold,
// and stop dead when they are paused.
//
// Phase G of the notes2 programme: a refresh frequency per folder, a count on
// every folder row, and a gear dialog holding both. Three properties are worth
// a verifier and the rest is decoration:
//
//   1. A PAUSE IS REFUSED WHERE THE REQUEST IS MADE. Counted AT THE NETWORK —
//      `page.route` sits between the page and the server, so a request that was
//      refused never reaches a counter and one that was merely hidden does.
//      Both halves are asked, and the second is the one that matters: paused →
//      nothing left the page; resumed → the request DOES leave. A check that
//      only ever proves silence passes with the feature entirely absent.
//
//   2. THE SCHEDULE IS HONOURED. A folder on a one-second interval is polled
//      about that often; one on an hour is not polled in between. Both, because
//      "it polls" and "it does not poll too much" are different failures.
//
//   3. A COUNT SAYS WHEN IT IS FROM. A number that silently means "as at the
//      last sync" is a lie the reader will act on, so a folder never fetched
//      shows no number at all rather than a nought, and a figure gone stale
//      carries its age in the row where a `title` cannot be hovered.
//
// And the one the user asked for by name: the manual refresh still refreshes
// EVERYTHING — every folder of every mailbox, not the selected one.
//
//   4. THE FOLDER ON SCREEN IS THE ONE ON SCREEN. Refreshing everything is
//      right; showing everything in turn is not. Each folder's sync ended by
//      adopting its own digest as the panel's list, so a walk past Sent,
//      Archive and a second mailbox left the reader's INBOX replaced — the
//      messages appearing, emptying and reappearing as it went. Asserted by
//      SUBJECT, because a list of the right length can still be the wrong
//      folder's.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file to the real page (through
// `page.route`, so the browser loads it as it loads any other script) and the
// run is expected to FAIL. A break that does not apply cleanly aborts rather
// than passing quietly: a check proved against code that was never broken is
// not proved at all.
//
//   node dev/verify_mailrefresh.mjs --break pause     # 1's paused half fails
//   node dev/verify_mailrefresh.mjs --break nofetch   # 1's resumed half fails
//   node dev/verify_mailrefresh.mjs --break schedule  # 2 fails
//   node dev/verify_mailrefresh.mjs --break counts    # 3 fails
//   node dev/verify_mailrefresh.mjs --break globalone # the manual refresh fails
//   node dev/verify_mailrefresh.mjs --break digest    # 4 fails: the refresh walk
//                                                     # leaves another folder's
//                                                     # digest on screen
//   node dev/verify_mailrefresh.mjs                   # and then, clean
//
//   eval "$(bash dev/world.sh 8 --up)"
//   node dev/verify_mailrefresh.mjs
//
// Needs dev/serve.mjs only. No gateway on :9002 and no IMAP fixture: every mail
// route is stubbed here, and everything below the stub — the scheduler, the
// pause tree, the Maildir on disk, the panel — is the real code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'mailrefresh' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must
// appear exactly once: a break that silently matched nothing would leave the
// suite green against working code and prove the opposite of what it claims.
const BREAKS = {
	// No pause enforcement anywhere in the app. Not just mail.js's guard —
	// gateway.js refuses the same request at the wire, so breaking one leaves
	// the other doing the job and the check would rightly still pass.
	pause: [{
		file: 'js/pause.js',
		find: '\t\tload();\n\t\treturn !!_paused[nodeId];',
		with: '\t\tload();\n\t\treturn false;',
	}],
	// The fetch never happens at all. The paused halves still pass — which is
	// the whole point of asking the resumed half.
	nofetch: [{
		file: 'js/mail.js',
		find: '\t\tvar a = acct(address);\n\t\tif (!a || state.busy) return;\n\t\tvar name = folder || a.folder',
		with: '\t\tvar a = acct(address);\n\t\tif (!a || state.busy || true) return;\n\t\tvar name = folder || a.folder',
	}],
	// The frequency is stored and nothing ever acts on it.
	schedule: [{
		file: 'js/mail.js',
		find: '\t\tvar wait = Math.max(floor, Math.min(TICK_MAX, soonest - now));\n\t\ttimer = setTimeout(function () { tick(); }, wait);',
		with: '\t\tvar wait = Math.max(floor, Math.min(TICK_MAX, soonest - now));\n\t\tif (wait) return;',
	}],
	// A bare number: never stale, no as-at, and a nought for a folder nobody
	// has ever fetched. This is the lie the check exists to catch.
	counts: [{
		file: 'js/mail.js',
		find: '\t\tvar f    = a && a.folders && a.folders[name];\n\t\tvar last = (f && ms(f.lastSync)) || 0;\n\t\tif (!last) {',
		with: '\t\tvar f    = a && a.folders && a.folders[name];\n\t\tvar last = (f && ms(f.lastSync)) || 0;\n\t\tif (true) { return { text: String((f && f.count) | 0), when: \'\', stale: false, title: \'messages\' }; }\n\t\tif (!last) {',
	}],
	// The digest of whichever folder synced last becomes what the panel shows,
	// selected or not. This is the flicker: a refresh walks INBOX, Sent and
	// Archive in turn, each one replaces the list, and the user watches their
	// inbox appear, empty and reappear as the walk goes past.
	digest: [{
		file: 'js/mail.js',
		find: '\t\tif (address === state.sel && a && name === (a.folder || \'INBOX\')) {\n'
			+ '\t\t\tstate.msgs = msgs;\n\t\t}',
		with: '\t\tstate.msgs = msgs;',
	}],
	// The old behaviour: the selected mailbox, and nothing else.
	globalone: [{
		file: 'js/mail.js',
		find: '\t\tvar boxes = state.accounts.map(function (a) { return a.address; });',
		with: '\t\tvar boxes = state.accounts.map(function (a) { return a.address; }).slice(0, 1);',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified
/// to differ from the file on disk.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

// ── The stubbed gateway ──────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

const BOX_A = 'alice@test.local';
const BOX_B = 'bob@test.local';

// Every folder poll that LEFT the page, in order. A refusal shows as a list
// that did not grow.
const syncs = [];
const lists = [];
const since = () => syncs.length;
const sincePer = (addr, folder) =>
	syncs.filter(s => s.address === addr && s.mailbox === folder).length;

/// A message the fixture serves, as the gateway would: base64 RFC 5322.
const msg = (uid, subject) => ({
	uid,
	flags: ['\\Seen'],
	raw: Buffer.from(
		`From: Someone <someone@example.com>\r\n`
		+ `Subject: ${subject}\r\n`
		+ `Date: Thu, 7 Aug 2026 09:00:00 +1000\r\n`
		+ `Content-Type: text/plain; charset=utf-8\r\n\r\n`
		+ `${subject} body\r\n`, 'utf8').toString('base64'),
});

// How many messages each folder holds on the server. The counts on the rows
// are checked against these, so they are the oracle and not a mirror of what
// the client happened to write.
const SERVER = {
	[BOX_A]: { INBOX: 3, Sent: 1, Archive: 0 },
	[BOX_B]: { INBOX: 2, Sent: 0, Archive: 0 },
};

async function stub(page) {
	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const body = damaged(spec);
			await page.route('**/' + spec.file, r => r.fulfill({
				status: 200, contentType: 'application/javascript', body,
			}));
		}
	}

	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-mr', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, held: true, currency: 'usd' })));

	await page.route('**/api/mail/accounts', r => {
		if (r.request().method() !== 'GET') return r.fulfill(json({ ok: true }));
		return r.fulfill(json({ ok: true, unlocked: true, max_accounts: 3 }));
	});

	await page.route('**/api/mail/folders', r => {
		let b = {};
		try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) { b = {}; }
		lists.push(b.address || '');
		return r.fulfill(json({
			ok: true,
			folders: [
				{ name: 'INBOX' },
				{ name: 'Sent',    role: 'sent' },
				{ name: 'Archive', role: 'archive' },
			],
		}));
	});

	await page.route('**/api/mail/sync', r => {
		let b = {};
		try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) { b = {}; }
		syncs.push({ address: b.address || '', mailbox: b.mailbox || '', at: Date.now() });
		const n = ((SERVER[b.address] || {})[b.mailbox]) | 0;
		const messages = [];
		for (let i = 1; i <= n; i++) messages.push(msg(i, `${b.mailbox} message ${i}`));
		return r.fulfill(json({
			ok: true, uid_validity: 42, messages, held_back: 0, limit: 25, credits_minor: 4990,
		}));
	});
	await page.route('**/api/mail/send', r => r.fulfill(json({ ok: true })));
}

// ── Driving ──────────────────────────────────────────────────────────

const pauseLeaf = (page, id) => page.evaluate(i => window.DaimondPause.set(i, false), id);
const playLeaf  = (page, id) => page.evaluate(i => window.DaimondPause.set(i, true), id);
const sleep     = (ms) => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'mailrefresh', profile: PROFILE, signIn: false, connect: false });
const { page } = s;
await stub(page);

// The stub only takes effect on a load that comes after it, and sign-in reloads
// nothing — so the page is reopened with the routes in place.
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'mailrefresh');
await page.waitForTimeout(2000);

try {
	// Two mailboxes, seeded the way the add-dialog would but pointed nowhere
	// real: every route they use is stubbed above.
	await page.evaluate(async ([a, b]) => {
		const pass = await window.DaimondIdentity.wrap('test-app-password');
		const mk = (address) => ({
			address, host: '127.0.0.1', port: 1143, security: 'plain',
			smtpHost: '127.0.0.1', smtpPort: 1587, smtpSecurity: 'plain',
			user: address, pass, folder: 'INBOX', folders: {}, lastSync: 0, touched: 1,
		});
		localStorage.setItem('daimond-mail', JSON.stringify({ accounts: [mk(a), mk(b)], sel: a }));
		window.DaimondMail.reload();
		window.DaimondPanels.show('mail');
		window.DaimondMail.onOpen();
	}, [BOX_A, BOX_B]);
	await page.waitForTimeout(1500);

	const INBOX_A = `root/mail/${BOX_A}/INBOX`;
	const SENT_A  = `root/mail/${BOX_A}/Sent`;
	const SELF_A  = `root/mail/${BOX_A}/self`;

	// ── 1. A paused folder is not fetched ────────────────────────
	await pauseLeaf(page, INBOX_A);
	let n = since();
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1200);
	check('a paused folder is not fetched', syncs.length === n,
		`${syncs.length - n} request(s) left the page`);

	await playLeaf(page, INBOX_A);
	n = since();
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1500);
	check('and resuming it fetches — so the silence above was the pause',
		syncs.length === n + 1, `${syncs.length - n} request(s)`);

	// ── 2. A paused mailbox stops all its folders ────────────────
	// The `self` leaf is a SIBLING of the folders, not their ancestor, so the
	// tree does not derive this and neither does `isPaused` on a folder leaf:
	// it is a rule laid over the tree, written in mail.js's `pollStop` and
	// again at the wire in gateway.js. What is asserted here is the rule, and
	// the folder's own leaf is left PLAYING so that nothing else could explain
	// the silence.
	await pauseLeaf(page, SELF_A);
	const folderState = await page.evaluate((id) => window.DaimondPause.state(id), INBOX_A);
	check('the folder\'s own leaf is playing while the mailbox is held',
		folderState === 'play', folderState);

	n = since();
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1200);
	check('a paused mailbox holds a folder that is playing', syncs.length === n,
		`${syncs.length - n} request(s)`);

	// And the scheduler obeys the same rule: a frequency set on a folder under
	// a held mailbox polls nothing at all.
	await page.evaluate(([addr]) => {
		window.DaimondMail.setRefresh(addr, 'INBOX', 1);
		window.DaimondMail.setRefresh(addr, 'Sent', 1);
	}, [BOX_A]);
	n = since();
	await sleep(3500);
	check('and the schedule under a held mailbox polls nothing', syncs.length === n,
		`${syncs.length - n} request(s) in 3.5s with two folders on a 1s interval`);

	await playLeaf(page, SELF_A);

	// ── 3. The schedule is honoured ──────────────────────────────
	// Sent is put on an hour AFTER a sync of its own, so its clock starts:
	// a folder with a frequency and nothing behind it is due immediately, which
	// is what setting one is supposed to mean.
	await page.evaluate(([addr]) => {
		window.DaimondMail.setRefresh(addr, 'Sent', 0);
		window.DaimondMail.setRefresh(addr, 'INBOX', 0);
	}, [BOX_A]);
	await page.evaluate((addr) => window.DaimondMail.selectFolder('Sent'), BOX_A);
	await page.waitForTimeout(1500);
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1200);
	await page.evaluate((addr) => window.DaimondMail.selectFolder('INBOX'), BOX_A);
	await page.waitForTimeout(1200);

	const inboxBefore = sincePer(BOX_A, 'INBOX');
	const sentBefore  = sincePer(BOX_A, 'Sent');
	await page.evaluate(([addr]) => {
		window.DaimondMail.setRefresh(addr, 'INBOX', 1);
		window.DaimondMail.setRefresh(addr, 'Sent', 3600);
	}, [BOX_A]);
	await sleep(5000);
	const inboxAfter = sincePer(BOX_A, 'INBOX');
	const sentAfter  = sincePer(BOX_A, 'Sent');
	check('a folder on a short interval is polled about that often',
		inboxAfter - inboxBefore >= 3,
		`${inboxAfter - inboxBefore} poll(s) in 5s at 1s`);
	check('and one on a long interval is not polled in between',
		sentAfter === sentBefore,
		`${sentAfter - sentBefore} poll(s) in 5s at 3600s`);

	// And a setting that says "manual only" means it.
	await page.evaluate(([addr]) => {
		window.DaimondMail.setRefresh(addr, 'INBOX', 0);
		window.DaimondMail.setRefresh(addr, 'Sent', 0);
	}, [BOX_A]);
	await sleep(500);
	n = since();
	await sleep(3000);
	check('and "manual only" polls nothing', syncs.length === n,
		`${syncs.length - n} request(s) in 3s`);

	// ── 4. Counts are the server's, and a stale one says so ──────
	const counts = await page.evaluate((addr) => window.DaimondMail.counts(addr), BOX_A);
	check('a folder row carries what the server handed over',
		counts.INBOX && counts.INBOX.count === SERVER[BOX_A].INBOX
			&& counts.Sent && counts.Sent.count === SERVER[BOX_A].Sent,
		`INBOX ${counts.INBOX && counts.INBOX.count} (server ${SERVER[BOX_A].INBOX}), `
		+ `Sent ${counts.Sent && counts.Sent.count} (server ${SERVER[BOX_A].Sent})`);
	check('and the count says when it is from',
		!!(counts.INBOX && /as at/i.test(counts.INBOX.says.title)),
		counts.INBOX && counts.INBOX.says.title);
	check('a folder never fetched shows no number rather than a nought',
		!!(counts.Archive && counts.Archive.says.text === '—'
			&& counts.Archive.lastSync === 0),
		counts.Archive && JSON.stringify(counts.Archive.says));
	check('a fresh count is not marked stale',
		!!(counts.INBOX && counts.INBOX.says.stale === false),
		counts.INBOX && String(counts.INBOX.says.stale));

	// What the reader actually sees, in the DOM, not in the API behind it.
	const rowsFresh = await page.$$eval('#mail-folders .mail-folder', els => els.map(e => ({
		name:  e.getAttribute('data-folder'),
		count: (e.querySelector('.mail-count') || {}).textContent || '',
		stale: !!e.querySelector('.mail-count.stale'),
		when:  (e.querySelector('.mail-when') || {}).textContent || '',
		title: (e.querySelector('.mail-count') || {}).title || '',
	})));
	const rowOf = (nm) => rowsFresh.find(r => r.name === nm) || {};
	check('the panel draws the count on the folder row',
		rowOf('INBOX').count === String(SERVER[BOX_A].INBOX),
		JSON.stringify(rowsFresh));
	check('and a never-fetched folder\'s row says never rather than nought',
		rowOf('Archive').count === '—' && /never/i.test(rowOf('Archive').when),
		JSON.stringify(rowOf('Archive')));

	// Wind the last sync back three days and reload: the number is the same and
	// the row now says how old it is.
	await page.evaluate((addr) => {
		const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const a = j.accounts.find(x => x.address === addr);
		a.folders.INBOX.lastSync = Date.now() - 3 * 86400000;
		a.folders.INBOX.lastTry  = a.folders.INBOX.lastSync;
		localStorage.setItem('daimond-mail', JSON.stringify(j));
		window.DaimondMail.reload();
	}, BOX_A);
	await page.waitForTimeout(600);
	const rowsStale = await page.$$eval('#mail-folders .mail-folder', els => els.map(e => ({
		name:  e.getAttribute('data-folder'),
		count: (e.querySelector('.mail-count') || {}).textContent || '',
		stale: !!e.querySelector('.mail-count.stale'),
		when:  (e.querySelector('.mail-when') || {}).textContent || '',
	})));
	const stale = rowsStale.find(r => r.name === 'INBOX') || {};
	check('a stale count keeps its number and says how old it is',
		stale.count === String(SERVER[BOX_A].INBOX) && stale.stale === true
			&& /3d|day/i.test(stale.when),
		JSON.stringify(stale));

	// ── 5. The manual refresh still refreshes everything ─────────
	// The one the user asked for by name. Both mailboxes, every folder each of
	// them tracks — pressed as a person presses it, on the button in the panel.
	syncs.length = 0;
	lists.length = 0;
	await page.click('.mail-refresh', { force: true });
	await page.waitForTimeout(6000);
	const addrs = [...new Set(syncs.map(x => x.address))].sort();
	const pairs = [...new Set(syncs.map(x => x.address + '/' + x.mailbox))].sort();
	check('the manual refresh reaches every mailbox',
		addrs.length === 2 && addrs[0] === BOX_A && addrs[1] === BOX_B,
		addrs.join(', ') || 'none');
	check('and it re-lists the folders of every mailbox',
		[...new Set(lists)].length === 2, JSON.stringify([...new Set(lists)]));
	check('and it refreshes every folder each of them tracks',
		pairs.length >= 4, pairs.join(' | '));

	// ── 6. The list still shows the folder that is OPEN ──────────────
	// Reported from the live app: "I manually refresh, they showed up for a
	// moment, but then they disappear, then reappear and so on." A refresh walks
	// every folder of every mailbox — which is check 5, and correct — and each
	// sync ended by adopting ITS digest as the panel's list, so the open INBOX
	// was replaced by Sent, then by an empty Archive, then by the other
	// mailbox's folders. Whatever synced last was left on screen.
	//
	// Asserted by SUBJECT, not by count: the fixture names every message after
	// the folder it came from, so a list showing three of anything is not
	// enough — they must be the INBOX's three. `SERVER` is the oracle.
	const subjects = await page.$$eval('.mail-msg .mail-subj', els => els.map(e => e.textContent.trim()));
	const openFolder = await page.evaluate(() => window.DaimondMail.folder()).catch(() => '');
	check('THE OPEN FOLDER IS STILL THE ONE ON SCREEN AFTER A REFRESH WALKS THE OTHERS',
		subjects.length === SERVER[BOX_A].INBOX
			&& subjects.every(x => /^INBOX message /.test(x)),
		`${openFolder || '?'} → ${JSON.stringify(subjects)}`);
	// The counts are the other half of the same rule: a folder nobody is looking
	// at still has to report what it holds, or fixing the flicker would cost the
	// rows their numbers.
	const countsAfter = await page.evaluate(a => window.DaimondMail.counts(a), BOX_A);
	check('and an unselected folder still reports its own count',
		(countsAfter.Sent || {}).count === SERVER[BOX_A].Sent,
		JSON.stringify(countsAfter));

	// And a held folder is skipped rather than being quietly dropped.
	await pauseLeaf(page, SENT_A);
	syncs.length = 0;
	await page.click('.mail-refresh', { force: true });
	await page.waitForTimeout(6000);
	check('a held folder is skipped by the manual refresh, and the rest still go',
		!syncs.some(x => x.address === BOX_A && x.mailbox === 'Sent') && syncs.length >= 3,
		syncs.map(x => x.address + '/' + x.mailbox).join(' | '));
	const said = await page.$eval('#mail-state', e => e.textContent.trim()).catch(() => '');
	check('and the panel says how many were held rather than only how many went',
		/held/i.test(said), said.slice(0, 160));
	await playLeaf(page, SENT_A);

	// ── The gear dialog's body ───────────────────────────────────
	const tiles = await page.evaluate((addr) => {
		const body = window.DaimondMail.settingsBody(addr);
		document.body.appendChild(body);		// so getComputedStyle etc. work
		const out = [...body.querySelectorAll('.mail-tile')].map(t => ({
			folder: t.getAttribute('data-folder') || 'self',
			name:   (t.querySelector('.mail-tile-name') || {}).textContent || '',
			every:  (t.querySelector('.mail-every') || {}).value,
			slots:  t.querySelectorAll('.pptw-slot').length,
		}));
		body.remove();
		return out;
	}, BOX_A);
	check('the gear dialog carries a tile for the mailbox and one per folder',
		tiles.length === 4 && tiles[0].folder === 'self',
		JSON.stringify(tiles));
	check('and every tile has a pause slot for its own node',
		tiles.every(t => t.slots === 1), JSON.stringify(tiles.map(t => t.slots)));
	check('and every folder tile carries a frequency',
		tiles.slice(1).every(t => typeof t.every === 'string'),
		JSON.stringify(tiles.map(t => t.every)));

	// Setting one through the dialog is the same act as setting one through the
	// API, and it survives a reload.
	await page.evaluate((addr) => {
		const body = window.DaimondMail.settingsBody(addr);
		document.body.appendChild(body);
		const sel = body.querySelector('.mail-tile[data-folder="Archive"] .mail-every');
		sel.value = '900';
		sel.dispatchEvent(new Event('change'));
		body.remove();
	}, BOX_A);
	await page.evaluate(() => window.DaimondMail.reload());
	await page.waitForTimeout(400);
	const kept = await page.evaluate((addr) =>
		window.DaimondMail.refreshOf(addr, 'Archive'), BOX_A);
	check('a frequency set in the dialog is kept', kept === 900, String(kept));

	// ── The parcel ───────────────────────────────────────────────
	// The frequency travels, so it has to be a fixed point: sorted keys and no
	// stamp that moves on its own. Two collects with nothing in between must be
	// byte-identical, and applying a parcel must not change what this device
	// would then send. Two devices have pushed at each other over less.
	const parcel = await page.evaluate(async () => {
		const a = JSON.stringify(window.DaimondMail.exportSync());
		const b = JSON.stringify(window.DaimondMail.exportSync());
		await window.DaimondMail.applySync(JSON.parse(a));
		const c = JSON.stringify(window.DaimondMail.exportSync());
		return { a, b, c };
	});
	check('the mail parcel is stable across two collects', parcel.a === parcel.b);
	check('and applying it does not change what would be sent next',
		parcel.a === parcel.c, parcel.a.slice(0, 200) + '\n vs \n' + parcel.c.slice(0, 200));
	check('and the frequency is in it, with sorted keys',
		/"refresh":\{"Archive":900\}/.test(parcel.a),
		(parcel.a.match(/"refresh":\{[^}]*\}/g) || []).join(' | '));

	// A refusal is a decision, not a fault: an app that logs an error every time
	// a held folder is asked to poll has taught its user to ignore the console.
	const errs = errors(s).filter(e =>
		!/Failed to load resource/.test(e) && !/Paused:/.test(e));
	check('nothing was refused by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	await shot(s, 'mailrefresh' + (BREAK ? '-' + BREAK : ''));
} finally {
	await s.close();
}

console.log(`\nsyncs seen: ${syncs.length}   folder lists: ${lists.length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
