// verify_search_bigfile.mjs -- file_search reaches a file past the old 2 MB ceiling.
//
// WHAT THIS FILE IS ABOUT. `file_search` used to skip any file over 2,000,000 bytes and say so
// in a footnote: `1 file(s) larger than 2000000 bytes`. The app's own largest source,
// `www/js/daimond.js`, is 2.36 MB, so the one file a daimon most often needs to search was the
// one file its search could not open -- and the answer it got was "No matches", with the reason
// in a line the model had every reason to skim past. The Rust test
// `test_the_search_finds_a_symbol_in_the_apps_own_largest_file` measured that directly and was
// red for as long as the ceiling stood.
//
// The ceiling is gone: the search reads a file a line at a time now, so a file's size costs one
// 256 KiB buffer rather than two copies of the file. This checks the BROWSER half of that --
// that a 2.4 MB file seeded into the page's own storage is searched, that the line number the
// search reports is the line the symbol is actually on, and that the result no longer carries a
// sentence about a size ceiling.
//
// WHAT IT LOCKS DOWN.
//
//   A. A file past the old ceiling is searched at all, and the hit names it.
//   B. The LINE NUMBER is the file's own -- the number a file_read afterwards has to agree with
//      -- and the streaming reader is where that could go wrong, since the symbol here sits past
//      several chunk boundaries.
//   C. `context` reaches across a chunk boundary: the line before a hit that straddles one comes
//      out of the chunk before it, which is what the carry buffer exists for.
//   D. The notes carry no page-side size ceiling any more.
//
// THE BREAK, AND WHAT IT PROVES. `--break ceiling` wraps `run_tool` in the page so that a
// `file_search` answers the way the old build answered: no matches, and the 2,000,000-byte
// footnote. Every check above then goes red. What that proves is that these checks CAN fail --
// which is the whole of what a break is for here. It does not prove the wasm has no ceiling of
// its own; nothing injectable from a verifier could, because the logic is compiled in rather
// than served. The instrument that proves THAT is the Rust test named above, which was watched
// red before the ceiling came out and is green now.
//
//   node dev/verify_search_bigfile.mjs
//   node dev/verify_search_bigfile.mjs --break ceiling
//
// It needs a dev world up (`bash dev/world.sh N --up`) and a wasm build of this tree.

import { open } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = ['ceiling'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

const bad = [];
const check = (name, pass, detail) => {
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
	if (!pass) bad.push(name);
};

// ── The fixture ─────────────────────────────────────────────────────
//
// Built in the page rather than sent through it: 2.4 MB across a `page.evaluate`
// boundary is slow and the generator is four lines.
const NEEDLE  = 'export function settleDeep';
const MIN     = 2_400_000;

const s = await open({ name: 'searchbig' });

const seeded = await s.page.evaluate(async ({ needle, min, brk }) => {
	const m   = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	// The break, injected where a verifier CAN inject one: between the page and the tool. It
	// answers a search the way the build with the ceiling answered one.
	const call = async (tool, args) => {
		if (brk === 'ceiling' && tool === 'file_search') {
			return "No matches for '" + JSON.parse(args).query + "'.\n"
				+ '[file_search] 0 match(es) in 0 file(s); 1 file(s) searched.\n'
				+ '[file_search] NOT searched: 1 file(s) larger than 2000000 bytes.\n';
		}
		return await app.run_tool(tool, args);
	};
	await app.run_tool('dir_create', JSON.stringify({ path: 'big' }));
	const pad = "const pad = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n";
	// TWO needles, and the second is what this file is about: it sits about eight 256 KiB
	// chunks in, so a reader that stopped at the first chunk -- or that lost a line on a chunk
	// boundary -- reports the first and misses the second.
	let body = '', first = 0, second = 0, n = 0;
	while (body.length < min) {
		n += 1;
		const deep = second === 0 && body.length > min * 0.8;
		if (n === 7 || deep) {
			if (n === 7) { first = n; } else { second = n; }
			body += needle + '(cents) { return cents; }\n';
		} else {
			body += pad;
		}
	}
	const last = body.split('\n').length;
	await app.run_tool('file_write', JSON.stringify({ path: 'big/rates.js', content: body }));
	const found = await call('file_search',
		JSON.stringify({ query: needle, path: 'big', limit: 50 }));
	const ctx = await call('file_search',
		JSON.stringify({ query: needle, path: 'big', context: 2, limit: 50 }));
	return { bytes: body.length, lines: last, first, second, found, ctx };
}, { needle: NEEDLE, min: MIN, brk: BREAK });

console.log(`fixture: big/rates.js, ${seeded.bytes} bytes, ${seeded.lines} lines, `
	+ `needles at ${seeded.first} and ${seeded.second}`);

// The fixture itself, checked before anything is concluded from it.
if (seeded.bytes <= 2_000_000) {
	console.error('the fixture is not past the old ceiling; this run would prove nothing.');
	await s.close();
	process.exit(2);
}

// ── A. it is searched at all ────────────────────────────────────────
check('A1 a 2.4 MB file is searched', seeded.found.includes('big/rates.js:'),
	seeded.found.split('\n')[0]);
check('A2 and the result is not the old "no matches"',
	!/^No matches/.test(seeded.found.trim()), seeded.found.split('\n')[0]);

// ── B. the line numbers are the file's own ──────────────────────────
const hits = seeded.found.split('\n')
	.filter(l => l.startsWith('big/rates.js:'))
	.map(l => Number(l.split(':')[1]));
check('B1 the first needle is reported on its own line',
	hits.includes(seeded.first), hits.join(','));
check('B2 and so is one several chunks in',
	hits.includes(seeded.second), hits.join(','));

// ── C. context crosses a chunk boundary ─────────────────────────────
check('C1 the line before a deep hit comes back as context',
	seeded.ctx.includes(`big/rates.js-${seeded.second - 1}-`),
	seeded.ctx.split('\n').slice(0, 3).join(' | '));
check('C2 and the line after it',
	seeded.ctx.includes(`big/rates.js-${seeded.second + 1}-`));

// ── D. no page-side ceiling is claimed ──────────────────────────────
check('D1 the notes name no 2,000,000-byte ceiling',
	!seeded.found.includes('2000000'),
	(seeded.found.match(/NOT searched:.*/) || [''])[0]);

await s.close();

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — the instrument is live.' : ' — THE BREAK PROVED NOTHING.'));
	process.exitCode = bad.length ? 0 : 1;
} else {
	console.log('\nVERDICT: ' + (bad.length === 0
		? 'the search reaches a file past the old ceiling'
		: 'FAILED — ' + bad.join('; ')));
	process.exitCode = bad.length === 0 ? 0 : 1;
}
