// R2f: a paired native runner's presence row keeps the gateway's `kind: "runner"`, and
// the Devices list's Remove on such a row goes to the runner's own door.
//   node www/js/runnerremove.test.mjs
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}

const win = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readPage(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
{
	const PR = win.DaimondPresence;
	const now = Date.now();
	PR.ingest({ rn: { name: 'argonaut', last_seen: now, runner: true, kind: 'runner' },
		tab: { name: 'laptop', last_seen: now } }, now);
	const snap = PR.snapshot();
	check('K1 a native runner\'s row keeps kind "runner"', snap.rn && snap.rn.kind === 'runner', JSON.stringify(snap));
	check('K2 a tab\'s row carries no kind', snap.tab && !('kind' in snap.tab), JSON.stringify(snap));
}
{
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');
	const a = src.indexOf('async function askRemoveDevice(');
	const b = src.indexOf('\n\t\tfunction el(', a);
	const body = a >= 0 && b > a ? src.slice(a, b) : '';
	const door = body.indexOf("'/api/runner/pair/remove'");
	const sync = body.indexOf('DaimondSync.removeDevice(id)');
	check('K3 Remove on a runner row posts to the runner door, else the sync door',
		door > 0 && sync > door && /kind === 'runner'/.test(body), 'door ' + door + ' sync ' + sync);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
