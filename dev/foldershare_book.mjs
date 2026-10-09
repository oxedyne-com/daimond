// The book `dev/verify_foldershare.mjs` shares, generated rather than borrowed.
//
// THE FIXTURE WAS ONCE THE OWNER'S OWN BOOK, read live from `~/usr/books`. On about
// 1 October 2026 the book moved into an archive folder, its `assets` link broke on the
// way, and the verifier exited 2 for a week with nothing wrong in the app. A verifier
// that depends on where somebody keeps their writing is a verifier with an expiry date,
// so the book is now built here, under the run's scratch directory, in the shape the
// checks lean on and nothing more:
//
//   - well over a hundred files once symlinks are followed, most of them text, some
//     nested two directories down, so the walk and the inline budgets have work to do;
//   - an `assets` SYMLINK to a tree outside the book, reached from two places (the top
//     and an archived snapshot), which is what the walk's ancestor-chain guard is for;
//   - font faces under `assets/fonts/`, at least one far over the 128 KiB inline
//     ceiling and one small enough to ride inline, all of them real fonts typst loads;
//   - real PNGs under `assets/png/`, at least one over the inline ceiling, which typst
//     refuses by name when it is missing;
//   - five compiled PDFs (the built-in ignore floor), an `archive/` tree and font zips
//     (the book's `.gitignore`), and a `revision/` directory (its `.oreignore`);
//   - `onthearche.typ` and `chap_practice.typ`, the document and its chapter, the
//     chapter well over a thousand characters.
//
// DETERMINISTIC. Every byte comes from a seeded generator or a fixed source file, so two
// runs share the same book and a failure is reproducible.
//
// THE FONTS ARE BORROWED, and the only thing that is. The small face is the repository's
// own (`dev/fixtures/typstproj`); the large faces are the DejaVu and Liberation families
// that ship with every Linux the browsers here run on. A box without them is told so by
// name, rather than run against a book with no font over the ceiling.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SMALL_FACE = path.join(HERE, 'fixtures/typstproj/books/assets/fonts/Radley-Regular.ttf');
const BIG_FACES = [							// family, then the files that make it
	['DejaVu Serif', [
		'/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
		'/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
	]],
	['Liberation Serif', [
		'/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
		'/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf',
		'/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf',
	]],
];

/// mulberry32: small, seeded, and the same on every machine.
function rng(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}

/// A real RGB PNG of `w` x `h` noise. Noise does not compress, so the file's size is
/// roughly `3wh` bytes and lands where it is asked to, either side of the ceiling.
function png(w, h, seed) {
	const r = rng(seed);
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		const row = y * (w * 3 + 1);
		raw[row] = 0;							// filter: none
		for (let i = 1; i <= w * 3; i++) raw[row + i] = (r() * 256) | 0;
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const WORDS = ('the a of and to in that it is was for on with as by at from this be '
	+ 'practice order fabric mind life world body breath silence form measure light '
	+ 'path season house river stone hand voice field gift memory return question '
	+ 'patience kinship work rest gathering making keeping listening attention').split(' ');

function prose(r, chars) {
	let out = '';
	while (out.length < chars) {
		const n = 8 + ((r() * 14) | 0);
		const ws = [];
		for (let i = 0; i < n; i++) ws.push(WORDS[(r() * WORDS.length) | 0]);
		const s = ws.join(' ');
		out += s.charAt(0).toUpperCase() + s.slice(1) + '.' + (r() < 0.2 ? '\n\n' : ' ');
	}
	return out;
}

function put(p, data) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, data);
}

/// Build the book under `root` (emptied first) and answer where it is and which font
/// family a document should ask for. Throws, naming what is missing, on a box with no
/// font face over the inline ceiling.
export function buildBook(root) {
	fs.rmSync(root, { recursive: true, force: true });
	const r = rng(0x0B00C);
	const book = path.join(root, 'Onthearche');
	const assets = path.join(root, 'assets');

	// ── The shared assets, outside the book ──────────────────────────
	const faces = BIG_FACES
		.map(([family, files]) => [family, files.filter(f => fs.existsSync(f))])
		.filter(([, files]) => files.length > 0);
	if (faces.length === 0) {
		throw new Error('no large font face for the fixture; it wants one of '
			+ BIG_FACES.map(([, files]) => files.join(', ')).join(', ')
			+ ' (Debian/Ubuntu: fonts-dejavu-core or fonts-liberation)');
	}
	fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });
	for (const [, files] of faces) {
		for (const f of files) fs.copyFileSync(f, path.join(assets, 'fonts', path.basename(f)));
	}
	fs.copyFileSync(SMALL_FACE, path.join(assets, 'fonts', path.basename(SMALL_FACE)));
	put(path.join(assets, 'fonts', 'downloads.zip'), Buffer.from(prose(r, 40 * 1024)));

	// Pictures: three over the inline ceiling, five under it.
	const pics = [['Narrative/Aisha', 260, 220], ['Narrative/River', 320, 260], ['Cover/cover', 420, 300],
		['Icons/mark', 60, 40], ['Icons/leaf', 80, 60], ['Narrative/Hand', 100, 90],
		['Narrative/Stone', 120, 100], ['Icons/seal', 40, 40]];
	pics.forEach(([name, w, h], i) => put(path.join(assets, 'png', name + '.png'), png(w, h, 101 + i)));

	// ── The book ─────────────────────────────────────────────────────
	fs.mkdirSync(book, { recursive: true });
	fs.symlinkSync('../assets', path.join(book, 'assets'));

	const chapters = [];
	for (let i = 1; i <= 36; i++) {
		const name = 'chap_' + String(i).padStart(2, '0') + '.typ';
		chapters.push(name);
		put(path.join(book, name), '= Chapter ' + i + '\n\n' + prose(r, 1500 + ((r() * 9000) | 0)));
	}
	put(path.join(book, 'chap_practice.typ'), '= Practice\n\n' + prose(r, 14000));
	chapters.push('chap_practice.typ');
	put(path.join(book, 'template.typ'),
		'#let doc(title: none, body) = {\n  set text(font: "' + faces[0][0] + '", size: 11pt)\n  body\n}\n');
	put(path.join(book, 'onthearche.typ'),
		'#import "template.typ": doc\n#show: doc.with(title: "Onthearche")\n\n'
		+ chapters.map(c => '#include "' + c + '"').join('\n') + '\n');

	for (let i = 1; i <= 24; i++) {
		const part = 'parts/part' + (1 + (i % 4)) + '/note_' + String(i).padStart(2, '0') + '.typ';
		put(path.join(book, part), prose(r, 400 + ((r() * 3000) | 0)));
	}
	for (let i = 1; i <= 18; i++) {
		put(path.join(book, 'notes', 'n' + String(i).padStart(2, '0') + '.md'),
			'# Note ' + i + '\n\n' + prose(r, 300 + ((r() * 2000) | 0)));
	}
	put(path.join(book, 'glossary.typ'), prose(r, 6000));
	put(path.join(book, 'index.typ'), prose(r, 2500));

	// What the ignore rules exist for.
	['onthearche', 'chap_01', 'chap_02', 'chap_practice', 'glossary'].forEach((n, i) => {
		put(path.join(book, n + '.pdf'),
			Buffer.concat([Buffer.from('%PDF-1.7\n'), png(120 + i * 40, 100, 300 + i), Buffer.from('\n%%EOF\n')]));
	});
	const snap = path.join(book, 'archive', '2026-08');
	for (let i = 1; i <= 6; i++) {
		put(path.join(snap, 'chap_' + String(i).padStart(2, '0') + '.typ'), prose(r, 2000));
	}
	fs.symlinkSync('../../../assets', path.join(snap, 'assets'));
	for (let i = 1; i <= 3; i++) put(path.join(book, 'revision', 'r' + i + '.typ'), prose(r, 1200));

	return { book, family: faces[0][0] };
}
