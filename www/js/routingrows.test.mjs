// routingrows.test.mjs -- every state of the routing rows writes the stored routing text that
// parses back to exactly that state (FIRE D-20261018-09 U5b, R1).
//
//	node www/js/routingrows.test.mjs
//	MM_SRC_REV=90eaed81 node www/js/routingrows.test.mjs   # red: the record has no rows
//
// The rows write the same text the typed field did, so the engine and an older build read it
// unchanged. The parser is models.js's own `parseRouting`, lifted from its source; the mapping is
// routingrows.js. Each Auto / Prefer / Avoid state of three hosts, with and without "only these",
// is written, parsed and read back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { source, liftFn } from './testlift.mjs';

function load() {
	let rr;
	try { rr = source('routingrows.js'); } catch (e) { return { missing: 'routingrows.js' }; }
	const win = {};
	new Function('window', 'module', rr)(win, undefined);
	const pr = liftFn(source('models.js'), 'parseRouting');
	if (!pr) return { missing: 'parseRouting' };
	return { R: win.DaimondRoutingRows, parse: new Function(pr + '\nreturn parseRouting;')() };
}

const L = load();
const need = () => assert.ok(!L.missing && L.R, `no routing rows at this revision (${L.missing || 'DaimondRoutingRows'})`);

const HOSTS  = ['SlowCo', 'Fast Host Inc', 'DeepInfra'];
const STATES = ['auto', 'prefer', 'avoid'];

test('every control state round-trips through the stored text', () => {
	need();
	const { R, parse } = L;
	let n = 0;
	const walk = (i, picks) => {
		if (i < HOSTS.length) { STATES.forEach(s => walk(i + 1, picks.concat([s]))); return; }
		for (const only of [false, true]) {
			let p = { order: [], ignore: [], only: false };
			picks.forEach((s, k) => { p = R.set(p, HOSTS[k], s); });
			p = R.setOnly(p, only);
			const txt  = R.text(p);
			const back = parse(txt);
			const want = picks.some(s => s === 'prefer') && only;
			HOSTS.forEach((h, k) => assert.equal(R.choice(back, h), picks[k], `${h} in "${txt}"`));
			assert.equal(back.only, want, `only in "${txt}"`);
			assert.ok(R.expressible(back), `"${txt}" is not expressible`);
			assert.equal(R.text(back), txt, `"${txt}" does not rewrite to itself`);
			n++;
		}
	};
	walk(0, []);
	assert.equal(n, 54);
});

test('Prefer on a host puts it in order, first when it is the only one', () => {
	need();
	const { R, parse } = L;
	const p = R.set(parse('-DeepInfra'), 'SlowCo', 'prefer');
	assert.equal(R.text(p), 'SlowCo, -DeepInfra');
	assert.deepEqual(parse(R.text(p)).order, ['SlowCo']);
	// A second Prefer keeps the first one's place at the head.
	assert.deepEqual(parse(R.text(R.set(p, 'Novita', 'prefer'))).order, ['SlowCo', 'Novita']);
	// Back to Auto takes it out of both lists, and "only these" with it once nothing is preferred.
	const q = R.set(R.setOnly(p, true), 'SlowCo', 'auto');
	assert.equal(R.text(q), '-DeepInfra');
});

test('a typed value the rows cannot say is reported, not rewritten', () => {
	need();
	const { R, parse } = L;
	for (const s of ['SlowCo, -SlowCo', 'SlowCo, SlowCo', '!', '-A, -A'])
		assert.equal(R.expressible(parse(s)), false, `"${s}" claimed expressible`);
	for (const s of ['', 'Novita, Together', 'Novita, -DeepInfra', 'Novita, !'])
		assert.equal(R.expressible(parse(s)), true, `"${s}" refused`);
	// Hand-typed spacing reads the same and rewrites to the canonical spelling.
	assert.equal(R.text(parse('Novita,Together ,  -DeepInfra,!')), 'Novita, Together, -DeepInfra, !');
});

test('rows: measured hosts quickest first, the last one used marked, typed hosts after', () => {
	need();
	const { R, parse } = L;
	const figs = [
		{ model: 'm/x', host: 'SlowCo', rounds: 12, tps: 4, firstMs: 9000, stallShare: 0, slow: true, why: 'rate', lastAt: 300 },
		{ model: 'm/x', host: 'FastCo', rounds: 9, tps: 120, firstMs: 800, stallShare: 0, slow: false, why: '', lastAt: 200 },
		{ model: 'm/y', host: 'Other', rounds: 3, tps: 50, firstMs: 900, stallShare: 0, slow: false, why: '', lastAt: 900 },
	];
	const rows = R.rows(parse('-Typed'), figs, 'm/x');
	assert.deepEqual(rows.map(r => r.host), ['FastCo', 'SlowCo', 'Typed']);
	assert.deepEqual(rows.map(r => r.last), [false, true, false]);
	assert.equal(rows[2].choice, 'avoid');
	assert.equal(rows[2].fig, null);
	assert.deepEqual(R.rows(parse(''), [], 'm/x'), []);
});

test('the person\'s own choice wins over a measured avoid', () => {
	need();
	const { R, parse } = L;
	const figs = [{ model: 'm/x', host: 'SlowCo', rounds: 12, tps: 4, firstMs: 9000, stallShare: 0, slow: true, why: 'rate', lastAt: 1 }];
	const auto = R.rows(parse(''), figs, 'm/x')[0];
	assert.equal(R.avoided(auto, false), true);
	assert.deepEqual(R.reason(auto), { kind: 'rate', n: 12, vars: { tps: 4 } });
	const pref = R.rows(parse('SlowCo'), figs, 'm/x')[0];
	assert.equal(R.avoided(pref, false), false, 'a preferred host shown as avoided');
	assert.equal(R.avoided(auto, true), false, 'under "only these" the measurement adds nothing');
});

// R4 (part 2): a model with no rounds still has hosts to press, from OpenRouter's endpoints list,
// asked only for an opened model and held in a bounded cache.
const EP = { data: { id: 'acme/m', endpoints: [
	{ provider_name: 'Very Long Host Name Incorporated International' }, { provider_name: 'DeepInfra' },
	{ provider_name: 'DeepInfra' }, { provider_name: '' }, {} ] } };

test('hostsFrom reads provider_name once each, in OpenRouter\'s order', () => {
	need();
	assert.ok(L.R.hostsFrom, 'no hostsFrom at this revision');
	assert.deepEqual(L.R.hostsFrom(EP), ['Very Long Host Name Incorporated International', 'DeepInfra']);
	assert.deepEqual(L.R.hostsFrom(null), []);
	assert.deepEqual(L.R.hostsFrom({ data: {} }), []);
});

test('a model with no rounds shows its hosts, and Prefer stores the name', () => {
	need();
	const hosts = L.R.hostsFrom ? L.R.hostsFrom(EP) : [];
	const rows = L.R.rows({ order: [], ignore: [], only: false }, [], 'acme/m', hosts);
	assert.deepEqual(rows.map(r => r.host), hosts);
	assert.ok(rows.length === 2 && rows.every(r => r.fig === null && r.choice === 'auto'));
	const p = L.R.set({ order: [], ignore: [], only: false }, 'DeepInfra', 'prefer');
	assert.equal(L.R.text(p), 'DeepInfra');
	assert.deepEqual(L.parse(L.R.text(p)), { order: ['DeepInfra'], ignore: [], only: false });
	// A measured host is not listed twice, and keeps its figures.
	const figs = [{ model: 'acme/m', host: 'DeepInfra', tps: 50, rounds: 3, lastAt: 1 }];
	const both = L.R.rows({ order: [], ignore: [], only: false }, figs, 'acme/m', hosts);
	assert.deepEqual(both.map(r => [r.host, !!r.fig]), [['DeepInfra', true], ['Very Long Host Name Incorporated International', false]]);
});

test('the host cache asks once per model, keeps an answer 30 min, retries a failure after 2, holds 64', async () => {
	need();
	assert.ok(L.R.hostCache, 'no hostCache at this revision');
	let t = 0, asked = [];
	const c = L.R.hostCache({ now: () => t });
	const settle = () => new Promise(r => setTimeout(r, 0));
	const ok = (m) => { asked.push(m); return EP; };
	c.want('a', ok); c.want('a', ok);
	await settle();
	assert.deepEqual(asked, ['a'], 'one request in flight per model');
	assert.equal(c.get('a').state, 'ok');
	t += 29 * 60e3; c.want('a', ok); await settle();
	assert.equal(asked.length, 1, 'held within 30 min');
	t += 2 * 60e3; c.want('a', ok); await settle();
	assert.equal(asked.length, 2, 'asked again after 30 min');
	assert.equal(c.get('a').hosts.length, 2);
	const bad = (m) => { asked.push(m); throw new Error('down'); };
	c.want('b', bad); await settle();
	assert.equal(c.get('b').state, 'failed');
	t += 60e3; c.want('b', bad); await settle();
	assert.equal(asked.filter(m => m === 'b').length, 1, 'a failure is not re-asked within 2 min');
	t += 61e3; c.want('b', bad); await settle();
	assert.equal(asked.filter(m => m === 'b').length, 2);
	for (let i = 0; i < 100; i++) c.want('m' + i, ok);
	await settle();
	assert.equal(c.size(), 64, 'at most 64 models held');
	assert.equal(c.get('a'), null, 'the oldest asked is dropped first');
});
