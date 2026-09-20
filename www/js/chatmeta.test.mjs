/* ============================================================
   Test — S-SYNC #5: chat scalars merge FIELD-appropriately, so a
   rename/model/fold/holds edit is no longer reverted by a later turn.
   ------------------------------------------------------------
   THE BUG. `applyChats`, the cross-tab reconcile and `ChatStore.write`'s
   migration all took the WHOLE scalar record from the side with the newer
   `updatedAt`:

       slimChat((r.updatedAt >= st.updatedAt) ? r : st)

   `touchChat` bumps `updatedAt` on ~31 paths, every turn among them. So a
   rename made on the phone (a small bump of `updatedAt`) was clobbered the
   moment a dispatched turn landed from the runner with a larger `updatedAt`:
   the transcript unioned fine, but the name snapped back -- it read as "the
   rename didn't stick". Record-level last-writer-wins on one stamp cannot tell
   a rename from a turn.

   THE FIX, all in `www/js/daimond.js`:
     1. Split the stamp. `updatedAt` stays the TURN/transcript stamp (counters,
        `lastPrompt`, the model's `session` follow it). A new `metaAt` stamps the
        user-facing scalars (name, model, provider, worker model/provider,
        status, foldedInto, holds, diamondId). `touchChat` moves `updatedAt`
        only; `touchChatMeta` moves both. `slimChat`, `summaryOf`, `stampOf` and
        `hydrateChat` all carry `metaAt` (falling back to `updatedAt` for a
        record that predates the field, so an old build merges as before).
     2. One merge. `mergeChatRecords(incoming, local)` resolves the transcript
        and turn fields by `updatedAt` and the metadata scalars by `metaAt`, and
        is used at EVERY apply/merge/restore/cross-tab site, so the rules cannot
        drift apart again.

   `daimond.js` is an ES module that imports the compiled wasm surface, so it
   cannot be instantiated in a sandbox here (the reason `tombdurable.test.mjs`
   and `collectheap.test.mjs` give for the same file). So the REAL code is held
   to SOURCE GUARDS, and the merge LOGIC is exercised for real against a
   faithful port. Each check is proven able to fail:

     node www/js/chatmeta.test.mjs              # the fix, clean
     node www/js/chatmeta.test.mjs --break lww  # record-level LWW again → rename reverts
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAIMOND_SRC = join(HERE, 'daimond.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['lww'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// The body of a named declaration, to the first line that closes it at the
/// declaration's own indentation. Enough to assert what a function does.
function funcBody(src, decl) {
	const at = src.indexOf(decl);
	if (at < 0) throw new Error('declaration not found: ' + decl);
	const lineStart = src.lastIndexOf('\n', at) + 1;
	const indent = src.slice(lineStart, at).match(/^\t*/)[0];
	const close = '\n' + indent + '}';
	const end = src.indexOf(close, at);
	if (end < 0) throw new Error('close not found for: ' + decl);
	return src.slice(at, end + close.length);
}

// ── The daimond.js source, optionally patched to REINTRODUCE record-level LWW so
//    a guard can be shown to catch it. ────────────────────────────────────────
function daimondSrc() {
	let src = readFileSync(DAIMOND_SRC, 'utf8');
	if (BREAK === 'lww') {
		// The metadata scalars resolve from the TURN winner again -- record-level
		// LWW -- so a rename loses to a later turn exactly as it did before the split.
		const target = 'out.name           = metaNewer.name;';
		if (!src.includes(target)) throw new Error('break target not found: metaNewer name resolution');
		src = src.replace(target, 'out.name           = turnNewer.name;  // BROKEN: record-level LWW');
	}
	return src;
}

// ── SOURCE GUARDS on the real code ───────────────────────────────────────────
function sourceGuards() {
	const d = daimondSrc();

	console.log('chatmeta: source -- the metadata stamp rides on every record shape');
	check('slimChat carries metaAt (fallback updatedAt)',
		funcBody(d, 'function slimChat(c) {').includes("metaAt: (typeof c.metaAt === 'number') ? c.metaAt : (c.updatedAt || 0)"),
		'slimChat drops metaAt');
	check('summaryOf carries metaAt',
		funcBody(d, 'function summaryOf(c, serial, chunks) {').includes("metaAt: (typeof c.metaAt === 'number') ? c.metaAt : (c.updatedAt || 0)"),
		'summaryOf drops metaAt -- the merge sites read summaries');
	check('stampOf folds metaAt into the write-skip stamp',
		funcBody(d, 'function stampOf(c) {').includes("+ ':m' + ma"),
		'a metaAt-only change would be skipped by write');
	check('hydrateChat seeds metaAt at boot',
		funcBody(d, 'function hydrateChat(c) {').includes("metaAt: (typeof c.metaAt === 'number') ? c.metaAt : (c.updatedAt || 0)"),
		'in-memory chats lack an explicit metaAt');

	console.log('\nchatmeta: source -- two stamps, two touch functions');
	check('touchChat moves updatedAt ONLY',
		/function touchChat\(c\) \{ if \(c\) c\.updatedAt = Date\.now\(\); \}/.test(d), 'touchChat changed shape');
	check('touchChatMeta moves BOTH stamps',
		/function touchChatMeta\(c\) \{ if \(c\) \{ var now = Date\.now\(\); c\.updatedAt = now; c\.metaAt = now; \} \}/.test(d),
		'touchChatMeta missing or wrong');

	console.log('\nchatmeta: source -- one field-appropriate merge, used everywhere');
	{
		const m = funcBody(d, 'function mergeChatRecords(a, b, opts) {');
		check('the turn winner is the newer updatedAt', m.includes('var turnNewer = au >= bu ? a : b;'));
		check('the metadata winner is the newer metaAt', m.includes('var metaNewer = am >= bm ? a : b;'));
		check('metaAt falls back to updatedAt when a side predates the field',
			m.includes("var am = (typeof a.metaAt === 'number') ? a.metaAt : au;")
			&& m.includes("var bm = (typeof b.metaAt === 'number') ? b.metaAt : bu;"));
		check('the user-facing scalars come from the metadata winner, NOT the turn winner',
			m.includes('out.name           = metaNewer.name;')
			&& m.includes('out.model          = metaNewer.model;')
			&& m.includes('out.status         = metaNewer.status')
			&& m.includes('out.foldedInto     = metaNewer.foldedInto')
			&& m.includes('out.holds          = Array.isArray(metaNewer.holds)'),
			BREAK === 'lww' ? 'record-level LWW reintroduced (the break)' : 'a scalar resolves from the wrong side');
		check('the transcript is always unioned, local copy first',
			m.includes('out.messages = slimMessages(mergeMessages(localMsgs, remoteMsgs, out.id, opts.mtombs));'));
		check('both stamps advance to the max each side holds (fixed point)',
			m.includes('out.updatedAt = au >= bu ? au : bu;') && m.includes('out.metaAt    = am >= bm ? am : bm;'));
	}
	check('applyChats merges through mergeChatRecords', d.includes('var merged = mergeChatRecords(r, st, {'),
		'applyChats still does record-level LWW');
	check('the cross-tab reconcile and the migration both merge through it',
		(d.match(/mergeChatRecords\(c, st, \{ mtombs: mtombs \}\)/g) || []).length >= 2,
		'persistChats or mergeInto still does its own LWW');
	check('the backup restore merges through it too',
		(d.match(/var merged = mergeChatRecords\(r, st, \{/g) || []).length >= 2, 'restore still does record-level LWW');

	console.log('\nchatmeta: source -- metadata writers stamp metaAt');
	check('renameChat stamps metaAt', funcBody(d, 'function renameChat(chat, name, quiet) {').includes('touchChatMeta(chat);'),
		'a rename still moves only updatedAt');
	check('the fold and unfold paths stamp metaAt',
		(d.match(/touchChatMeta\(chat\);/g) || []).length >= 4, 'fold/unfold/start still on touchChat');
	check('the holds toggles stamp metaAt',
		d.includes('touchChatMeta(_hc);') && d.includes('touchChatMeta(chats.find(function (x) { return x.id === chatId; }))'),
		'an attachment change is not stamped as metadata');

	console.log('\nchatmeta: source -- the cross-tab in-place copy splits the two stamps');
	{
		const oc = funcBody(d, 'async function onChatsChangedElsewhere(touchedIds) {');
		check('turn fields still gate on updatedAt', oc.includes("if ((s.updatedAt || 0) > (c.updatedAt || 0) && !c._generating) {"));
		check('metadata scalars gate on metaAt', oc.includes('if (sMeta > cMeta && !c._generating) {'),
			'a cross-tab rename can still be clobbered by another tab\'s turn');
	}
}

// ── BEHAVIOURAL: a faithful port of slimChat + mergeMessages + mergeChatRecords ─
//
// The port mirrors the real functions in shape. `--break lww` reverts
// mergeChatRecords to record-level LWW (the metadata scalars taken from the turn
// winner), exactly as the source patch does, so the reversion is reproduced.

const META_FIELDS = ['name', 'model', 'provider', 'workerModel', 'workerProvider', 'status', 'foldedInto', 'holds', 'diamondId'];

function slimChat(c) {
	return {
		id: c.id, name: c.name, messages: c.messages, model: c.model, provider: c.provider || '',
		diamondId: c.diamondId || '',
		workerModel: c.workerModel || '', workerProvider: c.workerProvider || '',
		status: c.status || 'active',
		session: c.session || null,
		holds: Array.isArray(c.holds) ? c.holds : [],
		promptTokens: c.promptTokens || 0, completionTokens: c.completionTokens || 0,
		updatedAt: c.updatedAt || 0, foldedInto: c.foldedInto || null,
		metaAt: (typeof c.metaAt === 'number') ? c.metaAt : (c.updatedAt || 0),
	};
}

// Union two transcripts: first-wins per mid, sorted by (ts, mid).
function mergeMessages(a, b) {
	const at = {}, out = [];
	(a || []).concat(b || []).forEach((m) => {
		if (at[m.mid] === undefined) { at[m.mid] = out.length; out.push(m); }
	});
	out.sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)));
	return out;
}

function mergeChatRecords(a, b, opts) {
	opts = opts || {};
	const au = a.updatedAt || 0, bu = b.updatedAt || 0;
	const am = (typeof a.metaAt === 'number') ? a.metaAt : au;
	const bm = (typeof b.metaAt === 'number') ? b.metaAt : bu;
	const turnNewer = au >= bu ? a : b;
	const metaNewer = am >= bm ? a : b;
	const out = slimChat(turnNewer);
	// THE FIX vs THE BUG: the metadata winner governs the scalars, unless --break.
	const scalarSrc = (BREAK === 'lww') ? turnNewer : metaNewer;
	out.name           = scalarSrc.name;
	out.model          = scalarSrc.model;
	out.provider       = scalarSrc.provider || '';
	out.workerModel    = scalarSrc.workerModel || '';
	out.workerProvider = scalarSrc.workerProvider || '';
	out.status         = scalarSrc.status || 'active';
	out.foldedInto     = scalarSrc.foldedInto || null;
	out.holds          = Array.isArray(scalarSrc.holds) ? scalarSrc.holds : [];
	out.diamondId      = scalarSrc.diamondId || '';
	out.updatedAt = au >= bu ? au : bu;
	out.metaAt    = am >= bm ? am : bm;
	const localMsgs  = (opts.localMsgs  !== undefined) ? opts.localMsgs  : (b.messages || []);
	const remoteMsgs = (opts.remoteMsgs !== undefined) ? opts.remoteMsgs : (a.messages || []);
	out.messages = mergeMessages(localMsgs, remoteMsgs);
	return out;
}

function touchChat(c)     { c.updatedAt = c._clock; }
function touchChatMeta(c) { c.updatedAt = c._clock; c.metaAt = c._clock; }

const names = (c) => c.name;
const mids  = (c) => c.messages.map((m) => m.mid).join(',');

function behavioural() {
	console.log('\nchatmeta: behavioural -- a rename survives a later dispatched turn');
	{
		// A and the runner both start from the same settled chat.
		const base = { id: 'C', name: 'Old', model: 'gpt', updatedAt: 100, metaAt: 100, messages: [{ mid: 'm1', ts: 1 }] };
		// A renames at t=200 (a metadata edit: touchChatMeta bumps BOTH stamps).
		const A = slimChat(base); A._clock = 200; A.name = 'New'; touchChatMeta(A);
		// The runner runs the dispatched turn at t=300 (touchChat bumps updatedAt only),
		// appending m2. It never saw the rename, so its metaAt stays at 100.
		const R = slimChat(base); R._clock = 300; R.messages = [{ mid: 'm1', ts: 1 }, { mid: 'm2', ts: 3 }]; touchChat(R);
		check('the runner turn has the larger updatedAt', R.updatedAt > A.updatedAt);
		check('the rename has the larger metaAt', A.metaAt > R.metaAt);
		// A pulls the runner's parcel: mergeChatRecords(incoming=R, local=A).
		const merged = mergeChatRecords(R, A, { localMsgs: A.messages, remoteMsgs: R.messages });
		if (BREAK !== 'lww') {
			check('the rename STICKS (name resolves by metaAt)', names(merged) === 'New', 'got ' + names(merged));
		} else {
			check('BROKEN: the rename REVERTS to the runner\'s old name', names(merged) === 'Old',
				'expected the record-level-LWW reversion, got ' + names(merged));
		}
		// The transcript union is unaffected by the break -- it is always a union.
		check('the newer turn wins the transcript (m2 is present, in order)', mids(merged) === 'm1,m2', 'got ' + mids(merged));
	}

	console.log('\nchatmeta: behavioural -- a scalar edit and a turn on two devices merge without clobber');
	{
		const base = { id: 'C', name: 'Old', model: 'gpt', updatedAt: 100, metaAt: 100, messages: [{ mid: 'm1', ts: 1 }] };
		// A renames (metaAt high, updatedAt modest). B takes a turn (updatedAt high, metaAt untouched).
		const A = slimChat(base); A._clock = 200; A.name = 'New'; touchChatMeta(A);
		const B = slimChat(base); B._clock = 300; B.messages = [{ mid: 'm1', ts: 1 }, { mid: 'm2', ts: 3 }]; touchChat(B);
		// Merge in BOTH directions -- each device pulling the other's parcel -- and require
		// the SAME converged record, so neither edit clobbers the other whichever lands first.
		const onA = mergeChatRecords(B, A, { localMsgs: A.messages, remoteMsgs: B.messages });   // A pulls B
		const onB = mergeChatRecords(A, B, { localMsgs: B.messages, remoteMsgs: A.messages });   // B pulls A
		if (BREAK !== 'lww') {
			check('A keeps its rename after B\'s turn lands', names(onA) === 'New', 'got ' + names(onA));
			check('B adopts the rename it never made (metaAt wins)', names(onB) === 'New', 'got ' + names(onB));
			check('both devices converge on the same name', names(onA) === names(onB));
			check('both devices hold the full transcript', mids(onA) === 'm1,m2' && mids(onB) === 'm1,m2');
		} else {
			check('BROKEN: at least one device loses the rename to the turn',
				names(onA) === 'Old' || names(onB) === 'Old', 'expected a clobber under record-level LWW');
		}
	}

	console.log('\nchatmeta: behavioural -- the quiet-round fixed point is byte-identical');
	{
		// A settled record, both a metaAt and an updatedAt in hand.
		const R = slimChat({ id: 'C', name: 'Kept', model: 'gpt', updatedAt: 250, metaAt: 275, holds: [{ ref: 'a' }],
			messages: [{ mid: 'm1', ts: 1 }, { mid: 'm2', ts: 2 }] });
		// Collecting the same state twice is byte-identical (the collect uses slimChat).
		check('two collects of one state are byte-identical', JSON.stringify(slimChat(R)) === JSON.stringify(slimChat(R)));
		// Applying a quiet parcel (remote == local) reproduces the record byte-for-byte, so
		// the pair uploads nothing on a settled round.
		const applied = mergeChatRecords(slimChat(R), slimChat(R), { localMsgs: R.messages, remoteMsgs: R.messages });
		check('merging a state with itself is byte-identical to the collected record',
			JSON.stringify(slimChat(applied)) === JSON.stringify(slimChat(R)),
			'a quiet round would push for ever');
		// metaAt does not drift under the merge (max of two equal numbers).
		check('metaAt is stable across a quiet apply', slimChat(applied).metaAt === slimChat(R).metaAt);
	}

	console.log('\nchatmeta: behavioural -- a legacy record (no metaAt) merges as before');
	{
		// Neither side carries an explicit metaAt: the fallback makes both track updatedAt,
		// so the merge degrades to the old record-level rule -- an old build merges as today.
		const A = { id: 'C', name: 'A-name', updatedAt: 100, messages: [{ mid: 'm1', ts: 1 }] };
		const B = { id: 'C', name: 'B-name', updatedAt: 200, messages: [{ mid: 'm1', ts: 1 }] };
		const merged = mergeChatRecords(slimChat(B), slimChat(A), { localMsgs: A.messages, remoteMsgs: B.messages });
		check('the newer-updatedAt side wins when neither has a real metaAt', names(merged) === 'B-name', 'got ' + names(merged));
	}
}

function main() {
	sourceGuards();
	behavioural();
	console.log('');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the failures above are the point -- the rename reverts under record-level LWW)');
		process.exit(failures > 0 ? 0 : 1);   // a break that reddens nothing is itself a failure
	}
	if (failures) { console.log(failures + ' of ' + checks + ' checks FAILED'); process.exit(1); }
	console.log('all ' + checks + ' checks ok');
}

main();
