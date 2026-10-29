// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
// page-split: end imports
export let Wasm, init, DaimondApp, builtin_tools, qr_matrix, set_account_ns, heap_bytes,
	grow_on_purpose, install_panic_hook, set_workspace_dir, use_opfs_workspace, compose_prompt,
	compose_prompt_for, default_prompt, safety_clause, Sbj; // page-split: hoisted
// page-split: import 0 (in js/daimond.js)

/// Read a file's BYTES, for anything that is not a model.
///
/// `run_tool('file_read')` is a MODEL-FACING RENDERING, not a file reader: it
/// prefixes every line with its number and a TAB, says when it truncates, and
/// wraps anything under an untrusted path in an envelope. Handed to something
/// that treats the result as the file, every line gains `1\t`, `2\t`, and so on.
///
/// This has shipped as a live bug FOUR times, each found only after the last was
/// written down: the Doc panel showed and then SAVED the numbered rendering; the
/// Email panel read every message header through it and showed "(unknown)"; the
/// `conductor` -> `daimon` prompt migration wrote the numbered text into the new
/// file; and the Web panel rendered an agent-written page with the numbers in it.
/// The rule is one line long and keeps being missed, so it now has one function
/// to be missed in.
///
/// Use `run_tool('file_read')` ONLY to ask a model-shaped question — chiefly "does
/// this file exist", where the answer is the error prefix and not the content.
export async function readBytes(path) {
	try { return await Wasm.read_file(path); }
	catch (e) { noteFolderLost(e); throw e; }
}

/// A file's raw BYTES, whole, with the same withdrawn-grant alarm. For a reader that must
/// not have them decoded as UTF-8 first: a message in ISO-8859-1 is not UTF-8.
export async function readRawBytes(path) {
	try { return await Wasm.read_bytes(path, 0, 4294967295); }
	catch (e) { noteFolderLost(e); throw e; }
}

// ── A withdrawn folder grant, on the paths the tool registry never sees ──
//
// The browser can take a real folder away at any moment, and every call that
// touches it then fails while the app goes on naming the folder. `src/tools.rs`
// catches that at `ToolRegistry::dispatch`, which is the single door EVERY tool
// result passes through, and raises `daimond:folder-lost`; the Workspace panel
// listens for it (`handlePermissionLoss`) and drops to the sandbox.
//
// The panel's own reads do not go through that door. `Wasm.read_file`,
// `Wasm.read_bytes` and the viewer's probes are called straight from here, so a
// revoked grant broke the panel's own operations and raised nothing at all: the
// alarm went off only if an AGENT happened to run a file tool afterwards.
//
// So the same test is applied where those calls fail, and the SAME EVENT is
// raised -- not a second copy of the handler, which stays the one place that
// decides what to do about it.
//
// THE PROPER FIX IS IN `src/wasm/entry.rs`, where `read_file` and its siblings
// could raise the event themselves and this pair would not need to exist. Until
// then the predicate lives in two languages and can drift; `dev/verify_joinedup.mjs`
// compares them to the character so that it cannot drift quietly.

/// A file, folder or cloud copy, drawn as an outline icon rather than an emoji.
///
/// The emoji were a colour picture each platform drew its own way, and the one
/// thing in a list of names that was not type. The icon carries no text, so a
/// row's `textContent` is its name alone -- what the file filter and every
/// verifier that reads a row match against.
var KIND_PATHS = {
	dir:   '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
	file:  '<path d="M13 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V10z"/><path d="M13 3v6h6"/>',
	cloud: '<path d="M7 18a4 4 0 01-.6-7.96A6 6 0 0118 9a4.5 4.5 0 01-.5 9z"/>',
};
export function kindIcon(kind) {
	var span = document.createElement('span');
	span.className = 'kind-ic kind-' + kind;
	span.setAttribute('aria-hidden', 'true');
	span.innerHTML = '<svg class="ic" viewBox="0 0 24 24">' + (KIND_PATHS[kind] || KIND_PATHS.file) + '</svg>';
	return span;
}
/// The same treatment for a file row's ACTIONS, not its kind: the paperclip
/// that attaches a row to the open focus, and the pencil that renames one.
/// Drawn as outline icons for the reason `KIND_PATHS` was -- a coloured
/// picture each platform drew its own way, on a row otherwise typed in the
/// theme's own ink (QA round 2, minor 7). Every skin, like the kind icons.
export var ACTION_ICONS = {
	attach: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.19 9.19a1 1 0 01-1.41-1.41l8.48-8.49"/></svg>',
	edit:   '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
};
/// Fill `el` with the diamond mark and then `text`. The mark was `◈`, a glyph
/// each face drew differently and none drew as the mark; the image is the mark.
export function markName(el, text) {
	el.textContent = '';
	var img = document.createElement('img');
	img.className = 'mark-ic';
	img.src = 'assets/daimond_mark.svg';
	img.alt = '';
	el.appendChild(img);
	el.appendChild(document.createTextNode(text));
	return el;
}
/// Fill `el` with a kind's icon and then the name, as text.
export function kindName(el, kind, name) {
	el.textContent = '';
	el.appendChild(kindIcon(kind));
	el.appendChild(document.createTextNode(name));
	return el;
}

/// A path drawn in one line as icon, muted folder and name, where the folder gives way
/// first and the name is cut only when it alone is wider than the row (UNBLOCK-13): a
/// long folder used to end the line in "…" and cut the file's own name, the one part
/// the reader needs. The layout is `.pn`'s, in files.css.
export function pathName(el, kind, pre, name) {
	el.textContent = '';
	el.classList.add('pn');
	el.appendChild(kindIcon(kind));
	if (pre) {
		var i = document.createElement('i');
		i.textContent = pre;
		el.appendChild(i);
	}
	var fn = document.createElement('span');
	fn.className = 'fn';
	fn.textContent = name;
	el.appendChild(fn);
	return el;
}

/// Whether a failed direct file call failed BECAUSE the open folder was taken away.
///
/// The mirror of `folder_loss_reported` in `src/tools.rs`: the workspace root is a
/// real folder, and the browser reported the failure as a `NotAllowedError`. A
/// missing file, or a path outside the jail, is an ordinary error and must not
/// cost the user their folder.
///
/// THE WHOLE NAME, not `NotAllowed`. The Rust side reads `DOMException.name` and
/// compares it whole; a substring of it is what turned a search HIT into a revoked
/// grant on 2026-09-13 and cost the user their folder mid-turn. Here there is no
/// name to read -- `to_js_err` rejects with a string -- so the test is still over
/// text, but only over text a call THREW.
///
/// # Arguments
/// * `e` - Whatever the rejected call threw. `to_js_err` rejects with a string,
///   so both a string and an `Error` carrying one have to read the same.
function folderWasLost(e) {
	try { if (Wasm.workspace_mode() !== 'folder') return false; }
	catch (err) { return false; }			// an engine too old to say is not a loss
	var text = (e && typeof e === 'object' && e.message) ? String(e.message) : String(e);
	return text.indexOf('NotAllowedError') >= 0;
}

/// Raise `daimond:folder-lost` when `e` says the grant is gone. True if it did.
///
/// Idempotent by construction: `handlePermissionLoss` returns at once once the
/// folder has been let go, so several calls failing on the one withdrawal say it
/// once between them.
export function noteFolderLost(e) {
	if (!folderWasLost(e)) return false;
	try { window.dispatchEvent(new CustomEvent('daimond:folder-lost')); }
	catch (err) { /* a window that cannot dispatch has nothing listening either */ }
	return true;
}
// page-split: import 1 (in js/daimond.js)
// page-split: import 2 (in js/daimond.js)


export function bindWasm(w) { // page-split: bind
	Wasm = w.Wasm;
	init = w.init;
	DaimondApp = w.DaimondApp;
	builtin_tools = w.builtin_tools;
	qr_matrix = w.qr_matrix;
	set_account_ns = w.set_account_ns;
	heap_bytes = w.heap_bytes;
	grow_on_purpose = w.grow_on_purpose;
	install_panic_hook = w.install_panic_hook;
	set_workspace_dir = w.set_workspace_dir;
	use_opfs_workspace = w.use_opfs_workspace;
	compose_prompt = w.compose_prompt;
	compose_prompt_for = w.compose_prompt_for;
	default_prompt = w.default_prompt;
	safety_clause = w.safety_clause;
	Sbj = w.Sbj;
} // page-split: end bind
