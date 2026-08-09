// verify_signals.mjs -- the local usage index, and the rule it is built around.
//
// notes2 #51 asks for the Optimiser to be given a scope over "a lot of things,
// possibly everything, but as a minimum all LLM sessions". A scope cannot say
// that: a scope is workspace folders, the ledger is localStorage and chats are
// in IndexedDB. So what it needs is written into a folder instead, and the
// folder is what it is granted.
//
// The properties, in the order they matter:
//
//   1. THE PRESENTATION RULE. The index may read irritation; nothing built on
//      it may ever mention it. A digest that says "you seem frustrated", or
//      prints a mood score, has misused the module -- so the digest is checked
//      for those words against input chosen to provoke them. This is the check
//      that stops the whole idea being obnoxious, so it is first.
//   2. NO MESSAGE TEXT IS KEPT. The index holds counters and hashes. It cannot
//      leak what it does not hold, and that claim is testable: put a rare
//      string in, and it must not come out anywhere in the stored index.
//   3. The composite is a composite. One signal is noise -- people swear at the
//      weather and write "again." meaning "once more please" -- so one does not
//      count and two do.
//   4. Terseness is judged against THIS user's norm, not a fixed number. Six
//      words from someone who always writes six words is not a signal.
//   5. A repeated ask is counted, and counted by MEANING rather than by exact
//      text, because nobody retypes a request the same way twice.
//   6. Findings carry a number and something to do. A finding with no action is
//      a complaint; one without evidence is astrology.
//   7. Silence is a valid answer. An index with nothing to report says so
//      rather than padding.
//
// The pure half runs in Node against www/js/signals.js with a localStorage
// stub, so the scoring is tested without a browser. The browser half proves the
// digest reaches system/usage/digest.md and that the Optimiser can read it.
//
//   node dev/verify_signals.mjs
//   node dev/verify_signals.mjs --pure     # skip the browser half
//
// Needs dev/serve.mjs for the browser half (dev/world.sh N --up).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
const check = (cond, msg, detail) => {
	if (!cond) failures++;
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail ? ' -- ' + detail : ''));
};

// ── A localStorage the module can use ───────────────────────
const mem = new Map();
globalThis.localStorage = {
	getItem: k => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: k => mem.delete(k),
};
const src = fs.readFileSync(path.join(ROOT, 'www/js/signals.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'localStorage', src)(mod, globalThis.localStorage);
const S = mod.exports;

// ══ 3. The composite ═══════════════════════════════════════════════
// A norm long enough that terseness is available as a signal, so these test
// what they say they test rather than accidentally scoring on length.
const NORM = 120;
// Long enough that terseness does NOT also fire: a four-letter swear is two
// signals, quite correctly, and would prove nothing about strong language alone.
const SWORE = 'this is a fucking long message about the ledger and what it should do';
check(S.score(SWORE, NORM) === 1, 'strong language is a signal, and on its own it is one',
	String(S.score(SWORE, NORM)));
check(S.missed(SWORE, NORM) === false,
	'so it is not a miss by itself -- people swear at the weather',
	String(S.score(SWORE, NORM)));
check(S.score('fuck', NORM) === 2,
	'while a four-letter reply is two signals: strong AND far shorter than this user writes',
	String(S.score('fuck', NORM)));
check(S.missed('no, i said use the other one', NORM) === false,
	'nor is a correction alone', String(S.score('no, i said use the other one', NORM)));
check(S.missed('wtf?? why would you do that', NORM) === true,
	'two independent signals together are',
	String(S.score('wtf?? why would you do that', NORM)));
check(S.missed('THIS IS COMPLETELY WRONG AGAIN, as i already told you', NORM) === true,
	'and shouting a correction certainly is',
	String(S.score('THIS IS COMPLETELY WRONG AGAIN, as i already told you', NORM)));
check(S.missed('Could you try the other approach please?', NORM) === false,
	'an ordinary polite request is not a miss',
	String(S.score('Could you try the other approach please?', NORM)));
check(S.missed('', NORM) === false, 'and an empty message is nothing at all');

// ══ 4. Terseness is relative ═══════════════════════════════════════
check(S.score('no', 400) > S.score('no', 0),
	'"no" from someone who writes long messages scores higher than from someone with no norm yet',
	`${S.score('no', 400)} vs ${S.score('no', 0)}`);
check(S.score('no', 30) === S.score('no', 0),
	'and a user whose own norm is short gets no terseness signal at all',
	`${S.score('no', 30)} vs ${S.score('no', 0)}`);

// ══ 5. Repeats are counted by meaning ══════════════════════════════
{
	const a = S.intentHash('Can you please summarise the meeting notes for me');
	const b = S.intentHash('summarise the meeting notes');
	check(!!a && a === b,
		'the same ask worded two ways lands on one hash', `${a} / ${b}`);
	const c = S.intentHash('deploy the gateway to production');
	check(a !== c, 'and a different ask does not', `${a} / ${c}`);
	check(S.intentHash('ok') === '', 'something too short to mean anything twice is not counted');
}

// ══ 2. No message text is kept ═════════════════════════════════════
{
	S.reset();
	const RARE = 'zarquon-fnord-quibble';
	S.noteUserMessage({ diamondId: 'd1', text: `fuck this ${RARE} is wrong again!!`, prevModel: 'm1' });
	const stored = JSON.stringify(S.snapshot());
	check(stored.indexOf(RARE) < 0,
		'the message does not appear in the stored index -- it cannot leak what it does not hold',
		stored.length + ' bytes stored');
	check(stored.indexOf('fuck') < 0, 'nor does anything else that was typed');
	check(S.snapshot().diamonds.d1 && S.snapshot().diamonds.d1.missed === 1,
		'but the counter moved', JSON.stringify(S.snapshot().diamonds.d1));
}

// ══ 1. THE PRESENTATION RULE ═══════════════════════════════════════
// Fed the most provocative input this module can be given, the digest must
// describe DEFECTS and never the person's mood.
{
	S.reset();
	const diamonds = [{ id: 'd1', name: 'Ledger work' }];
	for (let i = 0; i < 12; i++) {
		S.noteTurn({ ts: Date.now(), diamondId: 'd1', model: 'cheap/model', usd: 0.01 });
		S.noteTool('web_fetch', true);
		S.noteUserMessage({ diamondId: 'd1', text: 'WHAT?! that is wrong AGAIN, as i already told you',
			prevModel: 'cheap/model', prevTools: ['web_fetch'] });
	}
	const md = S.digest(diamonds);
	const banned = /frustrat|angry|upset|annoy|mood|swear|swore|profan|temper|emotion|stressed|irritat/i;
	check(!banned.test(md),
		'the digest never names the reader’s state of mind, however it was provoked',
		(md.match(banned) || [''])[0] || 'clean');
	check(!/\bscore\b/i.test(md), 'and shows no score for it either');
	// What it SHOULD say: the defect the signal pointed at.
	check(/web_fetch/.test(md),
		'it names the tool whose turns kept needing correcting', 'web_fetch present');
	check(/cheap\/model/.test(md), 'and the model they ran on');
	check(/correct/i.test(md),
		'in the language of work that had to be redone, which is the observable fact');
}

// ══ 6. Findings carry a number and an action ═══════════════════════
{
	const f = S.findings([{ id: 'd1', name: 'Ledger work' }]);
	check(f.length > 0, 'the run above produced findings', String(f.length));
	check(f.every(x => /\d/.test(x.what)),
		'each states a number, so it can be checked rather than believed',
		f.map(x => x.what).join(' | '));
	check(f.every(x => x.do_ && x.do_.length > 10),
		'and each says what to do about it -- a finding with no action is a complaint');
}

// ══ 7. Silence is a valid answer ═══════════════════════════════════
{
	S.reset();
	const md = S.digest([]);
	check(/Nothing\./.test(md) || /Nothing recorded yet/.test(md),
		'an index with nothing to report says so');
	check(!/frustrat/i.test(md), 'and still says nothing about anybody’s mood');
	check(/does not know/i.test(md),
		'and states what it cannot see, so a reader does not take it for the whole picture');
}

// ══ The browser half ═══════════════════════════════════════════════
if (!process.argv.includes('--pure')) {
	const { open, connectMock, signInAs, scratch } = await import('./harness.mjs');
	const s = await open({ name: 'signals', signIn: false, connect: false,
		profile: scratch('pw', 'signals-' + process.pid) });
	const { page: p } = s;
	try {
		await signInAs(s, 'signals');
		await connectMock(s);
		await p.evaluate(() => DaimondDiamond.seedDefaults());
		await p.waitForFunction(() =>
			[...document.querySelectorAll('#diamond-list .session-box-name')]
				.some(n => /Daimond Optimiser/.test(n.textContent)), null, { timeout: 20000 });

		const id = await p.evaluate(() => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find(x => /Daimond Optimiser/.test(x.textContent));
			return b ? b.dataset.id : '';
		});
		check(!!id, 'the Optimiser is there', String(id));

		// The digest is a real file, in the workspace, where a file tool reaches it.
		const file = await p.evaluate(async () => {
			const W = await import('/pkg/oxedyne_daimond.js');
			try { return await W.store_read('system/usage/digest.md'); }
			catch (e) { return ''; }
		});
		check(!!file, 'the digest is written to system/usage/digest.md',
			file ? file.split('\n')[0] : '(absent)');
		check(/does not know/i.test(file || ''),
			'and it is the digest this module writes, not an empty file');

		// And the Optimiser can actually see it. This is the whole point: the
		// grant is the ordinary read-only attachment, so bounds() reports it.
		const bounds = await p.evaluate(async (did) => {
			const W = window;
			// Files.bounds is the same call scopeAgentTo makes before dispatching
			// an agent, so this asks exactly what the engine will be told.
			return await W.DaimondDiamond.bounds(did);
		}, id).catch(() => null);
		if (bounds) {
			check((bounds.read_only || []).indexOf('system/usage') >= 0,
				'and the Optimiser holds it READ-ONLY -- it reports on the work, it does not rewrite it',
				JSON.stringify(bounds.read_only));
			check((bounds.attached || []).indexOf('system/usage') >= 0,
				'and it is in reach at all', JSON.stringify(bounds.attached));
		} else {
			check(false, 'the Optimiser’s bounds could be read', 'DaimondDiamond.bounds not published');
		}
		// ── And Help gets the guide, the same way ──────────
		// The guide ships inside the bundle as HTML, so Help -- the Diamond
		// whose whole job is explaining the app -- could not read the manual it
		// exists to explain. Mirrored from the search index that already ships,
		// one file per page so a daimon reads the page it needs rather than
		// eighty kilobytes to answer one question.
		const helpId = await p.evaluate(() => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find(x => /Daimond Help/.test(x.textContent));
			return b ? b.dataset.id : '';
		});
		check(!!helpId, 'Daimond Help is there', String(helpId));

		const mirror = await p.evaluate(async () => {
			const W = await import('/pkg/oxedyne_daimond.js');
			const out = {};
			try { out.readme = await W.store_read('system/guide/README.md'); } catch (e) { out.readme = ''; }
			try { out.page = await W.store_read('system/guide/accounts.md'); } catch (e) { out.page = ''; }
			return out;
		});
		check(!!mirror.readme, 'the guide is mirrored, with a contents page',
			(mirror.readme || '').split('\n')[0]);
		check(/\.md/.test(mirror.readme || ''),
			'that names the pages, so a daimon knows what to search');
		check((mirror.page || '').length > 200,
			'and a page carries the guide’s actual words',
			String((mirror.page || '').length) + ' chars');
		check(!/<[a-z]+[ >]/i.test(mirror.page || ''),
			'as text, not as the HTML it ships in',
			((mirror.page || '').match(/<[a-z]+[ >]/i) || [''])[0] || 'clean');

		const hb = await p.evaluate((did) => window.DaimondDiamond.bounds(did), helpId).catch(() => null);
		check(hb && (hb.read_only || []).indexOf('system/guide') >= 0,
			'and Help holds it READ-ONLY -- it explains the guide, it does not edit it',
			hb && JSON.stringify(hb.read_only));
	} catch (e) {
		failures++;
		console.log('  FAIL browser half threw -- ' + (e && e.message ? e.message.split('\n')[0] : e));
	} finally {
		await s.close();
	}
}

console.log('');
console.log(failures ? `verify_signals: ${failures} FAILED` : 'verify_signals: all checks pass.');
process.exit(failures ? 1 : 0);
