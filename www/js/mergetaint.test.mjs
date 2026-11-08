/* ============================================================
   mergetaint.test.mjs -- a taint that arrives by a record merge holds the Diamond

   Another device's daimon turn reads the web; its record, stamped `taintedAt`, reaches this page
   by a pull. The adoption (`onChatsChangedElsewhere`) must mark it as a read here would: through
   `taintChat` -> `taintDaimon`, under the Diamond's key on its client, never the client's own key
   (a client's `daimon_of` is '' until it steers, app.rs), and `daimonApp` must put the record's
   taint on every client it hands out, a cached one too. Arms, on the REAL page code over an engine
   stand-in keyed as the engine is:

     M1 -- through the real adoption: a clean held daimon record
           merges a tainted copy; the Diamond's key is marked on its client, so a steer here
           composes under taint.
     M2 -- control: a merge that brings no taint marks nothing.
     M3 -- `daimonApp` hands out a client after a merge, carrying the taint: one cached for
           another model, and one whose record took a stamp by no merge (an errand's seed).
     M4 -- a tainted record new to this page (no held copy) marks the Diamond on a built client.
     M5 -- a pull that does not name the open chat, whose summary holds a taint its held record
           lacks (an earlier adoption threw): the reload pass brings its web words in, so the
           Diamond is marked before the next steer.
     M6 -- control for M5: the same pull over a clean summary marks nothing.
     M7 -- the real store: a transcript read after the summaries carries the taint that the
           write which brought its words in committed beside them; a clean write carries none.
     M8 -- the reload pass over a clean summary, whose transcript read brings web words and
           their taint: the held record and the Diamond are marked before the next steer.
     M9 -- the open path (`loadChatMessages`) joins its read's taint onto the held record.
     M10 -- a record built from a read carries its taint: the backup (`chatsWithTranscripts`) and
            the parcel's inline entry (`collectChatsRefs`).
     M11 -- control for M8-M10: a read that carries no taint marks nothing.
     M12 -- a Diamond with two records (a seeded errand chat beside its own): a mark by Diamond
            stamps both, so after an adoption puts the other first and a reload, the hand-out is
            held.
     M13 -- control for M12: the same reorder and reload with no mark hands out a clean client.
     M14 -- a reload whose store holds the stamp on the second record only (written before this
            page stamped every record): the hand-out reads every record and is held.
     M15 -- keep as a Diamond (K1): a tainted chat kept makes a Diamond held before its transcript
            lands, and its daimon's hand-out is held.
     M16 -- a fold into a Diamond (K2): a tainted chat's fold, and a fold of a worker run that read
            outside content, hold the Diamond before the crystal is written.
     M17 -- the stamped record leaves (E2), over the real ChatStore: a record of a tainted Diamond
            arriving here takes the Diamond's taint; after the stamped one is gone, a reload on a
            fresh device is held, and so is one on this device whose records are all clean.
     M18 -- the Diamond's taint is one-way: a model record from a build that has no taint, or a
            later pick here, keeps it; a taint arriving on the record holds the Diamond and its
            client.
     M19 -- control for M15-M18: a clean keep, fold, arrival and merge mark nothing.
     M20 -- one reader (DT1): a tainted chat kept as, or folded into, a Diamond that has no daimon
            record; the record `daimonChat` makes later, on the same page and after a reload, is
            held by its own thread engine (`ensureApp`) and by a hand-off (`errandClean`) before
            anything calls `daimonApp`. A clean record held beside a stamped Diamond takes the
            stamp at the first question, and a hand-off on a clean engine is held.

   Run:  node www/js/mergetaint.test.mjs
   ============================================================ */
const { makeWindow } = await import('../../dev/syncprobe.mjs');
const { loadPage } = await import('./test/page.mjs');
const { fakeIdb } = await import('./test/fakeidb.mjs');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

/// As the engine's `ToolContext`: a mark or a question with no Diamond named is about the one
/// the client is steering now, '' on a client that has not steered.
class FakeApp {
	constructor() { this.tainted = new Set(); this.steer = ''; }
	set_tainted(who) { this.tainted.add(who || this.steer); }
	is_tainted(who) { return this.tainted.has(who || this.steer); }
	set_instructions() {} set_role_prompt() {} forget_web_consent() {} set_steering() {} shutdown() {}
}
const STUB = {
	DaimondApp: FakeApp,
	appCfgFor: (m) => ({ provider: m.provider, model: m.model, baseUrl: 'http://x', apiKey: 'k' }),
	diamondModel: (id) => ({ provider: 'p', model: 'm-' + id }),
	diamondEffort: () => '', maxOutFor: () => 1000, SYSTEM_PROMPT: () => 'sys',
	DaimondModels: { noteUse() {} },
	applyRoundLimit() {}, applyLiveness() {}, applyProviderRouting() {}, applySight() {}, applyEffort() {},
	applyCrystalCap() {}, applyFoldSettings() {}, noteAppProv() {}, Notes: { applyTo() {} },
	Instructions: { md: '' }, Prompts: { md: { daimon: '', reducer: '', compactor: '' } },
	recordSpend: () => ({}), updateSpend() {}, cfg: { model: 'starred' }, chatWindow: (s) => s,
	DaimondI18n: { t: (k) => k, tn: (k) => k },
};
const WANT = ['errandClean', 'daimonApp', 'onChatsChangedElsewhere', 'pg', 'loadChatMessages', 'chatsWithTranscripts', 'collectChatsRefs', 'taintDaimon'];
const NOW = 1_000_000_000;
const msgs = [{ role: 'user', content: 'hi', mid: 'u1', ts: 10 }];
const held = () => ({ id: 'dc6', diamondId: 'D6', name: 'D6', updatedAt: 1, metaAt: 1, messages: msgs.slice(), _loaded: true });
/// The store copy another device's turn wrote, tainted or not.
const copy = (tainted) => Object.assign({ id: 'dc6', diamondId: 'D6', name: 'D6', updatedAt: NOW + 50, metaAt: 1,
	messages: msgs.concat([{ role: 'assistant', content: 'NEW web words', mid: 'a2', ts: NOW + 50 }]) },
	tainted ? { taintedAt: NOW + 50 } : {});
/// A page holding the daimon record of D6, with the store a pull reads `stored` from.
function page(stored, fresh, freshTaint) {
	const rec = held();
	const saved = { n: 0 };
	const F = loadPage({ window: makeWindow({ now: NOW }), want: WANT, stub: Object.assign({}, STUB, {
		chats: [rec], persistChats: () => { saved.n++; }, renderHistory() {},
		ChatStore: { refresh: async () => stored.map((c) => Object.assign({}, c)), putTombs: async () => true,
			stored: () => stored.map((c) => Object.assign({}, c)), read: () => true, settled: async () => {},
			loadMessages: async () => Object.assign({ messages: (fresh || []).map((m) => Object.assign({}, m)) },
				freshTaint ? { taintedAt: freshTaint } : {}) },
	}) });
	return { F, rec, saved };
}
async function pull(p) {
	try { await p.F.onChatsChangedElsewhere(['dc6']); } catch (e) { console.log('  the pull threw: ' + (e && e.message)); }
	return (p.F.pg.chats || []).find((c) => c.id === 'dc6') || null;
}

console.log('\nM1: a tainted copy merged into a clean held daimon record holds the Diamond\n');
{
	const p = page([copy(true)]);
	const app = p.F.daimonApp('D6');
	p.rec.app = app;
	check('M1. the daimon is clean before the pull', !app.is_tainted('D6') && p.F.errandClean(p.rec, 'D6', app) === true);
	const rec = await pull(p);
	check('M1. the record keeps the merged stamp', !!rec && rec.taintedAt === NOW + 50, rec && rec.taintedAt);
	check('M1. the Diamond\'s key is marked on its client, so a steer here is held', app.is_tainted('D6') === true,
		{ steerSees: app.is_tainted('D6'), ownKey: app.is_tainted() });
	check('M1. the next hand-out carries it', p.F.daimonApp('D6').is_tainted('D6') === true);
	check('M1. its next hand-off is not clean', p.F.errandClean(rec, 'D6', app) === false);
}

console.log('\nM2: control, a merge that brings no taint marks nothing\n');
{
	const p = page([copy(false)]);
	const app = p.F.daimonApp('D6');
	p.rec.app = app;
	const rec = await pull(p);
	check('M2. the record stays unstamped', !!rec && !rec.taintedAt, rec && rec.taintedAt);
	check('M2. no key is marked on the client', app.tainted.size === 0, [...app.tainted]);
	check('M2. its next hand-off is clean', p.F.errandClean(rec, 'D6', app) === true);
}

console.log('\nM3: daimonApp hands out a client after a merge, and the client carries the taint\n');
{
	const p = page([copy(true)]);
	const pick = { provider: 'p2', model: 'm-alt' };
	const alt = p.F.daimonApp('D6', pick);		// cached under another model before the pull
	p.rec.app = p.F.daimonApp('D6');
	await pull(p);
	const got = p.F.daimonApp('D6', pick);
	check('M3. the cached client for another model is the one handed out', got === alt);
	check('M3. it carries the Diamond\'s taint', got.is_tainted('D6') === true, [...got.tainted]);
	// The record is the authority at every hand-out, whatever stamped it: here a stamp put on it
	// directly, as an errand's seeded chat takes its dispatcher's (handoff.js).
	const q = page([]);
	const app = q.F.daimonApp('D6');
	q.rec.taintedAt = NOW + 50;
	check('M3. a record stamped by no merge here still taints the cached client handed out',
		q.F.daimonApp('D6') === app && app.is_tainted('D6') === true, [...app.tainted]);
}

console.log('\nM4: a tainted record new to this page marks the Diamond on a client already built\n');
{
	const p = page([Object.assign(copy(true), { id: 'dc7' })]);
	const app = p.F.daimonApp('D6');
	try { await p.F.onChatsChangedElsewhere(['dc7']); } catch (e) { console.log('  the pull threw: ' + (e && e.message)); }
	const rec = (p.F.pg.chats || []).find((c) => c.id === 'dc7') || null;
	check('M4. the record arrives with its stamp', !!rec && rec.taintedAt === NOW + 50, rec && rec.taintedAt);
	check('M4. the Diamond\'s key is marked on its client', app.is_tainted('D6') === true, [...app.tainted]);
}

/// A page whose open chat is dc6, held clean, and a pull that names only another chat.
async function unnamed(tainted) {
	const c = copy(tainted);
	const p = page([Object.assign({}, c, { messages: undefined, msgCount: c.messages.length })], c.messages);
	const app = p.F.daimonApp('D6');
	p.rec.app = app;
	p.F.pg.current = p.rec;
	try { await p.F.onChatsChangedElsewhere(['dc9']); } catch (e) { console.log('  the pull threw: ' + (e && e.message)); }
	return { p, app, words: p.rec.messages.some((m) => m.content === 'NEW web words') };
}

console.log('\nM5: a pull that does not name the open chat still joins the taint its summary holds\n');
{
	const { p, app, words } = await unnamed(true);
	check('M5. the reload pass brought the web words in', words === true);
	check('M5. the record takes the summary\'s stamp', p.rec.taintedAt === NOW + 50, p.rec.taintedAt);
	check('M5. the Diamond\'s key is marked, so the next steer is held', app.is_tainted('D6') === true, [...app.tainted]);
	check('M5. the next hand-out carries it', p.F.daimonApp('D6').is_tainted('D6') === true);
	check('M5. its next hand-off is not clean', p.F.errandClean(p.rec, 'D6', app) === false);
}

console.log('\nM6: control, the same pull over a clean summary marks nothing\n');
{
	const { p, app, words } = await unnamed(false);
	check('M6. the reload pass brought the words in', words === true);
	check('M6. the record stays unstamped', !p.rec.taintedAt, p.rec.taintedAt);
	check('M6. no key is marked on the client', app.tainted.size === 0, [...app.tainted]);
}

/// A tab running the real ChatStore over the IndexedDB `data`.
function storeTab(data) {
	const w = makeWindow({ now: NOW });
	w.indexedDB = fakeIdb(data, { n: 0, open: 0 }); w.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
	w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
	return loadPage({ window: w, want: ['ChatStore'], stub: { t: (k) => k, tOr: (k, d) => d,
		noteCloudIndexStuck() {}, storageAlarm() {}, storageAlarmClear() {} } }).ChatStore;
}
/// Tab B reads the summaries, then tab A's write lands, then tab B reads the transcript.
async function interleave(tainted) {
	const data = new Map();
	const A = storeTab(data), B = storeTab(data);
	await A.boot();
	A.save([held()]);
	await A.settled();
	await B.boot();
	const sums = await B.refresh();
	A.save([copy(tainted)]);
	await A.settled();
	const got = await B.loadMessages('dc6');
	const sum = (sums || []).find((c) => c.id === 'dc6');
	return { got, sumTaint: sum ? (sum.taintedAt || 0) : -1,
		words: (got.messages || []).some((m) => m.content === 'NEW web words') };
}

console.log('\nM7: the real store, a transcript read after the summaries carries its words\' taint\n');
{
	const r = await interleave(true);
	check('M7. the summaries read was clean', r.sumTaint === 0, r.sumTaint);
	check('M7. the transcript read brought the web words', r.words === true);
	check('M7. the read carries the taint written beside them', r.got.taintedAt === NOW + 50, r.got.taintedAt);
	const c = await interleave(false);
	check('M7. control, a clean write\'s read carries no taint', c.words === true && !c.got.taintedAt, c.got.taintedAt);
}

const clean = () => Object.assign({}, copy(false), { messages: undefined, msgCount: copy(false).messages.length });

console.log('\nM8: the reload pass joins the taint its transcript read carries\n');
{
	const p = page([clean()], copy(true).messages, NOW + 50);
	const app = p.F.daimonApp('D6');
	p.rec.app = app;
	p.F.pg.current = p.rec;
	try { await p.F.onChatsChangedElsewhere(['dc9']); } catch (e) { console.log('  the pull threw: ' + (e && e.message)); }
	check('M8. the reload pass brought the web words in', p.rec.messages.some((m) => m.content === 'NEW web words'));
	check('M8. the record takes the read\'s stamp', p.rec.taintedAt === NOW + 50, p.rec.taintedAt);
	check('M8. the Diamond\'s key is marked, so the next steer is held', app.is_tainted('D6') === true, [...app.tainted]);
	check('M8. its next hand-off is not clean', p.F.errandClean(p.rec, 'D6', app) === false);
}

console.log('\nM9: the open path joins its read\'s taint onto the held record\n');
{
	const p = page([], copy(true).messages, NOW + 50);
	const app = p.F.daimonApp('D6');
	p.rec.app = app;
	p.rec._loaded = false; p.rec.messages = [];
	await p.F.loadChatMessages(p.rec);
	check('M9. the record takes the read\'s stamp', p.rec.taintedAt === NOW + 50, p.rec.taintedAt);
	check('M9. the Diamond\'s key is marked', app.is_tainted('D6') === true, [...app.tainted]);
}

console.log('\nM10: a record built from a read carries its taint\n');
{
	const p = page([], copy(true).messages, NOW + 50);
	const out = await p.F.chatsWithTranscripts([clean()]);
	check('M10. the backup\'s record carries the read\'s stamp', out.length === 1 && out[0].taintedAt === NOW + 50, out[0] && out[0].taintedAt);
	const q = page([clean()], copy(true).messages, NOW + 50);
	const sent = (await q.F.collectChatsRefs(1 << 20)).find((c) => c.id === 'dc6');
	check('M10. the parcel\'s entry carries the read\'s stamp', !!sent && sent.taintedAt === NOW + 50, sent && sent.taintedAt);
}

console.log('\nM11: control, a read with no taint marks nothing\n');
{
	const p = page([clean()], copy(false).messages, 0);
	const app = p.F.daimonApp('D6');
	p.rec.app = app;
	p.rec._loaded = false; p.rec.messages = [];
	await p.F.loadChatMessages(p.rec);
	const out = await p.F.chatsWithTranscripts([clean()]);
	check('M11. the opened record stays unstamped', !p.rec.taintedAt, p.rec.taintedAt);
	check('M11. no key is marked on the client', app.tainted.size === 0, [...app.tainted]);
	check('M11. the backup\'s record stays unstamped', !out[0].taintedAt, out[0].taintedAt);
	const sent = (await page([clean()], copy(false).messages, 0).F.collectChatsRefs(1 << 20)).find((c) => c.id === 'dc6');
	check('M11. the parcel\'s entry stays unstamped', !!sent && !sent.taintedAt, sent && sent.taintedAt);
}

/// A page holding records `recs`, whose store reads back `sums()`, by key order.
function pageOf(recs, sums) {
	return loadPage({ window: makeWindow({ now: NOW }), want: WANT, stub: Object.assign({}, STUB, {
		chats: recs, persistChats() {}, renderHistory() {},
		ChatStore: { refresh: async () => sums(), putTombs: async () => true,
			loadMessages: async () => ({ messages: [] }) },
	}) });
}
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'app' || k[0] === '_') ? undefined : v));
/// Two records of D6 ('dz' its own, 'da' a seeded chat pushed after it), an optional mark by
/// Diamond, an adoption that reads the store's key order, then a reload.
async function twoRecords(mark) {
	const A = Object.assign(held(), { id: 'dz' }), B = Object.assign(copy(false), { id: 'da', _loaded: true });
	const F = pageOf([A, B], () => [strip(B), strip(A)]);
	if (mark) F.taintDaimon('D6', NOW + 50);
	try { await F.onChatsChangedElsewhere(null); } catch (e) { console.log('  the pull threw: ' + (e && e.message)); }
	const first = F.pg.chats.find((c) => c.diamondId === 'D6').id;
	const G = pageOf([strip(B), strip(A)], () => [strip(B), strip(A)]);
	return { A, B, first, app: G.daimonApp('D6') };
}

console.log('\nM12: a mark by Diamond stamps every record of it, and the hand-out reads them all\n');
{
	const r = await twoRecords(true);
	check('M12. the mark stamps both records', r.A.taintedAt === NOW + 50 && r.B.taintedAt === NOW + 50, { A: r.A.taintedAt, B: r.B.taintedAt });
	check('M12. the adoption put the other record first', r.first === 'da', r.first);
	check('M12. after a reload the hand-out is held', r.app.is_tainted('D6') === true, [...r.app.tainted]);
}

console.log('\nM13: control, no mark: the same reorder and reload hands out a clean client\n');
{
	const r = await twoRecords(false);
	check('M13. neither record is stamped', !r.A.taintedAt && !r.B.taintedAt, { A: r.A.taintedAt, B: r.B.taintedAt });
	check('M13. the hand-out is clean', r.app.tainted.size === 0, [...r.app.tainted]);
}

console.log('\nM14: a stamp on the second record only still holds the hand-out\n');
{
	const A = Object.assign(strip(held()), { id: 'dz', taintedAt: NOW + 50 }), B = Object.assign(strip(copy(false)), { id: 'da' });
	const G = pageOf([B, A], () => [strip(B), strip(A)]);
	const app = G.daimonApp('D6');
	check('M14. the hand-out is held', app.is_tainted('D6') === true, [...app.tainted]);
}

const WANT2 = WANT.concat(['keepAsDiamond', 'foldChatInto', 'foldDeltaInto', 'adoptDiamondModel', 'setDiamondModel', 'daimonChat', 'ensureApp']);
/// The Diamond's own taint stamp as its synced model record holds it, 0 for none.
const dtaint = (w, id) => (JSON.parse(w.localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).taintedAt || 0;
const WEB = NOW + 50;
/// A plain chat as the store's mirror holds it, and its transcript with its taint.
const plain = (ta) => Object.assign({ id: 'pc1', name: 'pc1', updatedAt: 1, metaAt: 1 }, ta ? { taintedAt: ta } : {});
/// A page that can keep a chat as a Diamond and fold into one, with `seen` taking the Diamond's
/// own taint at the moment its transcript or crystal is written.
class FoldApp extends FakeApp {
	async read_crystal_data() { return '{}'; }
	async fold_propose() { return 'proposed'; }
}
function foldPage(ta, w) {
	const seen = {};
	w = w || makeWindow({ now: NOW });
	const P = loadPage({ window: w, want: WANT2, stub: Object.assign({}, STUB, {
		chats: [], persistChats() {}, renderHistory() {}, engineFor: () => new FoldApp(),
		Notes: { applyTo() {}, steerFor: () => '' }, Instructions: { md: '', compose: (s) => s },
		DaimondApp: FoldApp,
		ChatStore: { refresh: async () => [], putTombs: async () => true,
			loadMessages: async () => Object.assign({ messages: msgs.slice() }, ta ? { taintedAt: ta } : {}) },
		storedChats: () => [plain(ta)], promptDialog: async () => 'Kept', noticeDialog() {}, toast() {},
		diamondApp: () => ({ create_diamond: async () => 'KD', add_link: async () => {},
			stranger_marks: async () => [], recover_marks: async () => [] }),
		Files: { writeBytes: async (path) => { seen.file = dtaint(w, 'KD'); } },
		signalLinksChanged() {}, clearDiamondFilters() {}, loadDiamonds: async () => {}, selectDiamond: async () => {},
		diamonds: [{ id: 'FD', name: 'FD' }], diamondCanRun: () => true, diamondBusy: () => false,
		setCrystalBusy() {}, setCrystalStatus() {}, foldStageTile: () => ({}), foldLens() {}, foldStageSay() {},
		foldStageFail() {}, foldSettle() {}, showCrystalSpinner() {}, hideCrystalSpinner() {}, showSpinner() {},
		hideSpinner() {}, chatDelta: () => 'the words', meterDiamondTurn() {}, foldEnvelope: () => ({ crystal: 'c' }),
		diamondCrystalVersion: async () => 1, renderDiamondList() {}, removeChat() {}, undoAble() {},
		commitFold: async (id) => { seen.crystal = dtaint(w, id); return { changed: true, version: 2, files: [] }; },
	}) });
	return { P, seen, w };
}
async function keep(ta) {
	const { P, seen } = foldPage(ta);
	let id = '';
	try { id = await P.keepAsDiamond('pc1'); } catch (e) { console.log('  the keep threw: ' + (e && e.message)); }
	return { P, seen, id };
}
async function fold(ta) {
	const { P, seen } = foldPage(ta);
	const chat = Object.assign(plain(ta), { messages: msgs.slice(), _loaded: true });
	try { await P.foldChatInto(chat, 'FD'); } catch (e) { console.log('  the fold threw: ' + (e && e.message)); }
	return { P, seen };
}
async function foldRun(tainted) {
	const { P, seen } = foldPage(0);
	try { await P.foldDeltaInto('FD', 'a report', 'w1', { id: 'r1', tainted: tainted }); }
	catch (e) { console.log('  the fold threw: ' + (e && e.message)); }
	return { P, seen };
}

console.log('\nM15: a tainted chat kept as a Diamond holds the Diamond before its transcript lands\n');
{
	const r = await keep(WEB);
	check('M15. the new Diamond is held when its transcript is written', r.id === 'KD' && r.seen.file === WEB, r.seen);
	check('M15. its daimon\'s hand-out is held', r.P.daimonApp('KD').is_tainted('KD') === true);
}

console.log('\nM16: a fold of outside words into a Diamond holds it before the crystal is written\n');
{
	const r = await fold(WEB);
	check('M16. a tainted chat\'s fold holds the Diamond at commit', r.seen.crystal === WEB, r.seen);
	check('M16. the fold\'s Diamond hands out a held client', r.P.daimonApp('FD').is_tainted('FD') === true);
	const w = await foldRun(true);
	check('M16. a tainted worker\'s fold holds the Diamond at commit', !!w.seen.crystal, w.seen);
}

/// A tab running the real ChatStore with the page's adoption and hand-out, on window `w`.
function storePage(data, w) {
	w.indexedDB = fakeIdb(data, { n: 0, open: 0 }); w.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
	w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
	return loadPage({ window: w, want: WANT2.concat(['ChatStore']), stub: Object.assign({}, STUB, {
		tOr: (k, d) => d, noteCloudIndexStuck() {}, storageAlarm() {}, storageAlarmClear() {}, renderHistory() {} }) });
}
async function bootPage(data, w) {
	const P = storePage(data, w);
	await P.ChatStore.boot();
	P.pg.chats = P.ChatStore.stored().map((c) => Object.assign({}, c));
	return P;
}
const recE = (id) => ({ id, diamondId: 'E', name: 'E', updatedAt: 1, metaAt: 1, messages: msgs.slice() });
/// Diamond E's record dz, marked here when `mark`; then another device's dz leaves the store and
/// a record da of E arrives; this page adopts it.
async function leaves(mark) {
	const data = new Map(), wF = makeWindow({ now: NOW });
	const O = storeTab(data);
	await O.boot(); O.save([recE('dz')]); await O.settled();
	const F = await bootPage(data, wF);
	if (mark) F.taintDaimon('E', WEB);
	await F.ChatStore.settled();
	for (const n of ['chats', 'chatsum']) data.get(n).delete('dz');
	const O2 = storeTab(data);
	await O2.boot(); O2.save([recE('da')]); await O2.settled();
	try { await F.onChatsChangedElsewhere(null); } catch (e) { console.log('  the pull threw: ' + (e && e.message)); }
	await F.ChatStore.settled();
	const R = storeTab(data);
	await R.boot();
	const da = (await R.refresh()).find((c) => c.id === 'da');
	const fresh = await bootPage(data, makeWindow({ now: NOW }));
	const here = await bootPage(data, makeWindow({ now: NOW, ls: wF.localStorage }));
	return { data, wF, da, fresh: fresh.daimonApp('E').is_tainted('E'), here: here.daimonApp('E').is_tainted('E') };
}

console.log('\nM17: the stamped record leaves; the Diamond\'s own taint holds it, over the real store\n');
{
	const r = await leaves(true);
	check('M17. the arriving record takes the Diamond\'s taint, in the store', !!r.da && r.da.taintedAt === WEB, r.da && r.da.taintedAt);
	check('M17. a reload on a fresh device is held', r.fresh === true);
	check('M17. a reload here is held', r.here === true);
	// Every record of E clean, as one stamped by nothing here would be: the Diamond's own stamp holds.
	const H = pageOf([Object.assign(strip(recE('dc')), { _loaded: true })], () => []);
	const H2 = loadPage({ window: makeWindow({ now: NOW, ls: r.wF.localStorage }), want: WANT, stub: Object.assign({}, STUB, {
		chats: [Object.assign(strip(recE('dc')), { _loaded: true })], persistChats() {}, renderHistory() {},
		ChatStore: { refresh: async () => [], putTombs: async () => true, loadMessages: async () => ({ messages: [] }) } }) });
	check('M17. with every record clean, the Diamond\'s own stamp holds the hand-out', H2.daimonApp('E').is_tainted('E') === true
		&& H.daimonApp('E').is_tainted('E') === false);
}

console.log('\nM18: the Diamond\'s taint is one-way, and a taint arriving on its record holds it\n');
{
	const { P, w } = foldPage(0);
	P.taintDaimon('M', WEB);
	P.adoptDiamondModel('M', { provider: 'p', model: 'x', at: NOW + 100, eat: 0 }, false);
	check('M18. an arriving record with no taint keeps the Diamond\'s', dtaint(w, 'M') === WEB, dtaint(w, 'M'));
	P.setDiamondModel('M', { provider: 'p', model: 'y' });
	check('M18. a pick here keeps it', dtaint(w, 'M') === WEB, dtaint(w, 'M'));
	const app = P.daimonApp('N');
	P.adoptDiamondModel('N', { taintedAt: NOW + 60 }, false);
	check('M18. a taint arriving on the record is taken', dtaint(w, 'N') === NOW + 60, dtaint(w, 'N'));
	check('M18. and marks the client already built', app.is_tainted('N') === true, [...app.tainted]);
}

console.log('\nM19: control, a clean keep, fold, arrival and merge mark nothing\n');
{
	const k = await keep(0);
	check('M19. a clean keep leaves the Diamond clean', k.id === 'KD' && k.seen.file === 0 && !k.P.daimonApp('KD').is_tainted('KD'), k.seen);
	const f = await fold(0);
	check('M19. a clean fold leaves the Diamond clean', f.seen.crystal === 0, f.seen);
	const w = await foldRun(false);
	check('M19. a clean worker\'s fold leaves the Diamond clean', w.seen.crystal === 0, w.seen);
	const r = await leaves(false);
	check('M19. a clean arrival stays unstamped, and the reloads are clean', !!r.da && !r.da.taintedAt && !r.fresh && !r.here,
		{ da: r.da && r.da.taintedAt, fresh: r.fresh, here: r.here });
	const { P, w: wm } = foldPage(0);
	P.adoptDiamondModel('M', { provider: 'p', model: 'x', at: NOW + 100, eat: 0 }, false);
	check('M19. a clean merge marks nothing', dtaint(wm, 'M') === 0, dtaint(wm, 'M'));
}

console.log('\nM20: a Diamond\'s taint reaches its daimon record, its thread and its hand-off\n');
/// The readers a Diamond's turn meets, in a reload's order: its thread engine, then a hand-off,
/// with no `daimonApp` call before them.
function readers(P, id) {
	const rec = P.daimonChat({ id });
	let thread;
	try { rec.app = P.ensureApp(rec); thread = !!rec.app.is_tainted(); } catch (e) { thread = 'threw: ' + e.message; }
	return { thread, handoff: !P.errandClean(rec, id, null), rec: rec.taintedAt || 0 };
}
for (const entry of ['keep', 'fold']) {
	const w = makeWindow({ now: NOW });
	const { P } = foldPage(WEB, w);
	let id = '';
	try {
		if (entry === 'keep') id = await P.keepAsDiamond('pc1');
		else { await P.foldChatInto(Object.assign(plain(WEB), { messages: msgs.slice(), _loaded: true }), 'FD'); id = 'FD'; }
	} catch (e) { console.log('  the ' + entry + ' threw: ' + (e && e.message)); }
	const same = readers(P, id);
	check('M20. ' + entry + ': the new daimon record takes the Diamond\'s stamp', same.rec === WEB, same);
	check('M20. ' + entry + ': its thread engine is held on the same page', same.thread === true, same);
	const R = foldPage(WEB, makeWindow({ now: NOW, ls: w.localStorage })).P;
	const re = readers(R, id);
	check('M20. ' + entry + ': after a reload its thread engine is held', re.thread === true, re);
	check('M20. ' + entry + ': after a reload its hand-off is held', re.handoff === true, re);
}
{
	const w = makeWindow({ now: NOW });
	foldPage(0, w).P.taintDaimon('OD', WEB);
	const { P } = foldPage(0, makeWindow({ now: NOW, ls: w.localStorage }));
	const rec = { id: 'od1', diamondId: 'OD', name: 'OD', updatedAt: 1, metaAt: 1, messages: msgs.slice(), app: new FakeApp() };
	P.pg.chats.push(rec);
	const held = !P.errandClean(rec, 'OD', null);
	check('M20. a hand-off on a clean engine of a stamped Diamond is held', held === true, held);
	check('M20. a clean record beside the stamp takes it at the first question', rec.taintedAt === WEB, rec.taintedAt);
}
{
	const { P } = foldPage(0);
	const r = readers(P, 'CD');
	check('M20. control: a clean Diamond\'s record, thread and hand-off stay clean', !r.rec && r.thread === false && !r.handoff, r);
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (!failures) console.log('ALL PASS');
process.exit(failures ? 1 : 0);
