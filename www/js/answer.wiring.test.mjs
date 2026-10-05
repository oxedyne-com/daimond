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

// ── U6 (r535): dead controls by role ───────────────────────────────────
test('the home Send is built through the helper with a reason and a say, and nothing else binds its click', () => {
	const d = read('js', 'daimond.js');
	assert.match(d, /sendCtl\s*=\s*DaimondAnswer\.control\(chatSend, \{[^}]*can: sendWhy\b[^}]*say: sendSay\b/);
	assert.match(d, /DaimondAnswer\.reasons\.send_home\(/);
	assert.equal(count(d, /chatSend\.addEventListener\(\s*'click'/g), 0, 'a bare click on Send');
	assert.match(d, /bindSend\(\);/, 'the control is never built');
	// A hold is the helper's, so the page cannot set `disabled` behind its back.
	assert.equal(count(d, /chatSend\.disabled\s*=/g), 1, 'only the fallback before the control exists');
	assert.match(d, /sendCtl\.hold\(mode === 'sending'\)/);
});

test('every place the composer\'s words change by script re-asks Send, since a script raises no input event', () => {
	const d = read('js', 'daimond.js');
	for (const fn of [ 'function putInComposer(', 'function clearComposer(', 'function editResend(' ]) {
		const at = d.indexOf(fn);
		assert.ok(at > 0, fn + ' moved');
		const next = d.slice(at + 10).search(/\n\t(async )?function \w+/);
		assert.match(d.slice(at, at + 10 + next), /syncSendMode\(\)/, fn + ' leaves Send as it was');
	}
});

test('all three Refresh buttons are built through the helper and end in a note on their panel', () => {
	const d = read('js', 'daimond.js'), s = read('js', 'spend.js'), m = read('js', 'modeldash.js');
	assert.match(d, /DaimondAnswer\.control\(\s*panel\.querySelector\('\[data-act="refresh"\]'\)/);
	for (const [ src, act ] of [ [ s, 'spend-refresh' ], [ m, 'modeldash-refresh' ] ]) {
		assert.match(src, new RegExp('DaimondAnswer\\.control\\(\\s*panel\\.querySelector\\(\'\\[data-act="' + act + '"\\]\'\\)'), act + ' is not built through control');
		assert.equal(count(src, new RegExp('closest\\(\'\\[data-act="' + act + '"\\]\'\\)', 'g')), 0, act + ' still has a delegated bare click');
		assert.match(src, /DaimondAnswer\.note\(/, act + ' says nothing when it has run');
	}
	assert.match(s, /gateway\.acct_unreachable/, 'a refresh that could not reach the account says so rather than "Refreshed."');
});

test('the walk-back buttons are hidden while they cannot act, and re-asked wherever the thread moves', () => {
	const d = read('js', 'daimond.js');
	assert.match(html, /<button id="chat-jump" hidden/);
	assert.match(html, /<button id="chat-end" hidden/);
	assert.match(read('css', 'app.css'), /#chat-jump\[hidden\],\s*#chat-end\[hidden\]\s*\{\s*display:\s*none/);
	assert.match(d, /DaimondAnswer\.show\(jumpBtn, DaimondAnswer\.shown\.jump_back\(/);
	assert.match(d, /DaimondAnswer\.show\(endBtn, DaimondAnswer\.shown\.jump_end\(/);
	const body = (name) => { const at = d.indexOf('function ' + name + '('); const n = d.slice(at + 10).search(/\n\t(async )?function \w+/); return d.slice(at, at + 10 + n); };
	assert.match(body('setScrollTop'), /syncJumps\(\)/);
	assert.match(body('clearChat'), /syncJumps\(\)/);
	// The thread's own scroll listener and resize observer; no listener of its own.
	assert.match(d, /chatOutput\.addEventListener\('scroll', function \(\) \{\s*_wasAtEnd = nearBottom\(\);\s*syncJumps\(\);/);
	assert.match(d, /new ResizeObserver\(function \(\) \{\s*syncJumps\(\);/);
	assert.equal(count(d, /chatOutput\.addEventListener\('scroll'/g), 1, 'a second scroll listener');
});

test('Mail Sync now is built through the helper with a reason and a say, and re-asked wherever the panel draws', () => {
	const m = read('js', 'mail.js');
	assert.match(m, /syncCtl\s*=\s*DaimondAnswer\.control\(btn, \{[^}]*can: syncWhy\b[^}]*say: syncSay\b/);
	assert.match(m, /DaimondAnswer\.reasons\.sync_mail\(/);
	assert.match(m, /bindSync\(sync\);/, 'the control is never built');
	assert.equal(count(m, /sync\.addEventListener\(\s*'click'/g), 0, 'a bare click on Sync now');
	// A mailbox arrives or leaves by a draw, so the draw re-asks.
	const at = m.indexOf('\tfunction render() {');
	assert.ok(at > 0, 'render moved');
	const next = m.slice(at + 10).search(/\n\t(async )?function \w+/);
	assert.match(m.slice(at, at + 10 + next), /syncCtl\.sync\(\)/, 'render leaves Sync now as it was');
});

test('a gated control is dimmed by aria-disabled wherever it was dimmed by disabled: the rail buttons and home Send', () => {
	const css = read('css', 'app.css');
	assert.match(css, /\.addbtn\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*0\.4/);
	assert.match(css, /\.addbtn\[aria-disabled="true"\]:hover\s*\{[^}]*color:\s*var\(--text-secondary\)/);
	assert.match(css, /#chat-send\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*0\.4/);
	assert.match(read('css', 'skin-daylight.css'), /\.addbtn\[aria-disabled="true"\]:hover\s*\{[^}]*background:\s*transparent/);
});

test('the reason Sync now gives is in all eight languages', () => {
	for (const l of [ 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans' ]) {
		assert.match(read('i18n', l + '.js'), /'trig\.no_mailbox':/, l);
	}
});
