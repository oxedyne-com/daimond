/* ============================================================
   Test -- the errand says whether the chat is clean (U4 ERRAND-TAINT).
   ------------------------------------------------------------
   A handed-off turn's errand carries `clean: true` only when its chat has read nothing from
   outside, and never `clean: false`: the runner reads a missing key as tainted, so every doubt
   fails closed. The real `errandClean`, `daimonApp`, `taintDaimon` and `resetDiamondApps` are
   lifted out of daimond.js by source (`dev/syncprobe.mjs` `sliceDaimond`) over an engine stand-in;
   the real peer.js `buildDispatch` and `makeErrand` build the envelope.

   THE PROPERTIES: an untainted chat's errand is clean; after `markRead` (taintDaimon) it is not;
   nor after a reset rebuilds the Diamond's client; nor when only the engine marked the read; an
   ordinary chat whose engine is marked, or was rebuilt under the fence, is not; no engine is not;
   the dispatch door passes the verdict; and the envelope writes the key only for exactly true.

   Run:  node www/js/errandclean.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// ── The engine stand-in ──────────────────────────────────────────────────
class FakeApp {
	constructor(base, key, model) {
		this.model = model; this.busy = false; this.tainted = new Set(); this.prompts = {}; this.folds = 0;
		this.prompt_tokens = 0; this.completion_tokens = 0; this.cached_tokens = 0; this.cost_usd = 0;
	}
	set_instructions() {}
	set_role_prompt(role, text) { this.prompts[role] = text; }
	set_tainted(who) { this.tainted.add(who || ''); }
	is_tainted(who) { return this.tainted.has(who || ''); }
	forget_web_consent() {}
	set_steering() {}
	shutdown() { this.shut = true; }
}
const stub = {
	DaimondApp: FakeApp,
	appCfgFor: (m) => ({ provider: m.provider, model: m.model, baseUrl: 'http://x', apiKey: 'k' }),
	diamondModel: (id) => ({ provider: 'p', model: 'm-' + id }),
	diamondEffort: () => '',
	maxOutFor: () => 1000, SYSTEM_PROMPT: () => 'sys',
	DaimondModels: { noteUse() {} },
	applyRoundLimit() {}, applyLiveness() {}, applyProviderRouting() {}, applySight() {}, applyEffort() {}, applyCrystalCap() {},
	applyFoldSettings() {}, noteAppProv() {}, Notes: { applyTo() {} },
	Instructions: { md: '' }, Prompts: { md: { daimon: '', reducer: '', compactor: '' } },
	recordSpend: () => ({}), updateSpend() {}, cfg: { model: 'starred' }, chatWindow: (s) => s,
	// The daimon's taint also lands on its conversation's record (H3): the store holds none here.
	chats: [], persistChats() {},
};
const win = makeWindow({});
win.DaimondLedger = {};
const F = loadPage({ window: win, want: ['errandClean', 'daimonApp', 'taintDaimon', 'resetDiamondApps'], stub: stub });

// ── An ordinary chat ─────────────────────────────────────────────────────
{
	const chat = { id: 'c1', diamondId: '', app: new FakeApp() };
	check('an untainted chat is clean', F.errandClean(chat, '', chat.app) === true);
	chat.app.set_tainted();			// what markRead does to an ordinary chat's engine
	check('after markRead it is not', F.errandClean(chat, '', chat.app) === false);
	const held = chat.app;
	chat.app = new FakeApp();		// errandFence dropped the engine and built another
	check('an engine rebuilt under the fence does not wash the mark', F.errandClean(chat, '', held) === false);
	check('a chat with no engine to ask is not clean', F.errandClean({ id: 'c2' }, '', null) === false);
	check('an engine that cannot answer is not clean', F.errandClean({ id: 'c3', app: {} }, '', null) === false);
}
// ── A Diamond's chat ─────────────────────────────────────────────────────
{
	const chat = { id: 'd1-chat', diamondId: 'd1', app: F.daimonApp('d1') };
	check('an untainted Diamond chat is clean', F.errandClean(chat, 'd1', chat.app) === true);
	F.taintDaimon('d1');			// what markRead does for a Diamond's record
	check('after markRead for that Diamond it is not', F.errandClean(chat, 'd1', chat.app) === false);
	F.resetDiamondApps();
	chat.app = F.daimonApp('d1');		// a client rebuilt after the taint
	check('a client rebuilt after the taint is still not clean', F.errandClean(chat, 'd1', null) === false);
	const other = { id: 'd2-chat', diamondId: 'd2', app: new FakeApp() };
	check('another Diamond stays clean', F.errandClean(other, 'd2', other.app) === true);
	F.daimonApp('d2').set_tainted('d2');	// the engine's own mark, before the page's set has it
	check('a read only the engine has marked is not clean', F.errandClean(other, 'd2', other.app) === false);
}
// ── The dispatch door passes it, and only as true ────────────────────────
{
	const src = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
	check('dispatchToPeer reads the engine before the fence, then the verdict after',
		/var heldApp = chat && chat\.app;\s*\n\s*var fence = await errandFence\(chat, turnId\);/.test(src)
		&& /clean:\s*errandClean\(chat, cleanDia, heldApp\) \? true : undefined,/.test(src));
}
// ── The envelope: the key only for exactly true ──────────────────────────
{
	const body = readPage(new URL('./peer.js', import.meta.url), 'utf8');
	const pw = { addEventListener() {}, dispatchEvent() { return true; } };
	new Function('window', 'document', 'with (window) {\n' + body + '\n}')(pw, { addEventListener() {} });
	const P = pw.DaimondPeer;
	const chat = { id: 'c9', messages: [{ role: 'user', content: 'go', mid: 't9', ts: 1 }] };
	const sent = (extra) => P.buildDispatch(chat, Object.assign({ turnId: 't9', prompt: 'go', now: 2 }, extra)).errand(0);
	check('a clean dispatch carries clean:true', sent({ clean: true }).clean === true);
	check('a tainted dispatch carries no clean key', !('clean' in sent({})) && !('clean' in sent({ clean: undefined })));
	check('false, a string and a number carry no clean key',
		!('clean' in sent({ clean: false })) && !('clean' in sent({ clean: 'true' })) && !('clean' in sent({ clean: 1 })));
	check('an errand made again from a clean one stays clean', P.makeErrand(sent({ clean: true })).clean === true);
	check('and from a tainted one stays without the key', !('clean' in P.makeErrand(sent({}))));
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exit(1);
