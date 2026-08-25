// probe_askdaimon.mjs — the errand as the owner runs it: `/decisions` at a daimon,
// a question with options, one tap, and the daimon carries on with the answer.
//
// Two legs, split at the one seam a mock cannot cross. A mock cannot DECIDE to call a
// tool, so leg 1 asks what `/decisions` actually put in front of the model, and leg 2
// makes the model call `ask` and follows the card, the tap and what came back.
import { open, connectMock, mockLog, clearMockLog, contentText, shot } from './harness.mjs';

const Q = {
	question: 'Where should the parcel be signed?',
	options: [
		{ label: 'On the device',  means: 'The key never leaves this laptop. Losing it loses the ability to sign, and nothing else.' },
		{ label: 'In the gateway', means: 'Any device can sign. Oxedyne holds a key that can speak in your name.' },
	],
	recommend: 'On the device',
	why: 'You have said the whole point of Daimond is that Oxedyne cannot read or speak for you.',
	if_silent: 'I will keep signing on the device and note the choice in the crystal.',
	n: 1, of: 2,
};

let bad = [];
const ok = (c, why, d) => { console.log((c ? '  ok   ' : '  FAIL ') + why + (d != null ? ' — ' + d : '')); if (!c) bad.push(why); };

const s = await open({ name: 'askdaimon', defaults: false });
const { page: p } = s;
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 200)));
await p.waitForTimeout(1500);
await connectMock(s);

// A Diamond, opened on its chat face, which is where the owner types.
await p.evaluate(() => document.getElementById('new-diamond-btn').click());
await p.waitForSelector('.dlg-card', { timeout: 8000 });
await p.evaluate(() => {
	const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
	const inp = card.querySelector('input.dlg-input');
	inp.value = 'Sync';
	inp.dispatchEvent(new Event('input', { bubbles: true }));
	card.querySelector('.dlg-ok').click();
});
await p.waitForTimeout(1200);
await p.click('#dview-chat');
await p.waitForTimeout(700);
const say = async (text, ms = 5000) => {
	await p.fill('#chat-input', text);
	await p.click('#chat-send');
	await p.waitForTimeout(ms);
};

// ══ 1. `/decisions` reaches the daimon, and it names the tool ═══════
clearMockLog();
await say('/decisions');
const sent = mockLog().flatMap(r => (r.messages || []).map(m => contentText(m.content))).join('\n');
ok(/decisions/.test(sent) && /ONE AT A TIME/.test(sent),
	'the skill reached the daimon', sent.length + ' chars on the wire');
ok(/`ask` tool/.test(sent),
	'and it tells the daimon to use the tool rather than write the question in prose');
for (const f of ['question', 'options', 'recommend', 'why', 'if_silent']) {
	ok(new RegExp('`' + f + '`').test(sent), `it names the field \`${f}\``);
}
ok(/`Chose:`/.test(sent) && /`Other:`/.test(sent),
	'and says how the answer comes back, including a rejection of every option');
// And the tool is really in this daimon's belt, not only in its instructions. A skill
// that names a tool the registry does not carry teaches a call that will be refused.
const schemas = mockLog().map(r => JSON.stringify(r.tools || [])).join('');
ok(/"ask"/.test(schemas), 'and the daimon was actually handed the tool');

// ══ 2. The daimon asks, he taps, and it carries on ═════════════════
clearMockLog();
await say('@tool ask ' + JSON.stringify(Q), 6000);
const card = await p.evaluate(() => {
	const c = document.querySelector('#chat-output .ask-card');
	return c ? {
		q: (c.querySelector('.ask-q') || {}).textContent || '',
		opts: [...c.querySelectorAll('.ask-opt')].map(b => ({
			label: (b.querySelector('.ask-label') || {}).textContent || '',
			rec: b.classList.contains('recommended') })),
		modal: !!document.querySelector('.modal.dlg'),
	} : null;
});
ok(!!card, 'the question is drawn in the DAIMON\'s thread');
ok(!!card && /parcel be signed/.test(card.q), 'and it is this question', card && card.q);
ok(!!card && card.opts.length === 2 && card.opts[0].rec,
	'with its options as buttons and the recommendation marked');
ok(!!card && !card.modal, 'and it is not a permission dialog');
ok(mockLog().length === 1, 'the daimon\'s turn ended on the question', mockLog().length + ' request(s)');
await shot(s, 'askdaimon-1-question');

clearMockLog();
await p.evaluate(() => document.querySelector('#chat-output .ask-card .ask-opt.recommended').click());
await p.waitForTimeout(5000);
const answered = mockLog().flatMap(r => (r.messages || [])
	.filter(m => m.role === 'user').map(m => contentText(m.content)))
	.filter(t => /^Chose: /.test(t));
ok(answered.length === 1 && answered[0] === 'Chose: On the device',
	'one tap steered the daimon with his answer', JSON.stringify(answered));
// AND THE DAIMON CARRIED ON: a fresh turn ran on the answer, in the same conversation,
// with the question it asked still in front of it.
const carried = mockLog().length >= 1 && /parcel be signed/.test(
	mockLog().map(r => JSON.stringify(r.messages || [])).join(''));
ok(carried, 'and it carried on with the question it had asked still in its context');
const thread = await p.evaluate(() => {
	const c = document.querySelector('#chat-output .ask-card');
	return { answered: !!(c && c.dataset.answered),
		done: c ? ((c.querySelector('.ask-done') || {}).textContent || '') : '',
		msgs: [...document.querySelectorAll('#chat-output .chat-msg-user')].map(n => n.textContent.trim()).slice(-2) };
});
ok(thread.answered && /On the device/.test(thread.done),
	'and the card says what he answered', thread.done);
await shot(s, 'askdaimon-2-answered');

ok(errs.length === 0, 'nothing was thrown', errs.join(' | '));
console.log(bad.length ? `\nprobe_askdaimon: ${bad.length} failed.` : '\nprobe_askdaimon: all checks passed');
await s.close();
process.exit(bad.length ? 1 : 0);
