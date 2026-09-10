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

function makeEnv() {
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
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;

	// The capture: every POST body, parsed.
	const posts = [];
	const fetchImpl = (url, opts) => {
		try { posts.push({ url, body: JSON.parse((opts && opts.body) || '{}') }); }
		catch (e) { posts.push({ url, body: null }); }
		return Promise.resolve({ ok: true, status: 200 });
	};

	function CustomEventShim(type, init) { this.type = type; this.detail = init && init.detail; }
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	// setInterval is inert here, so the 30s/5min timers cannot fire real posts
	// mid-test; setTimeout is real, for the drainer's first-post path.
	const noInterval = () => 1;
	const noClear = () => {};

	function loadScript(rel) {
		const bodyText = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'localStorage', 'fetch', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'CustomEvent',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
			'with (window) {\n' + bodyText + '\n}');
		fn(win, document, localStorage, fetchImpl, btoa, atob,
			TextEncoder, TextDecoder, CustomEventShim,
			setTimeout, clearTimeout, noInterval, noClear, console);
	}
	loadScript('debugshare.js');
	return { win, document, localStorage, posts, topActions, store };
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

	console.log('');
	if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
	console.log('all debugshare checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
