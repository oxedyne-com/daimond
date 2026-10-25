/* ============================================================
   Test — D-20261018-09 U1c: creation stores no copy; a chat's model merges on its own stamp.
   ------------------------------------------------------------
   Changing the default changed nothing he could see: `newChat` copied the default into the chat,
   `startChat` wrote the resolved pair back, and New Diamond saved its pre-filled picker. Now only
   a deliberate pick is stored (`storedPick`), and `''` follows the default. And the chat's model
   half (model, provider, workers, Effort) merges on its own stamp `mat`, so a model clear on one
   device and a rename on another both survive.

   The REAL functions are lifted from daimond.js and stamp.js (`testlift.mjs`) and run in one
   sandbox per device. Red proof on the live record:

     MM_SRC_REV=14ef947b node www/js/mmcreate.test.mjs     # C1, C2, C5 fail
     node www/js/mmcreate.test.mjs                         # all pass

   C6 compares the merge with 14ef947b's own, lifted by `git show`, so it needs the git history.
   ============================================================ */
import { source, lift } from './testlift.mjs';

const APP   = source('daimond.js');
const STAMP = source('stamp.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const MERGE_FNS = ['withRecent', 'chatOwnsModel', 'slimChat', 'chatFields', 'takeChatMeta', 'chatTurnBeats',
	'chatMetaBeats', 'chatMetaFields', 'chatModelBeats', 'takeChatModel', 'chatMatOf', 'chatMatSplit',
	'mergeFold', 'mergeChatRecords', 'touchChatMeta', 'touchChatModel',
	'chatTaintOf', 'chatTaintJoin',	// the one-way taint (H3)
	'runKeyCmp', 'hereOf', 'nativeBaseWinner', 'nativeJoin', 'deriveNativeTotals'];	// the derived totals (RT-C)
const CREATE_FNS = ['storedPick', 'chatPairInForce', 'newChat', 'startChat', 'createDiamond', 'diamondPickFromChat'];
const VARS = ['FOLDED_RUNS_MAX', 'NATIVE_FIGS', 'HERE_FIELDS', 'TOTAL_FIELDS', 'CHAT_TURN_FIELDS', 'CHAT_META_FIELDS', 'CHAT_NAME_FIELDS', 'CHAT_MODEL_FIELDS', '_chatModelShedSaid'];
const NAMES = MERGE_FNS.concat(CREATE_FNS);

const DEF = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' };
const GLM = { provider: 'openrouter', model: 'z-ai/glm-5.3' };
const FW  = { provider: 'fireworks', model: 'deepseek/deepseek-v4.1-flash' };	// same id, another key

/// One device: the lifted code over its own clock, chat list and model store. Names the
/// revision lacks come back null and are listed in `missing`.
function device(src, name, skew) {
	const L = lift(src, NAMES, VARS);
	const clock = { t: Date.UTC(2026, 9, 18, 9, 0, 0) };
	const RealDate = Date;
	class FakeDate extends RealDate {}
	FakeDate.now = function () { return clock.t + (skew || 0); };
	const providers = { openrouter: 1, fireworks: 1 };
	const window = {
		DaimondModels: {
			getDefault: function () { return { provider: DEF.provider, model: DEF.model }; },
			// The real rule (models.js `resolve`): '' is the default's provider, and its model too
			// when no provider is named.
			resolve: function (p, m) {
				const id = p || DEF.provider;
				const mm = m || (p ? '' : DEF.model);
				if (!providers[id] || !mm) return null;
				return { provider: id, model: mm, baseUrl: 'u', apiKey: 'k' };
			},
			effortAfterSwitch: function (e) { return { effort: e || '', cleared: false }; },
			pick: function (x) { return x; },
		},
	};
	const made = [];
	const env = {
		window: window, Date: FakeDate,
		diag: function () {}, tel: function () {}, persistChats: function () {}, selectChat: function () {},
		renderSessionList: function () {}, isMobile: function () { return false; }, mshow: function () {},
		renderPendingCentre: function () {}, openSettings: function () {}, t: function (k) { return k; },
		slimMessages: function (m) { return m || []; },
		mergeMessages: function (l, r) {
			const seen = new Set(), out = [];
			(l || []).concat(r || []).forEach(function (m) { if (!seen.has(m.mid)) { seen.add(m.mid); out.push(m); } });
			return out;
		},
		newChatId: (function () { let n = 0; return function () { return name + '-chat-' + (++n); }; })(),
		chatInput: { focus: function () {} },
		// createDiamond's surroundings: the dialog answers with `dialogVals`, after its own validate.
		dialogVals: { v: null, said: null },
		setDiamondModel: function (id, pick) { made.push({ id: id, pick: pick }); },
		diamondApp: function () { return { create_diamond: async function () { return 'dia-' + (made.length + 1); } }; },
	};
	const body = STAMP + '\n' + L.body + `
		var DaimondStamp = window.DaimondStamp, DaimondModels = window.DaimondModels;
		var chats = [], current = null, cfg = { model: '' }, diamonds = [];
		async function dialog(o) { dialogVals.said = o.validate ? o.validate(dialogVals.v) : ''; return dialogVals.said ? null : dialogVals.v; }
		function takeDiamondLabel() {} function peekDiamondLabel() { return 'diamond-0001'; }
		function bumpDiamonds() {} function clearDiamondFilters() {} async function loadDiamonds() {}
		function selectDiamond() {} function noticeDialog() {}
		function fn(n) { try { return eval(n); } catch (e) { return null; } }
		var api = { chats: function () { return chats; } };
		${JSON.stringify(NAMES)}.forEach(function (n) { api[n] = fn(n); });
		return api;`;
	const keys = Object.keys(env);
	const api = new Function(...keys, body)(...keys.map((k) => env[k]));
	api.missing = L.missing; api.clock = clock; api.made = made; api.env = env; api.name = name;
	return api;
}

/// Run `f`, turning a ReferenceError for a function the revision lacks into a named failure.
function guarded(name, d, f) {
	try { return f(); }
	catch (e) { check(name, false, 'threw: ' + e.message + (d.missing.length ? '; revision lacks ' + d.missing.join(', ') : '')); return undefined; }
}

const pair = (c) => ({ model: c.model || '', provider: c.provider || '', workerModel: c.workerModel || '', workerProvider: c.workerProvider || '' });
const BLANK = { model: '', provider: '', workerModel: '', workerProvider: '' };

// ── C1, C2: a new chat follows; starting it stores nothing ───────────────────
console.log('C1/C2: newChat and startChat store no copy');
{
	const d = device(APP, 'A');
	const chat = guarded('C1 newChat runs', d, () => { d.newChat(); return d.chats()[0]; });
	if (chat) {
		check('C1 newChat stores \'\' for model, provider and workers', JSON.stringify(pair(chat)) === JSON.stringify(BLANK), pair(chat));
		guarded('C2 startChat runs', d, () => d.startChat(chat));
		check('C2 startChat leaves them \'\'', JSON.stringify(pair(chat)) === JSON.stringify(BLANK), pair(chat));
		check('C2 and the chat is active', chat.status === 'active', chat.status);
	}
}

// ── C3: a pick other than the default is stored; one equal to it is not ──────
console.log('\nC3: only a deliberate pick is stored');
{
	const d = device(APP, 'A');
	guarded('C3 runs', d, () => {
		d.newChat(); const c = d.chats()[0];
		d.startChat(c, GLM.model, GLM.provider);
		check('C3 a pick other than the default is stored', c.model === GLM.model && c.provider === GLM.provider, pair(c));
		check('C3 its workers follow it (\'\')', !c.workerModel && !c.workerProvider, pair(c));
		d.newChat(); const e = d.chats()[0];
		d.startChat(e, DEF.model, DEF.provider);
		check('C3 a pick equal to the default stores \'\'', JSON.stringify(pair(e)) === JSON.stringify(BLANK), pair(e));
		d.newChat(); const f = d.chats()[0];
		d.startChat(f, FW.model, FW.provider);
		check('C3 the same id through another provider is not equal, and is stored', f.model === FW.model && f.provider === FW.provider, pair(f));
		d.newChat(); const g = d.chats()[0];
		d.startChat(g, '', '', GLM);
		check('C3 a Workers pick alone is stored, the chat still follows', !g.model && g.workerModel === GLM.model && g.workerProvider === GLM.provider, pair(g));
	});
}

// ── C4: storedPick and New Diamond ───────────────────────────────────────────
console.log('\nC4: storedPick, and what New Diamond stores');
{
	const d = device(APP, 'A');
	const sp = d.storedPick;
	check('C4 storedPick exists', typeof sp === 'function', d.missing);
	if (typeof sp === 'function') {
		const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
		const none = { provider: '', model: '' };
		check('C4 nothing chosen stores \'\'', eq(sp({ provider: '', model: '' }, DEF), none));
		check('C4 equal to the default stores \'\'', eq(sp(DEF, DEF), none));
		check('C4 equal model, no provider (the default\'s) stores \'\'', eq(sp({ provider: '', model: DEF.model }, DEF), none));
		check('C4 a different model is stored', eq(sp(GLM, DEF), GLM));
		check('C4 the same model on another provider is stored', eq(sp(FW, DEF), FW));
	}
	const cases = [
		['untouched (both pickers on the default)', { name: '', model: DEF, workerModel: DEF }, BLANK],
		['left on the default, worker following it', { name: 'x', model: { provider: DEF.provider, model: DEF.model }, workerModel: DEF }, BLANK],
		['a different model, worker following it', { name: 'x', model: GLM, workerModel: GLM },
			{ model: GLM.model, provider: GLM.provider, workerModel: '', workerProvider: '' }],
		['worker only', { name: 'x', model: DEF, workerModel: GLM },
			{ model: '', provider: '', workerModel: GLM.model, workerProvider: GLM.provider }],
		['nothing chosen at all', { name: 'x', model: { provider: '', model: '' }, workerModel: { provider: '', model: '' } }, BLANK],
	];
	for (const [label, vals, want] of cases) {
		const dd = device(APP, 'N');
		dd.env.dialogVals.v = vals;
		// createDiamond is async; the sandbox stubs resolve at once, so a microtask turn settles it.
		const p = guarded('C4 createDiamond runs: ' + label, dd, () => dd.createDiamond());
		await p;
		const got = dd.made[0] ? pair(dd.made[0].pick) : null;
		check('C4 New Diamond, ' + label + ': validate passes', dd.env.dialogVals.said === '', dd.env.dialogVals.said);
		check('C4 New Diamond, ' + label, got && JSON.stringify(got) === JSON.stringify(want), got);
	}
}

// ── C5: rename on B, model clear on A, both after S, survive on both ────────
console.log('\nC5: a rename and a model clear on two devices both survive');
{
	const A = device(APP, 'A', 0), B = device(APP, 'B', 0);
	const S = { id: 'chat-x', name: 'Before', messages: [{ mid: 'm1', role: 'user', content: 'hi' }],
		model: GLM.model, provider: GLM.provider, workerModel: '', workerProvider: '', status: 'active',
		updatedAt: A.clock.t - 60000, metaAt: A.clock.t - 60000 };
	const onA = JSON.parse(JSON.stringify(S)), onB = JSON.parse(JSON.stringify(S));
	guarded('C5 runs', A, () => {
		// A clears the model (its own model edit; a revision without `touchChatModel` stamps as it did).
		A.clock.t += 1000;
		onA.model = ''; onA.provider = '';
		(A.touchChatModel || A.touchChatMeta)(onA);
		// B renames, later.
		B.clock.t += 2000;
		onB.name = 'After';
		B.touchChatMeta(onB);
		const atA = A.mergeChatRecords(onB, A.slimChat(onA));
		const atB = B.mergeChatRecords(onA, B.slimChat(onB));
		for (const [where, r] of [['A', atA], ['B', atB]]) {
			check('C5 on ' + where + ': the rename survives', r.name === 'After', r.name);
			check('C5 on ' + where + ': the model clear survives', !r.model && !r.provider, pair(r));
		}
		check('C5 the two devices hold the same bytes', JSON.stringify(atA) === JSON.stringify(atB));
		// And again, from the merged records: a fixed point.
		const again = A.mergeChatRecords(atB, atA);
		check('C5 a re-merge is byte-stable', JSON.stringify(again) === JSON.stringify(atA));
	});
}

// ── C6: an old-build chat record (no `mat`) merges exactly as 14ef947b merged it ─
console.log('\nC6: records without mat merge as before');
{
	let OLD = '';
	try { OLD = source('daimond.js', '14ef947b'); } catch (e) { OLD = ''; }
	check('C6 the 14ef947b source is readable', !!OLD);
	if (OLD) {
		const N = device(APP, 'N'), O = device(OLD, 'O');
		const base = { id: 'chat-y', messages: [{ mid: 'm1', role: 'user', content: 'hi' }], status: 'active', workerModel: '', workerProvider: '' };
		const rec = (o) => Object.assign({}, base, o);
		const pairs = [
			['newer metaAt wins every scalar', rec({ name: 'a', model: GLM.model, provider: GLM.provider, updatedAt: 100, metaAt: 300 }),
				rec({ name: 'b', model: DEF.model, provider: DEF.provider, updatedAt: 200, metaAt: 200 })],
			['the other way round', rec({ name: 'a', model: GLM.model, provider: GLM.provider, updatedAt: 300, metaAt: 100 }),
				rec({ name: 'b', model: DEF.model, provider: DEF.provider, updatedAt: 200, metaAt: 200 })],
			['a tie on metaAt', rec({ name: 'a', model: DEF.model, provider: DEF.provider, updatedAt: 200, metaAt: 200 }),
				rec({ name: 'b', model: GLM.model, provider: GLM.provider, updatedAt: 200, metaAt: 200, effort: 'high' })],
			['no metaAt at all', rec({ name: 'a', model: GLM.model, provider: GLM.provider, updatedAt: 150 }),
				rec({ name: 'b', model: '', provider: '', updatedAt: 250 })],
			['inside a Diamond', rec({ name: 'a', diamondId: 'dia-1', updatedAt: 100, metaAt: 400 }),
				rec({ name: 'b', diamondId: 'dia-1', updatedAt: 500, metaAt: 300 })],
		];
		for (const [label, a, b] of pairs) {
			const n = guarded('C6 runs: ' + label, N, () => [N.mergeChatRecords(a, b), N.mergeChatRecords(b, a)]);
			const o = O.mergeChatRecords ? [O.mergeChatRecords(a, b), O.mergeChatRecords(b, a)] : null;
			check('C6 ' + label + ': the same bytes as 14ef947b', n && o && JSON.stringify(n) === JSON.stringify(o), n && n[0]);
			check('C6 ' + label + ': no mat appears', n && !/"mat"/.test(JSON.stringify(n)));
			check('C6 ' + label + ': slimChat writes no mat', !('mat' in JSON.parse(JSON.stringify(N.slimChat(a)))));
		}
	}
}


// ── C7: a chat's worker pair travels, and a Diamond cut from it inherits it ────
// verify_workermodel asks this of the live app; these are the functions it rests on, so a red
// there can be told from a red here (WORKERMODEL, 24 Oct).
console.log('\nC7: the chat\'s worker pair is stored, carried and inherited as picks');
{
	const d = device(APP, 'A');
	const follow = { id: 'c1', messages: [], model: '', provider: '', workerModel: '', workerProvider: '' };
	const own    = { id: 'c2', messages: [], model: GLM.model, provider: GLM.provider, workerModel: '', workerProvider: '' };
	const apart  = { id: 'c3', messages: [], model: GLM.model, provider: GLM.provider,
		workerModel: FW.model, workerProvider: FW.provider };
	const same   = { id: 'c4', messages: [], model: GLM.model, provider: GLM.provider,
		workerModel: GLM.model, workerProvider: GLM.provider };
	const cut = (c) => guarded('C7 diamondPickFromChat runs', d, () => d.diamondPickFromChat(c));
	const wk  = (x) => x ? { provider: x.workerProvider, model: x.workerModel } : null;
	check('C7 a following chat cuts a Diamond that follows', JSON.stringify(pair(cut(follow) || {})) === JSON.stringify(BLANK), cut(follow));
	const o = cut(own);
	check('C7 a chat on its own model cuts a Diamond on it, workers following it',
		!!o && o.model === GLM.model && o.provider === GLM.provider && o.workerModel === '' && o.workerProvider === '', o);
	check('C7 a chat whose workers are set apart cuts a Diamond whose workers are too',
		JSON.stringify(wk(cut(apart))) === JSON.stringify(FW), cut(apart));
	check('C7 workers equal to the chat\'s own model are stored as following it',
		JSON.stringify(wk(cut(same))) === JSON.stringify({ provider: '', model: '' }), cut(same));
	const slim = guarded('C7 slimChat runs', d, () => d.slimChat(apart));
	check('C7 the record a chat travels as carries its worker pair',
		!!slim && slim.workerModel === FW.model && slim.workerProvider === FW.provider, slim);
	const slimF = guarded('C7 slimChat runs on a following chat', d, () => d.slimChat(follow));
	check('C7 and a following chat carries the pair as \'\', present, not absent',
		!!slimF && slimF.workerModel === '' && slimF.workerProvider === '', slimF);
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed' + (process.env.MM_SRC_REV ? ' (source ' + process.env.MM_SRC_REV + ')' : ''));
process.exit(failures ? 1 : 0);
