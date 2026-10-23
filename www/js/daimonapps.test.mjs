/* ============================================================
   Test -- one daimon client per Diamond (U1e, U1 ACTOR).
   ------------------------------------------------------------
   A Diamond's daimon conversation runs on `daimonApp(id)`, its own client, and the per-model
   `diamondApp` stays the door for the stateless store calls. The real `daimonApp`, `diamondApp`,
   `buildDiamondClient`, `everyDiamondClient`, `taintDaimon`, `claimDaimon`, `daimonSettled`,
   `trimDaimonApps`, `forgetDiamondWebConsent`, `resetDiamondApps` and `meterDiamondTurn` are lifted
   out of daimond.js by source (`dev/syncprobe.mjs` `sliceDaimond`); the engine is a stand-in that
   records what it is told.

   THE PROPERTIES: a client per Diamond, seeded as the store door is (the two ledger maps, role
   prompts, instructions, fold settings) and again after a reset; each priced at its own model and
   billed only its own spend, across two resets mid-turn as well; a forgotten web consent and a
   fan-out reach every client; taint the ENGINE read survives an eviction and a reset, and reaches
   a client built while the reading turn still ran; a steer's claim is released however it ends; the least recently used idle client past 8 is shut down,
   never a busy or claimed one; and the trim runs again when a turn settles.

   Run:  node www/js/daimonapps.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// ── The engine stand-in ──────────────────────────────────────────────────
let built = [];
class FakeApp {
	constructor(base, key, model) {
		this.model = model; this.calls = []; this.busy = false; this.shut = false;
		this.tainted = new Set(); this.prompts = {}; this.instructions = null; this.folds = 0;
		this.prompt_tokens = 0; this.completion_tokens = 0; this.cached_tokens = 0; this.cost_usd = 0;
		built.push(this);
	}
	set_instructions(md) { this.instructions = md; }
	set_role_prompt(role, text) { this.prompts[role] = text; }
	set_tainted(who) { this.tainted.add(who || ''); }
	is_tainted(who) { return this.tainted.has(who || ''); }
	forget_web_consent(who) { this.calls.push('forget:' + who); }
	set_steering() {}
	shutdown() { this.shut = true; }
}

// ── The page around the lifted code ──────────────────────────────────────
const models = { d1: 'm-a', d2: 'm-a', d3: 'm-b' };
const spent = [];
const Prompts = { md: { daimon: 'DAIMON v1', reducer: 'REDUCER v1', compactor: '' } };
const Instructions = { md: 'HOUSE RULES v1' };
const stub = {
	DaimondApp: FakeApp,
	appCfgFor: (m) => ({ provider: m.provider, model: m.model, baseUrl: 'http://x', apiKey: 'k' }),
	diamondModel: (id) => ({ provider: 'p-' + (models[id] || 'm-z'), model: models[id] || 'm-z' }),
	diamondEffort: () => '',
	maxOutFor: () => 1000, SYSTEM_PROMPT: () => 'sys',
	DaimondModels: { noteUse() {} },
	applyRoundLimit() {}, applyLiveness() {}, applyProviderRouting() {}, applySight() {}, applyEffort() {}, applyCrystalCap() {},
	applyFoldSettings: (app) => { if (app) app.folds++; },
	noteAppProv() {}, Notes: { applyTo() {} }, Instructions, Prompts,
	recordSpend: (model, p, c, ca, cost, prov, dia) => { spent.push({ model, p, c, cost, prov, dia }); return {}; },
	updateSpend() {}, cfg: { model: 'starred' }, chatWindow: (s) => s,
};
const win = makeWindow({});
win.DaimondLedger = {};
// `runSteer` is lifted on its own: its body, `runSteerHeld`, is a stand-in that claims as the real
// one does and then does whatever `steerBody` says.
let steerBody = async () => '';
stub.runSteerHeld = async (f, p, d, det, how, held) => {
	held.app = F.claimDaimon(F.daimonApp(f.id));
	return steerBody(held);
};
const F = sliceDaimond(win, ['daimonApp', 'diamondApp', 'everyDiamondClient', 'taintDaimon', 'claimDaimon',
	'daimonSettled', 'trimDaimonApps', 'forgetDiamondWebConsent', 'resetDiamondApps', 'meterDiamondTurn',
	'daimonBusy', 'runSteer'], stub).fns;
const all = () => { const out = []; F.everyDiamondClient((a) => out.push(a)); return out; };
const daimons = () => { const doors = [F.diamondApp('d1'), F.diamondApp('d3')]; return all().filter((a) => !doors.includes(a)); };

// ── A client per Diamond, seeded as the store door is ────────────────────
{
	const a1 = F.daimonApp('d1'), a2 = F.daimonApp('d2'), door = F.diamondApp('d1');
	check('two Diamonds on one model get two clients', a1 !== a2);
	check('one Diamond gets the same client again', F.daimonApp('d1') === a1);
	check('a daimon client is not the store door', a1 !== door);
	check('the role prompts are told at build', a1.prompts.daimon === 'DAIMON v1' && a1.prompts.reducer === 'REDUCER v1', JSON.stringify(a1.prompts));
	check('the instructions are told at build', a1.instructions === 'HOUSE RULES v1');
	check('the fold settings are applied at build', a1.folds === 1, String(a1.folds));
}
// ── Priced at its own model, billed only its own spend ───────────────────
{
	spent.length = 0;
	const a1 = F.daimonApp('d1'), a2 = F.daimonApp('d2'), b = F.daimonApp('d3');
	a1.prompt_tokens = 100; a1.completion_tokens = 50; a1.cost_usd = 0.01;
	a2.prompt_tokens = 300; a2.completion_tokens = 70; a2.cost_usd = 0.03;
	b.prompt_tokens = 10; b.completion_tokens = 5; b.cost_usd = 0.5;
	F.meterDiamondTurn(a1, 'd1'); F.meterDiamondTurn(a2, 'd2'); F.meterDiamondTurn(b, 'd3');
	check('two Diamonds on one model are billed their own spend', spent.length === 3
		&& spent[0].p === 100 && spent[0].cost === 0.01 && spent[1].p === 300 && spent[1].cost === 0.03, JSON.stringify(spent));
	check('each is priced at its own model and provider, not the starred one',
		spent[0].model === 'm-a' && spent[0].prov === 'p-m-a' && spent[2].model === 'm-b' && spent[2].prov === 'p-m-b', JSON.stringify(spent));
	a1.prompt_tokens = 160; a1.completion_tokens = 60; a1.cost_usd = 0.02;
	F.meterDiamondTurn(a1, 'd1');
	check('the next reading bills only the growth', spent[3] && spent[3].p === 60 && spent[3].c === 10, JSON.stringify(spent[3]));
}
// ── The fan-out and a forgotten consent reach every client ───────────────
{
	F.diamondApp('d3');
	const every = all();
	check('every client is the store doors and the daimon clients both',
		every.includes(F.daimonApp('d1')) && every.includes(F.daimonApp('d3')) && every.includes(F.diamondApp('d3')), String(every.length));
	F.forgetDiamondWebConsent('d1');
	check('forgetting a web consent reaches every daimon client', daimons().every((a) => a.calls.includes('forget:d1')));
	check('and every store door', F.diamondApp('d1').calls.includes('forget:d1') && F.diamondApp('d3').calls.includes('forget:d1'));
	// What `Prompts.refresh`, `Instructions.refresh`, `Notes.reapply` and the fold settings do with it.
	const src = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
	const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
	check('no fan-out loops over the store doors alone (only everyDiamondClient walks them)',
		(code.match(/Object\.keys\(_diamondApps\)/g) || []).length === 1);
	check('the instructions, prompts, notes, consent and fold-settings fan-outs go through both caches',
		(code.match(/\beveryDiamondClient\(/g) || []).length >= 6, String((code.match(/\beveryDiamondClient\(/g) || []).length));
}
// ── After a reset: built again, told again, still tainted ────────────────
{
	const was = F.daimonApp('d1');
	// A REAL READ: the engine marks its own client (`wrap_untrusted`), and nothing else is told.
	// Never `taintDaimon`, the verifier's door, which also writes the page's set.
	was.set_tainted('d1');
	check('taint goes on the Diamond\'s client', was.is_tainted('d1'));
	Prompts.md.daimon = 'DAIMON v2';
	F.resetDiamondApps();
	const now = F.daimonApp('d1');
	check('a reset builds the client again', now !== was);
	check('and the idle one it dropped is shut down', was.shut === true);
	check('a client rebuilt after a reset is told the role prompts', now.prompts.daimon === 'DAIMON v2', JSON.stringify(now.prompts));
	check('taint is re-applied after a reset', now.is_tainted('d1'));
	check('and only to its own Diamond', !F.daimonApp('d2').is_tainted('d2'));
}
// ── Eviction: LRU-8 idle, never a busy or claimed one ────────────────────
{
	F.resetDiamondApps();
	const first = F.daimonApp('d2');
	first.set_tainted('d2');			// a real read, on the engine alone
	for (let i = 0; i < 9; i++) F.daimonApp('e' + i);
	check('the least recently used idle client past 8 is shut down', first.shut === true);
	check('eight idle clients stay', all().length === 8, String(all().length));
	const again = F.daimonApp('d2');
	check('an evicted Diamond is built again', again !== first);
	check('taint read by the engine is re-applied after eviction', again.is_tainted('d2'));

	F.resetDiamondApps();
	const steer = F.daimonApp('d1');
	steer.busy = true;					// a steer in flight: the engine counts its child
	for (let i = 0; i < 9; i++) F.daimonApp('s' + i);
	check('a steer in flight on the LRU client survives a 9th Diamond\'s build', steer.shut === false && F.daimonApp('d1') === steer);

	F.resetDiamondApps();
	const held = F.claimDaimon(F.daimonApp('d1'));	// handed to a turn, not yet sent
	for (let i = 0; i < 9; i++) F.daimonApp('c' + i);
	check('a claimed client is not evicted before the engine counts it busy', held.shut === false);
	// Built and not evicted: no store door has been built since the reset, so these are daimon clients.
	const kept = () => all().length;
	check('so nine are kept while it is held: eight idle and the claimed one', kept() === 9, String(kept()));
	F.daimonSettled(held);
	check('the trim runs on settle: the idle count returns to 8', kept() === 8 && held.shut === true, String(kept()) + ' shut=' + held.shut);
}
// ── A reset leaves a busy client to finish ───────────────────────────────
{
	F.resetDiamondApps();
	const run = F.daimonApp('d1');
	run.busy = true;
	F.resetDiamondApps();
	check('a reset does not shut a client with a turn in flight', run.shut === false);
	check('and does not hand it out again', F.daimonApp('d1') !== run);
}
// ── Taint read mid-turn on a client a reset left draining ────────────────
{
	F.resetDiamondApps();
	models.t1 = 'm-t';
	const run = F.claimDaimon(F.daimonApp('t1'));
	run.busy = true;
	F.resetDiamondApps();
	const next = F.daimonApp('t1');			// built while the old turn still runs
	run.set_tainted('t1');				// the running turn reads a stranger's mail
	run.busy = false;
	F.daimonSettled(run);
	check('taint read on a draining client reaches the client built since', next.is_tainted('t1'));
	check('and every client built for it later', (F.resetDiamondApps(), F.daimonApp('t1').is_tainted('t1')));
}
// ── Two resets during one running turn: billed once, at its own model ─────
{
	F.resetDiamondApps();
	const a = F.daimonApp('d3');
	a.prompt_tokens = 1000; a.completion_tokens = 100; a.cost_usd = 1;
	F.meterDiamondTurn(a, 'd3');			// the earlier turn, billed: baseline 1000/100
	spent.length = 0;
	F.claimDaimon(a); a.busy = true;		// a long steer is running
	F.resetDiamondApps();				// a settings change
	F.resetDiamondApps();				// and another, the same turn still running
	check('a client left draining by two resets is not shut down', a.shut === false);
	a.prompt_tokens = 1200; a.completion_tokens = 120; a.cost_usd = 1.2; a.busy = false;
	F.meterDiamondTurn(a, 'd3');
	const b = spent[0] || {};
	check('two resets mid-turn bill only the turn (200/20)', b.p === 200 && b.c === 20, JSON.stringify(b));
	check('at its own model and provider, not the starred one', b.model === 'm-b' && b.prov === 'p-m-b', JSON.stringify(b));
	F.daimonSettled(a);
	check('a draining client is shut down when its turn settles', a.shut === true);
	F.resetDiamondApps();
	check('and a reset after that carries nothing of it', a.shut === true);
}
// ── A steer that throws before its own try still releases its claim ───────
{
	F.resetDiamondApps();
	models.k1 = 'm-k';
	let app = null;
	steerBody = async (held) => { app = held.app; throw new Error('setup threw'); };
	let threw = false;
	try { await F.runSteer({ id: 'k1' }, 'go'); } catch (e) { threw = true; }
	check('the throw still reaches the caller', threw);
	check('a steer that threw before its try leaves no claim', !!app && F.daimonBusy(app) === false);
	steerBody = async (held) => { app = held.app; F.daimonSettled(held.app); held.settled = true; return 'ok'; };
	const out = await F.runSteer({ id: 'k1' }, 'go');
	check('a steer that settled itself is not settled twice', out === 'ok' && F.daimonBusy(app) === false);
	// The claim count must not have gone negative and swallowed a later one.
	F.claimDaimon(app);
	check('and a later claim on it still holds', F.daimonBusy(app) === true);
	F.daimonSettled(app);
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' daimonapps checks FAILED' : 'all ' + checks + ' daimonapps checks passed'));
process.exit(failures ? 1 : 0);
