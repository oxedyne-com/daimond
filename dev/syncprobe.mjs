/* The sync law harness (from the D-28 state review's P1b probes, 2026-09-25).
 *
 * Every merge law is reached in the tree under test and run as written: a classic
 * script (trash.js, graph.js, ...) is compiled from its own file and run in a stand-in
 * window, after stamp.js as index.html loads it; a closure inside daimond.js's IIFE is
 * lifted out of the file's own text with every IIFE-level declaration it reaches, and
 * evaluated. Nothing here restates a law. Used by www/js/synclaws.test.mjs and
 * www/js/stampfloor.test.mjs.
 *
 * TREE selects the checkout (default: the one this file is in). */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

export const TREE = process.env.TREE || join(dirname(fileURLToPath(import.meta.url)), '..');
export const js = (f) => join(TREE, 'www', 'js', f);

// ── A stand-in browser ─────────────────────────────────────────────

export function storage(init) {
	const m = new Map(Object.entries(init || {}));
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { m.set(k, String(v)); },
		removeItem: (k) => { m.delete(k); },
		key: (i) => [...m.keys()][i] || null,
		get length() { return m.size; },
		clear: () => m.clear(),
		_m: m,
	};
}

/// Anything: a callable that answers itself for every property, for DOM stubs.
function anything() {
	const f = function () { return p; };
	const p = new Proxy(f, {
		get: (t, k) => {
			if (k === Symbol.toPrimitive) return () => '';
			if (k === 'then') return undefined;
			if (k === 'length') return 0;
			if (k === 'style' || k === 'dataset' || k === 'classList') return p;
			return p;
		},
		apply: () => p,
		construct: () => p,
		set: () => true,
	});
	return p;
}

export function makeWindow(opts) {
	opts = opts || {};
	const ls = opts.ls || storage();
	let clock = opts.now || 1_000_000;
	const D = function (...a) { return a.length ? new Date(...a) : new Date(clock); };
	D.now = () => clock;
	D.UTC = Date.UTC; D.parse = Date.parse; D.prototype = Date.prototype;
	const listeners = {};
	const win = {
		localStorage: ls,
		sessionStorage: storage(),
		document: new Proxy({ currentScript: null, readyState: 'complete', hidden: false, visibilityState: 'visible', cookie: '' }, { get: (t, k) => (k in t ? t[k] : anything()) }),
		navigator: { userAgent: 'node', platform: 'Linux', language: 'en', languages: ['en'], onLine: true, storage: undefined, locks: undefined },
		location: { href: 'https://daimond.test/', origin: 'https://daimond.test', hostname: 'daimond.test', protocol: 'https:', search: '', hash: '', pathname: '/' },
		crypto: webcrypto,
		console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
		setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
		requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
		queueMicrotask: (f) => Promise.resolve().then(f),
		addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
		removeEventListener: () => {},
		dispatchEvent: () => true,
		CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
		Event: function (type) { this.type = type; },
		fetch: () => Promise.reject(new Error('no network in the probe')),
		matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
		getComputedStyle: () => anything(),
		TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams, AbortController,
		MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
		ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
		IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
		Date: D,
		Math, JSON, Object, Array, String, Number, Boolean, Promise, Map, Set, WeakMap, RegExp, Error, TypeError,
		Symbol, parseInt, parseFloat, isFinite, isNaN, Uint8Array, ArrayBuffer, DataView, BigInt, encodeURIComponent,
		decodeURIComponent, escape, unescape, structuredClone, Intl, Reflect, Proxy, Infinity, NaN, undefined,
		indexedDB: undefined,
		_listeners: listeners,
		_setNow: (t) => { clock = t; },
	};
	win.window = win; win.self = win; win.globalThis = win;
	Object.assign(win, opts.extra || {});
	// The shared modules index.html loads before every module that keeps a synced
	// record, where the tree under test has them: the stamp rule, and the checked
	// write (store.js, from fix/sync-state-r5).
	for (const base of ['stamp.js', 'store.js']) if (existsSync(js(base))) loadScript(win, base);
	return win;
}

const compiled = new Map();
/// Run a classic script in `win`, as index.html runs it.
export function loadScript(win, file) {
	let fn = compiled.get(file);
	if (!fn) {
		const src = readFileSync(js(file), 'utf8');
		fn = new Function('window', 'with (window) {\n' + src + '\n}\n//# sourceURL=' + file);
		compiled.set(file, fn);
	}
	fn(win);
	return win;
}

// ── Lifting closures out of daimond.js ─────────────────────────────

let _decls = null;
function daimondDecls() {
	if (_decls) return _decls;
	const lines = readFileSync(js('daimond.js'), 'utf8').split('\n');
	const out = new Map();
	let start = lines.findIndex((l) => /^\(function\b/.test(l));
	const fnRe = /^\t(?:async )?function\*? ?([A-Za-z_$][\w$]*)\s*\(/;
	const varRe = /^\t(?:var|const|let) ([A-Za-z_$][\w$]*)\b/;
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i];
		let m = fnRe.exec(l);
		if (m) {
			let j = i;
			const oneLine = /\}\s*$/.test(l) && l.split('{').length === l.split('}').length;
			if (!oneLine) for (j = i + 1; j < lines.length; j++) if (/^\t\}/.test(lines[j])) break;
			if (!out.has(m[1])) out.set(m[1], { src: lines.slice(i, j + 1).join('\n'), line: i + 1, kind: 'function' });
			i = j; continue;
		}
		m = varRe.exec(l);
		if (m && !/^\t(?:var|const|let) [A-Za-z_$][\w$]*\s*,/.test(l)) {
			let j = i;
			if (!/;\s*(\/\/.*)?$/.test(l)) {
				for (j = i + 1; j < lines.length; j++) {
					if (/^\t[\]})]/.test(lines[j]) && /;\s*(\/\/.*)?$/.test(lines[j])) break;
					if (/^\t[^\t\s\]})]/.test(lines[j])) { j--; break; }
				}
			}
			if (!out.has(m[1])) out.set(m[1], { src: lines.slice(i, j + 1).join('\n'), line: i + 1, kind: 'var' });
			i = j;
		}
	}
	_decls = out;
	return out;
}
function mentions(src) {
	const body = src.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
	const out = new Set(); const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g; let m;
	while ((m = re.exec(body))) out.add(m[2]);
	return out;
}
/// Lift `names` (and what they reach) from daimond.js into `win`. `stub` names are
/// supplied rather than lifted (a store, a renderer). Answers the functions and the
/// line each lifted declaration came from.
/// The source of `names` and every top-level declaration they reach, functions first,
/// less the names in `stubbed` (which the caller supplies). For a test that builds its
/// own scope around the app's code: it cannot drift from what the app's code reaches
/// the way a hand-kept list does (r53 msg2: a list naming `msgTier` outlived it).
export function liftSource(names, stubbed) {
	const stubs = new Set(stubbed || []);
	const all = daimondDecls();
	const want = [], seen = new Set();
	const visit = (n) => {
		if (seen.has(n) || stubs.has(n)) return;
		const d = all.get(n); if (!d) return;
		seen.add(n);
		for (const x of mentions(d.src)) if (x !== n && all.has(x)) visit(x);
		want.push(n);
	};
	for (const n of names) { if (!all.has(n)) throw new Error('no declaration ' + n); visit(n); }
	const ordered = want.slice().sort((a, b) => {
		const da = all.get(a), db = all.get(b);
		if (da.kind !== db.kind) return da.kind === 'function' ? -1 : 1;
		return da.line - db.line;
	});
	return { src: ordered.map((n) => all.get(n).src).join('\n'), ordered, lines: Object.fromEntries(ordered.map((n) => [n, all.get(n).line])) };
}

export function sliceDaimond(win, names, stub) {
	stub = stub || {};
	const { src, ordered, lines } = liftSource(names, Object.keys(stub));
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ') {\n' + src + '\nreturn { ' + names.join(', ') + ' };\n}).apply(null, arguments[1]); }';
	const fn = new Function('window', 'stubs', body.replace('arguments[1]', 'stubs'));
	const fns = fn(win, sk.map((k) => stub[k]));
	return { fns, lines, lifted: ordered };
}
export function declLine(name) { const d = daimondDecls().get(name); return d ? d.line : 0; }

// ── Seeded choice ─────────────────────────────────────────────────

export function rng(seed) {
	let s = seed >>> 0 || 1;
	const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
	return {
		next, int: (n) => Math.floor(next() * n), pick: (a) => a[Math.floor(next() * a.length)],
		chance: (p) => next() < p,
		sub: (a) => a.filter(() => next() < 0.5),
	};
}

export function canon(x) {
	return JSON.stringify(x, (k, v) => {
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const o = {}; for (const key of Object.keys(v).sort()) o[key] = v[key]; return o;
		}
		return v;
	});
}
function firstDiff(a, b, path) {
	if (canon(a) === canon(b)) return null;
	if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return path + ': ' + canon(a) + ' vs ' + canon(b);
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) { const d = firstDiff(a[k], b[k], path + '/' + k); if (d) return d; }
	return path + ': (order) ' + canon(a).slice(0, 120) + ' vs ' + canon(b).slice(0, 120);
}

// ── The three laws ────────────────────────────────────────────────
//
// A kind is { name, gen(r) -> state, join(states...) -> state } where `join` is the
// real law: a fresh replica that takes each state in turn (the adopt path) or the
// pure merge applied left to right. Checked:
//   idempotent   join(x, x) == join(x)
//   commutative  join(x, y) == join(y, x)
//   associative  join(join(x, y), z) == join(x, join(y, z))
// `join(x)` is the replica holding x alone: a law whose single adopt already moves x
// is reported as `lossy on adopt`, a fault of its own (the replica is not faithful).

export async function checkKind(kind, trials, seed) {
	const r = rng(seed || 7);
	const res = { name: kind.name, trials: 0, fail: {}, first: {}, errors: 0, firstError: '' };
	const note = (law, detail) => {
		res.fail[law] = (res.fail[law] || 0) + 1;
		if (!res.first[law]) res.first[law] = detail;
	};
	for (let i = 0; i < trials; i++) {
		const x = kind.gen(r), y = kind.gen(r), z = kind.gen(r);
		try {
			const j = async (...s) => canon(await kind.join(...s));
			const x1 = await j(x);
			const xx = await j(x, x);
			if (xx !== x1) note('idempotent', { x, 'x⊔x': JSON.parse(xx), x1: JSON.parse(x1), at: firstDiff(JSON.parse(xx), JSON.parse(x1), '') });
			const xy = await j(x, y), yx = await j(y, x);
			if (xy !== yx) note('commutative', { x, y, 'x⊔y': JSON.parse(xy), 'y⊔x': JSON.parse(yx), at: firstDiff(JSON.parse(xy), JSON.parse(yx), '') });
			const l = await j(JSON.parse(xy), z);
			const yz = await j(y, z);
			const rr = await j(x, JSON.parse(yz));
			if (l !== rr) note('associative', { x, y, z, '(x⊔y)⊔z': JSON.parse(l), 'x⊔(y⊔z)': JSON.parse(rr), at: firstDiff(JSON.parse(l), JSON.parse(rr), '') });
			if (kind.faithful !== false) {
				const again = await j(JSON.parse(x1));
				if (again !== x1) note('fixed point', { x, 'join(x)': JSON.parse(x1), 'join(join(x))': JSON.parse(again) });
			}
			res.trials++;
		} catch (e) {
			res.errors++;
			if (!res.firstError) res.firstError = String(e && e.stack || e).split('\n').slice(0, 4).join(' | ');
		}
	}
	return res;
}
