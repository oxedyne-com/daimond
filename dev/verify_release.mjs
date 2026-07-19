// verify_release.mjs — which Daimond you are running, and what came before it.
//
// The guarantees worth holding, rather than the pixels:
//
//   * a note can be added to a sealed entry WITHOUT moving its hash, which is
//     the whole reason the changelog can live in the transparency log at all,
//   * the status row names the release, not a hex build id,
//   * every sealed build appears, newest first, exactly one marked "you are here",
//   * the planned entry is never mistakable for history: no build, no seal
//     number, and said in words,
//   * there is no way back to an old version, deliberately.
//
// Run with dev/serve.mjs up. No gateway needed. The log is fed in over a data:
// URL so this does not depend on the network or on what is published today.
import { open, signInAs, errors } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { parseLog, verifyChain, entryHash, nextEntry } from '../verify/lib.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The chain tolerates notes, which is what makes this possible ────────
{
	const entries = parseLog(await readFile('verify/transparency.jsonl', 'utf8'));
	const chain = verifyChain(entries);
	check('the real log still verifies with notes on every entry', chain.ok,
		chain.error || `${entries.length} entries`);
	check('every entry carries a note', entries.every(e => e.note && e.note.length),
		`${entries.filter(e => e.note).length}/${entries.length}`);

	// The load-bearing property: the note is outside the hashed preimage.
	const e = entries[entries.length - 1];
	const recomputed = entryHash({ seq: e.seq, ts: e.ts, build: e.build, bundle: e.bundle, prev: e.prev });
	check('the hash is computed without the note', recomputed === e.entry, e.entry.slice(0, 16) + '…');

	const withNote = nextEntry([], { ts: 't', build: 'b', bundle: 'x', note: 'hello' });
	const without  = nextEntry([], { ts: 't', build: 'b', bundle: 'x' });
	check('so adding one to a sealed entry cannot invalidate it',
		withNote.entry === without.entry, withNote.entry.slice(0, 16) + '…');
	check('and an absent note leaves no empty field behind', !('note' in without));
}

// ── A log of our own, so this test does not depend on the network ───────
const LOG = [
	{ seq: 0, ts: '2026-01-02T00:00:00.000Z', build: 'aaaaaaaaaaaa', note: 'The first one' },
	{ seq: 1, ts: '2026-02-03T00:00:00.000Z', build: 'bbbbbbbbbbbb', note: 'The second one' },
	{ seq: 2, ts: '2026-03-04T00:00:00.000Z', build: 'cccccccccccc', note: 'The newest one' },
].map(e => ({ ...e, bundle: 'x'.repeat(64), prev: '0'.repeat(64), entry: 'e'.repeat(64) }));
const LOG_URL = 'data:text/plain,' + encodeURIComponent(LOG.map(e => JSON.stringify(e)).join('\n'));

const s = await open({ name: 'release', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

await p.evaluate((url) => {
	const m = document.createElement('meta');
	m.name = 'daimond-log';
	m.content = url;
	document.head.appendChild(m);
	window.DaimondRelease.reset();
}, LOG_URL);

// ── The status row names the release ────────────────────────────────────
{
	await p.evaluate(() => window.DaimondRelease.paintRow());
	await p.waitForTimeout(500);
	const txt = await p.$eval('#astat-release', e => e.textContent);
	check('the row names the milestone, not a hex build id', /Albany/.test(txt), txt.trim());
	check('and says how long you have been on it',
		/(today|yesterday|days ago|months ago|years ago)/.test(txt), txt.trim());
	const title = await p.$eval('#astat-release', e => e.title);
	check('the build id is still available, in the tooltip', /cccccccccccc/.test(title), title);
}

// ── The history ─────────────────────────────────────────────────────────
{
	await p.click('#astat-release');
	await p.waitForTimeout(700);
	const rows = await p.$$eval('#rel-list .rel-row', els => els.map(e => ({
		planned: e.classList.contains('rel-planned'),
		current: e.classList.contains('rel-current'),
		text: e.textContent,
	})));
	check('every sealed build is listed, plus what is planned', rows.length === LOG.length + 1,
		`${rows.length} rows for ${LOG.length} builds`);
	check('the planned one is first', rows[0] && rows[0].planned, rows[0] && rows[0].text.slice(0, 30));
	check('exactly one row says you are here',
		rows.filter(r => /you are here/i.test(r.text)).length === 1);
	check('and it is the newest build, not the planned line',
		rows[1] && rows[1].current && /cccccccccccc/.test(rows[1].text));
	check('the newest is above the oldest',
		rows[1].text.indexOf('cccccccccccc') >= 0 && rows[3].text.indexOf('aaaaaaaaaaaa') >= 0);
	check('each build carries its own note', /The second one/.test(rows[2].text), rows[2].text.slice(0, 40));
}

// ── A promise must not read as a record ─────────────────────────────────
// This is the one honesty requirement of the whole surface: everything below
// the first row is sealed and checkable, and the first row is neither.
{
	const planned = await p.$eval('#rel-list .rel-planned', e => ({
		text: e.textContent,
		dashed: getComputedStyle(e).borderStyle,
		hasCode: !!e.querySelector('code'),
	}));
	check('the planned entry names no build id', !planned.hasCode);
	check('it carries no seal number', !/sealed #/.test(planned.text));
	check('it is drawn differently from a sealed one', planned.dashed === 'dashed', planned.dashed);
	check('and it says so in words, not only in styling',
		/not built yet/i.test(planned.text), planned.text.slice(-46).trim());
	check('it is labelled planned', /planned/i.test(planned.text));
}

// ── No way back, on purpose ─────────────────────────────────────────────
// Reverting fights the gateway's own "too old" refusal, lets a user pin a build
// with a since-fixed security fault, and risks an old build meeting newer local
// data. If a control for it ever appears, that was a decision, not a drive-by.
{
	const controls = await p.$$eval('#rel-list button, #rel-list a', els =>
		els.map(e => (e.textContent || '').trim()).filter(Boolean));
	check('the history offers no way to go back to an old build',
		!controls.some(t => /revert|roll ?back|downgrade|switch to|install/i.test(t)),
		controls.length ? controls.join(', ') : 'no controls at all');
}

// ── It survives a log it cannot read ────────────────────────────────────
// Not knowing the version is a smaller problem than a blank panel.
{
	await p.evaluate(() => {
		document.querySelector('meta[name="daimond-log"]').content = 'data:text/plain,not%20json%20at%20all';
		window.DaimondRelease.reset();
	});
	await p.evaluate(() => window.DaimondRelease.render(document.getElementById('rel-list')));
	await p.waitForTimeout(500);
	const txt = await p.$eval('#rel-list', e => e.textContent);
	check('an unreadable log says so rather than showing nothing',
		/no published history/i.test(txt), txt.trim().slice(0, 60));
	await p.evaluate(() => window.DaimondRelease.paintRow());
	await p.waitForTimeout(300);
	check('and the status strip still stands', await p.isVisible('#astat-release'));
}

{
	const errs = errors(s).filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.join(' | ') || 'clean');
}

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
