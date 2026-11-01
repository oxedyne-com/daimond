// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
// page-split: end imports
export let Wasm, init, DaimondApp, builtin_tools, qr_matrix, set_account_ns, heap_bytes,
	grow_on_purpose, install_panic_hook, compose_prompt,
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
	return await Wasm.read_file(path);
}

/// A file's raw BYTES, whole, with the same withdrawn-grant alarm. For a reader that must
/// not have them decoded as UTF-8 first: a message in ISO-8859-1 is not UTF-8.
export async function readRawBytes(path) {
	return await Wasm.read_bytes(path, 0, 4294967295);
}

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
	compose_prompt = w.compose_prompt;
	compose_prompt_for = w.compose_prompt_for;
	default_prompt = w.default_prompt;
	safety_clause = w.safety_clause;
	Sbj = w.Sbj;
} // page-split: end bind
