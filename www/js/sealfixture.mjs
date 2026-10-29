/* sealfixture.mjs -- the real seal in a test's stand-in window: the wasm from www/pkg and
   `window.DaimondSeal` built from the very lines daimond.js builds it from (the block between
   `// SEAL-BRIDGE-BEGIN` and `// SEAL-BRIDGE-END`). post.js and peer.js seal and open through
   that bridge only (S1 SEAL), so every harness that runs either calls this first.

     await loadSeal()                once, before the tabs: instantiates one shared module
     installSeal(win)                a ready DaimondSeal over it (synchronous, for makeTab)
     const s = await pendingSeal(win) a FRESH, not yet instantiated module, as the page has it
                                      before init(); s.start() instantiates it and marks the
                                      bridge ready, s.fail(e) marks the boot failed

   Needs www/pkg (dev/build-wasm.sh --no-opt). */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync, existsSync } from 'node:fs';

const PKG = new URL('../pkg/', import.meta.url);
const JS = new URL('oxedyne_daimond.js', PKG);
const WASM = new URL('oxedyne_daimond_bg.wasm', PKG);

function bridgeSource() {
	const src = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
	const a = src.indexOf('// SEAL-BRIDGE-BEGIN'), b = src.indexOf('// SEAL-BRIDGE-END');
	if (a < 0 || b < 0) throw new Error('sealfixture: daimond.js has no SEAL-BRIDGE markers');
	return src.slice(a, b);
}

async function freshModule(tag) {
	if (!existsSync(JS)) throw new Error('sealfixture: no www/pkg -- build it with dev/build-wasm.sh --no-opt');
	// A query makes a separate module instance, with its own (unset) wasm binding.
	return await import(JS.href + '?' + tag);
}

let shared = null;

/// Instantiate the one module every ready tab shares.
export async function loadSeal() {
	if (!shared) {
		const mod = await freshModule('shared');
		mod.initSync({ module: readPage(WASM) });
		shared = mod;
	}
	return shared;
}

/// Give `win` a ready DaimondSeal over the shared module (`loadSeal` first).
export function installSeal(win) {
	if (!shared) throw new Error('sealfixture: await loadSeal() before installSeal');
	new Function('window', 'Sbj', bridgeSource())(win, shared);
	return win.DaimondSeal;
}

let fresh = 0;

/// Give `win` a DaimondSeal over a module NOT yet instantiated, as daimond.js has it before
/// `init()` finishes; answer the levers the boot pulls.
export async function pendingSeal(win) {
	const mod = await freshModule('pending' + (++fresh));
	new Function('window', 'Sbj', bridgeSource())(win, mod);
	return {
		seal: win.DaimondSeal,
		mod,
		start() { mod.initSync({ module: readPage(WASM) }); win.DaimondSeal.markReady(); },
		fail(e) { win.DaimondSeal.markFailed(e); },
	};
}
