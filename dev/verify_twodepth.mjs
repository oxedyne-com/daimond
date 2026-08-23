// verify_twodepth.mjs — the two-depth answer, and the streaming that is the whole
// point of it.
//
// A model can now fold part of its answer away in the answer itself: a
// `<details>` in the markdown, no tool involved. The tool it replaces, `say`, did
// not stream at all — an unchanging spinner for one to three minutes on a hard
// question, and then the whole reply at once. So THE STREAMING IS THE FEATURE.
// A fold that renders beautifully and stops the text arriving is a regression,
// however well it folds, and most of what is asserted below is about the stream
// rather than about the fold.
//
// What is asserted, and why each one rather than the next thing:
//
//   1. THE KEY, AGAINST THE FIXTURE ON DISK. `dev/fixtures/fold_keys.json` is the
//      one name the Rust and JS halves must agree on (dev/CONTRACT_FOLD.md §2).
//      Every case in it is READ FROM THE FILE and driven through the shipped
//      `DaimondRender.foldScan` in the real page — not transcribed into this
//      file, so a case added to the fixture cannot silently stop being checked,
//      and a case changed cannot silently start agreeing with a copy.
//
//   2. THE ANSWER ABOVE THE FOLD STREAMS. Sampled every frame of a real turn
//      against the mock provider: the text above the fold is complete on screen
//      while the fold's own body is still filling, and the body grows across
//      frames rather than appearing whole at the end. This is the check the
//      feature exists for.
//
//   3. THE CONTROL IS MADE ONCE. A `MutationObserver` counts every
//      `details.md-fold` ever inserted into the bubble across the whole turn, and
//      the survivor is stamped so its identity can be read back. One insertion,
//      not one per frame: a fold rebuilt per frame is a fold that snaps shut
//      sixty times a second and takes the reader's place in it with it.
//
//   4. A CLOSED FOLD'S BODY IS NOT VISIBLE — AND A RECT WITH AREA IS NOT EVIDENCE.
//      A closed `<details>` in Chrome puts its contents behind
//      `content-visibility: hidden`, and a skipped subtree KEEPS ITS LAST LAYOUT:
//      `getBoundingClientRect()` on a paragraph inside a closed fold comes back
//      with real width and height, sitting below the one-line fold that is
//      supposedly containing it. Measured that way the check would pass on a fold
//      that never closes. So "shown" is two geometric facts together — the
//      content's rect lies INSIDE the fold's own rect, and the point at its
//      centre hit-tests to something inside the fold — and it is asserted BOTH
//      ways, closed and then open, so a measurement that can only ever say "no"
//      cannot pass for a proof.
//
//   5. THE OPEN SET REACHES WASM. `DaimondApp.set_open_folds` is wrapped on its
//      prototype and the real one still called, so what is recorded is what the
//      engine was actually handed. Opening a fold has to put that fold's key into
//      it. (What the ENGINE then does with the set is the Rust half's, and is not
//      asserted here.)
//
//   6. A FOLD WITH NOTHING ABOVE IT IS DRAWN OPEN. `say` could refuse an empty
//      summary — src/tools.rs calls it "the one failure worth refusing", because
//      it draws a fold the user must open to discover says nothing. Markup cannot
//      be refused, so the renderer takes the decision instead.
//
//   7. A FENCED FOLD IS NOT A FOLD. A `<details>` inside a code fence is a model
//      SHOWING markup. No control is drawn and the angle brackets stay on screen.
//
//   8. NOTHING EXECUTABLE RIDES IN ON THE LABEL. The summary is a NEW
//      `innerHTML` sink taking model text: the fold's control is built by hand,
//      so the label does not travel through `md` with the rest of the message.
//      It goes through the same sanitiser, and this is the check that says so
//      rather than the comment beside it.
//
//   9. A FOLD INSIDE A FOLD TAKES NO KEY. The renderer nests correctly for free,
//      because the browser's parser does; what has to be proved is that the KEY
//      does not, since only a top-level fold takes an ordinal
//      (CONTRACT_FOLD.md §8) and one extra here would rename every fold after it
//      in the engine's eyes.
//
//   11. THE LABEL IS LEGIBLE. Measured against the ANSWER IT SITS BESIDE, not
//      against a number written here: same size, same ink. Every other check in
//      this file passes on a fold the reader never finds, which is what happened
//      -- see 11 below for whose screen it happened on.
//
//   10. THE READER'S CHOICE SURVIVES A RELOAD. The key is an ordinal and a label
//      and carries no message identity, which is exactly what makes this possible
//      without touching the stored chat schema.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page (through
// `page.route`), and the run is then expected to FAIL. A break whose anchor does
// not appear exactly once aborts rather than passing quietly.
//
//   node dev/verify_twodepth.mjs --break keysep      # 1: the key's separator
//   node dev/verify_twodepth.mjs --break fencedfold  # 1,7: a fenced fold counted
//   node dev/verify_twodepth.mjs --break nestordinal # 1,9: a nested fold counted
//   node dev/verify_twodepth.mjs --break nostream    # 2: drawn only at the end
//   node dev/verify_twodepth.mjs --break perframe    # 3: the control rebuilt
//   node dev/verify_twodepth.mjs --break holdforever # 1: the hold-back never let go
//   node dev/verify_twodepth.mjs --break flicker     # 1: the half-written fold drawn
//   node dev/verify_twodepth.mjs --break alwaysopen  # 4: a fold that never shuts
//   node dev/verify_twodepth.mjs --break bodygone    # 4: a body that never shows
//   node dev/verify_twodepth.mjs --break openbroken  # 5: the gesture not recorded
//   node dev/verify_twodepth.mjs --break rawlabel    # 8: the label as live markup
//   node dev/verify_twodepth.mjs --break bareclosed  # 6: nothing above it, shut
//   node dev/verify_twodepth.mjs --break barequiet   # 6: the decision left unsaid
//   node dev/verify_twodepth.mjs --break noreload    # 10: the choice not restored
//   node dev/verify_twodepth.mjs --break mutedlabel  # 11: the label as a caption
//   node dev/verify_twodepth.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 3 --up)"
//   node dev/verify_twodepth.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs. No gateway and no real provider: the
// mock is told exactly what to stream, so nothing here spends anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, shot, scratch, errors, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'twodepth' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The one name both languages must agree on, spelled differently. Nothing
	// visible changes; only the fixture notices, which is what the fixture is for.
	keysep: [{
		file: 'js/render.js',
		find: "\t\t\tf.key = i + ':' + f.summary;",
		with: "\t\t\tf.key = i + '|' + f.summary;",
	}],
	// Fenced code read as markup: a model showing a reader how to write a fold
	// has the demonstration folded away instead.
	fencedfold: [{
		file: 'js/render.js',
		find: '\t\t\tif (inRanges(fenced, m.index)) continue;',
		with: '\t\t\tif (false) continue;',
	}],
	// THE REGRESSION THIS FEATURE EXISTS TO AVOID: nothing on screen until the
	// generation ends, which is what `say` did and what made it worth replacing.
	nostream: [{
		file: 'js/daimond.js',
		find: '\t\tvar pinned = nearBottom();\n\t\tdrawAsst();\n'
			+ '\t\tif (pinned) chatOutput.scrollTop = chatOutput.scrollHeight;\n'
			+ '\t}\n\tfunction appendAssistantText(text) {',
		with: '\t\tvar pinned = nearBottom();\n'
			+ '\t\tif (pinned) chatOutput.scrollTop = chatOutput.scrollHeight;\n'
			+ '\t}\n\tfunction appendAssistantText(text) {',
	}],
	// The control rebuilt every frame — the obvious implementation, and the one
	// that loses the reader's open fold and their place in it sixty times a second.
	perframe: [{
		file: 'js/daimond.js',
		find: '\t\t\tif (!cur || cur.id !== id) {',
		with: '\t\t\tif (true) {',
	}],
	// The label put on screen as markup. It is the one place model text reaches
	// `innerHTML` without going through `md` first, and it is invisible from
	// anywhere but here.
	rawlabel: [{
		file: 'js/daimond.js',
		find: '\t\tsum.innerHTML = DaimondRender.sanitize(seg.label);',
		with: '\t\tsum.innerHTML = seg.label;',
	}],
	// The label drawn as a caption again: muted, and a size below the answer it
	// belongs to. This is the state the owner met on 2026-08-23, and it is the one
	// shape of this feature that nothing could see -- every behavioural check above
	// passes on a fold nobody can find.
	mutedlabel: [{
		file: 'css/app.css',
		find: 'details.md-fold > summary {\n\tpadding: 4px 0;\n\tcolor: var(--text-primary);'
			+ '\n\tfont-size: var(--fs-base);',
		with: 'details.md-fold > summary {\n\tpadding: 4px 0;\n\tcolor: var(--text-muted);'
			+ '\n\tfont-size: var(--fs-sm);',
	}],
	// A nested fold given an ordinal of its own, which is what the contract's
	// Amendment 1 forbids: the engine counts only top-level folds, so every key
	// after a nested one would name a different fold in each half.
	nestordinal: [{
		file: 'js/render.js',
		find: '\t\t\tif (top) found.push(fold);',
		with: '\t\t\tfound.push(fold);',
	}],
	// The hold-back removed, so the browser's own half-formed disclosure is drawn
	// for the few frames between `<details>` and `</summary>` and then replaced.
	// This is not hypothetical: it is what this file caught, on 2026-08-21.
	flicker: [{
		file: 'js/render.js',
		find: '\tfunction foldPending(rest) {\n',
		with: '\tfunction foldPending(rest) {\n\t\treturn false;\n',
	}],
	// A fold that is never shut, so "closed hides its body" has nothing to measure.
	alwaysopen: [{
		file: 'js/daimond.js',
		find: '\t\td.open = !!_openFolds[seg.key];',
		with: '\t\td.open = true;',
	}],
	// The other half of the same check: a body that is never shown. Without this
	// break, "closed is hidden" could be passing on a measurement that always
	// answers hidden.
	bodygone: [{
		file: 'css/app.css',
		find: 'details.md-fold > .md-fold-body > :last-child { margin-bottom: 0; }',
		with: 'details.md-fold > .md-fold-body > :last-child { margin-bottom: 0; }\n'
			+ 'details.md-fold > .md-fold-body { display: none; }',
	}],
	// The gesture that manages the reader's screen no longer manages the model's
	// working set: the fold opens, and the engine is told nothing.
	openbroken: [{
		file: 'js/daimond.js',
		find: '\t\tif (el.open) _openFolds[k] = 1; else delete _openFolds[k];',
		with: '\t\tif (el.open) { /* broken */ } else { /* broken */ }',
	}],
	// A fold with nothing above it, drawn shut: a whole answer behind a control
	// the reader has to press to find out there was nothing else.
	bareclosed: [{
		file: 'js/daimond.js',
		find: '\t\tif ((seg.open || headless) && !(seg.key in _openFolds)) _openFolds[seg.key] = 1;',
		with: '\t\tif (seg.open && !(seg.key in _openFolds)) _openFolds[seg.key] = 1;',
	}],
	// The fold drawn open for the right reason but not SAYING so, which is how a
	// decision quietly becomes a coincidence nobody can find again.
	barequiet: [{
		file: 'js/daimond.js',
		find: "\t\tif (headless) d.classList.add('md-fold-bare');",
		with: "\t\tif (false) d.classList.add('md-fold-bare');",
	}],
	// The hold-back never released, so a turn that died half way through a
	// `<summary>` shows the reader nothing where its last words should be.
	holdforever: [{
		file: 'js/render.js',
		find: '\t\t\tif (!settled && /<details/i.test(tail)) {',
		with: '\t\t\tif (/<details/i.test(tail)) {',
	}],
	// The stored set never read back, so every reload shuts every fold.
	noreload: [{
		file: 'js/daimond.js',
		find: "\t\t// Before a single fold is drawn: which of them this chat's reader had open.\n"
			+ '\t\tloadTextFolds();\n',
		with: '',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// `src` with `spec` applied, or a hard stop.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const TYPE = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

/// The damaged files, ONE BODY PER FILE: Playwright hands a request to the LAST
/// route registered for its URL, so two routes on one file ship only the second.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		const type = TYPE[path.extname(file)] || 'text/plain';
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: type, body }));
	}
}

// ── The fixture, read from disk ──────────────────────────────────────
//
// Not transcribed. A lane that believes a case is wrong reports it; a lane that
// copies the cases into its own source has stopped testing the pin.
const FIXTURE = path.join(HERE, 'fixtures', 'fold_keys.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// ── What the model is told to stream ─────────────────────────────────
//
// The mock splits its reply on single spaces and sends one word per frame, so
// these are written with single spaces and their newlines ride inside the words.
// Every label is different, because two folds with the same ordinal and the same
// label share a key ON PURPOSE (CONTRACT_FOLD.md §2) and a check that wants to
// name one fold needs to have named one fold.
const BODY = 'The cache was cold because the deploy dropped the warmed image and the '
	+ 'replacement came up empty. Nothing was lost. The first request after a deploy '
	+ 'now pays for the fill, every request after it does not, and the window in which '
	+ 'that is true is about ninety seconds on the current instance size. There is a '
	+ 'longer story about why the warmer runs after the cutover rather than before it, '
	+ 'which is the part worth changing.';

// `open`, so the body is on screen while it fills and the stream can be MEASURED.
// A closed fold's contents are not rendered, and "did the text grow" asked of an
// unrendered subtree is a question with no answer.
const STREAMED = 'Short answer: the cache was cold.\n\n'
	+ '<details open>\n<summary>The long version</summary>\n\n' + BODY + '\n\n</details>\n';
const SHUT     = 'It is fixed now.\n\n'
	+ '<details>\n<summary>What was actually wrong</summary>\n\n' + BODY + '\n\n</details>\n';
const BARE     = '<details>\n<summary>Everything I have</summary>\n\n' + BODY + '\n\n</details>\n';
const FENCED   = 'Write it like this:\n\n```html\n<details>\n<summary>A label</summary>\n\n'
	+ 'The detail.\n\n</details>\n```\n';
// Never touched by this run, so the reload check has something that must come
// back SHUT. Without one, "the reader's choice survived" would also be true of a
// build that simply opened everything.
const ALONE    = 'And another thing.\n\n'
	+ '<details>\n<summary>Left alone</summary>\n\n' + BODY + '\n\n</details>\n';
// The whole of an attack, in the LABEL rather than in the body, because the label
// is the part this change hands to `innerHTML` on its own. The image is the one
// that really fires: an `onerror` that has not fired yet is not an `onerror` that
// was stripped, and the two look identical at zero milliseconds.
const NASTY    = 'Careful now.\n\n<details>\n<summary>Mind '
	+ '<img src="/no-such-image-7731.png" onerror="window.__pwned=1"> '
	+ '<script>window.__pwned=1;<\/script> '
	+ '<a href="javascript:window.__pwned=1">the</a> gap</summary>\n\n'
	+ 'The body.\n\n</details>\n';

// A fold inside a fold. The renderer nests correctly for free, because the
// browser's parser does; what has to be proved is that the KEY does not, since a
// nested fold takes no ordinal (CONTRACT_FOLD.md §8) and an extra one here would
// rename every fold after it in the engine's eyes.
const NESTED   = 'Here it is.\n\n<details>\n<summary>Outer label</summary>\n\n'
	+ 'The part above.\n\n<details>\n<summary>Inner label</summary>\n\n'
	+ 'The deepest part.\n\n</details>\n\nThe part below.\n\n</details>\n';

const s = await open({ name: 'twodepth', profile: PROFILE, route: serveBreaks });
const page = s.page;

/// The bubble a turn just drew, by the label of the fold in it.
const bubbleFor = (label) => page.evaluateHandle((lbl) => {
	const all = [...document.querySelectorAll('#chat-output .chat-msg-assistant')];
	return all.reverse().find(b => {
		const sm = b.querySelector('details > summary');
		return sm && sm.textContent.trim() === lbl;
	}) || null;
}, label);

try {
	await page.waitForFunction(() => window.DaimondRender && window.DaimondRender.foldScan,
		null, { timeout: 20000 });

	// ── 0c. EVERY turn pushes the open set, not just the one that was checked ──
	//
	// Static, and deliberately so: the browser checks below drive an ordinary
	// chat, and an ordinary chat was never the path that was broken. `doSteer`
	// -- the Diamond's own thread, which is the surface Daimond is developed
	// from -- set `_generating` and streamed without ever calling
	// `pushOpenFolds`, so a Diamond's app carried an EMPTY open set for its
	// whole life and every fold body was stripped from every payload. The
	// feature worked, was tested, and was inert where it mattered most.
	//
	// So the property is not "a turn pushes the open set" but "there is no turn
	// that does not". Each `_generating = true` is a turn beginning; the push
	// must be within reach of it in the same function. A third turn path added
	// without the call reddens here rather than in a month of use.
	{
		const js = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
		const lines = js.split('\n');
		const starts = [], missing = [];
		lines.forEach((ln, i) => { if (/_generating\s*=\s*true/.test(ln)) starts.push(i); });
		for (const i of starts) {
			// The push sits beside the app the turn will run on, which is within a
			// few lines of the flag in both existing paths. Sixty lines is wide
			// enough for a commented one and far narrower than a function.
			const near = lines.slice(Math.max(0, i - 60), i + 60).join('\n');
			if (!/pushOpenFolds\s*\(/.test(near)) missing.push(`daimond.js:${i + 1}`);
		}
		check(`0c every turn pushes what is open on screen (${starts.length} turn path(s))`,
			starts.length >= 2 && missing.length === 0,
			missing.length ? `no pushOpenFolds near ${missing.join(', ')}`
				: `${starts.length} turn path(s), all push`);
	}

	// ── 1. The key, against the fixture ───────────────────────────────
	//
	// Body length is counted in CODE POINTS on both sides, because the contract
	// says `chars().count()` and a JS `.length` counts UTF-16 units — the two part
	// company on the first emoji a model puts in a fold.
	const keyed = await page.evaluate((cases) => cases.map((c) => {
		const folds = window.DaimondRender.foldScan(c.input);
		return { keys: folds.map(f => f.key), chars: folds.map(f => [...f.body].length) };
	}), fixture.cases);
	check('0 the fixture on disk was actually read',
		Array.isArray(fixture.cases) && fixture.cases.length > 0
			&& keyed.length === fixture.cases.length,
		`${fixture.cases.length} case(s) from ${path.relative(path.join(HERE, '..'), FIXTURE)}`);
	const wrong = [];
	fixture.cases.forEach((c, i) => {
		const okK = JSON.stringify(keyed[i].keys)  === JSON.stringify(c.keys);
		const okC = JSON.stringify(keyed[i].chars) === JSON.stringify(c.body_chars);
		if (!okK || !okC) {
			wrong.push(`${c.name}: keys ${JSON.stringify(keyed[i].keys)} want ${JSON.stringify(c.keys)}`
				+ `, chars ${JSON.stringify(keyed[i].chars)} want ${JSON.stringify(c.body_chars)}`);
		}
	});
	check(`1a every fixture case keys as the contract says (${fixture.cases.length})`,
		wrong.length === 0, wrong.slice(0, 2).join(' | '));

	// WHY THE RENDERER HOLDS A HALF-WRITTEN FOLD BACK, measured rather than
	// assumed. `marked` hands raw HTML through, and the parser auto-closes an
	// unfinished element at the end of the fragment -- so a `<details>` whose
	// `</summary>` has not arrived is already a real, closed disclosure with a
	// growing label. Drawn, it appears shut and then snaps open when the control
	// proper replaces it. Recorded here because it is the reason for `foldPending`
	// and nothing else in the tree says it.
	const halfway = await page.evaluate(() => {
		const d = document.createElement('div');
		d.innerHTML = window.DaimondRender.md('<details>\n<summary>Half typed');
		const f = d.querySelector('details');
		return f ? { drawn: true, label: (f.querySelector('summary') || {}).textContent } : { drawn: false };
	});
	check('1b an unfinished `<details>` really is auto-closed into a live control',
		halfway.drawn === true && halfway.label === 'Half typed', JSON.stringify(halfway));

	// THE HOLD-BACK ITSELF, asked deterministically. Check 3a below puts the same
	// question to a real stream, but whether a frame lands inside the few
	// milliseconds between `<details>` and `</summary>` is a race, and a prover
	// that only sometimes reddens is not a prover.
	const pending = await page.evaluate(() => {
		const half = 'Above the fold.\n\n<details open>\n<summary>Half typ';
		const seg = (a) => a.map(x => x.kind + ':' + (x.kind === 'fold' ? x.key : x.text));
		return {
			live: seg(window.DaimondRender.foldSegments(half, false)),
			done: seg(window.DaimondRender.foldSegments(half, true)),
		};
	});
	check('1c a half-written fold draws nothing at all until it IS a fold',
		pending.live.length === 1 && pending.live[0] === 'text:Above the fold.\n\n',
		JSON.stringify(pending.live));
	check('1d but a turn that died half way through one still shows what arrived',
		pending.done.length === 1 && /<details open>/.test(pending.done[0]),
		JSON.stringify(pending.done));

	// ── The instrument ────────────────────────────────────────────────
	//
	// Installed before the turn, sampling once per frame. A MutationObserver
	// counts insertions rather than reading a count at the end, because "one fold
	// on screen" is exactly what a fold rebuilt sixty times still looks like.
	//
	// SCOPED TO ONE BUBBLE, by the count of them standing before the turn began.
	// "The last assistant message" is not the same question: the app may draw
	// another one while this turn is still going, and a count of folds taken over
	// the whole thread would then answer for two messages at once.
	await page.evaluate(() => {
		const out = document.getElementById('chat-output');
		const asst = () => out.querySelectorAll('.chat-msg-assistant');
		const st = { made: 0, uid: 0, samples: [], sent: [], base: asst().length };
		window.__twodepth = st;
		const mine = () => asst()[st.base] || null;
		const stamp = (el) => {
			const b = mine();
			if (!b || !b.contains(el) || el.dataset.probeUid) return;
			el.dataset.probeUid = String(++st.uid);
			st.made++;
		};
		const obs = new MutationObserver((recs) => {
			for (const r of recs) {
				for (const n of r.addedNodes) {
					if (n.nodeType !== 1) continue;
					if (n.matches && n.matches('details.md-fold')) stamp(n);
					if (n.querySelectorAll) n.querySelectorAll('details.md-fold').forEach(stamp);
				}
			}
		});
		obs.observe(out, { childList: true, subtree: true });
		const tick = () => {
			const b = mine();
			if (b) {
				const fold = b.querySelector('details.md-fold');
				const seg  = b.querySelector('.md-seg');
				const body = b.querySelector('.md-fold-body');
				st.samples.push({
					all:  b.innerText.length,
					seg:  seg ? seg.innerText.length : -1,
					body: body ? body.innerText.length : -1,
					fold: !!fold,
					bubbles: asst().length,
				});
			}
			st.raf = requestAnimationFrame(tick);
		};
		tick();
		st.stop = () => { obs.disconnect(); cancelAnimationFrame(st.raf); };
	});

	// The engine's own door, wrapped and still called. What is recorded is what
	// the wasm boundary was handed, not what this file hoped it would be.
	const shimmed = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const P = m.DaimondApp && m.DaimondApp.prototype;
		if (!P || typeof P.set_open_folds !== 'function') return false;
		const orig = P.set_open_folds;
		P.set_open_folds = function (json) {
			window.__twodepth.sent.push(json);
			return orig.call(this, json);
		};
		return true;
	});
	check('0b the engine offers `set_open_folds` to wrap', shimmed === true);

	// ── 2 & 3. A real turn, streamed ──────────────────────────────────
	await chat(s, '@text ' + STREAMED);
	const run = await page.evaluate(() => {
		const st = window.__twodepth;
		st.stop();
		return { made: st.made, samples: st.samples, sent: st.sent.slice() };
	});
	const seen = run.samples;
	const last = seen[seen.length - 1] || { all: 0, seg: -1, body: -1, fold: false };
	const distinct = (k) => new Set(seen.map(x => x[k]).filter(v => v >= 0)).size;
	const iFold = seen.findIndex(x => x.fold);

	check('2a the answer arrived a piece at a time, not all at the end',
		distinct('all') >= 4, `${distinct('all')} distinct length(s) over ${seen.length} frame(s)`);
	check('2b the text ABOVE the fold was complete on screen while the fold was still filling',
		iFold >= 0 && seen[iFold].seg > 0 && seen[iFold].body < last.body
			&& seen[iFold].seg === last.seg,
		iFold < 0 ? 'no fold was ever drawn'
			: `at the fold's first frame: above=${seen[iFold].seg}/${last.seg}, `
				+ `inside=${seen[iFold].body}/${last.body}`);
	check('2c the fold\'s own body grew across frames',
		distinct('body') >= 3 && seen.filter(x => x.body >= 0)
			.every((x, i, a) => i === 0 || x.body >= a[i - 1].body),
		`${distinct('body')} distinct length(s), final ${last.body}`);
	check('3a the fold control was inserted ONCE for the whole stream',
		run.made === 1, `${run.made} insertion(s) over ${seen.length} frame(s)`);
	const uid = await page.evaluate(() => {
		const b = document.querySelectorAll('#chat-output .chat-msg-assistant')[window.__twodepth.base];
		const d = b && b.querySelector('details.md-fold');
		return d ? d.dataset.probeUid : null;
	});
	check('3b and the fold still on screen is that same element',
		uid === '1', String(uid) + `; ${new Set(seen.map(x => x.bubbles)).size} bubble count(s) seen`);

	// ── 4. A closed fold's body ───────────────────────────────────────
	await chat(s, '@text ' + SHUT);
	/// Shown, in two geometric facts at once. See the header: a closed fold's
	/// contents keep their last layout, so a rect with area proves nothing alone.
	const measure = (label) => page.evaluate((lbl) => {
		const all = [...document.querySelectorAll('#chat-output details.md-fold')];
		const d = all.reverse().find(x => {
			const sm = x.querySelector('summary');
			return sm && sm.textContent.trim() === lbl;
		});
		if (!d) return null;
		d.scrollIntoView({ block: 'center' });
		const el = d.querySelector('.md-fold-body > *');
		if (!el) return { open: d.open, rect: false, hit: false, why: 'no body' };
		const a = d.getBoundingClientRect(), c = el.getBoundingClientRect();
		const at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
		return {
			open: d.open,
			// Real area, and inside the fold that is meant to be containing it.
			rect: c.height > 0 && c.top >= a.top - 0.5 && c.bottom <= a.bottom + 0.5,
			hit:  !!at && d.contains(at),
			h:    Math.round(c.height),
		};
	}, label);
	const shut = await measure('What was actually wrong');
	check('4a a fold the model did not open starts closed',
		!!shut && shut.open === false, shut ? JSON.stringify(shut) : 'no fold');
	check('4b and its body is not on screen — containment AND a hit test',
		!!shut && !shut.rect && !shut.hit, shut ? JSON.stringify(shut) : null);
	// `el.click()`, not page.click with force: a forced click does nothing at all
	// on this app headless, and has flaked several older verifiers.
	await page.evaluate((lbl) => {
		const all = [...document.querySelectorAll('#chat-output details.md-fold')];
		const d = all.reverse().find(x => {
			const sm = x.querySelector('summary');
			return sm && sm.textContent.trim() === lbl;
		});
		if (d) d.querySelector('summary').click();
	}, 'What was actually wrong');
	await page.waitForTimeout(250);
	const shown = await measure('What was actually wrong');
	check('4c pressing the label puts it on screen — the same two facts, the other way',
		!!shown && shown.open === true && shown.rect && shown.hit,
		shown ? JSON.stringify(shown) : null);

	// ── 5. The open set, at the wasm boundary ─────────────────────────
	const sent = await page.evaluate(() => window.__twodepth.sent.slice());
	const lastSent = sent.length ? sent[sent.length - 1] : '';
	let parsed = null;
	try { parsed = JSON.parse(lastSent); } catch (e) { /* the check below says so */ }
	check('5a opening a fold hands the engine a set with that fold\'s key in it',
		Array.isArray(parsed) && parsed.indexOf('0:What was actually wrong') >= 0,
		lastSent ? lastSent.slice(0, 160) : 'nothing was ever handed to the engine');

	// ── 6. A fold with nothing above it ───────────────────────────────
	await chat(s, '@text ' + BARE);
	const bare = await measure('Everything I have');
	const bareMark = await page.evaluate(() => {
		const all = [...document.querySelectorAll('#chat-output details.md-fold')];
		const d = all.reverse().find(x => {
			const sm = x.querySelector('summary');
			return sm && sm.textContent.trim() === 'Everything I have';
		});
		return d ? { marked: d.classList.contains('md-fold-bare'),
			above: (d.previousElementSibling || {}).textContent || '' } : null;
	});
	check('6a a fold with nothing above it is drawn OPEN, not shut',
		!!bare && bare.open === true && bare.rect && bare.hit,
		bare ? JSON.stringify(bare) : 'no fold');
	check('6b and the renderer says so, rather than it being a coincidence',
		!!bareMark && bareMark.marked === true && !String(bareMark.above).trim(),
		bareMark ? JSON.stringify(bareMark) : null);

	// ── 7. A fenced fold is a model showing markup ────────────────────
	await chat(s, '@text ' + FENCED);
	const fenced = await page.evaluate(() => {
		const all = [...document.querySelectorAll('#chat-output .chat-msg-assistant')];
		const b = all.reverse().find(x => /Write it like this/.test(x.innerText || ''));
		if (!b) return null;
		return {
			folds:   b.querySelectorAll('details').length,
			literal: /<details>/.test(b.innerText || ''),
			code:    b.querySelectorAll('pre code').length,
		};
	});
	check('7a a `<details>` inside a fence draws no control',
		!!fenced && fenced.folds === 0, fenced ? JSON.stringify(fenced) : 'no bubble');
	check('7b and the reader still sees the markup that was being shown',
		!!fenced && fenced.literal && fenced.code > 0,
		fenced ? JSON.stringify(fenced) : null);

	// ── 8. Nothing executable rides in on the label ───────────────────
	await chat(s, '@text ' + NASTY);
	// The image has to be given time to fail before "nothing ran" means anything.
	await page.waitForTimeout(900);
	const nasty = await page.evaluate(() => {
		const all = [...document.querySelectorAll('#chat-output details.md-fold')];
		const d = all.reverse().find(x => /Mind/.test((x.querySelector('summary') || {}).textContent || ''));
		if (!d) return null;
		const sum = d.querySelector('summary');
		return {
			pwned:   !!window.__pwned,
			scripts: sum.querySelectorAll('script').length,
			onerror: sum.querySelectorAll('[onerror]').length,
			hrefs:   [...sum.querySelectorAll('a')].map(a => a.getAttribute('href') || ''),
			label:   String(sum.textContent || '').replace(/\s+/g, ' ').trim(),
			key:     d.dataset.foldKey || '',
		};
	});
	check('8a the label carries no script, no handler and no javascript: url',
		!!nasty && nasty.pwned === false && nasty.scripts === 0 && nasty.onerror === 0
			&& nasty.hrefs.every(h => !/^javascript:/i.test(h)),
		nasty ? JSON.stringify(nasty) : 'no fold');
	check('8b but the words the model wrote are still its label',
		!!nasty && nasty.label === 'Mind the gap',
		nasty ? JSON.stringify(nasty.label) : null);
	// THE KEY AND THE LABEL LEGITIMATELY DIFFER HERE, and it is worth pinning
	// rather than filing off. §2 says the key is the summary's TEXT CONTENT with
	// its tags removed, and a `<script>`'s body is text content -- a DOM reading
	// gives the same answer as the scan does. The renderer drops the element
	// whole, as it must. So the fold is NAMED with words nobody sees, and both
	// halves of the app agree on that name, which is the only thing the key is
	// for.
	check('8c and the key keeps what the sanitiser threw away, because it is not the DOM',
		!!nasty && nasty.key === '0:Mind window.__pwned=1; the gap',
		nasty ? JSON.stringify(nasty.key) : null);

	// ── 9. A fold inside a fold ───────────────────────────────────────
	await chat(s, '@text ' + NESTED);
	const nested = await page.evaluate(() => {
		const all = [...document.querySelectorAll('#chat-output details.md-fold')];
		const outer = all.reverse().find(d =>
			(d.querySelector('summary') || {}).textContent.trim() === 'Outer label');
		if (!outer) return null;
		// Opened here, because a nested fold is only worth asking about once the
		// fold holding it is on screen.
		outer.querySelector('summary').click();
		const inner = outer.querySelector('details.md-fold');
		return {
			outerKey: outer.dataset.foldKey || '',
			innerKey: inner ? (inner.dataset.foldKey || '') : '(no inner fold)',
			contained: !!inner && outer.contains(inner),
			outerOpen: outer.open, innerOpen: inner ? inner.open : null,
		};
	});
	check('9a the outer fold takes ordinal 0 and the inner takes no key at all',
		!!nested && nested.outerKey === '0:Outer label' && nested.innerKey === '',
		nested ? JSON.stringify(nested) : 'no fold');
	check('9b and the inner one really is inside it, still shut when the outer opens',
		!!nested && nested.contained && nested.outerOpen === true && nested.innerOpen === false,
		nested ? JSON.stringify(nested) : null);

	await chat(s, '@text ' + ALONE);

	// ── 10. The reader's choice survives a reload ─────────────────────
	//
	// The fold opened at 4c, after a real reload of the page and a real unlock —
	// not a redraw. The key holds no message identity, so nothing about the
	// message had to be stored for this to work.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'twodepth');
	await page.waitForSelector('#chat-output details.md-fold', { timeout: 20000 })
		.catch(() => { /* the check below says what was there */ });
	await page.waitForTimeout(600);
	const after = await page.evaluate(() => {
		const all = [...document.querySelectorAll('#chat-output details.md-fold')];
		return all.map(d => ({
			label: (d.querySelector('summary') || {}).textContent.trim(),
			open:  d.open,
		}));
	});
	const restored = after.find(x => x.label === 'What was actually wrong');
	const untouched = after.find(x => x.label === 'Left alone');
	check('10a the fold the reader opened comes back open',
		!!restored && restored.open === true, JSON.stringify(after));
	check('10b and one the reader never touched comes back shut',
		!!untouched && untouched.open === false, JSON.stringify(after));

	// ── 11. The label is legible ──────────────────────────────────────
	//
	// A fold nobody finds is a fold nobody opens, and every check above this one
	// passes on exactly that. The owner, 2026-08-23, located a real fold on his own
	// screen only after being told it was there: the summary was `--text-muted` at
	// `--fs-sm`, which between a reply above and a reply below reads as a caption
	// for something rather than as a thing to read.
	//
	// MEASURED AGAINST THE ANSWER IT BELONGS TO, never against a value written
	// here. A check pinned to `#ECE6DC` would go red on a theme and green on a
	// regression under the pink one; a check pinned to the answer's own computed
	// style moves with every theme and still catches a summary set apart as minor.
	const legible = await page.evaluate(() => {
		const d = [...document.querySelectorAll('#chat-output details.md-fold')]
			.filter(x => !x.classList.contains('chat-msg-thinking')).pop();
		if (!d) return { why: 'no fold on screen' };
		const sum = d.querySelector('summary');
		const bubble = d.closest('.chat-msg-content') || d.parentElement;
		// The answer above the fold, in the same bubble. `!d.contains` because the
		// fold's own body is full of paragraphs and one of those proves nothing.
		const above = [...bubble.querySelectorAll('p')].find(x => !d.contains(x));
		if (!sum || !above) return { why: 'no summary, or nothing above the fold' };
		const a = getComputedStyle(sum), b = getComputedStyle(above);
		return { size: a.fontSize, answerSize: b.fontSize,
			ink: a.color, answerInk: b.color };
	});
	check('11a the summary is set at the size of the answer it belongs to',
		!!legible && legible.size === legible.answerSize, JSON.stringify(legible));
	check('11b and in the same ink, not the grey of a caption',
		!!legible && legible.ink === legible.answerInk, JSON.stringify(legible));

	// The attack's own 404 is expected -- the image is MEANT to fail, which is what
	// makes 8a mean anything -- so it is not counted as the app throwing.
	const errs = errors(s).filter(e => !/Failed to load resource/.test(e))
		.filter(e => !/no-such-image-7731/.test(e));
	check('nothing threw while it was on screen', errs.length === 0, errs.slice(0, 3).join(' | '));

	// The picture, with the ink centred: the guide put away so the thread has the
	// width, and the fold that streamed opened in the middle of it. A fold that is
	// technically right and visually wrong is not done, and the only way to know
	// which it is, is to look.
	await page.evaluate(() => {
		// The guide rides in the Web panel; its own closer sends the panel back to
		// the tag row, which is what a reader would do before settling in to read.
		const x = document.querySelector('#panel-web [data-close="web"]');
		if (x) x.click();
	});
	await page.waitForTimeout(500);
	await page.evaluate(() => {
		const d = [...document.querySelectorAll('#chat-output details.md-fold')]
			.find(x => (x.querySelector('summary') || {}).textContent.trim() === 'The long version');
		if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); }
	});
	await page.waitForTimeout(400);
	await shot(s, 'twodepth' + (BREAK ? '-' + BREAK : ''));
} catch (e) {
	check('the run got to the end of itself', false,
		String(e && e.message ? e.message : e).split('\n')[0]);
	try { await shot(s, 'twodepth-threw' + (BREAK ? '-' + BREAK : '')); } catch (e2) { /* none */ }
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0
	? `\ntwodepth: all ${ok.length} checks passed`
	: `\ntwodepth: ${bad.length} of ${ok.length + bad.length} checks FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
