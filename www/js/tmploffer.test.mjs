/* ============================================================
   Test -- an edited page with a newer template is offered no merge (TMPLOFF, r545 hotfix).

   r545 offered a forked Life log the template's newer page as a line merge. The owner took
   it and the merged page threw `ReferenceError: readLanes is not defined`: a merge that
   keeps the person's lines where both sides changed can drop a definition the template's
   other changes call. Until a merged page is proved to load before it is offered, no
   offer is made: `cappMergeOffer` answers `null`, so no "Update the page" is drawn and
   the stored page is never touched.   `node www/js/tmploffer.test.mjs`
   ============================================================ */
import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL  = join(HERE, '..', 'capps', 'lifelog');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// A real served base, edited by the person, and today's template, which has moved on.
const fresh = readFileSync(join(TPL, 'crystal.html'), 'utf8');
const bname = readdirSync(join(TPL, 'base')).find((f) => f.endsWith('.html') && f !== sha(fresh) + '.html');
const base  = readFileSync(join(TPL, 'base', bname), 'utf8');
const from  = sha(base);
const mine  = base.replace('</body>', '<!-- kept as I had it -->\n</body>');

const win = makeWindow({});
loadScript(win, 'versions.js');
let wrote = 0;
const stubs = {
	readCappRecord:  async () => ({ capp: 'lifelog', v: 1, files: { 'crystal.html': from } }),
	writeCappRecord: async () => { wrote++; },
	CAPP_TEMPLATES:  { lifelog: { name: 'Log Life' } },
	cappManifest:    async () => ({ v: 99 }),
	cappFetchFile:   async (spec, path) => path === 'crystal.html' ? fresh
		: path === 'base/' + from + '.html' ? base : null,
	cappHash:        async (s) => sha(String(s)),
};
let fns = null;
try { fns = sliceDaimond(win, ['cappMergeOffer'], stubs).fns; }
catch (e) { check('cappMergeOffer exists', false, e.message); }

if (fns) {
	check('fixture: the page is edited and the template is newer', mine !== base && sha(fresh) !== from);
	const offer = await fns.cappMergeOffer('d1', mine);
	check('an edited page with a newer template is offered no merge', offer === null,
		offer ? 'offered, ' + offer.conflicts.length + ' conflicts' : '');
	check('and the record is left as it was', wrote === 0, wrote + ' writes');
}

console.log('\n' + (failures ? failures + ' failed' : 'all ok'));
process.exit(failures ? 1 : 0);
