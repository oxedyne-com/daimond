/* ============================================================
   Test — a copy older by `touched` still gives this device the name set later
   on its device (U96-SYNCRACE, UNBLOCK-96).
   ------------------------------------------------------------
   THE BUG. Device A renamed diamond X; device B wrote to X 370 ms later, before
   it had pulled the rename. B's copy was then the fresher by `touched`, and
   `applyDiamonds` drops a strictly older arrival unread, so A's copy, and the
   name in it, never reached B until B pushed and A pulled and pushed again: in
   the arm, B kept the old name through 90 s of A pushing and B pulling.
   THE FIX. Each copy in a parcel carries the stamps of the fields a person sets
   (`set: { name, tags }`); an older arrival that set either later than here is
   fetched and joined (`union_logs`), and the join takes those fields by their
   stamps, with the other device's History rows.
   WHAT IS CHECKED, with the real `applyDiamonds` lifted: an older copy with a
   later name is joined once; an older copy that set nothing later is not
   fetched; an older copy from a build that sends no stamps is not fetched; and
   the real `collectDiamonds` sends the stamps with each copy.
   Run:  node www/js/u96syncrace.test.mjs
   ============================================================ */
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const T = 1_790_000_000_000;

// B's own record of X: renamed long ago (name_at 100), worked on just now (touched 600).
function device() {
	const w = makeWindow({ now: T });
	let fetches = 0;
	const joins = [];
	w.DaimondChunks = { materialiseBytes: async () => { fetches++; return new TextEncoder().encode('{"id":"d","files":{}}'); } };
	w.DaimondCloud = { contentGet: () => ({ key: 'mine' }) };
	const app = {
		list_diamonds: async () => JSON.stringify([{ id: 'd', name: 'Fred Hoogland', updated: 600, touched: 600, tags: [],
			name_at: 100, tags_at: 0, provisional: false }]),
		union_logs: async (id) => { joins.push(id); return JSON.stringify({ files: 0, here: 0, arriving: 1 }); },
	};
	const stubs = {
		ChatStore: { putTombs: () => Promise.resolve(true) }, diamondApp: () => app, trail: () => {}, heapNote: () => '',
		notePeerRef: () => {}, bumpDiamonds: () => {}, onDiamondsChangedElsewhere: async () => {}, signalLinksChanged: () => {},
		setDiamondModel: () => {}, adoptDiamondModel: () => false, renderEffortStep: () => {}, storageAlarm: () => {},
		tOr: (k, x) => x, mergeTombMap: (k, t) => Object.assign({}, t || {}),
		unionDiamondTags: async () => false, unionDiamondLinks: async () => false,
		diamondAdoptsRef: () => false, diamondManifest: () => null,
		holdDiamond: async (id, fn) => fn(), noteLogsHeld: () => {},
	};
	const f = loadPage({ window: w, want: ['applyDiamonds', 'diamondData'], stub: stubs });
	return {
		get fetches() { return fetches; },
		joins,
		pull: (entry) => f.applyDiamonds({ diamonds: [Object.assign({ id: 'd', touched: 500, dataRef: { key: 'theirs', chunks: ['c1'] } }, entry)] }, 'peer'),
	};
}

// ── 1. The race: A renamed at 550, B worked at 600 ─────────────────
{
	const D = device();
	await D.pull({ set: { name: 550, tags: 0 } });
	check('an older copy with a name set later there is fetched', D.fetches === 1, 'fetches=' + D.fetches);
	check('and joined, so the name is taken by its stamp', D.joins.length === 1 && D.joins[0] === 'd', JSON.stringify(D.joins));
}

// ── 2. An older copy that set nothing later: left unread ───────────
{
	const D = device();
	await D.pull({ set: { name: 100, tags: 0 } });
	check('an older copy that set nothing later is not fetched', D.fetches === 0 && D.joins.length === 0, 'fetches=' + D.fetches);
}

// ── 3. A sender that sends no stamps: as before ────────────────────
{
	const D = device();
	await D.pull({});
	check('an older copy from a build without the stamps is not fetched', D.fetches === 0 && D.joins.length === 0, 'fetches=' + D.fetches);
}

// ── 4. The sender: each copy names when its name and tags were set ──
{
	const w = makeWindow({ now: T });
	const d = { id: 'd', name: 'Hoogland stories', updated: 550, touched: 550, tags: [], name_at: 550, tags_at: 7 };
	const app = { export_diamond: async () => JSON.stringify({ id: 'd', touched: 550, files: {} }) };
	const f = loadPage({ window: w, want: ['collectDiamonds'], stub: { diamondApp: () => app, trail: () => {} } });
	const out = await f.collectDiamonds(1 << 20, { ok: true, held: [d], sizes: [64], models: {}, canOffload: false, refReserve: 0 });
	const e = (out.list || [])[0] || {};
	check('the copy sent carries when its name and tags were set', !!e.set && e.set.name === 550 && e.set.tags === 7, JSON.stringify(e.set));
}

if (failures) { console.log('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nall passed');
