// QA r572y C2b F2: the pre-claim wait judged the runner's stored copy only and waited the whole bound although
// the errand's own seed completes the thread. A copy the seed completes is ready at once (seq 223 kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { loadPeer } from './c2ready_common.mjs';
const DP = loadPeer();
const asker = { id: 'c1', _loaded: true, messages: [
	{ role: 'user', content: 'q', mid: 'm1', ts: 10 },
	{ role: 'assistant', content: 'a (answered on the phone)', mid: 'm2', ts: 20 },
	{ role: 'user', content: 'and then?', mid: 'T', ts: 30 } ] };
// The older-sender variants carry no `through` key (C2 r2 F4): the copy-only fingerprint arm waited the bound.
for (const variant of ['runner holds m1 only', 'runner has never seen the chat', 'runner holds m1 only, older sender', 'runner has never seen the chat, older sender']) {
	test(variant + ': ready at once, nothing lacked', async () => {
		const errand = DP.buildDispatch(asker, { turnId: 'T', chatId: 'c1', prompt: 'and then?', by: 'phone', now: 40 }).errand(0);
		if (variant.endsWith('older sender')) delete errand.through;
		const live = { id: 'c1', _loaded: true, messages: [{ role: 'user', content: 'q', mid: 'm1', ts: 10 }] };
		const chats = variant.startsWith('runner holds') ? [live] : [];
		const win = makeWindow({}); win.setTimeout = setTimeout; win.Date = Date;
		win.DaimondPeer = DP;
		win.DaimondSync = { version: () => 1, pull: async () => {} };	// the parcel has not arrived yet
		const R = loadPage({ window: win, want: ['peerReady', 'lackedNote', 'syncHeld', 'THROUGH_WAIT_MS', 'throughDeadline'], stub: {
			diag() {}, chats, loadChatMessages: async () => {}, onChatsChangedElsewhere: async () => {} } });
		const t0 = Date.now();
		const v = await R.peerReady(errand, [], 3000);
		const dt = Date.now() - t0;
		assert.ok(dt < 500, 'waited ' + dt + ' ms');
		assert.equal(v.lacked, '');
	});
}
