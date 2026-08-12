// probe_typstpkg.mjs — can the vendored compiler be given a Typst package it already has?
//
// The author's book template opens with `#import "@preview/cetz:0.3.4"`.  `@preview` is
// the Typst Universe registry, fetched over the network, and the in-browser compiler has
// none -- so gathering every local file still leaves the book uncompilable.  Before any
// work is proposed on that, one question has to be answered from the artefact rather than
// from memory: does this build expose a way to SUPPLY a package it is handed?
//
// Three things in `typst_ts_web_compiler.d.ts` say it might:
//
//   TypstCompilerBuilder.set_package_registry(context, real_resolve_fn)
//   TypstCompilerBuilder.set_access_model(context, mtime, is_file, real_path, read_all)
//   ProxyContext.untar(data, cb)   "untar a tarball and call a callback for each entry"
//
// This probe wires all three to JavaScript callbacks that log every argument they are
// handed, serves cetz 0.3.4 out of the local Typst cache (READ ONLY -- nothing is fetched
// over the network), and tries to compile a document that imports it.  Whether it
// succeeds or fails, the log says what the interface actually wants.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as pjoin } from 'node:path';
import { open } from './harness.mjs';

const CACHE = process.env.HOME + '/.cache/typst/packages/preview';
// Everything in the cache, every version.  cetz imports oxifmt, and a package that
// resolves but whose own dependency does not is indistinguishable from one that never
// resolved -- the first run of this probe stopped exactly there.
const PKGS = [];
for (const name of readdirSync(CACHE)) {
	for (const ver of readdirSync(pjoin(CACHE, name))) PKGS.push([name, ver]);
}

function walk(root, rel = '') {
	const out = [];
	for (const name of readdirSync(pjoin(root, rel))) {
		const r = rel ? rel + '/' + name : name;
		if (statSync(pjoin(root, r)).isDirectory()) { out.push(...walk(root, r)); continue; }
		out.push([r, Array.from(readFileSync(pjoin(root, r)))]);
	}
	return out;
}

const supply = [];
for (const [name, ver] of PKGS) {
	const root = pjoin(CACHE, name, ver);
	try { statSync(root); } catch (e) { console.log('not cached: ' + name + ':' + ver); continue; }
	for (const [rel, bytes] of walk(root)) supply.push([`/pkg/preview/${name}/${ver}/${rel}`, bytes]);
}
console.log(`serving ${supply.length} package files from ${CACHE}`);

const s = await open({ name: 'typstpkg' });
const p = s.page;
await p.waitForTimeout(1200);

const out = await p.evaluate(async (supply) => {
	const VENDOR = new URL('/vendor/typst/', location.href);
	const mod = await import(new URL('typst_ts_web_compiler.mjs', VENDOR).href);
	await mod.default(new URL('typst_ts_web_compiler_bg.wasm', VENDOR));

	const files = new Map();
	for (const [path, bytes] of supply) files.set(path, new Uint8Array(bytes));
	const log = [];
	const note = (what, args) => {
		if (log.length < 40) log.push(what + '(' + args.map(a =>
			typeof a === 'string' ? JSON.stringify(a) : Object.prototype.toString.call(a)).join(', ') + ')');
	};

	const b = new mod.TypstCompilerBuilder();
	let wired = 'ok';
	try {
		await b.set_access_model({},
			(...a) => { note('mtime', a); return 0; },
			(...a) => { note('is_file', a); return files.has(String(a[a.length - 1])); },
			(...a) => { note('real_path', a); return String(a[a.length - 1]); },
			(...a) => {
				note('read_all', a);
				const f = files.get(String(a[a.length - 1]));
				if (!f) throw new Error('no such file: ' + a[a.length - 1]);
				return f;
			});
		await b.set_package_registry({}, (...a) => {
			note('resolve', a);
			// The spec arrives somehow; answer with the directory the files are under.
			const j = JSON.stringify(a.map(x => typeof x === 'string' ? x : (x && x.name ? x : null)));
			log.push('resolve-arg-shape ' + j.slice(0, 300));
			const spec = a.find(x => x && typeof x === 'object' && x.name) || null;
			if (spec) return `/pkg/${spec.namespace || 'preview'}/${spec.name}/${spec.version}`;
			return '/pkg/preview/cetz/0.3.4';
		});
	} catch (e) {
		wired = 'threw: ' + (e && e.message ? e.message : e);
	}
	for (const n of ['LibertinusSerif-Regular.otf', 'LibertinusSerif-Bold.otf',
		'LibertinusSerif-Italic.otf', 'LibertinusSerif-BoldItalic.otf', 'NewCMMath-Regular.otf']) {
		const r = await fetch(new URL('fonts/' + n, VENDOR));
		await b.add_raw_font(new Uint8Array(await r.arrayBuffer()));
	}
	let res = {};
	try {
		const c = await b.build();
		c.reset_shadow();
		c.add_source('/m.typ', '#import "@preview/cetz:0.3.4"\n'
			+ '#cetz.canvas({ import cetz.draw: *; circle((0,0), radius: 1) })\n');
		const ret = c.compile('/m.typ', undefined, 'pdf', 3);
		const pdf = ret instanceof Uint8Array ? ret : (ret && (ret.result || ret.artifact));
		res.bytes = pdf ? pdf.length : 0;
		res.diag = ret && ret.diagnostics ? JSON.stringify(ret.diagnostics).slice(0, 600) : '(none)';
	} catch (e) {
		res.built = 'threw: ' + (e && e.message ? e.message : e);
	}
	res.wired = wired;
	res.log = log;
	return res;
}, supply);

console.log(JSON.stringify(out, null, 2));
await s.close();
