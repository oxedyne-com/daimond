/* ============================================================
   Daimond — the app's own paths (DaimondAppPaths)
   ------------------------------------------------------------
   Three pure tests of a path, the page's mirrors of the engine's
   `is_store_path`, `APP_STATE_DIRS` and `is_keeper_record`. They lived
   in the page's marks record until the folder-grant model went (D-20261031-11,
   1 Nov 2026); the guards they feed are Daimond's own state, which
   he never manages, so they stay.

   Attaches `window.DaimondAppPaths`, and exports the same for Node.
   ============================================================ */
(function () {
	'use strict';

	/// Store paths -- `diamonds/`, `mail/`, `chats/` -- which follow no folder
	/// (`is_store_path`, `src/tools.rs`), mirrored here so a reference naming one
	/// is reachable from every workspace whatever root it was written with.
	///
	/// F3, 2026-09-25. A legacy Keep transcript row, written with a folder open
	/// before this build named store paths as such, reads `file:[machine:usr@…]
	/// diamonds/<id>/transcript.md`. Judged by its written root, it fit no other
	/// workspace: the Doc header drew it away, and one press there added a SECOND
	/// row rather than finding the one already held. The row itself is never a
	/// mark (`isMark`/`inOwnDir`), so nothing is granted either way; this is
	/// reachability, the same question `fits` and `refReachable` already ask.
	///
	/// Release 5: the engine's `is_store_path` also pins the app's own
	/// `system/agents`, `system/guide` and `system/usage` (`APP_STATE_DIRS`) to the
	/// browser store, and, like its `under`, counts the directory itself as well as
	/// what is beneath it. Mirrored here, so Help's `dir:[browser]system/guide` row
	/// is reachable wherever the engine will read it from.
	var STORE_PATH_RE = /^(?:diamonds|mail|chats|system\/(?:agents|guide|usage|journal))(?:\/|$)/;
	function isStorePath(path) {
		return STORE_PATH_RE.test(String(path || ''));
	}

	/// Is this path the app's own state under `system/` (`APP_STATE_DIRS`): the agents'
	/// transcripts, the guide's mirror, the usage digest or the run journals (U4c)?
	///
	/// Each is made on the device from something that never travels -- the run list in
	/// the tab, the build's own guide, the `local` signal counters -- so none is a
	/// workspace file, and the sync census, the merge and the fork point all ask this
	/// (soak R2, 2026-09-25: each device's digest rode the `files` section and none ever
	/// agreed). The directory itself counts, as the engine's `under` does.
	var APP_STATE_RE = /^system\/(?:agents|guide|usage|journal)(?:\/|$)/;
	function isAppStatePath(path) {
		return APP_STATE_RE.test(String(path || ''));
	}

	/// Is this path part of a keeper's RECORD -- a Diamond's or a chat's version store, its
	/// log, its links (`versions/`, `.daimond/`, `.red/` under `diamonds/<id>/` or
	/// `chats/<id>/`)? The mirror of the engine's `is_keeper_record` (src/tools.rs), folded
	/// to lower case as that one is.
	///
	/// Daimond's own record of THIS device's files, so none of it is a workspace file: a
	/// chat's rows name the paths it changed here -- a machine path absolutely -- and its
	/// bodies are the copies it kept of them. Diamonds travel whole in their own section;
	/// a chat's record never leaves the device (U5 of the reopen rehearsal, 2026-09-25: it
	/// rode the files section from a device in the browser sandbox, and a peer's census
	/// without it deleted every manifest and body of the chat's store, the copy a chat's
	/// Undo had just kept of the person's save among them).
	var KEEPER_RECORD_RE = /^(?:diamonds|chats)\/[^/]+\/(?:versions|\.daimond|\.red)(?:\/|$)/;
	function isKeeperRecordPath(path) {
		return KEEPER_RECORD_RE.test(String(path || '').toLowerCase());
	}

	/// Is this a Diamond id as the engine mints it (`generate_session_id`: hex time and
	/// counter)? A synced chat's `diamondId` becomes a path segment, so `X/../Y` must
	/// never pass (HIST-SAFE U2).
	var DIAMOND_ID_RE = /^[0-9a-f]+$/;
	function isDiamondId(id) {
		return typeof id === 'string' && DIAMOND_ID_RE.test(id);
	}

	var api = {
		isStorePath:        isStorePath,
		isAppStatePath:     isAppStatePath,
		isKeeperRecordPath: isKeeperRecordPath,
		isDiamondId:        isDiamondId,
	};
	if (typeof window !== 'undefined') window.DaimondAppPaths = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
