// UNBLOCK-24 r3, runner ask at the press (18 Oct 2026). Pressing the ✭ on this device's own
// row in Settings › Devices only saved the nomination; runner.js asked "Make this device the
// runner?" on its next fifteen-second poll, so the dialog arrived 0-15 s later over whatever
// screen was up by then (the r570v crawl's COVERED row on admin: home). The press now puts the
// question itself: yes nominates, no nominates nothing. A nomination made on ANOTHER device
// keeps the polled ask, which is the case the poll is for.
//
// daimond.js cannot be loaded whole in Node, so `setNominee` is cut out by name and run beside
// the REAL runner.js in a simulated tab whose confirm box the test answers.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const app  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const run  = readFileSync(join(HERE, 'runner.js'), 'utf8');

const NOM  = 'daimond-nominated';
const DEV  = 'daimond-id-device';
const KEY  = 'daimond-runner-posture';
const ME   = 'a'.repeat(32);
const PEER = 'b'.repeat(32);

function cutNominee() {
	const at = app.indexOf('\n\t\tfunction setNominee(');
	assert.ok(at >= 0, 'setNominee is not in daimond.js');
	// The press and, where the fix splits it out, the save it hands the answer to.
	let end = app.indexOf('\n\t\t}\n', at);
	if (app.startsWith('\n\n\t\tfunction saveNominee(', end + 4)) end = app.indexOf('\n\t\t}\n', end + 5);
	return app.slice(at + 1, end + 4);
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

/// One tab: the real runner.js and the cut `setNominee`, with a confirm box that waits for
/// `answer(yes)`. No interval runs, so any dialog seen is the press's own.
function tab() {
	const local = new Map([[DEV, ME]]);
	const dlg = { open: 0, at: 0, resolve: null };
	const drawn = { n: 0 };
	const win = {
		addEventListener() {},
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k),
		},
		DaimondCore: {
			confirm() {
				dlg.open++; dlg.at = Date.now();
				return new Promise((r) => { dlg.resolve = r; });
			},
			busy: () => false,
		},
		DaimondWake: { hold() {}, release() {}, regain() {} },
		DaimondIdentity: { isUnlocked: () => false },
	};
	win.window = win;
	const document = { readyState: 'complete', visibilityState: 'visible', addEventListener() {} };
	// The module starts its own poll; a timer that never fires keeps it from running.
	const idle = () => 0;
	new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
		'with (window) {\n' + run + '\n}')(win, document, idle, idle, idle, idle);
	const body = cutNominee();
	const press = new Function('window', 'DaimondRunner', 'DaimondSync', 'deviceId', 'nominateDevice',
		'renderHome', 'toast', 't', body + '\nreturn setNominee;')(
		win, win.DaimondRunner, undefined, () => ME,
		// Returns the record, as the real one does: a null is a refused id, and
		// saveNominee says so (STARFIX).
		(id) => { const rec = { id, at: 1 }; if (id) local.set(NOM, JSON.stringify(rec)); else local.delete(NOM); return rec; },
		() => { drawn.n++; }, () => { throw new Error('a refused star in a test that refuses none'); }, (k) => k);
	return {
		local, dlg, drawn, press,
		answer: async (yes) => { dlg.resolve(yes); await settle(); },
		nominee: () => { const r = local.get(NOM); return r ? JSON.parse(r).id : ''; },
	};
}

test('own ✭: the runner question is up at the press, and Cancel nominates nothing', async () => {
	const t = tab();
	const t0 = Date.now();
	t.press(ME);
	await settle();
	assert.equal(t.dlg.open, 1, 'the press did not ask "Make this device the runner?"');
	assert.ok(t.dlg.at - t0 < 1000, 'the question came ' + (t.dlg.at - t0) + ' ms after the press');
	assert.equal(t.nominee(), '', 'the nomination was saved before the answer');
	await t.answer(false);
	assert.equal(t.local.has(NOM), false, 'Cancel left daimond-nominated set');
	assert.notEqual(t.local.get(KEY), '1', 'Cancel armed the posture');
});

test('own ✭: yes nominates this device and arms it', async () => {
	const t = tab();
	t.press(ME);
	await settle();
	await t.answer(true);
	assert.equal(t.nominee(), ME);
	assert.equal(t.local.get(KEY), '1');
	assert.ok(t.drawn.n >= 1, 'the list was not redrawn');
});

test("another device's ✭ and un-nominating save at once, unasked", async () => {
	const t = tab();
	t.press(PEER);
	await settle();
	assert.equal(t.dlg.open, 0);
	assert.equal(t.nominee(), PEER);
	t.press('');
	await settle();
	assert.equal(t.dlg.open, 0);
	assert.equal(t.local.has(NOM), false);
});
