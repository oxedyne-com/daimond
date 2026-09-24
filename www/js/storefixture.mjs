/* storefixture.mjs -- the real store.js in a test's stand-in window, loaded as
   index.html loads it: before any module that keeps a synced record. Every
   harness that runs one of those modules (ledger.js, pause.js, trash.js,
   models.js, support.js, voice.js, identity.js, or a daimond.js record lifted
   out of the file) calls this first with the window and localStorage it hands
   the module. */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./store.js', import.meta.url), 'utf8');
// stamp.js follows store.js, as index.html loads it: the modules these harnesses run
// take their stamps from it (`DaimondStamp.next`, `.beats`).
const STAMP = readFileSync(new URL('./stamp.js', import.meta.url), 'utf8');

export function loadStore(win, localStorage) {
	new Function('window', 'localStorage', SRC)(win, localStorage);
	new Function('window', 'localStorage', STAMP)(win, localStorage);
	return win.DaimondStore;
}
