/* ============================================================
   Test — the rail's Status exceptions (needs.js, D-20261015-15).
   ------------------------------------------------------------
   The Status section is calm when nothing needs the person: one muted
   sync line. Each thing that does need them is one row with a dot, a
   short sentence and one act, red first, then amber. A row goes when
   its cause does. Design: STATUS-REVIEW.md, st-S1x-desk.png.

     node www/js/needs.test.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const N = require('./needs.js');
const ids = (f) => N.compute(f).map(r => r.id);

test('calm: nothing needs him, so no rows', () => {
	assert.deepEqual(N.compute({}), []);
	assert.deepEqual(N.compute({ hand: 'guarded', updateReady: false, pots: [] }), []);
});

test('Bypass is a red row with Guard; Guarded and Ask are silent', () => {
	const [r] = N.compute({ hand: 'bypass' });
	assert.equal(r.id, 'bypass');
	assert.equal(r.tone, 'bad');
	assert.equal(r.act, 'guard');
	assert.deepEqual(ids({ hand: 'guarded' }), []);
	assert.deepEqual(ids({ hand: 'ask' }), []);
});

test('a key with under a day of runway raises "~N h left" and Top Up', () => {
	const pots = [{ key: 'byok', provider: 'openrouter', what: 'OpenRouter key', label: 'Your OpenRouter key', minutes: 20 * 60 }];
	const [r] = N.compute({ pots });
	assert.equal(r.id, 'money:byok');
	assert.equal(r.tone, 'warn');
	assert.equal(r.act, 'topup');
	assert.equal(r.key, 'needs.money_hours');
	assert.equal(r.vars.n, 20);
	assert.equal(r.vars.what, 'OpenRouter key');
	assert.equal(r.url, 'https://openrouter.ai/settings/credits');
	// under an hour it counts minutes, never "~0 h"
	const [m] = N.compute({ pots: [{ key: 'byok', label: 'Your OpenRouter key', minutes: 12 }] });
	assert.equal(m.key, 'needs.money_mins');
	assert.equal(m.vars.n, 12);
	// a day or more, no rate, or an empty pot (null runway): silent
	assert.deepEqual(ids({ pots: [{ key: 'byok', label: 'k', minutes: 24 * 60 }] }), []);
	assert.deepEqual(ids({ pots: [{ key: 'byok', label: 'k', minutes: null }] }), []);
});

test('update ready raises Reload', () => {
	const [r] = N.compute({ updateReady: true });
	assert.equal(r.id, 'update');
	assert.equal(r.act, 'reload');
	assert.equal(r.tone, 'warn');
});

test('no model and a stalled sync are exceptions too', () => {
	assert.deepEqual(ids({ noModel: true }), ['model']);
	assert.equal(N.compute({ noModel: true })[0].act, 'connect');
	const [s] = N.compute({ syncStalledMs: 3 * 3600e3 });
	assert.equal(s.id, 'sync');
	assert.equal(s.vars.n, 3);
	assert.equal(s.act, 'retry');
	// a stall under ten minutes is a hiccup, not an exception
	assert.deepEqual(ids({ syncStalledMs: 5 * 60e3 }), []);
});

test('order: red first, then amber in the design order', () => {
	const all = ids({
		updateReady: true, hand: 'bypass', noModel: true, syncStalledMs: 3 * 3600e3,
		pots: [{ key: 'byok', label: 'Your OpenRouter key', minutes: 600 }],
	});
	assert.deepEqual(all, ['bypass', 'money:byok', 'update', 'sync', 'model']);
});
