/* ============================================================
   Test -- the default stands only on a key this device has opened
   (DIAG_BUSY3 fix 2, 23 Oct 2026).
   ------------------------------------------------------------
   THE BUG. `runnable()` let the default ("Everyone uses") stand on a
   SEALED key (`hasKey` counts `keyEnc`), while `resolve()`, which runs
   the turn, needs an opened one (`keyFor`). In the window between a
   models merge adopting a newer default and its sealed key opening, or
   for good when it never opens here, the device reported a default it
   could not resolve.

   THE FIX. One predicate for both, `canRun(id)`: this device holds an
   opened key for the provider (`keyFor(id)` is not empty).

     K1  merge pending its unwrap: the default stays on the last choice
         this device can run, and that choice resolves;
     K2  the unwrap lands: the new default stands and resolves;
     K3  a sealed key that will not open here never takes the default;
     K4  everywhere above, a standing default always resolves;
     K5  `keyState` names each state (none, opening, failed, opened; HT3) and
         `canRun` is true on `opened` alone.

   The REAL models.js. Red proof: `git stash` the models.js change, run:

     node www/js/defaultopened.test.mjs
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const w = makeWindow({ now: 1_000_000_000 });
const gates = {};								// sealed key -> { promise, open, fail }
function gate(enc) {
	if (!gates[enc]) {
		let open, fail;
		const promise = new Promise((a, b) => { open = a; fail = b; });
		gates[enc] = { promise, open, fail };
	}
	return gates[enc];
}
w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: (s) => gate(s).promise };
const c = loadPage({ window: w, want: ['mergeTombMap', 'loadTombMap'], stub: { ChatStore: { putTombs: () => Promise.resolve(true) },
	storageAlarm: () => {}, tOr: (k, f) => f } });
w.DaimondCore = { mergeTombs: c.mergeTombMap, loadTombMap: c.loadTombMap, tombs: c.loadTombMap };
loadScript(w, 'models.js');
const M = w.DaimondModels;
M.init({});

const row = (enc, t) => ({ name: enc, url: 'https://' + enc, keyEnc: enc, models: ['m'], fetched: t, touched: t });
const ks = (id) => (M.keyState ? M.keyState(id) : 'no keyState');	// absent before the fix: red, not a crash
const cr = (id) => (M.canRun ? M.canRun(id) : null);
function agrees(label) {
	const d = M.getDefault();
	check(label + ': a standing default resolves (K4)', !d.provider || !!M.resolve(d.provider, d.model), d);
}

console.log('defaultopened: the default stands only on an opened key (real models.js)');
gate('kA').open('key-a');
await M.applySync({ v: 1, providers: { 'custom:a': row('kA', 10) }, tombs: {}, def: { provider: 'custom:a', model: 'm' }, defAt: 10 });
check('A merged and opened: A is the default', M.getDefault().provider === 'custom:a', M.getDefault());
agrees('A');

// K1: B's row and its newer default arrive; its key has not opened yet.
check('K5 no row: none', ks('custom:b') === 'none' && !cr('custom:b'), ks('custom:b'));
const pB = M.applySync({ v: 2, providers: { 'custom:a': row('kA', 10), 'custom:b': row('kB', 20) }, tombs: {},
	def: { provider: 'custom:b', model: 'm' }, defAt: 20 });
check('K1 B merged, key not opened: the default stays A', M.getDefault().provider === 'custom:a', M.getDefault());
agrees('K1');
check('K5 merged, unwrap pending: opening', ks('custom:b') === 'opening' && !cr('custom:b'), ks('custom:b'));

// K2: the key opens.
gate('kB').open('key-b');
await pB;
check('K2 B key opened: B is the default', M.getDefault().provider === 'custom:b', M.getDefault());
agrees('K2');
check('K5 unwrapped: opened', ks('custom:b') === 'opened' && cr('custom:b'), ks('custom:b'));

// K3: C's sealed key will not open on this device.
gate('kC').fail(new Error('not this identity'));
await M.applySync({ v: 3, providers: { 'custom:a': row('kA', 10), 'custom:b': row('kB', 20), 'custom:c': row('kC', 30) },
	tombs: {}, def: { provider: 'custom:c', model: 'm' }, defAt: 30 });
check('K3 C never opens: the default stays B', M.getDefault().provider === 'custom:b', M.getDefault());
agrees('K3');
check('K5 never opens: failed', ks('custom:c') === 'failed' && !cr('custom:c'), ks('custom:c'));

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
