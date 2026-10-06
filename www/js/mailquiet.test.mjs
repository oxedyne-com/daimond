// mailquiet.test.mjs -- an automatic mail poll that fails says nothing until the failure persists.
//
//	node --test www/js/mailquiet.test.mjs
//
// The owner saw "The mail server's TLS certificate could not be validated." in red at the head
// of the Mail panel (2026-10-06). Gmail had dropped one IMAP connection from the gateway and the
// next poll succeeded, so the line announced a blip that had already healed, from a poll nobody
// asked for. mail.js said an automatic poll "says nothing" and its failure path had not been told.
//
// The rule is quiet.js (DaimondQuiet): asked work speaks at once, automatic work after two
// failures in a row, and a success clears what was shown. This drives the REAL mail.js and
// quiet.js against a scripted gateway and reads what the panel DRAWS: a `.mail-err` child of
// #mail-state, not a field behind it. Each case is a script of gateway replies; `ok` and `fail`
// are the two answers a poll can get.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

const NOW   = 1_700_000_000_000;
const EVERY = 300;						// seconds: the shortest schedule the dialog offers
const WORDS = "The mail server's TLS certificate could not be validated.";

// An element that answers anything and remembers the html it was given.
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

// A page with the Mail panel's state block, a gateway that answers from `script`, and a clock.
async function rig(script) {
	const w = makeWindow({ now: NOW });
	const timers = [];
	w.setTimeout   = (fn) => { timers.push(fn); return timers.length; };
	w.clearTimeout = () => {};

	// What #mail-state holds right now: render clears it, then appends what it draws.
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

	const seen = [];						// what the panel showed as each request left it
	const sent = [];
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = {
		state: () => ({ authed: true }),
		noteBalance() {},
		gwFetch: async (path) => {
			if (path !== '/api/mail/sync') {
				return { status: 200, ok: true, json: async () => ({ ok: true, folders: [] }) };
			}
			sent.push(path);
			seen.push(drawn.some((h) => h.includes('mail-err')));
			if (script.shift() === 'ok') {
				return { status: 200, ok: true,
					json: async () => ({ ok: true, messages: [], uid_validity: 1, held_back: 0 }) };
			}
			return { status: 502, ok: false, json: async () => ({ ok: false, error: WORDS }) };
		},
	};
	loadScript(w, 'quiet.js');
	loadScript(w, 'mail.js');

	const M = w.DaimondMail;
	M.init({
		writeBytes: async () => {}, openFile() {}, refreshFiles() {}, showDoc() {},
		runTool: async () => ({ outcome: 'done', text: '' }),
	});
	await M.applySync({ v: 1, sel: 'a@x.test', tombs: {}, accounts: [{
		address: 'a@x.test', host: 'imap.x.test', port: 993, smtpHost: 's', smtpPort: 465,
		user: 'a@x.test', pass: 'w', refresh: { INBOX: EVERY }, folder: 'INBOX', touched: NOW - 1000,
	}] });

	const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
	let at = NOW;
	return {
		M, sent, seen,
		/// Is a red error line on the panel?
		red:   () => drawn.some((h) => h.includes('mail-err') && h.includes('TLS certificate')),
		/// One poll by the schedule, an interval after the last.
		async poll() {
			at += EVERY * 1000; w._setNow(at);
			timers.splice(0).slice(-1).forEach((fn) => fn());
			await settle();
		},
		/// A press of Sync now.
		async press() { at += 1000; w._setNow(at); M.sync(); await settle(); },
		/// A press of the panel's Refresh button.
		async refresh() { at += 1000; w._setNow(at); M.refreshAll(); await settle(); },
		/// Arm the schedule, so `poll` has a timer to run.
		async arm() { M.setRefresh('a@x.test', 'INBOX', EVERY + 1); M.setRefresh('a@x.test', 'INBOX', EVERY); await settle(); },
	};
}

test('one automatic poll that fails paints nothing', async () => {
	const r = await rig(['fail']);
	await r.arm();
	await r.poll();
	assert.equal(r.sent.length, 1, 'the poll reached the gateway');
	assert.equal(r.red(), false, 'a blip is not announced');
});

test('automatic polls that keep failing do paint', async () => {
	const r = await rig(['fail', 'fail']);
	await r.arm();
	await r.poll();
	assert.equal(r.red(), false, 'quiet after the first');
	await r.poll();
	assert.equal(r.sent.length, 2);
	assert.equal(r.red(), true, 'two in a row is not a blip');
});

test('a failing Sync now paints at once', async () => {
	const r = await rig(['fail']);
	await r.press();
	assert.equal(r.sent.length, 1);
	assert.equal(r.red(), true, 'the person asked, so the person is told');
});

test('a failing Refresh paints at once', async () => {
	const r = await rig(['fail']);
	await r.refresh();
	assert.equal(r.sent.length, 1);
	assert.equal(r.red(), true, 'Refresh is pressed, though it syncs quietly');
});

test('a success clears a shown error', async () => {
	const r = await rig(['fail', 'fail', 'ok']);
	await r.arm();
	await r.poll();
	await r.poll();
	assert.equal(r.red(), true);
	await r.poll();
	assert.equal(r.red(), false, 'the next success takes it down');
});

test('a manual success also clears it', async () => {
	const r = await rig(['fail', 'ok']);
	await r.press();
	assert.equal(r.red(), true);
	await r.press();
	assert.equal(r.red(), false);
});

test('a success between two failures starts the count again', async () => {
	const r = await rig(['fail', 'ok', 'fail']);
	await r.arm();
	await r.poll();
	await r.poll();
	await r.poll();
	assert.equal(r.sent.length, 3);
	assert.equal(r.red(), false, 'fail, ok, fail is two blips, not a streak');
});

test('a shown error stays on screen while the next poll runs', async () => {
	const r = await rig(['fail', 'fail', 'fail']);
	await r.arm();
	await r.poll();
	await r.poll();
	await r.poll();
	assert.equal(r.seen[2], true, 'the line does not blink off for each retry');
	assert.equal(r.red(), true);
});

test('a failed press counts toward the next automatic failure', async () => {
	const r = await rig(['fail', 'fail']);
	await r.arm();
	await r.press();
	await r.poll();
	assert.equal(r.red(), true, 'two failures in a row, whoever pressed');
});
