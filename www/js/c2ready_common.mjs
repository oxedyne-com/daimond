// Shared loader for the c2ready_* arms (FIRE C2-READY, QA r572y C2b F1-F3): the real peer.js in a bare window.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
export function loadPeer() {
	const win = { console: { log() {}, warn() {}, error() {} }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
	new Function('window', 'with (window) {\n' + readFileSync(join(HERE, 'peer.js'), 'utf8') + '\n}')(win);
	return win.DaimondPeer;
}
