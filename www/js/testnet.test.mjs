/* ============================================================
   Test — the page half of the testnet (design §R11.3, §R7; tn-U2a).
   ------------------------------------------------------------
   Drives the REAL policy.js, trash.js, testnet.js, support.js and
   debugshare.js's scrubber in a fake tab, with `/api/policy` stubbed
   to the contract the gateway half serves:
     {ok, chat_expire_days, trash_retain_days, network, capabilities:{runner}}.

     (a) parse: an absent, "live" or garbage `network` is live; only "test" is test.
     (b) one `/api/policy` fetch per boot, shared: trash.js takes its figures from it.
     (c) live: no identity swap, no TEST chip, and `report()` keeps the consent
         sheet with no free-text box (support.js's no-free-text rule).
     (d) test: title, apple title, apple-touch-icon and manifest swapped; a TEST
         chip in `.brand-group` opens the Testnet sheet with the sandbox card
         and Report a Problem, which opens the report box.
     (e) the box posts a `testnet.report` header and the text in rows of at most
         380 bytes, through debugshare's `scrubText`: a provider key and a
         passphrase do not travel. With the scrubber absent no text travels.
     (f) the runner row (daimond.js `runnerMintRow`) shows a short label, not
         the pair button, when `can('runner')` is false.

   Run:  node www/js/testnet.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// ── A fake DOM: enough selectors for the head tags and the sheets ──
function makeNode(tag) {
	const node = {
		tagName: String(tag).toUpperCase(), className: '', id: '', textContent: '', title: '',
		type: '', disabled: false, hidden: false, value: '', maxLength: -1, placeholder: '',
		attrs: {}, _listeners: {}, _parent: null, children: [], style: {},
		setAttribute(k, v) { node.attrs[k] = String(v); if (k === 'class') node.className = String(v); if (k === 'id') node.id = String(v); },
		getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
		addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
		appendChild(c) { c._parent = node; node.children.push(c); return c; },
		insertBefore(c, ref) {
			c._parent = node;
			const i = ref ? node.children.indexOf(ref) : -1;
			if (i < 0) node.children.push(c); else node.children.splice(i, 0, c);
			return c;
		},
		removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c; },
		remove() { if (node._parent) node._parent.removeChild(node); },
		get parentNode() { return node._parent; },
		get firstChild() { return node.children[0] || null; },
		get nextSibling() { const p = node._parent; if (!p) return null; return p.children[p.children.indexOf(node) + 1] || null; },
		classList: {
			add(...c) { const s = new Set(node.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); node.className = [...s].join(' '); },
			remove(...c) { node.className = node.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
			contains(c) { return node.className.split(/\s+/).includes(c); },
		},
		querySelector(sel) { return all(node, sel)[0] || null; },
		querySelectorAll(sel) { return all(node, sel); },
		focus() {}, select() {},
	};
	return node;
}
function matches(n, sel) {
	const m = /^([a-z0-9]*)(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/i.exec(sel);
	if (!m) throw new Error('fake DOM: selector ' + sel);
	if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
	if (m[2] && n.id !== m[2]) return false;
	for (const c of (m[3] || '').split('.').filter(Boolean)) if (!n.className.split(/\s+/).includes(c)) return false;
	if (m[4] && n.getAttribute(m[4]) !== m[5]) return false;
	return true;
}
function all(root, sel) {
	const out = [];
	(function walk(n) { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } })(root);
	return out;
}
function fire(node, type) { (node._listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} })); }
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── One tab ─────────────────────────────────────────────────────
function makeTab(cfg) {
	cfg = cfg || {};
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const head = makeNode('head'), body = makeNode('body'), root = makeNode('html');
	root.appendChild(head); root.appendChild(body);
	const tag = (t, attrs) => { const n = makeNode(t); for (const k in attrs) n.setAttribute(k, attrs[k]); head.appendChild(n); return n; };
	tag('link', { rel: 'manifest', href: 'app.webmanifest' });
	tag('link', { rel: 'apple-touch-icon', href: 'assets/icons/icon-180.png' });
	tag('meta', { name: 'apple-mobile-web-app-title', content: 'Daimond' });
	const bg = makeNode('div'); bg.className = 'brand-group';
	const brand = makeNode('a'); brand.className = 'brand';
	bg.appendChild(brand); body.appendChild(bg);
	// The phone home page's head (index.html), which covers the top bar on a phone.
	const hh = makeNode('div'); hh.className = 'home-head'; hh.id = 'home-head';
	const lock = makeNode('img'); lock.className = 'home-lockup';
	const srch = makeNode('button'); srch.className = 'home-act';
	hh.appendChild(lock); hh.appendChild(srch); body.appendChild(hh);
	const document = {
		title: 'Daimond', head, body, documentElement: root, readyState: 'complete',
		createElement: (t) => makeNode(t),
		querySelector: (s) => root.querySelector(s),
		querySelectorAll: (s) => root.querySelectorAll(s),
		getElementById: (id) => all(root, '#' + id)[0] || null,
		addEventListener() {},
	};
	const listeners = {};
	const win = {
		addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
		dispatchEvent(e) { (listeners[e.type] || []).forEach((fn) => fn(e)); return true; },
		navigator: {},
		// gateway.js, stubbed: every /api request carries its clientApi() (API-FLOOR).
		DaimondGateway: { clientApi: () => 3, failWhy: (st) => 'status ' + st },
		// daimond.js's `idCopyBtn`, stubbed: what the sheet asks it to copy is what is checked.
		DaimondCopyBtn: (what, get) => {
			const b = makeNode('button'); b.className = 'copy-id';
			b.addEventListener('click', () => { win._copied = typeof get === 'function' ? get() : get; });
			return b;
		},
	};
	const policyGets = [], policyApis = [], posts = [];
	const reply = cfg.reply === undefined
		? { ok: true, chat_expire_days: 9, trash_retain_days: 3 }
		: cfg.reply;
	const fetchImpl = (url, opts) => {
		if (String(url).indexOf('/api/policy') === 0) {
			policyGets.push(url);
			policyApis.push(opts && opts.headers && opts.headers['x-daimond-api']);
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reply) });
		}
		let b = null;
		try { b = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
		posts.push({ url, body: b });
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
	};
	class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
	win.CustomEvent = CustomEvent;
	function load(rel) {
		const src = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'console',
			'CustomEvent', 'navigator', 'with (window) {\n' + src + '\n}')(
			win, document, localStorage, fetchImpl, setTimeout, clearTimeout, console, CustomEvent, win.navigator);
	}
	if (cfg.cached) store.set('daimond-net', JSON.stringify(cfg.cached));
	for (const f of cfg.scripts || []) load(f);
	return { win, document, body, head, store, policyGets, policyApis, posts, load };
}

const LIVE = { ok: true, chat_expire_days: 9, trash_retain_days: 3, network: 'live', capabilities: { runner: true } };
const TEST = { ok: true, chat_expire_days: 9, trash_retain_days: 3, network: 'test', capabilities: { runner: false } };
const PAGE = ['policy.js', 'store.js', 'stamp.js', 'layers.js', 'support.js', 'scrub.js', 'debugshare.js', 'trash.js', 'testnet.js'];

function tryRun(name, fn) {
	return Promise.resolve().then(fn).catch((e) => check(name, false, 'threw: ' + (e && e.message)));
}

// (a) parse
await tryRun('(a) parse', async () => {
	for (const [reply, want] of [[{ ok: true }, 'live'], [{ ok: true, network: 'live' }, 'live'],
		[{ ok: true, network: 'TEST' }, 'live'], [{ ok: true, network: 42 }, 'live'], [{ ok: true, network: 'test' }, 'test']]) {
		const tab = makeTab({ reply, scripts: ['policy.js'] });
		await tick();
		check('(a) network ' + JSON.stringify(reply.network) + ' reads as ' + want,
			tab.win.DaimondNet && tab.win.DaimondNet.network() === want);
	}
	const tab = makeTab({ reply: { ok: true }, scripts: ['policy.js'] });
	await tick();
	check('(a) a capability the gateway did not name is allowed', tab.win.DaimondNet.can('runner') === true);
});

// (b) one fetch per boot, shared with trash.js
await tryRun('(b) shared', async () => {
	const tab = makeTab({ reply: LIVE, scripts: ['policy.js', 'store.js', 'trash.js'] });
	await tick();
	check('(b) one /api/policy fetch per boot, not one per module', tab.policyGets.length === 1, 'fetches=' + tab.policyGets.length);
	check('(b) the policy fetch carries the client API version', tab.policyApis[0] === '3', 'x-daimond-api=' + tab.policyApis[0]);
	const d = tab.win.DaimondPolicy && tab.win.DaimondPolicy.days();
	check('(b) trash.js adopted the figures from DaimondNet', d && d.expire === 9 && d.retain === 3, JSON.stringify(d));
});

// (c) live
await tryRun('(c) live', async () => {
	const tab = makeTab({ reply: LIVE, scripts: PAGE });
	await tick();
	check('(c) live: title untouched', tab.document.title === 'Daimond');
	check('(c) live: manifest untouched', tab.document.querySelector('link[rel="manifest"]').getAttribute('href') === 'app.webmanifest');
	check('(c) live: apple-touch-icon untouched',
		tab.document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href') === 'assets/icons/icon-180.png');
	check('(c) live: no TEST chip', !tab.document.querySelector('.net-chip'));
	tab.win.DaimondSupport.report('settings');
	const sheet = tab.document.getElementById('support-sheet');
	check('(c) live: report() still opens the consent sheet', !!sheet);
	check('(c) live: the sheet has no free-text box', sheet && sheet.querySelectorAll('textarea').length === 0);
});

// (d) test
let testTab = null;
await tryRun('(d) test', async () => {
	const tab = testTab = makeTab({ reply: TEST, scripts: PAGE });
	await tick();
	check('(d) test: title is "Daimond TEST"', tab.document.title === 'Daimond TEST', tab.document.title);
	check('(d) test: apple title swapped',
		tab.document.querySelector('meta[name="apple-mobile-web-app-title"]').getAttribute('content') === 'Daimond TEST');
	check('(d) test: apple-touch-icon swapped',
		tab.document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href') === 'assets/icons/test-180.png');
	check('(d) test: manifest swapped',
		tab.document.querySelector('link[rel="manifest"]').getAttribute('href') === 'app-test.webmanifest');
	const chip = tab.document.querySelector('.net-chip');
	check('(d) test: a TEST chip sits in .brand-group', chip && chip.parentNode.className === 'brand-group' && chip.textContent === 'TEST');
	const hc = tab.document.querySelectorAll('.net-chip').find((c) => c.parentNode.id === 'home-head');
	check('(d) test: a second TEST chip sits in #home-head, after the lockup (home hides the bar)',
		hc && hc.parentNode.children.indexOf(hc) === 1 && hc.textContent === 'TEST');
	check('(d) test: one chip per host, however often policy arrives',
		(await tab.win.DaimondNet.refresh(), tab.document.querySelectorAll('.net-chip').length === 2));
	fire(chip, 'click');
	const sheet = tab.document.getElementById('testnet-sheet');
	check('(d) the chip opens the Testnet sheet', !!sheet && sheet.querySelector('h2').textContent === 'Testnet');
	const card = sheet && sheet.querySelector('.tn-card-num');
	check('(d) the sheet holds the sandbox card', card && card.textContent === '4242 4242 4242 4242');
	const copy = sheet && sheet.querySelector('.tn-copy');
	if (copy) { fire(copy, 'click'); await tick(); }
	check('(d) Copy copies the bare number', tab.win._copied === '4242424242424242', String(tab.win._copied));
	const rep = sheet && sheet.querySelector('.tn-report');
	check('(d) the sheet has Report a Problem', rep && rep.textContent === 'Report a Problem');
	if (rep) fire(rep, 'click');
	const box = tab.document.getElementById('support-sheet');
	const ta = box && box.querySelector('textarea');
	check('(d) Report a Problem opens the report box', !!ta);
	check('(d) the box takes at most 2000 characters', ta && ta.maxLength === 2000);
	check('(d) the Testnet sheet closed behind it', !tab.document.getElementById('testnet-sheet'));
});

// (e) the rows, and the allow-list
const KEYV = 'sk-or-v1-' + '9f3c'.repeat(16);
const PASS = 'passphrase: Wombat7Kettle9Drum';
async function sendBox(tab, text) {
	tab.win.DaimondSupport.report('settings');
	const box = tab.document.getElementById('support-sheet');
	const ta = box.querySelector('textarea');
	ta.value = text;
	fire(box.querySelector('.report-send'), 'click');
	await tick();
	return tab.posts[tab.posts.length - 1];
}
await tryRun('(e) rows', async () => {
	const tab = makeTab({ reply: TEST, scripts: PAGE });
	await tick();
	// One report line per sentence: scrub.js masks a passphrase to the end of its line, so
	// the multi-word one is caught, and the words after it on the next line still travel.
	const long = ('The diamond stalled after the upload — día ✓ ' + KEYV + ' and ' + PASS + '.\n').repeat(14).slice(0, 2000);
	const p = await sendBox(tab, long);
	const rows = (p && p.body && p.body.rows) || [];
	check('(e) posted to /api/debug-trace', p && p.url === '/api/debug-trace');
	check('(e) the header row is tagged testnet.report', rows[0] && rows[0].tag === 'testnet.report', rows[0] && rows[0].tag);
	const txt = rows.filter((r) => /^testnet\.report text/.test(r.tag));
	const enc = new TextEncoder();
	check('(e) the text is split across rows', txt.length > 1, 'rows=' + txt.length);
	check('(e) every text row is at most 380 bytes', txt.every((r) => enc.encode(r.data).length <= 380),
		txt.map((r) => enc.encode(r.data).length).join(','));
	check('(e) every tag fits the gateway\'s 64', rows.every((r) => r.tag.length <= 64));
	const joined = txt.map((r) => r.data).join('');
	check('(e) the text arrives whole, in order', joined.indexOf('The diamond stalled after the upload — día ✓') === 0 && joined.split('The diamond stalled').length > 12);
	const wire = JSON.stringify(p.body);
	check('(e) allow-list: no provider key travels', wire.indexOf('9f3c9f3c9f3c') < 0);
	check('(e) allow-list: no passphrase travels', wire.indexOf('Wombat7Kettle9Drum') < 0);

	const bare = makeTab({ reply: TEST, scripts: PAGE.filter((f) => f !== 'scrub.js' && f !== 'debugshare.js') });
	await tick();
	const q = await sendBox(bare, 'plain words ' + KEYV);
	const qrows = (q && q.body && q.body.rows) || [];
	check('(e) without the scrubber no text row is sent', qrows.length > 0 && qrows.every((r) => !/^testnet\.report text/.test(r.tag)));
	check('(e) ... and the header says it was withheld', qrows[0] && /text=withheld/.test(qrows[0].data), qrows[0] && qrows[0].data);
});

// (f) the runner row
await tryRun('(f) runner', async () => {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const start = src.indexOf('\n\t\tfunction runnerMintRow(');
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	const fnSrc = src.slice(start + 1, i);
	for (const [caps, wantBtn] of [[{ runner: true }, true], [{ runner: false }, false]]) {
		const tab = makeTab({ reply: { ok: true, network: 'test', capabilities: caps }, scripts: ['policy.js'] });
		await tick();
		const view = makeNode('div');
		const el = (t, c, x) => { const n = makeNode(t); if (c) n.className = c; if (x !== undefined) n.textContent = x; return n; };
		const make = new Function('window', 'document', 'DaimondNet', 't', 'el', 'idCopyBtn', 'DaimondGateway',
			'var RUNNER_MINT_URL = "", RUNNER_MINT_CMD = "", RUNNER_MINT_TOKEN_RE = /x/, _runnerMinted = null;\n'
			+ fnSrc + '\nreturn runnerMintRow;');
		const row = make(tab.win, tab.document, tab.win.DaimondNet, (k) => k, el, () => makeNode('button'), {});
		row(view);
		const btn = view.children.find((c) => c.className === 'admin-item');
		const note = view.children.find((c) => c.className === 'admin-note');
		if (wantBtn) check('(f) runner on: the pair button is drawn', !!btn && !note);
		else check('(f) runner off: a short label, no pair button', !btn && note && note.textContent === 'devices.runner_off');
	}
});

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
