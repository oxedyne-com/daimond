// verify_wire.mjs — the Wire band says what actually goes to the model, on BOTH
// threads.
//
// The Wire is a chip in the chat header that opens the invisible part of every
// request: the composed system message split by whose each paragraph is, and the
// tool schemas beside it.  Its whole selling point, written into its own commit,
// is that it CANNOT DRIFT from the request, because one function composes what
// goes out and what is shown.
//
// That was true of a chat and false of a Diamond.  A daimon's turn never goes
// through `run_turn`: `sendUserMessage` hands a record carrying a `diamondId` to
// `doSteer`, which steers the DIAMOND'S OWN app through `steer_crystal`, and
// `steer_inner` builds its own tool vector — seventeen tools, none of the nine
// web tools and no `file_show` for a worker.  `renderWire` read
// `ensureApp(current)`, an ordinary CHAT app whose registry is `Tool::browser()`:
// twenty-eight tools.  So a Diamond's owner was shown a toolbelt his daimon has
// never held, while he sat asking why it never used one of them.
//
// `say` used to be the tool this file told the two belts apart by. It is gone —
// an answer is written at two depths in the model's own prose now — so the
// distinguishing tool is `file_show`, and `say` is asserted ABSENT from both.
//
// THE ORACLE IS THE MOCK PROVIDER, not the app's opinion of itself.  Every check
// below compares the band on screen with the request the model actually received
// — `dev/mockllm.mjs` logs the whole payload, tool names and all — so a band and
// an engine that agree with each other and not with the wire cannot both pass.
//
// Four properties:
//
//   1. On an ORDINARY CHAT the band's tool list is the chat's real registry, and
//      its system message is the string the provider was sent.
//   2. On a DAIMON THREAD the band's tool list is the DAIMON'S real registry —
//      and carries no web tool, because the daimon has not got them.  This is the
//      check the shipped feature failed.  Neither belt carries `say` at all.
//   3. The token figures the band reports for a daimon are the daimon's: the
//      schema count is the daimon's tool count, the total is not the chat's, and
//      it is the arithmetic the app itself does over the daimon's own bands.
//   4. The per-turn paragraph — this Diamond's folder, its attachments and its
//      crystal — is drawn under its own heading and has a bounding rectangle.
//      Measured as an area, never as a computed `display`: `display:none` does
//      not cascade, so a parent that is gone leaves a child still "block".
//
//   node dev/verify_wire.mjs
//   node dev/verify_wire.mjs --break chatapp    # the daimon thread reads the chat app again
//   node dev/verify_wire.mjs --break dropshow   # the band drops one tool from its list
//   node dev/verify_wire.mjs --break splice     # a band spliced out of two distant pieces
//   node dev/verify_wire.mjs --break pretty     # the schemas counted as the band prints them
//   node dev/verify_wire.mjs --break chars      # the schemas counted in characters, not bytes
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { open, chat, steerDiamond, scratch, shot, mockLog, clearMockLog, contentText } from './harness.mjs';
import { whyStaleWasm, refuse } from './staleguard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT  = path.join(os.homedir(), '.cache/daimond/wire-shots');
fs.mkdirSync(OUT, { recursive: true });

// The composition under test is in the wasm — `wire_json`, and the
// `compose_daimon` both the turn and the band read — so a stale bundle would
// measure the defect this run exists to disprove.
refuse(whyStaleWasm(path.join(ROOT, 'www/pkg/oxedyne_daimond_bg.wasm'), path.join(ROOT, 'src'), {
	subject: 'The Wire\'s composition',
	holds:   '`wire_json` and `compose_daimon`, which the band and the turn share',
}));

const BI  = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

const HOUSE = 'Answer in the fewest words that are still true. RANUNCULUS.';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

// ── The breaks ───────────────────────────────────────────────────────────
//
// Served, not applied to the tree: the file on disk is never touched, so a run
// that dies half way leaves nothing behind to confuse the next one.
const WWW = path.join(ROOT, 'www');
const BREAKS = {
	// The defect exactly as it shipped: the band composed from an ordinary chat
	// app, with no Diamond named, on a thread that steers a daimon.
	chatapp: [
		{ file: 'js/daimond.js',
		  find: "\t\ttry { app = did ? diamondApp(did) : ensureApp(current); } catch (e) { return; }",
		  with: "\t\ttry { app = ensureApp(current); } catch (e) { return; }" },
		{ file: 'js/daimond.js',
		  find: "\t\t\tw = JSON.parse(await app.wire_system(did,",
		  with: "\t\t\tw = JSON.parse(await app.wire_system('',", },
	],
	// The user's own house rules left inside the safety band, which is what a
	// first cut of this fix did: harmless on a chat, where the two are adjacent,
	// and on a Diamond a band made of two pieces with a paragraph missing from
	// between them -- text that never stood together in the message.
	splice: [
		{ file: 'js/daimond.js',
		  find: "\t\tvar std = role.indexOf('## Standing instructions from the user');\n"
			+ "\t\tif (std > 0) { standing = role.slice(std); role = role.slice(0, std); }",
		  with: "\t\tvar std = -1;" },
	],
	// The schemas counted in the form the band DRAWS rather than the form the
	// request carries. This is the defect as it shipped: the figure people quote
	// from this band -- "9k of the 11k is tool schemas" -- overstated by an eighth,
	// entirely in whitespace the viewer added itself.
	pretty: [
		{ file: 'js/daimond.js',
		  find: "\t\tvar schemaTok = Math.round((w.schemas_len || 0) / 4);",
		  with: "\t\tvar schemaTok = wireTok(schemas);" },
	],
	// The schemas counted in CHARACTERS rather than in the bytes the body carries. Not the
	// same mistake as `pretty`: this copy is the compact array, the one the request really
	// holds, measured with `String.length` -- UTF-16 code units, so 41,964 where the body
	// carries 41,998. Thirty-four bytes, and on 2026-08-25 they straddled the 10,500-token
	// rounding step, so the band drew "11k" and a run measuring the same array in characters
	// drew "10k" and reported the band as having drifted from the request. It had not.
	chars: [
		{ file: 'js/daimond.js',
		  find: "\t\tvar schemaTok = Math.round((w.schemas_len || 0) / 4);",
		  with: "\t\tvar schemaTok = Math.round(JSON.stringify(w.schemas || []).length / 4);" },
	],
	// One tool quietly missing from what the band draws, and present in the
	// request. Here to prove check 1 has teeth: a check that only ever reads a
	// list that is right proves nothing about a list that is wrong.
	dropshow: [
		{ file: 'js/daimond.js',
		  find: "\t\tvar schemas = JSON.stringify(w.schemas || [], null, 1);",
		  with: "\t\tvar schemas = JSON.stringify((w.schemas || []).filter(function (d) "
			+ "{ return ((d || {}).function || {}).name !== 'file_show'; }), null, 1);" },
	],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Every edit a break makes to ONE file, applied to one copy of it.
///
/// Grouped by file because `page.route` keeps only the LAST handler registered
/// for a pattern: two specs against `js/daimond.js` registered separately would
/// serve the second edit alone, and the run would report a check as proved that
/// had been asked of working code.
function damaged(file, specs) {
	let src = fs.readFileSync(path.join(WWW, file), 'utf8');
	for (const spec of specs) {
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		src = src.replace(spec.find, spec.with);
	}
	return src;
}

/// Keep the RAW body of every request to the provider.
///
/// The mock logs the payload it parsed, which is enough for names and messages
/// and not for a SIZE: a re-serialised copy is a second opinion about the very
/// bytes in question. The string handed to `fetch` is the request, so it is kept
/// as a string and measured as one.
async function watchWire(page) {
	await page.addInitScript(() => {
		// The engine builds a `Request` and hands THAT to `fetch`, so a hook on `fetch`
		// alone sees a body that is already a stream. The constructor is where the
		// string still exists.
		const keep = (url, init) => {
			try {
				if (/chat\/completions/.test(String(url || '')) && init && typeof init.body === 'string') {
					window.__wireRaw = init.body;
				}
			} catch (e) { /* never break a turn to watch one */ }
		};
		window.Request = new Proxy(window.Request, {
			construct(target, args) {
				const u = args[0];
				keep(typeof u === 'string' ? u : ((u && u.url) || ''), args[1]);
				return new target(...args);
			},
		});
		const orig = window.fetch;
		window.fetch = function (u, init) {
			keep(typeof u === 'string' ? u : ((u && u.url) || ''), init);
			return orig.apply(this, arguments);
		};
	});
}

async function serveBreak(page) {
	await watchWire(page);
	if (!BREAK) return;
	const byFile = new Map();
	for (const spec of BREAKS[BREAK]) {
		if (!byFile.has(spec.file)) byFile.set(spec.file, []);
		byFile.get(spec.file).push(spec);
	}
	for (const [file, specs] of byFile) {
		const body = damaged(file, specs);
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body }));
	}
}

// ── Reading the two sides ────────────────────────────────────────────────

/// The band on screen, in pieces.
///
/// The bodies are read as text whether the band is folded open or not — a
/// `<pre>` with `display:none` still carries its `textContent` — but every
/// question about whether something is DRAWN is answered with an area.
const wireDom = (p) => p.evaluate(() => {
	const box = document.getElementById('wire-head');
	if (!box) return null;
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return Math.round(r.width * r.height);
	};
	const bands = [...box.querySelectorAll('.wire-band')].map((row) => {
		const head = row.querySelector('.wire-band-head');
		const body = row.querySelector('.wire-band-body');
		return {
			name: head.querySelector('.wire-band-name').textContent.replace(/^[▸▾]\s*/, ''),
			why:  head.querySelector('.wire-band-why').textContent,
			tok:  head.querySelector('.wire-band-tok').textContent,
			text: body ? body.textContent : '',
			area: rect(head),
		};
	});
	return { area: rect(box), title: (box.querySelector('.wire-title') || {}).textContent || '', bands };
});

// The schema band's heading carries its count -- `Tool schemas (17)` -- so a name
// is matched whole or up to its bracket.
const band = (w, name) => (w
	? w.bands.find(b => b.name === name || b.name.startsWith(name + ' ('))
	: null);

/// The tool names the band draws, read out of the schema band it shows.
///
/// From the SCHEMAS and not from the tool sentence, deliberately: the schemas are
/// the bytes on the wire, and the sentence is prose about them.
function bandTools(w) {
	const b = band(w, 'Tool schemas');
	if (!b) return null;
	try {
		return JSON.parse(b.text).map(d => (d.function || {}).name).filter(Boolean).sort();
	} catch (e) { return null; }
}

/// The last request the provider received, and the system message in it.
const lastReq = () => { const r = mockLog(); return r.length ? r[r.length - 1] : null; };
const sysOf = (row) => {
	const m = (row.messages || []).find(x => x.role === 'system');
	return m ? contentText(m.content) : '';
};

/// The app's own arithmetic, so a figure can be checked rather than admired.
///
/// BYTES, because that is what the band claims to be reporting and what the engine budgets
/// with. `String.length` is UTF-16 code units: for the browser toolbelt it says 41,964 where
/// the body carries 41,998, and on 2026-08-25 those two straddled the 10,500-token rounding
/// step and drew "10k" and "11k". This run then reported a band that had drifted from the
/// request, and it had not -- the two figures were the same array in two encodings. Measuring
/// characters and calling them bytes is the defect this file exists to catch, made by the
/// file itself.
const ENC = new TextEncoder();
const bytes = (s) => ENC.encode(String(s || '')).length;
const tok = (s) => Math.round(bytes(s) / 4);
const fmtTok = (n) => (n % 1024 === 0) ? (n / 1024) + 'k'
	: (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
		: (n >= 1000 ? Math.round(n / 1000) + 'k' : '' + n));

/// Turn the band on and wait for it to be drawn.
async function showWire(p) {
	const on = await p.evaluate(() => document.getElementById('wire-btn').getAttribute('aria-pressed'));
	if (on !== 'true') await p.click('#wire-btn', { force: true });
	await p.waitForTimeout(900);
}

/// Redraw the band for whatever thread is on screen now.
///
/// Off and on again rather than trusting a redraw: the band is rebuilt on every
/// thread change, and this run wants the one for the thread it is looking at,
/// not whichever render happened to finish last.
async function redrawWire(p) {
	await p.evaluate(() => {
		const b = document.getElementById('wire-btn');
		if (b.getAttribute('aria-pressed') === 'true') b.click();
	});
	await p.waitForTimeout(300);
	await p.click('#wire-btn', { force: true });
	await p.waitForTimeout(1200);
}

async function makeDiamond(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1400);
}

// `route` and not a reload afterwards: the damaged file has to be in place before
// the page is navigated, or the module has already been imported by the time the
// route exists and the break is served to nobody.
const s = await open({ name: 'wire', profile: scratch('pw', 'wire-' + process.pid), route: serveBreak });
const { page: p } = s;
try {
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);

	// The user's own house rules, in force before either turn.
	//
	// NOT decoration. They are appended after everything the app composes, so on a
	// Diamond they sit on the FAR SIDE of the paragraph this run is about -- and a
	// band that lifted that paragraph out without accounting for them would show a
	// "Safety clause" made of two pieces that never stood together in the message.
	// Seeded through the store, which is where `Instructions.refresh` reads them.
	await p.evaluate(async (text) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.store_write('DAIMOND.md', text);
		await window.DaimondInstructions.refresh();
	}, HOUSE);
	await p.waitForTimeout(600);

	// ══ 1. An ordinary chat ═══════════════════════════════════════════
	clearMockLog();
	await chat(s, 'say hello');
	const chatReq = lastReq();
	check(!!chatReq, 'the chat turn reached the provider');
	const chatSent = chatReq ? (chatReq.tools || []).slice().sort() : [];
	check(chatSent.includes('file_show') && chatSent.some(n => n.startsWith('web_')),
		'and a chat really does hold `file_show` and the web tools',
		`${chatSent.length} tools`);
	// The tool that is gone. A chat is the actor `say` was FOR, so if any belt anywhere
	// still carries it, this is the one it would be on.
	check(!chatSent.includes('say'),
		'and no longer holds `say`, which is not a tool any more',
		chatSent.includes('say') ? 'it is still offered one' : '');

	await showWire(p);
	let w = await wireDom(p);
	check(!!w && w.area > 0, 'the band is drawn on a chat', w && `area ${w.area}`);
	const chatShown = bandTools(w);
	check(!!chatShown, 'and its schema band parses as JSON');
	check(JSON.stringify(chatShown) === JSON.stringify(chatSent),
		'THE BAND\'S TOOL LIST IS THE CHAT\'S REAL REGISTRY',
		`band ${chatShown ? chatShown.length : '?'} vs wire ${chatSent.length}`
		+ (JSON.stringify(chatShown) === JSON.stringify(chatSent) ? '' :
			`; only in band: [${(chatShown || []).filter(n => !chatSent.includes(n))}]`
			+ `; only sent: [${chatSent.filter(n => !(chatShown || []).includes(n))}]`));

	const chatSys = chatReq ? sysOf(chatReq) : '';
	const chatBands = [band(w, 'Role prompt'), band(w, 'Safety clause'), band(w, 'Standing instructions'),
		band(w, 'Tool names'), band(w, 'This computer')].filter(Boolean).map(b => b.text);
	check(chatBands.length >= 4, 'the chat band has its parts', chatBands.length + ' of them');
	check(chatBands.every(t => t.length > 0 && chatSys.includes(t.trim())),
		'and every one of them is VERBATIM in the system message the provider was sent');
	check(((band(w, 'Standing instructions') || {}).text || '').includes('RANUNCULUS'),
		'the user\'s own house rules are drawn as theirs');
	const chatTitle = w ? w.title : '';

	// ── The size it reports is the size that goes ────────────────────
	const raw = await p.evaluate(() => window.__wireRaw || '');
	const sentTools = raw ? JSON.parse(raw).tools : null;
	const compact = sentTools ? JSON.stringify(sentTools) : '';
	check(!!compact && raw.includes(compact),
		'the compact serialisation IS the engine\'s own bytes, character for character',
		compact ? `${bytes(compact)} bytes, found in the body` : 'no body captured');
	const pretty = sentTools ? JSON.stringify(sentTools, null, 1) : '';
	check(bytes(pretty) > bytes(compact) * 1.05,
		'and the printed form is materially bigger, so the two figures are distinguishable',
		`${bytes(compact)} sent vs ${bytes(pretty)} printed`);
	const schemaBand = band(w, 'Tool schemas') || {};
	check(schemaBand.tok === fmtTok(tok(compact)),
		'THE SCHEMA FIGURE IS THE BYTES THE REQUEST CARRIES',
		`band says ${schemaBand.tok}, sent is ${fmtTok(tok(compact))}, `
		+ `printed would be ${fmtTok(tok(pretty))}`);
	check(schemaBand.tok !== fmtTok(tok(pretty)) || fmtTok(tok(pretty)) === fmtTok(tok(compact)),
		'and not the size of the indenting the band added itself');
	// The chat's headline as a NUMBER, kept for the daimon's half. The headline itself is
	// printed to a thousand tokens, and a comparison made on the printed form cannot tell two
	// threads apart when their true totals fall inside one rounding step -- see the daimon's
	// half below, which is where that cost a red.
	const chatTotalTok = tok((band(w, 'Role prompt') || {}).text) + tok((band(w, 'Safety clause') || {}).text)
		+ tok((band(w, 'Standing instructions') || {}).text) + tok((band(w, 'Tool names') || {}).text)
		+ tok((band(w, 'This computer') || {}).text) + tok(compact);
	// THE THIRD WAY OF BEING WRONG, and the one that fooled this file: the array measured in
	// UTF-16 code units. It is neither the indented copy nor the sent bytes -- 41,964 against
	// 41,998 for the browser toolbelt -- and the two draw different headlines whenever they
	// fall either side of a rounding step, which on 2026-08-25 they did, at 10,500 tokens.
	// Asserted apart from the `pretty` check above, so a band that regressed to counting
	// characters cannot pass on the strength of merely not being the indented copy.
	check(bytes(compact) !== compact.length,
		'the sent array holds multi-byte characters, so bytes and characters CAN disagree',
		`${bytes(compact)} bytes over ${compact.length} UTF-16 units`);
	// They do not always round apart, and a run that pretended otherwise would be claiming a
	// distinction it had not drawn. So it says which kind of run it is.
	const charTok = fmtTok(Math.round(compact.length / 4));
	if (charTok === fmtTok(tok(compact))) {
		console.log('  ..   bytes and characters round alike today (' + charTok
			+ '), so this run cannot tell those two apart');
	} else {
		check(schemaBand.tok !== charTok,
			'and it is not the count of CHARACTERS, which rounds elsewhere today',
			`characters would say ${charTok}`);
	}
	await shot(s, 'chat-wire');

	// ══ 2. A daimon thread ════════════════════════════════════════════
	await makeDiamond(p, 'Wiremaker');
	const did = await p.evaluate(() => (DaimondDiamond.current() || {}).id || '');
	check(!!did, 'a Diamond is open', did);
	clearMockLog();
	// The same path a person takes: the Diamond's chat face, its composer, its send
	// button -- which `sendUserMessage` routes to `doSteer` and nowhere near `run_turn`.
	await steerDiamond(s, 'note that this happened');
	await p.waitForTimeout(6000);
	const dReq = lastReq();
	check(!!dReq, 'the steering turn reached the provider');
	const dSent = dReq ? (dReq.tools || []).slice().sort() : [];
	// THE DAIMON HOLDS THE WEB TOOLS NOW, and this check used to say it must not.
	//
	// `Tool::daimon()` never called `Tool::web()`, so a Diamond built for research held no
	// way to search, fetch or read a page while a chat beside it held nine. The owner
	// decided on 2026-08-24 that it should, and what stops a tainted turn reaching the
	// network is the egress gate rather than withholding the tools -- see the comment above
	// the grant in `src/tools.rs` and `dev/verify_daimonreach.mjs`, which holds that half.
	//
	// `say` is still absent, and that has not changed: it was removed outright, and what it
	// used to enforce moved rather than went.
	check(dSent.length > 0 && !dSent.includes('say'),
		'and the daimon does not hold `say`, which no longer exists',
		`${dSent.length} tools`);
	check(dSent.some(n => n.startsWith('web_')),
		'and it DOES hold the web tools, which is the grant of 2026-08-24',
		dSent.filter(n => n.startsWith('web_')).join(',') || 'none');
	check(dSent.includes('file_show'),
		'though it does hold `file_show`, so the check above is not simply an empty belt');

	await redrawWire(p);
	w = await wireDom(p);
	check(!!w && w.area > 0, 'the band is drawn on a daimon thread', w && `area ${w.area}`);
	const dShown = bandTools(w);
	check(JSON.stringify(dShown) === JSON.stringify(dSent),
		'THE BAND\'S TOOL LIST IS THE DAIMON\'S REAL REGISTRY',
		`band ${dShown ? dShown.length : '?'} vs wire ${dSent.length}`
		+ (JSON.stringify(dShown) === JSON.stringify(dSent) ? '' :
			`; only in band: [${(dShown || []).filter(n => !dSent.includes(n))}]`
			+ `; only sent: [${dSent.filter(n => !(dShown || []).includes(n))}]`));
	check(!!dShown && !dShown.includes('say'),
		'the band does not offer him `say` on a daimon thread',
		dShown && dShown.includes('say') ? 'it does' : '');
	// The band's own half of the grant of 2026-08-24: a daimon holds the web tools, so the
	// band must SHOW them. The check above already asserts the band's list is the registry
	// character for character; this says which way that agreement now falls, so a band that
	// silently stopped drawing them would not pass on the strength of matching an empty belt.
	check(!!dShown && dShown.some(n => n.startsWith('web_')),
		'and the band shows the nine web tools the daimon now holds',
		dShown ? `[${dShown.filter(n => n.startsWith('web_'))}]` : '');

	const dSys = dReq ? sysOf(dReq) : '';
	const dParts = [band(w, 'Role prompt'), band(w, 'Safety clause'), band(w, 'This Diamond'),
		band(w, 'Standing instructions'), band(w, 'Tool names'), band(w, 'This computer')]
		.filter(Boolean).map(b => b.text);
	check(dParts.length >= 5, 'the daimon band has its parts', dParts.length + ' of them');
	check(dParts.length > 0 && dParts.every(t => t.length > 0 && dSys.includes(t.trim())),
		'AND EVERY PART OF IT IS IN THE SYSTEM MESSAGE THE PROVIDER WAS SENT',
		dParts.map((t, i) => dSys.includes(t.trim()) ? '' : `part ${i} is not`).filter(Boolean).join('; '));

	// ══ 3. The figures are the daimon's ═══════════════════════════════
	check((dShown || []).length === dSent.length,
		'the daimon\'s schema count is the daimon\'s tool count',
		`${(dShown || []).length} vs ${dSent.length}`);
	const dTitle = w ? w.title : '';
	// The claim that the daimon's headline is the daimon's own is asserted below, on the
	// numbers, once both are in hand.
	// The daimon's own schemas, off the daimon's own request. `__wireRaw` holds the
	// last body the page sent, which after the steer is the steering turn's.
	const dRaw = await p.evaluate(() => window.__wireRaw || '');
	const dCompact = dRaw ? JSON.stringify(JSON.parse(dRaw).tools) : '';
	check(!!dCompact && dRaw.includes(dCompact) && bytes(dCompact) < bytes(compact),
		'the daimon sent its own, smaller, schema array',
		`${bytes(dCompact)} bytes against the chat's ${bytes(compact)}`);
	const dSchemaTok = tok(dCompact);
	check((band(w, 'Tool schemas') || {}).tok === fmtTok(dSchemaTok),
		'and the band reports THAT, in the daimon\'s figure',
		`band says ${(band(w, 'Tool schemas') || {}).tok}, sent is ${fmtTok(dSchemaTok)}`);
	// The whole headline, against the request rather than against itself: the text
	// bands as drawn, plus the schemas as sent. The bands are trimmed at the seams
	// where the blob is split, so a few characters go astray either side; the figure
	// is printed to a thousand tokens, which no seam can move.
	const sysTok = tok((band(w, 'Role prompt') || {}).text) + tok((band(w, 'Safety clause') || {}).text)
		+ tok((band(w, 'This Diamond') || {}).text) + tok((band(w, 'Standing instructions') || {}).text)
		+ tok((band(w, 'Tool names') || {}).text) + tok((band(w, 'This computer') || {}).text);
	const want = fmtTok(sysTok + dSchemaTok);
	check(dTitle.includes(want),
		'and the headline is those bands plus those bytes',
		`says "${dTitle}", computed ${want}`);
	// AND THE TWO THREADS REALLY DO CARRY DIFFERENT TOTALS, which is what keeps the check
	// above from being satisfiable by a headline carried over from the chat.
	//
	// COMPARED AS NUMBERS, NOT AS THE STRINGS THEY ARE PRINTED AS. This read
	// `dTitle !== chatTitle` until 2026-08-25, and `fmtTok` prints anything over a thousand
	// tokens to the nearest thousand -- so the moment the daimon's total and the chat's fell
	// in the same thousand, two correctly measured figures drew the same sentence and this
	// went red about the app. On the gate of that morning both said "about 13k tokens" while
	// the arrays behind them were 41,993 and 44,437 bytes: 611 tokens apart, and printed
	// identically. A check that cannot tell a collision from a carry-over is measuring the
	// rounding, not the band.
	const dTotalTok = sysTok + dSchemaTok;
	check(!!dTitle && dTotalTok !== chatTotalTok,
		'and it is the daimon\'s own total, not the chat\'s carried across',
		`daimon ${dTotalTok} tok "${dTitle}" vs chat ${chatTotalTok} tok "${chatTitle}"`);

	// ══ 4. The per-turn paragraph, drawn ══════════════════════════════
	const local = band(w, 'This Diamond');
	check(!!local, 'this turn\'s own paragraph has a band of its own');
	check(!!local && local.area > 0, 'and it is drawn, measured as an area',
		local && `area ${local.area}`);
	check(!!local && local.text.includes('diamonds/' + did),
		'it names THIS Diamond\'s folder', local && local.text.slice(0, 90));
	check(!!local && local.text.includes('Current crystal.json:'),
		'and carries the crystal the turn started from');
	check(!!local && !((band(w, 'Safety clause') || {}).text || '').includes('Current crystal.json:'),
		'so the crystal is not filed under the safety clause');
	check(!((band(w, 'Safety clause') || {}).text || '').includes('RANUNCULUS'),
		'nor the user\'s own house rules, which are drawn under their own heading');
	check(((band(w, 'Standing instructions') || {}).text || '').includes('RANUNCULUS'),
		'and they reach a daimon too, on the far side of this turn\'s own paragraph');
	await shot(s, 'daimon-wire');

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_wire: all checks pass.`
	: `\nverify_wire: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
