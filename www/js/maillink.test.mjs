// maillink.test.mjs -- the mail poll waits on the link, with the main sync's backoff and online check.
//
//	node --test www/js/maillink.test.mjs
//
// UNBLOCK-73 (LENS-SWEEP-1NOV finding K): at 01:22:41-45 on 1 Nov, with gilgamesh offline ("the
// request never left this device"), `/api/mail/sync` went twelve times in four seconds: every
// overdue folder was tried in turn, each failing at once, because the poll had no backoff and no
// online check of its own. A road failure says nothing about the folder, so the whole schedule
// holds on the link, and it does so through the main sync's own mechanism (`DaimondSync.link`),
// not a second copy. This drives the REAL sync.js, quiet.js and mail.js on a clock the test moves.
//
//   L1  twelve overdue folders on a road that never answers: at most a handful of requests in
//       four seconds, spaced on a growing ladder, not twelve;
//   L2  a browser that says offline sends nothing for a minute; the `online` event polls at once;
//   L3  a poll that lands releases the hold, and the next folder goes at the schedule's pace;
//   L4  an IMAP failure (an answer, not the road) holds nothing: the next folder goes;
//   L5  Refresh on a dead road stops at the first failure, which is told;
//   L6  one mechanism: sync.js exports it and mail.js carries no backoff of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeWindow, loadScript, js } from '../../dev/syncprobe.mjs';

const NOW   = 1_700_000_000_000;
const EVERY = 300;						// seconds: the shortest schedule the dialog offers
const ROAD  = 'daimond-road: the request never left this device';
const FOLDERS = Array.from({ length: 12 }, (_, i) => i ? 'F' + String(i).padStart(2, '0') : 'INBOX');

function elem() {
	const own = { html: '' };
	const p = new Proxy(function () { return p; }, {
		get: (t, k) => {
			if (k === Symbol.toPrimitive) return () => '';
			if (k === 'then') return undefined;
			if (k === 'html') return own.html;
			if (k === 'firstElementChild') return undefined;
			if (k === 'length') return 0;
			return k in own ? own[k] : p;
		},
		set: (t, k, v) => { if (k === 'innerHTML') own.html = String(v); else own[k] = v; return true; },
		apply: () => p,
	});
	return p;
}

// A page with sync.js and the Mail panel, twelve folders all overdue, a gateway whose mail
// door answers by `answer(path)`: 'road' (the request never left), 'ok', or 'imap' (a 502 the
// IMAP server caused), and a clock with real timer delays.
async function rig(answer) {
	const w = makeWindow({ now: NOW });
	let at = NOW, seq = 0;
	const timers = new Map();
	const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
	const drawn = [];
	const box = {
		set innerHTML(v) { drawn.length = 0; },
		get innerHTML() { return ''; },
		appendChild(c) { drawn.push(c.html || ''); return c; },
		querySelector() { return null; },
	};
	w.document.createElement  = () => elem();
	w.document.getElementById = (id) => (id === 'mail-state' ? box : id === 'panel-mail'
		? { querySelector: () => null } : elem());
	const sent = [];						// [ms since the start, folder] of each mail sync that left
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = {
		state: () => ({ authed: true }),
		noteBalance() {},
		isRoad: (e) => !!(e && (e.daimondRoad || String(e.message || '').indexOf(ROAD) === 0)),
		gwFetch: async (path, init) => {
			// The folder listing names all twelve, so Refresh walks every one of them, as it
			// does on a mailbox the server has listed (an empty list walks the INBOX alone).
			if (path === '/api/mail/folders') {
				return { status: 200, ok: true,
					json: async () => ({ ok: true, folders: FOLDERS.map((name) => ({ name })) }) };
			}
			if (path !== '/api/mail/sync') {
				return { status: 200, ok: true, json: async () => ({ ok: true, folders: [] }) };
			}
			const box = JSON.parse(init.body).mailbox;
			const a = answer(box);
			if (a === 'road') { const e = new TypeError(ROAD + ': Failed to fetch'); e.daimondRoad = true; throw e; }
			sent.push([at - NOW, box]);
			if (a === 'ok') {
				return { status: 200, ok: true,
					json: async () => ({ ok: true, messages: [], uid_validity: 1, held_back: 0 }) };
			}
			return { status: 502, ok: false, json: async () => ({ ok: false, error: 'IMAP: connection reset.' }) };
		},
	};
	loadScript(w, 'quiet.js');
	loadScript(w, 'sync.js');
	// The clock's timers start here, so only the mail poll's own are driven.
	w.setTimeout   = (fn, ms) => { const id = ++seq; timers.set(id, { fn, due: at + Math.max(0, ms | 0) }); return id; };
	w.clearTimeout = (id) => { timers.delete(id); };
	loadScript(w, 'mail.js');
	// A road failure is counted where it is thrown too: the gwFetch stub above records it.
	const road = [];
	const gw = w.DaimondGateway.gwFetch;
	w.DaimondGateway.gwFetch = async (path, init) => {
		if (path === '/api/mail/sync' && answer(JSON.parse(init.body).mailbox) === 'road') road.push(at - NOW);
		return gw(path, init);
	};

	const M = w.DaimondMail;
	M.init({
		writeBytes: async () => {}, openFile() {}, refreshFiles() {}, showDoc() {},
		runTool: async () => ({ outcome: 'done', text: '' }),
	});
	const refresh = {};
	FOLDERS.forEach((f) => { refresh[f] = EVERY; });
	await M.applySync({ v: 1, sel: 'a@x.test', tombs: {}, accounts: [{
		address: 'a@x.test', host: 'imap.x.test', port: 993, smtpHost: 's', smtpPort: 465,
		user: 'a@x.test', pass: 'w', refresh: refresh, folder: 'INBOX', touched: NOW - 1000,
		folders: Object.fromEntries(FOLDERS.map((f) => [f, { lastSync: NOW - 3600_000 }])),
	}] });
	await settle();

	return {
		w, M, sent, road, drawn,
		/// Run every timer that falls due in the next `ms`, in order, as the clock moves.
		async run(ms) {
			const end = at + ms;
			for (;;) {
				let next = null;
				for (const [id, t] of timers) if (t.due <= end && (!next || t.due < next[1].due)) next = [id, t];
				if (!next) break;
				timers.delete(next[0]);
				at = Math.max(at, next[1].due); w._setNow(at);
				next[1].fn();
				await settle();
			}
			at = end; w._setNow(at);
		},
		async refresh() { M.refreshAll(); await settle(); for (let i = 0; i < 40; i++) await settle(); },
		/// The browser's `online` event.
		async online() { w.navigator.onLine = true; (w._listeners.online || []).forEach((f) => f({})); await settle(); },
	};
}

test('L1 twelve overdue folders on a dead road: no burst', async () => {
	const r = await rig(() => 'road');
	await r.run(4000);
	assert.ok(r.road.length >= 1, 'the schedule tried the road');
	assert.ok(r.road.length <= 4, 'at most a handful in four seconds, got ' + r.road.length + ' at ' + r.road.join());
	for (let i = 2; i < r.road.length; i++) {
		assert.ok(r.road[i] - r.road[i - 1] >= 250, 'spaced by the ladder: ' + r.road.join());
	}
	await r.run(56000);
	assert.ok(r.road.length <= 9, 'a minute on the ladder is not a poll per tick, got ' + r.road.length);
});

test('L2 offline sends nothing, and the link returning polls at once', async () => {
	const r = await rig(() => 'ok');
	r.w.navigator.onLine = false;
	r.w.dispatchEvent({});
	await r.run(60000);
	assert.equal(r.sent.length + r.road.length, 0, 'no request into a link the browser says is down');
	await r.online();
	await r.run(1000);
	assert.ok(r.sent.length >= 1, 'the link back re-arms the poll without waiting out the sleep');
});

test('L3 a poll that lands releases the hold', async () => {
	let dead = true;
	const r = await rig(() => (dead ? 'road' : 'ok'));
	await r.run(3000);
	const tries = r.road.length;
	dead = false;
	await r.run(400000);
	assert.ok(r.sent.length >= 11, 'the folders go once the road answers, got ' + r.sent.length);
	assert.ok(tries <= 4, 'held while dead: ' + tries);
});

test('L4 an IMAP failure is the folder\'s own and holds nothing', async () => {
	const r = await rig(() => 'imap');
	await r.run(4000);
	assert.ok(r.sent.length >= 12, 'every folder is tried at the schedule\'s pace, got ' + r.sent.length);
});

test('L5 Refresh on a dead road stops at the first failure', async () => {
	const r = await rig(() => 'road');
	await r.refresh();
	assert.equal(r.road.length, 1, 'one request told the person; the rest were not sent into it');
	assert.ok(r.drawn.some((h) => h.includes('mail-err')), 'the failure is told');
	// The same walk on a live road goes through all twelve, so the stop above is the fix and
	// not a walk that had only the INBOX to visit.
	const live = await rig(() => 'ok');
	const before = live.sent.length;
	await live.refresh();
	assert.equal(live.sent.length - before, FOLDERS.length, 'Refresh on a live road walks every listed folder');
});

test('L6 one mechanism: sync.js exports the link and mail.js keeps no backoff of its own', async () => {
	const r = await rig(() => 'ok');
	const L = r.w.DaimondSync && r.w.DaimondSync.link;
	assert.ok(L && typeof L.offline === 'function' && typeof L.wait === 'function' && typeof L.back === 'function',
		'DaimondSync.link carries offline, wait and back');
	const mail = readFileSync(js('mail.js'), 'utf8');
	assert.ok(!/Math\.random|Math\.pow|navigator\.onLine/.test(mail), 'mail.js computes no backoff and reads no link itself');
	assert.ok(/DaimondSync\.link/.test(mail), 'mail.js reads the shared link');
});
