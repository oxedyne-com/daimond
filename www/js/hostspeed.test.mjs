// hostspeed.test.mjs -- each round's host speed reaches the lens and the page (D-20261020-10).
//
//	node --test www/js/hostspeed.test.mjs
//
// The engine measures every round's host, first token and rate (src/hostspeed.rs) and states
// them on `round_meta` as `o`, `tf`, `gm`. Here: the lens row built from that event carries
// output tokens and its rate, and its bytes as `by` (the envelope's `b` is the build tag, which
// overwrote them); the `round` rows carry `o`; and `DaimondHostSpeed.figures()` gives the page
// the fixed shape the U5b routing rows and Model Compare build on.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// daimond.js's own `roundMetaRow`, lifted out of its source: the function every round_meta arm
// (chat, worker, daimon) builds its feed row with.
function liftRoundMetaRow() {
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');
	const at = src.indexOf('function roundMetaRow(');
	assert.ok(at >= 0, 'daimond.js has no roundMetaRow');
	const end = src.indexOf('\n\t}\n', at);
	return new Function(src.slice(at, end + 3) + '\nreturn roundMetaRow;')();
}

// What `event_to_js` hands the page for one round: 1,200 output tokens over 30 s on SlowCo.
const EV = { type: 'round_meta', gen: 'gen-1', finish: 'stop', nfinish: 'stop', provider: 'SlowCo',
	stalled: false, b: 48213, f: 2100, g: 900, ms: 34000, p: 9000, ca: 8000, o: 1200, tf: 4000, gm: 30000 };

test('the lens round_meta row carries output tokens, first token, rate and bytes as `by`', () => {
	const roundMetaRow = liftRoundMetaRow();
	const row = roundMetaRow({ turn: 'T1', r: 1 }, EV, { p: 9000, ca: 8000 });
	assert.equal(row.o, 1200, 'output tokens lost');
	assert.equal(row.tf, 4000, 'first token lost');
	assert.equal(row.tps, 40, '1200 tokens over 30 s is 40 tok/s');
	assert.equal(row.by, 48213, 'bytes lost');
	assert.ok(!('b' in row), 'bytes still ride as `b`, which the envelope build tag overwrites');
	assert.equal(row.provider, 'SlowCo');
	assert.deepEqual([row.turn, row.r, row.p, row.ca, row.f, row.g, row.ms], ['T1', 1, 9000, 8000, 2100, 900, 34000]);
	// A round from an engine before the change states none, and the row says 0 rather than NaN.
	const old = roundMetaRow({ w: 'W1', r: 2 }, { provider: 'X', b: 5 }, { p: 0, ca: 0 });
	assert.deepEqual([old.o, old.tf, old.tps, old.by], [0, 0, 0, 5]);
});

test('the `round` rows carry the round\'s output tokens', () => {
	// The feed's `roundFeed` reads only the event; the rest of debugshare.js needs a tab, so the
	// function is checked on its source for the `o` it now carries.
	const src = readPage(join(HERE, 'debugshare.js'), 'utf8');
	const at = src.indexOf('function roundFeed(');
	const body = src.slice(at, src.indexOf('flush: send', at));
	assert.ok(/o:\s*Math\.round\(Number\(ev && ev\.o\)/.test(body), 'roundFeed.meta does not take o');
	assert.ok(/if \(p\.o == null\) p\.o = use\.o;/.test(body), 'roundFeed.add does not put o on the row');
});

function loadHostSpeed(ls) {
	const win = {};
	new Function('window', 'localStorage', 'setTimeout', 'clearTimeout',
		readPage(join(HERE, 'hostspeed.js'), 'utf8'))(win, ls, () => 1, () => {});
	return win.DaimondHostSpeed;
}

test('DaimondHostSpeed.figures() gives one fixed-shape row per model+host', () => {
	const map = new Map();
	const ls = { getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)) };
	const HS = loadHostSpeed(ls);
	assert.deepEqual(HS.figures(), [], 'no engine yet is no figures');
	const json = JSON.stringify([
		{ model: 'm', host: 'SlowCo', rounds: 4, stalls: 1, first_ms: 31000, tps: 9.5, out: 4000, last_at: 7, slow: 'stalls' },
		{ model: 'm', host: 'FastCo', rounds: 5, stalls: 0, first_ms: null, tps: null, out: 50, last_at: 9, slow: '' },
	]);
	let loaded = null;
	const wasm = { host_speeds: () => json, host_speeds_save: () => 'saved', host_speeds_load: t => { loaded = t; return 0; } };
	map.set(HS.KEY, 'earlier');
	HS.attach(wasm);
	assert.equal(loaded, 'earlier', 'last visit\'s window is not given back to the engine');
	assert.deepEqual(HS.figures(), [
		{ model: 'm', host: 'FastCo', rounds: 5, tps: null, firstMs: null, stallShare: 0, slow: false, why: '', out: 50, lastAt: 9 },
		{ model: 'm', host: 'SlowCo', rounds: 4, tps: 9.5, firstMs: 31000, stallShare: 0.25, slow: true, why: 'stalls', out: 4000, lastAt: 7 },
	]);
	assert.equal(HS.save(), true);
	assert.equal(map.get(HS.KEY), 'saved');
	assert.deepEqual(HS.parse('not json'), []);
});

test('index.html loads hostspeed.js before modelcompare.js, and the page attaches it at boot', () => {
	const html = readPage(join(HERE, '..', 'index.html'), 'utf8');
	const a = html.indexOf('js/hostspeed.js'), b = html.indexOf('js/modelcompare.js');
	assert.ok(a > 0 && a < b, 'hostspeed.js must load, and before modelcompare.js');
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');
	assert.ok(/DaimondHostSpeed\.attach\(Wasm\)/.test(src), 'the engine is never attached');
});
