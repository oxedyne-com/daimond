#!/usr/bin/env node
// Verifier for proposal #19 (superfluous stop button beside the enter button).
//
// Declared breaks:
//   --break markup   restores the removed <button id="chat-stop"> in index.html
//   --break unhide   restores `chatStop.hidden = (mode !== 'interject')`
//   --break listener restores the getElementById('chat-stop') lookup
//
// Every declared break reddens a check that passes clean, so these checks have
// each been seen to fail. That is what makes the pass above evidence.

import { readFileSync } from 'node:fs';

const BIDX = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.slice(8) : (BIDX >= 0 ? (process.argv[BIDX + 1] || '') : '');
if (BREAK && !['markup', 'unhide', 'listener'].includes(BREAK)) {
	console.error(`unknown break '${BREAK}' -- this verifier declares markup, unhide, listener`);
	process.exit(2);
}

const html = BREAK === 'markup'
	? readFileSync('www/index.html', 'utf-8') +
		'\n\t\t\t\t<button id="chat-stop" title="Stop" hidden>■</button>\n'
	: readFileSync('www/index.html', 'utf-8');
const js0 = readFileSync('www/js/daimond.js', 'utf-8');
const js = BREAK === 'listener'
	? js0 + "\nvar chatStop = document.getElementById('chat-stop');\n"
	: BREAK === 'unhide'
	? js0 + "\nif (chatStop) chatStop.hidden = (mode !== 'interject');\n"
	: js0;
const appC = readFileSync('www/css/app.css', 'utf-8');

let fails = 0, n = 0;
function ck(name, ok) {
	n++;
	const mark = ok ? 'ok  ' : 'FAIL';
	console.log(`  ${mark}   ${name}`);
	if (!ok) fails++;
}

// 1. The button is gone from the markup (or, under the markup break, back).
const htmlHasBtn = /<button id="chat-stop"/.test(html);
ck('index.html carries no chat-stop button', !htmlHasBtn);

// 2. No JS looks the button up in the document (listener break restores it).
const jsLooksUp = /getElementById\('chat-stop'\)/.test(js);
ck('no getElementById(chat-stop) anywhere in daimond.js', !jsLooksUp);

// 3. The interject-mode unhiding is gone; the guard hides always, and null
//    short-circuits it anyway. The unhide break restores the mode toggle.
const unhides = /chatStop\.hidden = \(mode !== 'interject'\)/.test(js);
ck('no interject-mode unhiding of the second stop', !unhides);

// 4. The send button itself still carries the three modes -- the removal must
//    not have touched setSendMode's honest core.
ck('setSendMode still distinguishes stop/interject/send',
	/'stop'\s*\?\s*t\('chat\.stop'\)/.test(js) &&
	/'interject'\s*\?\s*t\('chat\.send_into'\)/.test(js));

// 5. sendMode() still derives the mode from the composer.
ck('sendMode still reads curGen and the composer',
	/curGen\(\)\) return 'send'/.test(js.replace(/!curGen\(\)\s*/, '!curGen() ')) ||
	/function sendMode\(\) \{[\s\S]*?curGen\(\)[\s\S]*?interject/.test(js));

// 6. No orphaned CSS keeps styling a button that no longer exists.
ck('app.css carries no #chat-stop styling', !/#chat-stop/.test(appC));

// 7. The i18n key chat.stop is still in the catalogue -- the send button's ■
//    mode still needs it (chat.send_into likewise).
const en = readFileSync('www/i18n/en.js', 'utf-8');
ck("en.js still carries 'chat.stop' and 'chat.send_into'",
	/'chat\.stop'/.test(en) && /'chat\.send_into'/.test(en));

console.log(BREAK ? `\nbreak ${BREAK}: ${fails} FAIL of ${n}` : `\n${n - fails}/${n} checks clean`);
process.exit(fails ? 1 : 0);
