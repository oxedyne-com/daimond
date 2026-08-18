//! The Office document edge: a `.docx` read into prose the panel and the model can both use.
//!
//! # Why this returns Markdown rather than HTML
//!
//! It would be easy to hand back HTML -- `fe2o3_text::doc::html` renders the same tree -- and it
//! would be worse in three ways at once.
//!
//! The document being read is **a stranger's**. It arrived by mail, or from a share, or the user
//! dragged it in; nothing about it is ours. HTML from a stranger reaching this origin is the risk
//! `viewer.js` spends its opening comment on, and the answer there is a frame with
//! `sandbox="allow-scripts"` and never `allow-same-origin`. Markdown needs none of that, because
//! `DaimondRender.md` already sanitises -- it drops `script style iframe form input button svg`
//! whole -- and it is the sanitiser this app already trusts for agent-written prose.
//!
//! It is also the form the *model* reads best. `## Findings` says what it is; `<h2>` has to be
//! explained, in every request, forever. And it means the Doc panel and `file_read` render the same
//! bytes by the same path, so a user and a model looking at one document are looking at one document.
//!
//! # It says what it did not draw, in PARTS rather than in a sentence
//!
//! A reading view that quietly dropped a chart would be lying by omission, and the number is the
//! whole of the information: a reader told only that *something* is missing has been told that the
//! reader cannot be trusted, and nothing else. So `undrawn` carries a kind and a count for each --
//! `[{ kind: "TextBox", n: 3 }, { kind: "Chart", n: 1 }]` -- and the panel composes the sentence.
//!
//! Handing over the finished English would have been shorter by twenty lines and wrong.
//! `viewer.js` says of itself that every user-visible string in it goes through `opts.t`, "so the
//! file holds no English of its own that a translation pass cannot reach", and a phrase built in
//! Rust and printed verbatim is exactly the English a translation pass cannot reach. The MODEL is
//! addressed in English by every other tool note and keeps the sentence; the USER is not.

use crate::wasm::to_js_err;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_file::office::docx;
use oxedyne_fe2o3_file::office::edit::Find;
use oxedyne_fe2o3_file::office::odf;
use oxedyne_fe2o3_file::office::sheet::Ref;
use oxedyne_fe2o3_file::office::xlsx;
use oxedyne_fe2o3_text::doc::markdown;

use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

/// Reads a `.docx` into the prose it holds.
///
/// Answers an object: `{ markdown, undrawn, macros, tracked }`. `undrawn` is `null` where everything
/// in the document reached the page, and a ready-made phrase where it did not.
#[wasm_bindgen]
pub fn office_read_doc(bytes: &[u8], media: &str) -> Result<JsValue, JsValue> {
	// One door for both vocabularies. What a reader wants out of a text document is the same thing
	// whichever it was written in, and the neutral tree is where the two meet -- which is the whole
	// point of having one.
	if media == "Odt" {
		let r = odf::text::read(bytes).map_err(to_js_err)?;
		let out = js_sys::Object::new();
		set(&out, "markdown", &JsValue::from_str(&markdown::write::render(&r.doc)))?;
		let undrawn = js_sys::Array::new();
		if r.images > 0 {
			let one = js_sys::Object::new();
			set(&one, "kind", &JsValue::from_str("image"))?;
			set(&one, "n", &JsValue::from_f64(r.images as i32 as f64))?;
			undrawn.push(&one);
		}
		set(&out, "undrawn", &undrawn.into())?;
		set(&out, "macros", &JsValue::from_bool(r.macros))?;
		set(&out, "tracked", &JsValue::from_f64(0.0))?;
		set(&out, "blocks", &JsValue::from_f64(r.doc.blocks.len() as i32 as f64))?;
		return Ok(out.into());
	}
	let r = docx::read(bytes).map_err(to_js_err)?;
	let out = js_sys::Object::new();
	let md = markdown::write::render(&r.doc);
	set(&out, "markdown", &JsValue::from_str(&md))?;
	let undrawn = js_sys::Array::new();
	for (kind, n) in &r.undrawn {
		let one = js_sys::Object::new();
		set(&one, "kind", &JsValue::from_str(name_of(*kind)))?;
		set(&one, "n", &JsValue::from_f64(*n as i32 as f64))?;
		undrawn.push(&one);
	}
	set(&out, "undrawn", &undrawn.into())?;
	set(&out, "macros", &JsValue::from_bool(r.macros))?;
	// `i32` and not `usize`: a `u64` crosses this boundary as a `BigInt`, which every arithmetic
	// operation on the JS side then refuses to mix with a number.
	set(&out, "tracked", &JsValue::from_f64(r.tracked as i32 as f64))?;
	set(&out, "blocks", &JsValue::from_f64(r.doc.blocks.len() as i32 as f64))?;
	Ok(out.into())
}

/// Reads a `.xlsx` into the sheets it holds.
///
/// Answers `{ sheets: [{ name, cols, rows, formulas, cut }], macros, missing }`, where each sheet's
/// `rows` is an array of arrays of strings -- the values AS STORED, which is what the person who
/// wrote the file saw. Nothing is recalculated; see `oxedyne_fe2o3_file::office::sheet` for why that
/// is the correct answer and not a missing feature.
///
/// Each sheet is cut to a rectangle before it crosses the boundary. A sheet may be a hundred
/// thousand rows and the panel can draw a screenful, so sending the rest would cost the copy, the
/// JS heap and the DOM for something nobody looks at. `cut` says whether it happened, and the panel
/// says so on screen -- a silent truncation reads as a corrupt file.
#[wasm_bindgen]
pub fn office_read_sheet(
	bytes:	&[u8],
	media:	&str,
	max_rows:	u32,
	max_cols:	u32,
)
	-> Result<JsValue, JsValue>
{
	use oxedyne_fe2o3_file::office::sheet::{Range, Ref, col_name};

	// The same door for both, for the same reason as `office_read_doc`.
	let (book, macros, missing) = match media {
		"Ods"	=> {
			let r = odf::sheet::read(bytes).map_err(to_js_err)?;
			(r.book, r.macros, Vec::new())
		}
		_	=> {
			let r = xlsx::read(bytes).map_err(to_js_err)?;
			(r.book, r.macros, r.missing)
		}
	};
	let out = js_sys::Object::new();
	let sheets = js_sys::Array::new();
	for s in &book.sheets {
		let one = js_sys::Object::new();
		set(&one, "name", &JsValue::from_str(&s.name))?;
		let (rows, cols) = s.size();
		set(&one, "rows", &JsValue::from_f64(rows as i32 as f64))?;
		set(&one, "cols", &JsValue::from_f64(cols as i32 as f64))?;
		let keep_rows = (rows as u32).min(max_rows.max(1));
		let keep_cols = (cols as u32).min(max_cols.max(1));
		set(&one, "cut", &JsValue::from_bool(
			keep_rows as usize != rows || keep_cols as usize != cols))?;
		// The column letters, so the grid a person reads is addressed the way a person addresses it
		// -- and the way `sheet_read` takes a range, which is the same vocabulary.
		let heads = js_sys::Array::new();
		for c in 0..keep_cols {
			heads.push(&JsValue::from_str(&col_name(c)));
		}
		set(&one, "heads", &heads.into())?;
		let grid = js_sys::Array::new();
		let mut formulas = 0usize;
		if keep_rows > 0 && keep_cols > 0 {
			let window = s.window(&Range {
				from:	Ref { col: 0, row: 0 },
				to:	Ref { col: keep_cols - 1, row: keep_rows - 1 },
			});
			for line in &window {
				let js_line = js_sys::Array::new();
				for cell in line {
					if cell.formula.is_some() {
						formulas += 1;
					}
					js_line.push(&JsValue::from_str(&cell.value.show()));
				}
				grid.push(&js_line.into());
			}
		}
		set(&one, "cells", &grid.into())?;
		set(&one, "formulas", &JsValue::from_f64(formulas as i32 as f64))?;
		sheets.push(&one);
	}
	set(&out, "sheets", &sheets.into())?;
	set(&out, "macros", &JsValue::from_bool(macros))?;
	let gone = js_sys::Array::new();
	for name in &missing {
		gone.push(&JsValue::from_str(name));
	}
	set(&out, "missing", &gone.into())?;
	Ok(out.into())
}

/// Writes Markdown out as the bytes of a `.docx`.
///
/// The app action behind "save as Word". **The model does not emit document XML and there is no tool
/// that lets it**: it writes Markdown, which it does well, and the conversion from there is
/// deterministic code. Every design where the model emits the format puts it in the position of
/// getting a file format right, which it will sometimes not; this removes the failure class rather
/// than mitigating it.
#[wasm_bindgen]
pub fn office_write_docx(md: &str) -> Result<Vec<u8>, JsValue> {
	let doc = markdown::parse(md).map_err(to_js_err)?;
	let (bytes, _left) = docx::write(&doc).map_err(to_js_err)?;
	Ok(bytes)
}

/// Writes Markdown out as the bytes of whichever Office format is named.
///
/// The one door for "save as a document", and the reason there is one rather than six is the argument
/// `office_write_docx` already makes: **the model never emits document XML**. It writes Markdown, the
/// conversion is deterministic code, and the failure class where a model gets a file format slightly
/// wrong does not exist rather than being mitigated.
///
/// What each format makes of the same prose differs, and the difference is not a loss: a `.docx` and an
/// `.odt` take the whole document; a `.pptx` and an `.odp` split it at its headings into slides; a
/// `.xlsx` and an `.ods` take its TABLES, one sheet each, because a spreadsheet built out of paragraphs
/// would be a spreadsheet with one long column in it.
#[wasm_bindgen]
pub fn office_write(md: &str, media: &str) -> Result<Vec<u8>, JsValue> {
	use oxedyne_fe2o3_file::office::deck::Deck;
	use oxedyne_fe2o3_file::office::pptx;
	use oxedyne_fe2o3_file::office::sheet::Book;
	use oxedyne_fe2o3_file::office::xlsx;

	let doc = markdown::parse(md).map_err(to_js_err)?;
	let bytes = match media {
		"Docx"	=> docx::write(&doc).map_err(to_js_err)?.0,
		"Odt"	=> odf::text::write(&doc).map_err(to_js_err)?.0,
		"Xlsx"	=> xlsx::write(&Book::from_doc(&doc)).map_err(to_js_err)?,
		"Ods"	=> odf::sheet::write(&Book::from_doc(&doc)).map_err(to_js_err)?,
		"Pptx"	=> pptx::write(&Deck::from_doc(&doc)).map_err(to_js_err)?.0,
		"Odp"	=> odf::slides::write(&Deck::from_doc(&doc)).map_err(to_js_err)?.0,
		other	=> return Err(to_js_err(err!(
			"'{}' is not a document format this writes. It writes Docx, Odt, Xlsx, Ods, Pptx and \
			Odp.", other; Invalid, Input, Unimplemented))),
	};
	Ok(bytes)
}

/// Replaces text in a document that already exists, leaving every other byte of it alone.
///
/// `edits` is JSON: `[{"find": "...", "replace": "...", "nth": 1}]`, `nth` optional and counted from
/// one through the whole document. **An unmatched `find` is an error naming the string** and NOTHING is
/// written -- a caller told "the document was edited" has no way to discover that one of its four
/// replacements did nothing, so a silent no-op would be reported to the user as a change.
///
/// Only `.docx` and `.odt`. A deck is not edited here and it is not an oversight: a slide is a position
/// on a canvas, and changing the words without knowing the geometry puts text over other text. A
/// spreadsheet is edited by `office_edit_sheet`, whose unit is a cell.
#[wasm_bindgen]
pub fn office_edit_doc(bytes: &[u8], media: &str, edits: &str) -> Result<Vec<u8>, JsValue> {
	let asks = finds_of(edits)?;
	let out = match media {
		"Odt"	=> odf::text::edit(bytes, &asks).map_err(to_js_err)?.bytes,
		"Docx"	=> docx::edit::edit(bytes, &asks).map_err(to_js_err)?.bytes,
		other	=> return Err(to_js_err(err!(
			"'{}' is not a format whose text can be edited in place. Word and OpenDocument text \
			documents can; a presentation cannot, because a slide is a position on a canvas and \
			changing its words without knowing the geometry puts text over other text.", other;
			Invalid, Input, Unimplemented))),
	};
	Ok(out)
}

/// Writes cells into a spreadsheet that already exists.
///
/// `edits` is JSON: `[{"sheet": "Sheet1", "ref": "B2", "value": "3.5"}]`, or `"formula": "=B2*C2"` in
/// place of the value. `sheet` may be left out for the first sheet. A `ref` outside the sheet is
/// written rather than refused -- the sheet grows -- but a SHEET that is not there is an error naming
/// what sheets the workbook has.
#[wasm_bindgen]
pub fn office_edit_sheet(bytes: &[u8], media: &str, edits: &str) -> Result<Vec<u8>, JsValue> {
	use oxedyne_fe2o3_file::office::xlsx;

	let asks = cells_of(edits)?;
	let out = match media {
		"Ods"	=> {
			let sets: Vec<odf::sheet::Set> = asks.into_iter()
				.map(|(sheet, at, value, formula)| odf::sheet::Set { sheet, at, value, formula })
				.collect();
			odf::sheet::edit(bytes, &sets).map_err(to_js_err)?.bytes
		}
		"Xlsx"	=> {
			let sets: Vec<xlsx::edit::Set> = asks.into_iter()
				.map(|(sheet, at, value, formula)| xlsx::edit::Set { sheet, at, value, formula })
				.collect();
			xlsx::edit::edit(bytes, &sets).map_err(to_js_err)?.bytes
		}
		other	=> return Err(to_js_err(err!(
			"'{}' is not a spreadsheet, so it has no cells to write.", other;
			Invalid, Input, Unimplemented))),
	};
	Ok(out)
}

/// The find-and-replace edits a JSON array asks for.
///
/// The browser's own parser rather than a second one written here: this JSON carries a user's prose,
/// and a hand-rolled scan would be a second unescaping implementation to keep exactly in step with the
/// first.
fn finds_of(edits: &str) -> Result<Vec<Find>, JsValue> {
	let list = array_of(edits, "an edit")?;
	let mut out = Vec::new();
	for one in list.iter() {
		let find = str_of(&one, "find").unwrap_or_default();
		if find.is_empty() {
			return Err(to_js_err(err!(
				"An edit carries no 'find', so there is nothing to look for."; Invalid, Input)));
		}
		out.push(Find {
			find,
			replace:	str_of(&one, "replace").unwrap_or_default(),
			// A zero would ask for an occurrence before the first, which the edit itself refuses in
			// terms that say so; it is not silently turned into "every".
			nth:	num_of(&one, "nth").map(|n| n as usize),
		});
	}
	if out.is_empty() {
		return Err(to_js_err(err!("No edits were given, so there is nothing to do."; Invalid, Input)));
	}
	Ok(out)
}

/// The cells a JSON array asks to be written.
fn cells_of(edits: &str) -> Result<Vec<(Option<String>, Ref, Option<String>, Option<String>)>, JsValue> {
	let list = array_of(edits, "a cell")?;
	let mut out = Vec::new();
	for one in list.iter() {
		let at = str_of(&one, "ref").unwrap_or_default();
		let at = Ref::parse(&at).map_err(to_js_err)?;
		let value = str_of(&one, "value");
		let formula = str_of(&one, "formula");
		if value.is_none() && formula.is_none() {
			return Err(to_js_err(err!(
				"The write to {} carries neither a value nor a formula, so it says nothing. To empty \
				a cell, give it a value of \"\".", at.name(); Invalid, Input)));
		}
		out.push((str_of(&one, "sheet").filter(|s| !s.trim().is_empty()), at, value, formula));
	}
	if out.is_empty() {
		return Err(to_js_err(err!("No cells were given, so there is nothing to write."; Invalid, Input)));
	}
	Ok(out)
}

/// The JSON as the array of objects it has to be.
fn array_of(json: &str, what: &str) -> Result<js_sys::Array, JsValue> {
	let val = js_sys::JSON::parse(json).map_err(|_| to_js_err(err!(
		"The edits are not JSON. They are a list of objects, one for each {}.", what;
		Invalid, Input)))?;
	match val.dyn_into::<js_sys::Array>() {
		Ok(a)	=> Ok(a),
		Err(_)	=> Err(to_js_err(err!(
			"The edits are not a LIST. They are a JSON array of objects, one for each {}.", what;
			Invalid, Input))),
	}
}

/// One string property of an object, absent where it is not a string.
fn str_of(obj: &JsValue, key: &str) -> Option<String> {
	js_sys::Reflect::get(obj, &JsValue::from_str(key)).ok().and_then(|v| v.as_string())
}

/// One number property of an object.
fn num_of(obj: &JsValue, key: &str) -> Option<f64> {
	js_sys::Reflect::get(obj, &JsValue::from_str(key)).ok().and_then(|v| v.as_f64())
}

/// What a document written from this Markdown would leave out, in PARTS, or nothing.
///
/// Asked before the write rather than after, so a caller can warn before the file exists rather than
/// explain after it does.
///
/// # It answers in parts and not in a sentence, and that is not a style preference
///
/// This used to compose the finished English -- *"1 image is not carried into the document: cover.png"*
/// -- which is exactly the mistake `office_read_doc` was built to avoid, twenty lines above. `viewer.js`
/// says of itself that every user-visible string in it goes through `opts.t`, "so the file holds no
/// English of its own that a translation pass cannot reach", and a phrase built in Rust and printed
/// verbatim is precisely the English a translation pass cannot reach. So `undrawn` carries a kind and a
/// count and the panel composes the sentence, and this now does the same: `[{ kind, n, names }]`.
///
/// One export kept the rule and its sibling broke it, which is what happens when the rule lives in a
/// comment rather than in the shape of the answer.
///
/// `names` is the source each image was written with -- a path out of the user's own Markdown, not
/// English -- so it passes through as it is, and a caller that wants to say *which* file has it.
#[wasm_bindgen]
pub fn office_write_left(md: &str, media: &str) -> Result<JsValue, JsValue> {
	use oxedyne_fe2o3_file::office::deck::Deck;
	use oxedyne_fe2o3_file::office::pptx;

	let doc = markdown::parse(md).map_err(to_js_err)?;
	// A spreadsheet has no `Left` of its own: what it leaves out is everything in the document that is
	// not a table, which is a different question and one `office_write`'s own note answers.
	let (images, notes) = match media {
		"Docx"	=> (docx::write(&doc).map_err(to_js_err)?.1.images, 0),
		"Odt"	=> (odf::text::write(&doc).map_err(to_js_err)?.1.images, 0),
		"Pptx"	=> {
			let left = pptx::write(&Deck::from_doc(&doc)).map_err(to_js_err)?.1;
			(left.images, left.notes)
		}
		"Odp"	=> {
			let left = odf::slides::write(&Deck::from_doc(&doc)).map_err(to_js_err)?.1;
			(left.images, left.notes)
		}
		"Xlsx" | "Ods"	=> (Vec::new(), 0),
		other	=> return Err(to_js_err(err!(
			"'{}' is not a document format this writes, so there is nothing to say about what it \
			would leave out.", other; Invalid, Input, Unimplemented))),
	};
	if images.is_empty() && notes == 0 {
		return Ok(JsValue::NULL);
	}
	let out = js_sys::Array::new();
	if !images.is_empty() {
		let one = js_sys::Object::new();
		set(&one, "kind", &JsValue::from_str("image"))?;
		// `i32` and not `usize`, for the reason `office_read_doc` gives: a `u64` crosses this boundary
		// as a `BigInt`, which every arithmetic operation on the JS side then refuses to mix.
		set(&one, "n", &JsValue::from_f64(images.len() as i32 as f64))?;
		let names = js_sys::Array::new();
		for name in &images {
			names.push(&JsValue::from_str(name));
		}
		set(&one, "names", &names.into())?;
		out.push(&one);
	}
	if notes > 0 {
		let one = js_sys::Object::new();
		set(&one, "kind", &JsValue::from_str("notes"))?;
		set(&one, "n", &JsValue::from_f64(notes as i32 as f64))?;
		set(&one, "names", &js_sys::Array::new().into())?;
		out.push(&one);
	}
	Ok(out.into())
}

/// The name a kind travels under, which is the key the panel looks its wording up by.
///
/// Written out rather than derived from `Debug`, because a name a translation file is keyed on is
/// part of the interface and must not change because somebody renamed a variant.
fn name_of(kind: docx::read::Undrawable) -> &'static str {
	use docx::read::Undrawable as U;
	match kind {
		U::Image	=> "image",
		U::Chart	=> "chart",
		U::Diagram	=> "diagram",
		U::TextBox	=> "textbox",
		U::Object	=> "object",
		U::Equation	=> "equation",
		U::Footnote	=> "footnote",
		U::Endnote	=> "endnote",
		U::Comment	=> "comment",
	}
}

/// Sets one property on an object, turning a failed set into a rejection rather than dropping it.
fn set(obj: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
	match js_sys::Reflect::set(obj, &JsValue::from_str(key), value) {
		Ok(_)	=> Ok(()),
		Err(e)	=> Err(e),
	}
}
