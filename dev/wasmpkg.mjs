// wasmpkg.mjs -- the real wasm (www/pkg, built from the tree) for the node tests that drive
// www/js/mail.js, which hand it to the page as deps.wasm (C1a, D-20261026-01).

import fs from 'node:fs';

let pkg = null;

/// The wasm namespace, initialised once.
export async function wasm() {
	if (pkg) return pkg;
	const base = new URL('../www/pkg/', import.meta.url);
	const m = await import(new URL('oxedyne_daimond.js', base).href);
	m.initSync({ module: fs.readFileSync(new URL('oxedyne_daimond_bg.wasm', base)) });
	pkg = m;
	return pkg;
}
