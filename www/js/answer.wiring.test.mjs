// answer.wiring.test.mjs -- that no action control goes around the answer rule.
//
//	node --test www/js/answer.wiring.test.mjs
//
// answer.test.mjs proves the rule. This proves nothing binds AROUND it: the next
// button added to a sheet's Ask pill or Compose's foot, or the next chip given a
// click, would otherwise bring back a control that takes a press, changes nothing
// and says nothing, and no unit test of the helper could see it. The checks are
// over the source, by role (the pattern layers.wiring.test.mjs set).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(WWW, ...p), 'utf8');
const JS   = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'));
const html = read('index.html');
const count = (s, re) => (s.match(re) || []).length;

// The ids of the buttons inside one container of the page, found by its class.
function buttonsIn(cls) {
	const at = html.indexOf('class="' + cls + '"');
	assert.ok(at > 0, 'the page has no ' + cls);
	// Neither container holds another div, so the first </div> after its first button closes it.
	const end = html.indexOf('</div>', html.indexOf('</button>', at));
	const body = html.slice(at, end);
	return [ ...body.matchAll(/<button\b[^>]*\bid="([^"]+)"/g) ].map((m) => m[1]);
}

// The variable a file binds the element `id` to, and whether the file hands that variable to the helper.
function routed(id) {
	for (const f of JS) {
		const s = read('js', f);
		const m = s.match(new RegExp('(\\w+)\\s*=\\s*document\\.getElementById\\(\'' + id + '\'\\)'));
		if (!m) continue;
		const v = m[1];
		// The function the binding sits in, up to the next function at its level: a name like `send` is reused elsewhere in a file.
		const from = m.index, next = s.slice(from).search(/\n\t(async )?function \w+/);
		const here = next < 0 ? s.slice(from) : s.slice(from, from + next);
		return { file: f, v, ok: new RegExp('DaimondAnswer\\.control\\(\\s*' + v + '\\b').test(here),
			bare: new RegExp('\\b' + v + '\\.addEventListener\\(\\s*\'click\'').test(here) };
	}
	return null;
}

test('the helper is loaded after the language machinery and before anything that binds a control', () => {
	const at = (s) => html.indexOf('src="' + s + '"');
	assert.ok(at('js/answer.js') > at('js/i18n.js'), 'answer.js must follow i18n.js, which it registers with');
	assert.ok(at('js/answer.js') < at('js/mobile.js'), 'answer.js must precede mobile.js');
	assert.ok(at('js/answer.js') < at('js/daimond.js'), 'answer.js must precede daimond.js');
});

test('every button on the Ask pill is bound through the helper and by no click of its own', () => {
	const ids = buttonsIn('msheet-ask');
	assert.ok(ids.includes('msheet-ask-send'), 'the scan lost the Ask button: ' + ids);
	for (const id of ids) {
		const r = routed(id);
		assert.ok(r, id + ' is bound nowhere');
		assert.ok(r.ok, `${id}: ${r.file} binds ${r.v} without DaimondAnswer.control`);
		assert.equal(r.bare, false, `${id}: ${r.file} also binds a bare click on ${r.v}`);
	}
});

test('every button in Compose\'s foot is bound through the helper and by no click of its own', () => {
	const ids = buttonsIn('compose-foot');
	assert.deepEqual(ids.sort(), [ 'compose-attach', 'compose-discard', 'compose-save', 'compose-send' ]);
	for (const id of ids) {
		const r = routed(id);
		assert.ok(r, id + ' is bound nowhere');
		assert.ok(r.ok, `${id}: ${r.file} binds ${r.v} without DaimondAnswer.control`);
		assert.equal(r.bare, false, `${id}: ${r.file} also binds a bare click on ${r.v}`);
	}
});

test('each of those controls takes its reason from the table, so none can invent a silent one', () => {
	const m = read('js', 'mobile.js'), d = read('js', 'daimond.js');
	assert.match(m, /DaimondAnswer\.reasons\.ask\(/);
	// Compose takes the table once (`R = DaimondAnswer.reasons`) and names each row it uses.
	assert.match(d, /\bR = DaimondAnswer\.reasons;/);
	for (const r of [ 'send', 'draft' ]) assert.equal(count(d, new RegExp('can: why\\(R\\.' + r + '\\)', 'g')) >= 1, true, r);
	assert.equal(count(d, /can: why\(R\.draft\)/g), 3, 'Save Draft, Attach and Discard each take the draft row');
});

test('the Ask pill and Compose each hand the rule a say, so a press that reaches a gated control is answered', () => {
	const m = read('js', 'mobile.js'), d = read('js', 'daimond.js');
	assert.match(m, /DaimondAnswer\.control\(askSend, \{[^}]*\bsay: askSay\b/);
	assert.match(html, /id="msheet-ask-note"/, 'the sheet has no note line for the Ask pill to say it in');
	assert.match(m, /askNote\s*=\s*document\.getElementById\('msheet-ask-note'\)/);
	// Compose: every one of the four names composeSay.
	assert.equal(count(d, /DaimondAnswer\.control\((send|save|attach|discard), \{[^\n]*\bsay: composeSay\b/g), 4);
});

test('a gated control is aria-disabled, never disabled, in the helper and dimmed by the same rule in the sheets', () => {
	const a = read('js', 'answer.js');
	// `disabled` is only ever set for a hold, which gives no reason.
	assert.equal(count(a, /\.disabled\s*=\s*true/g), 1, 'only the hold may set disabled');
	assert.match(a, /setAttribute\('aria-disabled', 'true'\)/);
	assert.match(read('css', 'mobile.css'), /#msheet-ask-send\[aria-disabled="true"\]/);
	assert.match(read('css', 'mail.css'), /\.compose-send\[aria-disabled="true"\]/);
	assert.match(read('css', 'mail.css'), /\.compose-btn\[aria-disabled="true"\]/);
});

test('publishing DaimondCore re-asks every control, since a reason may read it (r533 QA B-5)', () => {
	const d = read('js', 'daimond.js');
	const at = d.indexOf('window.DaimondCore = {');
	assert.ok(at > 0, 'DaimondCore is not published where it was');
	const end = d.indexOf('\n\t};', at);
	assert.ok(end > at);
	// The Ask pill is built by mobile.js, which can run before this and read `DaimondCore.ask` as absent.
	assert.match(d.slice(end, end + 700), /DaimondAnswer\.syncAll\(\)/, 'nothing re-asks the controls once DaimondCore is there');
	assert.match(read('js', 'mobile.js'), /ready: !!\(window\.DaimondCore && DaimondCore\.ask\)/, 'the reason the publish lifts is no longer read from DaimondCore.ask');
});

test('Compose is bound once, at boot, and what it holds is let go when its draft is closed', () => {
	const d = read('js', 'daimond.js');
	assert.equal(count(d, /\binitCompose\(\);/g), 1, 'initCompose must be called once, beside the other panels\' init');
	assert.equal(count(d, /\bcomposeCur\s*=\s*null\b/g) >= 2, true, 'a sent or discarded draft must clear composeCur');
	// The old shape cloned the buttons on every showing and bound four fresh clicks: nothing may do that again.
	assert.equal(count(d, /\[send, save, attach, file, discard\]\.forEach/g), 0);
});

test('Workspace Refresh is bound through the helper and its result is said where the panel keeps notes', () => {
	const d = read('js', 'daimond.js');
	assert.equal(count(d, /querySelector\('\[data-act="refresh"\]'\)\.addEventListener/g), 0, 'a bare click on Refresh');
	assert.match(d, /DaimondAnswer\.control\(\s*panel\.querySelector\('\[data-act="refresh"\]'\)/);
	assert.match(d, /showModeMsg\(t\('files\.refreshed'\)/);
});

test('a note meant to pass takes its own leave', () => {
	const d = read('js', 'daimond.js');
	assert.match(d, /function showModeMsg\(text, isErr, ms\)/);
	assert.match(d, /if \(ms\) setTimeout\(/);
});

test('the Machine chip\'s native folder picker is seen by the crawl, so it is not read as a press that did nothing', () => {
	const c = read('..', 'dev', 'crawl.mjs');
	assert.match(c, /showDirectoryPicker/);
	assert.match(c, /\[\s*'picker',\s*name\s*\]/);
});

test('the crawl\'s allow list carries a reason for every entry, and no entry is a bare selector', () => {
	const c = read('..', 'dev', 'crawl.mjs');
	const block = c.slice(c.indexOf('const ALLOW = ['), c.indexOf('];', c.indexOf('const ALLOW = [')));
	const entries = count(block, /\{ surface:/g);
	assert.ok(entries >= 3, 'the allow list lost entries: ' + entries);
	assert.equal(count(block, /why:\s*'[^']{40,}/g), entries, 'an entry without a reason of some length');
});

test('the delegating host of the Improve board is not read as a control of its own', () => {
	const c = read('..', 'dev', 'crawl.mjs');
	assert.match(c, /ignore:\s*'[^']*#tracker-view/);
});

test('no new chip is given a click that has no answer: a chip with a handler is a role=button with a key', () => {
	const d = read('js', 'daimond.js');
	const at = d.indexOf('function modeChip(');
	const body = d.slice(at, d.indexOf('return c;', at));
	assert.match(body, /setAttribute\('role', 'button'\)/);
	assert.match(body, /setAttribute\('tabindex', '0'\)/);
	assert.match(body, /ev\.key === 'Enter'/);
});
