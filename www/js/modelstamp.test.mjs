/* ============================================================
   Test: a Diamond's model-and-Effort record syncs on its own stamp
   (COMPOSER-ROW check_f1 B1, B2).

   A press of the Effort step used to touch the whole Diamond, so it won a
   whole-Diamond last-writer-wins race and put another device's crystal edit
   off the head. The record now carries `at`; `applyDiamonds` adopts the
   arriving record by it on every round, and a cleared record is kept as a
   tombstone (`effort: ''`, stamped) rather than deleted. The models (`at`)
   and the Effort (`eat`) are stamped apart, so a press does not revert a
   model changed elsewhere.

   The real `setDiamondModel`, `mergeDiamondModel` and `adoptDiamondModel` are
   lifted from daimond.js over an in-memory localStorage.

     MERGE    a newer half wins, an equal or older one does not; absent never
              clears; unstamped never beats stamped; neither stamped: only a
              newer Diamond being imported, and only a record that says
              something; the two halves merge apart.
     SET      a local change stamps the half it moved; a restatement keeps
              the stamps; a clearing leaves a stamped tombstone; a given
              stamp is kept.
     ADOPT    a tombstone travels and clears a level; a model change made on
              another device and a press here before it arrived both survive,
              in either order of arrival.

   Run:  node www/js/modelstamp.test.mjs
         DAIMOND_JS=<tree>/www/js/daimond.js node www/js/modelstamp.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = process.env.DAIMOND_JS || join(HERE, 'daimond.js');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const src = readPage(SRC, 'utf8');

function extractFn(name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	let depth = 0, i = src.indexOf('{', start + 1);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const store = {};
const localStorage = {
	getItem: (k) => (k in store ? store[k] : null),
	setItem: (k, v) => { store[k] = String(v); },
};
const KEY = 'daimond-diamond-models';
const readJson = (k, d) => { try { return JSON.parse(store[k]); } catch (e) { return d; } };
let clock = 1000;
const DateStub = { now: () => clock };

// The real stamp rule (stamp.js) on this clock: a local write is `max(now, prev + 1)`.
const stampWin = {};
new Function('window', 'Date', readPage(join(dirname(SRC), 'stamp.js'), 'utf8'))(stampWin, DateStub);

const lib = new Function('localStorage', 'readJson', 'Date', 'Notes', 'DaimondStamp',
	"var DIAMOND_MODELS_KEY = '" + KEY + "';\n" +
	src.match(/\n\tvar DIAMOND_MODEL_HALF[^\n]*\n/)[0] + src.match(/\n\tvar DIAMOND_EFFORT_HALF[^\n]*\n/)[0] +
	['diamondModels', 'setDiamondModel', 'blankDiamondModel', 'mergeDiamondModel', 'adoptDiamondModel'].map(extractFn).join('\n') +
	'\nreturn { diamondModels, setDiamondModel, mergeDiamondModel, adoptDiamondModel };'
)(localStorage, readJson, DateStub, undefined, stampWin.DaimondStamp);
const rec = (id) => lib.diamondModels()[id];
const reset = () => { delete store[KEY]; };

// ── MERGE ───────────────────────────────────────────────────────
const M = lib.mergeDiamondModel;
const eff = (r) => r && r.effort;
check('MERGE a newer Effort wins',             eff(M({ effort: 'low', eat: 5 }, { effort: 'high', eat: 6 }, false)) === 'high');
check('MERGE an equal stamp keeps here',       M({ effort: 'low', eat: 6 }, { effort: 'high', eat: 6 }, true) === null);
check('MERGE an older one keeps here, importing too', M({ effort: 'low', eat: 7 }, { effort: 'high', eat: 6 }, true) === null);
check('MERGE an absent record never clears',   M({ effort: 'low', eat: 7 }, null, true) === null);
check('MERGE unstamped never beats stamped',   M({ effort: 'low', eat: 7 }, { effort: 'high' }, true) === null);
check('MERGE a stamped tombstone beats unstamped', eff(M({ effort: 'low' }, { effort: '', eat: 1 }, false)) === '');
check('MERGE neither stamped: an equal round keeps here (B2)', M({ effort: 'low' }, { model: 'm' }, false) === null);
check('MERGE neither stamped: an import adopts what says something', (M(undefined, { model: 'm' }, true) || {}).model === 'm');
check('MERGE neither stamped: an import of nothing does not clear (B2)', M({ effort: 'low' }, { effort: '' }, true) === null);
// An old build's record has no stamps; the rule for that is per half (check_b1 should 1).
const legacy = M({ effort: 'high', eat: 5 }, { provider: 'p', model: 'Y', effort: '' }, true);
check('MERGE neither stamped in the model half: an import adopts its model, keeps the stamped Effort',
	legacy && legacy.model === 'Y' && legacy.effort === 'high' && legacy.eat === 5, legacy);
check('MERGE neither stamped in the model half: an equal round keeps here',
	M({ effort: 'high', eat: 5 }, { provider: 'p', model: 'Y' }, false) === null);
check('MERGE neither stamped in the model half: an import of no model keeps here',
	M({ effort: 'high', eat: 5 }, { effort: 'low' }, true) === null);
const both = M({ model: 'old', effort: 'high', effortModel: 'old', at: 1, eat: 30 },
	{ model: 'new', effort: '', at: 20, eat: 2 }, false);
check('MERGE the halves merge apart: their model, this Effort',
	both && both.model === 'new' && both.effort === 'high' && both.at === 20 && both.eat === 30, both);

// ── SET ─────────────────────────────────────────────────────────
reset(); clock = 1000;
lib.setDiamondModel('d', { effort: 'high', effortProvider: 'p', effortModel: 'm' });
check('SET an Effort change stamps eat now', rec('d') && rec('d').eat === 1000 && rec('d').effort === 'high' && !rec('d').at, rec('d'));
clock = 1500;
lib.setDiamondModel('d', { provider: 'p', model: 'x' });
check('SET a model change stamps at only', rec('d').at === 1500 && rec('d').eat === 1000, rec('d'));
clock = 2000;
lib.setDiamondModel('d', { effort: 'high', model: 'x' });
check('SET a restatement keeps the stamps', rec('d').at === 1500 && rec('d').eat === 1000, rec('d'));
reset(); clock = 1000;
lib.setDiamondModel('d', { effort: 'high' });
clock = 3000;
lib.setDiamondModel('d', { effort: '' });
check('SET a clearing leaves a stamped tombstone', rec('d') && rec('d').effort === '' && rec('d').model === '' && rec('d').eat === 3000, rec('d'));
clock = 4000;
lib.setDiamondModel('d', { effort: '' });
check('SET clearing a tombstone again moves nothing', rec('d').eat === 3000, rec('d'));
lib.setDiamondModel('e', { effort: '' });
check('SET no record and nothing to say writes none', rec('e') === undefined);
lib.setDiamondModel('d', { effort: 'low' }, 3000);
check('SET a given stamp is kept', rec('d').eat === 3000 && rec('d').effort === 'low', rec('d'));
reset(); clock = 1000;
lib.setDiamondModel('d', { effort: 'high' });
lib.setDiamondModel('d', { workerProvider: 'p', workerModel: 'W', visionProvider: 'p', visionModel: 'V' });
clock = 5000;
lib.setDiamondModel('d', { effort: '' });
check('SET clearing the Effort keeps the worker and vision models (check_b1 should 2)',
	rec('d').effort === '' && rec('d').workerModel === 'W' && rec('d').visionModel === 'V' && rec('d').wat === 1000 && rec('d').vat === 1000 && rec('d').dat === 0 && rec('d').at === 1000 && rec('d').eat === 5000, rec('d'));	// each pick on its own stamp (U1a), `at` the latest (S)
reset(); clock = 1000;
lib.setDiamondModel('d', { effort: 'high' });
clock = 900;																	// this clock is behind the stamp it replaces
lib.setDiamondModel('d', { effort: 'low' });
check('SET a stamp outranks the one it replaces, whatever the clock (check_b1 must)', rec('d').eat === 1001, rec('d'));

// ── ADOPT ───────────────────────────────────────────────────────
reset(); clock = 1000;
lib.setDiamondModel('d', { effort: 'high', effortProvider: 'p', effortModel: 'm' });	// here, at 1000
check('ADOPT a tombstone travels and clears', lib.adoptDiamondModel('d', { effort: '', eat: 1500 }, false) === true
	&& rec('d').effort === '' && rec('d').eat === 1500, rec('d'));
check('ADOPT an older record is refused', lib.adoptDiamondModel('d', { effort: 'high', eat: 1200 }, true) === false
	&& rec('d').effort === '', rec('d'));
// B changes the model at 2000; A, not having pulled, presses + at 3000. Each takes the other's.
const onB = { provider: 'p', model: 'B-model', effort: '', at: 2000, eat: 2000 };
clock = 3000;
lib.setDiamondModel('d', { effort: 'high', effortProvider: 'p', effortModel: 'm' });
const onA = JSON.parse(JSON.stringify(rec('d')));
lib.adoptDiamondModel('d', onB, false);
check('ADOPT on A: B\'s model and A\'s level', rec('d').model === 'B-model' && rec('d').effort === 'high', rec('d'));
const aNow = JSON.parse(JSON.stringify(rec('d')));
store[KEY] = JSON.stringify({ d: onB });
lib.adoptDiamondModel('d', onA, false);
check('ADOPT on B: its model survives A\'s press, and takes A\'s level',
	rec('d').model === 'B-model' && rec('d').effort === 'high', rec('d'));
check('ADOPT both devices converge', JSON.stringify(rec('d')) === JSON.stringify(aNow), [rec('d'), aNow]);

console.log('\n' + (checks - failures) + '/' + checks + ' ok');
process.exit(failures ? 1 : 0);
