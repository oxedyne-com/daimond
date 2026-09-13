// verify_foldshape.mjs — a fold comes back in a shape, and a fold that does not still folds.
//
// WHAT THIS IS WRITTEN FROM. A fold's note used to be whatever prose the compactor wrote, and
// what a model needs after a fold is not prose: it is the task, the next step, and the VALUES
// it learned. A free-form note keeps "we measured the caps" and loses "the cap is 4120", and
// the one thing nothing downstream can recover is the number.
//
// So the compactor is given a fixed heading layout (`prompts::FOLD_SHAPE_NOTE`) and the reply
// is parsed leniently (`compact::parse_fold_notes`). Headings and not JSON, because a truncated
// JSON document loses the whole note while a truncated heading document keeps every heading
// that arrived, and because each heading validates on its own.
//
// THE TWO PROPERTIES, and the second is the one that makes the first safe to ship:
//
//   1. A reply in the layout becomes a notice in the layout. The headings survive into the
//      conversation the model reads next, the value learned is in `## Found`, and the fold
//      event says `shape: 'structured'` so a measurement can count it.
//   2. A reply that is NOT the layout still folds. The prose becomes the note under
//      `## What happened`, the ledger is still beneath it, the turn still answers, and the
//      event says `shape: 'prose'`. A fold lost to a model that wrote paragraphs would be a
//      conversation that never gets under its window again.
//
//   DAIMOND_MOCK_FOLD=structured node dev/verify_foldshape.mjs
//   DAIMOND_MOCK_FOLD=garbage    node dev/verify_foldshape.mjs
//
// The mode reaches the mock through a sidecar beside its log, because the mock is a
// world-lived process whose environment was fixed when world.sh started it -- an env var on
// this process could never reach it. Cleared on the way out, so the next verifier to run
// against the same mock reads what it read yesterday.
//
// HOW EACH GOES RED. Run the OTHER mode: `structured` asserts on headings that a garbage
// reply cannot produce, and `garbage` asserts on the prose fallback that a structured reply
// does not take. Neither mode can pass the other's checks, which is what says the two are
// reading the shape rather than reading that a fold happened.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, clearMockLog, mockLog, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODE = String(process.env.DAIMOND_MOCK_FOLD || 'structured');
if (MODE !== 'structured' && MODE !== 'garbage') {
	console.error('DAIMOND_MOCK_FOLD must be "structured" or "garbage", got ' + JSON.stringify(MODE));
	process.exit(2);
}
const LOG   = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');
const SIDE  = LOG + '.fold';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

fs.writeFileSync(SIDE, MODE);
console.log('  (the mock is folding in ' + MODE + ' mode)');

const NAME = 'foldshape';
const s = await open({ name: NAME });
const p = s.page;

// A window small enough that a handful of turns will not fit, stubbed where `ensureApp` asks --
// the same seam `verify_foldreload.mjs` uses, so the app's own path carries the figure.
await p.evaluate(() => {
	window.DaimondPricing.contextWindow = function () { return 3000; };
	// The feed's own seam, recorded rather than sent: `shape` has to travel on the `fold`
	// event or a measurement cannot count a structured fold, and a feed that is switched off
	// (which it is, by default) would swallow it silently. The same stand-in
	// `dev/verify_contentoffload.mjs` uses.
	window.__ds = [];
	window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
});

try {
	clearMockLog();
	await chat(s, '@text the first thing said');
	// Many small turns rather than a few large ones: `tail_start` keeps at least
	// MIN_KEEP_MESSAGES, so a conversation of a few enormous messages has nothing it is
	// allowed to cut and falls back to shortening -- a real behaviour, and not this one.
	for (let i = 0; i < 14; i++) {
		await chat(s, '@text turn ' + i + ' ' + 'padding '.repeat(30));
	}

	const drawnOn = await p.evaluate(() => !!document.querySelector('.chat-msg-compacted'));
	check('the conversation was folded whatever the compactor answered', drawnOn);
	// THE NOTICE ITSELF, off the wire rather than off the screen. What is drawn is the page's
	// own tile -- a heading, a count and a sentence of the app's copy -- and the note the MODEL
	// reads is the user message in the request. A check that read the tile would be reading the
	// app's words and calling them the fold's.
	const noticeOf = (log) => {
		for (let i = log.length - 1; i >= 0; i--) {
			const m = (log[i].messages || []).find(x =>
				String(x.content || '').startsWith('[Daimond folded the earlier part'));
			if (m) return String(m.content || '');
		}
		return '';
	};
	const drawn = { text: noticeOf(mockLog()) };
	check('and the notice reached the model', !!drawn.text, drawn.text.length + ' chars');
	check('and the turn after it still answered', await p.evaluate(
		() => document.querySelectorAll('.chat-msg').length > 2));

	// The fold event the engine emitted, off the feed the page files it on.
	const shapes = await p.evaluate(() => (window.__ds || [])
		.filter(e => e && e.kind === 'fold' && e.payload && e.payload.trigger === 'real')
		.map(e => e.payload.shape || ''));

	if (MODE === 'structured') {
		check('the notice carries the layout the compactor was told to write',
			/##\s*Task/.test(drawn.text) && /##\s*Next step/.test(drawn.text),
			drawn.text.replace(/\n/g, ' / ').slice(0, 140));
		// THE VALUE AND NOT A DESCRIPTION OF IT, which is the whole reason `## Found` is in
		// the layout: a fold that keeps "we measured the cap" has kept the sentence and lost
		// the number, and nothing downstream can recover it.
		check('and the value the fold exists to carry survived it',
			/MOCKCAP=4120/.test(drawn.text), drawn.text.replace(/\n/g, ' / ').slice(0, 160));
		check('and the prose heading is not there as well',
			!/##\s*What happened/.test(drawn.text));
		check('and the ledger the app builds is still beneath it',
			/##\s*What was touched/.test(drawn.text) || /folded/i.test(drawn.text));
		check('the fold event says the note came back structured',
			shapes.some(x => x === 'structured'), JSON.stringify(shapes));
	} else {
		check('a reply that is not the layout still becomes the note',
			/##\s*What happened/.test(drawn.text),
			drawn.text.replace(/\n/g, ' / ').slice(0, 140));
		check('and it is the model\'s own words', /folded some things/i.test(drawn.text),
			drawn.text.replace(/\n/g, ' / ').slice(0, 160));
		check('and no heading of the layout was invented for it',
			!/##\s*Next step/.test(drawn.text));
		check('the fold event says the note came back as prose',
			shapes.some(x => x === 'prose'), JSON.stringify(shapes));
	}

	// AND THE COMPACTOR WAS ASKED FOR THE LAYOUT, read out of what the provider really got.
	// A note composed and not sent is no note, and the seam it is appended at is a function
	// nothing else calls.
	const asked = mockLog().find(r => (r.messages || []).some(m =>
		m && m.role === 'system' && /folding the earlier part/i.test(String(m.content || ''))));
	check('a summarising call was made at all', !!asked,
		asked ? (asked.messages || []).length + ' messages' : 'no compactor request in the log');
	const sys = asked ? String((asked.messages.find(m => m.role === 'system') || {}).content || '') : '';
	check('and it carried the layout, appended over whatever prompt the user has',
		/##\s*Files edited/.test(sys) && /##\s*Found/.test(sys), sys.slice(0, 90).replace(/\n/g, ' '));
	check('and the reply budget was not the prose one',
		!asked || (asked.max_tokens || 0) >= 2000, String(asked && asked.max_tokens));

	// The notice is a USER message, or a reload drops it and the conversation springs back.
	const last = mockLog().slice(-1)[0] || { messages: [] };
	const notice = (last.messages || []).find(m =>
		String(m.content || '').startsWith('[Daimond folded the earlier part'));
	check('the notice travels as a user message, whatever shape it is',
		!!notice && notice.role === 'user', notice ? notice.role : 'no notice in the request');

	const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
	check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	try { fs.unlinkSync(SIDE); } catch { /* the next run writes it again */ }
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
