/* ============================================================
   Daimond — reading a QR code (qrscan.js)
   ------------------------------------------------------------
   THE READING HALF ONLY. Daimond has exactly one QR ENCODER and
   it is in Rust — `fe2o3_graphics::qr`, exported as `qr_matrix`
   and reached from the page as `window.DaimondQR.matrix`. Nothing
   here draws a symbol, and nothing here may grow to. A second
   encoder is how two devices come to disagree about a code they
   both claim to have written.

   Why any of it is here. First contact is two people in a room:
   one holds up a card, the other reads it. `BarcodeDetector` does
   that job on the browsers that have it, and is used first because
   it is the platform's own reader and it is what a phone's camera
   app uses. Firefox and desktop Safari have none, so the pixels
   have to be decoded in JavaScript or the feature is absent on
   two of the four browsers people actually run.

   WHERE THIS CAME FROM, AND WHERE IT SHOULD END UP. The picture
   pipeline — luminance, adaptive threshold, finder search, the
   homography and the sampler — is ported from the codec in
   `oxegen/www/public/js/qr.js`, which was written for the same
   ceremony and is exercised by `oxegen/dev/qr.test.mjs`. The
   matrix-to-bytes half is written here as the exact inverse of
   `fe2o3_graphics::qr`, with the two error-correction tables
   transcribed from that crate rather than from the standard, so
   the reader and the writer cannot drift apart. A decoder
   ultimately belongs in `fe2o3_graphics::qr` beside the encoder;
   until it is there, this is the fallback and dev/verify_qrscan.mjs
   holds it to the Rust encoder's output at every version.

   THE VERSION RANGE MATTERS AND IS NOT INCIDENTAL. The oxegen
   codec stops at version 10, 57 modules across, because an
   oxenym pairing code is short. An identity card is not: a signed
   `daimond/card/0` artefact measures about 336 bytes, so its
   `#c=` URL needs version 17. A reader capped at 10 would have
   been a reader that could never once read the thing this app
   shows it. So the tables here are computed, not tabulated, and
   the range is the standard's whole 1 to 40.

   Loaded ON DEMAND by trust.js, not from index.html: it is only
   wanted when somebody opens the scanner, and the boot has enough
   to do.
   ============================================================ */
(function () {
	'use strict';

	// ── GF(256), the QR field ──────────────────────────────────
	// x^8 + x^4 + x^3 + x^2 + 1. Two tables and the rest is lookup.

	var EXP = new Uint8Array(512);
	var LOG = new Uint8Array(256);
	(function field() {
		var x = 1;
		for (var i = 0; i < 255; i++) {
			EXP[i] = x;
			LOG[x] = i;
			x <<= 1;
			if (x & 0x100) x ^= 0x11d;
		}
		// Doubled, so a sum of two logs never has to be reduced.
		for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
	})();

	/// Multiply in the field. Zero absorbs, as it must.
	function mul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
	/// Divide in the field. The divisor may not be zero.
	function div(a, b) { return a ? EXP[LOG[a] + 255 - LOG[b]] : 0; }
	/// The multiplicative inverse.
	function inv(a) { return EXP[255 - LOG[a]]; }

	// Polynomials are coefficient arrays, highest degree first.

	function polyAdd(a, b) {
		var out = new Uint8Array(Math.max(a.length, b.length));
		var i;
		for (i = 0; i < a.length; i++) out[i + out.length - a.length] = a[i];
		for (i = 0; i < b.length; i++) out[i + out.length - b.length] ^= b[i];
		return out;
	}

	function polyMul(a, b) {
		var out = new Uint8Array(a.length + b.length - 1);
		for (var i = 0; i < a.length; i++) {
			for (var j = 0; j < b.length; j++) out[i + j] ^= mul(a[i], b[j]);
		}
		return out;
	}

	function polyScale(a, x) {
		var out = new Uint8Array(a.length);
		for (var i = 0; i < a.length; i++) out[i] = mul(a[i], x);
		return out;
	}

	function polyEval(a, x) {
		var y = a[0];
		for (var i = 1; i < a.length; i++) y = mul(y, x) ^ a[i];
		return y;
	}

	// ── Reed-Solomon, the reading way ──────────────────────────
	// Syndromes, Berlekamp-Massey for the locator, Chien for the positions and
	// Forney for the magnitudes. A correction is not trusted because the
	// arithmetic completed: the corrected block is re-checked, and a block that
	// still has a syndrome is a failure rather than a guess.

	/// The syndromes, with the leading zero the locator search expects.
	function syndromes(msg, nsym) {
		var out = new Uint8Array(nsym + 1);
		for (var i = 0; i < nsym; i++) out[i + 1] = polyEval(msg, EXP[i]);
		return out;
	}

	/// The error locator polynomial, or null when there are too many errors.
	function errorLocator(synd, nsym) {
		var err = Uint8Array.from([1]);
		var old = Uint8Array.from([1]);
		var shift = synd.length - nsym;
		for (var i = 0; i < nsym; i++) {
			var k = i + shift;
			var delta = synd[k];
			for (var j = 1; j < err.length; j++) {
				delta ^= mul(err[err.length - 1 - j], synd[k - j]);
			}
			var grown = new Uint8Array(old.length + 1);
			grown.set(old, 0);
			old = grown;
			if (delta !== 0) {
				if (old.length > err.length) {
					var next = polyScale(old, delta);
					old = polyScale(err, inv(delta));
					err = next;
				}
				err = polyAdd(err, polyScale(old, delta));
			}
		}
		var lead = 0;
		while (lead < err.length && err[lead] === 0) lead++;
		err = err.slice(lead);
		// More errors than the code can locate is not a code this block holds.
		return (err.length - 1) * 2 > nsym ? null : err;
	}

	/// Where the errors are, as indices from the head of the block.
	///
	/// The locator's roots are the INVERSES of the error positions' field
	/// elements, so the search runs over a^-i and not over a^i.
	function errorPositions(loc, n) {
		var want = loc.length - 1;
		var pos = [];
		for (var i = 0; i < n; i++) {
			if (polyEval(loc, EXP[(255 - i % 255) % 255]) === 0) pos.push(n - 1 - i);
		}
		return pos.length === want ? pos : null;
	}

	/// The error evaluator: the syndromes times the locator, modulo x^(n+1).
	function errorEvaluator(synd, loc) {
		var p = polyMul(synd, loc);
		return p.slice(Math.max(0, p.length - loc.length));
	}

	/// Take the errors out of a block, given where they are.
	function applyForney(msg, synd, pos) {
		var n = msg.length;
		var degrees = pos.map(function (p) { return n - 1 - p; });
		var loc = Uint8Array.from([1]);
		var i, j;
		for (i = 0; i < degrees.length; i++) {
			loc = polyMul(loc, Uint8Array.from([EXP[degrees[i] % 255], 1]));
		}
		var rev = Uint8Array.from(synd).reverse();
		var om = errorEvaluator(rev, loc);
		var roots = degrees.map(function (d) { return EXP[d % 255]; });

		var fix = new Uint8Array(n);
		for (i = 0; i < roots.length; i++) {
			var xi = roots[i];
			var xinv = inv(xi);
			var prime = 1;
			for (j = 0; j < roots.length; j++) {
				if (j !== i) prime = mul(prime, 1 ^ mul(xinv, roots[j]));
			}
			if (prime === 0) return null;
			fix[pos[i]] = div(mul(xi, polyEval(om, xinv)), prime);
		}
		return polyAdd(msg, fix);
	}

	/// Correct one block, or null where it cannot be corrected.
	function rsDecode(block, nsym) {
		var synd = syndromes(block, nsym);
		var clean = true;
		var i;
		for (i = 0; i < synd.length; i++) if (synd[i]) { clean = false; break; }
		if (clean) return block;
		var loc = errorLocator(synd, nsym);
		if (!loc) return null;
		var pos = errorPositions(loc, block.length);
		if (!pos || !pos.length) return null;
		var fixed = applyForney(block, synd, pos);
		if (!fixed) return null;
		// The proof: a corrected block has no syndrome left. Without this a
		// miscorrection returns confident rubbish.
		var again = syndromes(fixed, nsym);
		for (i = 0; i < again.length; i++) if (again[i]) return null;
		return fixed;
	}

	// ── The version parameters ─────────────────────────────────
	//
	// TRANSCRIBED FROM `fe2o3_graphics/src/qr.rs`, which is the encoder this
	// reader has to agree with, and not from the standard: two independent
	// readings of the same table are two chances to differ on a version nobody
	// tested. Everything else a version implies -- total codewords, how the
	// blocks divide, where the alignment patterns sit -- is COMPUTED from these,
	// exactly as the encoder computes it, because a table that repeats what it
	// implies is a table that can disagree with itself.
	//
	// Indexed [ecc ordinal][version], version 0 unused. Low is 0, High is 3.

	var ECC_PER_BLOCK = [
		[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
		[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
		[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
		[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	];

	var ECC_BLOCKS = [
		[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
		[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
		[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
		[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
	];

	/// The level's index in the tables above.
	var ORDINAL = { L: 0, M: 1, Q: 2, H: 3 };
	/// The two-bit value the format field carries for each level. NOT the same
	/// order as the table index: the standard assigns Medium the value 0.
	var FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
	/// The four levels in format-field order, so a read format word names one.
	var ECC_OF = ['M', 'L', 'H', 'Q'];

	var MIN_VERSION = 1;
	var MAX_VERSION = 40;

	/// The frame's width in modules.
	function widthOf(version) { return 17 + 4 * version; }

	/// The version a matrix of this width is drawn at, or 0 when it is not one.
	function versionOf(size) {
		var v = (size - 17) / 4;
		return v >= MIN_VERSION && v <= MAX_VERSION && v === Math.floor(v) ? v : 0;
	}

	/// Every module a version holds before function patterns and error
	/// correction are taken out, in bits. The encoder's own formula.
	function rawDataModules(ver) {
		var n = (16 * ver + 128) * ver + 64;
		if (ver >= 2) {
			var numalign = Math.floor(ver / 7) + 2;
			n -= (25 * numalign - 10) * numalign - 55;
			if (ver >= 7) n -= 36;			// two version blocks of eighteen bits
		}
		return n;
	}

	/// Codewords, data and check together.
	function totalCodewords(ver) { return Math.floor(rawDataModules(ver) / 8); }

	/// How a version's blocks divide at a level: the counts and the lengths.
	function split(version, ecc) {
		var o = ORDINAL[ecc];
		var nsym = ECC_PER_BLOCK[o][version];
		var blocks = ECC_BLOCKS[o][version];
		var total = totalCodewords(version);
		var data = total - nsym * blocks;
		var short = Math.floor(data / blocks);
		var longs = data % blocks;
		return { nsym: nsym, blocks: blocks, total: total, data: data,
			short: short, shorts: blocks - longs, longs: longs };
	}

	/// How many data codewords a version and level hold.
	function capacity(version, ecc) { return split(version, ecc).data; }

	/// The width of the character-count field in byte mode.
	function countBits(version) { return version < 10 ? 8 : 16; }

	/// Where the alignment patterns' centres sit, for a version. The encoder's
	/// own formula, version 32 included, which the standard makes an exception of.
	function alignPositions(ver) {
		if (ver === 1) return [];
		var num = Math.floor(ver / 7) + 2;
		var step = (ver === 32) ? 26
			: Math.floor((ver * 4 + num * 2 + 1) / (num * 2 - 2)) * 2;
		var size = ver * 4 + 17;
		var out = [];
		for (var i = 0; i < num - 1; i++) out.push(size - 7 - i * step);
		out.push(6);
		out.reverse();
		return out;
	}

	// ── The frame ──────────────────────────────────────────────
	// Which modules are function patterns, so the data stream knows what to
	// skip. Built the same way the encoder builds it.

	/// A version's function-pattern map. `fixed` marks every module the data
	/// stream must skip, the format and version areas included.
	var FRAMES = {};
	function frameOf(version) {
		if (FRAMES[version]) return FRAMES[version];
		var size = widthOf(version);
		var fixed = new Uint8Array(size * size);
		var mark = function (x, y) {
			if (x < 0 || y < 0 || x >= size || y >= size) return;
			fixed[y * size + x] = 1;
		};
		var corners = [[0, 0], [size - 7, 0], [0, size - 7]];
		var i, dx, dy, c;
		// The three finders, each with its separator.
		for (c = 0; c < corners.length; c++) {
			for (dy = -1; dy <= 7; dy++) {
				for (dx = -1; dx <= 7; dx++) mark(corners[c][0] + dx, corners[c][1] + dy);
			}
		}
		// The timing patterns, which are what tell a reader the module pitch.
		for (i = 8; i < size - 8; i++) { mark(i, 6); mark(6, i); }
		// The alignment patterns, less the three the finders already occupy.
		var coords = alignPositions(version);
		for (var a = 0; a < coords.length; a++) {
			for (var b = 0; b < coords.length; b++) {
				var cx = coords[b], cy = coords[a];
				var atCorner = (cx === 6 && cy === 6)
					|| (cx === 6 && cy === size - 7)
					|| (cx === size - 7 && cy === 6);
				if (atCorner) continue;
				for (dy = -2; dy <= 2; dy++) {
					for (dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy);
				}
			}
		}
		// The format areas. (8, 6) and (6, 8) belong to the timing patterns and
		// not to the format, which is why the loop steps over 6.
		for (i = 0; i < 9; i++) {
			if (i === 6) continue;
			mark(8, i); mark(i, 8);
		}
		for (i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
		mark(8, size - 8);							// the module that is always dark
		// And the version areas, on the versions that carry them.
		if (version >= 7) {
			for (i = 0; i < 18; i++) {
				var p = size - 11 + i % 3;
				var q = Math.floor(i / 3);
				mark(p, q); mark(q, p);
			}
		}
		FRAMES[version] = { version: version, size: size, fixed: fixed };
		return FRAMES[version];
	}

	/// Every data module of a frame, in the order the stream fills them: upward
	/// and downward through two-module columns from the right, skipping column 6
	/// because the vertical timing pattern stands in it.
	function stream(size, fixed) {
		var order = [];
		for (var right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (var step = 0; step < size; step++) {
				for (var j = 0; j < 2; j++) {
					var x = right - j;
					var up = ((right + 1) & 2) === 0;
					var y = up ? size - 1 - step : step;
					var i = y * size + x;
					if (!fixed[i]) order.push(i);
				}
			}
		}
		return order;
	}

	/// Whether mask `m` inverts the module at (x, y).
	function masked(m, x, y) {
		switch (m) {
		case 0:  return (x + y) % 2 === 0;
		case 1:  return y % 2 === 0;
		case 2:  return x % 3 === 0;
		case 3:  return (x + y) % 3 === 0;
		case 4:  return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
		case 5:  return (x * y) % 2 + (x * y) % 3 === 0;
		case 6:  return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
		default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
		}
	}

	// ── Format and version information ─────────────────────────

	/// The fifteen bits that say which level and which mask, already masked.
	function formatBits(ecc, mask) {
		var data = (FORMAT_BITS[ecc] << 3) | mask;
		var rem = data;
		for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		return ((data << 10) | rem) ^ 0x5412;
	}

	/// The eighteen bits that say which version, for versions 7 and up.
	function versionBits(version) {
		var rem = version;
		for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		return (version << 12) | rem;
	}

	// Every legal word, so a damaged one can be matched to the nearest.
	var FORMATS = (function () {
		var out = [];
		var levels = ['L', 'M', 'Q', 'H'];
		for (var i = 0; i < levels.length; i++) {
			for (var m = 0; m < 8; m++) {
				out.push({ bits: formatBits(levels[i], m), ecc: levels[i], mask: m });
			}
		}
		return out;
	})();

	var VERSIONS = (function () {
		var out = [];
		for (var v = 7; v <= MAX_VERSION; v++) out.push({ bits: versionBits(v), version: v });
		return out;
	})();

	/// How many bits two words differ in.
	function hamming(a, b) {
		var x = a ^ b, n = 0;
		while (x) { n += x & 1; x >>>= 1; }
		return n;
	}

	/// Read the format information, from whichever copy is asked for.
	function readFormat(cells, size, copy) {
		var at = function (x, y) { return cells[y * size + x]; };
		var bits = 0;
		var put = function (i, v) { bits |= (v & 1) << i; };
		var i;
		if (copy === 0) {
			for (i = 0; i <= 5; i++) put(i, at(8, i));
			put(6, at(8, 7));
			put(7, at(8, 8));
			put(8, at(7, 8));
			for (i = 9; i < 15; i++) put(i, at(14 - i, 8));
		} else {
			for (i = 0; i < 8; i++) put(i, at(size - 1 - i, 8));
			for (i = 8; i < 15; i++) put(i, at(8, size - 15 + i));
		}
		return bits;
	}

	/// The version drawn in the frame, or 0 where there is none to read.
	function readVersion(cells, size) {
		if (size < 45) return 0;
		var bits = 0;
		for (var i = 0; i < 18; i++) {
			var a = size - 11 + i % 3;
			var b = Math.floor(i / 3);
			bits |= (cells[b * size + a] & 1) << i;
		}
		var best = null;
		for (var v = 0; v < VERSIONS.length; v++) {
			var d = hamming(bits, VERSIONS[v].bits);
			if (d <= 3 && (!best || d < best.d)) best = { d: d, version: VERSIONS[v].version };
		}
		return best ? best.version : 0;
	}

	// ── Decoding a matrix ──────────────────────────────────────

	/// Read a sampled matrix: format, mask, codewords, correction, payload.
	///
	/// `cells` is one byte per module, row-major, 1 dark -- the same shape
	/// `DaimondQR.matrix` hands out, which is what lets the encoder be the
	/// oracle this reader is tested against.
	function fromMatrix(cells, size) {
		var guess = versionOf(size);
		if (!guess) return null;
		var format = null;
		var copy, i, b;
		for (copy = 0; copy < 2; copy++) {
			var bits = readFormat(cells, size, copy);
			var best = null;
			for (i = 0; i < FORMATS.length; i++) {
				var d = hamming(bits, FORMATS[i].bits);
				if (d <= 3 && (!best || d < best.d)) best = { d: d, f: FORMATS[i] };
			}
			if (best && (!format || best.d < format.d)) format = { d: best.d, f: best.f };
			if (format && format.d === 0) break;
		}
		if (!format) return null;
		var drawn = readVersion(cells, size);
		if (drawn && drawn !== guess) return null;

		var ecc = format.f.ecc;
		var mask = format.f.mask;
		var frame = frameOf(guess);
		var order = stream(size, frame.fixed);

		// Take the mask off, then read the stream out of the data modules.
		var sp = split(guess, ecc);
		var words = new Uint8Array(sp.total);
		for (i = 0; i < order.length && i < words.length * 8; i++) {
			var idx = order[i];
			var x = idx % size;
			var y = (idx - x) / size;
			var bit = cells[idx] ^ (masked(mask, x, y) ? 1 : 0);
			if (bit) words[i >>> 3] |= 0x80 >>> (i & 7);
		}

		// Undo the interleave, then correct each block on its own. The short
		// blocks hold one data codeword fewer, and the encoder skips that one
		// cell as it interleaves, which is why the data pass stops at `short`
		// for them and runs one further for the rest.
		var dataBlocks = [];
		for (b = 0; b < sp.blocks; b++) {
			dataBlocks.push(new Uint8Array(sp.short + (b < sp.shorts ? 0 : 1)));
		}
		var n = 0;
		for (i = 0; i <= sp.short; i++) {
			for (b = 0; b < sp.blocks; b++) {
				if (i < dataBlocks[b].length) dataBlocks[b][i] = words[n++];
			}
		}
		var checkBlocks = [];
		for (b = 0; b < sp.blocks; b++) checkBlocks.push(new Uint8Array(sp.nsym));
		for (i = 0; i < sp.nsym; i++) {
			for (b = 0; b < sp.blocks; b++) checkBlocks[b][i] = words[n++];
		}

		var out = [];
		for (b = 0; b < sp.blocks; b++) {
			var whole = new Uint8Array(dataBlocks[b].length + sp.nsym);
			whole.set(dataBlocks[b], 0);
			whole.set(checkBlocks[b], dataBlocks[b].length);
			var fixed = rsDecode(whole, sp.nsym);
			if (!fixed) return null;
			for (i = 0; i < dataBlocks[b].length; i++) out.push(fixed[i]);
		}

		var text = payload(out, guess);
		if (text === null) return null;
		return { text: text, version: guess, ecc: ecc, mask: mask, corrections: format.d };
	}

	/// The payload out of the corrected data codewords. Byte mode only, which is
	/// what the encoder writes; any other mode is refused rather than guessed at.
	function payload(words, version) {
		var at = 0;
		var total = words.length * 8;
		var take = function (n) {
			var v = 0;
			for (var i = 0; i < n; i++) {
				if (at >= total) return null;
				v = (v << 1) | ((words[at >>> 3] >>> (7 - (at & 7))) & 1);
				at++;
			}
			return v;
		};
		var bytes = [];
		for (;;) {
			var mode = take(4);
			if (mode === null || mode === 0) break;	// the terminator, or the end
			if (mode !== 4) return null;			// any other mode is not ours
			var n = take(countBits(version));
			if (n === null) return null;
			for (var i = 0; i < n; i++) {
				var byte = take(8);
				if (byte === null) return null;
				bytes.push(byte);
			}
		}
		var buf = Uint8Array.from(bytes);
		return new TextDecoder('utf-8', { fatal: false }).decode(buf);
	}

	// ── Reading a picture ──────────────────────────────────────

	/// Luminance, on the usual weighting.
	function luminance(frame) {
		var width = frame.width, height = frame.height, data = frame.data;
		var out = new Uint8ClampedArray(width * height);
		for (var i = 0, j = 0; j < out.length; i += 4, j++) {
			out[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
		}
		return out;
	}

	// A block the local threshold is taken over, and the smallest spread of
	// luminance a block must have before its own average is trusted.
	var BLOCK = 8;
	var SPREAD = 24;

	/// Binarise adaptively: one threshold per block of the picture, taken from
	/// the neighbourhood rather than from the whole frame.
	///
	/// A single global threshold works on a screen and fails on every
	/// photograph, because a phone holding a card under a lamp has one half of
	/// the frame brighter than the other half's paper is dark.
	function binarise(lum, width, height) {
		var bw = Math.max(1, Math.ceil(width / BLOCK));
		var bh = Math.max(1, Math.ceil(height / BLOCK));
		var mean = new Float32Array(bw * bh);
		var bx, by, x, y, x0, y0, x1, y1, sum, n;
		for (by = 0; by < bh; by++) {
			for (bx = 0; bx < bw; bx++) {
				x0 = bx * BLOCK; y0 = by * BLOCK;
				x1 = Math.min(width, x0 + BLOCK); y1 = Math.min(height, y0 + BLOCK);
				sum = 0; n = 0;
				var lo = 255, hi = 0;
				for (y = y0; y < y1; y++) {
					for (x = x0; x < x1; x++) {
						var v = lum[y * width + x];
						sum += v; n++;
						if (v < lo) lo = v;
						if (v > hi) hi = v;
					}
				}
				var avg = sum / Math.max(1, n);
				if (hi - lo <= SPREAD) {
					// All one colour: below whatever the darkest module is.
					avg = lo / 2;
					if (by > 0 && bx > 0) {
						var near = (mean[(by - 1) * bw + bx]
							+ 2 * mean[by * bw + bx - 1]
							+ mean[(by - 1) * bw + bx - 1]) / 4;
						if (lo < near) avg = near;
					}
				}
				mean[by * bw + bx] = avg;
			}
		}
		var bin = new Uint8Array(width * height);
		for (by = 0; by < bh; by++) {
			for (bx = 0; bx < bw; bx++) {
				sum = 0; n = 0;
				for (var dy = -2; dy <= 2; dy++) {
					var yy = Math.min(bh - 1, Math.max(0, by + dy));
					for (var dx = -2; dx <= 2; dx++) {
						var xx = Math.min(bw - 1, Math.max(0, bx + dx));
						sum += mean[yy * bw + xx]; n++;
					}
				}
				var t = sum / n;
				x0 = bx * BLOCK; y0 = by * BLOCK;
				x1 = Math.min(width, x0 + BLOCK); y1 = Math.min(height, y0 + BLOCK);
				for (y = y0; y < y1; y++) {
					for (x = x0; x < x1; x++) {
						bin[y * width + x] = lum[y * width + x] <= t ? 1 : 0;
					}
				}
			}
		}
		return bin;
	}

	// ── Finding the code in the picture ────────────────────────
	// The three finder patterns are the whole of it: found them, and the code's
	// position, size, rotation and skew all follow.

	/// Whether five runs hold the finder's 1:1:3:1:1 proportions.
	function isFinderRun(c) {
		var total = c[0] + c[1] + c[2] + c[3] + c[4];
		if (total < 7) return false;
		var m = total / 7;
		var tol = m / 2;
		return Math.abs(m - c[0]) < tol && Math.abs(m - c[1]) < tol
			&& Math.abs(3 * m - c[2]) < 3 * tol
			&& Math.abs(m - c[3]) < tol && Math.abs(m - c[4]) < tol;
	}

	/// One line of the picture as alternating runs. `at` is the first pixel
	/// index of the run and `n` its length.
	function runs(bin, width, height, along, axis) {
		var limit = axis ? height : width;
		var out = [];
		var at = 0;
		var dark = axis ? bin[along] === 1 : bin[along * width] === 1;
		for (var i = 1; i <= limit; i++) {
			var here = i < limit
				&& (axis ? bin[i * width + along] === 1 : bin[along * width + i] === 1);
			if (i === limit || here !== dark) {
				out.push({ dark: dark, at: at, n: i - at });
				at = i;
				dark = here;
			}
		}
		return out;
	}

	/// The centre of a run, in pixel-index coordinates.
	function midRun(r) { return r.at + (r.n - 1) / 2; }

	/// Confirm a candidate along one axis, and say where its centre is. A row of
	/// a picture can hold the finder's proportions by accident -- a line of text
	/// does -- and only a pattern that holds them both ways is a finder.
	function crossCheck(bin, width, height, cx, cy, module, axis) {
		var limit = axis ? height : width;
		var read = function (i) { return (axis ? bin[i * width + cx] : bin[cy * width + i]) === 1; };
		var from = axis ? cy : cx;
		if (from < 0 || from >= limit || !read(from)) return null;
		var cap = Math.max(3, module * 4);

		var lo = from, hi = from;
		while (lo - 1 >= 0 && read(lo - 1)) lo--;
		while (hi + 1 < limit && read(hi + 1)) hi++;
		var c = [0, 0, hi - lo + 1, 0, 0];

		var i = lo - 1;
		while (i >= 0 && !read(i) && c[1] <= cap) { c[1]++; i--; }
		while (i >= 0 && read(i) && c[0] <= cap) { c[0]++; i--; }
		i = hi + 1;
		while (i < limit && !read(i) && c[3] <= cap) { c[3]++; i++; }
		while (i < limit && read(i) && c[4] <= cap) { c[4]++; i++; }

		if (!isFinderRun(c)) return null;
		return (lo + hi) / 2;
	}

	/// Every finder-like pattern the picture holds, with its module pitch.
	function finders(bin, width, height) {
		var found = [];
		var add = function (x, y, module) {
			for (var i = 0; i < found.length; i++) {
				var p = found[i];
				if (Math.abs(p.x - x) <= module && Math.abs(p.y - y) <= module
						&& Math.abs(p.module - module) <= Math.max(1, module / 2)) {
					p.x = (p.x * p.count + x) / (p.count + 1);
					p.y = (p.y * p.count + y) / (p.count + 1);
					p.module = (p.module * p.count + module) / (p.count + 1);
					p.count++;
					return;
				}
			}
			found.push({ x: x, y: y, module: module, count: 1 });
		};

		for (var y = 0; y < height; y++) {
			var row = runs(bin, width, height, y, 0);
			for (var i = 0; i + 5 <= row.length; i++) {
				if (!row[i].dark) continue;
				var c = [row[i].n, row[i + 1].n, row[i + 2].n, row[i + 3].n, row[i + 4].n];
				if (!isFinderRun(c)) continue;
				var module = (c[0] + c[1] + c[2] + c[3] + c[4]) / 7;
				var cx0 = Math.round(midRun(row[i + 2]));
				var cy = crossCheck(bin, width, height, cx0, y, module, 1);
				if (cy === null) continue;
				var cx = crossCheck(bin, width, height, cx0, Math.round(cy), module, 0);
				if (cx === null) continue;
				add(cx, cy, module);
			}
		}
		return found.filter(function (p) { return p.count >= 2; });
	}

	function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

	/// The three of them that form a code, in reading order: a right-angled
	/// isosceles triangle with the right angle at the top left.
	function triple(all) {
		var best = null;
		for (var i = 0; i < all.length; i++) {
			for (var j = i + 1; j < all.length; j++) {
				for (var k = j + 1; k < all.length; k++) {
					var fit = fitTriple(all[i], all[j], all[k]);
					if (fit && (!best || fit.error < best.error)) best = fit;
				}
			}
		}
		return best;
	}

	function fitTriple(a, b, c) {
		var ab = dist(a, b), bc = dist(b, c), ac = dist(a, c);
		// The vertex is opposite the longest side.
		var v, p, q;
		if (bc >= ab && bc >= ac)      { v = a; p = b; q = c; }
		else if (ac >= ab && ac >= bc) { v = b; p = a; q = c; }
		else                           { v = c; p = a; q = b; }
		var d1 = dist(v, p), d2 = dist(v, q), hyp = dist(p, q);
		if (!d1 || !d2) return null;
		var legs = Math.abs(d1 - d2) / Math.max(d1, d2);
		if (legs > 0.3) return null;
		var right = Math.abs(hyp - Math.hypot(d1, d2)) / hyp;
		if (right > 0.2) return null;
		var sizes = [a.module, b.module, c.module];
		var mean = (sizes[0] + sizes[1] + sizes[2]) / 3;
		var spread = Math.max(Math.abs(sizes[0] - mean), Math.abs(sizes[1] - mean),
			Math.abs(sizes[2] - mean)) / mean;
		if (spread > 0.5) return null;
		// Which of the two is the top right is the handedness of the pair about
		// the vertex, and handedness survives rotation -- which is what lets a
		// code held sideways be read without trying four ways.
		var turn = (p.x - v.x) * (q.y - v.y) - (p.y - v.y) * (q.x - v.x);
		return {
			error: legs + right + spread,
			topLeft: v,
			topRight: turn > 0 ? p : q,
			bottomLeft: turn > 0 ? q : p,
			module: mean,
		};
	}

	// ── The perspective ────────────────────────────────────────
	// A code photographed off-axis is a projective image of a square, so the map
	// from module coordinates to picture coordinates is a homography.

	/// The homography taking the unit square's corners to four points.
	function squareTo(p) {
		var p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
		var dx3 = p0.x - p1.x + p2.x - p3.x;
		var dy3 = p0.y - p1.y + p2.y - p3.y;
		if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
			return [p1.x - p0.x, p3.x - p0.x, p0.x,
				p1.y - p0.y, p3.y - p0.y, p0.y,
				0, 0, 1];
		}
		var dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
		var dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
		var den = dx1 * dy2 - dx2 * dy1;
		if (!den) return null;
		var a = (dx3 * dy2 - dx2 * dy3) / den;
		var b = (dx1 * dy3 - dx3 * dy1) / den;
		return [p1.x - p0.x + a * p1.x, p3.x - p0.x + b * p3.x, p0.x,
			p1.y - p0.y + a * p1.y, p3.y - p0.y + b * p3.y, p0.y,
			a, b, 1];
	}

	/// The adjugate, which inverts a homography up to a scale that cancels.
	function adjugate(m) {
		return [
			m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
			m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
			m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
		];
	}

	function matMul(a, b) {
		var out = new Array(9);
		for (var r = 0; r < 3; r++) {
			for (var c = 0; c < 3; c++) {
				var s = 0;
				for (var k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
				out[r * 3 + c] = s;
			}
		}
		return out;
	}

	function applyH(m, x, y) {
		var w = m[6] * x + m[7] * y + m[8];
		return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
	}

	/// The homography from module space to picture space, from four pairs.
	function transform(from, to) {
		var a = squareTo(to);
		var b = squareTo(from);
		if (!a || !b) return null;
		return matMul(a, adjugate(b));
	}

	/// Look for an alignment pattern near where one is expected. It is the
	/// fourth correspondence, and it is what makes a skewed code read.
	function findAlignment(bin, width, height, cx, cy, module) {
		var span = Math.max(3, Math.ceil(module * 3));
		var top = Math.max(0, Math.round(cy - span));
		var foot = Math.min(height - 1, Math.round(cy + span));
		var left = Math.max(0, Math.round(cx - span));
		var right = Math.min(width - 1, Math.round(cx + span));
		var best = null;
		for (var y = top; y <= foot; y++) {
			// The pattern's own middle row is light, dark, light, one module each.
			var row = runs(bin, width, height, y, 0);
			for (var i = 0; i + 3 <= row.length; i++) {
				if (row[i].dark) continue;
				if (!isAlignRun([row[i].n, row[i + 1].n, row[i + 2].n], module)) continue;
				var px = midRun(row[i + 1]);
				if (px < left || px > right) continue;
				var py = alignVertical(bin, width, height, Math.round(px), y, module);
				if (py === null) continue;
				var d = Math.hypot(px - cx, py - cy);
				if (!best || d < best.d) best = { d: d, x: px, y: py };
			}
		}
		return best;
	}

	/// Whether three runs are the alignment pattern's 1:1:1 at this pitch.
	function isAlignRun(c, module) {
		var tol = Math.max(0.8, module * 0.7);
		return Math.abs(c[0] - module) <= tol && Math.abs(c[1] - module) <= tol
			&& Math.abs(c[2] - module) <= tol;
	}

	/// The same check down the column, and where the centre module sits.
	function alignVertical(bin, width, height, cx, cy, module) {
		if (cx < 0 || cx >= width) return null;
		var read = function (i) { return bin[i * width + cx] === 1; };
		if (!read(cy)) return null;
		var lo = cy, hi = cy;
		while (lo - 1 >= 0 && read(lo - 1)) lo--;
		while (hi + 1 < height && read(hi + 1)) hi++;
		var cap = Math.max(3, module * 3);
		var above = 0, i = lo - 1;
		while (i >= 0 && !read(i) && above <= cap) { above++; i--; }
		var below = 0;
		i = hi + 1;
		while (i < height && !read(i) && below <= cap) { below++; i++; }
		if (!isAlignRun([above, hi - lo + 1, below], module)) return null;
		return (lo + hi) / 2;
	}

	/// Sample the module at (x, y) of the grid, as the pitch allows.
	function sampleAt(bin, width, height, m, x, y, module) {
		var step = module >= 3 ? module / 4 : 0;
		var offs = step
			? [[0, 0], [-step, 0], [step, 0], [0, -step], [0, step]]
			: [[0, 0]];
		var dark = 0, seen = 0;
		var p = applyH(m, x + 0.5, y + 0.5);
		for (var i = 0; i < offs.length; i++) {
			var px = Math.round(p.x + offs[i][0]);
			var py = Math.round(p.y + offs[i][1]);
			if (px < 0 || py < 0 || px >= width || py >= height) continue;
			seen++;
			dark += bin[py * width + px];
		}
		if (!seen) return 0;
		return dark * 2 > seen ? 1 : 0;
	}

	/// Read a matrix of `size` modules out of the picture.
	function sampleGrid(bin, width, height, spot, size) {
		var half = 3.5;
		var from = [
			{ x: half, y: half },
			{ x: size - half, y: half },
			spot.align ? { x: size - 6.5, y: size - 6.5 } : { x: size - half, y: size - half },
			{ x: half, y: size - half },
		];
		var to = [spot.topLeft, spot.topRight, spot.align || spot.bottomRight, spot.bottomLeft];
		var m = transform(from, to);
		if (!m) return null;
		var cells = new Uint8Array(size * size);
		for (var y = 0; y < size; y++) {
			for (var x = 0; x < size; x++) {
				cells[y * size + x] = sampleAt(bin, width, height, m, x, y, spot.module);
			}
		}
		return cells;
	}

	/// Read a code out of a picture.
	///
	/// `frame` is an ImageData, or anything with `width`, `height` and RGBA
	/// `data`. Answers null when there is nothing there to read -- which is the
	/// ordinary answer on most frames of a camera stream, not a failure.
	function decode(frame) {
		if (!frame || !frame.data || !frame.width) return null;
		var width = frame.width, height = frame.height;
		var bin = binarise(luminance(frame), width, height);
		var all = finders(bin, width, height);
		if (all.length < 3) return null;
		// The strongest candidates first: a picture of a code on a page holds
		// more finder-like runs than a code has finders.
		all.sort(function (a, b) { return b.count - a.count; });
		var spot = triple(all.slice(0, 8));
		if (!spot) return null;

		var across = dist(spot.topLeft, spot.topRight) / spot.module;
		var down = dist(spot.topLeft, spot.bottomLeft) / spot.module;
		var guess = Math.round((across + down) / 2) + 7;

		// The estimate is a division of two measured lengths, so it can land a
		// version either side. Every legal width near it is tried, nearest first,
		// and the first that reads is the answer -- a wrong width almost never
		// survives the format check, let alone the Reed-Solomon.
		var near = 17 + 4 * Math.round((guess - 17) / 4);
		var widths = [near, near - 4, near + 4, near - 8, near + 8]
			.filter(function (s) { return versionOf(s); });

		for (var w = 0; w < widths.length; w++) {
			var size = widths[w];
			// The bottom-right corner from the three finders, and then the
			// alignment pattern that sits just inside it where there is one.
			var bottomRight = {
				x: spot.topRight.x - spot.topLeft.x + spot.bottomLeft.x,
				y: spot.topRight.y - spot.topLeft.y + spot.bottomLeft.y,
			};
			var align = null;
			if (size > 21) {
				var pull = 1 - 3 / (size - 7);
				var ex = spot.topLeft.x + pull * (bottomRight.x - spot.topLeft.x);
				var ey = spot.topLeft.y + pull * (bottomRight.y - spot.topLeft.y);
				align = findAlignment(bin, width, height, ex, ey, spot.module);
			}
			var tries = align ? [align, null] : [null];
			for (var a = 0; a < tries.length; a++) {
				var cells = sampleGrid(bin, width, height, {
					topLeft: spot.topLeft, topRight: spot.topRight,
					bottomLeft: spot.bottomLeft, bottomRight: bottomRight,
					align: tries[a], module: spot.module,
				}, size);
				if (!cells) continue;
				var got = fromMatrix(cells, size);
				if (got) return got;
			}
		}
		return null;
	}

	/// RGBA pixels out of whatever was handed over.
	function pixels(source) {
		if (!source) return null;
		if (source.data && source.width) return source;
		if (typeof document === 'undefined') return null;
		var w = source.videoWidth || source.naturalWidth || source.width;
		var h = source.videoHeight || source.naturalHeight || source.height;
		if (!w || !h) return null;
		var canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		var ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		try { ctx.drawImage(source, 0, 0, w, h); } catch (e) { return null; }
		try { return ctx.getImageData(0, 0, w, h); } catch (e) { return null; }
	}

	/// Read a code from a video element, a canvas, an image or raw pixels.
	///
	/// THE PLATFORM'S OWN READER FIRST. `BarcodeDetector` is hardware-backed and
	/// is what a phone's camera app uses; the decoder above is what Firefox and
	/// desktop Safari get instead. The answer has the same shape either way, so
	/// nothing above this call has to know which read it -- but `by` says, so a
	/// failure can be attributed to the right half.
	async function detect(source) {
		var Detector = (typeof window !== 'undefined') ? window.BarcodeDetector : null;
		if (Detector) {
			try {
				var kinds = await Detector.getSupportedFormats();
				if (kinds && kinds.indexOf('qr_code') >= 0) {
					var reader = new Detector({ formats: ['qr_code'] });
					var hits = await reader.detect(source);
					if (hits && hits.length) {
						return { text: hits[0].rawValue, by: 'BarcodeDetector',
							version: 0, ecc: null, mask: -1 };
					}
					return null;
				}
			} catch (e) { /* the platform's reader is not usable; ours is */ }
		}
		var frame = pixels(source);
		if (!frame) return null;
		var got = decode(frame);
		if (!got) return null;
		got.by = 'daimond';
		return got;
	}

	// ── Public surface ─────────────────────────────────────────
	// `fromMatrix` is published beside `decode` because it is the half the
	// encoder can be an oracle for: dev/verify_qrscan.mjs hands it the grid
	// `DaimondQR.matrix` produced, with no picture in between, so a failure
	// there is the codec and never the camera.
	window.DaimondQRScan = {
		decode:     decode,
		detect:     detect,
		fromMatrix: fromMatrix,
		pixels:     pixels,
		binarise:   binarise,
		luminance:  luminance,
		capacity:   capacity,
		versionOf:  versionOf,
		widthOf:    widthOf,
		maxVersion: MAX_VERSION,
		levels:     ECC_OF,
	};
})();
