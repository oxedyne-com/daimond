// QA ccp3r (A): the queue handed back to the box (returnQueue: the turn it waited on failed or was stopped; or
// unqueue(i, true) to edit it) clears the queue's durable record (renderQueue -> journalQueue) but writes no draft:
// a value set by code fires no 'input', so drafts.js never stores it. A reload before a keystroke then loses the words.
// Real journal.js (journalfixture). Run: node <this> <www/js dir> [return|edit]
// ADAPTED for the gate (CCP3-QAFIX4): runs over this www/js with no argument, both ways out (return, edit) each
// on fresh state; lifts the one composer intake (`intoComposer`), absent at the base.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] || HERE, hows = process.argv[3] ? [process.argv[3]] : ['return', 'edit'];
const { fakeIDB, tabJournal } = await import(DIR + '/journalfixture.mjs');
const SRC = readPage(DIR + '/daimond.js', 'utf8');
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start); let d = 0, i = brace;
	for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
	return src.slice(start + 1, i);
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const WORDS = 'and then summarise it for Fred';
async function run(how) {
	const idb = fakeIDB(), locks = new Set(), drafts = {};
	const Drafts = { set: (k, v) => { if (v) drafts[k] = v; else delete drafts[k]; }, get: (k) => drafts[k], drop: (k) => { delete drafts[k]; } };
	const JA = tabJournal(idb, locks); await tick();
	const box = { value: '', style: {}, dataset: { draftKey: 'chat:c1' }, focus() {} };
	const chat = { id: 'c1', _generating: false, messages: [], _queue: [] };
	const deps = { window: { DaimondJournal: JA, DaimondDrafts: Drafts }, DaimondJournal: JA, DaimondDrafts: Drafts, current: chat, chatInput: box,
		diag() {}, fitComposer() {}, syncSendMode() {}, toast() {}, t: (k) => k, chatDraftKey: (c) => 'chat:' + c.id };
	const ks = Object.keys(deps);
	const A = new Function(...ks, ['returnQueue', 'unqueue', 'putInComposer', 'intoComposer', 'journalQueue', 'queuedText'].map((n) => lift(SRC, n)).join('\n')
		+ '\nfunction renderQueue() { journalQueue(current); }\nreturn { returnQueue, unqueue, journalQueue };')(...ks.map((k) => deps[k]));
	chat._queue.push({ text: WORDS, drawn: 'argonaut' }); A.journalQueue(chat); await tick(60);
	const before = (await tabJournal(idb, new Set()).recover()).queues.length;	// a reload now would find it
	if (how === 'edit') A.unqueue(0, true); else A.returnQueue(chat);
	await tick(60);
	locks.clear();
	const rec = await tabJournal(idb, locks).recover();
	console.log(how, '| durable before:', before, '| box', JSON.stringify(box.value), '| after reload: queues', rec.queues.length, '| drafts', JSON.stringify(drafts));
	const ok = rec.queues.length > 0 || Object.values(drafts).some((v) => v.includes(WORDS));
	console.log(ok ? 'PASS' : 'FAIL the words are only in the box: a reload before a keystroke loses them');
	return ok;
}
let all = true;
for (const how of hows) if (!(await run(how))) all = false;
process.exit(all ? 0 : 1);
