// gateway: none
// verify_d1tab.mjs — on the tab, a chat that has read outside content keeps searching and
// fetching with nothing asked (UNBLOCK-88, D-20261101-48; rulings l.73, l.253, l.254).
//
// THE DEFECT. His Fred Hoogland turn, 1 Nov 2026: once a chat had read web content, the tab put
// every later search to him ("Search the web?") and the first fetch of each conversation too
// ("one ask per conversation"). His pick, 22:43, "Just run": later searches and fetches run with
// nothing asked; only a daimon-composed address that looks like it carries data out is refused,
// and the refusal is shown. Kimberlite got the rule in a843e7a78; this holds the tab to it, by the
// same engine code (`src/tools/shown.rs`; the engine keeps each chat's shown set, keyed as its taint
// is, and both net ports answer from it).
//
// It RETIRES verify_egressconvo.mjs, whose checks 2-5, 7 and 8 asserted the questions D1 removes
// on the default rung. Its check 1 (a clean turn is never asked) is check 1 here; its checks 6 and
// 9 (one Diamond's reading does not cross to another) are held in Rust by
// `test_one_diamonds_reading_does_not_taint_another_on_a_shared_client`. The page's questions
// remain for the `Ask` rung, which he chooses, and verify_injection drives that bridge directly.
//
// SIX PROPERTIES, each counted in dialogs and in what reached the network:
//
//   1. A clean turn is not asked.
//   2. After outside content, an ordinary 99-character research query is searched, nobody asked
//      (his query; red on the live record 51f30d494, which asks "Search the web?").
//   3. A long address that search result gave is fetched as it stands, nobody asked (l.254).
//   4. An ordinary address on a new host is fetched, nobody asked.
//   5. A composed address carrying a 200-character query is NOT fetched, nobody asked,
//   6. and the refusal shown says so in D1's words, not "the user was asked, and declined".
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_d1tab.mjs
//
// Needs dev/serve.mjs and the mock. No gateway: the search and the read are answered by the
// page's own `DaimondSearch.search` and `DaimondWeb.fetch`, replaced here so what left is counted.
// Needs the wasm to have been rebuilt since src/ last changed.
import { open, newChat, scratch } from './harness.mjs';

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'd1tab', profile: scratch('pw', 'd1tab') });
const { page: p } = s;

/// Every dialog raised while `body` runs, each answered no, with its title kept. Answered rather
/// than watched for, so a turn that raised one does not sit behind it.
const asks = async (body) => {
	const seen = [];
	let stop = false;
	const pump = (async () => {
		while (!stop) {
			const got = await p.evaluate(() => {
				const card = [...document.querySelectorAll('.dlg-card')]
					.filter(c => c.getClientRects().length).pop();
				if (!card) return null;
				const title = (card.querySelector('h2') || {}).textContent || '';
				const b = card.querySelector('.dlg-cancel') || card.querySelector('.dlg-ok');
				if (b) b.click();
				return title;
			}).catch(() => null);
			if (got !== null) seen.push(got);
			await p.waitForTimeout(250);
		}
	})();
	await body();
	stop = true;
	await pump;
	return seen;
};

const turn = (text, wait = 7000) => asks(async () => {
	await p.fill('#chat-input', text);
	await p.click('#chat-send', { force: true });
	await p.waitForTimeout(wait);
});

const FETCH  = (u) => `@tool web_fetch {"url":"${u}"}`;
const SEARCH = (q) => `@tool web_search {"query":"${q}"}`;
const QUERY  = 'Open Beelden Netherlands Institute for Sound and Vision free download archive footage Polygoon 1954';
const SHOWN  = 'https://www.1twente.nl/artikel/herontdekt-oorlogsdagboek-van-riet-hoogland-toont-twente-in-de-bezettingsjaren';
const OWN    = 'https://x.test/s?q=' + 'a b c d '.repeat(25).trim().replace(/ /g, '+');

/// What reached the network since the last call: queries searched and addresses read.
const left = () => p.evaluate(() => {
	const out = { q: window.__d1q.slice(), u: window.__d1u.slice() };
	window.__d1q.length = 0;
	window.__d1u.length = 0;
	return out;
});

try {
	await newChat(s);
	// The search and the read, answered here and counted. Installed after boot, where the
	// engine reads them (`searcher()`, `driver()` look them up on every call).
	const stubbed = await p.evaluate(({ shown }) => {
		window.__d1q = [];
		window.__d1u = [];
		window.DaimondSearch = window.DaimondSearch || {};
		window.DaimondSearch.search = async (q) => {
			window.__d1q.push(String(q));
			return { engine: 'stub', results: [{ title: 'Dagboek', url: shown, snippet: 'Riet Hoogland' }] };
		};
		window.DaimondWeb = window.DaimondWeb || {};
		window.DaimondWeb.fetch = async (u) => {
			window.__d1u.push(String(u));
			return 'A page about the archive.';
		};
		return true;
	}, { shown: SHOWN });
	check(stubbed, 'the search and the read can be counted');

	// ── 1 ─────────────────────────────────────────────────────────────
	const clean = await turn(FETCH('https://alpha.test/one'));
	await left();
	check(clean.length === 0, 'A TURN THAT HAS READ NOTHING IS NOT ASKED', `${clean.length} dialog(s)`);

	const marked = await p.evaluate(() => !!(window.DaimondCore && DaimondCore.markRead()));
	check(marked, 'the chat can be marked as having read outside content');

	// ── 2 ─────────────────────────────────────────────────────────────
	const searched = await turn(SEARCH(QUERY));
	const l2 = await left();
	check(searched.length === 0 && l2.q.includes(QUERY),
		'AFTER OUTSIDE CONTENT, HIS 99-CHARACTER QUERY IS SEARCHED, NOBODY ASKED',
		`${searched.length} dialog(s) ${JSON.stringify(searched)}; searched ${JSON.stringify(l2.q)}`);

	// ── 3 ─────────────────────────────────────────────────────────────
	const fromResult = await turn(FETCH(SHOWN));
	const l3 = await left();
	check(fromResult.length === 0 && l3.u.includes(SHOWN),
		'A LONG ADDRESS THAT RESULT GAVE IS FETCHED AS IT STANDS, NOBODY ASKED',
		`${fromResult.length} dialog(s); read ${JSON.stringify(l3.u)}`);

	// ── 4 ─────────────────────────────────────────────────────────────
	const fresh = await turn(FETCH('https://beta.test/two'));
	const l4 = await left();
	check(fresh.length === 0 && l4.u.includes('https://beta.test/two'),
		'AN ORDINARY ADDRESS ON A NEW HOST IS FETCHED, NOBODY ASKED',
		`${fresh.length} dialog(s); read ${JSON.stringify(l4.u)}`);

	// ── 5 and 6 ───────────────────────────────────────────────────────
	const composed = await turn(FETCH(OWN));
	const l5 = await left();
	check(composed.length === 0 && l5.u.length === 0,
		'A COMPOSED ADDRESS CARRYING DATA IS NOT FETCHED, AND NOBODY IS ASKED',
		`${composed.length} dialog(s); read ${JSON.stringify(l5.u)}`);
	const said = await p.evaluate(() => document.body.textContent || '');
	check(/refused automatically, and nobody was asked/.test(said)
		&& /Only this address was refused; other searches and addresses still work/.test(said),
		'AND THE REFUSAL SHOWN SAYS SO IN D1’S WORDS',
		/refused automatically/.test(said) ? '' : 'no D1 refusal on the page');
} catch (e) {
	check(false, 'no exception during the run', String(e && e.message || e));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
