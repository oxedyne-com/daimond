// R568-FU F5 (17 Oct 2026): when loading the chats failed at boot, `runnerReady` never settled,
// so every collected errand waited on it, held, until the page was reloaded, and nothing on the
// screen said so. A failed load now settles it (the waiters hear "not up" and leave the row held
// for a device that can run it), says so on screen, and tries again; the retry that succeeds is
// what makes the runner ready.
//
// daimond.js cannot be loaded whole in Node, so the boot's chat load is cut out by name and run
// against a stub world. On the base, where the load is still inline in `boot`, that inline
// sequence is cut instead.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readPage(join(HERE, 'daimond.js'), 'utf8');

function cut(name) {
	let at = src.indexOf('\n\tasync function ' + name + '(');
	if (at < 0) at = src.indexOf('\n\tfunction ' + name + '(');
	if (at < 0) return null;
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at + 1, end + 3);
}

/// The boot's chat load, as `bootChats()`, and the runner-ready promise it settles.
function theLoad() {
	const named = cut('loadChatsHeld');
	const arm = cut('armRunnerReady');
	if (named && arm) {
		return arm + '\n' + named + '\nrunnerReady = armRunnerReady();\n'
			+ 'async function bootChats() { chats = await loadChatsHeld(); runnerReadyResolve(); }';
	}
	// The base: made once at module load, resolved after an inline `loadChats`.
	const make = src.indexOf('\tvar runnerReady = new Promise(');
	assert.ok(make >= 0, 'runnerReady is not made in daimond.js');
	const line = src.slice(make, src.indexOf('\n', make));
	assert.ok(src.includes('\t\tchats = await loadChats();'), 'the boot does not load the chats');
	return line + '\nasync function bootChats() { chats = await loadChats(); runnerReadyResolve(); }';
}

const PENDING = Symbol('pending');
const ticks = (n = 20) => new Promise((r) => setTimeout(r, n));
async function state(p) {
	return Promise.race([p.then(() => 'up', () => 'down'), ticks(30).then(() => PENDING)]);
}

function world(results) {
	const W = { notices: [], loads: 0, retry: null };
	const code = 'var runnerReadyResolve, runnerReadyReject, runnerReady, chats = null;\n' + theLoad()
		+ '\nreturn { boot: bootChats, ready: function () { return runnerReady; }, chats: function () { return chats; } };';
	const deps = {
		loadChats: async () => {
			const r = results[W.loads++];
			if (r instanceof Error) throw r;
			return r;
		},
		// The visible state: `null` clears it; an error shows it and resolves when the retry is due,
		// which the test decides by calling `W.retry()`.
		chatsHeldNotice: (e) => {
			W.notices.push(e ? String(e.message || e) : null);
			if (!e) return Promise.resolve();
			return new Promise((r) => { W.retry = r; });
		},
		diag: () => {},
	};
	const fn = new Function(...Object.keys(deps), code);
	W.api = fn(...Object.values(deps));
	return W;
}

test('a failed chat load settles runnerReady, says so, and the retry makes it ready', async () => {
	const W = world([new Error('IndexedDB would not open'), [{ id: 'c1' }]]);
	const first = W.api.ready();
	const booting = W.api.boot();
	await ticks();
	assert.equal(await state(first), 'down', 'a waiter on the failed load was left hanging');
	assert.deepEqual(W.notices, ['IndexedDB would not open'], 'the held state is not on screen');
	W.retry();
	await booting;
	assert.equal(await state(W.api.ready()), 'up', 'the retry that loaded the chats did not make the runner ready');
	assert.deepEqual(W.api.chats(), [{ id: 'c1' }]);
	assert.equal(W.notices[W.notices.length - 1], null, 'the held notice stayed up after the chats came');
});

test('between tries a new waiter is told at once, never hung', async () => {
	const W = world([new Error('a'), new Error('b'), [{ id: 'c1' }]]);
	const booting = W.api.boot();
	await ticks();
	assert.equal(await state(W.api.ready()), 'down', 'a waiter arriving after a failed try hangs');
	W.retry();
	await ticks();
	assert.equal(await state(W.api.ready()), 'down', 'the second failure left the waiter hanging');
	assert.equal(W.notices.length, 2);
	W.retry();
	await booting;
	assert.equal(await state(W.api.ready()), 'up');
	assert.equal(W.loads, 3);
});

test('a load that succeeds first time is ready and shows nothing', async () => {
	const W = world([[{ id: 'c1' }]]);
	await W.api.boot();
	assert.equal(await state(W.api.ready()), 'up');
	assert.ok(W.notices.every((n) => n === null), JSON.stringify(W.notices));
});
