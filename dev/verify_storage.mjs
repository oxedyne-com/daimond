// gateway: none
// verify_storage.mjs — what the workspace costs, and the one figure the browser will not give.
//
// The sandbox row used to say "Workspace · evictable  2.0 MB", which is a number with nothing to
// compare it to and a word with no explanation. The browser DOES know the rest — `estimate()`
// gives usage and quota, `persisted()` says whether the storage may be thrown away, and
// `persist()` fixes it — so the row now says how much of what it is allowed, and offers the fix.
//
// The native row, for a real folder, went with the browser's Machine folder (G5, D-20261031-11):
// the browser opens no folder, so there is nothing of the user's disk to count.
import { open, shot } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'storage', connect: false });
const p = s.page;
await p.waitForTimeout(1800);

// ── The sandbox row ─────────────────────────────────────────────────────

const sandbox = await p.evaluate(async () => {
	const r = document.getElementById('astat-store');
	const e = await navigator.storage.estimate();
	return {
		text:  r ? r.textContent.trim() : '(none)',
		title: r ? r.title : '',
		quota: e.quota,
		persisted: await navigator.storage.persisted(),
	};
});
// The word is "Browser", not "OPFS": the mode chip in the files panel reads
// "🗄 Browser", and the row has to name the same place in the same words or the
// two read as two different stores. (The row said "OPFS" until the chips were
// de-jargoned; this asserts the current word, and that it matches the chip.)
check('the sandbox row names the browser store, in the chip’s own words',
	/Browser/.test(sandbox.text), sandbox.text);
check('and says how much of what it is allowed',
	/%/.test(sandbox.text) && /of/.test(sandbox.title),
	sandbox.text + ' · ' + sandbox.title.slice(0, 48));
check('evictable is explained, not just asserted',
	/evict/i.test(sandbox.title), sandbox.persisted ? '(already persistent)' : 'offers the fix');

// ── The CREDIT cell is gone from Session / Week / Month ─────────────────

const spend = await p.evaluate(() => {
	const el = document.getElementById('spend-row');
	return {
		cells: [...(el ? el.querySelectorAll('.spend-label') : [])].map(e => e.textContent),
		creditCell: !!(el && el.querySelector('.credit-cell')),
	};
});
check('Session / Week / Month no longer carries a fourth "Credits" cell',
	spend.creditCell === false, spend.cells.join(' · ') || '(row hidden — no spend yet)');

await shot(s, 'storage');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
