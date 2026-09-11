/* ============================================================
   Test — the TEMPORARY debug-data-sharing feature (TRAINING WHEELS).
   ------------------------------------------------------------
   Drives the REAL www/js/debugshare.js in a simulated tab: a
   Map-backed localStorage, a minimal fake DOM (a `.top-actions`
   header host, createElement, head/getElementById), and a `fetch`
   that captures every POST to /api/debug-trace. No browser, no
   gateway -- the module's own gather/redact/chunk/post path is the
   code under test.

   The three properties the owner asked to prove:

     (a) OFF (the default): nothing is collected or posted, and no
         header indicator exists.
     (b) ON: the indicator appears carrying the plain warning in its
         title; a bundle is assembled that CONTAINS the ledger,
         transcripts and roster and does NOT contain the raw provider
         key or the master key -- only their fingerprints -- and the
         same holds for what actually goes on the wire.
     (c) OFF again: posting stops and the indicator disappears.

   Run:  node www/js/debugshare.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name); failures++; }
}

// ── The distinctive secrets the wire must never carry in the clear ──
// These are FAKE fixtures, invented for this test, never a real key. They wear a
// realistic provider-key SHAPE on purpose: the whole point is to prove the
// redactor turns exactly this shape into a fingerprint before anything ships.
const RAW_API_KEY    = 'sk-or-v1-ZZZTOPSECRETproviderKEY0123456789abcdef';	// allowlist secret
const RAW_API_KEY_ENC = 'ENCWRAPPED-ZZZ-abcdef0123456789-providerkey-sealed';	// allowlist secret
const RAW_MASTER_KEY = 'MASTERKEY-passphrase-derived-DO-NOT-SHIP-9999';	// allowlist secret

// ── A minimal fake DOM, only as much as debugshare.js touches ──
function makeNode(tag) {
	const node = {
		tagName: tag, className: '', id: '', title: '', innerHTML: '', textContent: '',
		_attrs: {}, _parent: null, children: [], style: {},
		get firstChild() { return this.children[0] || null; },
		setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') this.id = v; },
		getAttribute(k) { return this._attrs[k]; },
		addEventListener() {},
		appendChild(c) { c._parent = this; this.children.push(c); return c; },
		insertBefore(c, ref) {
			c._parent = this;
			const i = ref ? this.children.indexOf(ref) : -1;
			if (i >= 0) this.children.splice(i, 0, c); else this.children.unshift(c);
			return c;
		},
		remove() {
			if (this._parent) {
				const i = this._parent.children.indexOf(this);
				if (i >= 0) this._parent.children.splice(i, 1);
			}
		},
		querySelector() { return null; },
	};
	return node;
}

function makeEnv(cfg) {
	cfg = cfg || {};
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const head = makeNode('head');
	const body = makeNode('body');
	const topActions = makeNode('div');
	topActions.className = 'top-actions';
	body.appendChild(topActions);

	const document = {
		readyState: 'complete',
		head, body,
		addEventListener() {},
		createElement: (tag) => makeNode(tag),
		getElementById(id) {
			const scan = (n) => {
				for (const c of n.children) {
					if (c.id === id) return c;
					const deep = scan(c);
					if (deep) return deep;
				}
				return null;
			};
			return scan(head) || scan(body);
		},
		querySelector(sel) {
			if (sel === '.top-actions') return topActions;
			if (sel === '.topbar') return body;
			return null;
		},
		querySelectorAll: () => [],
	};

	const win = {};
	// Capture registered window listeners so a test can fire a synthetic `storage`
	// event (the same-device cross-tab path) and a `daimond:debugshare` can be observed.
	const listeners = {};
	win.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
	const events = [];
	win.dispatchEvent = (ev) => { events.push(ev); return true; };
	// A stand-in for the sync engine: `setEnabled` (a LOCAL flip) must nudge it so the
	// flag reaches the fleet; a count lets a test assert the nudge happened.
	let nudges = 0;
	win.DaimondSync = { nudge: () => { nudges += 1; } };
	const fireStorage = (key) => {
		(listeners.storage || []).forEach((fn) => fn({ key }));
	};

	// The capture: every POST body, parsed. When `cfg.gateFetch` is set, each POST
	// resolves only when the test releases it, so a snapshot can be held mid-drain and
	// a telemetry post injected behind it -- the priority-lane property under test.
	const posts = [];
	const resolvers = [];
	const fetchImpl = (url, opts) => {
		try { posts.push({ url, body: JSON.parse((opts && opts.body) || '{}') }); }
		catch (e) { posts.push({ url, body: null }); }
		if (cfg.gateFetch) {
			return new Promise((resolve) => { resolvers.push(() => resolve({ ok: true, status: 200 })); });
		}
		return Promise.resolve({ ok: true, status: 200 });
	};

	function CustomEventShim(type, init) { this.type = type; this.detail = init && init.detail; }
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	// setInterval is inert here, so the 30s/5min timers cannot fire real posts
	// mid-test; setTimeout is real, for the drainer's first-post path.
	const noInterval = () => 1;
	const noClear = () => {};
	// The drainer paces itself with `setTimeout(step, POST_GAP_MS)`. `cfg.fastTimers`
	// records every requested delay -- so a test can assert the 11 s rate cap is
	// honoured -- while firing the callback near-instantly, so a multi-post drain can
	// be observed without waiting real seconds.
	const timerDelays = [];
	const setTimeoutImpl = cfg.fastTimers
		? (fn, ms) => { timerDelays.push(ms); return setTimeout(fn, 1); }
		: setTimeout;

	function loadScript(rel) {
		const bodyText = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'localStorage', 'fetch', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'CustomEvent',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
			'with (window) {\n' + bodyText + '\n}');
		fn(win, document, localStorage, fetchImpl, btoa, atob,
			TextEncoder, TextDecoder, CustomEventShim,
			setTimeoutImpl, clearTimeout, noInterval, noClear, console);
	}
	loadScript('debugshare.js');
	// Release every gated POST currently in flight, let the microtasks and the (fast)
	// pacing timer run, and repeat until nothing new is queued -- so a gated drain runs
	// to completion in order without waiting the real 11 s between posts.
	async function drainAll() {
		for (let guard = 0; guard < 2000; guard++) {
			if (!resolvers.length) { await sleep(3); if (!resolvers.length) break; }
			resolvers.splice(0).forEach((r) => r());
			await sleep(3);
		}
	}
	return {
		win, document, localStorage, posts, topActions, store,
		fireStorage, events, timerDelays, drainAll,
		nudges: () => nudges,
	};
}

const indicatorOf = (topActions) =>
	topActions.children.find((c) => (c.className || '').indexOf('ds-indicator') !== -1) || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The decrypted state daimond.js's provider would hand the module.
function providerState() {
	return {
		config: {
			baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
			model: 'anthropic/claude-3.5',
			apiKey: RAW_API_KEY,			// the provider bearer key -- must be fingerprinted
			apiKeyEnc: RAW_API_KEY_ENC,		// the wrapped form -- must be fingerprinted too
			masterKey: RAW_MASTER_KEY,		// belt-and-braces: a key-named field anywhere
			maxOut: 4096,
		},
		transcripts: [
			{ id: 'chatA', name: 'Debugging the loop', model: 'anthropic/claude-3.5',
				messages: [{ role: 'user', content: 'why does sync loop?' },
					{ role: 'assistant', content: 'because the nominee looked stale' }] },
		],
		roster: { devAAA: { name: 'laptop', seen: 111 }, devBBB: { name: 'phone', seen: 222 } },
		presence: { devAAA: { name: 'laptop', lastSeen: 111 } },
		election: { self: 'devAAA', nominated: 'devBBB', trace: {} },
		tokenStats: [{ id: 'chatA', messages: 2, contextWindow: 200000 }],
	};
}

async function main() {
	console.log('debugshare: OFF by default — nothing collected or posted, no indicator');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		env.localStorage.setItem('daimond-ledger', JSON.stringify([{ id: 'x', cost: 1 }]));
		DS.registerProvider(async () => providerState());
		check('isOn() is false at first run', DS.isOn() === false);
		check('no header indicator when off', indicatorOf(env.topActions) === null);
		// A snapshot request while off must post nothing and queue nothing.
		await DS.snapshotNow();
		await sleep(30);
		check('snapshotNow() posts nothing while off', env.posts.length === 0);
		check('queue stays empty while off', DS._queueLen() === 0);
	}

	console.log('debugshare: redaction — ledger/transcripts/roster present, raw keys never');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		const sources = {
			ledger: [{ id: 'led1', cost: 42, model: 'm' }],
			trail: [{ t: 'boot', a: 0 }],
			diag: [],
		};
		const bundle = DS._assemble(sources, providerState());
		const json = JSON.stringify(bundle);
		// Content present.
		check('bundle carries the ledger', json.indexOf('led1') !== -1);
		check('bundle carries the transcripts', json.indexOf('why does sync loop?') !== -1
			&& json.indexOf('Debugging the loop') !== -1);
		check('bundle carries the roster', json.indexOf('devAAA') !== -1 && json.indexOf('devBBB') !== -1);
		check('bundle carries presence + election', json.indexOf('lastSeen') !== -1 && json.indexOf('nominated') !== -1);
		// Secrets fingerprinted, never raw.
		check('raw provider apiKey is NOT in the bundle', json.indexOf(RAW_API_KEY) === -1);
		check('raw wrapped apiKeyEnc is NOT in the bundle', json.indexOf(RAW_API_KEY_ENC) === -1);
		check('raw master key is NOT in the bundle', json.indexOf(RAW_MASTER_KEY) === -1);
		check('apiKey appears as a fingerprint', /"apiKey":"\[redacted [^"]+\]"/.test(json));
		check('apiKeyEnc appears as a fingerprint', /"apiKeyEnc":"\[redacted [^"]+\]"/.test(json));
		check('masterKey appears as a fingerprint', /"masterKey":"\[redacted [^"]+\]"/.test(json));
		// The fingerprint keeps the first six characters (an operator can match keys).
		check('fingerprint keeps the first six chars', json.indexOf('sk-or-') !== -1);
		// A non-secret model field is untouched.
		check('non-secret fields pass through', json.indexOf('anthropic/claude-3.5') !== -1);
	}

	console.log('debugshare: ON — indicator with the warning, and the WIRE carries no raw key');
	let onEnv;
	{
		const env = makeEnv();
		onEnv = env;
		const DS = env.win.DEBUG_SHARE;
		env.localStorage.setItem('daimond-ledger', JSON.stringify([{ id: 'led9', cost: 7 }]));
		DS.registerProvider(async () => providerState());

		DS.setEnabled(true);
		check('isOn() is true after turning on', DS.isOn() === true);
		const ind = indicatorOf(env.topActions);
		check('a header indicator appears when on', ind !== null);
		check('the indicator title carries the plain warning',
			ind && /Debug data sharing is ON/.test(ind.title)
			&& /shared with the developer/.test(ind.title)
			&& /Turn off in Settings/.test(ind.title));
		check('the indicator carries the same warning as its aria-label',
			ind && /Debug data sharing is ON/.test(ind.getAttribute('aria-label') || ''));

		// Let the async gather + drain fire the first post.
		await sleep(60);
		check('turning on posts a snapshot', env.posts.length >= 1);
		const wire = JSON.stringify(env.posts);
		check('the POST goes to /api/debug-trace', env.posts.every((p) => p.url === '/api/debug-trace'));
		check('the wire body has the {v,device,rows} shape',
			env.posts[0].body && env.posts[0].body.v === 1 && Array.isArray(env.posts[0].body.rows));
		// The wire is base64; decode every row's data and prove no raw secret survives.
		let decoded = '';
		for (const p of env.posts) {
			for (const row of (p.body && p.body.rows) || []) {
				try { decoded += Buffer.from(row.data || '', 'base64').toString('utf8'); } catch (e) {}
			}
		}
		check('the decoded wire carries the ledger', decoded.indexOf('led9') !== -1);
		check('the decoded wire carries the transcript', decoded.indexOf('why does sync loop?') !== -1);
		check('the decoded wire has NO raw provider key', decoded.indexOf(RAW_API_KEY) === -1
			&& wire.indexOf(RAW_API_KEY) === -1);
		check('the decoded wire has NO raw master key', decoded.indexOf(RAW_MASTER_KEY) === -1
			&& wire.indexOf(RAW_MASTER_KEY) === -1);
		check('the decoded wire has a fingerprint instead', /\[redacted sk-or-/.test(decoded));
		// The rows are tagged for reassembly.
		check('rows are tagged for reassembly', (env.posts[0].body.rows[0].tag || '').indexOf('ds snapshot ') === 0);
	}

	console.log('debugshare: OFF again — posting stops and the indicator disappears');
	{
		const DS = onEnv.win.DEBUG_SHARE;
		const before = onEnv.posts.length;
		DS.setEnabled(false);
		check('isOn() is false after turning off', DS.isOn() === false);
		check('the indicator is removed', indicatorOf(onEnv.topActions) === null);
		check('the queue is cleared on off', DS._queueLen() === 0);
		// A snapshot request while off adds nothing more to the wire.
		await DS.snapshotNow();
		await sleep(40);
		check('no further posts after off', onEnv.posts.length === before);
	}

	console.log('debugshare: telemetry — per-model aggregation numbers are exact');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		// A small fixture ledger with hand-checkable sums. Entry shape {t,m,p,c,ca,u,r}.
		env.localStorage.setItem('daimond-ledger', JSON.stringify([
			{ t: 1, m: 'modelX', p: 100, c: 50, ca: 20, u: 0.10, r: 1 },
			{ t: 2, m: 'modelX', p: 300, c: 80, ca: 60, u: 0.30 },			// not reported
			{ t: 3, m: 'modelY', p: 50,  c: 10, ca: 0,  u: 0.05, r: 1 },
		]));
		const rows = DS._aggregateLedger(DS._publicSources().ledger);
		const byModel = {};
		rows.forEach((r) => { byModel[r.model] = r; });
		const x = byModel['modelX'], y = byModel['modelY'];
		check('aggregation has one row per model', rows.length === 2 && !!x && !!y);
		check('modelX turns/prompt/completion/cached summed', x.turns === 2
			&& x.prompt === 400 && x.completion === 130 && x.cached === 80);
		check('modelX cachedPct is 100*cached/prompt', x.cachedPct === 20);		// 100*80/400
		check('modelX maxPromptTurn is the largest single turn', x.maxPromptTurn === 300);
		check('modelX reportedPct is 100*count(r)/turns', x.reportedPct === 50);	// 1 of 2
		check('modelX usd summed', Math.abs(x.usd - 0.40) < 1e-9);
		check('modelY cachedPct is 0 with no cache', y.cachedPct === 0);
		check('modelY maxPromptTurn with one turn', y.maxPromptTurn === 50);
		check('modelY reportedPct is 100 when the only turn reported', y.reportedPct === 100);
	}

	console.log('debugshare: telemetry — stats ride every tick when a stats seam is registered');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		env.localStorage.setItem('daimond-ledger', JSON.stringify([
			{ t: 1, m: 'modelX', p: 100, c: 50, ca: 20, u: 0.10, r: 1 },
		]));
		DS.registerStats(() => ({
			contextActual: 123, contextWindow: 200000, foldAt: 0,
			activeModel: 'modelX', provider: 'openrouter',
			workerState: { active: 0, queued: 0, busy: false }, activity: 'idle',
		}));
		const first = DS._gatherTelemetry();
		check('telemetry is sent with a stats block', !!first && !!first.stats);
		check('stats carries the per-model aggregation', Array.isArray(first.stats.models)
			&& first.stats.models.length === 1 && first.stats.models[0].model === 'modelX');
		check('stats carries the live numbers from the seam',
			first.stats.live && first.stats.live.contextActual === 123
			&& first.stats.live.contextWindow === 200000
			&& first.stats.live.activeModel === 'modelX');
		// A SECOND tick with no new ledger/trail/diag rows still sends, because stats
		// is present -- the whole point of the change.
		const second = DS._gatherTelemetry();
		check('a quiet tick still sends when stats is present', !!second && !!second.stats);
		check('the quiet tick carries no new ledger rows', Array.isArray(second.ledger)
			&& second.ledger.length === 0);
		check('the quiet tick still carries the aggregation', Array.isArray(second.stats.models)
			&& second.stats.models.length === 1);
	}

	console.log('debugshare: telemetry — a live seam that throws is null-safe');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerStats(() => { throw new Error('boom'); });
		const tel = DS._gatherTelemetry();
		check('a throwing stats seam yields live:null, not a crash',
			!!tel && !!tel.stats && tel.stats.live === null);
	}

	console.log('debugshare: elision — a giant string is byte-capped, a readable one is kept');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		const giant = 'x'.repeat(5000);					// a giant tool payload, > 2 KB
		const readable = 'hello '.repeat(200);			// 1200 bytes, an ordinary message
		const tree = { a: { b: [ { out: giant, msg: readable, keep: 'short' } ] }, n: 42 };
		const res = DS._elide(tree);
		const capped = res.a.b[0].out;
		check('the giant string is capped at the 2048-byte cap plus a tail',
			capped.length < giant.length && capped.indexOf('x'.repeat(2048)) === 0);
		check('the elision tail names the bytes dropped', capped.indexOf('…[+2952 bytes]') !== -1);	// 5000 − 2048
		check('a readable under-cap message is left WHOLE', res.a.b[0].msg === readable);
		check('a short string is left untouched', res.a.b[0].keep === 'short');
		check('structure and non-strings are preserved', res.n === 42
			&& Array.isArray(res.a.b) && res.a.b.length === 1);
	}

	console.log('debugshare: assemble — giant transcript payloads elided, structured state COMPLETE');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		const bigInstr = 'I'.repeat(3000);				// a long but structured config field
		const bigRead  = 'SRC'.repeat(4000);			// a 12 KB verbatim read in a transcript
		const readable = 'why does sync loop? '.repeat(50);	// 1000 bytes, under cap
		const signals = { v: 1, diamonds: { dA: { turns: 5, usd: 0.5, missed: 1 } },
			models: { 'anthropic/claude-3.5': { turns: 7, usd: 0.7 } }, tools: {}, days: {}, intents: {}, len: { sum: 0, n: 0 } };
		const state = {
			config: { instructions: bigInstr, apiKey: RAW_API_KEY },
			transcripts: [ { id: 'c', name: 'Long chat', messages: [
				{ role: 'user', content: readable },
				{ role: 'assistant', content: bigRead } ] } ],
			roster: { dev1: { name: 'phone', seen: 9 } },
		};
		const bundle = DS._assemble({ ledger: [], trail: [], diag: [], signals: signals }, state);
		const json = JSON.stringify(bundle);
		check('config (structured) stays COMPLETE — a long instructions field is not elided',
			json.indexOf(bigInstr) !== -1);
		check('a giant transcript payload IS elided', json.indexOf(bigRead) === -1
			&& json.indexOf('…[+') !== -1);
		check('a readable transcript message under the cap is kept whole',
			json.indexOf(readable) !== -1);
		check('the signal index travels complete in the snapshot',
			json.indexOf('"signals"') !== -1 && json.indexOf('dA') !== -1);
		check('the roster travels complete', json.indexOf('phone') !== -1);
		check('the config apiKey is still fingerprinted, never raw', json.indexOf(RAW_API_KEY) === -1
			&& /"apiKey":"\[redacted /.test(json));
	}

	console.log('debugshare: telemetry — per-Diamond and per-model signal breakdowns');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		env.localStorage.setItem('daimond-signals', JSON.stringify({ v: 1,
			diamonds: { dA: { turns: 5, usd: 0.50, missed: 1 }, dB: { turns: 2, usd: 0.20 } },
			models: { modelX: { turns: 7, usd: 0.70 } }, tools: {}, days: {}, intents: {}, len: { sum: 0, n: 0 } }));
		const b = DS._signalBreakdown(DS._publicSources().signals);
		const dA = b.diamonds.find((x) => x.diamondId === 'dA');
		const dB = b.diamonds.find((x) => x.diamondId === 'dB');
		check('per-Diamond breakdown has a row per Diamond', b.diamonds.length === 2 && !!dA && !!dB);
		check('per-Diamond turns/usd/missed are read straight from the index',
			dA.turns === 5 && Math.abs(dA.usd - 0.5) < 1e-9 && dA.missed === 1
			&& dB.turns === 2 && Math.abs(dB.usd - 0.2) < 1e-9);
		check('per-model (signals) usd/turns are read from the index',
			b.models.length === 1 && b.models[0].model === 'modelX'
			&& Math.abs(b.models[0].usd - 0.7) < 1e-9 && b.models[0].turns === 7);
		// The whole thing rides telemetry.
		const tel = DS._gatherTelemetry();
		check('telemetry carries the per-Diamond breakdown', Array.isArray(tel.stats.diamonds)
			&& tel.stats.diamonds.length === 2);
		check('telemetry carries the per-model signal breakdown', Array.isArray(tel.stats.signalModels)
			&& tel.stats.signalModels.length === 1);
	}

	console.log('debugshare: telemetry — diamond×model cross accumulates while sharing is on');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => providerState());
		// A cross note is a no-op while OFF, so nothing is recorded until on.
		DS.noteCross('dA', 'modelX', 0.10);
		check('noteCross is a no-op while sharing is off', DS._crossBreakdown().length === 0);
		DS.setEnabled(true);
		DS.noteCross('dA', 'modelX', 0.10);
		DS.noteCross('dA', 'modelX', 0.10);		// dA×modelX: 2 turns, 0.20
		DS.noteCross('dA', 'modelY', 0.20);		// dA×modelY: 1 turn,  0.20
		DS.noteCross('dB', 'modelX', 0.05);		// dB×modelX: 1 turn,  0.05
		const cross = DS._crossBreakdown();
		const axX = cross.find((c) => c.diamondId === 'dA' && c.model === 'modelX');
		const axY = cross.find((c) => c.diamondId === 'dA' && c.model === 'modelY');
		const bxX = cross.find((c) => c.diamondId === 'dB' && c.model === 'modelX');
		check('the cross has a row per (Diamond, model) pair', cross.length === 3);
		check('dA×modelX summed 2 turns and 0.20', axX && axX.turns === 2 && Math.abs(axX.usd - 0.20) < 1e-9);
		check('dA×modelY recorded 1 turn and 0.20', axY && axY.turns === 1 && Math.abs(axY.usd - 0.20) < 1e-9);
		check('dB×modelX recorded 1 turn and 0.05', bxX && bxX.turns === 1 && Math.abs(bxX.usd - 0.05) < 1e-9);
		check('the cross is sorted dearest first', cross[cross.length - 1].usd <= cross[0].usd);
		// And it rides telemetry.
		const tel = DS._gatherTelemetry();
		check('telemetry carries the diamond×model cross', Array.isArray(tel.stats.cross)
			&& tel.stats.cross.length === 3);
	}

	console.log('debugshare: elision — an assembled snapshot caps a huge transcript read');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		const bigRead = 'SOURCE'.repeat(5000);		// a verbatim file read, ~30 KB
		const state = {
			config: null,
			transcripts: [ { id: 'chatA', name: 'x', messages: [
				{ role: 'user', content: bigRead } ] } ],
		};
		const bundle = DS._assemble({ ledger: [], trail: [], diag: [] }, state);
		const json = JSON.stringify(bundle);
		check('the assembled snapshot no longer holds the whole read',
			json.indexOf('SOURCE'.repeat(5000)) === -1);
		check('the assembled snapshot keeps the capped head and a tail',
			json.indexOf('…[+') !== -1);
		check('the capped snapshot is far smaller than the raw read',
			json.length < bigRead.length);
	}

	console.log('debugshare: cross-device — a synced ON value mounts the eye and starts collection');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		env.localStorage.setItem('daimond-ledger', JSON.stringify([{ id: 'ledS', cost: 1 }]));
		DS.registerProvider(async () => providerState());
		check('a fresh device is OFF and says NOTHING on the parcel', DS.isOn() === false
			&& DS.syncSnapshot() === null);
		// A parcel arrives from another device that turned sharing ON.
		DS.adoptSync({ on: true, at: Date.now() });
		check('a synced ON turns the flag on', DS.isOn() === true);
		check('a synced ON mounts the header indicator', indicatorOf(env.topActions) !== null);
		await sleep(40);
		check('a synced ON starts collection (a snapshot is posted)', env.posts.length >= 1);
		// It now rides this device's OWN parcel, so it propagates onward.
		const snap = DS.syncSnapshot();
		check('after adopting, this device carries { on:true, at } on its parcel',
			snap && snap.on === true && typeof snap.at === 'number' && snap.at > 0);
	}

	console.log('debugshare: cross-device — a synced OFF stops the fleet (eye gone, collection stopped)');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => providerState());
		DS.setEnabled(true);					// this device had it on
		await sleep(40);
		check('the device is ON before the OFF arrives', DS.isOn() === true);
		const onAt = Number(env.store.get('daimond-debugshare-at'));
		// A FRESHER parcel from another device turns it off.
		DS.adoptSync({ on: false, at: onAt + 1000 });
		check('a synced OFF turns the flag off', DS.isOn() === false);
		check('a synced OFF unmounts the indicator', indicatorOf(env.topActions) === null);
		check('a synced OFF clears the post queue (collection stopped)', DS._queueLen() === 0);
		check('the OFF now rides this device’s own parcel', DS.syncSnapshot().on === false);
	}

	console.log('debugshare: cross-device — freshest-at-wins; a stale or equal parcel is ignored');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => providerState());
		DS.setEnabled(true);					// local decision at time T
		const T = Number(env.store.get('daimond-debugshare-at'));
		// An OLDER parcel must NOT override the local decision.
		DS.adoptSync({ on: false, at: T - 5000 });
		check('a STALE OFF does not override a newer local ON', DS.isOn() === true);
		// An EQUAL stamp must not flip either (strictly-fresher wins).
		DS.adoptSync({ on: false, at: T });
		check('an EQUAL-stamp OFF does not flip the flag', DS.isOn() === true);
		// A malformed parcel is a no-op, never a throw.
		DS.adoptSync(null); DS.adoptSync({}); DS.adoptSync({ on: false });		// missing at
		check('a malformed or at-less parcel is a no-op', DS.isOn() === true);
		// A genuinely FRESHER value does win.
		DS.adoptSync({ on: false, at: T + 1 });
		check('a strictly-fresher OFF wins', DS.isOn() === false);
	}

	console.log('debugshare: cross-device — a local flip stamps and nudges the sync engine');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => providerState());
		const before = env.nudges();
		DS.setEnabled(true);
		check('a local ON stamps the decision', Number(env.store.get('daimond-debugshare-at')) > 0);
		check('a local ON nudges the sync engine so it reaches the fleet', env.nudges() === before + 1);
		DS.setEnabled(false);
		check('a local OFF nudges the sync engine too', env.nudges() === before + 2);
		// adopting a synced value must NOT restamp (no ping-pong) — the stamp is written
		// verbatim, so it equals what arrived.
		const remoteAt = Date.now() + 10000;
		DS.adoptSync({ on: true, at: remoteAt });
		check('adopting a synced value writes the remote stamp VERBATIM (no restamp)',
			Number(env.store.get('daimond-debugshare-at')) === remoteAt);
		const n = env.nudges();
		DS.adoptSync({ on: true, at: remoteAt });		// same/again
		check('adopting does not itself nudge (no push storm)', env.nudges() === n);
	}

	console.log('debugshare: cross-device — the parcel field carries ONLY the flag, never a key');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => providerState());
		DS.setEnabled(true);
		const snap = DS.syncSnapshot();
		const keys = Object.keys(snap).sort();
		check('the parcel field is exactly { at, on }', JSON.stringify(keys) === JSON.stringify(['at', 'on']));
		const json = JSON.stringify(snap);
		check('the parcel field carries NO raw provider key', json.indexOf(RAW_API_KEY) === -1
			&& json.indexOf(RAW_API_KEY_ENC) === -1);
		check('the parcel field carries NO raw master key', json.indexOf(RAW_MASTER_KEY) === -1);
		check('the parcel field has no key/secret-named property',
			!/apikey|token|secret|passphrase|master|salt|wrapped|seal|priv|mnemonic|seed/i.test(json));
	}

	console.log('debugshare: cross-tab — the storage event mirrors the flip WITHOUT restamping or nudging');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => providerState());
		// Another tab on THIS device flipped the flag: it wrote the key + stamp and
		// nudged. This tab only sees the storage event and must mirror the effect.
		const nBefore = env.nudges();
		env.store.set('daimond-debugshare', '1');
		env.store.set('daimond-debugshare-at', String(Date.now()));
		env.fireStorage('daimond-debugshare');
		check('a cross-tab ON mounts the indicator here', indicatorOf(env.topActions) !== null);
		check('a cross-tab flip does NOT re-nudge the sync engine', env.nudges() === nBefore);
		// And OFF the same way.
		env.store.set('daimond-debugshare', '0');
		env.fireStorage('daimond-debugshare');
		check('a cross-tab OFF unmounts the indicator here', indicatorOf(env.topActions) === null);
		check('a cross-tab OFF is off', DS.isOn() === false);
	}

	console.log('debugshare: windowing — recent turns kept, older dropped-count recorded, structured state COMPLETE');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		// A chat with far more than the per-chat cap of turns; each turn distinct.
		const msgs = [];
		for (let i = 0; i < 120; i++) {
			msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn-' + i });
		}
		const windowed = DS._windowTranscripts([{ id: 'c', name: 'long', updatedAt: 100, messages: msgs }]);
		const w = windowed[0];
		check('a chat is capped to the last MAX_MSGS_PER_CHAT (40) turns', w.messages.length === 40);
		check('the turns KEPT are the most recent (tail)', w.messages[0].content === 'turn-80'
			&& w.messages[39].content === 'turn-119');
		check('the oldest turn is gone', JSON.stringify(w.messages).indexOf('turn-0"') === -1);
		check('droppedOlderTurns records exactly how many were cut', w.droppedOlderTurns === 80);
		check('non-message fields are preserved', w.id === 'c' && w.name === 'long' && w.updatedAt === 100);
		check('the input array is not mutated', msgs.length === 120);
		// A short chat is left whole with no drop marker.
		const shortW = DS._windowTranscripts([{ id: 's', messages: [{ role: 'user', content: 'hi' }] }])[0];
		check('a short chat keeps all its turns', shortW.messages.length === 1);
		check('a short chat carries NO droppedOlderTurns marker', !('droppedOlderTurns' in shortW));
		// A null/absent transcripts value passes through untouched.
		check('a null transcripts value passes through', DS._windowTranscripts(null) === null);
	}

	console.log('debugshare: windowing — a total byte budget spends freshest-first across chats');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		// Two chats, each with one enormous message so the ~700 KiB budget cannot hold
		// both. The FRESHER chat (higher updatedAt) must be the one kept.
		const big = 'Z'.repeat(600 * 1024);				// ~600 KiB each
		const chats = [
			{ id: 'old',   updatedAt: 10, messages: [{ role: 'user', content: big }] },
			{ id: 'fresh', updatedAt: 99, messages: [{ role: 'user', content: big }] },
		];
		const w = DS._windowTranscripts(chats);
		const byId = {}; w.forEach((c) => { byId[c.id] = c; });
		check('the freshest chat keeps its turn', byId['fresh'].messages.length === 1);
		check('the older chat is dropped once the budget is spent', byId['old'].messages.length === 0
			&& byId['old'].droppedOlderTurns === 1);
		check('windowing preserves the input order of the array',
			w[0].id === 'old' && w[1].id === 'fresh');
	}

	console.log('debugshare: windowing — the SNAPSHOT windows transcripts but leaves telemetry/structured state whole');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		const msgs = [];
		for (let i = 0; i < 100; i++) msgs.push({ role: 'user', content: 'msg-' + i });
		const signals = { v: 1, diamonds: { dA: { turns: 5, usd: 0.5 } },
			models: { modelX: { turns: 7, usd: 0.7 } }, tools: {}, days: {}, intents: {}, len: { sum: 0, n: 0 } };
		const state = {
			config:      { model: 'anthropic/claude-3.5', maxOut: 4096 },
			transcripts: [{ id: 'c', updatedAt: 5, messages: msgs }],
			roster:      { dev1: { name: 'phone' } },
			presence:    { dev1: { lastSeen: 9 } },
			election:    { self: 'dev1', nominated: 'dev2' },
			tokenStats:  [{ id: 'c', messages: 100, contextWindow: 200000 }],		// TRUE full count
		};
		const bundle = DS._assemble({ ledger: [{ id: 'L' }], trail: [], diag: [], signals }, state);
		check('the snapshot windows the transcript to 40 turns', bundle.transcripts[0].messages.length === 40);
		check('the snapshot records droppedOlderTurns on the windowed chat',
			bundle.transcripts[0].droppedOlderTurns === 60);
		check('kept transcript turns are the most recent', bundle.transcripts[0].messages[39].content === 'msg-99');
		// Structured state is COMPLETE and unwindowed.
		check('config travels complete', bundle.config && bundle.config.maxOut === 4096);
		check('roster travels complete', !!bundle.roster.dev1);
		check('presence + election travel complete', !!bundle.presence.dev1 && bundle.election.nominated === 'dev2');
		check('the signal index travels complete', !!bundle.signals && !!bundle.signals.diamonds.dA);
		check('tokenStats keeps the TRUE full message count (never windowed)',
			bundle.tokenStats[0].messages === 100);
	}

	console.log('debugshare: windowing — telemetry stats are NOT windowed (live numbers stay complete)');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		// A ledger far larger than any transcript window; the per-model aggregation must
		// still sum EVERY turn -- telemetry is never windowed.
		const ledger = [];
		for (let i = 0; i < 300; i++) ledger.push({ t: i, m: 'modelX', p: 10, c: 5, u: 0.01 });
		env.localStorage.setItem('daimond-ledger', JSON.stringify(ledger));
		DS.registerStats(() => ({ contextActual: 42, contextWindow: 200000 }));
		const tel = DS._gatherTelemetry();
		check('telemetry aggregates ALL 300 ledger turns (unwindowed)',
			tel.stats.models[0].model === 'modelX' && tel.stats.models[0].turns === 300);
		check('the live numbers ride telemetry whole', tel.stats.live && tel.stats.live.contextActual === 42);
	}

	console.log('debugshare: priority — telemetry jumps ahead of a snapshot backlog, rate cap kept');
	{
		const env = makeEnv({ gateFetch: true, fastTimers: true });
		const DS = env.win.DEBUG_SHARE;
		env.localStorage.setItem('daimond-ledger', JSON.stringify([{ t: 1, m: 'modelX', p: 10, c: 5, u: 0.01 }]));
		// A big STRUCTURED config (config is never elided) makes the snapshot span several
		// posts, so a genuine backlog sits behind the first in-flight post.
		DS.registerProvider(async () => ({
			config:      { instructions: 'I'.repeat(300000), model: 'anthropic/claude-3.5' },
			transcripts: [{ id: 'c', name: 'x', updatedAt: 1, messages: [{ role: 'user', content: 'hi' }] }],
			roster: {}, presence: {}, election: {}, tokenStats: [],
		}));
		DS.setEnabled(true);
		await sleep(20);	// the snapshot is gathered; post #1 is in flight (gated), the rest queued
		const backlog = DS._snapQueueLen();
		check('a multi-post snapshot leaves a backlog behind the first post', backlog >= 2);
		check('nothing is on the telemetry lane yet', DS._telQueueLen() === 0);
		// A telemetry tick arrives mid-snapshot.
		DS._telemetryTick();
		check('the telemetry post is queued on the priority lane', DS._telQueueLen() === 1);
		check('the telemetry enqueue leaves the snapshot backlog untouched', DS._snapQueueLen() === backlog);
		// Drain everything, in order, without waiting the real 11 s between posts.
		await env.drainAll();
		const kinds = env.posts.map((p) => {
			const tag = (p.body && p.body.rows && p.body.rows[0] && p.body.rows[0].tag) || '';
			return tag.indexOf('ds telemetry') === 0 ? 'telemetry' : 'snapshot';
		});
		const telCount = kinds.filter((k) => k === 'telemetry').length;
		check('exactly one telemetry post reached the wire', telCount === 1);
		check('the first post was the snapshot already in flight', kinds[0] === 'snapshot');
		check('telemetry drained BEFORE the remaining snapshot backlog', kinds[1] === 'telemetry');
		check('every remaining snapshot post followed the telemetry',
			kinds.slice(2).every((k) => k === 'snapshot') && kinds.length === backlog + 2);
		// The rate cap: the drainer never asked to post faster than the 11 s gap.
		const paceDelays = env.timerDelays.filter((d) => d > 0);
		check('the drainer paced every post at the 11 s rate cap',
			paceDelays.length >= 1 && paceDelays.every((d) => d === 11000));
	}

	console.log('debugshare: priority — turning off clears BOTH lanes');
	{
		const env = makeEnv({ gateFetch: true });
		const DS = env.win.DEBUG_SHARE;
		DS.registerProvider(async () => ({ config: { instructions: 'I'.repeat(300000) },
			transcripts: [], roster: {}, presence: {}, election: {}, tokenStats: [] }));
		DS.setEnabled(true);
		await sleep(20);
		DS._telemetryTick();
		check('both lanes hold posts before off', DS._snapQueueLen() >= 1 && DS._telQueueLen() === 1);
		DS.setEnabled(false);
		check('turning off empties the snapshot lane', DS._snapQueueLen() === 0);
		check('turning off empties the telemetry lane', DS._telQueueLen() === 0);
		check('_queueLen reflects both lanes cleared', DS._queueLen() === 0);
	}

	console.log('debugshare: snapshot — the raw ledger is trimmed to a recent tail, not shipped whole');
	{
		const env = makeEnv();
		const DS = env.win.DEBUG_SHARE;
		const ledger = [];
		for (let i = 0; i < 400; i++) ledger.push({ t: i, m: 'modelX', p: 10, c: 5, u: 0.01, id: 'led-' + i });
		const bundle = DS._assemble({ ledger, trail: [], diag: [], signals: null }, providerState());
		check('the snapshot keeps only the ledger TAIL (20 entries), not all 400',
			Array.isArray(bundle.ledger) && bundle.ledger.length === 20);
		check('the tail is the MOST RECENT entries', bundle.ledger[19].id === 'led-399'
			&& bundle.ledger[0].id === 'led-380');
		check('the snapshot records how many older ledger entries were dropped',
			bundle.ledgerDropped === 380);
		const json = JSON.stringify(bundle);
		check('an old ledger entry is NOT in the snapshot',
			json.indexOf('"led-0"') === -1 && json.indexOf('"led-100"') === -1);
		check('a recent ledger entry IS in the tail', json.indexOf('"led-399"') !== -1);
		// The aggregates that replace the raw ledger still sum EVERY turn via telemetry.
		const agg = DS._aggregateLedger(ledger);
		check('the per-model aggregate still summarises all 400 turns',
			agg.length === 1 && agg[0].model === 'modelX' && agg[0].turns === 400);
		// The trim is a real size cut: the snapshot is far smaller than the raw ledger alone.
		check('the trimmed snapshot is smaller than the raw ledger it used to embed',
			json.length < JSON.stringify(ledger).length);
		// A short ledger is kept whole with nothing dropped.
		const small = DS._assemble({ ledger: [{ id: 'only', u: 1 }], trail: [], diag: [] }, {});
		check('a ledger under the tail cap is kept whole',
			small.ledger.length === 1 && small.ledgerDropped === 0);
	}

	console.log('');
	if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
	console.log('all debugshare checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
