// probe_typstspin.mjs — the guard against a rebuild loop, proved on code that spins.
//
// The author reported the status bar cycling `Live` / `Rebuilding` every 1-2 s with
// nothing being edited, and the compiler at 2427 MB by the end of it. A rebuild on
// unchanged bytes is free, so a spin costs nothing until the bytes really do differ
// — and then about 10 MB a time (`dev/probe_typstloop.mjs`), which is why an
// unattended spin walks into the heap ceiling and why the loop has to notice.
//
// This serves a DELIBERATELY BROKEN `typstwatch.js` in which the poll always reports
// a change, which is the fault whatever its cause, and asks what the loop does. Two
// runs, and the pair is the point:
//
//     node dev/probe_typstspin.mjs            # the guard in place: it stops and says why
//     node dev/probe_typstspin.mjs --noguard  # the guard defeated: it spins forever
//
// It asserts nothing and is not a verifier.
//
//     eval "$(bash dev/world.sh 5 --env)"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const NOGUARD = process.argv.includes('--noguard');

const SRC = path.join(WWW, 'js', 'typstwatch.js');
let body = fs.readFileSync(SRC, 'utf8');

// The fault: every poll finds one watched file changed, whatever it really says.
//
// `--big` makes it claim a size past `DIGEST_MAX` as well, which is the one case
// the contents cannot settle — the file is too large to read back — and therefore
// the case the count-and-hold backstop is for. Without it the file is small, and
// what stops the loop is the digest rather than the backstop.
const BIG = process.argv.includes('--big');
const anchor = '\t\tfor (let i = 0; i < S.files.length && i < got.length; i++) out[S.files[i]] = got[i];';
if (body.split(anchor).length - 1 !== 1) {
	console.error('the anchor for the fault is not there exactly once — nothing would be proved');
	process.exit(2);
}
// The TIME moves and the size is left alone, which is what a file whose stamp
// lies looks like from here — a fake length would be caught by the byte read
// rather than by the digest, and would prove the wrong thing. `--big` fakes the
// length on purpose, because that IS the case the digest cannot settle.
body = body.replace(anchor, anchor + (BIG
	? '\n\t\tif (S.files.length) out[S.files[0]] = String(Date.now()) + \':99999999\';'
	: '\n\t\tif (S.files.length) out[S.files[0]] = String(Date.now()) + \':\''
		+ ' + String(got[0]).split(\':\')[1];'));

if (NOGUARD) {
	for (const g of ['\tif (S.mode === \'live\' && S.same >= SPIN_MAX) {',
			'\t\tif (await confirmed(p, now[p])) continue;']) {
		if (body.split(g).length - 1 !== 1) { console.error('nothing to defeat: ' + g); process.exit(2); }
	}
	body = body
		.replace('\tif (S.mode === \'live\' && S.same >= SPIN_MAX) {', '\tif (false) {')
		.replace('\t\tif (await confirmed(p, now[p])) continue;', '\t\tif (false) continue;');
}

// BEFORE `goto`, or the page has already fetched the real file and the run proves
// nothing — which is what the harness's `route` option exists for.
const s = await open({ name: 'typstspin', route: async (page) => {
	await page.route('**/js/typstwatch.js', r => r.fulfill({
		status: 200, contentType: 'application/javascript', body }));
} });
const p = s.page;
await p.setViewportSize({ width: 1500, height: 950 });
await p.waitForTimeout(1200);
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	m.set_locked_packs('');
	await m.write_file('spinprobe/main.typ',
		'#set page(width: 300pt, height: 220pt)\n= A page\nSome text on it.\n');
});
await p.evaluate(() => window.DaimondDoc.show('spinprobe/main.typ'));
await p.waitForTimeout(1000);
await p.click('[data-act="compile"]', { force: true });

const st = () => p.evaluate(() => window.DaimondTypstWatch.state());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
console.log(NOGUARD ? '=== the guard defeated ===' : '=== the guard in place ===');
for (let i = 0; i < 12; i++) {
	await sleep(2000);
	const n = await st();
	console.log(`  +${(i + 1) * 2}s  mode ${n.mode}  builds ${n.builds}  drawn ${n.drawn}`
		+ `  same ${n.same}  heap ${n.heap.toFixed(0)} MB  why "${n.why}"`);
	if (n.mode === 'held') {
		console.log('  it stopped, and what it says is:\n    '
			+ n.reason.replace(/\s+/g, ' '));
		break;
	}
}
await s.close();
