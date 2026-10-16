// leadok.test.mjs -- the confirm tick is drawn, never read.
//
//	node --test www/js/leadok.test.mjs
//
// `.lead-ok` draws its tick as generated content beside a word that already says
// what the control does, and a menu check row says its state by aria-checked. A
// tick read aloud as well made VoiceOver say "tick, checked" (GATEFIX, r568). The
// tick carries an empty alternative text (`/ ''`), after a plain declaration an
// engine without the alternative syntax keeps, so no engine loses the tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS  = fs.readFileSync(path.join(HERE, '..', 'css', 'app.css'), 'utf8');

test('the lead-ok tick has an empty alternative text, after a plain fallback', () => {
	const m = CSS.match(/^\.lead-ok::before \{([^}]*)\}/m);
	assert.ok(m, 'no .lead-ok::before rule of its own in app.css');
	const decls = m[1].split(';').map((d) => d.trim()).filter((d) => d.startsWith('content:'));
	assert.deepEqual(decls, [ "content: '\\2714'", "content: '\\2714' / ''" ],
		'the tick must be drawn and announced as nothing: ' + JSON.stringify(decls));
});

test('no other rule gives lead-ok a glyph that would be read', () => {
	for (const r of CSS.matchAll(/^([^{\n]*\.lead-ok[^{\n]*)\{([^}]*)\}/gm)) {
		for (const d of r[2].split(';').map((x) => x.trim()).filter((x) => /^content:\s*'[^']+'/.test(x))) {
			assert.ok(/\/\s*''$/.test(d) || r[1].trim() === '.lead-ok::before' && d === "content: '\\2714'",
				`${r[1].trim()} has a spoken glyph: ${d}`);
		}
	}
});
