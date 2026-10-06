/* ============================================================
   Daimond -- the quiet rule.
   ------------------------------------------------------------
   Background work that fails says nothing until the failure persists.
   Work a person asked for says so at once.

   It exists because mail's schedule polled a mailbox every few minutes and
   painted a red line at the head of the panel whenever one poll failed. Gmail
   drops an IMAP connection now and then and the very next poll succeeds
   (daimond_mail_502_20261006), so a line meant for the owner was raised for a
   blip that had already healed. The page's own comment said an automatic poll
   "says nothing"; the failure path had not been told.

   The rule, kept in one place so no poller grows its own:

     asked     a person pressed it, so a failure is theirs to hear, at once.
     automatic the schedule ran it, so a failure is counted, not announced,
               until it has failed AFTER times in a row.

   AFTER is two. A blip costs one poll, the next succeeds, and that is the
   whole of the evidence for it. Two in a row means a full poll interval has
   gone by with nothing arriving, which at the shortest interval mail offers
   is five minutes and at the longest a day: the unit is the poller's own
   interval, so it scales without the helper knowing what the interval is.

   `ok` forgets the count, and the caller takes down whatever it showed. A
   failure that was shown because it was asked still counts toward the next
   automatic one: two failures in a row are two in a row, whoever pressed.

   Keys are the caller's: one per thing that can recover on its own, such as a
   folder of a mailbox. The counts live in memory only. A reload starts afresh,
   which can only make the page quieter for one more interval.
   ============================================================ */
(function () {
	'use strict';

	var AFTER = 2;			// consecutive failures that are no longer a blip
	var runs  = new Map();	// key -> consecutive failures since the last success

	/// A job failed. Is the failure worth showing now? `asked` is true when a person asked for it.
	function failed(key, asked) {
		var n = (runs.get(key) || 0) + 1;
		runs.set(key, n);
		return !!asked || n >= AFTER;
	}

	/// A job succeeded: whatever it failed before is over.
	function ok(key) { runs.delete(key); }

	window.DaimondQuiet = { failed: failed, ok: ok, AFTER: AFTER };
})();
