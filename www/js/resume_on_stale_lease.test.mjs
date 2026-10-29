// QA ccp3r (A): R3 through another door. resumeQueue (switchChat) -> drainQueue decides on the cached lease alone,
// never through drainAfterHeld's lapsedByClock/confirmLapse. Same case as R3: phone locked > LEASE_TTL through an
// argonaut turn, on unlock he opens the chat. FAIL = the queued send goes with no door read while the door holds a fresh renewal.
// ADAPTED for the gate (CCP3-QAFIX4): runs over this www/js/daimond.js with no argument, every door on fresh state:
// resume (switchChat), wake (drainAfterHeld), drain (drainQueue itself) and steer (a daimon's drainSteerQueue);
// lifts the confirmation names (`lapseConfirmed`, `lapseMark`, state `_lapseRead`), absent at the base.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(process.argv[2] || join(HERE, 'daimond.js'), 'utf8');
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start); let d = 0, i = brace;
	for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
	return src.slice(start + 1, i);
}
const names = ['resumeQueue', 'drainQueue', 'drainAfterHeld', 'dispatchInFlight', 'peerHeldTurnOf', 'peerLeaseHeld', 'lapsedByClock', 'confirmLapse', 'leaseDoorRead', 'lapseConfirmed', 'lapseMark', 'drainSteerQueue'];
async function run(which) {
	const st = { sent: 0, doorReads: 0 };
	const NOW = Date.now();
	let cached = { holder: 'argonaut', mode: 'running', expiry: NOW - 120000 };
	const Lease = { holder: () => (cached.expiry > Date.now() ? cached.holder : null), record: () => cached, adopt: (m) => { if (m && m.t2) cached = m.t2; return true; } };
	const Sync = { leaseGet: async () => { st.doorReads++; return { leases: { t2: { holder: 'argonaut', mode: 'running', expiry: NOW + 60000 } }, unread: false }; } };
	const chat = { id: 'c1', status: 'active', _queue: [{ text: 'and then summarise it', drawn: 'argonaut' }], messages: [
		{ role: 'user', mid: 't2', iturn: 't2', content: 'run the long job' },
		{ role: 'assistant', mid: 'ph-2', iturn: 't2', why: 'dispatched', content: '' }] };
	const deps = { window: { DaimondLease: Lease, DaimondSync: Sync }, current: chat, chats: [chat], _unloading: false,
		recoveringHere: () => false, diamondBusy: () => false, armHeldWake() {}, isLostRow: () => false,
		sendQueued: async () => { st.sent++; return 'sent'; }, askHolds: () => false, returnQueue() {}, renderQueue() {}, updateQueueBadges() {},
		_peerStopping: {}, PEER_HELD: { claimed: 1, running: 1, blocked: 1, 'awaiting-consent': 1 },
		peerUiStateFor: () => (cached.expiry > Date.now() ? 'running' : 'failed'),
		peerReports: {}, _localEnding: {}, _localRecovering: {}, _lapseReading: {}, _lapseRead: {}, diag() {},
		currentDiamond: { id: 'd1' }, steerQueued: () => { st.sent++; }, journalQueue() {},
		selfDeviceId: () => 'phone', _lostRunOf: {}, lostRetryMid: (t) => t + '-rt' };
	globalThis.DaimondLease = Lease;
	const keys = Object.keys(deps);
	const api = new Function(...keys, names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { resumeQueue, drainAfterHeld, drainQueue, drainSteerQueue };')(...keys.map((k) => deps[k]));
	if (which === 'steer') chat.diamondId = 'd1';
	if (which === 'resume') api.resumeQueue(chat);
	else if (which === 'drain') api.drainQueue(chat, false);
	else if (which === 'steer') api.drainSteerQueue(chat, 'd1', false);
	else api.drainAfterHeld(chat);
	await new Promise((r) => setTimeout(r, 20));
	console.log(which, '| sendQueued calls:', st.sent, '| door reads:', st.doorReads);
	const ok = st.sent === 0 && st.doorReads > 0;
	console.log(ok ? 'PASS the queue waits for the lease as it stands' : 'FAIL the queued send goes on a cached expiry while the runner still holds t2');
	return ok;
}
let all = true;
for (const which of (process.argv[3] ? [process.argv[3]] : ['resume', 'wake', 'drain', 'steer'])) if (!(await run(which))) all = false;
process.exit(all ? 0 : 1);
