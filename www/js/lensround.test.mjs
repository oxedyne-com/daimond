// lensround.test.mjs -- the lens `round` row states that round's own prompt and cached tokens.
//
//	node --test www/js/lensround.test.mjs
//
// r578 U3. Every `round` row the lens held carried `ctx:0` and `ca:0`: the rows read the
// `live_*` getters off the chat's app, and a Diamond's daimon runs on its own app and its own
// agent (`diamondApp`, `compose_daimon`), so the app the row read had never run a round. The
// engine now states each round's own figures on its `round_meta` event, and the turn's
// `roundFeed` carries them onto the round's rows. This drives the REAL debugshare.js in a
// stand-in tab, and reads daimond.js's source for the call sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Only as much of a tab as debugshare.js touches: a Map for localStorage, a document with no
// header, a `fetch` that holds every post, and timers that never fire.
function loadFeed() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => store.delete(k),
	};
	const node = () => ({
		children: [], style: {}, _attrs: {},
		setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
		addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
		insertBefore(c) { this.children.unshift(c); return c; }, remove() {},
		querySelector() { return null; },
	});
	const document = {
		readyState: 'complete', visibilityState: 'visible', head: node(), body: node(),
		addEventListener() {}, createElement: node, getElementById: () => null,
		querySelector: () => null, querySelectorAll: () => [],
	};
	const win = { addEventListener() {}, dispatchEvent() { return true; }, DaimondSync: { nudge() {} },
		DaimondGateway: { clientApi: () => 3 } };	// the page's gateway.js, the one copy of the version
	const quiet = {};
	['log', 'info', 'debug', 'warn', 'error'].forEach((l) => { quiet[l] = () => {}; });
	const fetchImpl = () => new Promise(() => {});
	function CustomEventShim(type, init) { this.type = type; this.detail = init && init.detail; }
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	for (const rel of ['stamp.js', 'scrub.js', 'debugshare.js']) {
		const fn = new Function(
			'window', 'document', 'localStorage', 'fetch', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'CustomEvent',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
			'with (window) {\n' + readFileSync(join(HERE, rel), 'utf8') + '\n}');
		fn(win, document, localStorage, fetchImpl, btoa, atob, TextEncoder, TextDecoder,
			CustomEventShim, () => 1, () => {}, () => 1, () => {}, quiet);
	}
	const DS = win.DEBUG_SHARE;
	DS.setEnabled(true);
	const rows = (id) => DS._outbox().filter((r) => r.tag === 'ev round')
		.map((r) => JSON.parse(r.data)).filter((e) => e.turn === id);
	return { DS, rows };
}

test('a round_meta of prompt 78000 and cached 74000 yields a round row of ctx 78000 and ca 74000', () => {
	const { DS, rows } = loadFeed();
	const rf = DS.roundFeed();
	// What `event_to_js` hands the page for a round, read off a real OpenRouter usage block.
	const use = rf.meta({ type: 'round_meta', provider: 'InferenceNet', p: 78000, ca: 74000 });
	assert.deepEqual(use, { p: 78000, ca: 74000, o: 0 }, 'the round_meta row is not given the round\'s own figures');
	rf.add({ turn: 'T1', r: 1, win: 131072, msgs: 12, tool: 'file_read' });
	const got = rows('T1');
	assert.equal(got.length, 1);
	assert.equal(got[0].ctx, 78000, 'ctx is not this round\'s prompt tokens');
	assert.equal(got[0].ca, 74000, 'ca is not this round\'s cached tokens');
	// And the host that answered, so one row holds host, prompt and cached tokens (r578b F7).
	assert.equal(got[0].prov, 'InferenceNet', 'the round row does not name the provider that served it');
	// A second call in the same round states the same round's figures.
	rf.add({ turn: 'T1', r: 2, win: 131072, msgs: 13, tool: 'file_write' });
	assert.deepEqual(rows('T1').map((e) => [e.ctx, e.ca]), [[78000, 74000], [78000, 74000]]);
	// A new turn's feed starts from nothing, never from another turn's round.
	const fresh = DS.roundFeed();
	fresh.add({ turn: 'T2', r: 1, tool: 'file_read' });
	assert.deepEqual(rows('T2').map((e) => [e.ctx, e.ca, e.prov]), [[0, 0, '']]);
});

test('the fold past 60 rounds still folds, on the rounds\' own figures', () => {
	const { DS, rows } = loadFeed();
	const rf = DS.roundFeed();
	for (let r = 1; r <= 75; r++) {
		rf.meta({ p: r === 65 ? 99999 : 2000 + r, ca: 1000 + r });
		rf.add({ turn: 'T75', r, tool: 't' });
	}
	rf.flush();
	const got = rows('T75');
	assert.equal(got.length, 62, '60 rows, a fold of ten and the flushed fold of five');
	const f1 = got[60];
	assert.equal(f1.r0, 61); assert.equal(f1.r, 70); assert.equal(f1.co, 10);
	assert.equal(f1.cmax, 99999, 'the fold lost the highest prompt it covered');
	assert.equal(f1.ctx, 2070); assert.equal(f1.ca, 1070);
});

test('daimond.js builds every round row from the round\'s own event, the daimon\'s included', () => {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	assert.ok(!/live_last_prompt_tokens\)\s*\|\|\s*0,/.test(src) && !/live_cached_tokens\)\s*\|\|\s*0,/.test(src),
		'a round row still reads a live_* getter off an app that may not be the one running');
	const arms = src.split("ev.type === 'round_meta'").slice(1).map((s) => s.slice(0, 1600));
	assert.ok(arms.length >= 3, 'the chat, the worker and the daimon each have a round_meta arm');
	// One helper builds every arm's row (D-20261020-10), and it carries p and ca.
	const helper = src.slice(src.indexOf('function roundMetaRow('), src.indexOf('function roundMetaRow(') + 1600);
	assert.ok(/row\.p\s*=\s*use\.p/.test(helper) && /row\.ca\s*=\s*use\.ca/.test(helper), 'roundMetaRow does not carry p and ca');
	arms.forEach((arm, i) => {
		assert.ok(/roundMetaRow\(/.test(arm), 'round_meta arm ' + i + ' does not build its row with roundMetaRow');
		// EVERY arm feeds its own rounds (r578b F3): the worker's did not, so its `round` rows
		// took the feed's starting {0,0} and stated a prompt and a cache of nothing. Any arm
		// added later is held to the same.
		assert.ok(/\w*rounds\.meta\(ev\)/.test(arm), 'round_meta arm ' + i + ' does not feed its round rows (rounds.meta(ev))');
	});
});
