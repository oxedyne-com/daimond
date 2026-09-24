/* ============================================================
   Test — offloaded message tails stay alive at the gateway (the D-28
   state review, A4: REF-1).
   ------------------------------------------------------------
   THE BUG, three parts. The post record's tail (the heavy half of every
   message past a 2 MiB budget) is offloaded to content chunks and named
   by `@m/<addr>` manifests in the chunk index, which a commit declares
   live; the gateway sweeps the rest.
     (i)  `snapshotRefs` offloaded on ANY unlocked device, although only a
          device that may commit declares what it uploads: a
          folder-mounted desktop's tails were swept a day later.
     (ii) the presence check re-offloads a chat, a Diamond or a file whose
          chunks the gateway no longer has, and read an `@m/` manifest as
          unrestorable, so a swept tail was never put back.
     (iii) no device named a PEER's `@m/` addresses in a peer slot, as it
          does a peer's chats and Diamonds, so two committing devices
          swept each other's tails in turn and a device that lacked the
          messages never received their bodies.

   THE FIX. (i) `snapshotRefs` asks `DaimondCore.syncMayCommitChunks`;
   (ii) `verifyManifestPresence` has an `@m/` arm that re-offloads while
   `DaimondPost.holdsHeavy(addr)`; (iii) `applySync` names every `@m/`
   reference a peer's parcel carries in that peer's slot
   (`notePeerMsgRefs`).

   WHAT IS CHECKED, with the real post.js and cloud.js over a stand-in
   chunk store, and daimond.js's `verifyManifestPresence` and
   `notePeerMsgRefs` lifted from the file's own text.

   Run:  node www/js/msgtail.test.mjs [--tree <checkout>]
   ============================================================ */
import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const SELF = 'ffffffffffffffffffffffffffffffff';
const PEER = '0123456789abcdef0123456789abcdef';

/// A tab with the real post.js and cloud.js, a chunk store that remembers what it
/// holds, and a commit gate the test sets.
async function tab(mayCommit) {
	const w = makeWindow({ now: 1_000_000_000 });
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s, deviceId: () => SELF };
	const held = new Set();
	let n = 0;
	w.DaimondChunks = {
		offloadBytes: async (name, bytes) => {
			const addr = 'c' + String(++n).padStart(63, '0');
			held.add(addr);
			return { v: 1, size: bytes.length, key: 'k' + n, chunks: [{ addr, size: bytes.length }] };
		},
		presence: async (addrs) => ({ ok: true, missing: addrs.filter((a) => !held.has(a)) }),
	};
	w.DaimondCore = { syncMayCommitChunks: () => mayCommit.value };
	loadScript(w, 'cloud.js');
	loadScript(w, 'post.js');
	await w.DaimondPost.read();
	// Three messages of 1 MiB each: past the 2 MiB inline budget, so the older
	// ones are the tail.
	const big = 'x'.repeat(1024 * 1024);
	const msgs = {};
	for (const [addr, ts] of [['a1', 1], ['a2', 2], ['a3', 3]]) msgs[addr] = { addr, ts, dir: 'in', body: big + addr, read: 0, tray: 0 };
	w.DaimondPost.adopt({ v: 5, through: 0, acked: 0, msgs, notes: {}, groups: {}, shares: {}, feed: { since: 0, read: {}, new: {} } });
	return { w, held };
}
const refs = (rec) => Object.keys(rec.msgs).filter((a) => rec.msgs[a].msgRef);

console.log('msgtail (i): only a device that may commit offloads its tail');
{
	const gate = { value: false };
	const { w } = await tab(gate);
	const off = await w.DaimondPost.snapshotRefs();
	check('a device that may not commit keeps every row inline', refs(off).length === 0, refs(off).join(','));
	check('and writes no @m/ manifest', !Object.keys(w.DaimondCloud.index()).some((k) => k.startsWith('@m/')));
	gate.value = true;
	const on = await w.DaimondPost.snapshotRefs();
	check('a device that may commit offloads the tail, the freshest row inline',
		refs(on).includes('a1') && !refs(on).includes('a3'), refs(on).join(','));
}

console.log('\nmsgtail (ii): a tail the gateway no longer holds is offloaded again');
{
	const gate = { value: true };
	const { w, held } = await tab(gate);
	await w.DaimondPost.snapshotRefs();
	const before = w.DaimondCloud.contentGet('@m/a1');
	check('the tail has a manifest', !!before);
	held.delete(before.chunks[0].addr);						// swept at the gateway
	const f = sliceDaimond(w, ['verifyManifestPresence'], {
		ChatStore: { stored: () => [] }, diamondApp: () => ({ list_diamonds: async () => '[]' }),
		filesSyncable: () => true, syncFileAt: async () => null, clog: () => {}, trail: () => {}, diag: () => {},
		tOr: (k, x) => x, t: (k) => k,
	}).fns;
	await f.verifyManifestPresence();
	check('the presence check forgets the dead manifest (reoffload)', !w.DaimondCloud.contentGet('@m/a1'));
	await w.DaimondPost.snapshotRefs();
	const after = w.DaimondCloud.contentGet('@m/a1');
	check('the next collect offloads it again, to an address the gateway holds',
		!!after && held.has(after.chunks[0].addr) && after.chunks[0].addr !== before.chunks[0].addr);
	check('holdsHeavy says no for a message this device does not hold', w.DaimondPost.holdsHeavy('zz') === false);
}

console.log('\nmsgtail (iii): a peer\'s tail is named in its slot');
{
	const gate = { value: true };
	const { w } = await tab(gate);
	const f = sliceDaimond(w, ['notePeerMsgRefs'], {}).fns;
	const peerRef = { v: 1, size: 9, key: 'pk', chunks: [{ addr: 'p'.repeat(64), size: 9 }] };
	f.notePeerMsgRefs({ msgs: { a1: { addr: 'a1', msgRef: peerRef }, a2: { addr: 'a2', body: 'inline' } } }, PEER);
	const slot = w.DaimondCloud.contentGet('@m/a1.peer.' + PEER);
	check('the peer\'s addresses are held in @m/<addr>.peer.<dev>', !!slot && slot.peer === true && slot.chunks[0].addr === 'p'.repeat(64));
	check('an inline row opens no slot', !w.DaimondCloud.contentGet('@m/a2.peer.' + PEER));
	f.notePeerMsgRefs({ msgs: { a1: { addr: 'a1', body: 'now inline' } } }, PEER);
	check('the slot goes when the peer carries the row inline again', !w.DaimondCloud.contentGet('@m/a1.peer.' + PEER));
	f.notePeerMsgRefs({ msgs: { a1: { addr: 'a1', msgRef: peerRef } } }, PEER);
	f.notePeerMsgRefs({ msgs: {} }, PEER);
	check('and when the peer\'s record no longer holds the row at all', !w.DaimondCloud.contentGet('@m/a1.peer.' + PEER));
	f.notePeerMsgRefs({ msgs: { a1: { addr: 'a1', msgRef: peerRef } } }, 'fedcba9876543210fedcba9876543210');
	f.notePeerMsgRefs({ msgs: { a1: { addr: 'a1', msgRef: peerRef } } }, PEER);
	f.notePeerMsgRefs({ msgs: {} }, 'fedcba9876543210fedcba9876543210');
	check('one peer dropping a row leaves another peer\'s slot for it standing',
		!!w.DaimondCloud.contentGet('@m/a1.peer.' + PEER) && !w.DaimondCloud.contentGet('@m/a1.peer.fedcba9876543210fedcba9876543210'));
	await w.DaimondPost.snapshotRefs();
	check('the slot survives this device\'s own collect while it holds the message',
		!!w.DaimondCloud.contentGet('@m/a1.peer.' + PEER));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall msgtail checks passed');
process.exit(failures ? 1 : 0);
