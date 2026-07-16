// verify_durability.mjs — a turn cut off by the tab dying loses nothing but the split-second in
// flight, and can be continued.
//
// Before the write-ahead journal, a browser closed mid-turn lost the whole turn — the prompt
// included — because the transcript was saved only when the turn FINISHED. This drives the real
// failure: it sends a slow reply, RELOADS the page mid-stream (which kills the in-flight fetch
// exactly as a crash would), and then checks that on the next boot the prompt and the partial
// reply are both there, badged interrupted, with a Continue button that runs it again.
//
// It also checks the other side of the ledger: a turn that COMPLETED normally leaves nothing
// behind — its journal is pruned — so a completed turn never masquerades as interrupted.
import { open, signInAs, connectMock, chat, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
// Poll a page-side predicate rather than sleeping a fixed time: the timing windows here are real
// (a turn in flight, recovery having run) but their duration varies with machine load, so waiting
// on the CONDITION is what keeps the test honest and stable.
async function until(page, fn, ms = 12000, step = 150) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await page.evaluate(fn)) return true;
		await page.waitForTimeout(step);
	}
	return false;
}

const s = await open({ name: 'durability', connect: false, signIn: false, profile: '/tmp/daimond-durability-profile' });
const p = s.page;
p.on('dialog', d => d.accept().catch(() => {}));   // a beforeunload warning must not block the reload
await p.waitForTimeout(1500);
await signInAs(s, 'Dura');
await p.waitForTimeout(500);
await connectMock(s);
await p.waitForTimeout(700);

// ── A completed turn leaves nothing behind ──────────────────────────────

await chat(s, '@text a normal complete answer');
const afterComplete = await p.evaluate(async () => {
	const r = await window.DaimondJournal.recover();
	return { interruptedChats: r.turns.length };
});
check('a completed turn is pruned from the journal — nothing to recover',
	afterComplete.interruptedChats === 0, String(afterComplete.interruptedChats));

// ── Start a slow turn, then simulate a crash mid-stream ─────────────────

await p.evaluate(() => {
	const box = document.getElementById('chat-input');
	box.value = '@long 90';                       // 90 chunks at ~120ms each = a turn that stays in flight for ~10s
	box.dispatchEvent(new Event('input', { bubbles: true }));
	document.getElementById('chat-send').click();
});
// Wait until the turn is genuinely in flight with some reply streamed — poll, don't guess.
await until(p, () => {
	const b = document.getElementById('chat-send');
	const generating = /stop/i.test((b.getAttribute('title') || '') + b.className);
	return generating && /chunk-1/.test(document.getElementById('chat-output').innerText);
});

const midTurn = await p.evaluate(async () => {
	const generating = /stop/i.test((document.getElementById('chat-send').getAttribute('title') || '') + document.getElementById('chat-send').className);
	// The prompt is already durable (persist-first), before the turn has finished.
	const snap = JSON.parse(localStorage.getItem('daimond-chats') || '[]');
	const msgs = (snap[0] && snap[0].messages) || [];
	const hasPrompt = msgs.some(m => m.role === 'user' && /@long 90/.test(m.content || ''));
	// The journal holds the open turn with its partial reply.
	const r = await window.DaimondJournal.recover();
	const t = r.turns[0];
	return { generating, hasPrompt, partial: t ? t.text : '', hasChunks: t ? /chunk-1/.test(t.text) : false };
});
check('the turn is genuinely in flight when we pull the plug', midTurn.generating === true);
check('the prompt is ALREADY durable mid-turn (persist-first)', midTurn.hasPrompt === true);
check('the journal holds the partial reply as it streams', midTurn.hasChunks === true,
	midTurn.partial.slice(0, 40));

// The crash: reload kills the in-flight fetch and everything in memory, exactly as closing the
// browser would.
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
await signInAs(s, 'Dura');                        // unlock again
// Wait until recovery has folded the interrupted turn back in, rather than assuming a duration.
await until(p, () => !!document.querySelector('.chat-msg.interrupted, .ti-continue'));

// ── After the crash: the turn is recovered, badged, continuable ─────────

const recovered = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const text = out ? out.innerText : '';
	return {
		hasPrompt: /@long 90/.test(text),
		hasPartial: /chunk-1/.test(text),
		interruptedBadge: !!out.querySelector('.chat-msg.interrupted'),
		continueBtn: !!out.querySelector('.ti-continue'),
	};
});
check('after the crash, the prompt survived', recovered.hasPrompt === true);
check('after the crash, the partial reply survived', recovered.hasPartial === true);
check('the recovered turn is badged interrupted', recovered.interruptedBadge === true);
check('and it offers a Continue button', recovered.continueBtn === true);

// The journal was pruned once recovery folded the turn into the snapshot, so a SECOND reload does
// not recover it twice.
const doubleReload = await p.evaluate(async () => {
	const r = await window.DaimondJournal.recover();
	return r.turns.length;
});
check('recovery is one-shot — the journal is cleared once folded in', doubleReload === 0, String(doubleReload));

// ── Continue re-runs the turn ───────────────────────────────────────────

await p.evaluate(() => document.querySelector('.ti-continue').click());
// The interrupted attempt is dropped immediately; the re-run starts generating shortly after.
const interruptedGone = await p.evaluate(() => !document.querySelector('.chat-msg.interrupted'));
const started = await until(p, () => {
	const b = document.getElementById('chat-send');
	return /stop/i.test((b.getAttribute('title') || '') + b.className);
});
check('Continue starts the turn running again', started === true);
check('and drops the interrupted attempt it is replacing', interruptedGone === true);

// Stop the re-run so it settles as a completed (stopped) turn, keeping the test quick.
await p.evaluate(() => { const b = document.getElementById('chat-send'); if (/stop/i.test((b.getAttribute('title') || '') + b.className)) b.click(); });
await until(p, () => { const b = document.getElementById('chat-send'); return !/stop/i.test((b.getAttribute('title') || '') + b.className); });
await p.waitForTimeout(400);

// ── The Finding-1 regression: a continued turn must NOT resurrect ───────
//
// Continue filters the interrupted turn from the in-memory array, but the snapshot is an
// append-only UNION — without a tombstone the merge silently re-adds the removed messages, so on
// the next reload the interrupted turn (duplicate prompt, stale Continue button, partial re-fed as
// history) comes back. This is the exact bug; reload once more and prove it stays gone.
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
await signInAs(s, 'Dura');
await p.waitForTimeout(1500);
const afterSecondReload = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const text = out ? out.innerText : '';
	const prompts = (text.match(/@long 90/g) || []).length;
	return { prompts, staleInterrupted: !!out.querySelector('.chat-msg.interrupted'), staleContinue: !!out.querySelector('.ti-continue') };
});
check('a continued turn does not resurrect on the next reload — the prompt appears once',
	afterSecondReload.prompts === 1, 'x' + afterSecondReload.prompts);
check('no stale "Interrupted" badge survives a continue', afterSecondReload.staleInterrupted === false);
check('no stale Continue button survives a continue', afterSecondReload.staleContinue === false);

const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
check('nothing throws through the crash and recovery', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
