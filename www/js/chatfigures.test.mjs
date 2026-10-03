/* ============================================================
   Test -- a saved chat keeps its summary figures (F3b-0).
   ------------------------------------------------------------
   THE FAULT. The collect ranks the inline set from each stored summary's `bytes`
   (`collectChatsRefs`, pass 1) and treats a summary with none as "too large to ride
   inline". The store's mirror held those figures from boot, but `ChatStore.save(list)`
   is `mirror = list`, and every caller builds its list from `slimChat` output, which
   has no `bytes` and no `fp`: `persistChats` (the head of every collect) merges each
   app chat with its summary through `mergeChatRecords`, and `applyChats` saves the
   merge of every chat a parcel carried. So after every such save the next collect met
   a mirror of unknown sizes, sent every transcript as a reference (an empty one
   included), loaded and fingerprinted each, and wrote the figures back only to lose
   them at the next save. The `have`(1) reads of the soak, and a pull followed by a
   collect that offloaded a 1 kB chat on a device with room to spare, are this.

   THE FIX (`carryChatFigures`, daimond.js; `ChatStore.save` calls it before the
   mirror is replaced). A transcript in hand is measured now, in the form the collect
   fingerprints; one that is not in hand keeps the prior entry's figures while the
   transcript they described still stands (the same count and standing); an empty one
   is two bytes.

   THE FOLLOW-UP (F3e). The first version wrote the measure of the copy in hand as the
   chat's `fp`, which the collect trusts when it equals the stored manifest's. That is
   right only while the copy in hand is what the store serves; the store can be ahead of
   it (a cross-tab write, a chunk heal, a copy a merge has not yet refreshed), and then a
   stale measure matched an old manifest and the chat was never re-offloaded
   (`verify_msgconverge` check 2). So `fp` is now only ever the authoritative value the
   collect writes back (`noteFps`), and the entry carries `seed`, the measure of the
   copy in hand when that pair was taken: at a save, the same copy keeps the prior `fp`,
   a different one clears it (the collect loads, and `noteFps` restores it). `bytes`
   still comes from the measure, since it only ranks.

   WHAT IS CHECKED, through the REAL functions lifted from the tree under test
   (dev/syncprobe.mjs, `TREE=<checkout>` to aim it elsewhere):
     A. the fault, on the real `slimChat` and `mergeChatRecords`: what the callers
        save has no figures;
     B. the seed is the collect's own figure: `chatSeed(msgs)` equals the length and
        `fileHash` of `JSON.stringify(msgs)`;
     C. a round trip through save keeps them: a non-resident entry rebuilt the way
        `persistChats` rebuilds it, with and without a rename;
     D. an apply that adds nothing keeps them (the merged transcript measures what the
        summary held), and one that adds messages recomputes them to what the collect
        would compute (the bytes), never the stale pair, and its fp is cleared;
     E. a non-resident entry whose transcript has moved is not given the old pair; an
        empty chat is two bytes; a resident entry's own stale pair is replaced;
     F. `fp` stays authoritative: the same copy in hand keeps the prior fp (a cleared
        one stays cleared), a moved copy clears it, a copy that flips back to an old
        seat never revives an old fp, and the collect's write-back is kept by a copy
        equal to its seed;
     G. a copy in hand answers to the seed whether or not the entry says it is resident:
        a transcript put on a non-resident entry in place, or a rebuilt entry carrying a
        different one at the old count, is not given the pair of the transcript it replaced.
     node www/js/chatfigures.test.mjs            # ALL PASS
   ============================================================ */
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const J = (x) => JSON.stringify(x);

const w = makeWindow({ now: 1_000_000_000 });
const base = sliceDaimond(w, ['slimChat', 'mergeChatRecords', 'fileHash', 'chatMsgCount', 'standingOf', 'msgStanding']).fns;
let lifted = null, why = '';
try { lifted = sliceDaimond(w, ['carryChatFigures', 'chatSeed']).fns; } catch (e) { why = String((e && e.message) || e); }

const msgs = (tag, n, len) => Array.from({ length: n }, (_, i) => ({
	role: i % 2 ? 'assistant' : 'user', mid: tag + '-m' + i, ts: 1000 + i,
	content: ((tag + i + ' lorem ipsum ').repeat(Math.ceil(len / 12))).slice(0, len) }));
const collectForm = (m) => { const s = J(m); return { bytes: s.length, fp: base.fileHash(s) }; };
// What the boot read leaves in the mirror for a stored chat: a summary with its figures.
const summary = (id, m, extra) => Object.assign({ id, name: 'n', model: 'm', provider: '', updatedAt: 5, metaAt: 5, status: 'active',
	msgCount: m.length, sessionMsgs: 0, standing: base.msgStanding(m), opening: '' }, collectForm(m), { seed: collectForm(m).fp }, extra || {});

// ── A. the fault ───────────────────────────────────────────────────
console.log('A. what the callers save');
{
	const m = msgs('a', 2, 400);
	const rec = { id: 'a', name: 'n', model: 'm', provider: '', updatedAt: 5, metaAt: 5, messages: m, session: null };
	const slim = base.slimChat(rec);
	check('a slimChat record has no bytes and no fp', slim.bytes === undefined && slim.fp === undefined, J([slim.bytes, slim.fp]));
	const merged = base.mergeChatRecords(rec, summary('a', m), { localMsgs: m, remoteMsgs: m, mtombs: {} });
	check('a mergeChatRecords result (the applyChats save) has no bytes and no fp', merged.bytes === undefined && merged.fp === undefined, J([merged.bytes, merged.fp]));
}

if (!lifted) {
	check('the tree has carryChatFigures and chatSeed', false, why);
} else {
	const { carryChatFigures: carry, chatSeed: seed } = lifted;

	console.log('B. the seed is the collect\'s figure');
	{
		const m = msgs('b', 5, 700);
		check('chatSeed(msgs) is the length and fileHash of JSON.stringify(msgs)', J(seed(m)) === J(collectForm(m)), J([seed(m), collectForm(m)]));
		check('chatSeed of an empty transcript is two bytes', seed([]).bytes === 2 && seed(null).bytes === 2);
	}

	console.log('C. a round trip through save');
	{
		const m = msgs('c', 1, 900);
		const prior = [summary('c', m)];
		// persistChats' rebuild of a non-resident chat: slimChat, then the residency markers.
		const rebuilt = (over) => Object.assign(base.slimChat(Object.assign({ id: 'c', name: 'n', model: 'm', updatedAt: 5, metaAt: 5, messages: [] }, over || {})),
			{ _loaded: false, msgCount: base.chatMsgCount(prior[0]), sessionMsgs: 0, standing: base.standingOf(prior[0]) });
		const list = [rebuilt()];
		check('the rebuilt entry has lost its figures', list[0].bytes === undefined);
		carry(list, prior);
		check('a non-resident entry keeps the prior bytes, fp and seed', list[0].bytes === prior[0].bytes && list[0].fp === prior[0].fp && list[0].seed === prior[0].seed, J([list[0].bytes, list[0].fp, list[0].seed, prior[0].bytes]));
		const renamed = [rebuilt({ name: 'renamed', metaAt: 99 })];
		carry(renamed, prior);
		check('a rename (the transcript untouched) keeps them too', renamed[0].bytes === prior[0].bytes && renamed[0].fp === prior[0].fp);
	}

	console.log('D. an apply');
	{
		const m = msgs('d', 3, 300);
		// An authoritative fp that is not the measure (the collect hashes what the store serves).
		const prior = [summary('d', m, { fp: 'auth:fp' })];
		const merge = (a, b) => base.mergeChatRecords({ id: 'd', name: 'n', model: 'm', updatedAt: 6, metaAt: 5, messages: a },
			prior[0], { localMsgs: b, remoteMsgs: a, mtombs: {} });
		// The parcel carried what this device holds: the merge adds nothing.
		const same = merge(m, m);
		carry([same], prior);
		check('an apply that adds nothing keeps the pair the summary held', same.bytes === prior[0].bytes && same.fp === 'auth:fp' && same.seed === prior[0].seed, J([same.bytes, same.fp, same.seed]));
		// The parcel carried two messages this device did not hold.
		const more = msgs('d', 5, 300);
		const grown = merge(more, m);
		carry([grown], prior);
		const want = collectForm(grown.messages);
		check('an apply that adds messages measures the merged transcript', grown.messages.length === 5 && grown.bytes === want.bytes && grown.seed === want.fp, J([grown.bytes, want.bytes, grown.seed]));
		check('and its fp is cleared, not the stale pair or the measure', grown.fp === '' && grown.bytes !== prior[0].bytes, J([grown.fp]));
	}

	console.log('E. what is not carried');
	{
		const m = msgs('e', 2, 500);
		const prior = [summary('e', m)];
		// A non-resident entry that now counts more messages: the old pair describes a transcript that has moved.
		const moved = [Object.assign(base.slimChat({ id: 'e', messages: [] }), { _loaded: false, msgCount: 3, sessionMsgs: 0, standing: prior[0].standing })];
		carry(moved, prior);
		check('a non-resident entry whose count moved is not given the old pair', moved[0].bytes === undefined && moved[0].fp === undefined, J([moved[0].bytes, moved[0].fp]));
		// A new empty chat: no prior, nothing in hand.
		const fresh = [base.slimChat({ id: 'f', messages: [] })];
		carry(fresh, []);
		check('a new empty chat is two bytes', fresh[0].bytes === 2 && fresh[0].fp === base.fileHash('[]'), J([fresh[0].bytes, fresh[0].fp]));
		// A resident entry that arrives carrying a stale pair is measured afresh.
		const stale = Object.assign(base.slimChat({ id: 'g', messages: msgs('g', 4, 200) }), { bytes: 7, fp: 'stale:7' });
		carry([stale], []);
		const gw = collectForm(stale.messages);
		check('a resident entry\'s own stale pair is replaced: bytes measured, fp cleared', stale.bytes === gw.bytes && stale.fp === '' && stale.seed === gw.fp, J([stale.bytes, stale.fp, stale.seed]));
		// A resident-but-empty entry over a prior that held messages: a cold read, not an empty chat.
		const cold = [base.slimChat({ id: 'e', messages: [] })];
		carry(cold, prior);
		check('a resident-empty entry over a prior with messages is not called empty', cold[0].bytes !== 2, J([cold[0].bytes]));
	}

	console.log('F. fp stays authoritative');
	{
		const x1 = msgs('x', 4, 400), x2 = msgs('x', 4, 400).map((m, i) => i === 3 ? Object.assign({}, m, { toDevice: 'desk-y' }) : m);
		const h1 = collectForm(x1), h2 = collectForm(x2);
		check('the two seats measure differently', h1.fp !== h2.fp);
		// A resident entry as the save builds it: the transcript in hand, no figures of its own.
		const held = (m) => [Object.assign(base.slimChat({ id: 'x', name: 'n', model: 'm', updatedAt: 5, metaAt: 5, messages: m }), { _loaded: true })];
		// What the collect wrote back: the fp of the serial it offloaded, taken while the copy in hand measured h1.
		const offered = [summary('x', x1, { fp: 'auth:P1' })];
		const same = held(x1);
		carry(same, offered);
		check('the same copy in hand keeps the authoritative fp', same[0].fp === 'auth:P1' && same[0].seed === h1.fp && same[0].bytes === h1.bytes, J([same[0].fp, same[0].seed]));
		const moved = held(x2);
		carry(moved, offered);
		check('a copy that moved clears the fp, takes the new seed and measures the bytes', moved[0].fp === '' && moved[0].seed === h2.fp && moved[0].bytes === h2.bytes, J([moved[0].fp, moved[0].seed]));
		// The copy flips back to the old seat while the store serves the new one (verify_msgconverge, check 2).
		const flipped = held(x1);
		carry(flipped, moved);
		check('a copy that flips back to the old seat does not revive the old fp', flipped[0].fp === '' && flipped[0].seed === h1.fp, J([flipped[0].fp, flipped[0].seed]));
		// The collect loads from the store and writes back the fp of what it offloaded; the entry keeps the seed it had.
		flipped[0].fp = 'auth:P2';
		const again = held(x1);
		carry(again, flipped);
		check('the collect\'s write-back is kept by a copy equal to the seed', again[0].fp === 'auth:P2', J([again[0].fp]));
		const moves = held(x2);
		carry(moves, flipped);
		check('and cleared again when the copy moves off it', moves[0].fp === '', J([moves[0].fp]));
		// A cleared fp (invalidateSummaryFp after a chunk heal) stays cleared across a save that leaves the copy alone.
		const healed = [summary('x', x1, { fp: '' })];
		const after = held(x1);
		carry(after, healed);
		check('a cleared fp stays cleared while the copy in hand has not moved', after[0].fp === '' && after[0].bytes === h1.bytes, J([after[0].fp]));
		// A row from before the seed existed has no seed to compare: the fp is not trusted.
		const legacy = [Object.assign(summary('x', x1, { fp: 'auth:P1' }), { seed: undefined })];
		const lh = held(x1);
		carry(lh, legacy);
		check('a prior without a seed gives no fp, and takes one', lh[0].fp === '' && lh[0].seed === h1.fp, J([lh[0].fp, lh[0].seed]));
		// Not in hand: a cleared fp still passes its bytes on, which only rank.
		const cold = [Object.assign(base.slimChat({ id: 'x', messages: [] }), { _loaded: false, msgCount: x1.length, sessionMsgs: 0, standing: base.msgStanding(x1) })];
		carry(cold, healed);
		check('a non-resident entry over a cleared fp keeps the bytes and the cleared fp', cold[0].bytes === h1.bytes && cold[0].fp === '' && cold[0].seed === h1.fp, J([cold[0].bytes, cold[0].fp, cold[0].seed]));
	}

	console.log('G. a copy in hand answers to the seed, resident or not');
	{
		const m1 = msgs('h', 4, 400), m2 = msgs('h', 6, 400);
		const h1 = collectForm(m1), h2 = collectForm(m2);
		// The mirror entry as persistChats builds it for a chat not opened here, carrying the pair the collect wrote back.
		const entry = () => Object.assign(base.slimChat({ id: 'h', name: 'n', model: 'm', updatedAt: 5, metaAt: 5, messages: [] }),
			{ _loaded: false, msgCount: m1.length, sessionMsgs: 0, standing: base.msgStanding(m1), bytes: h1.bytes, fp: 'auth:H1', seed: h1.fp });
		// A caller puts a transcript on that same object and saves it: the entry still says what it said, the copy in hand has moved.
		const moved = entry();
		moved.messages = m2;
		carry([moved], [moved]);
		check('a non-resident entry given a different transcript in place does not keep its pair', moved.fp === '' && moved.seed === h2.fp, J([moved.fp, moved.seed]));
		check('and its bytes are not the old figure', moved.bytes !== h1.bytes, J([moved.bytes]));
		// The same transcript in hand (the whole record a merge left, flagged not resident): the pair stands.
		const same = entry();
		same.messages = m1;
		carry([same], [same]);
		check('a non-resident entry holding the transcript its pair describes keeps the pair', same.fp === 'auth:H1' && same.bytes === h1.bytes && same.seed === h1.fp, J([same.fp, same.bytes]));
		// persistChats' rebuild of it, a new object carrying the whole copy over the prior entry.
		const rebuilt = Object.assign(base.slimChat({ id: 'h', name: 'n', model: 'm', updatedAt: 5, metaAt: 5, messages: m1 }),
			{ _loaded: false, msgCount: m1.length, sessionMsgs: 0, standing: base.msgStanding(m1) });
		carry([rebuilt], [entry()]);
		check('a rebuilt entry holding the same transcript takes the prior pair', rebuilt.fp === 'auth:H1' && rebuilt.bytes === h1.bytes, J([rebuilt.fp, rebuilt.bytes]));
		const rebuiltMoved = Object.assign(base.slimChat({ id: 'h', name: 'n', model: 'm', updatedAt: 5, metaAt: 5, messages: m2 }),
			{ _loaded: false, msgCount: m1.length, sessionMsgs: 0, standing: base.msgStanding(m1) });
		carry([rebuiltMoved], [entry()]);
		check('a rebuilt entry holding another transcript is not given it, even at the old count', rebuiltMoved.fp === '' && rebuiltMoved.bytes !== h1.bytes, J([rebuiltMoved.fp, rebuiltMoved.bytes]));
	}
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
if (failures) process.exitCode = 1;
