/* ============================================================
   Daimond — in-browser Typst compiler (Stage 4b)
   ------------------------------------------------------------
   A thin, self-hosted wrapper over the Typst wasm compiler
   (typst.ts web-compiler, vendored under www/vendor/typst/).
   It compiles a `.typ` source string to a PDF (Uint8Array)
   entirely in the browser — no server, no CDN.

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

let _compilerPromise = null;   // memoised compiler build

/// Build (once) and return the Typst compiler with its fonts
/// loaded.  Subsequent calls reuse the same instance.
function getCompiler() {
	if (_compilerPromise) return _compilerPromise;
	_compilerPromise = (async function () {
		const mod = await import(GLUE.href);
		// Initialise the wasm module from the vendored path.
		await mod.default(WASM);
		const builder = new mod.TypstCompilerBuilder();
		// No external file/package access is needed: sources are
		// injected as shadow files, so a dummy access model is fine.
		builder.set_dummy_access_model();
		for (const name of FONTS) {
			const url = new URL('fonts/' + name, VENDOR);
			const resp = await fetch(url);
			if (!resp.ok) {
				throw new Error('Typst: font fetch failed for ' + name + ' (' + resp.status + ')');
			}
			const buf = await resp.arrayBuffer();
			await builder.add_raw_font(new Uint8Array(buf));
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

/// Compile a Typst source string to a PDF.
///
/// Returns `{ pdf: Uint8Array }` on success, or `{ error: string }`
/// when the compiler reports diagnostics or produces no bytes.
export async function compilePdf(source) {
	let compiler;
	try {
		compiler = await getCompiler();
	} catch (e) {
		return { error: tt('typst.load_failed', { reason: (e && e.message ? e.message : e) }) };
	}
	try {
		// Start from a clean shadow filesystem each time.
		compiler.reset_shadow();
		compiler.add_source(MAIN, source);
		const ret = compiler.compile(MAIN, undefined, 'pdf', DIAG_FULL);
		const pdf = extractPdf(ret);
		if (pdf && pdf.length > 4) {
			return { pdf: pdf };
		}
		const diag = diagText(ret);
		return { error: diag || tt('typst.no_pdf') };
	} catch (e) {
		return { error: tt('typst.compile_error', { reason: (e && e.message ? e.message : e) }) };
	}
}

// ── The driver the agent's `typst_compile` tool reaches ─────────
// The compiler was wired to a human's Compile button and to nothing
// else, so the tool registry had no Typst tool in it and a model
// asked to produce a PDF correctly answered that it could not.
// `window.DaimondTypst` is the one object the Rust side looks for
// (see `src/wasm/typst.rs`), and it exchanges STRINGS and BYTES
// only: the source comes in, PDF bytes go out, and every file touch
// stays in Rust where the OPFS path jail and the per-account
// namespace apply.
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
	};
}
