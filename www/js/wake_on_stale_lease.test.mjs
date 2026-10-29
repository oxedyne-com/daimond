// QA ccp3 (A) probe R3: `armHeldWake` (787a84e26) asks the queue again at the lease's expiry + 250 ms, and
// `drainAfterHeld` decides on this tab's CACHED lease view alone. A phone locked through a long argonaut turn misses
// the runner's renewals; on unlock the overdue wake fires before any sync round, the cached lease reads expired
// (`leaseHolder` null, the tile 'failed'), and the queued send goes while argonaut still runs t2: two turns of the chat
// at once, the seam the queue exists to close (QA ccp1 M1). Run: node <this> <daimond.js>.
// FAIL = the queue drains on the cached expiry with no authoritative read of the lease.
// ADAPTED for the gate (CCP3-QAFIX3): runs over www/js/daimond.js with no argument; the door is the real one
// (`DaimondSync.leaseGet`, adopted through `DaimondLease.adopt`), not a `Lease.pull`; the R3 names and their
// state are lifted and stubbed; and the door's fresh renewal must keep the queue waiting, not only be read.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const SRC = readPage(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'daimond.js'), 'utf8');
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start); let d = 0, i = brace;
	for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
	return src.slice(start + 1, i);
}
const names = ['drainAfterHeld', 'dispatchInFlight', 'peerHeldTurnOf', 'peerLeaseHeld', 'lapsedByClock', 'confirmLapse', 'leaseDoorRead', 'lapseConfirmed', 'lapseMark'];
const st = { drained: 0, doorReads: 0 };
const NOW = Date.now();
// The cache: argonaut's claim, last renewal seen before the lock, expired 2 minutes ago. The door holds a fresh renewal.
let cached = { holder: 'argonaut', mode: 'running', expiry: NOW - 120000 };
const Lease = {
	holder: (tid) => (cached.expiry > Date.now() ? cached.holder : null),	// peer.js leaseHolder: live by the clock, no grace
	record: () => cached,
	adopt: (m) => { if (m && m.t2) cached = m.t2; return true; },
};
const Sync = { leaseGet: async () => { st.doorReads++; return { leases: { t2: { holder: 'argonaut', mode: 'running', expiry: NOW + 60000 } }, unread: false }; } };
const chat = { id: 'c1', _queue: [{ text: 'and then summarise it', drawn: 'argonaut' }], messages: [
	{ role: 'user', mid: 't2', iturn: 't2', content: 'run the long job' },
	{ role: 'assistant', mid: 'ph-2', iturn: 't2', why: 'dispatched', content: '' }] };
const deps = { window: { DaimondLease: Lease, DaimondSync: Sync }, recoveringHere: () => false, diamondBusy: () => false,
	drainQueue: () => { st.drained++; }, drainSteerQueue() {}, armHeldWake() {}, isLostRow: () => false,
	_peerStopping: {}, PEER_HELD: { claimed: 1, running: 1, blocked: 1, 'awaiting-consent': 1 },
	peerUiStateFor: () => (cached.expiry > Date.now() ? 'running' : 'failed'),	// uiState: "the lease expired mid-run with no report"
	peerReports: {}, _localEnding: {}, _localRecovering: {}, _lapseReading: {}, _lapseRead: {}, diag() {},
	selfDeviceId: () => 'phone', _lostRunOf: {}, lostRetryMid: (t) => t + '-rt' };
globalThis.DaimondLease = Lease;
const keys = Object.keys(deps);
const api = new Function(...keys, names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { drainAfterHeld };')(...keys.map((k) => deps[k]));
api.drainAfterHeld(chat);	// what the overdue wake runs on unlock
await new Promise((r) => setTimeout(r, 20));
console.log('drainQueue calls:', st.drained, '| authoritative lease reads first:', st.doorReads);
const ok = st.drained === 0 && st.doorReads > 0;
console.log(ok ? 'PASS the queue waits for the lease as it stands' : 'FAIL the queued send goes on a cached expiry while the runner still holds t2');
process.exit(ok ? 0 : 1);
