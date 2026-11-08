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

   Run:  node www/js/mergetaint.test.mjs
   ============================================================ */
const { makeWindow } = await import('../../dev/syncprobe.mjs');
const { loadPage } = await import('./test/page.mjs');

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
const WANT = ['errandClean', 'daimonApp', 'onChatsChangedElsewhere', 'pg'];
const NOW = 1_000_000_000;
const msgs = [{ role: 'user', content: 'hi', mid: 'u1', ts: 10 }];
const held = () => ({ id: 'dc6', diamondId: 'D6', name: 'D6', updatedAt: 1, metaAt: 1, messages: msgs.slice(), _loaded: true });
/// The store copy another device's turn wrote, tainted or not.
const copy = (tainted) => Object.assign({ id: 'dc6', diamondId: 'D6', name: 'D6', updatedAt: NOW + 50, metaAt: 1,
	messages: msgs.concat([{ role: 'assistant', content: 'NEW web words', mid: 'a2', ts: NOW + 50 }]) },
	tainted ? { taintedAt: NOW + 50 } : {});
/// A page holding the daimon record of D6, with the store a pull reads `stored` from.
function page(stored, fresh) {
	const rec = held();
	const saved = { n: 0 };
	const F = loadPage({ window: makeWindow({ now: NOW }), want: WANT, stub: Object.assign({}, STUB, {
		chats: [rec], persistChats: () => { saved.n++; }, renderHistory() {},
		ChatStore: { refresh: async () => stored.map((c) => Object.assign({}, c)), putTombs: async () => true,
			loadMessages: async () => ({ messages: (fresh || []).map((m) => Object.assign({}, m)) }) },
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

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (!failures) console.log('ALL PASS');
process.exit(failures ? 1 : 0);
