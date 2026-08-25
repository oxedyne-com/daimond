// probe_skillsau.mjs — the three pieces of lane AU, walked in the real page.
//
//   1. A fresh store gets a seeded `DAIMOND.md`, the chip says so, and the text
//      reaches the model as the user's standing instructions.
//   2. Every chat and daimon request carries the skills note.
//   3. `/status` and `/decisions` resolve in a workspace with no skills file, and
//      the shipped text reaches the provider named as shipped.
import { open, chat, mockLog, clearMockLog, contentText, connectMock } from './harness.mjs';

const s = await open({ name: 'skillsau', defaults: false });
const { page } = s;
await page.waitForTimeout(1500);

const out = {};

// ── 1. DAIMOND.md ────────────────────────────────────────────────
out.seeded = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	let stored = null;
	try { stored = await m.store_read('DAIMOND.md'); } catch (e) { stored = 'ERR ' + e; }
	return {
		flag:   (() => { try { return localStorage.getItem('daimond.instructions.seeded'); } catch (e) { return 'no-storage'; } })(),
		bytes:  typeof stored === 'string' ? stored.length : null,
		head:   typeof stored === 'string' ? stored.slice(0, 60) : String(stored),
		names:  typeof stored === 'string' ? /\/status/.test(stored) && /\/handover/.test(stored) : false,
	};
});
// The chip: open the Workspace panel so it is drawn, then read it.
out.chip = await page.evaluate(() => {
	const el = document.getElementById('instructions-chip');
	if (!el) return { there: false };
	return { there: true, display: el.style.display, text: el.textContent, title: el.title,
		empty: el.getAttribute('data-empty') };
});

await connectMock(s);
clearMockLog();

// ── 2 and 3. The wire ────────────────────────────────────────────
await chat(s, '/status');
let log = mockLog();
const sys = (r) => contentText((r.messages || []).find(m => m.role === 'system')?.content || '');
const usr = (r) => (r.messages || []).filter(m => m.role === 'user').map(m => contentText(m.content)).join('\n');
out.status = log.length ? {
	requests:    log.length,
	skillsNote:  /## Skills/.test(sys(log[0])),
	notesNamed:  /handover, pickup, status/.test(sys(log[0])),
	standing:    /Standing instructions from the user/.test(sys(log[0])),
	seedOnWire:  /How to answer me/.test(sys(log[0])),
	shippedPath: /daimond:skills\/status\.md/.test(usr(log[0])),
	fiveLines:   /five lines or fewer/.test(usr(log[0])),
	required:    /Required from you:/.test(usr(log[0])),
} : { requests: 0 };

clearMockLog();
await chat(s, '/decisions');
log = mockLog();
out.decisions = log.length ? {
	requests:    log.length,
	shippedPath: /daimond:skills\/decisions\.md/.test(usr(log[0])),
	oneAtATime:  /ONE AT A TIME/.test(usr(log[0])),
	recommend:   /Your recommendation/.test(usr(log[0])),
	count:       /Decision 1 of N/.test(usr(log[0])),
} : { requests: 0 };

clearMockLog();
const said = await chat(s, '/pickpu');
out.mistyped = { refused: /no skill called/i.test(said), reachedModel: mockLog().length };

console.log(JSON.stringify(out, null, 1));
await s.browser.close();
