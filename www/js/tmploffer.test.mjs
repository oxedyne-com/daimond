/* ============================================================
   Test -- a template merge is offered only once the merged page is proved to load
   (TMPL2, after the r545 TMPLOFF hotfix).

   r545 offered a forked Life log the template's newer page as a line merge. The owner took
   it and the merged page printed "Could not open the log: ReferenceError: readLanes is not
   defined": where both sides changed the same line the merge kept the person's, which
   still held the old function, while a line only the template changed -- a call to the
   renamed function -- came in. Now the merged page goes through the crystal's load proof
   before the offer is drawn; one that does not pass is refused in words, remembered at
   that version, and the person's page is never written.

   Here the proof's verdict is the real `proofVerdict` from crystal.js, over the text the
   fixture page draws when its script is run; the off-screen frame itself is exercised in
   the browser by dev/verify_crystalupdate.mjs.   `node www/js/tmploffer.test.mjs`
   ============================================================ */
import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Fixture pages: the readLanes shape ─────────────────────────────
const page = (def, call, extra) => [
	'<!doctype html><html><body><div id="app"></div>',
	'<script>',
	'var APP = document.getElementById("app");',
	def,
	'\treturn "lanes";',
	'}',
	'var a = 1;',
	'var b = 2;',
	'var c = 3;',
	'function start() {',
	call,
	'}',
	extra || '// the end',
	'try { APP.textContent = "Log: " + start(); }',
	'catch (e) { APP.textContent = "Could not open the log: " + e; }',
	'</script>',
	'</body></html>',
].join('\n');
const BASE   = page('function readAll() {',           '\treturn readAll();');
// The template renames the function and its call; the person changed the definition line.
const THEIRS = page('function readLanes() {',         '\treturn readLanes();');
const MINE   = page('function readAll() { // mine',   '\treturn readAll();');
// A clean case: the template changes a line the person did not touch.
const CLEAN  = page('function readAll() {',           '\treturn readAll();', '// the end, fixed');
const CLEAN2 = page('function readAll() {',           '\treturn readAll();', '// the end, fixed again');

const win = makeWindow({});
loadScript(win, 'versions.js');
loadScript(win, 'crystal.js');
const verdict = win.DaimondCrystal && win.DaimondCrystal.proofVerdict;
check('crystal.js exposes the load proof verdict', typeof verdict === 'function');

/// The load proof over a fixture page: its script run, the text it draws read, the verdict the crystal's.
let draws = 0;
win.DaimondCrystal.render = async (req) => {
	draws++;
	const app = { textContent: '' };
	const src = (/<script>([\s\S]*?)<\/script>/.exec(String(req.page)) || [])[1] || '';
	const trace = [];
	try { vm.runInNewContext(src, { document: { getElementById: () => app } }); }
	catch (e) { trace.push('error: ' + e.message); }
	const v = verdict({ text: app.textContent, svg: 0, canvas: 0, img: 0, bar: 0, pre: 0, dbg: 0, keymap: 0, dkeys: 0 },
		JSON.parse(req.data || '{}'), 0);
	return { table: '', proof: v.proof, debug: v.debug, trace: trace.join('\n') };
};

let rec = null, stored = MINE, wrote = 0, cdata = '{}';
const reset = (theirs) => {
	rec = { capp: 'lifelog', v: 1, files: { 'crystal.html': sha(BASE) } };
	stored = MINE; wrote = 0; draws = 0; served = theirs;
};
let served = THEIRS;
function el(tag) {
	return { tag, children: [], listeners: {}, hidden: false, className: '', textContent: '', id: '', type: '',
		classList: { add() {}, remove() {} }, firstChild: null, parentNode: null,
		appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); this.firstChild = this.children[0] || null; },
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		setAttribute() {} };
}
win.document = { createElement: el };
const stubs = {
	readCappRecord:  async () => JSON.parse(JSON.stringify(rec)),
	writeCappRecord: async (id, r) => { rec = JSON.parse(JSON.stringify(r)); },
	CAPP_TEMPLATES:  { lifelog: { name: 'Log Life' } },
	cappManifest:    async () => ({ v: 2 }),
	cappFetchFile:   async (spec, path) => path === 'crystal.html' ? served
		: path === 'base/' + sha(BASE) + '.html' ? BASE : null,
	cappHash:        async (s) => sha(String(s)),
	cappReadFile:    async () => stored,
	diamondApp:      () => ({
		read_crystal_data: async () => cdata,
		write_crystal_page: async (id, t) => { stored = t; wrote++; },
	}),
	tOr: (k, d, o) => String(d).replace('{name}', (o && o.name) || ''),
	noticeDialog() {}, friendlyError: (e) => String(e),
	currentDiamond: null, renderCrystal() {},
	// The remount goes through the scheduler since the r545 typing guard; not what this test is about.
	scheduleCrystalRemount() {}, crystalLib: () => null,
};
const names = ['cappMergeOffer', 'cappTakeMerge', 'cappOfferNote', 'cappProveAndShow'];
let fns = null;
try { fns = sliceDaimond(win, names, stubs).fns; }
catch (e) {
	check('the merge is proved before it is offered (cappProveAndShow exists)', false, e.message);
	try { fns = sliceDaimond(win, ['cappMergeOffer', 'cappTakeMerge'], stubs).fns; } catch (e2) { fns = null; }
}

const settle = () => new Promise((r) => setTimeout(r, 20));
if (fns) {
	// ── 1. The readLanes shape: refused, and the page is never written ──
	reset(THEIRS);
	const offer = await fns.cappMergeOffer('d1', MINE);
	check('fixture: the merge keeps the old definition and takes the renamed call',
		!!offer && offer.conflicts.length === 1 && /readAll\(\) \{ \/\/ mine/.test(offer.text) && /return readLanes\(\);/.test(offer.text),
		offer ? offer.conflicts.length + ' conflicts' : 'no merge');
	if (offer && fns.cappProveAndShow) {
		const box = el('div');
		await fns.cappProveAndShow('d1', offer, box);
		check('THE MERGED PAGE THAT DOES NOT LOAD IS REFUSED', offer.proved !== true && draws >= 1, 'proved=' + offer.proved);
		const said = box.children.map((c) => c.textContent).join(' ');
		check('in words, with no Update button', /conflicts with your edits/.test(said) && !box.children.some((c) => /capp-offer-acts/.test(c.className)), said);
		check('and the refusal is remembered at the version offered', rec.refused === 2, JSON.stringify(rec));
		check('so it is not offered again at that version', (await fns.cappMergeOffer('d1', MINE)) === null);
	}
	if (offer) {
		const took = await fns.cappTakeMerge('d1', offer);
		check('UPDATE NEVER WRITES A PAGE THE PROOF HAS NOT PASSED', took === false && wrote === 0 && stored === MINE,
			'took=' + took + ', writes=' + wrote);
		check('and the record\'s base is left where it was', rec.files['crystal.html'] === sha(BASE));
	}

	// ── 2. A clean merge that loads is offered, and Update writes it ──
	if (fns.cappOfferNote) {
		reset(CLEAN);
		const ok = await fns.cappMergeOffer('d1', MINE);
		check('a clean merge is a candidate', !!ok && ok.conflicts.length === 0);
		const note = fns.cappOfferNote('d1', ok);
		check('drawn hidden until proved', note.hidden === true);
		await settle();
		check('A MERGED PAGE THAT LOADS IS OFFERED', ok.proved === true && note.hidden === false, 'proved=' + ok.proved);
		check('with Update and Not now', note.children.some((c) => /capp-offer-acts/.test(c.className)));
		check('Update writes it', (await fns.cappTakeMerge('d1', ok)) === true && wrote === 1 && /the end, fixed/.test(stored));
	}

	// ── 3. The Diamond's summary, which a template page never shows ──
	// The Life log page does not print crystal.json's summary, so its proof says "the summary is
	// not on screen" for the person's page and the merge alike. That weighs the page against the
	// data, not whether it loads: held against the merge only when the person's page is clear of it.
	if (fns.cappOfferNote) {
		const SUM = JSON.stringify({ title: 'Log', summary: 'What I eat, what I do and how I feel, kept by the page.' });
		reset(CLEAN2); cdata = SUM;   // not CLEAN: its proof is remembered from section 2
		const ok = await fns.cappMergeOffer('d1', MINE);
		const note = fns.cappOfferNote('d1', ok);
		await settle();
		check('A CLEAN MERGE IS OFFERED THOUGH NEITHER PAGE SHOWS THE SUMMARY', !!ok && ok.proved === true && note.hidden === false,
			ok ? 'proved=' + ok.proved : 'no merge');
		reset(THEIRS); cdata = SUM;
		const bad = await fns.cappMergeOffer('d1', MINE);
		const box = el('div');
		if (bad) await fns.cappProveAndShow('d1', bad, box);
		check('and the readLanes merge is still refused alongside it', !!bad && bad.proved !== true && rec.refused === 2,
			bad ? 'proved=' + bad.proved : 'no merge');
		cdata = '{}';
	}
}

console.log('\n' + (failures ? failures + ' failed' : 'all ok'));
process.exit(failures ? 1 : 0);
