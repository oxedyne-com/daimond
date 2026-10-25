// QA ccp3 (A) probe R2: a send queued behind a hand-off (sendPressed -> dispatchInFlight -> enqueueMessage, or behind a
// non-empty queue, 787a84e26) is held only in tab memory. `journalQueue` writes only while a turn runs HERE
// (`chat._generating`), and a hand-off is not one; `giveUpSent` -> `clearComposer` has already emptied the box and
// dropped the stored draft. A reload, a phone's tab discard or the poison reload then leaves no copy of his words.
// Run: node <this> <daimond.js>. FAIL = after the enqueue no durable store holds the words.
// ADAPTED for the gate (CCP3-QAFIX3): runs over www/js/daimond.js with no argument, and the journal stub takes
// the chat's own queue record (`chatQueue`, journal.js since 05b532b4b) beside the turn's `queueSet`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const SRC = readFileSync(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'daimond.js'), 'utf8');
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start); let d = 0, i = brace;
	for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
	return src.slice(start + 1, i);
}
const names = ['enqueueMessage', 'journalQueue', 'queuedText', 'giveUpSent', 'clearComposer'];
const WORDS = 'and then summarise it for Fred';
const drafts = { 'chat:c1': WORDS }, journal = [];
const chatInput = { value: WORDS, style: {}, dataset: { draftKey: 'chat:c1' } };
// t2 is out on argonaut (a hand-off: nothing runs here). The last Here turn's journal id is left from before.
const chat = { id: 'c1', _jturn: 'old-turn', _generating: false, messages: [] };
const deps = {
	window: { DaimondJournal: { queueSet: (t, c, items) => journal.push([t, c, items]), chatQueue: (c, items) => journal.push(['chat', c, items]) },
		DaimondDrafts: { set: (k, v) => { drafts[k] = v; }, get: (k) => drafts[k], drop: (k) => { delete drafts[k]; } } },
	diag() {}, syncSendMode() {}, renderQueue() {}, fitComposer() {}, chatInput, chatDraftKey: (c) => c ? 'chat:' + c.id : '',
	current: chat,
};
globalThis.DaimondJournal = deps.window.DaimondJournal; globalThis.DaimondDrafts = deps.window.DaimondDrafts;
const keys = Object.keys(deps);
const api = new Function(...keys, names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { enqueueMessage };')(...keys.map((k) => deps[k]));
api.enqueueMessage(chat, WORDS, WORDS, 'argonaut');
const durable = journal.some((j) => JSON.stringify(j[2]).includes(WORDS)) || Object.values(drafts).some((v) => String(v).includes(WORDS));
console.log('queue in memory:', JSON.stringify(chat._queue), '| journal writes:', JSON.stringify(journal), '| drafts:', JSON.stringify(drafts), '| box:', JSON.stringify(chatInput.value));
console.log(durable ? 'PASS a reload finds the queued words' : 'FAIL a reload loses the queued words: only tab memory holds them');
process.exit(durable ? 0 : 1);
