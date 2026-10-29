/* ============================================================
   Test — Settings → Devices mints a runner's pairing token
   (FIRST-RUN MINT-UI).
   ------------------------------------------------------------
   Production had no way to mint one: only the rig posted to
   /api/runner/pair/mint, so a computer could not be paired from
   the app at all. The Devices list now carries "Pair a computer
   as a runner".

     M1  the press posts to /api/runner/pair/mint, through gwFetch;
     M2  it shows exactly `/opt/kimberlite/bin/runner pair <token>`
         and a Copy that copies exactly that line;
     M3  it says how long the token lasts (the gateway's ten minutes);
     M4  a second press mints again and shows only the new token;
     M5  a refusal is said in place, in plain words, with no line;
     M6  the token never reaches storage, sync or the console.

   Lifts the REAL function out of daimond.js. Red proof: run
   against 770b1069c.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	const a = SRC.indexOf('\n\t\tfunction ' + name + '(');
	if (a < 0) { console.log('  (this revision lacks: ' + name + ')'); return ''; }
	return SRC.slice(a, SRC.indexOf('\n\t\t}\n', a) + 4);
}
function constOf(name) {
	const m = SRC.match(new RegExp('var ' + name + ' *= *\'([^\']*)\''));
	return m ? m[1] : '';
}

// A DOM just deep enough: elements keep their children, listeners and attributes.
function mk(tag) {
	return { tag, children: [], textContent: '', className: '', disabled: false, type: '', attrs: {}, style: {},
		listeners: {},
		appendChild(c) { this.children.push(c); return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
		get firstChild() { return this.children[0] || null; },
		setAttribute(k, v) { this.attrs[k] = String(v); },
		addEventListener(k, f) { this.listeners[k] = f; } };
}
function text(n) { return (n.textContent || '') + n.children.map(text).join(''); }
function walk(n, f) { f(n); n.children.forEach((c) => walk(c, f)); }

// Everywhere a token could leak to: storage, sync and the console.
const leaks = [];
function spy(where) {
	return new Proxy({}, { get: (_, k) => (...a) => { leaks.push(where + '.' + String(k) + ' ' + JSON.stringify(a)); return null; } });
}
const copies = [];
const posts  = [];
let replies  = [];
const timers = [];
const env = {
	document: { createElement: mk }, String, JSON, Math, Number, RegExp,
	localStorage: spy('localStorage'), sessionStorage: spy('sessionStorage'), indexedDB: spy('indexedDB'),
	console: spy('console'),
	window: { DaimondSync: spy('DaimondSync') },
	DaimondSync: spy('DaimondSync'),
	DaimondGateway: { gwFetch: async (path, opts) => { posts.push([path, opts]); const r = replies.shift(); if (r === 'offline') throw new Error('offline'); return r; } },
	t: (k, o) => k + (o ? ' ' + JSON.stringify(o) : ''),
	tOr: (k, f, o) => k + (o ? ' ' + JSON.stringify(o) : ''),
	idCopyBtn: (what, get) => { const b = mk('button'); b.className = 'copy-id'; b.copyGet = get; b.what = what; return b; },
	copyToClipboard: async (s) => { copies.push(s); },
	setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimeout: () => {},
	RUNNER_MINT_URL: constOf('RUNNER_MINT_URL'), RUNNER_MINT_CMD: constOf('RUNNER_MINT_CMD'),
	RUNNER_MINT_TOKEN_RE: (() => { const m = SRC.match(/var RUNNER_MINT_TOKEN_RE *= *(\/.*\/);/); return m ? eval(m[1]) : /^$/; })(),
};
const NAMES = ['el', 'runnerMintRow'];
const have = NAMES.map((n) => [n, lift(n)]).filter((x) => x[1]);
const body = have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
const scope = new Proxy(env, {
	has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
	get: (t, k) => t[k],
	set: (t, k, v) => { t[k] = v; return true; },
});
const F = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);

function reply(status, j) { return { ok: status >= 200 && status < 300, status, json: async () => j }; }
const TOK  = 'abcd2345efgh6789ikmnpqrs';
const TOK2 = 'zyxw9876vuts5432rqpn2345';
const LINE = (k) => '/opt/kimberlite/bin/runner pair ' + k;
function lines(view) {
	const out = [];
	walk(view, (n) => { if (n.tag === 'pre') out.push(n.textContent); });
	return out;
}
function copyOf(view) {
	let b = null;
	walk(view, (n) => { if (n.className === 'copy-id') b = n; });
	return b;
}
async function press(view) {
	let go = null;
	walk(view, (n) => { if (!go && n.tag === 'button' && n.className === 'admin-item') go = n; });
	if (!go || !go.listeners.click) return false;
	await go.listeners.click({ preventDefault() {} });
	return true;
}

async function main() {
	const view = mk('div');
	if (!F.runnerMintRow) { check('M0 Devices has a mint row', false, 'no runnerMintRow'); return; }
	F.runnerMintRow(view);
	check('M0 the row is labelled as a pairing', text(view).includes('devices.runner_mint'), text(view));
	check('M0b nothing is shown before the press', lines(view).length === 0, lines(view));

	replies = [reply(200, { ok: true, token: TOK, expires_in: 600 })];
	check('M1 there is a button to press', await press(view));
	check('M1 the press posts to /api/runner/pair/mint',
		posts.length === 1 && posts[0][0] === '/api/runner/pair/mint' && posts[0][1] && posts[0][1].method === 'POST',
		JSON.stringify(posts));
	const ls = lines(view);
	check('M2 it shows exactly the runner pair line', ls.length === 1 && ls[0] === LINE(TOK), JSON.stringify(ls));
	const cb = copyOf(view);
	const got = cb && (typeof cb.copyGet === 'function' ? cb.copyGet() : cb.copyGet);
	check('M2b Copy copies exactly that line', got === LINE(TOK), got);
	let rowOfCopy = null;
	walk(view, (n) => { if (n.className === 'device-row' && n.children.some((c) => c.className === 'copy-id')) rowOfCopy = n; });
	check('M2c Copy sits in a device row\'s copy column, as every device\'s does', !!rowOfCopy
		&& rowOfCopy.children.map((c) => c.className).join(',') === 'device-name,copy-id,device-acts',
		rowOfCopy && rowOfCopy.children.map((c) => c.className).join(','));
	check('M3 it says the token lasts ten minutes', /devices\.runner_mint_expiry \{"n":10\}/.test(text(view)), text(view));

	replies = [reply(200, { ok: true, token: TOK2, expires_in: 600 })];
	await press(view);
	const ls2 = lines(view);
	check('M4 a second press mints again', posts.length === 2, posts.length);
	check('M4b only the new token is shown', ls2.length === 1 && ls2[0] === LINE(TOK2), JSON.stringify(ls2));

	// It lapses where it stands: at the gateway's expiry the line goes.
	const lapse = timers.filter((x) => x[1] === 600 * 1000).pop();
	if (lapse) lapse[0]();
	check('M4c the line goes when the token lapses', !!lapse && lines(view).length === 0
		&& text(view).includes('devices.runner_mint_lapsed'), text(view));

	replies = [reply(500, { ok: false })];
	await press(view);
	check('M5 a refusal shows no line', lines(view).length === 0, JSON.stringify(lines(view)));
	check('M5b and is said in place', text(view).includes('devices.runner_mint_failed'), text(view));
	replies = [reply(401, { ok: false })];
	await press(view);
	check('M5c a lapsed session asks to sign in', text(view).includes('devices.runner_mint_signin'), text(view));
	replies = ['offline'];
	await press(view);
	check('M5d an offline press is said, not thrown', text(view).includes('devices.runner_mint_failed'), text(view));

	const tokLeaks = leaks.filter((l) => l.includes(TOK) || l.includes(TOK2));
	check('M6 the token never reaches storage, sync or the console', tokLeaks.length === 0, tokLeaks.join('; '));
}
main().catch((e) => { console.log('  FAIL threw ' + (e && e.stack || e)); failures++; }).then(() => {
	console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
	process.exit(failures ? 1 : 0);
});
