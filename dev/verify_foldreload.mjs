// verify_foldreload.mjs — does a folded conversation stay folded across a reload?
//
// Compaction replaces the earlier part of a conversation with one notice when it
// outgrows the model's context window. It reported that the fold did not survive a
// reload: `restore` rebuilt the session from the FULL, untouched screen transcript,
// so a reloaded chat sprang back to its unfolded size and paid for another summary
// on the next turn — for ever, since nothing it did could make the transcript
// smaller.
//
// The two halves interlock. The fold notice is deliberately a `user`-role message
// because `restore` drops system ones; and the session store this asserts against
// is what makes the fold durable, because what it stores is the agent's own message
// list AFTER folding, not the screen's before it.
//
// So: three things, read from the mock provider's own log.
//   - the fold happened, and the user was told
//   - what it replaced is gone from the request
//   - after a reload, still gone, and the notice is still there
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099).
import { open, chat, signInAs, clearMockLog, mockLog, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const NAME = 'foldreload';
const MARK = 'ZEBRAFISH-THE-FIRST-THING-SAID';
const s = await open({ name: NAME });
const p = s.page;

// A window small enough that a handful of turns will not fit. Stubbed on the
// pricing table, which is where `ensureApp` asks — the app's own path is exercised,
// including the setter that carries the figure into the wasm.
await p.evaluate(() => {
	window.DaimondPricing.contextWindow = function () { return 3000; };
});

clearMockLog();
await chat(s, '@text ' + MARK);
// Many small turns rather than a few large ones. `tail_start` keeps at least
// MIN_KEEP_MESSAGES (6), so a conversation of a few enormous messages has nothing
// it is allowed to cut and compaction falls back to shortening instead — which is
// a real behaviour, but not the one this is about.
for (let i = 0; i < 14; i++) {
	await chat(s, '@text turn ' + i + ' ' + 'padding '.repeat(30));
}

const folded = await p.evaluate(() => ({
	onScreen: !!document.querySelector('.chat-msg-compacted'),
	text:     (document.querySelector('.chat-msg-compacted') || {}).innerText || '',
}));
check('the conversation was folded, and the user was told where it happened',
	folded.onScreen, folded.text.replace(/\n/g, ' / ').slice(0, 110));
check('the notice says what it is and how much went, not merely that something happened',
	/folded/i.test(folded.text) && /\d+\s+earlier messages/i.test(folded.text),
	folded.text.replace(/\n/g, ' / ').slice(0, 140));

const before = mockLog();
const lastBefore = before[before.length - 1] || { messages: [] };
// Outside the fold notice. The mock's summariser echoes its own prompt back, so
// the notice quotes the conversation it replaced verbatim — a fixture artefact, and
// a real summary would not. What is asked is whether the ORIGINAL messages are
// still being sent, so the notice is excluded from the search.
const isNotice = (m) => String(m.content || '').startsWith('[Daimond folded the earlier part');
const stillThere = (req) => (req.messages || []).some(m => !isNotice(m) && String(m.content || '').includes(MARK));
check('and the first thing said is no longer in the request',
	!stillThere(lastBefore), `${(lastBefore.messages || []).length} messages`);
check('while the notice that replaced it is',
	JSON.stringify(lastBefore.messages || []).includes('Daimond folded the earlier part'));

// ── The reload ────────────────────────────────────────────────────────────

await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
await signInAs(s, NAME);
await p.waitForTimeout(1000);
// The stub does not survive a reload, and must not: the point is that the FOLD
// survives, not that the window is still small.
await p.evaluate(() => {
	const b = [...document.querySelectorAll('#session-list .chat-box')][0];
	if (b) b.click();
});
await p.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
await p.waitForTimeout(600);

const drawn = await p.evaluate(() => !!document.querySelector('.chat-msg-compacted'));
check('the fold is still drawn in the reloaded thread', drawn);

clearMockLog();
await chat(s, '@text after the reload');
const after = mockLog();
const lastAfter = after[after.length - 1] || { messages: [] };
check('the reloaded chat sent something', after.length > 0, `${after.length} requests`);
check('what the fold replaced does NOT come back',
	!stillThere(lastAfter),
	stillThere(lastAfter) ? 'the conversation sprang back to full size' : `${(lastAfter.messages || []).length} messages`);
check('and the notice survived the reload with it',
	JSON.stringify(lastAfter.messages || []).includes('Daimond folded the earlier part'));

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
