// verify_typstpack.mjs — typesetting is bought, and every door to it knows.
//
// Typst typesetting moved from the free belt to a purchasable pack. THE CAPABILITY IS THE
// PRODUCT, not the function the model calls, and the capability has three doors:
//
//   1. the model's `typst_compile` tool, dispatched through `Tool::guard` in `src/tools.rs`;
//   2. the ⚙ Compile button in the Doc panel, which involves no model, costs nothing, and calls
//      `window.DaimondTypst.compile` straight from JavaScript;
//   3. the driver itself, `window.DaimondTypst`, which the other two share so the 30 MB compiler
//      wasm is built once between them.
//
// A gate on (1) alone stops the model and leaves the person compiling free, which is a gate on one
// door and not on the product. So each door is driven here, separately, and each is asked the
// question that matters: NOT "did it say something" but "did a PDF appear".
//
// The properties, each with its control:
//
//   A. Unlocked, every door compiles.  Without this the refusals below prove nothing -- a build
//      whose compiler was simply broken would pass every locked check.
//   B. Locked, no door compiles, and NO PDF IS WRITTEN.  The file is removed before each attempt,
//      so the assertion is on the world and not on the wording.
//   C. The refusals are useful and in the reader's language: the tool's answers the MODEL in
//      English naming the tool and the pack, the button's answers a PERSON from the catalogue the
//      page has been translated into -- checked by reading it in a second language.
//   D. The catalogue and the build name the SAME pack.  `gateway/app.jdat` says what is on sale
//      and `Tool::pack` says what a sale unlocks; they ship separately, and a build older than the
//      catalogue fails open -- the page pushes a lock nothing recognises and the pack runs free.
//   E. The SALE and not merely the gate: with the price standing in `gateway/app.jdat` the page
//      reads it, the engine locks the tool and the compile is refused; with the price taken out of
//      that same string the pack is no longer on sale AND IS STILL LOCKED, because what a build
//      gates is decided by the build. The price buys a way out of the lock; it does not set it.
//   F. SOLD IS NOT LOCKED. An EMPTY catalogue must lock the pack, not give it away -- and the
//      control for it is the defect itself, reproduced in the same run: a listing assembled only
//      from the catalogue, for that same empty string, unlocks the tool and compiles a PDF. That
//      is the state the production gateway was in while a priced pack ran free on every device,
//      and it is why E above is not enough on its own -- E only ever pushes the catalogue towards
//      HAVING a price, and every failure that mattered was the catalogue losing one.
//
//   node dev/verify_typstpack.mjs
//
// Prove it red before trusting it green. The two gates are layered, and each removal turns a
// DIFFERENT check red, which is the point:
//
//   Remove `if let Some(refusal) = self.pack_refusal()` from `Tool::guard` and rebuild: no PDF
//   still appears, because the driver stops it -- so "the tool does not compile" stays green and
//   the ANSWER check goes red, the model having been handed a raw `UpstreamErr` naming a source
//   line instead of something it can relay. Gated, and still broken.
//
//   Remove the `if (await packLocked())` block from `www/js/typst.js`: the model's tool is still
//   refused by Rust, and both of the other two doors -- the driver and the ⚙ button -- go red,
//   compiling a PDF for an account that did not buy one.
//
// Neither removal turns everything red, and a verifier that only watched one of them would have
// signed off a half-gated product.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, SCRATCH } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A namespace of this verifier's own, so the files it makes and removes are nobody else's.
const NS   = 'd~typstpack';
const SRC  = 'paper.typ';
const PDF  = 'paper.pdf';
const BODY = '= A heading\n\nA paragraph, and $x^2 + y^2$.\n';

/// Every pack key the gateway's shipped catalogue sells, read out of `gateway/app.jdat` -- the
/// configuration a customer would actually be charged against.
///
/// This file used to hard-code the key. It cannot any more, because the key is now half of an
/// agreement between two files that are deployed separately: the catalogue names the pack, and the
/// BUILD decides which tool that pack locks. A catalogue selling `drop01` against a build whose
/// `Tool::pack` still answers an earlier key fails OPEN -- the page pushes a lock the engine does
/// not recognise, and the pack runs free on every device. That is the same defect this gate was
/// written to close, wearing a different hat, so the two are read independently here and compared.
/// It is also why the key is the pack's DROP rather than its theme: the display name may be
/// rewritten in the catalogue on the day, and nothing here or in the build moves when it is.
/// The `tools` string exactly as `gateway/app.jdat` states it.
function catalogueString() {
	const src = fs.readFileSync(path.join(HERE, '..', 'gateway', 'app.jdat'), 'utf8');
	const m = /"tools":\s*"([^"]*)"/.exec(src);
	return m ? m[1] : '';
}

/// The catalogue string read the way `gateway/src/catalogue.rs::parse` reads it:
/// `tool:price_minor:Name:Blurb`, comma separated, and an entry with no price is DROPPED --
/// "a tool with no price is a tool nobody can buy". Deliberately dumb, because it is a mirror of
/// Rust that Rust's own tests already cover; what it is here for is to put the SHIPPED
/// configuration in front of the page rather than a fixture somebody typed.
function parseCatalogue(str) {
	return str.split(',').map((entry) => {
		const parts = entry.trim().split(':');
		const tool  = (parts.shift() || '').trim();
		const price = parseInt((parts.shift() || '').trim(), 10);
		const name  = (parts.shift() || '').trim();
		const blurb = parts.join(':').trim();
		if (!tool || !(price > 0)) return null;
		return { tool, name: name || 'Daimond tool', blurb, price_minor: price };
	}).filter(Boolean);
}

const catalogueKeys = () => parseCatalogue(catalogueString()).map(t => t.tool);

/// Every pack key the GATEWAY gates, read out of `gateway/src/catalogue.rs`.
///
/// A third source, and it has to be third: the catalogue says what is on SALE and the build says
/// what a sale unlocks, and neither of those is what the gateway locks. That register is compiled
/// into the gateway precisely so that a catalogue edit cannot empty it -- which means it can now
/// disagree with the build, and a gateway gating `drop02` against a build gating `drop01` fails
/// open exactly as an empty catalogue used to. So all three are read here and compared.
///
/// The scan is on the `key` arms rather than on the enum, because the arms are the mapping and the
/// enum is only its spelling.
function gatedKeys() {
	const src  = fs.readFileSync(path.join(HERE, '..', 'gateway', 'src', 'catalogue.rs'), 'utf8');
	const body = /pub const fn key\(self\)[\s\S]*?match self \{([\s\S]*?)\n\s*\}/.exec(src);
	if (!body) return [];
	const out = [];
	const re  = /Self::\w+\s*=>\s*"([^"]+)"/g;
	let m;
	while ((m = re.exec(body[1])) !== null) out.push(m[1]);
	return out;
}

const s = await open({ name: 'typstpack', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// ── The instrument, before anything is measured with it ──────────────
//
// Everything below reads the world through these three helpers. If any of them is lying -- a
// namespace that is not applied, an existence check that always answers no -- every "no PDF was
// written" is vacuous. So they are proved against a file that IS there before they are trusted to
// report one that is not.

/// Point the wasm at this verifier's namespace and hand back the module.
await p.evaluate(async (ns) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_account_ns(ns);
}, NS);

/// Whether a file exists in the namespace, asked of OPFS directly rather than of the app.
const exists = (name) => p.evaluate(async ({ ns, n }) => {
	const root = await navigator.storage.getDirectory();
	let dir;
	try { dir = await root.getDirectoryHandle(ns); } catch (e) { return false; }
	try { await dir.getFileHandle(n); return true; } catch (e) { return false; }
}, { ns: NS, n: name });

/// Remove a file if it is there, so the next attempt starts from nothing.
const remove = (name) => p.evaluate(async ({ ns, n }) => {
	const root = await navigator.storage.getDirectory();
	try {
		const dir = await root.getDirectoryHandle(ns);
		await dir.removeEntry(n);
	} catch (e) { /* already absent */ }
}, { ns: NS, n: name });

/// Lock or unlock the pack, exactly as the page does after reading `/api/tools`.
const setLocked = (csv) => p.evaluate(async (v) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_locked_packs(v);
	return { locked: mod.locked_packs(), tool: mod.tool_locked('typst_compile') };
}, csv);

/// Run a tool the way the model does: through the registry's dispatch, which is what applies the
/// guard. NOT a direct call to the compile -- that would test a path no model takes.
const runTool = (name, args) => p.evaluate(async ({ n, a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app.run_tool(n, JSON.stringify(a));
}, { n: name, a: args });

// Prove the instrument on a file that is definitely there, then on its absence.
await runTool('file_write', { path: SRC, content: BODY });
const seesPresent = await exists(SRC);
await remove(PDF);
const seesAbsent = await exists(PDF);
check('the existence check can see a file that is there, and only that file',
	seesPresent === true && seesAbsent === false,
	`source seen: ${seesPresent}, absent PDF seen: ${seesAbsent}`);
if (!seesPresent || seesAbsent) {
	console.log('\nthe instrument is unsound, so nothing below would mean anything');
	await s.close();
	process.exit(1);
}

// ── The key the two halves have to agree on ──────────────────────────

const beltEarly = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return JSON.parse(mod.builtin_tools());
});
const beltEntry = beltEarly.find(t => t.tool === 'typst_compile');
const PACK  = beltEntry && beltEntry.pack ? beltEntry.pack : '';
const SELLS = catalogueKeys();
const GATES = gatedKeys();
check('the build locks on the pack key the gateway\'s catalogue actually sells',
	!!PACK && SELLS.indexOf(PACK) >= 0,
	`the build locks on "${PACK || '(nothing)'}", the catalogue sells ${
		SELLS.length ? SELLS.map(k => '"' + k + '"').join(', ') : '(nothing)'
	} — a build older than the catalogue fails OPEN, so rebuild the wasm before switching the price on`);
check('and the gateway GATES that same key, whatever the catalogue is doing',
	!!PACK && GATES.indexOf(PACK) >= 0,
	`the gateway's register gates ${
		GATES.length ? GATES.map(k => '"' + k + '"').join(', ') : '(nothing)'
	} — a register that does not name "${PACK}" reports the pack to nobody, so nothing locks it`);
if (!PACK) {
	console.log('\nthe build sells nothing, so there is no gate below to measure');
	await s.close();
	process.exit(1);
}

const armed = await setLocked(PACK);
check('the build can be told the pack is locked, and says so about the tool',
	armed.locked === PACK && armed.tool === true, JSON.stringify(armed));

// ── A. Unlocked, every door compiles ─────────────────────────────────
//
// The control for everything after it. This is the slow part: the first compile through any door
// builds the 30 MB compiler, and all three doors then share it.

await setLocked('');

await remove(PDF);
const toolFree = await runTool('typst_compile', { path: SRC });
const toolFreePdf = await exists(PDF);
check('unlocked: the model\'s tool compiles, and a PDF lands in the workspace',
	toolFreePdf === true, toolFree.slice(0, 160));

await remove(PDF);
const driverFree = await p.evaluate(async (body) => {
	const r = await window.DaimondTypst.compile(body);
	return {
		error: r.error || '',
		magic: r.pdf ? String.fromCharCode.apply(null, Array.from(r.pdf.slice(0, 5))) : '',
	};
}, BODY);
check('unlocked: the driver compiles a real document to real PDF bytes',
	driverFree.error === '' && driverFree.magic === '%PDF-',
	driverFree.error || `magic "${driverFree.magic}"`);

// ── The button, which involves no model at all ───────────────────────
//
// Opened the way a person opens it: the row in the Workspace tree, then the ⚙ in the header. The
// panel is what draws the button, so a fixture that called `compileTypst` directly would be
// testing a function nobody clicks.

async function openTheTypFile() {
	await p.evaluate(() => window.DaimondPanels.show('work'));
	await sleep(400);
	await p.evaluate(() => {
		const r = document.querySelector('#panel-work [data-act="refresh"]');
		if (r) r.click();
	});
	await sleep(900);
	return await p.evaluate((src) => {
		const rows = Array.from(document.querySelectorAll('#panel-work .files-row'));
		const row = rows.find(r => new RegExp(src.replace('.', '\\.')).test(r.textContent || ''));
		if (!row) return 'not in the tree: ' + rows.map(r => (r.textContent || '').trim()).join(',');
		row.click();
		return true;
	}, SRC);
}

/// Click ⚙ and wait for the header line to settle on an answer, whichever kind it is.
async function clickCompile(waitMs = 90000) {
	const clicked = await p.evaluate(() => {
		const b = document.querySelector('[data-act="compile"]');
		if (!b) return false;
		b.click();
		return true;
	});
	if (!clicked) return { clicked: false, msg: '' };
	const t0 = Date.now();
	for (;;) {
		const st = await p.evaluate(() => {
			const b = document.querySelector('[data-act="compile"]');
			const m = document.querySelector('.files-view-msg');
			return { busy: !!(b && b.disabled), msg: m ? (m.textContent || '') : '' };
		});
		// The handler re-enables the button in its `finally`, so "not busy" is the answer having
		// arrived by either route -- compiled, or refused.
		if (!st.busy && st.msg && !/^…/.test(st.msg)) return { clicked: true, msg: st.msg };
		if (Date.now() - t0 > waitMs) return { clicked: true, msg: st.msg, timedOut: true };
		await sleep(400);
	}
}

const inTree = await openTheTypFile();
// The view renders after the click resolves, so the button is waited FOR rather than looked for
// once. Looked for once, this reported "no Compile button" on a build that has one -- which is the
// verifier failing, not the app, and the kind of red that gets a real check deleted.
let hasButton = false;
for (let i = 0; i < 40 && !hasButton; i++) {
	hasButton = await p.evaluate(() => !!document.querySelector('[data-act="compile"]'));
	if (!hasButton) await sleep(250);
}
check('the .typ file opens in the Doc panel and offers a Compile button',
	inTree === true && hasButton, `in the tree: ${inTree}, button drawn: ${hasButton}`);

await remove(PDF);
const btnFree = await clickCompile();
const btnFreePdf = await exists(PDF);
check('unlocked: clicking ⚙ compiles, and a PDF lands in the workspace',
	btnFree.clicked === true && btnFreePdf === true, btnFree.msg.slice(0, 160));

// ── B. Locked, no door compiles and no PDF is written ────────────────

await setLocked(PACK);

await remove(PDF);
const toolLocked = await runTool('typst_compile', { path: SRC });
const toolLockedPdf = await exists(PDF);
check('LOCKED: the model\'s tool does not compile — no PDF was written',
	toolLockedPdf === false, `a PDF at ${PDF}: ${toolLockedPdf}`);
// The refusal is the model's to relay, so it has to carry what the model needs to say: which tool
// was refused, and which pack it is sold in. Asserted as content, not as a fixed sentence.
//
// AND it must be an ANSWER rather than an error. This is the check that the Rust gate earns its
// place with: take `pack_refusal` out of `Tool::guard` and the driver below still stops the
// compile, so no PDF appears and the check above stays green -- but the model is handed a raw
// `UpstreamErr` naming a source line, which it cannot relay to anyone. The capability would still
// be gated and the product would still be broken, and only this assertion says so.
check('and it tells the model which tool was refused and which pack sells it, as an answer not an error',
	toolLocked.includes('typst_compile') && toolLocked.includes(PACK)
		&& /has not bought/.test(toolLocked)
		&& !/^Error:/.test(toolLocked.trim()),
	toolLocked.slice(0, 200));

await remove(PDF);
const driverLocked = await p.evaluate(async (body) => {
	const r = await window.DaimondTypst.compile(body);
	return { error: r.error || '', bytes: r.pdf ? r.pdf.length : 0 };
}, BODY);
check('LOCKED: the driver itself refuses, and hands back no bytes at all',
	driverLocked.bytes === 0 && driverLocked.error !== '',
	`${driverLocked.bytes} bytes, error: ${driverLocked.error.slice(0, 120)}`);

await remove(PDF);
const btnLocked = await clickCompile(20000);
const btnLockedPdf = await exists(PDF);
check('LOCKED: clicking ⚙ does not compile — no PDF was written',
	btnLocked.clicked === true && btnLockedPdf === false,
	`clicked: ${btnLocked.clicked}, said: ${btnLocked.msg.slice(0, 140)}`);

// ── C. The refusal a person reads, in the language they read in ──────
//
// The button's message is shown to a PERSON, so it comes out of the catalogue rather than out of
// Rust. Two claims: it IS the catalogue's sentence, and it MOVES when the language does. The
// second is what catches a "localised" string that was hard-coded in English -- a bug class this
// app has shipped before, where a locale change left the text where it was.

const englishSaid = await p.evaluate(() => ({
	msg: (document.querySelector('.files-view-msg') || {}).textContent || '',
	cat: window.DaimondI18n ? window.DaimondI18n.t('typst.pack_locked') : '',
	loc: window.DaimondI18n ? window.DaimondI18n.locale() : '',
}));
check('the refusal a person reads is the catalogue\'s sentence, not one built in the code',
	englishSaid.msg.trim() === englishSaid.cat.trim() && englishSaid.cat.length > 20,
	`shown "${englishSaid.msg.slice(0, 60)}" vs catalogue "${englishSaid.cat.slice(0, 60)}"`);
// It has to say the three things a refused reader needs: that it is a pack, where to get it, and
// that it is not their credits being spent.
check('and it says it is a pack, names where to get it, and that credits are not spent',
	/pack/i.test(englishSaid.cat) && /Tools/.test(englishSaid.cat) && /credits/i.test(englishSaid.cat),
	englishSaid.cat);
// No dialog ambushes the reader: the answer arrives in the header line where they clicked.
const noDialog = await p.evaluate(() => {
	const open = Array.from(document.querySelectorAll('dialog')).filter(d => d.open);
	return open.length === 0;
});
check('and nothing is put up in front of them to deliver it', noDialog === true);

await p.evaluate(async () => {
	if (window.DaimondI18n) await window.DaimondI18n.setLocale('de');
});
await sleep(600);
await remove(PDF);
const btnDe = await clickCompile(20000);
const germanSaid = await p.evaluate(() => ({
	cat: window.DaimondI18n ? window.DaimondI18n.t('typst.pack_locked') : '',
	loc: window.DaimondI18n ? window.DaimondI18n.locale() : '',
}));
check('a reader in another language is refused in THEIR language',
	germanSaid.loc === 'de'
		&& btnDe.msg.trim() === germanSaid.cat.trim()
		&& germanSaid.cat.trim() !== englishSaid.cat.trim(),
	`locale ${germanSaid.loc}, shown "${btnDe.msg.slice(0, 60)}"`);
check('and it is still refused in that language — no PDF was written',
	(await exists(PDF)) === false);

await p.evaluate(async () => {
	if (window.DaimondI18n) await window.DaimondI18n.setLocale('en');
});
await sleep(400);

// ── Buying it gives it back ──────────────────────────────────────────
//
// The last control, and the one that proves the gate is the ENTITLEMENT and not the code path: the
// same click, on the same file, in the same session, once the pack is held.

await setLocked('');
await remove(PDF);
const btnBought = await clickCompile();
const btnBoughtPdf = await exists(PDF);
check('bought: the very same click compiles again, in the same sitting',
	btnBought.clicked === true && btnBoughtPdf === true, btnBought.msg.slice(0, 160));

await remove(PDF);
const toolBought = await runTool('typst_compile', { path: SRC });
check('bought: and so does the model\'s tool',
	(await exists(PDF)) === true, toolBought.slice(0, 160));

// ── E. Driven by the PRICE in the shipped catalogue ──────────────────
//
// Everything above sets the lock by hand, which proves the gate and not the SALE. This phase
// starts from `gateway/app.jdat` -- the file an operator edits to put a pack on sale -- and lets
// the page do the rest: `/api/tools` answers what that catalogue sells, `www/js/tools.js` reads
// it, pushes the shortfall into the wasm, and the compile is attempted for real. Nothing between
// the price and the refusal is simulated except the gateway's own parse, which its Rust tests
// cover.
//
// And then the control, which CHANGED when the gate did. Taking the price out used to make the
// same run compile: the listing was built from the catalogue alone, so an entry nobody could buy
// was an entry nobody was locked out of. That was the defect, not the design -- phase F below
// reproduces it deliberately -- and the fix put the gated register in the BUILD, where a catalogue
// edit cannot empty it. So a pack with no price is still a gated pack, and what the price decides
// now is whether it can be BOUGHT. The two checks below assert exactly that, which is the property
// the sale rests on: the lock does not move with the price. Revert the fix and they go red, because
// the pack would fall out of the listing with its price.
//
// The anti-vacuity control for the whole phase is therefore not here but in phase A above, which
// compiles through all three doors unlocked, and in phase F's first pair, which reaches the same
// engine through the same listing route and DOES unlock it.

/// Serve `/api/tools` with exactly this listing and let the panel push what it makes of it into
/// the engine. The low half of `serveCatalogue`, separated so the OLD rule can be served too.
async function serveListing(tools) {
	await p.unroute('**/api/tools').catch(() => {});
	await p.route('**/api/tools', r => r.fulfill({
		status: 200, contentType: 'application/json',
		body: JSON.stringify({ ok: true, credits_minor: 0, tools }),
	}));
	await p.evaluate(() => window.DaimondTools && window.DaimondTools.reload());
	await sleep(900);
	return p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		return { locked: mod.locked_packs(), tool: mod.tool_locked('typst_compile') };
	});
}

/// The listing the gateway builds from a catalogue string, for an account holding nothing.
///
/// A UNION of two sets and not a walk over one, mirroring `catalogue::listing`: everything the
/// catalogue sells, then every gated pack nothing sells. The mirror is deliberately dumb -- the
/// gateway's own tests cover the rule -- and what it is here for is to put the shape the gateway
/// now emits in front of the real page and the real engine.
function listingFor(str) {
	const sold = parseCatalogue(str).map(t => ({
		tool: t.tool, name: t.name, blurb: t.blurb, price_minor: t.price_minor,
		unlocked: false, purchasable: true, gated: GATES.indexOf(t.tool) >= 0, currency: 'usd',
	}));
	GATES.forEach((k) => {
		if (sold.some(t => t.tool.toLowerCase() === k.toLowerCase())) return;
		sold.push({
			tool: k, name: '', blurb: '', price_minor: 0,
			unlocked: false, purchasable: false, gated: true, currency: 'usd',
		});
	});
	return sold;
}

/// Serve `/api/tools` from a catalogue string, as the gateway would for an account holding
/// nothing, and let the panel push what it makes of it into the engine.
async function serveCatalogue(str) {
	return serveListing(listingFor(str));
}

const SHIPPED = catalogueString();
if (SELLS.indexOf(PACK) < 0) {
	console.log('  skip  the shipped catalogue sells no pack this build locks on, so the '
		+ 'end-to-end phase was NOT RUN — see the first failure above');
} else {
	await setLocked('');
	const engPriced = await serveCatalogue(SHIPPED);
	check('priced in the catalogue: the page reads it and the engine locks the tool',
		engPriced.tool === true && engPriced.locked.split(',').indexOf(PACK) >= 0,
		`catalogue "${SHIPPED.slice(0, 60)}…" → ${JSON.stringify(engPriced)}`);

	await remove(PDF);
	const soldRefusal = await runTool('typst_compile', { path: SRC });
	check('priced and unbought: the compile is refused and no PDF is written',
		(await exists(PDF)) === false && soldRefusal.includes(PACK),
		soldRefusal.slice(0, 140));

	// The control: the same catalogue with the price taken out. The entry is dropped from the
	// sale -- a tool with no price is a tool nobody can buy -- and the pack is then reported by
	// the BUILD's register instead, unbought and so still locked.
	const unpriced = SHIPPED.replace(/^([^:,]+):\d+:/, '$1::');
	const engFree = await serveCatalogue(unpriced);
	check('price removed: the pack drops out of the sale and STAYS locked',
		engFree.tool === true && engFree.locked.split(',').indexOf(PACK) >= 0,
		`catalogue "${unpriced.slice(0, 60)}…" → ${JSON.stringify(engFree)}`
			+ ' — a listing built from the catalogue alone reports nothing here and gives the pack away');

	await remove(PDF);
	const stillRefused = await runTool('typst_compile', { path: SRC });
	check('price removed: the very same call is still refused, and no PDF is written',
		(await exists(PDF)) === false && stillRefused.includes(PACK),
		stillRefused.slice(0, 140));

	await p.unroute('**/api/tools').catch(() => {});
	await setLocked('');
}

// ── F. Sold is not locked ────────────────────────────────────────────
//
// Phase E moves the catalogue towards HAVING a price. Every failure that has actually happened
// moved it the other way: the running gateway's catalogue was the empty string, so nothing was on
// sale, so nothing was locked, so a $15 pack compiled documents for free on every device and no
// log line said so. This phase therefore runs OUTSIDE the guard above -- a shipped catalogue that
// has lost its price is exactly the state it is here to measure, and skipping it then would skip
// it precisely when it matters.
//
// The control is run FIRST and is the defect itself, so the phase cannot pass by refusing
// everything: the same empty catalogue, listed the old way -- one line per entry, which for an
// empty catalogue is no lines at all -- unlocks the tool and writes a PDF.

await setLocked('');
const engOldRule = await serveListing([]);
check('THE DEFECT, reproduced: a listing built only from the catalogue unlocks the pack',
	engOldRule.tool === false && engOldRule.locked === '',
	`empty listing → ${JSON.stringify(engOldRule)}`);
await remove(PDF);
const gaveItAway = await runTool('typst_compile', { path: SRC });
check('and the tool compiles for an account that bought nothing — this is what was live',
	(await exists(PDF)) === true, gaveItAway.slice(0, 140));

// And now the same empty catalogue through the rule that separates the two.
const engEmpty = await serveCatalogue('');
check('EMPTY catalogue: the pack is still gated, so the engine still locks the tool',
	engEmpty.tool === true && engEmpty.locked.split(',').indexOf(PACK) >= 0,
	`empty catalogue → ${JSON.stringify(engEmpty)}`);
await remove(PDF);
const emptyRefusal = await runTool('typst_compile', { path: SRC });
check('EMPTY catalogue: the compile is refused and no PDF is written',
	(await exists(PDF)) === false && emptyRefusal.includes(PACK),
	emptyRefusal.slice(0, 140));

// A catalogue nobody can parse an entry out of is the same case wearing a different hat: a
// mistyped price is not a price, so nothing is on sale -- and nothing being on sale must not be
// what decides whether the tool runs.
const engJunk = await serveCatalogue(PACK + ':free:Publishing,,:1500:Nameless');
check('UNPARSEABLE catalogue: the pack is locked rather than released',
	engJunk.tool === true && engJunk.locked.split(',').indexOf(PACK) >= 0,
	`junk catalogue → ${JSON.stringify(engJunk)}`);
await remove(PDF);
const junkRefusal = await runTool('typst_compile', { path: SRC });
check('UNPARSEABLE catalogue: the compile is refused and no PDF is written',
	(await exists(PDF)) === false && junkRefusal.includes(PACK),
	junkRefusal.slice(0, 140));

// NOT checked here, and deliberately: what the PANEL draws for a pack it cannot sell. The gateway
// now says `purchasable: false` and quotes no price, and `www/js/tools.js` does not read that
// field yet -- it draws a Buy button from `unlocked` alone, so in this state it offers the pack at
// $0.00 and the checkout refuses the click. That is a cosmetic fault in a state that only exists
// when the catalogue is broken, it belongs to the panel's own lane, and a red line here would
// block a release on it. `dev/verify_toolspanel.mjs` is where it should land once the panel
// honours the field.

await p.unroute('**/api/tools').catch(() => {});
await setLocked('');

// ── The panel no longer calls it free ────────────────────────────────
//
// The belt is what the Tools panel draws from, so a sold tool has to be MARKED sold there or the
// panel keeps listing it under "Built in" with no price on it.

const belt = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return JSON.parse(mod.builtin_tools());
});
const typstEntry = belt.find(t => t.tool === 'typst_compile');
const freeEntries = belt.filter(t => !t.pack);
check('the belt marks the sold tool with its pack, and marks nothing else',
	!!typstEntry && typstEntry.pack === PACK
		&& freeEntries.length === belt.length - 1
		&& !freeEntries.some(t => t.tool === 'typst_compile'),
	typstEntry ? `pack "${typstEntry.pack}", ${freeEntries.length} free of ${belt.length}` : 'no entry');

await shot(s, 'typstpack');

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_locked_packs('');
	mod.set_account_ns('');
});

const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
console.log('scratch:', SCRATCH);
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
