/* ============================================================
   Test — the runner approval tile shows the device key's
   fingerprint, the one `kimberlite pair` prints (QA-B #1, LOW).
   ------------------------------------------------------------
   The tile named the runner only, so whoever held the token could
   join first under the right name and take the owner's approval.
   It now shows the key's 4×4 fingerprint and holds Approve until
   it is shown.

     F1  the page's fingerprint is kimberlite's for the shared vector
         ([7; 32] → 311d 23d8 4360 c5dc, pair.rs test_qab1);
     F2  the tile shows it, in the same form;
     F3  Approve is held until the key is shown;
     F4  a key that is not 32 bytes gives no fingerprint.

   Lifts the REAL functions out of daimond.js. Red proof: run
   against e6594b179.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	let a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) a = SRC.indexOf('\n\tasync function ' + name + '(');
	if (a < 0) { console.log('  (this revision lacks: ' + name + ')'); return ''; }
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}
const dom = SRC.match(/var RUNNER_PAIR_FP_DOMAIN = '([^']*)'/);

function el() {
	return { children: [], textContent: '', className: '', disabled: false, type: '',
		appendChild(c) { this.children.push(c); return c; }, addEventListener() {} };
}
const env = {
	document: { createElement: el }, crypto: webcrypto, atob: atob, TextEncoder: TextEncoder,
	Uint8Array: Uint8Array, String: String, Date: Date,
	RUNNER_PAIR_FP_DOMAIN: dom ? dom[1].replace('\\0', '\0') : '',
	t: (k, o) => k + (o ? ' ' + JSON.stringify(o) : ''), toast: () => {},
	runnerPairApprove: async () => ({ ok: true }), runnerPairRefuse: async () => true,
};
const NAMES = ['runnerPairFingerprint', 'runnerPairTile'];
const have = NAMES.map((n) => [n, lift(n)]).filter((x) => x[1]);
const body = have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
const scope = new Proxy(env, {
	has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
	get: (t, k) => t[k],
	set: (t, k, v) => { t[k] = v; return true; },
});
const F = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);

const PK = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';	// [7; 32]
const FP = '311d 23d8 4360 c5dc';
async function main() {
	const fp = F.runnerPairFingerprint ? await F.runnerPairFingerprint(PK) : '';
	check('F1 the page\'s fingerprint is kimberlite\'s for the shared vector', fp === FP, fp);
	const box = el();
	const p = F.runnerPairTile(box, { runnerpair: { device: 'dev1', pubkey: PK, name: 'argonaut', joined: 1 } });
	const acts = box.children.find((c) => c.className === 'pend-acts');
	const go = acts && acts.children[0];
	check('F3 Approve is held until the key is shown', !!go && go.disabled === true, go && go.disabled);
	await p;
	const text = box.children.map((c) => c.textContent).join(' | ');
	check('F2 the tile shows the key\'s fingerprint', text.includes(FP), text);
	check('F3b Approve is open once it is shown', !!go && go.disabled === false, go && go.disabled);
	const bad = F.runnerPairFingerprint ? await F.runnerPairFingerprint('AAAA') : 'x';
	check('F4 a key that is not 32 bytes gives no fingerprint', bad === '', bad);
}
main().then(() => {
	console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
	process.exit(failures ? 1 : 0);
});
