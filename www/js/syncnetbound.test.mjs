/* ============================================================
   Test — sync calls time out for real; presence beats go one at a time
   (SYNC-NETBOUND, diag/c2freeze/DIAG_c2freeze.md fixes 0 and 3).

   On a starved connection WebKit queued requests past its six sockets
   per origin, and an aborted queued fetch never settled: `call()`'s
   18 s bound relied on fetch honouring the abort, so `refreshPresence`
   hung for ever. Presence beats had no single flight, so every held
   beat took another socket until the phone could send nothing at all.

   (a) a fetch that never settles and ignores abort -> call() rejects
       (refreshPresence returns) at its deadline;
   (b) with the network stalled, 20 beat ticks leave at most one beat
       request in flight, and the one sent next carries the newest state;
   (c) a beat that times out frees the slot for the next one.

   Drives the REAL www/js/sync.js in a simulated tab with a fake clock.

   Run:  node www/js/syncnetbound.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

/// A clock that moves only when told to, so an 18 s or 60 s deadline costs nothing.
function makeClock() {
	let now = 0, seq = 0;
	const timers = new Map();
	const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
	return {
		setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms | 0), fn }); return id; },
		clearTimeout: (id) => { timers.delete(id); },
		flush,
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				let next = null;
				for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
				if (!next) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].fn();
				await flush();
			}
			now = end;
			await flush();
		},
	};
}

/// A tab whose network black-holes: every request is held, never answered,
/// and an abort is ignored -- the WebKit-queued fetch of the diagnosis.
function makeTab(clock) {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const tab = { win, sent: [], open: 0 };
	win.DaimondIdentity = {
		isUnlocked: () => true, deviceId: () => '00112233445566aa', handle: () => '',
		epoch: () => 0, saltB64: () => 'mm', hasPrevKey: () => false,
	};
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: true }),
		gwFetch: (path, opts) => {
			const req = { path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null };
			tab.sent.push(req);
			tab.open++;
			// Never settles, whatever the signal says.
			return new Promise(() => {});
		},
	};
	win.DaimondCore = { collectSync: async () => ({}), syncSelfDeviceId: () => '00112233445566aa' };
	const body = readFileSync(join(HERE, 'sync.js'), 'utf8');
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console',
		'with (window) {\n' + body + '\n}');
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		clock.setTimeout, clock.clearTimeout, () => 0, () => {},
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return tab;
}

const beats = (tab) => tab.sent.filter((r) => r.method === 'POST' && r.path.indexOf('presence=1') >= 0);

console.log('\na sync call ends at its deadline, and presence beats go one at a time\n');

// (a) refreshPresence's GET is held for ever and ignores its abort.
{
	const clock = makeClock();
	const tab = makeTab(clock);
	let settled = false;
	tab.win.DaimondSync.refreshPresence().then(() => { settled = true; }, () => { settled = true; });
	await clock.advance(17000);
	check('(a) a held GET is still pending before its deadline', !settled);
	await clock.advance(1500);
	check('(a) a GET whose fetch ignores the abort still settles at its deadline (18 s)', settled);
}

// (b) 20 beat ticks on a stalled network.
{
	const clock = makeClock();
	const tab = makeTab(clock);
	for (let i = 0; i < 20; i++) {
		tab.win.DaimondSync.beatPresence('dev', 'name', true, false, false, true, false, false, i, []);
		await clock.advance(1000);
	}
	check('(b) 20 ticks on a stalled network put at most 1 beat on the wire', beats(tab).length <= 1,
		beats(tab).length + ' beat request(s)');
	// The first beat's deadline frees the slot; the one that follows is the newest state.
	await clock.advance(60000);
	const b = beats(tab);
	check('(b) the beat sent next carries the newest state, not a queued old one',
		b.length === 2 && b[1].body && b[1].body.busy === 19,
		b.map((x) => x.body && x.body.busy).join(','));
}

// (c) a beat that times out frees the slot for the next.
{
	const clock = makeClock();
	const tab = makeTab(clock);
	let first = 'pending';
	tab.win.DaimondSync.beatPresence('dev', 'name', true).then((r) => { first = r; });
	await clock.advance(61000);
	check('(c) a beat held past its deadline settles (null)', first === null, String(first));
	tab.win.DaimondSync.beatPresence('dev', 'name', true, false, false, true, false, false, 7, []);
	await clock.flush();
	const b = beats(tab);
	check('(c) the next beat goes at once', b.length === 2 && b[1].body.busy === 7,
		b.length + ' beat request(s)');
}

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nall sync-netbound checks passed\n');
process.exit(failures ? 1 : 0);
