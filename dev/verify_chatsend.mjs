// gateway: none
// verify_chatsend.mjs — `chat()` waits for a press of Send to be TAKEN before it waits for the turn.
//
// `chat()` clicked Send, slept 300 ms and read "Send is not busy" as "the reply has finished".
// Not busy is also true before the press has registered, so under load a turn went busy late,
// `chat()` returned early, and the next `chat()` landed inside the turn as an interjection
// (`chat-msg-interjected`, deliberately not `.chat-msg-user`). Verifiers that count turns broke:
// verify_turns read no turn 4 in the 2026-10-06 shard-3 run.
//
// The lateness is forced here, not hoped for: a capture-phase listener holds every press of
// Send for LATE_MS and then lets it through, so the question bubble and the busy Send both come
// seconds after the click. The listener is installed in THIS page by THIS file, so it cannot
// reach any other run.
//
//	node dev/verify_chatsend.mjs
//	node dev/verify_chatsend.mjs --break oldchat   # harness.mjs with the registration wait
//	                                               # cut back to the fixed 300 ms sleep
//
// The break is the real module, patched: the lines between the SEND-REGISTERS markers in
// `dev/harness.mjs` are replaced by the old sleep, the copy is written beside it (its relative
// imports need that), imported, and removed again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : '';
})();
if (BREAK && BREAK !== 'oldchat') {
	console.log(`no such break: ${BREAK}. This file declares: oldchat.`);
	process.exit(1);
}

/// `dev/harness.mjs` as it stood: the registration wait replaced by the fixed sleep.
async function harnessBefore() {
	const src = fs.readFileSync(path.join(HERE, 'harness.mjs'), 'utf8');
	const a = src.indexOf('\t// SEND-REGISTERS begin');
	const e = src.indexOf('\t// SEND-REGISTERS end');
	if (a < 0 || e < a) {
		throw new Error('the SEND-REGISTERS markers were not found in dev/harness.mjs, so this '
			+ 'break reproduces nothing. Fix harnessBefore() here.');
	}
	const cut = src.slice(0, a) + '\tawait page.waitForTimeout(300);\n'
		+ src.slice(src.indexOf('\n', e) + 1);
	if (cut === src) throw new Error('the cut changed nothing.');
	const f = path.join(HERE, `.harness.oldchat.${process.pid}.mjs`);
	fs.writeFileSync(f, cut);
	try { return await import(pathToFileURL(f).href); }
	finally { fs.rmSync(f, { force: true }); }
}

const H = BREAK === 'oldchat' ? await harnessBefore() : await import('./harness.mjs');
const { open, chat, errors } = H;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const LATE_MS = 4000;     // well past the old 300 ms, well inside SEND_REGISTER_MS
const s = await open({ name: 'chatsend' });
const p = s.page;
if (BREAK) console.log(`\n── BREAK ${BREAK}: dev/harness.mjs with chat() waiting a fixed 300 ms ──`);

// Hold every press of Send for LATE_MS, then let it through exactly once.
await p.evaluate((ms) => {
	document.addEventListener('click', (e) => {
		const b = e.target && e.target.closest && e.target.closest('#chat-send');
		if (!b || b.__late) return;
		e.stopImmediatePropagation();
		e.preventDefault();
		setTimeout(() => { b.__late = true; b.click(); b.__late = false; }, ms);
	}, true);
}, LATE_MS);

const shape = () => p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const q = sel => out ? [...out.querySelectorAll(sel)] : [];
	return {
		users: q('.chat-msg-user').length,
		inter: q('.chat-msg-interjected').length,
		answers: q('.chat-msg-assistant').map(a => a.innerText),
	};
});

const t0 = Date.now();
const r1 = await chat(s, '@text LATE-ALPHA first answer');
const t1 = Date.now() - t0;
const a1 = await shape();
check('chat() returns only once the delayed turn has answered',
	a1.answers.some(t => /LATE-ALPHA/.test(t)),
	`${a1.users} question(s), ${a1.answers.length} answer(s) after ${t1} ms`);
check('and it waited for the press, not for a fixed 300 ms', t1 >= LATE_MS - 500, `${t1} ms`);

await chat(s, '@text LATE-BETA second answer');
const a2 = await shape();
check('the second message is a turn of its own, not an interjection',
	a2.users === 2 && a2.inter === 0,
	`${a2.users} turn(s), ${a2.inter} interjected`);
check('and both turns are answered', /LATE-ALPHA/.test(a2.answers.join('|')) && /LATE-BETA/.test(a2.answers.join('|')));
check('chat() hands back the transcript', typeof r1 === 'string' && /LATE-ALPHA/.test(r1));

const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
check('the page throws nothing meanwhile', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
