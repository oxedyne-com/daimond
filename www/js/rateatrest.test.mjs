// rateatrest.test.mjs -- the rating controls of an answer are on show at rest, on a computer as on a phone.
//
//	node --test www/js/rateatrest.test.mjs
//
// Owner decision: the up, down and details controls (`.ctile-rate`) were opacity 0 on a computer until the
// tile was hovered or held focus, so a finished answer carried nothing to say it could be rated. They are
// now shown at rest as the phone shows them, quiet in colour (`--text-muted`, the app's muted-control
// token), and take the accent on hover or keyboard focus. Select mode hides them by `display: none`; a folded
// answer keeps its header group (a computer can rate a folded answer as it always could) and hides only the
// phone's row under the answer. The same rule serves a file row's group in the Files tile (`.turn-file-rate`),
// which is the same group in another place (bar rule 2).
//
// The sheet is read by role, not by the lines the old rule happened to sit on: any rule of any selector
// that names a rating control and sets opacity must set 1, so a later "faint until hover" cannot come
// back under another selector.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const css  = fs.readFileSync(path.join(WWW, 'css', 'app.css'), 'utf8');

// Flat rules of a sheet, in source order. At-rule bodies are entered, their own preludes dropped.
function rules(src) {
	src = src.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	const walk = (s) => {
		let i = 0;
		while (i < s.length) {
			const o = s.indexOf('{', i);
			if (o < 0) break;
			let d = 1, j = o + 1;
			while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
			const sel = s.slice(i, o).trim(), body = s.slice(o + 1, j - 1);
			if (sel.startsWith('@')) walk(body);
			else out.push({ sel, body });
			i = j;
		}
	};
	walk(src);
	return out;
}

// A selector list split at its top-level commas (a comma inside `:is(...)` is not a split).
function parts(sel) {
	const out = [];
	let d = 0, from = 0;
	for (let i = 0; i < sel.length; i++) {
		const c = sel[i];
		if (c === '(' || c === '[') d++;
		else if (c === ')' || c === ']') d--;
		else if (c === ',' && d === 0) { out.push(sel.slice(from, i).trim()); from = i + 1; }
	}
	out.push(sel.slice(from).trim());
	return out;
}

// The rating controls: the group, its three buttons and a file row's group; not the row form or the tag chips.
const RATE = /\.(ctile-rate(-up|-down|-more)?|turn-file-rate)(?![\w-])/;
const decl = (body, prop) => {
	const m = new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;]+)', 'g');
	const all = [];
	let x;
	while ((x = m.exec(body))) all.push(x[1].trim());
	return all;
};

const rs   = rules(css);
const rate = rs.filter((r) => parts(r.sel).some((p) => RATE.test(p)));

test('no rule puts a rating control at opacity below 1', () => {
	const bad = [];
	for (const r of rate) {
		for (const v of decl(r.body, 'opacity')) {
			if (parseFloat(v) !== 1) bad.push(`${r.sel.replace(/\s+/g, ' ')} { opacity: ${v} }`);
		}
	}
	assert.deepEqual(bad, [], 'a rating control is quiet by colour, never by opacity:\n  ' + bad.join('\n  '));
});

test('no rule hides a rating control at rest by visibility', () => {
	const bad = rate.filter((r) => decl(r.body, 'visibility').some((v) => v === 'hidden')).map((r) => r.sel);
	assert.deepEqual(bad, []);
});

test('a rating button rests in the muted-control colour and takes the accent on hover and on keyboard focus', () => {
	const rest = rate.filter((r) => parts(r.sel).includes('.ctile-rate-up') && decl(r.body, 'color').length);
	assert.ok(rest.length, 'no rule gives .ctile-rate-up a colour');
	assert.ok(rest.every((r) => decl(r.body, 'color').every((v) => v === 'var(--text-muted)')), 'the resting colour is not --text-muted');
	for (const st of ['hover', 'focus-visible']) {
		const lit = rs.filter((r) => parts(r.sel).includes('.ctile-rate button:' + st) && decl(r.body, 'color').includes('var(--accent)'));
		assert.ok(lit.length, `no rule takes the accent on .ctile-rate button:${st}`);
	}
});

test('select mode hides the rating controls; a folded answer keeps its header group', () => {
	const hides = (sel) => rs.some((r) => parts(r.sel).includes(sel) && decl(r.body, 'display').includes('none'));
	assert.ok(hides('.chat-output.selecting .ctile-rate'), 'select mode no longer hides .ctile-rate');
	assert.ok(hides('.chat-output.selecting .ctile-rate-row'), 'select mode no longer hides .ctile-rate-row');
	assert.ok(hides('.ctile.collapsed > .ctile-rate-row'), 'a folded answer no longer hides its phone rating row');
	assert.ok(!hides('.ctile.collapsed > .ctile-lbl .ctile-rate'), 'a folded answer hides its header rating group: the controls must stay reachable');
});

test('Copy keeps its own reveal: hidden at rest, shown on hover', () => {
	const rest = rs.filter((r) => parts(r.sel).includes('.ctile-copy') && decl(r.body, 'opacity').includes('0'));
	assert.ok(rest.length, 'Copy is no longer hidden at rest');
});
