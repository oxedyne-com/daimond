/* ============================================================
   Daimond — in-browser Typst compiler (Stage 4b)
   ------------------------------------------------------------
   A thin, self-hosted wrapper over the Typst wasm compiler
   (typst.ts web-compiler, vendored under www/vendor/typst/).
   It compiles a `.typ` source string, or a whole PROJECT of
   sources, assets and fonts gathered in Rust, to a PDF
   (Uint8Array) entirely in the browser — no server, no CDN.

   The 28 MB compiler wasm and the default fonts are fetched
   from the vendored directory only; nothing leaves the origin.
   The compiler and its font set are built once, lazily, on the
   first compile and reused thereafter.

   Security (H5): this module produces bytes only; it never
   touches the DOM.  The caller renders the PDF from a blob URL
   in an <embed>, and shows any diagnostics via textContent.
   ============================================================ */

// Vendored assets, resolved relative to this module's own URL so
// the paths hold wherever `www/` is served from.
/// What the app says. A module, not a script, so the engine is reached through
/// the window rather than through a shared closure.
function tt(k, v) { return window.DaimondI18n ? window.DaimondI18n.t(k, v) : k; }

const VENDOR = new URL('../vendor/typst/', import.meta.url);
const GLUE   = new URL('typst_ts_web_compiler.mjs', VENDOR);
const WASM   = new URL('typst_ts_web_compiler_bg.wasm', VENDOR);

// The default font set: Libertinus Serif (Typst's default body
// and heading family) plus New Computer Modern Math (the default
// maths font), so a heading, paragraph and equation all render.
const FONTS = [
	'LibertinusSerif-Regular.otf',
	'LibertinusSerif-Bold.otf',
	'LibertinusSerif-Italic.otf',
	'LibertinusSerif-BoldItalic.otf',
	'NewCMMath-Regular.otf',
];

// Full diagnostics (see typst.ts: none=1, unix=2, full=3), so a
// failed compile carries a human-readable message.
const DIAG_FULL = 3;

// The main source path inside the compiler's shadow filesystem.
const MAIN = '/main.typ';

// ── The memo is the incremental compiler, and it is not an optimisation ─────
//
// `_compilerPromise` holds ONE `TypstCompiler` for the life of the document. It is
// never freed and never rebuilt, and the module-URL guard at the foot of this file
// exists specifically to stop a second one being installed.
//
// THAT MEMO IS WHY A REBUILD IS HALF A SECOND RATHER THAN THREE. Every compile calls
// `reset_shadow()` and re-`add_source`s all 63 files of a book, which wipes the shadow
// filesystem -- but NOT comemo's memo cache, which is keyed on content hashes. Identical
// text re-added under the same path hashes the same, so the cached layout is still valid
// and only what changed is laid out again. Measured on the author's 281-page book: 2960 ms
// the first time, 182 ms the second, 384 ms after a real edit -- a factor of fifteen, and
// the whole difference between a watch loop and a build.
//
// So a tidy-up that gave each compile a fresh `TypstCompiler` -- which would look like good
// hygiene, and which nothing here would fail on -- is a silent fifteen-fold regression. It
// would break no test, because every test would still get its PDF. The measurements are in
// `dev/TYPST_WATCH.md` §4.
let _compilerPromise = null;   // memoised compiler build
let _glue = null;              // the glue module, kept for its font-resolver builder
let _init = null;              // the wasm exports, kept so the heap can be read
let _bundled = null;           // the bundled font bytes, kept so a project set can re-add them
let _fontState = '';           // which project fonts the live compiler was last given

/// Build (once) and return the Typst compiler with its fonts
/// loaded.  Subsequent calls reuse the same instance.
function getCompiler() {
	if (_compilerPromise) return _compilerPromise;
	_compilerPromise = (async function () {
		const mod = await import(GLUE.href);
		_glue = mod;
		// Initialise the wasm module from the vendored path.
		_init = await mod.default(WASM);
		const builder = new mod.TypstCompilerBuilder();
		// No external file/package access is needed: sources are
		// injected as shadow files, so a dummy access model is fine.
		builder.set_dummy_access_model();
		_bundled = [];
		for (const name of FONTS) {
			const url = new URL('fonts/' + name, VENDOR);
			const resp = await fetch(url);
			if (!resp.ok) {
				throw new Error('Typst: font fetch failed for ' + name + ' (' + resp.status + ')');
			}
			const buf = new Uint8Array(await resp.arrayBuffer());
			_bundled.push(buf);
			await builder.add_raw_font(buf);
		}
		return await builder.build();
	})();
	return _compilerPromise;
}

/// Extract the PDF bytes from the compiler's return value, which
/// across versions is either the artifact directly or an object
/// carrying `result`/`artifact` alongside `diagnostics`.
function extractPdf(ret) {
	if (ret instanceof Uint8Array) return ret;
	if (ret && typeof ret === 'object') {
		const cand = ret.result || ret.artifact || ret.pdf || ret.output;
		if (cand instanceof Uint8Array) return cand;
		if (cand && cand.buffer) return new Uint8Array(cand.buffer);
	}
	return null;
}

/// Pull any diagnostics into a printable string.
function diagText(ret) {
	if (!ret || typeof ret !== 'object') return '';
	const d = ret.diagnostics;
	if (!d) return '';
	if (typeof d === 'string') return d;
	if (Array.isArray(d)) {
		return d.map(function (e) {
			if (typeof e === 'string') return e;
			if (e && e.message) return (e.severity ? e.severity + ': ' : '') + e.message;
			try { return JSON.stringify(e); } catch (_) { return String(e); }
		}).join('\n');
	}
	try { return JSON.stringify(d); } catch (_) { return String(d); }
}

// ── Saying what actually went wrong ─────────────────────────────────────────
//
// Typst's dummy access model answers EVERY unreachable path with one sentence:
//
//   failed to load file (access denied), hints: cannot read file outside of
//   project root, you can adjust the project root with the --root argument
//
// That sentence describes a setting the caller could change, and there is no
// such setting here -- there is no `--root` to pass, and the file was not outside
// a root, it was simply never handed over.  In a real session it cost the author
// an hour: his daimon read "outside of project root", concluded the book's images
// were out of bounds, and went looking for assets that were never the problem.
//
// So the message is composed here instead, out of what this side actually knows:
// which file was being read, which line, which path that line names, and what the
// compiler was given.  Typst's own words are kept underneath, because they name
// the failing construct, but they no longer lead.

/// The diagnostics of a failed compile, as an array of objects.
function diagList(ret) {
	if (!ret || typeof ret !== 'object') return [];
	const d = ret.diagnostics;
	if (Array.isArray(d)) return d.filter(function (e) { return e && typeof e === 'object'; });
	return [];
}

/// The zero-based line number a typst range like `4:7-4:24` starts on, or -1.
function rangeLine(range) {
	const m = /^(\d+):(\d+)/.exec(String(range || ''));
	return m ? parseInt(m[1], 10) : -1;
}

/// The zero-based column a typst range starts at, or -1.
function rangeCol(range) {
	const m = /^(\d+):(\d+)/.exec(String(range || ''));
	return m ? parseInt(m[2], 10) : -1;
}

/// The source line a diagnostic points at, trimmed, or ''.
function lineAt(text, idx) {
	if (idx < 0) return '';
	const lines = String(text || '').split('\n');
	return idx < lines.length ? lines[idx].trim() : '';
}

/// The quoted literal a diagnostic points at.
///
/// The column is used to pick which literal on a busy line, but the whole line
/// is searched rather than the exact byte span: typst counts columns in its own
/// units, and being one unit out must not turn a precise message back into a
/// vague one.
function literalAt(text, range) {
	const line = lineAt(text, rangeLine(range));
	if (!line) return '';
	const col = rangeCol(range);
	const hits = [];
	const re = /"([^"\n]*)"/g;
	let m;
	while ((m = re.exec(line)) !== null) hits.push({ at: m.index, val: m[1] });
	if (!hits.length) return '';
	for (const h of hits) {
		// The line was trimmed, so allow generous slack around the column.
		if (col >= 0 && Math.abs(h.at - col) <= 8) return h.val;
	}
	return hits[0].val;
}

/// One diagnostic, said in terms of what this compiler was actually given.
///
/// # Arguments
/// * `d`   - The diagnostic object typst returned.
/// * `ctx` - `{ texts, count, root, searched, single }`: the sources by shadow path,
///           how many files went in, where the root was put, which folders a
///           root-relative name was looked for in, and whether this was a
///           single-file compile with no project behind it at all.
function explainDiag(d, ctx) {
	const where = d.path ? (d.path + (rangeLine(d.range) >= 0 ? ':' + (rangeLine(d.range) + 1) : '')) : '';
	const head = (d.severity || 'error') + (where ? ' at ' + where : '') + ': ';
	const msg = String(d.message || '');
	const text = ctx.texts[d.path] || '';
	const named = literalAt(text, d.range);

	if (/failed to load package/i.test(msg)) {
		const pkg = named || 'a package';
		return head + '"' + pkg + '" is a REGISTRY package, not a file. Names beginning "@" '
			+ 'come from Typst Universe, which the command-line compiler downloads over the '
			+ 'network and caches; this compiler runs inside the page with no network at all, '
			+ 'and nothing supplies it packages yet. So this is not a missing file, not a path '
			+ 'problem and not a root problem, and no amount of moving files or attaching '
			+ 'folders will fix it: do not go looking, and do not rewrite the source to work '
			+ 'around it. Compile this document with the command-line typst, which can fetch '
			+ 'the package — or copy what it provides into the project as ordinary files and '
			+ 'import it by path.';
	}
	if (/failed to load file/i.test(msg) || /access denied/i.test(msg)) {
		if (ctx.single) {
			return head + 'this line reaches for ' + (named ? '"' + named + '"' : 'another file')
				+ ', and only the one source was given to the compiler. Nothing else was gathered, '
				+ 'so there is no file of that name for it to read. Typst\'s own wording, below, '
				+ 'talks about a project root and a --root argument; there is no root to adjust '
				+ 'here, because a single string was compiled rather than a folder.'
				+ '\n  typst said: ' + msg;
		}
		return head + 'this line reaches for ' + (named ? '"' + named + '"' : 'a file')
			+ ', which was not among the ' + ctx.count + ' files gathered for this compile. '
			+ 'The project root was put at ' + ctx.root + ', worked out from the imports rather '
			+ 'than set anywhere, and a name beginning with "/" was looked for in '
			+ (ctx.searched.length ? ctx.searched.join(', then ') : 'the root') + '. A path built '
			+ 'at run time -- joined from a variable, say -- cannot be seen when the project is '
			+ 'gathered, and would look exactly like this. Check that the file is in one of those '
			+ 'folders, and that the source names it as a plain string.'
			+ '\n  typst said: ' + msg;
	}
	const line = lineAt(text, rangeLine(d.range));
	return head + msg + (line ? '\n  ' + line : '');
}

/// Every diagnostic of a failed compile, explained.
function explainDiags(ret, ctx) {
	const list = diagList(ret);
	if (!list.length) return diagText(ret);
	return list.map(function (d) { return explainDiag(d, ctx); }).join('\n\n');
}

// ── Typesetting is bought, not shipped ──────────────────────────
//
// Typesetting is sold as a pack, and there are THREE ways into this compiler: the
// model's `typst_compile` tool, the ⚙ Compile button in the Doc panel, and this
// driver itself, which the other two share so the 30 MB wasm is built once.
//
// So the gate is here, at the one point all three meet.  A gate at the Rust tool
// alone would stop the model and leave the button free, which is not a gate on the
// capability -- it is a gate on one of its doors.  The Rust one is still there and
// still first for a tool call: it answers the MODEL, in the model's language, with
// what the pack is and what to tell the user.  This one answers a PERSON, in
// theirs, in the header line where they clicked.
//
// The wasm bundle is the single authority on this device for what was bought: the
// page sets it there from `/api/tools`, and `Tool::guard` in Rust reads the very
// same value, so the button and the tool cannot disagree about one purchase.
// Nothing here holds a pack key -- `tool_locked` is asked about the TOOL, and the
// mapping from tool to pack stays in one language.

/// The tool this compiler is, as the registry names it.
const TOOL = 'typst_compile';

/// Whether this account has not bought the pack the compiler is sold in.
///
/// Asked afresh at every compile rather than memoised: a purchase completes in the
/// middle of a sitting, and a memo would go on refusing a customer who has just paid.
///
/// Answers `false` -- not locked -- when it cannot ask at all: no bundle, or one not
/// yet initialised.  Refusing on that would take a bought tool away from a paying
/// customer over a load order or a network blink, and the gate that actually takes
/// the money is the gateway's, which is not reachable from here in any case.
async function packLocked() {
	try {
		const mod = await import('../pkg/oxedyne_daimond.js');
		return mod.tool_locked(TOOL) === true;
	} catch (e) {
		return false;
	}
}

/// Compile a Typst source string to a PDF.
///
/// Returns `{ pdf: Uint8Array }` on success, or `{ error: string }`
/// when the compiler reports diagnostics or produces no bytes.
export async function compilePdf(source) {
	// Before the compiler is built, not after: an account that has not bought the
	// pack never fetches the 30 MB wasm, and the refusal is immediate rather than
	// arriving at the end of a long download that was always going to be refused.
	//
	// The wording does not name the pack, deliberately. The catalogue owns its name
	// and its price, an operator may change either from the console, and a name
	// copied into eight translations would be the copy that goes stale. The Tools
	// panel states both, from the table the till charges against, so this points
	// there instead.
	if (await packLocked()) {
		return { error: tt('typst.pack_locked') };
	}
	let compiler;
	try {
		compiler = await getCompiler();
	} catch (e) {
		return { error: tt('typst.load_failed', { reason: (e && e.message ? e.message : e) }) };
	}
	// A single file has no project behind it, so there is provably nowhere a font
	// could come from: a family that is not one of the five bundled here cannot be
	// satisfied by anything, and rendering it in a substitute would be the same
	// silent lie the project door refuses. Said here as well as there, because the
	// document does not become less wrong for having arrived by the smaller door.
	const bundledFams = [];
	for (const f of _bundled) for (const n of familiesOf(f)) bundledFams.push(n);
	const lack = missingFamilies(fontSetsOf(source), bundledFams);
	if (lack.length) {
		return { error: 'This document asks for the font "' + lack.join('", and for "')
			+ '", and a single file brings no fonts with it. Only ' + bundledFams.join(', ')
			+ ' are bundled with this compiler. Typst would substitute one silently, and the '
			+ 'line breaks and page count of what came back would not be the ones that print. '
			+ 'Put the font file beside the source and compile it as a project, or set a family '
			+ 'that is bundled.' };
	}

	try {
		// Start from a clean shadow filesystem each time.
		compiler.reset_shadow();
		await useFonts([]);
		compiler.add_source(MAIN, source);
		const ret = compiler.compile(MAIN, undefined, 'pdf', DIAG_FULL);
		const pdf = extractPdf(ret);
		if (pdf && pdf.length > 4) {
			return { pdf: pdf };
		}
		const texts = {}; texts[MAIN] = source;
		const diag = explainDiags(ret, { texts: texts, count: 1, root: 'nowhere', searched: [], single: true });
		return { error: diag || tt('typst.no_pdf') };
	} catch (e) {
		return { error: tt('typst.compile_error', { reason: (e && e.message ? e.message : e) }) };
	}
}

// ── Fonts are a correctness question ────────────────────────────────────────
//
// A family the compiler does not have is not an error and not a warning: this
// build reports diagnostics only when the compile FAILS, and an unknown family
// simply falls back.  Measured on this very compiler: a document that sets
// "Radley" and one that sets nothing at all produced byte-identical PDFs.
//
// That silence is the danger.  The author proofreads a 281-page book for widows,
// short last lines and page count, and every one of those is decided by the font
// metrics.  A preview typeset in a substitute is a preview of a book that will
// never be printed, and nothing on the screen would say so.  So the rule here is
// to refuse rather than approximate: if the project names a family that cannot be
// loaded, no PDF is produced and the refusal names the family and where to put it.

/// The font families a font file provides.
function familiesOf(bytes) {
	try {
		const info = new _glue.TypstFontResolverBuilder().get_font_info(bytes);
		const list = (info && info.info) || [];
		return list.map(function (i) { return String(i.family || ''); }).filter(Boolean);
	} catch (e) {
		return [];
	}
}

/// A family name reduced to what two spellings of the same font share.
function famKey(name) {
	return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/// The font families a source asks for, as alternative sets.
///
/// A parenthesised tuple is typst's fallback chain -- it takes the first family it
/// has -- so the whole tuple is ONE set, satisfied by any member.  Anything else,
/// including the `if it.level <= 2 { "Radley" } else { "Libertinus Serif" }` form
/// the author's template uses, yields one set per family: both branches really do
/// render, and folding them into a chain would let a missing font through.
///
/// This lives here rather than in the Rust gatherer, and only here, because here is
/// where the answer is compared against the fonts actually loaded.  Two scanners in
/// two languages agreeing today is two scanners disagreeing later.
///
/// Its limit, stated because it is a real one: a family reached through a variable
/// (`#let f = "Radley"` … `font: f`) is invisible to it, and this build gives no
/// warning to fall back on -- measured, typst returns diagnostics only when a
/// compile FAILS, and a missing family does not fail.
function fontSetsOf(src) {
	const s = String(src || '');
	const out = [];
	let i = 0;
	for (;;) {
		const at = s.indexOf('font:', i);
		if (at < 0) break;
		let j = at + 'font:'.length;
		while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
		let end;
		let asTuple = false;
		if (s[j] === '(') {
			let depth = 0;
			let k = j;
			for (; k < s.length; k++) {
				if (s[k] === '(') depth++;
				else if (s[k] === ')') { depth--; if (!depth) { k++; break; } }
			}
			end = k;
			asTuple = true;
		} else {
			const nl = s.indexOf('\n', j);
			end = nl < 0 ? s.length : nl;
		}
		const found = [];
		const re = /"([^"\n]*)"/g;
		const slice = s.slice(j, end);
		let m;
		while ((m = re.exec(slice)) !== null) if (m[1]) found.push(m[1]);
		if (found.length) {
			if (asTuple) out.push(found);
			else for (const f of found) out.push([f]);
		}
		i = end > at ? end : at + 1;
	}
	return out;
}

/// A cheap fingerprint of a font's bytes, for deciding whether the loaded set is
/// still the set on disk.
///
/// Path and length alone would miss a font edited in place to the same size, and the
/// consequence of missing it is the whole reason this file refuses substitutes: a
/// book typeset in yesterday's metrics, with today's font sitting in the folder.
function sample(bytes) {
	let h = 0;
	for (let i = 0; i < bytes.length; i += 997) h = (h * 31 + bytes[i]) >>> 0;
	return h;
}

/// Give the live compiler the bundled fonts plus `extra`, or just the bundled
/// ones when `extra` is empty.
///
/// `set_fonts` REPLACES the font book rather than adding to it -- measured: a
/// resolver built from one project font alone left the compiler unable to find
/// Libertinus Serif, which it had been built with.  So the bundled bytes are
/// re-added every time, and the set is left alone when it has not changed, since
/// rebuilding a resolver per compile would be paid for on every keystroke of a
/// preview loop.
///
/// # Arguments
/// * `extra` - `[name, Uint8Array]` pairs gathered from the project.
async function useFonts(extra) {
	const key = extra.map(function (f) { return f[0] + ':' + f[1].length + ':' + sample(f[1]); }).join('|');
	if (key === _fontState) return;
	const compiler = await getCompiler();
	const b = new _glue.TypstFontResolverBuilder();
	for (const f of _bundled) b.add_raw_font(f);
	for (const f of extra) b.add_raw_font(f[1]);
	compiler.set_fonts(await b.build());
	_fontState = key;
}

/// Which of the families a project asks for it cannot supply.
///
/// A `wanted` entry is a set of ALTERNATIVES -- typst takes the first family in
/// a fallback tuple that it has -- so a set is satisfied when any member is
/// available, and unsatisfied only when none is.
///
/// # Arguments
/// * `wanted`    - Alternative sets, from `fontSetsOf` over every source.
/// * `available` - Every family the compiler will have for this compile.
function missingFamilies(wanted, available) {
	const have = new Set(available.map(famKey));
	const out = [];
	for (const set of wanted) {
		if (!set.length) continue;
		if (set.some(function (n) { return have.has(famKey(n)); })) continue;
		const label = set.join('" or "');
		if (out.indexOf(label) < 0) out.push(label);
	}
	return out;
}

/// Compile a gathered project to `fmt`, which is `'pdf'` or `'vector'`.
///
/// The argument carries CONTENTS, never a path to contents: `sources` and
/// `assets` are keyed by position in the compiler's in-memory shadow filesystem,
/// which exists only inside the wasm module.  Every byte in it was read on the
/// Rust side, through the OPFS edge, under the path jail and the per-account
/// namespace -- see `src/wasm/typst.rs`, which is the only thing that builds one
/// of these.  There is nothing here that could open a file if it tried.
///
/// # Arguments
/// * `p`   - `{ root, main, sources, assets, fonts, fontDirs, searched }`.
/// * `fmt` - `'pdf'` for the publishing path, `'vector'` for the live view.
async function compileProjectAs(p, fmt) {
	if (await packLocked()) {
		return { error: tt('typst.pack_locked') };
	}
	if (!p || !Array.isArray(p.sources) || !p.sources.length) {
		return { error: 'Nothing was gathered to compile.' };
	}
	let compiler;
	try {
		compiler = await getCompiler();
	} catch (e) {
		return { error: tt('typst.load_failed', { reason: (e && e.message ? e.message : e) }) };
	}

	// Fonts first, and refuse before compiling rather than after: a PDF handed
	// back and then disowned is a PDF somebody keeps.
	const fonts = (p.fonts || []).map(function (f) { return [String(f[0]), f[1]]; });
	const available = [];
	for (const f of _bundled) for (const n of familiesOf(f)) available.push(n);
	for (const f of fonts) for (const n of familiesOf(f[1])) available.push(n);
	const wanted = [];
	for (const s of p.sources) for (const set of fontSetsOf(s[1])) wanted.push(set);
	const missing = missingFamilies(wanted, available);
	if (missing.length) {
		// Where it looked, always -- and when it found nothing, the folders it looked
		// in rather than the root alone. The search starts at the compiled file's own
		// folder and works outward to the root, so naming the root (which this did
		// until seq 117) described neither where it looked nor where to put a font.
		const where = (p.searched || []).length ? p.searched : [String(p.root || 'the project root')];
		const dirs = (p.fontDirs || []).length
			? 'Fonts were looked for in ' + p.fontDirs.join(' and ') + '.'
			: 'No font directory was found: this compile looked for an "assets/fonts" and a '
				+ '"fonts" folder in ' + where.join(', then ') + ', and found neither.';
		return { error: 'This project asks for the font "' + missing.join('", and for "')
			+ '", which is not among the fonts available to compile it. Nothing was produced. '
			+ 'A missing family is not an error to Typst -- it substitutes another silently -- '
			+ 'so a PDF made without it would have different line breaks, different last lines '
			+ 'and a different page count from the one that prints, with nothing on screen to '
			+ 'say so. ' + dirs + ' Put the font file (.ttf, .otf or .ttc) in one of those and '
			+ 'compile again.' };
	}

	try {
		await useFonts(fonts);
		compiler.reset_shadow();
		const texts = {};
		for (const s of p.sources) {
			const path = String(s[0]);
			texts[path] = String(s[1]);
			if (compiler.add_source(path, texts[path]) === false) {
				return { error: 'The compiler would not accept the source ' + path + '.' };
			}
		}
		for (const a of (p.assets || [])) {
			if (compiler.map_shadow(String(a[0]), a[1]) === false) {
				return { error: 'The compiler would not accept the file ' + a[0] + '.' };
			}
		}
		const count = p.sources.length + (p.assets || []).length;
		// What a later `queryProject` will ask about. Recorded BEFORE the compile
		// rather than after it, so a compile that fails still leaves the compiler's
		// shadow filesystem and this name describing the same project.
		_lastMain = String(p.main);
		const ret = compiler.compile(String(p.main), undefined, fmt, DIAG_FULL);
		const out = extractPdf(ret);
		if (out && out.length > 4) {
			return fmt === 'vector' ? { vector: out } : { pdf: out };
		}
		const ctx = { texts: texts, count: count, root: String(p.root || 'the workspace root'),
				searched: (p.searched || []), single: false };
		return { error: explainDiags(ret, ctx) || tt('typst.no_pdf') };
	} catch (e) {
		return { error: tt('typst.compile_error', { reason: (e && e.message ? e.message : e) }) };
	}
}

/// Compile a gathered project to a PDF -- the publishing path, unchanged.
export async function compileProjectPdf(p) {
	return await compileProjectAs(p, 'pdf');
}

// ── Laying the pages out is not writing the document out ────────────────────
//
// Measured on the author's 281-page book, on the same warm compiler and the same
// layout: `compile → 'pdf'` is 1834-2069 ms and `compile → 'vector'` is 235-272 ms.
// WRITING THE PDF IS ABOUT EIGHT TIMES WHAT LAYING THE PAGES OUT COSTS. A watch loop
// that produced a PDF on every save would therefore spend seven eighths of its time
// making a file nobody is going to open, since the reader is looking at the screen.
//
// `vector` is typst.ts's own intermediate format (SIR), which the vendored renderer
// (`typst_ts_renderer_bg.wasm`, the same typst checkout -- see the version note in
// `www/js/typstwatch.js`) turns into SVG. The pages are the SAME layout from the SAME
// compiler with the SAME fonts, drawn as glyph outlines rather than as text, so the
// live view is the book and not an approximation of it. `dev/verify_typstwatch.mjs`
// proves that against poppler rather than asserting it.
//
// PDF stays the publishing path and is untouched: the Compile button still writes one,
// `file_show` still opens one, and export is unaffected.

// ── Asking the compiler ABOUT the document it has just laid out ─────────────
//
// The live view's section rail wants the document's headings, in order, with their
// levels. `TypstCompiler.query` answers exactly that and costs 6 ms on a small
// document and 9-14 ms on the author's 281-page book, because it runs against the
// layout comemo has already memoised rather than laying it out again.
//
// IT NEEDS NOTHING BUT THE MAIN PATH. The shadow filesystem is populated by
// `compileProjectAs` and is not cleared afterwards -- `reset_shadow` runs at the
// START of a compile -- so the last project compiled is still in there. Which is why
// `_lastMain` is kept: it is the only piece of the gathered project a query needs,
// and keeping the project itself would be holding a copy of the book on this heap for
// no reason.
//
// A QUERY IS NOT A COMPILE AND MUST NOT BECOME ONE. It is called from the watch loop
// in the same turn as the compile that produced the pages, never from a control the
// reader touched.

let _lastMain = '';            // the main path of the last project compiled

/// Ask the compiler about the document it last laid out.
///
/// Returns the parsed answer -- an array of elements as typst serialises them -- or
/// `null` when there is nothing to ask about, the selector is refused, or the answer
/// is not JSON. A refusal is not an error here: a rail that cannot be built is a rail
/// that is not shown, and nothing else in the view depends on it.
///
/// # Arguments
/// * `selector` - A typst selector, as `typst query` takes it: `heading`, `<label>`.
/// * `field`    - One field of each element, or nothing for all of them.
export async function queryProject(selector, field) {
	if (!_lastMain || !_compilerPromise) return null;
	try {
		const compiler = await getCompiler();
		const json = compiler.query(_lastMain, undefined, String(selector),
			field == null ? undefined : String(field));
		const out = JSON.parse(String(json));
		return Array.isArray(out) ? out : null;
	} catch (e) {
		return null;
	}
}

/// Compile a gathered project to typst.ts's vector format, for the live view.
///
/// Returns `{ vector: Uint8Array }` or `{ error: string }`, with the error composed
/// exactly as the PDF path composes it -- the same diagnostics, naming the same file
/// and line -- so a failed rebuild reads the same wherever it came from.
export async function compileProjectVector(p) {
	return await compileProjectAs(p, 'vector');
}

/// The compiler's wasm heap, in megabytes, or 0 before it has been built.
///
/// A wasm32 `WebAssembly.Memory` can GROW and can NEVER SHRINK, so this is the
/// high-water mark of everything compiled in this page so far rather than a reading
/// of what is live. That is the property the watch loop's budget rests on: a figure
/// that only ever goes up can be compared against a ceiling without sampling.
export function heapMB() {
	if (!_init || !_init.memory) return 0;
	return _init.memory.buffer.byteLength / 1048576;
}

// ── The driver the agent's `typst_compile` tool reaches ─────────
// The compiler was wired to a human's Compile button and to nothing
// else, so the tool registry had no Typst tool in it and a model
// asked to produce a PDF correctly answered that it could not.
// `window.DaimondTypst` is the one object the Rust side looks for
// (see `src/wasm/typst.rs`), and it exchanges CONTENTS AND BYTES
// only: source text comes in, PDF bytes go out, and every file touch
// stays in Rust where the OPFS path jail and the per-account
// namespace apply.  A project comes in the same way -- as the files
// themselves, gathered on the Rust side, keyed by positions in the
// compiler's in-memory filesystem.  Nothing here is ever given a
// path it could open.
//
// The memo lives in this module (`_compilerPromise`), so the 30 MB
// wasm is built once however it is reached -- the button's dynamic
// `import()` and this global resolve to the same module instance,
// because a module URL is evaluated once per document. The guard
// below is belt and braces for a second evaluation under a
// different URL, which would otherwise install a second compiler.
if (typeof window !== 'undefined' && !window.DaimondTypst) {
	window.DaimondTypst = {
		/// Compile a Typst source string, resolving `{ pdf }` or `{ error }`.
		/// It RESOLVES on failure rather than rejecting, so the compiler's own
		/// diagnostics reach the caller as the reason instead of as an exception.
		compile: function (source) { return compilePdf(String(source == null ? '' : source)); },
		/// Compile a project GATHERED IN RUST, resolving `{ pdf }` or `{ error }`.
		/// The object holds file contents and virtual shadow paths; it holds no
		/// path this side could open, which is how the OPFS jail stays the only
		/// way a byte gets in.
		compileProject: function (project) { return compileProjectPdf(project); },
		/// The same project, laid out but not written out: `{ vector }` or
		/// `{ error }`. What the live view draws, and what makes it affordable.
		compileProjectVector: function (project) { return compileProjectVector(project); },
		/// What the compiler will say ABOUT the document it last laid out -- the
		/// headings the live view's section rail is made of. It lays nothing out
		/// again: comemo hands back the layout it already has.
		queryProject: function (selector, field) { return queryProject(selector, field); },
		/// The compiler's wasm heap in MB, which never shrinks. The watch loop's
		/// budget is measured against this.
		heapMB: heapMB,
	};
	// The live view registers `window.DaimondTypstWatch`, which is the one object
	// `src/wasm/typst.rs` looks for when a compile finishes at the page's door. It
	// is loaded from HERE, beside the driver, for the same reason the driver is
	// loaded from `daimond.js`: a module nothing imports is a module nothing
	// installs, and a Rust side that cannot import would find nothing on `window`.
	// It costs a few kilobytes; the renderer wasm it needs is fetched lazily, on
	// the first live view, and a session that never compiles never pays for it.
	import('./typstwatch.js').catch(function () { /* no live view on this build */ });
}
