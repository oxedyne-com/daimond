/* ============================================================
   Test — how typst.js explains a compile failure that names a
   file the project gather never hands over (UNBLOCK-25).
   ------------------------------------------------------------
   A .docx in an image() call is not a missing file: it is a kind
   of file typst cannot place, and saying "it was not among the
   files gathered" sent the daimon hunting for a path that was
   right all along. A BMP that is really absent still gets the
   gathered-files message, since a BMP is gathered and converted.
   ============================================================ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { explainDiag } from './typst.js';

const ctx = (text) => ({
	texts: { '/book.typ': text }, count: 3, root: 'book', searched: ['book'], single: false,
});

test('a non-image extension gets its own diagnostic', () => {
	const text = '#image("letter.docx")';
	const d = { path: '/book.typ', range: '0:7-0:20', severity: 'error',
		message: 'failed to load file (access denied)' };
	const out = explainDiag(d, ctx(text));
	assert.match(out, /"letter\.docx" is a \.docx file, which typst cannot read or place/);
	assert.doesNotMatch(out, /not among the/);
});

test('a missing BMP is still a missing file', () => {
	const text = '#image("scan.bmp")';
	const d = { path: '/book.typ', range: '0:7-0:17', severity: 'error',
		message: 'failed to load file (access denied)' };
	const out = explainDiag(d, ctx(text));
	assert.match(out, /not among the 3 files gathered/);
});
