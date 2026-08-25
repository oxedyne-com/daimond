// probe_askav.mjs — a model asks the owner a question, and he answers with one tap.
//
// The whole path in the real page: the model calls `ask`, the card is drawn in the thread,
// a tap sends the answer, and the turn that asked has ALREADY ENDED. Then a reload, to prove
// the question survives the tab and that an answered one comes back answered.
import { open, chat, mockLog, clearMockLog, contentText, connectMock, transcript, shot, signInAs } from './harness.mjs';

const Q = {
	question: 'Which store should the drafts live in?',
	options: [
		{ label: 'OPFS',  means: 'Drafts stay on this device only. Nothing to pay, and a lost laptop is a lost draft.' },
		{ label: 'Cloud', means: 'Drafts sync to your other devices. Needs Pro, and the bytes are billed.' },
	],
	recommend: 'OPFS',
	why: 'You write on one machine and have said twice that you do not want another bill.',
	if_silent: 'I will use OPFS and say so in the commit message.',
	n: 1, of: 3,
};

const s = await open({ name: 'askav', defaults: false });
const { page } = s;
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 200)));
await page.waitForTimeout(1500);
await connectMock(s);
await chat(s, 'hello');
await page.waitForTimeout(400);

const out = {};

// ── 1. The model asks ────────────────────────────────────────────────
clearMockLog();
await chat(s, '@tool ask ' + JSON.stringify(Q));
await page.waitForTimeout(600);

out.card = await page.evaluate(() => {
	const c = document.querySelector('.ask-card');
	if (!c) return null;
	return {
		role:   c.getAttribute('role'),
		count:  (c.querySelector('.ask-count') || {}).textContent || '',
		q:      (c.querySelector('.ask-q') || {}).textContent || '',
		opts:   [...c.querySelectorAll('.ask-opt')].map(b => ({
			label: (b.querySelector('.ask-label') || {}).textContent || '',
			rec:   b.classList.contains('recommended'),
			badge: (b.querySelector('.ask-rec') || {}).textContent || '',
			means: (b.querySelector('.ask-means') || {}).textContent || '',
		})),
		why:    (c.querySelector('.ask-why') || {}).textContent || '',
		silent: (c.querySelector('.ask-silent') || {}).textContent || '',
		other:  !!c.querySelector('.ask-other-open'),
		// A permission prompt is a modal over a scrim. A question must not be one.
		modal:  !!document.querySelector('.modal.dlg'),
	};
});
// ROUNDS. `@tool` normally makes two requests: the one that returns the call, and the one
// that returns the text afterwards. A turn that ends on the question makes ONE.
out.rounds = mockLog().length;
// And the result the model was handed, which it never got to read because the turn ended --
// but which is in the record, and is what the NEXT turn reads.
out.result = await page.evaluate(() => {
	const c = window.DaimondChats && DaimondChats.current ? DaimondChats.current() : null;
	return null;
});
await shot(s, 'askav-1-question');

// THE CONTROL on that number. A tool that does NOT end the turn makes two requests, so
// `rounds: 1` above is a measurement rather than a coincidence of this harness.
clearMockLog();
await chat(s, '@tool file_list {"path":"."}');
await page.waitForTimeout(400);
out.roundsControl = mockLog().length;

// ── 2. One tap ───────────────────────────────────────────────────────
clearMockLog();
await page.evaluate(() => document.querySelector('.ask-card .ask-opt.recommended').click());
await page.waitForTimeout(2500);
out.afterTap = await page.evaluate(() => {
	const c = document.querySelector('.ask-card');
	return {
		answered: !!(c && c.dataset.answered),
		done:     c ? ((c.querySelector('.ask-done') || {}).textContent || '') : '',
		buttons:  c ? c.querySelectorAll('.ask-opt').length : -1,
		live:     c ? c.querySelectorAll('.ask-opt:not(:disabled)').length : -1,
		chosen:   c ? ((c.querySelector('.ask-opt.chosen .ask-label') || {}).textContent || '') : '',
	};
});
// What the model got. The user message on the wire is the answer.
out.sent = mockLog().flatMap(r => (r.messages || [])
	.filter(m => m.role === 'user')
	.map(m => contentText(m.content)))
	.filter(t => /^(Chose|Other): /.test(t));
// And what the tool handed the model, which the NEXT turn reads: it rides in the same
// request as the answer.
out.toolResult = mockLog().flatMap(r => (r.messages || [])
	.filter(m => m.role === 'tool').map(m => contentText(m.content)))
	.filter(t => /^Asked\./.test(t));
await shot(s, 'askav-2-answered');

// ── 3. A reload ──────────────────────────────────────────────────────
await page.reload();
await page.waitForFunction(() => !!window.DaimondCore, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
// A reload lands on the passphrase gate: the tab really did close, as far as the app
// is concerned, which is the case being tested.
if (await page.$('#id-primary')) { await signInAs(s, 'askav'); }
await page.waitForTimeout(3000);
// And back into the chat that holds the question, the way a person gets there.
await page.evaluate(() => {
	const row = document.querySelector('#session-list .session-item, .rail-item');
	if (row) row.click();
});
await page.waitForTimeout(2000);
out.afterReload = await page.evaluate(() => {
	const c = document.querySelector('.ask-card');
	return c ? {
		present:  true,
		answered: !!c.dataset.answered,
		done:     (c.querySelector('.ask-done') || {}).textContent || '',
		buttons:  c.querySelectorAll('.ask-opt').length,
		live:     c.querySelectorAll('.ask-opt:not(:disabled)').length,
		q:        (c.querySelector('.ask-q') || {}).textContent || '',
	} : { present: false };
});
await shot(s, 'askav-3-reloaded');

// ── 4. A second question, rejected in his own words ──────────────────
clearMockLog();
const Q2 = Object.assign({}, Q, { question: 'Shall I rename the field?', n: 2,
	options: [{ label: 'Rename it', means: 'Every caller changes today.' },
	          { label: 'Leave it',  means: 'Nothing changes and the name stays wrong.' }],
	recommend: 'Leave it' });
await chat(s, '@tool ask ' + JSON.stringify(Q2));
await page.waitForTimeout(600);
out.second = await page.evaluate(() => {
	const cs = [...document.querySelectorAll('.ask-card')];
	return { cards: cs.length, live: cs.filter(c => !c.dataset.answered).length };
});
clearMockLog();
await page.evaluate(() => {
	const c = [...document.querySelectorAll('.ask-card')].filter(x => !x.dataset.answered).pop();
	c.querySelector('.ask-other-open').click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
	const c = [...document.querySelectorAll('.ask-card')].filter(x => !x.dataset.answered).pop();
	const box = c.querySelector('.ask-other-box');
	box.value = 'Neither — split it in two and keep both names.';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	c.querySelector('.ask-other-go').click();
});
await page.waitForTimeout(2500);
out.other = mockLog().flatMap(r => (r.messages || [])
	.filter(m => m.role === 'user').map(m => contentText(m.content)))
	.filter(t => /^Other: /.test(t));
await shot(s, 'askav-4-other');

// ── 5. Two questions in one turn: the second is refused ──────────────
clearMockLog();
await chat(s, '@tools ask ' + JSON.stringify(Q) + ' ;; ask ' + JSON.stringify(Q2));
await page.waitForTimeout(800);
out.twoInOneTurn = await page.evaluate(() => {
	const cs = [...document.querySelectorAll('.ask-card')].filter(x => !x.dataset.answered);
	return { live: cs.length, last: cs.length ? (cs[cs.length-1].querySelector('.ask-q')||{}).textContent : '' };
});
out.tail = (await transcript(s)).slice(-500);
await shot(s, 'askav-5-two');

out.errs = errs;

// ── What has to be true ──────────────────────────────────────────────
//
// Written as checks with an exit code rather than as a dump to read, because a probe
// whose result is a human squinting at JSON is a probe that passes the day it stops
// working.
const bad = [];
const ok = (cond, why) => { if (!cond) bad.push(why); };
ok(out.card, 'no question card was drawn at all');
if (out.card) {
	ok(out.card.role === 'group' && !out.card.modal,
		'the question is a modal dialog, which is what a PERMISSION prompt is');
	ok(out.card.count === 'Decision 1 of 3', 'the card does not say how many decisions follow');
	ok(out.card.opts.length === 2, 'the options were not drawn as buttons');
	ok(out.card.opts.filter(o => o.rec).length === 1 && out.card.opts[0].rec,
		'the recommendation is not marked, so it is implied by ordering or not at all');
	ok(/RECOMMENDED/i.test(out.card.opts[0].badge),
		'the recommendation is marked by colour alone, which a red-green reader cannot see');
	ok(out.card.opts.every(o => o.means.length > 20),
		'an option is a bare label, so it names a category rather than a consequence');
	ok(/another bill/.test(out.card.why), 'the reason for the recommendation is not on the card');
	ok(/commit message/.test(out.card.silent),
		'what happens if he says nothing is not on the card, so silence is not a knowing answer');
	ok(out.card.other, 'there is no way to reject every option');
}
// THE MEASUREMENT AND ITS CONTROL. A tool that does not end the turn costs two requests;
// this one costs one. Both halves, so the number means something.
ok(out.rounds === 1, `the turn went round again after asking: ${out.rounds} request(s)`);
ok(out.roundsControl === 2,
	`the control is wrong: an ordinary tool took ${out.roundsControl} request(s), not 2, so ` +
	'the figure above proves nothing');
ok(out.afterTap.answered && out.afterTap.buttons === 2 && out.afterTap.live === 0,
	`an answered card still offers its buttons, or has thrown the alternatives away: ${JSON.stringify(out.afterTap)}`);
ok(out.afterTap.chosen === 'OPFS',
	`the option he chose is not marked on the card: ${out.afterTap.chosen}`);
ok(out.sent.length === 1 && out.sent[0] === 'Chose: OPFS',
	`the tap did not reach the model as an answer: ${JSON.stringify(out.sent)}`);
ok(out.toolResult.length === 1 && /Chose:/.test(out.toolResult[0]) && /Other:/.test(out.toolResult[0]),
	'the model was not told the two shapes its answer arrives in');
// THE RELOAD, which is the whole durability claim: the tab really did go.
ok(out.afterReload.present && /drafts live in/.test(out.afterReload.q),
	'the question did not survive the reload');
ok(out.afterReload.answered && out.afterReload.live === 0 && out.afterReload.buttons === 2,
	`a question already answered came back offering its buttons, or without them: ${JSON.stringify(out.afterReload)}`);
ok(out.other.length === 1 && /^Other: Neither/.test(out.other[0]),
	`an answer in his own words did not reach the model as the answer: ${JSON.stringify(out.other)}`);
ok(out.twoInOneTurn.live === 1,
	`two questions were put in one turn: ${out.twoInOneTurn.live} card(s) live`);
ok(errs.length === 0, `the page threw: ${errs.join(' | ')}`);

console.log(JSON.stringify(out, null, 1));
if (bad.length) {
	console.log('\nprobe_askav: FAILED');
	bad.forEach(b => console.log('  - ' + b));
} else {
	console.log('\nprobe_askav: the model asked, he tapped once, and the answer reached the model.');
}
await s.close();
process.exit(bad.length ? 1 : 0);
