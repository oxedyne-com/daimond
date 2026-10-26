// mailadd.test.mjs -- a mailbox added here polls on a schedule from the moment it is added, and
// follows its own history (Sent and Archive) as well as its inbox.
//
//	node --test www/js/mailadd.test.mjs
//
// hello@oxedyne.com was added on 25 Oct 2026 at 23:19 and synced once, its inbox only, and never
// again (D-20261025-10; diag_mailsync.md). A new mailbox was born with an empty refresh map, which
// is "manual only", and the folders that hold a person's own history were never fetched. This
// drives the REAL mail.js through its add button against a scripted gateway and a hand-driven
// clock, then reloads it from the same storage, and reads what reached the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

const NOW  = 1_700_000_000_000;
const ADDR = 'new@x.test';

// The six folders a stock Dovecot hands a mail client, and one the user made.
const LIST = [
	{ name: 'INBOX',    selectable: true },
	{ name: 'Sent',     selectable: true, role: 'sent' },
	{ name: 'Archive',  selectable: true, role: 'archive' },
	{ name: 'Drafts',   selectable: true, role: 'drafts' },
	{ name: 'Trash',    selectable: true, role: 'trash' },
	{ name: 'Junk',     selectable: true, role: 'junk' },
	{ name: 'Clients',  selectable: true },
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

/// A page with the Mail panel, a gateway that answers from `gw`, and a clock. `ls` carries the
/// browser's storage across a reload.
function page(ls, gw) {
	const w = makeWindow({ now: gw.at, ls });
	const timers = [];
	w.setTimeout   = (fn) => { timers.push(fn); return timers.length; };
	w.clearTimeout = () => {};
	let addBtn = null;
	const panel = {
		querySelector: (sel) => sel === '[data-act="mail-add"]'
			? { addEventListener: (ev, fn) => { addBtn = fn; } } : null,
	};
	w.document.createElement  = () => elem();
	w.document.getElementById = (id) => (id === 'panel-mail' ? panel : elem());
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = {
		state: () => ({ authed: true }),
		noteBalance() {},
		gwFetch: async (path, init) => {
			const body = init && init.body ? JSON.parse(init.body) : {};
			if (path === '/api/mail/folders') {
				gw.lists++;
				if (gw.listFails > 0) {
					gw.listFails--;
					return { status: 502, ok: false, json: async () => ({ ok: false, error: 'down' }) };
				}
				return { status: 200, ok: true, json: async () => ({ ok: true, folders: LIST }) };
			}
			if (path === '/api/mail/accounts' && body.action === 'bind') gw.order.push(['bind', body]);
			if (path === '/api/mail/sync') {
				gw.order.push(['sync', body.mailbox]);
				gw.synced.push(body.mailbox);
				return { status: 200, ok: true,
					json: async () => ({ ok: true, messages: [], uid_validity: 1, held_back: 0 }) };
			}
			return { status: 200, ok: true, json: async () => ({ ok: true, unlocked: true, accounts: [] }) };
		},
	};
	loadScript(w, 'quiet.js');
	loadScript(w, 'mail.js');
	const M = w.DaimondMail;
	M.init({
		writeBytes: async () => {}, openFile() {}, refreshFiles() {}, showDoc() {},
		runTool: async () => ({ outcome: 'done', text: '' }),
		mailDialog: async () => ({
			address: ADDR, password: 'pw', host: 'imap.x.test', port: 993,
			smtpHost: 'smtp.x.test', smtpPort: 587, user: ADDR,
		}),
	});
	const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
	return {
		M, w,
		async add() { await addBtn(); await settle(); },
		/// Let the clock run `secs`, firing whatever the schedule armed, one tick at a time.
		async run(secs) {
			const end = gw.at + secs * 1000;
			for (let i = 0; i < 40 && gw.at < end; i++) {
				gw.at = Math.min(end, gw.at + 60_000); w._setNow(gw.at);
				const fire = timers.splice(0).slice(-1);
				for (const fn of fire) { fn(); await settle(); }
			}
		},
		settle,
	};
}

function gateway() { return { at: NOW, lists: 0, listFails: 0, synced: [], order: [] }; }
const count = (xs, n) => xs.filter((x) => x === n).length;

test('an added mailbox polls its inbox on a schedule, with no one setting it', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.add();
	assert.equal(count(gw.synced, 'INBOX'), 1, 'the add syncs the inbox once');
	assert.ok(p.M.refreshOf(ADDR, 'INBOX') > 0, 'the inbox has a schedule from the moment it is added');
	await p.run(p.M.refreshOf(ADDR, 'INBOX') + 60);
	assert.ok(count(gw.synced, 'INBOX') >= 2, 'the schedule polls the inbox again: ' + gw.synced);
});

test('the schedule survives a reload', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.add();
	const every = p.M.refreshOf(ADDR, 'INBOX');
	assert.ok(every > 0);
	gw.synced.length = 0;
	const q = page(ls, gw);					// a reload: a fresh page on the same storage
	assert.equal(q.M.refreshOf(ADDR, 'INBOX'), every, 'the schedule was stored');
	await q.run(every + 60);
	assert.ok(count(gw.synced, 'INBOX') >= 1, 'the reloaded page polls without being asked: ' + gw.synced);
});

test('an added mailbox follows Sent and Archive, and nothing else it was not asked to', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.add();
	const every = p.M.refreshOf(ADDR, 'INBOX');
	assert.equal(p.M.refreshOf(ADDR, 'Sent'),    every, 'Sent is followed');
	assert.equal(p.M.refreshOf(ADDR, 'Archive'), every, 'Archive is followed');
	for (const n of ['Drafts', 'Trash', 'Junk', 'Clients']) {
		assert.equal(p.M.refreshOf(ADDR, n), 0, n + ' is not followed by default');
	}
	await p.run(120);
	assert.ok(count(gw.synced, 'Sent') >= 1,    'Sent is fetched: ' + gw.synced);
	assert.ok(count(gw.synced, 'Archive') >= 1, 'Archive is fetched: ' + gw.synced);
	for (const n of ['Drafts', 'Trash', 'Junk', 'Clients']) assert.equal(count(gw.synced, n), 0, n);
});

test('a first folder listing that fails still follows Sent and Archive once one succeeds', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	gw.listFails = 1;
	const p = page(ls, gw);
	await p.add();
	assert.equal(p.M.refreshOf(ADDR, 'Sent'), 0, 'nothing listed yet');
	const q = page(ls, gw);					// a reload, and the panel opened again
	await q.M.loadFolders(ADDR, true);
	await q.settle();
	assert.ok(q.M.refreshOf(ADDR, 'Sent') > 0,    'Sent followed after the later listing');
	assert.ok(q.M.refreshOf(ADDR, 'Archive') > 0, 'Archive followed after the later listing');
});

test('a decision made after the add is not overridden by a later listing', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.add();
	p.M.setRefresh(ADDR, 'Sent', 0);			// the user turns Sent to manual
	await p.M.loadFolders(ADDR, true);
	await p.settle();
	assert.equal(p.M.refreshOf(ADDR, 'Sent'), 0, 'Manual stays manual');
});

test('a mailbox that arrives from another device keeps the schedule it travelled with', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.M.applySync({ v: 1, sel: ADDR, tombs: {}, accounts: [{
		address: ADDR, host: 'imap.x.test', port: 993, smtpHost: 's', smtpPort: 587,
		user: ADDR, pass: 'w', refresh: { INBOX: 0 }, folder: 'INBOX', touched: NOW - 1000,
	}] });
	await p.M.loadFolders(ADDR, true);
	await p.settle();
	assert.equal(p.M.refreshOf(ADDR, 'INBOX'), 0, 'the other device said manual');
	assert.equal(p.M.refreshOf(ADDR, 'Sent'),  0, 'and nothing is added on its behalf');
});

// ── Manual is a stated choice; an empty schedule is the 7 Aug default (rc-b ruling, 25 Oct) ──
//
// Until 25 Oct choosing Manual deleted the folder's key, so an empty map could be either Manual or
// the "manual until told" default every mailbox was born with. Manual is now stored as 0, so an
// empty map can only be that default, and it becomes the new-mailbox schedule: hello@oxedyne.com
// starts polling with no step from him, and alerts@ and hoogland@, which were set, are not touched.

const LEGACY = 'old@x.test';

/// A page reloaded over storage that already holds `accounts`, as an existing install has.
function stored(accounts) {
	const ls = makeWindow().localStorage;
	ls.setItem('daimond-mail', JSON.stringify({ sel: accounts[0].address, accounts }));
	return ls;
}
function legacy(refresh) {
	const a = { address: LEGACY, host: 'imap.x.test', port: 993, smtpHost: 's', smtpPort: 587,
		user: LEGACY, pass: 'w', folder: 'INBOX', touched: NOW - 5000, lastSync: 0,
		folders: { INBOX: { dir: 'INBOX', uidValidity: 1, lastUid: 4, firstUid: 1, heldBack: 0,
			limit: 0, lastSync: NOW - 5000, lastTry: NOW - 5000, count: 4 } } };
	if (refresh !== undefined) a.refresh = refresh;
	return a;
}
const travelled = (M, addr) => M.exportSync().accounts.find((r) => r.address === addr).refresh;

test('an empty schedule becomes the new-mailbox default, and polls', async () => {
	for (const refresh of [undefined, {}]) {
		const gw = gateway();
		const p = page(stored([legacy(refresh)]), gw);
		assert.equal(p.M.refreshOf(LEGACY, 'INBOX'), 900, 'the empty schedule is now 15 minutes');
		assert.deepEqual(travelled(p.M, LEGACY), { INBOX: 900 }, 'and it travels to every device');
		await p.run(960);
		assert.ok(count(gw.synced, 'INBOX') >= 1, 'it polls with no step from anyone: ' + gw.synced);
		await p.M.loadFolders(LEGACY, true);
		await p.settle();
		assert.equal(p.M.refreshOf(LEGACY, 'Sent'), 900, 'its Sent is followed like a new mailbox\'s');
		assert.equal(p.M.refreshOf(LEGACY, 'Junk'), 0);
	}
});

test('Manual is stored, travels, and survives a reload as manual', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.add();
	p.M.setRefresh(ADDR, 'INBOX', 0);
	assert.equal(travelled(p.M, ADDR).INBOX, 0, 'Manual is an explicit value on the wire');
	const q = page(ls, gw);
	assert.equal(q.M.refreshOf(ADDR, 'INBOX'), 0, 'Manual stays manual after a reload');
});

// A schedule that was set keeps its inbox as set. Its Sent and Archive, never decided about,
// follow on the inbox's own schedule: the owner's ask of 26 Oct, so that hoogland@'s sent mail
// shows without a step from him (SENT-COPY), which supersedes "nothing is added" for those two.
test('a schedule that was set keeps its inbox, and its Sent and Archive follow it', async () => {
	const gw = gateway();
	const p = page(stored([legacy({ INBOX: 3600 })]), gw);
	assert.equal(p.M.refreshOf(LEGACY, 'INBOX'), 3600);
	await p.M.loadFolders(LEGACY, true);
	await p.settle();
	assert.deepEqual(travelled(p.M, LEGACY), { INBOX: 3600, Sent: 3600, Archive: 3600 });
});

test('a set schedule whose inbox is Manual has nothing added', async () => {
	const gw = gateway();
	const p = page(stored([legacy({ INBOX: 0 })]), gw);
	await p.M.loadFolders(LEGACY, true);
	await p.settle();
	assert.deepEqual(travelled(p.M, LEGACY), { INBOX: 0 });
});

test('the migration runs once: Manual chosen after it is not undone', async () => {
	const gw = gateway(), ls = stored([legacy({})]);
	const p = page(ls, gw);
	assert.equal(p.M.refreshOf(LEGACY, 'INBOX'), 900);
	p.M.setRefresh(LEGACY, 'INBOX', 0);
	const q = page(ls, gw);
	assert.equal(q.M.refreshOf(LEGACY, 'INBOX'), 0, 'the user\'s Manual stands after a reload');
});

test('an empty schedule arriving from another device is the default, an explicit Manual is not', async () => {
	const gw = gateway();
	const p = page(makeWindow().localStorage, gw);
	const row = (address, refresh) => ({ address, host: 'imap.x.test', port: 993, smtpHost: 's',
		smtpPort: 587, user: address, pass: 'w', refresh, touched: NOW - 1000 });
	await p.M.applySync({ v: 1, sel: LEGACY, tombs: {}, accounts: [row(LEGACY, {}), row(ADDR, { INBOX: 0 })] });
	assert.equal(p.M.refreshOf(LEGACY, 'INBOX'), 900, 'an empty map is the old default');
	assert.equal(p.M.refreshOf(ADDR, 'INBOX'), 0, 'an explicit Manual is a choice');
});

// FIRE mailhost: the gateway refuses a send from a mailbox with no SMTP host on record, and a sync
// records only the IMAP one, so the add flow binds both servers before its first sync.
test('an added mailbox binds both its servers before its first sync', async () => {
	const gw = gateway(), ls = makeWindow().localStorage;
	const p = page(ls, gw);
	await p.add();
	const first = gw.order[0];
	assert.ok(first && first[0] === 'bind', 'the first call was not a bind: ' + JSON.stringify(gw.order));
	assert.equal(first[1].address,   ADDR);
	assert.equal(first[1].host,      'imap.x.test');
	assert.equal(first[1].smtp_host, 'smtp.x.test', 'the SMTP server was not recorded');
});
