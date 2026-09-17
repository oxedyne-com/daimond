// p18: the empty-transcript blank ("No conversation yet. Ask below.") must
// appear ONCE, no matter how many times the daimon's chat face is re-opened.
//
// Defect: daimond.js:42442 appended the blank after every renderHistory([]) —
// and renderHistory's identical-transcripts early return (18942) clears
// nothing — so each crystal→chat switch stacked another blank under the last.
// Fix: take the previous blank down before appending a fresh one.
//
// The logic is lifted VERBATIM from the call site (the `if (!rec.messages.length)`
// block at daimond.js ~42437) and run against a fake DOM chatOutput, twice —
// a second visit simulating the view switch. Breaks patch the SOURCE or the
// lifted block and prove each check fails against the shipped defect.
//
// Declared breaks: `nobreak` is not a break; run `--break=stacks` to restore
// the shipped defect (no prev.remove()) and `--break=always` to append
// unconditionally.

import { readFileSync } from 'node:fs';

const BIDX = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.slice(8) : (BIDX >= 0 ? (process.argv[BIDX + 1] || '') : '');

// ── Source guards ──────────────────────────────────────────
const src = readFileSync('www/js/daimond.js', 'utf-8');
let checks = 0, fails = 0;
const ck = (name, ok) => {
	checks++;
	if (!ok) { fails++; console.log('  FAIL ' + name); }
	else console.log('  ok   ' + name);
};

// 1. the guard exists at the call site
ck('guard: prev blank is taken down before a fresh append',
	src.includes("var prev = chatOutput.querySelector('.chat-msg-empty');") &&
	src.includes('if (prev) prev.remove();'));
// 2. the blank is only drawn for an empty transcript
ck('blank drawn only inside the empty-transcript branch',
	/if \(!rec\.messages\.length\) \{[\s\S]{0,400}chat-msg-empty/.test(src));
// 3. the blank carries the chat_empty text
ck("blank text comes from t('crystal.chat_empty')",
	src.includes("blank.textContent = t('crystal.chat_empty')"));

// ── Behaviour, lifted verbatim ────────────────────────────
// The call-site block, minus the function around it, run twice against a
// fake DOM. Second run = the view switch back; the guard must keep it to one.
function fakeOutput() {
	const kids = [];
	return {
		get children() { return kids.slice(); },
		appendChild(n) { kids.push(n); },
		querySelector(sel) {
			const want = sel.replace(/^\./, '').split('.');
			return kids.find(k => want.every(c => (k.className || '').includes(c))) || null;
		},
	};
}

// Lifted block, verbatim in behaviour. On the stacks break the guard is gone.
const GUARDED = `\t\t\tif (!rec.messages.length) {
				var prev = chatOutput.querySelector('.chat-msg-empty');
				if (prev) prev.remove();
				var blank = document.createElement('div');
				blank.className = 'chat-msg chat-msg-empty';
				blank.textContent = t('crystal.chat_empty');
				chatOutput.appendChild(blank);
			}`;

const STACKS = `\t\t\tif (!rec.messages.length) {
				var blank = document.createElement('div');
				blank.className = 'chat-msg chat-msg-empty';
				blank.textContent = t('crystal.chat_empty');
				chatOutput.appendChild(blank);
			}`;

const ALWAYS = `\t\t\t{
				var blank = document.createElement('div');
				blank.className = 'chat-msg chat-msg-empty';
				blank.textContent = t('crystal.chat_empty');
				chatOutput.appendChild(blank);
			}`;

const blockSrc = BREAK === 'stacks' ? STACKS : BREAK === 'always' ? ALWAYS : GUARDED;
function t(k) { return 'No conversation yet. Ask below.'; }
function mkNode() {
	return { className: '', textContent: '', _removed: false,
		remove() { this._removed = true; } };
}
function mkOutput() {
	const kids = [];
	const out = {
		get children() { return kids.slice(); },
		appendChild(n) { kids.push(n); return n; },
		querySelector(sel) {
			const want = sel.replace(/^\./, '').split('.');
			const hit = kids.filter(k => want.every(c => (k.className || '').includes(c)));
			// a removed node is gone from the thread
			const live = hit.filter(k => !k._removed);
			return live[live.length - 1] || null;
		},
	};
	return out;
}
function createElement() { return mkNode(); }
function fresh() { return mkOutput(); }

// Simulate: open (visit 1), switch away and back (visit 2, same empty chat).
const out = fresh();
const rec = { messages: [] };
const run1 = new Function('chatOutput', 'rec', 't', 'createElement',
	'const document = { createElement: createElement };\n' +
	blockSrc + '\nreturn chatOutput.children.length;');
run1(out, rec, t, createElement);
const after1 = out.children.filter(k => !k._removed).length;
ck('first open of the empty chat face draws exactly one blank', after1 === 1);

// Second visit — the view switch. The identical-transcripts early return in
// renderHistory clears NOTHING, so the guard is the only thing standing
// between the second append and a stack.
const run2 = new Function('chatOutput', 'rec', 't', 'createElement',
	'const document = { createElement: createElement };\n' +
	blockSrc + '\nreturn chatOutput.children.length;');
run2(out, rec, t, createElement);
const live = out.children.filter(k => !k._removed);
ck('second visit leaves exactly one blank on the thread', live.length === 1);

// Third — the accumulation the report named ("repeats on every switch").
run2(out, rec, t, createElement);
const live3 = out.children.filter(k => !k._removed);
ck('third visit still leaves exactly one blank', live3.length === 1);

// And the guard is really what did it: with the guard, one stays.
ck('the surviving blank carries the chat_empty text',
	live3.length === 1 && /No conversation yet/.test(live3[0].textContent || ''));

console.log(fails ? `${fails} of ${checks} checks failed` : `${checks} of ${checks} checks passed`);
process.exit(fails ? 1 : 0);
