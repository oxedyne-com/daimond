// verify_crystalgap.mjs — a Diamond that LISTS must OPEN.
//
// `list()` admits a Diamond on its metadata alone, deliberately: a Diamond the
// user can see and cannot open is a bug they can report, while one that has
// silently vanished is a bug they can only mourn (src/wasm/diamond.rs). The
// other half of that bargain was missing. `read_crystal_data` was a bare read,
// so a Diamond whose crystal was not beside its metadata threw NotFoundError at
// the panel and could not be opened at all — and four live paths arrive there,
// an interrupted `import_diamond` among them, because the export sorts its
// paths and `.daimond/meta.json` sorts BEFORE `crystal.json`.
//
// The fallback it grew has four legs now that a crystal is data, and the ORDER
// of them is the claim:
//
//   1. `crystal.json`, where it should be;
//   2. the newest `versions/NNNN.json`, the store's own copy of the same bytes;
//   3. a legacy markdown crystal — `crystal.md`, then the newest
//      `versions/NNNN.md` — converted on the way out;
//   4. empty, and said so in the console.
//
// Leg 3 is why a Diamond that predates the migration still opens. It is the leg
// most easily lost in a refactor, because everything above it works without it
// right up until somebody restores a two-year-old backup.
//
// What is pinned:
//   * a Diamond with metadata and no crystal lists AND opens, empty;
//   * where a version snapshot survives, opening finds the NEWEST one — the
//     store's own redundancy, which nothing else ever read back;
//   * data beats markdown wherever both survive, whatever their numbers say;
//   * a crystal that is still markdown opens as data, converted;
//   * an import that fails part way leaves the Diamond invisible rather than
//     listed and broken, because the metadata is written LAST whatever order it
//     arrived in;
//   * a whole import still lands, which is what stops the fix above from being
//     "never write the metadata".
//
// Run with dev/serve.mjs (DAIMOND_PORT, default 8777) up. No gateway, no hand, no mock
// model.
//
//	node dev/verify_crystalgap.mjs
//
// Every check here has been proved against BROKEN code: revert
// `read_crystal_data` to a bare read and the first two go red; drop its legacy
// leg and the markdown ones do; revert the metadata-last sort in
// `import_diamond` and the import one does.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'crystalgap', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__d = {
		mod,
		app:  new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
		root: await navigator.storage.getDirectory(),
	};
	// Seeded through the directory handle, not through the store: the state
	// under test is one the store's own writers cannot produce on purpose.
	window.__put = async (path, body) => {
		let cur = __d.root;
		const parts = path.split('/');
		for (let i = 0; i < parts.length - 1; i++) {
			cur = await cur.getDirectoryHandle(parts[i], { create: true });
		}
		const fh = await cur.getFileHandle(parts[parts.length - 1], { create: true });
		const w = await fh.createWritable();
		await w.write(body);
		await w.close();
	};
	window.__meta = (name) => JSON.stringify(
		{ name: name, crystal_version: 0, updated: 1, touched: 1 });
});

const listed  = () => p.evaluate(async () => JSON.parse(await __d.app.list_diamonds()).map(d => d.id));
const opens   = (id) => p.evaluate(async (x) =>
	__d.app.read_crystal_data(x).then((t) => ({ text: t })).catch((e) => ({ err: String(e) })), id);

/// A crystal as the data file holds one, and the same words as the markdown a
/// legacy Diamond holds. The conversion is asserted between the two, so both
/// forms of every fixture below are written from one place.
const json = (title) => JSON.stringify({ title: title });

// ── A Diamond whose crystal is not there ────────────────────────────────

const GAP = 'ba5eba11ca11';
await p.evaluate(async (id) => {
	await __put('diamonds/' + id + '/.daimond/meta.json', __meta('Metadata and nothing else'));
}, GAP);

const gapRows = await listed();
check('a Diamond with metadata and no crystal is still on the rail',
	gapRows.includes(GAP), gapRows.join(' '));
const gapOpen = await opens(GAP);
check('and it OPENS rather than throwing, which is the other half of that bargain',
	gapOpen.err === undefined && gapOpen.text === '', JSON.stringify(gapOpen));

// ── ...but its versions are the store's own redundancy ──────────────────

const VER = 'c0deca11ab1e';
await p.evaluate(async (arg) => {
	await __put('diamonds/' + arg.id + '/.daimond/meta.json', __meta('Crystal lost, versions kept'));
	await __put('diamonds/' + arg.id + '/versions/0001.json', arg.first);
	await __put('diamonds/' + arg.id + '/versions/0009.json', arg.last);
	await __put('diamonds/' + arg.id + '/versions/0002.json', arg.middle);
	// A markdown snapshot NUMBERED ABOVE every one of them. The order of the legs
	// is the claim, not the numbers: data is preferred wherever any data survives,
	// and a walk that took the highest number whatever its extension would hand
	// back the markdown here and look entirely reasonable doing it.
	await __put('diamonds/' + arg.id + '/versions/0011.md', '# a newer markdown one\n');
}, { id: VER, first: json('the first crystal'), last: json('the crystal as it was last left'),
	middle: json('a middle one') });

const verOpen = await opens(VER);
check('a lost crystal is read back from the NEWEST version snapshot',
	verOpen.text === json('the crystal as it was last left'), JSON.stringify(verOpen));
check('and data wins over markdown even where the markdown is numbered higher',
	!/a newer markdown one/.test(verOpen.text || ''), JSON.stringify(verOpen).slice(0, 90));

// ── ...and a Diamond that predates the data entirely ────────────────────
//
// The leg that reaches a workspace older than this whole change. Whether the
// conversion is done by the migration in `list()` or by the read itself, the
// answer is the same data — which is the point: a Diamond that predates the
// migration OPENS, and opens carrying its words.

const OLD = '0lda11eddece';
await p.evaluate(async (id) => {
	await __put('diamonds/' + id + '/.daimond/meta.json', __meta('Written before the migration'));
	await __put('diamonds/' + id + '/crystal.md', '# The old way\n\nWords a user typed years ago.\n');
}, OLD);

const oldOpen = await opens(OLD);
check('a crystal still in markdown opens as data, converted, not empty',
	oldOpen.err === undefined && /Words a user typed years ago/.test(oldOpen.text || '')
		&& oldOpen.text.trim().startsWith('{'),
	JSON.stringify(oldOpen).slice(0, 120));

// The same Diamond with only its HISTORY in markdown, which is what a
// half-finished conversion leaves behind: the file gone, the snapshots not.
const OLDV = '0ldve5510n55';
await p.evaluate(async (id) => {
	await __put('diamonds/' + id + '/.daimond/meta.json', __meta('History only, in markdown'));
	await __put('diamonds/' + id + '/versions/0003.md', '# Older still\n\nAnd these words too.\n');
}, OLDV);

const oldVerOpen = await opens(OLDV);
check('and so does one whose only surviving crystal is a markdown snapshot',
	oldVerOpen.err === undefined && /And these words too/.test(oldVerOpen.text || ''),
	JSON.stringify(oldVerOpen).slice(0, 120));

// ── An import that fails half way ───────────────────────────────────────
//
// `a.md/b.md` cannot be written once `a.md` is a file, so the import fails
// after some of its files are down. What matters is which ones: with the
// metadata written last the Diamond is invisible and the next pull brings the
// whole of it back, and with it written first the Diamond lists, opens, and
// throws — the exact state the checks above are about.

const HALF = 'facefeed1234';
const half = await p.evaluate(async (arg) => {
	// Object key order is insertion order, and this one puts the metadata first
	// on purpose: an export sorts its paths, and that is where `.daimond/` sorts.
	const files = {};
	files['.daimond/meta.json'] = JSON.stringify(
		{ name: 'Arrived half way', crystal_version: 0, updated: 1, touched: 1 });
	files['a.md']      = 'a file';
	files['a.md/b.md'] = 'a file inside a file, which cannot be written';
	files['crystal.json'] = arg.crystal;
	const pack = JSON.stringify({ id: arg.id, touched: 1, files: files });
	const err = await __d.app.import_diamond(pack).then(() => null).catch((e) => String(e));
	return { err };
}, { id: HALF, crystal: json('the crystal that never arrived') });

check('an import that cannot write every file fails out loud',
	!!half.err, JSON.stringify(half.err || '').slice(0, 90));
const halfRows = await listed();
check('and a half-arrived Diamond is invisible, not listed and broken',
	!halfRows.includes(HALF), halfRows.join(' '));

// ── A whole import still lands ──────────────────────────────────────────
//
// The control. Without it, "never write the metadata" would pass everything
// above and break importing outright.

const WHOLE = 'add511feed99';
await p.evaluate(async (arg) => {
	const files = {};
	files['.daimond/meta.json'] = JSON.stringify(
		{ name: 'Arrived whole', crystal_version: 0, updated: 2, touched: 2 });
	files['crystal.json'] = arg.crystal;
	await __d.app.import_diamond(JSON.stringify({ id: arg.id, touched: 2, files: files }));
}, { id: WHOLE, crystal: json('the whole crystal') });

const wholeRows = await listed();
const wholeOpen = await opens(WHOLE);
check('a whole import lists and opens, at the crystal it arrived with',
	wholeRows.includes(WHOLE) && wholeOpen.text === json('the whole crystal'),
	wholeRows.join(' ') + ' | ' + JSON.stringify(wholeOpen));

// A resource the browser could not load is the dev stack, not the page: no
// gateway runs here, so its probes answer 401 or 502 and neither is a throw.
const noise = s.errs.filter((e) =>
	!/favicon|ERR_ABORTED|net::ERR|Failed to load resource/i.test(e));
check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));

await s.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
