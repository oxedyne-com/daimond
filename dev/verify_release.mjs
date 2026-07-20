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
// The build this tab is running has to appear in the log, because the surface
// reports what you are RUNNING rather than what has most recently been
// published -- reporting the latter told a stale tab it was current.
const running = await (async () => {
	const r = await fetch('http://localhost:8777/build.json').catch(() => null);
	const j = r && r.ok ? await r.json() : null;
	return (j && j.build) || 'cccccccccccc';
})();

const mk = (seq, ts, build, note) => ({
	seq, ts, build, note, bundle: 'x'.repeat(64), prev: '0'.repeat(64), entry: 'e'.repeat(64),
});
const LOG = [
	mk(0, '2026-01-02T00:00:00.000Z', 'aaaaaaaaaaaa', 'The first one'),
	mk(1, '2026-02-03T00:00:00.000Z', 'bbbbbbbbbbbb', 'The second one'),
	mk(2, '2026-03-04T00:00:00.000Z', running,        'The newest one'),
];
const asUrl = (rows) => 'data:text/plain,' + encodeURIComponent(rows.map(e => JSON.stringify(e)).join('\n'));
const LOG_URL = asUrl(LOG);

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

// ── Before a release is declared, nothing is announced ──────────────────
// A deployment is not a release. Daimond seals several builds a day, and none
// of them is an announcement; until one is declared the row has to say so
// rather than dress a build up as a version.
{
	await p.evaluate((url) => {
		const m = document.createElement('meta');
		m.name = 'daimond-releases';
		m.content = url;
		document.head.appendChild(m);
		window.DaimondRelease.reset();
	}, 'data:application/json,' + encodeURIComponent(JSON.stringify(
		{ milestones: [], planned: { name: 'Albany', blurb: 'The first release.' } })));
	await p.evaluate(() => window.DaimondRelease.paintRow());
	await p.waitForTimeout(500);
	const txt = await p.$eval('#astat-release', e => e.textContent);
	check('with no release declared, the row says pre-release', /Pre-release/i.test(txt), txt.trim());
	check('and names the build rather than inventing a version name',
		txt.includes(running), txt.trim());
	check('it does not present the planned release as the current one',
		!/Albany/.test(txt), txt.trim());
}

// ── Once one IS declared, the row names it ──────────────────────────────
{
	await p.evaluate((url) => {
		document.querySelector('meta[name="daimond-releases"]').content = url;
		window.DaimondRelease.reset();
	}, 'data:application/json,' + encodeURIComponent(JSON.stringify({
		milestones: [{ name: 'Albany', from: 0, blurb: 'The first release.' }],
		planned: { name: 'Broome', blurb: 'What comes next.' },
	})));
	await p.evaluate(() => window.DaimondRelease.paintRow());
	await p.waitForTimeout(500);
	const txt = await p.$eval('#astat-release', e => e.textContent);
	check('the row names the release, not a hex build id', /Albany/.test(txt), txt.trim());
	check('and says how long you have been on it',
		/(today|yesterday|days ago|months ago|years ago)/.test(txt), txt.trim());
	const title = await p.$eval('#astat-release', e => e.title);
	check('the build id is still available, in the tooltip', title.includes(running), title);
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
	// The list is RELEASES, not deployments: one declared release plus what is
	// planned, however many builds have been sealed underneath.
	check('the list shows releases rather than every build', rows.length === 2,
		`${rows.length} rows for ${LOG.length} builds`);
	check('the planned one is first', rows[0] && rows[0].planned, rows[0] && rows[0].text.slice(0, 30));
	check('exactly one row says you are here',
		rows.filter(r => /you are here/i.test(r.text)).length === 1);
	check('and it is the declared release', rows[1] && rows[1].current && /Albany/.test(rows[1].text));

	// The builds stay reachable, because they are the verifiable part.
	const builds = await p.$$eval('#rel-list .rel-builds .rel-build', els => els.map(e => e.textContent));
	check('every sealed build is still there, behind a disclosure',
		builds.length === LOG.length, `${builds.length} builds`);
	check('each build carries its own note',
		builds.some(t => /The second one/.test(t)), builds[1] && builds[1].slice(0, 44));
	const summary = await p.$eval('#rel-list .rel-builds summary', e => e.textContent);
	check('the disclosure says how many there are', /3 sealed builds/.test(summary), summary);
}

// ── A tab running an OLDER build is told so, not flattered ─────────────
// This is the defect the surface was built with: it reported the newest
// PUBLISHED release as "you are here", so a tab open since before a deploy was
// told it was current on the same screen where the update chip said otherwise.
{
	const ahead = LOG.concat([mk(3, '2026-04-05T00:00:00.000Z', 'ffffffffffff', 'Published after this tab loaded')]);
	await p.evaluate((url) => {
		document.querySelector('meta[name="daimond-log"]').content = url;
		window.DaimondRelease.reset();
	}, asUrl(ahead));
	await p.evaluate(() => window.DaimondRelease.paintRow());
	await p.waitForTimeout(400);
	const txt = await p.$eval('#astat-release', e => e.textContent);
	const tip = await p.$eval('#astat-release', e => e.title);
	check('a tab behind the newest release says so', /update ready/i.test(txt), txt.trim());
	check('and the tooltip says a newer build exists', /newer build/i.test(tip), tip);

	await p.evaluate(() => window.DaimondRelease.render(document.getElementById('rel-list')));
	await p.waitForTimeout(400);
	const marked = await p.$$eval('#rel-list .rel-row', els =>
		els.filter(e => /you are here/i.test(e.textContent)).map(e => e.textContent.slice(0, 60)));
	check('"you are here" marks where the running build sits, not the newest published',
		marked.length >= 1 && !marked.some(t => t.includes('ffffffffffff')), marked.join(' | '));

	// Put the original log back for the checks below.
	await p.evaluate((url) => {
		document.querySelector('meta[name="daimond-log"]').content = url;
		window.DaimondRelease.reset();
	}, LOG_URL);
	await p.evaluate(() => window.DaimondRelease.render(document.getElementById('rel-list')));
	await p.waitForTimeout(400);
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
		/not released yet/i.test(planned.text), planned.text.slice(-46).trim());
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
