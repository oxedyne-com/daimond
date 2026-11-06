// bigresultcut.test.mjs -- the tab says, in the reader's language, that a tool result was cut
// (BIGRESULT-PAGE, 06 Nov 2026).
//
//	node --test www/js/bigresultcut.test.mjs
//	BIGRESULTCUT_PKG=/path/to/www/pkg node --test www/js/bigresultcut.test.mjs
//
// The engine cuts a result longer than `run.tool_result_max` (src/limits.jdat) and keeps no file
// of the whole in the tab; the note it leaves is for the model, in English. The page asks the
// engine (`tool_result_cut`) for the figures off that line and draws `chat.tool_result_cut` under
// the result card, so a stored result says the same after a reload.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG  = process.env.BIGRESULTCUT_PKG || join(HERE, '..', 'pkg');

const CUT = 'x'.repeat(50000) + '\n\n[file_read result cut: the first 50000 of 60000 characters '
	+ 'are shown, and the whole was not kept. Ask for less: a narrower command, a pattern, or an '
	+ 'offset.]';

test('the engine reads the figures off its own cut line, and nothing off an uncut result', async () => {
	const m = await import(join(PKG, 'oxedyne_daimond.js'));
	m.initSync({ module: readPage(join(PKG, 'oxedyne_daimond_bg.wasm')) });
	assert.equal(typeof m.tool_result_cut, 'function', 'the bundle has no tool_result_cut');
	assert.deepEqual([...m.tool_result_cut(CUT)], [50000, 60000]);
	assert.deepEqual([...m.tool_result_cut('Wrote 6 bytes.')], []);
});

test('the result card draws the size note from the engine\'s answer', () => {
	const src = readFileSync(join(HERE, 'page', 'turns.js'), 'utf8');
	assert.match(src, /cutLine\(pg\.lastToolBlock, resultCut\(result\)\);/);
	assert.match(src, /Wasm\.tool_result_cut\(/);
	assert.match(src, /t\('chat\.tool_result_cut', vars\)/);
});

test('every locale says it, with both figures', () => {
	const dir = join(HERE, '..', 'i18n');
	const locs = readdirSync(dir).filter(f => f.endsWith('.js'));
	assert.equal(locs.length, 8, locs.join(' '));
	for (const f of locs) {
		const line = readFileSync(join(dir, f), 'utf8').split('\n')
			.find(l => l.includes("'chat.tool_result_cut':"));
		assert.ok(line, f + ' has no chat.tool_result_cut');
		assert.ok(line.includes('{shown}') && line.includes('{whole}'), f + ': ' + line);
	}
});
