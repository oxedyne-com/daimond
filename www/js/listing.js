// listing.js — the one reader of a `file_list` answer.
//
// **The listing's text is load-bearing, and it had two parsers.**  `parseListing` draws the Work
// panel; `parseSyncListing` builds the census the other device syncs against, and its own comment
// already called itself "a local copy of the Files panel's parser, which is closed over there".
// Two copies of a rule about text is how one of them comes to be right: a line neither recognises
// is not read as unknown, it is read as A FILE WHOSE NAME IS THAT SENTENCE -- and a phantom file
// in a census that calls itself complete is what the other device deletes on.
// `dev/verify_refusedpath.mjs` check 1c is the write-up of the last time that happened.
//
// So annotations go INSIDE the parentheses and nowhere else, and both panels read them here.
//
// The grammar, which is the whole of it:
//
//	name                                  a file the listing gave no size for
//	name  (123 bytes)                     a file on this device
//	name/                                 a directory on this device
//	name  (123 bytes, in cloud storage)   a file this device does not hold
//	name/  (in cloud storage)             a directory that exists only in cloud storage
//	name  (on gilgamesh)                  a file in a folder the user marked in
//	name/  (Daimond's own store: …)       one of the three store roots, at the root only
(function () {
	'use strict';

	// TWO SPACES separate the name from the parentheses, which is what makes a filename
	// containing " (" unambiguous. The name is non-greedy so that a name with its own
	// parentheses in it keeps them.
	var ENTRY = /^(.*?)(\/)?(?:\s{2}\((?:(\d+) bytes)?(?:, )?([^)]*)\))?$/;

	/// Which place an entry's annotation names.
	///
	/// `local` for no annotation, which is the default the whole scheme rests on: silence means
	/// on this device, in ordinary storage.
	function placeOf(note) {
		if (!note) return 'local';
		if (note.indexOf('in cloud storage') === 0) return 'cloud';
		if (note.indexOf('on ') === 0) return 'machine';
		// The three store roots each say what they are in their own words; they have "browser
		// storage" in common and nothing else, so that is what is matched.
		if (note.indexOf('browser storage') >= 0) return 'store';
		return 'local';
	}

	/// One `file_list` answer as entries.
	///
	/// The first line is tested for the empty answer BEFORE anything else, and anchored at the
	/// first line rather than at the end of the text: `file_list` may put a note on a second line
	/// saying which filesystem it looked in, and a test anchored at the end stops recognising the
	/// answer the moment one appears.
	function parse(text) {
		var out = [];
		var s = String(text == null ? '' : text);
		if (/ is empty\.$/.test(s.split('\n')[0].trim())) return out;
		s.split('\n').forEach(function (line) {
			if (!line) return;
			var m = ENTRY.exec(line);
			if (!m) { out.push({ name: line, dir: false, size: 0, where: 'local' }); return; }
			var where = placeOf(m[4]);
			out.push({
				name:  m[1],
				dir:   !!m[2],
				size:  m[3] ? parseInt(m[3], 10) : 0,
				where: where,
				// The flag both former parsers set, kept so their callers need no change: a file
				// marked as in cloud storage is not on this device, so there is nothing here to
				// read or to re-offload.
				cloud: where === 'cloud',
			});
		});
		return out;
	}

	window.DaimondListing = { parse: parse, placeOf: placeOf };
})();
