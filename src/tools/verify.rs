use super::*;

impl Tool {
    /// The default whole-sequence budget, when the caller names none.
    ///
    /// A sequence is one clean run plus one run per declared break, so the cost multiplies by
    /// however many breaks the file has.  Twenty minutes covers a browser verifier with a
    /// handful of them; a big one is asked for explicitly.
    pub(super) const VERIFY_BUDGET_DEFAULT_MS: u64 = 20 * 60 * 1_000;

    /// The largest budget a caller may ask for.
    pub(super) const VERIFY_BUDGET_MAX_MS: u64 = 2 * 60 * 60 * 1_000;

    /// The line the hand puts all three numbers on.
    ///
    /// Checked for rather than trusted.  A result with no trailer is a result whose three
    /// numbers were never computed, and the model is told so in place of them.
    pub(super) const VERIFY_TRAILER: &str = "[verify:";

    // How much of a dead run's own output is kept beside the note that names it.
    //
    // Twenty lines is a Node stack trace and the line that threw, which is the whole of what a
    // reader needs to tell a refused connection from a real failure.  More would push the report
    // against `MAX_OUTPUT` on a run that proved nothing.
    pub(super) const VERIFY_DEAD_TAIL_LINES: usize = 20;

    /// The line the hand's report carries about the dev world the sequence ran in.
    ///
    /// Lifted out of the report the way the trailer is, because it decides how every number
    /// above it should be read: a page verifier given no world aimed at `localhost:8777`,
    /// which is another lane's app or nothing.
    pub(super) const VERIFY_WORLD: &str = "[world:";

    /// The line the hand's report carries about the hand that ran it.
    ///
    /// Lifted out beside the world line, and for the same reason.  A page reloaded inside the
    /// extension's grace keeps the hand it had, so the report may be an OLDER hand's answer
    /// about code the machine has already replaced -- which is how 2026-09-14's `verify` came
    /// back in 767 ms with no world line and nothing to explain it.
    pub(super) const VERIFY_HAND: &str = "[hand:";

    /// What the hand's handshake says when the file it was launched from now holds different
    /// bytes.
    ///
    /// Said only when it is true, so its ABSENCE is what every build before 2026-09-14 had and
    /// not a second way of saying nothing is wrong.  `hand/src/main.rs` writes it.
    pub(super) const CAP_BIN_STALE: &str = "bin-stale:1";

    /// What the hand's handshake says when it resolves the verify tree PER REQUEST.
    ///
    /// A fact about the hand and never about a folder, which is the whole of why it is a
    /// separate word from `verify:dev`: the latter answers for the granted root and cannot
    /// answer for a folder marked into a Diamond after the hand started.  `hand/src/verify.rs`
    /// writes it, as `verify::BY_ROOT`.
    pub(super) const CAP_VERIFY_BY_ROOT: &str = "verify:by-root";
    pub(super) const CAP_VERIFY_FENCED: &str = "verify:fenced"; // `hand/src/verify.rs`'s `verify::FENCED`

    /// Does this hand have verifiers to run at all?
    ///
    /// From the handshake's `caps`, exactly as `fence_enforced` reads the fence out of it: a
    /// hand that does not say it can, has not said it can.
    ///
    /// **`verify:dev` is a statement about the GRANT, and the grant is not the repository in the
    /// case this app is for.**  A person grants the folder their projects live in and marks one of
    /// them into a Diamond; the grant then holds no `dev/` of its own and says `verify:none`, and
    /// this gate refused every call in a sentence about a folder the model could do nothing
    /// about -- 64 of them across four tasks on 2026-09-15, because a refusal whose remedy is out
    /// of reach becomes a loop.  So a hand carrying [`Self::CAP_VERIFY_BY_ROOT`] is asked instead:
    /// the request names the folder the turn is working in and the hand answers for THAT tree, in
    /// a sentence naming it.  A hand without the capability keeps the older gate, because it would
    /// ignore the field and resolve in the grant.
    ///
    /// # Arguments
    /// * `caps` - What the hand said it can do.
    pub(super) fn verify_available(caps: &[String]) -> bool {
        caps.iter().any(|c| c == Self::CAP_VERIFY_BY_ROOT || c == "verify:dev")
    }

    /// The sentence refusing a named `verify` on this hand, or `None` to go ahead.
    ///
    /// # Arguments
    /// * `caps` - What the hand said in its handshake.
    pub(super) fn verify_gate(caps: &[String]) -> Option<String> {
        if !Self::verify_available(caps) {
            return Some(fmt!(
                "Refused: the folder this hand was granted holds no 'dev/verify_*.mjs', so \
                there is nothing here to verify with. This tool runs THIS repository's own \
                verifiers; it is not a general test runner. Tell the user which folder they \
                granted, and use 'run' for the project's own test command instead."));
        }
        // A hand that does not say its verifiers run fenced is one older than the fence, which
        // ran a committed verifier with the person's whole access: nothing sent from here can
        // fence it, so it is refused, and the remedy is the person's.
        if !caps.iter().any(|c| c == Self::CAP_VERIFY_FENCED) {
            return Some(fmt!(
                "Refused: the machine hand on this computer is older than the one that runs \
                verifiers behind a fence, so a verifier run through it could reach every file the \
                user can. Nothing was run. Tell the user to update the hand (install the current \
                Daimond hand and reload the extension), and use 'run' for the project's own test \
                command meanwhile."));
        }
        None
    }

    /// The tree this Diamond is about, absolute on the machine, or the sentence refusing it.
    ///
    /// **The folder the user MARKED, and not the folder they granted.**  A grant is commonly the
    /// parent of several repositories -- a person grants `~/projects` and marks one of them into
    /// a Diamond -- so a verify tree fixed at the grant answers about a folder nobody asked
    /// about, which is what refused every call of the real-repository bank on 2026-09-15.
    ///
    /// Composed as [`ToolContext::default_cwd`] composes a command's working directory, from the
    /// turn's prefix and then its bounds, with one difference: the bound must be WRITABLE
    /// ([`writable_dir`]).  A Diamond attached only to consult is refused rather than sent the
    /// consulted tree, whose verifiers would report on someone else's code as this Diamond's
    /// (QA A F1, 11 Oct 2026).  **A tree is always named** (11 Oct 2026): an
    /// unscoped turn sends the grant written out, and a scoped turn with no folder on the machine
    /// is refused in `run`'s words ([`no_folder_refusal`]).  An empty root used to send the hand
    /// to its grant, which took a scoped turn's verifier outside its scope.
    pub(super) fn verify_root_of<H: Host>(ctx: &ToolContext<H>, machine: &Machine) -> Result<String, String> {
        if !machine.rooted() {
            return Err(fmt!(
                "Refused: the machine hand did not say which folder it was granted, so there is \
                no tree to look a verifier up in. Nothing was run."));
        }
        let grant = machine.root.trim_end_matches('/');
        let prefix = normalise(&ctx.path_prefix);
        let rel = match !prefix.is_empty() && !is_store_path(&prefix) {
            true	=> prefix,
            false	=> writable_dir(&ctx.no_write),
        };
        // A Diamond's own directory is in the browser's storage and not on the machine at all
        // (see `is_store_path`), so naming it would send the hand a path it cannot resolve.
        if rel.is_empty() || is_store_path(&rel) {
            if ctx.is_scoped() {
                return Err(no_folder_refusal(ctx, NoFolder::Verify));
            }
            return Ok(if grant.is_empty() { fmt!("/") } else { grant.to_string() });
        }
        Ok(fmt!("{}/{}", grant, rel))
    }

    /// The wire request one `verify` call becomes, or the sentence refusing it.
    ///
    /// **Nothing composed here is a program, a path or an argument.**  The request carries a
    /// NAME and at most a BREAK, both of which the hand looks up -- the name in its own `dev/`
    /// directory, the break in that file's own source -- and neither of which reaches a command
    /// line in the form the model wrote it.  There is no `argv` field to fill, no `cwd`, no
    /// `env` and no shell anywhere on the road, which is why this function is twenty lines
    /// where [`Tool::run`]'s equivalent is two hundred.
    ///
    /// Available on the native build for its tests: it is pure string composition, and the
    /// checks it makes are the ones worth holding to.
    ///
    /// **A DISPATCHED WORKER GETS THIS, on the owner's ruling of 2026-09-12.**  It was refused
    /// one until then, on the ground that a verifier runs a process outside the fence every other
    /// tool works inside and a worker is the turn with nobody watching.  What the refusal actually
    /// bought was the opposite of supervision: every round of checking ran in the DISPATCHING
    /// daimon's context, read by the model that did not do the work and paid for out of the one
    /// context in the app that is scarce -- while a worker that reached for `run` instead met
    /// [`verifier_refusal`], which told it to use `verify`, which refused it.  A worker now
    /// composes the request a daimon composes, under the same budget, shaped by the same
    /// [`Tool::verify_result`], and booked by [`call_outcome`] the same way.  Nothing composed
    /// here is a program, a path or an argument, so there is no fence for a worker to be outside
    /// of -- the selector argument below is the whole of the reason that is true.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments.
    /// * `id` - The identifier every answer about this sequence is tagged with.
    /// * `root` - The folder this turn is working in, absolute on the machine, or empty for the
    ///   granted root.  Composed from the turn's BOUNDS and never from the model's text -- it is
    ///   the mark the user made, which is the one thing that says which of the grant's
    ///   repositories this Diamond is about.
    /// * `net` - What [`Tool::turn_net`] answered for this turn, which the hand's verifier fence
    ///   takes as its network and never widens.
    /// * `fence` - `run`'s fence on this turn, whose read-only and deny lists the hand's verifier
    ///   fence carries (rc-b F3, 11 Oct 2026), so a verifier writes nowhere `run` could not.
    pub(super) fn verify_spec(args: &str, id: &str, root: &str, net: bool, fence: &FenceSpec)
        -> Result<String, String>
    {
        let name = match extract_json_string(args, "name") {
            Some(n) => n,
            None    => return Err(fmt!(
                "Refused: verify needs 'name' -- the verifier's short name, as in 'graph' for \
                dev/verify_graph.mjs. It takes a NAME and never a path or a command line.")),
        };
        if !verify_name_ok(&name) {
            return Err(fmt!(
                "Refused: '{}' is not a verifier name. A name is lower-case letters, digits and \
                underscores -- 'graph', not 'dev/verify_graph.mjs' and not 'node dev/...'. This \
                tool looks the name up in the tracked tree; it does not run what you write.",
                name.chars().take(40).collect::<String>()));
        }
        let clean_only = extract_json_bool(args, "clean_only").unwrap_or(false);
        let asked      = extract_json_string(args, "break").filter(|b| !b.trim().is_empty());
        // Two arguments that want opposite things. Refused rather than resolved, because
        // either resolution silently gives the caller the run they did not ask for -- and one
        // of the two is the run that proves nothing.
        if clean_only && asked.is_some() {
            return Err(fmt!(
                "Refused: 'clean_only' asks for no break and 'break' names one. Send one or the \
                other. A clean-only run proves nothing, so it is never what you want alongside \
                a break."));
        }
        let (breaks, brk) = match (&asked, clean_only) {
            (Some(b), _) => {
                if !verify_name_ok(b) {
                    return Err(fmt!(
                        "Refused: '{}' is not a break name. A break is lower-case letters, \
                        digits and underscores, and it must be one the verifier itself \
                        declares in its own source.",
                        b.chars().take(40).collect::<String>()));
                }
                ("one", fmt!(r#""{}""#, json_escape(b)))
            },
            (None, true)  => ("none", fmt!("null")),
            (None, false) => ("all",  fmt!("null")),
        };
        let budget = extract_json_number(args, "timeout_ms")
            .unwrap_or(Self::VERIFY_BUDGET_DEFAULT_MS)
            .min(Self::VERIFY_BUDGET_MAX_MS)
            .max(1);
        // A BOOLEAN here and three words on the wire, which is the one thing the model is
        // allowed to say about a world. WHICH world is the hand's to choose from the band
        // `dev/world.sh`'s register reserves -- the history of that register is the history
        // of callers picking numbers -- so there is nothing here for a model to collide with
        // another lane on. Saying nothing is "infer", which reads the verifier's own source.
        let world = match extract_json_bool(args, "world") {
            Some(true)	=> "stand",
            Some(false)	=> "none",
            None	=> "infer",
        };
        Ok(fmt!(
            r#"{{"t":"verify","id":"{}","name":"{}","root":"{}","breaks":"{}","break":{},"world":"{}","net":{},"ro":{},"deny":{},"timeout_ms":{}}}"#,
            json_escape(id),
            json_escape(&name),
            json_escape(root),
            breaks,
            brk,
            world,
            net,
            json_list(&fence.ro),
            json_list(&fence.deny),
            budget))
    }

    /// The hand's report, as the model reads it.
    ///
    /// **The one thing this function is for is refusing to pass on a bare pass.**  The three
    /// numbers are computed in the hand, by `verify::Verdict`, whose every arm carries the
    /// count of breaks that reddened nothing -- but a report is text, and text can arrive
    /// truncated, from an older hand, or from a verifier that printed something shaped like a
    /// trailer.  So the trailer is lifted out of the report and re-stated OUTSIDE the untrusted
    /// envelope, as Daimond's own sentence; and where there is no trailer to lift, the model is
    /// told in plain words that what it is holding is not evidence.
    ///
    /// **THE ENVELOPE EITHER WAY, THE TAINT ONLY WHERE THE FENCE EARNED IT**, which is
    /// [`Tool::run_result`]'s rule and was not this one's.  A verifier is a script the hand looked
    /// up by name in the tracked tree's own `dev/`, run over files the daimon wrote, and its
    /// output went through [`ToolContext::wrap_untrusted`] unconditionally -- so on 2026-09-13 a
    /// daimon's own `verify` marked its turn as having read a stranger's words, and the next
    /// `grep` reached [`net_step`] as `Ask`.  `tainting` is now decided by
    /// [`fence_reaches_untrusted`] in [`Tool::verify`], beside the fence it is a property of,
    /// exactly as `run` decides it.
    ///
    /// # Arguments
    /// * `name` - The verifier, for the origin line.
    /// * `res` - The hand's JSON result.
    /// * `ctx` - The turn, which `tainting` decides whether to mark.
    /// * `tainting` - Whether this turn's fence could reach a stranger's words.  Computed in
    ///   [`Tool::verify`] and passed down, never re-derived here.
    pub(super) fn verify_result<H: Host>(name: &str, res: &str, ctx: &ToolContext<H>, tainting: bool) -> String {
        if let Some(reason) = extract_json_string(res, "refused") {
            return refusal_line(&reason);
        }
        let out = extract_json_string(res, "stdout").unwrap_or_default();
        let err = extract_json_string(res, "stderr").unwrap_or_default();
        let exit = extract_json_i64(res, "exit").unwrap_or(-1);
        // The trailer, taken from the report rather than composed here: the numbers are the
        // hand's, which is the half of this that ran the processes.
        let trailer = out.lines().rev()
            .find(|l| l.trim_start().starts_with(Self::VERIFY_TRAILER))
            .map(|l| fmt!("{}", l.trim()));
        // The world, from the head of the report rather than its tail: which world the checks
        // were aimed at is what says whether the numbers are about this tree's app at all.
        let world = out.lines()
            .find(|l| l.trim_start().starts_with(Self::VERIFY_WORLD))
            .map(|l| fmt!("{}", l.trim()));
        // And WHICH HAND produced them, on the same terms.
        let hand = out.lines()
            .find(|l| l.trim_start().starts_with(Self::VERIFY_HAND))
            .map(|l| fmt!("{}", l.trim()));
        let mut s = String::new();
        if !out.is_empty() { s.push_str(&out); }
        if !err.is_empty() {
            if !s.is_empty() && !s.ends_with('\n') { s.push('\n'); }
            s.push_str("[progress] ");
            s.push_str(&err);
        }
        let origin = fmt!("verify: dev/verify_{}.mjs", name);
        s = defang(&s);
        // A CLEAN RUN THAT MEASURED NOTHING IS A DEATH, NOT A RESULT.
        //
        // `0 passed, 0 failed` is what the report says when the script threw before it printed
        // its first check, and the three numbers below it are dutifully computed from nothing.  A
        // model holding that reads a product defect and starts looking for one: on 2026-09-13 a
        // daimon spent fifty steps on a verifier whose whole trouble was that no dev world was
        // up, because the script's own `ERR_CONNECTION_REFUSED` reached it nowhere.  So the
        // script's own exit code is stated, its last lines are kept, and the one cause worth
        // naming is named.
        let died = match verify_clean_numbers(&out) {
            Some((0, 0, e)) => Some(e),
            _               => None,
        };
        let dead_note = match died {
            None    => String::new(),
            Some(e) => {
                let seen = last_lines(&s, Self::VERIFY_DEAD_TAIL_LINES);
                fmt!("\n[THE VERIFIER MEASURED NOTHING. Its clean run printed no check at all and \
                    exited {}, so every number below is computed over an empty run and says \
                    nothing about this repository. Do not report a defect from it; find out why \
                    the script died. Its last lines are above, verbatim.]{}",
                    e,
                    dead_run_hint(&seen).unwrap_or_default())
            },
        };
        let tail = match (&trailer, exit) {
            // No trailer, whatever the exit code says. This is the case the whole tool exists
            // to make survivable: a passing count with nothing behind it is the evidence that
            // has been lying, so it is not handed on as evidence at all.
            (None, _) => fmt!(
                "\n[THIS IS NOT EVIDENCE. The run did not report how many breaks were \
                confirmed red and how many proved nothing, so nothing above has been shown to \
                be capable of failing. Do not report a passing count from this. Say that the \
                verifier ran and that its instrument was not proved.]"),
            (Some(t), -1) => fmt!(
                "\n{}\n[the sequence did not finish, so these numbers cover only what ran]", t),
            (Some(t), _) => fmt!("\n{}", t),
        };
        let tail = fmt!("{}{}", tail, dead_note);
        // Restated outside the envelope beside the trailer, and for the same reason: a report is
        // text, and a model reading a passing count owes its reader which app the count is about.
        let world = match &world {
            Some(w) => fmt!("\n{}", w),
            None    => String::new(),
        };
        let hand = match &hand {
            Some(h) => fmt!("\n{}", h),
            None    => String::new(),
        };
        let room = MAX_OUTPUT.saturating_sub(
            envelope_overhead(&origin) + tail.len() + world.len() + hand.len());
        if died.is_some() {
            // THE END IS THE HALF THAT MATTERS on a run that died: `truncate_output` keeps the
            // beginning, which would cut away the very stack trace this note points at.
            s = head_and_tail(&s, room);
        } else {
            truncate_output(&mut s, room);
        }
        // The method marks the turn and the free function does not, and that is the whole of the
        // difference: the model reads the same marked output on both branches, and only the
        // network moves.  See `Tool::run_result`, which has said this since 2026-08-24.
        let body = if tainting {
            ctx.wrap_untrusted(&origin, &s)
        } else {
            wrap_untrusted(&origin, &s)
        };
        fmt!("{}{}{}{}", body, world, hand, tail)
    }

    /// What the seat adds about the hand that answered, in Daimond's own words.
    ///
    /// **A REPORT CANNOT BE READ WITHOUT KNOWING WHICH HAND WROTE IT**, and the two ways of
    /// not knowing are opposite.  A hand that is current says which image it runs and which
    /// world it stood; a hand OLDER than either line says nothing at all, and silence reads
    /// as "there was nothing to say".  On 2026-09-14 that cost a turn twice over: `verify
    /// {"world":true}` came back in 767 ms with no `[world:` line, and a daimon spent about
    /// thirty rounds guessing at the fence and the mocks, because the page -- reloaded inside
    /// the extension's thirty-second grace -- was still holding a hand from 2026-09-10 that
    /// had never heard of the world code.  The absence is now the message.
    ///
    /// The other direction is the hand's own: `bin-stale:1` in the handshake is the hand
    /// saying the file it was launched from now holds different bytes, which is an install
    /// that has not been taken.
    ///
    /// # Arguments
    /// * `caps` - The handshake, as [`Machine`] carries it.
    /// * `asked_world` - Whether this call said `"world": true`, which is the only case where
    ///   a missing world line is a fault rather than the answer.
    /// * `out` - What the model is about to read.
    pub(super) fn verify_hand_note(caps: &[String], asked_world: bool, out: &str) -> String {
        let mut s = String::new();
        // A REFUSAL RAN NOTHING, so it carries no numbers whose hand is in question, and its
        // silence about the hand is not a sign of age: since QA B B3 (11 Oct 2026) a current
        // hand stamps its `[hand:` line on every verify refusal, and that line is the answer.
        // Only the handshake's own word below still applies.
        let refused = out.trim_start().starts_with(REFUSAL_OPENING);
        if !refused && asked_world && !out.contains(Self::VERIFY_WORLD) {
            s.push_str(
                "\n[NO WORLD, AND NOTHING SAID SO. This call asked for a dev world and the \
                report carries no '[world:' line at all -- which is what a hand older than \
                verify's world support produces, because that hand does not know the word. \
                The verifier was therefore aimed at whatever was on :8777, so a refused \
                connection above is that and not a defect in this repository. Do not debug \
                the fence, the mocks or the verifier from this run. The page is holding a \
                hand the machine has already replaced: a reload inside the extension's \
                thirty-second grace hands the old process back. Reload the page with \
                nothing running and ask again; if there is still no world line, say so to \
                the user -- the machine hand needs installing.]");
        } else if !refused && !out.contains(Self::VERIFY_HAND) {
            s.push_str(
                "\n[The report does not say which hand produced it, so the hand this page is \
                holding is older than that line. Reload the page with nothing running to \
                take the hand the machine has.]");
        }
        if caps.iter().any(|c| c == Self::CAP_BIN_STALE) {
            let bin = caps.iter()
                .find_map(|c| c.strip_prefix("bin:"))
                .unwrap_or("the path it was installed to");
            s.push_str(&fmt!(
                "\n[A NEWER MACHINE HAND IS INSTALLED at {} and this page is not running it. \
                The numbers above are the older hand's answer about code the machine has \
                already replaced. Reload the page with nothing running and the new hand is \
                taken; a reload while a command is in flight keeps this one.]", bin));
        }
        s
    }


    /// The project check's result, as the model reads it.
    ///
    /// **The exit code is the verdict and the summary is a convenience.**  The counts are lifted
    /// out of the runner's own output by [`verify_summary`], which knows three runners; anything
    /// else says so in words rather than reporting a number it inferred.  The body goes through
    /// [`Tool::run_result`], so a project check carries the same envelope, the same spend gate
    /// and the same no-network note a command does -- it IS a command.
    ///
    /// # Arguments
    /// * `plan` - What was run and where the command came from.
    /// * `secs` - Wall time measured on the page, because the wire carries no elapsed figure.
    pub(super) fn verify_project_result<H: Host>(
        plan:      &ProjectVerify,
        res:       &str,
        ctx:       &ToolContext<H>,
        no_net:    NetCut,
        tainting:  bool,
        read_only: bool,
        cap:       Option<usize>,
        secs:      f64,
    )
        -> String
    {
        if let Some(reason) = extract_json_string(res, "refused") {
            return refusal_line(&reason);
        }
        let cmd  = plan.argv.join(" ");
        let exit = extract_json_i64(res, "exit").unwrap_or(-1);
        let head = fmt!(
            "[verify] {} ({}), cwd '{}', exit {}, {:.1} s\n",
            cmd, plan.source, plan.cwd,
            if exit < 0 { fmt!("unknown -- it did not finish") } else { fmt!("{}", exit) },
            secs);
        let body = Self::run_result(&plan.argv, res, ctx, no_net, tainting, read_only, cap);
        let out  = extract_json_string(res, "stdout").unwrap_or_default();
        let err  = extract_json_string(res, "stderr").unwrap_or_default();
        let tail = match verify_summary(&fmt!("{}\n{}", out, err)) {
            Some((p, f)) => fmt!("\n[verify] {}: {} passed, {} failed. The exit code is the \
                verdict.\n", cmd, p, f),
            None => fmt!("\n[verify] {}: summary not parsed; the exit code is the verdict.\n", cmd),
        };
        fmt!("{}{}{}", head, body, tail)
    }

    /// Is this project's check a command the toolkit for it has not been granted?
    ///
    /// Its own sentence, because the hand's refusal names a binary that is not on PATH and the
    /// cause is a grant the user makes in a panel.
    pub(super) fn toolkit_missing(argv0: &str, bounds: &[Bound]) -> Option<String> {
        let granted = toolkits(bounds);
        // The tail of a path is the program: `/usr/bin/cargo` is cargo.
        let prog = argv0.rsplit('/').next().unwrap_or(argv0);
        for kit in Toolkit::all() {
            if kit.programs().contains(&prog) && !granted.contains(&kit) {
                return Some(fmt!(
                    "Refused: the project's verify command is '{}' and the {} toolkit is not \
                    granted to this Diamond -- grant it in the Workspace panel, or declare a \
                    command in .daimond/verify.json that does not need it.",
                    prog, kit.name()));
            }
        }
        None
    }

    /// [`Self::toolkit_missing`] on `machine`: never on a whole-home fence, where no toolkit is
    /// granted because none is needed ([`Machine::whole_home`]).
    ///
    /// # Arguments
    /// * `argv0` - The check's program.
    /// * `bounds` - This turn's bounds.
    /// * `machine` - The machine the check runs on.
    pub(super) fn toolkit_missing_on(argv0: &str, bounds: &[Bound], machine: &Machine) -> Option<String> {
        if machine.whole_home() {
            return None;
        }
        Self::toolkit_missing(argv0, bounds)
    }

    /// Run THIS PROJECT's own check, inside the fence, and say what its exit code was.
    pub(super) async fn verify_project<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let cwd_rel = match asked_cwd(args) {
            Some(c) => c,
            None    => ctx.default_cwd(),
        };
        // The declaration, read by the TOOL rather than through a file tool: `.daimond` is denied
        // to a bounded turn's reads for the same reason it is denied to every command, and the
        // one thing entitled to read a tool's own declaration is that tool.
        let decl = Self::read_one_text(ctx, &Self::join_rel(&cwd_rel, ".daimond/verify.json"))
            .await.ok();
        let mut has = Manifests::default();
        if decl.is_none() {
            // Probed in the inference's own order and stopped at the first hit, so an ordinary
            // project costs one round trip rather than five.
            has.cargo = Self::read_one_text(ctx, &Self::join_rel(&cwd_rel, "Cargo.toml"))
                .await.is_ok();
            if !has.cargo {
                has.npm = match Self::read_one_text(
                    ctx, &Self::join_rel(&cwd_rel, "package.json")).await
                {
                    Ok(t)  => npm_test_script(&t),
                    Err(_) => false,
                };
            }
            if !has.cargo && !has.npm {
                has.pytest = Self::read_one_text(ctx, &Self::join_rel(&cwd_rel, "pyproject.toml"))
                    .await.is_ok()
                    || Self::read_one_text(ctx, &Self::join_rel(&cwd_rel, "pytest.ini"))
                    .await.is_ok();
            }
            if !has.cargo && !has.npm && !has.pytest {
                has.go = Self::read_one_text(ctx, &Self::join_rel(&cwd_rel, "go.mod"))
                    .await.is_ok();
            }
        }
        let plan = match project_verify_argv(decl.as_deref(), has) {
            Ok(p)  => p,
            Err(w) => return Ok(refusal_line(w.trim_start_matches("Refused: "))),
        };
        // The call's ceiling is now the check's own budget, not the default (U3a LV2, A2).
        crate::engine::worker::deadline::stretch(plan.timeout);
        // Where the toolchain question can be put, `run_exec` puts it; this sentence is for the
        // turns it cannot be put on (a worker alone, the bypass rung, a hand with no home).
        // No answer is no home: `run_exec` says why the hand did not answer.  A whole-home fence
        // grants no toolkit and needs none, so it is neither asked nor refused one.
        let machine = ctx.host().exec().status().await
            .map(|st| Machine::from_status(&st))
            .unwrap_or_else(|_| Machine::at(""));
        if !ctx.can_ask_kits_on(mode(), &machine) {
            if let Some(why) = Self::toolkit_missing_on(
                &plan.argv[0], &ctx.run_bounds(), &machine)
            {
                return Ok(refusal_line(why.trim_start_matches("Refused: ")));
            }
        }
        // The declaration's `cwd` is relative to the project root, which is where this turn's
        // commands already run.
        let run_in = match plan.cwd.trim() {
            "" | "." => cwd_rel.clone(),
            other    => Self::join_rel(&cwd_rel, other),
        };
        let began = ctx.host().clock().now_ms();
        let cap = extract_json_number(args, "max_bytes").map(|n| n as usize);
        match res!(Self::run_exec(Self::Verify.name(), "verify", &plan.argv, Some(run_in),
            plan.timeout, None, ctx, false).await)
        {
            Exec::Refused(why) => Ok(why),
            Exec::Ran { res, no_net, tainting, read_only, after } => {
                let secs = (ctx.host().clock().now_ms() - began) / 1_000.0;
                Ok(Self::verify_project_result(&plan, &res, ctx, no_net, tainting, read_only, cap,
                    secs) + &after)
            },
        }
    }

    /// Run one named verifier from the tracked tree and hand back what it proved.
    ///
    /// Short, and the shortness is the design.  [`Tool::run`] spends two hundred lines building
    /// a fence out of the turn's bounds, because it is about to run a command a MODEL wrote.
    /// This one has nothing to fence: the hand is given a name it looks up in its own granted
    /// `dev/` directory and at most a break it looks up in that file's own source, and it
    /// composes the argument vector itself out of what it found.  The model's text is a
    /// selector and never an input.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments.
    /// * `ctx` - The turn.
    /// Whether this turn's commands may reach the network: the ONE question `run` and `verify`
    /// both ask, so a committed verifier is never a wider way out than a command.
    ///
    /// # Arguments
    /// * `machine` - Where the command runs.
    /// * `cmd` - What the user is asked about, as they would read it.
    /// * `cwd_abs` - Where it runs.
    pub(super) async fn turn_net<H: Host>(ctx: &ToolContext<H>, machine: &Machine, mode: Mode, cmd: &str, cwd_abs: &str)
        -> bool
    {
        // Its own edge, not `egress_allowed_detail`, and for one reason: the page's gate answers
        // `allow` outright for our own origin, and a command line resolved against the page IS
        // our own origin, so this question asked through that door would be waved through by a
        // shortcut meant for a URL. `egress_allowed_net` takes a yes only in a word the branch
        // written for this question can say.
        let tag = ctx.turn_tag();
        Self::turn_net_with(ctx, machine, mode,
            || ctx.host().net().egress_allowed_net(&tag, cmd, cwd_abs)).await
    }

    /// [`Self::turn_net`] with the question put by `ask`, so a test can count the questions.
    pub(super) async fn turn_net_with<H: Host, F, A>(ctx: &ToolContext<H>, machine: &Machine, mode: Mode, ask: F) -> bool
        where F: FnOnce() -> A, A: std::future::Future<Output = Option<Verdict>>
    {
        // On the runner the taint alone decides, on every rung, and nobody is asked: nobody could
        // answer there, and the parent takes the network from the rest of the run (U9).
        if machine.whole_home() {
            return !ctx.is_tainted();
        }
        let step = net_step(mode, ctx.net_risk(), ctx.is_unsupervised(), ctx.net_consent());
        let step = match step {
            NetStep::Ask => {
                let answer = ask().await;
                let v = net_verdict(answer);
                ctx.set_net_consent(v);
                // Read back rather than derived, so the turn's memory is what the fence is built
                // from: two answers to one question is how a race gets the network.
                net_step(mode, ctx.net_risk(), ctx.is_unsupervised(), ctx.net_consent())
            },
            other => other,
        };
        step.gives_net()
    }

    pub(super) async fn verify<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let name = extract_json_string(args, "name")
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        // NO NAME IS THE PROJECT'S OWN CHECK, and it is a different tool underneath: a command
        // inside the fence rather than a script the hand looks up outside it. One tool because
        // it is one question -- "does this pass" -- and the model should not have to know which
        // kind of repository it is holding to ask it.
        let name = match name {
            Some(n) => n,
            None    => return Self::verify_project(args, ctx).await,
        };
        let st = res!(ctx.host().exec().status().await);
        if extract_json_bool(&st, "paired") != Some(true) {
            return Ok(fmt!("Refused: {}", extract_json_string(&st, "reason").unwrap_or_else(|| fmt!(
                "There is no machine hand paired with this browser, so there is nothing to run \
                a verifier on. Tell the user, and carry on with the file tools."))));
        }
        let machine = Machine::from_status(&st);
        if !machine.rooted() {
            return Err(err!(
                "The machine hand did not say which folder it was granted, so there is no tree \
                to look a verifier up in. Nothing was run."; Missing, Configuration));
        }
        if let Some(r) = Self::verify_gate(&machine.caps) {
            return Ok(r);
        }
        let root = match Self::verify_root_of(ctx, &machine) {
            Ok(r)  => r,
            Err(r) => return Ok(r),
        };
        // The network `run` would get on this turn, asked the same way: a verifier that could
        // not read another Diamond must not be able to post this one anywhere instead.
        let net = Self::turn_net(ctx, &machine, mode(), &fmt!("verify {}", name), &root).await;
        // `run`'s own fence on this turn, by the function `run` builds it with, so the verifier
        // takes its read-only marks and deny rules (and, on a hand older than the deletion
        // meter, its everything-read-only).
        let fence = command_fence(&ctx.run_bounds(), &machine, true);
        let spec = match Self::verify_spec(args, &Self::run_id("verify", ctx), &root, net, &fence) {
            Ok(s)  => bound_to_link(s, extract_json_number(&st, "link")),
            Err(r) => return Ok(r),
        };
        // THE SAME QUESTION `run` ASKS, over the same fence and by the same function.  Since
        // 11 Oct 2026 the verifier runs behind the hand's verifier fence (`verifier_fence` in
        // hand/src/verify.rs), and its INPUT is still only a name looked up in the tracked tree's
        // own `dev/`, so nothing the model wrote reaches a program, an argument or a path.  The
        // one thing that could make this output a stranger's
        // words is therefore the TURN working somewhere a stranger's words live, which is exactly
        // what the fence states: an unbounded turn's fence IS the granted root and still answers
        // yes, mailbox and all, while a Diamond bounded to its own folder answers no.
        //
        // Before this, the answer was yes unconditionally, and on 2026-09-13 that cost a live
        // daimon its network on its own verifier's output (`dev/HATES.md`, turn 54).
        let tainting = fence_reaches_untrusted(&command_fence(&ctx.no_write, &machine, true),
            &machine);
        let res = res!(ctx.host().exec().run(&spec).await);
        let out = Self::verify_result(&name, &res, ctx, tainting);
        // AND WHO ANSWERED, from the handshake rather than from the report -- because the one
        // case that has to be named is the report saying nothing at all. See
        // `Tool::verify_hand_note`.
        let note = Self::verify_hand_note(
            &machine.caps, extract_json_bool(args, "world") == Some(true), &out);
        Ok(fmt!("{}{}", out, note))
    }


    /// Start, stop or list a static server for a folder on this computer.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments: `act`, and `path`/`port` or `id`.
    /// * `ctx` - The turn, whose bounds decide where a folder may be served from.
    pub(super) async fn serve<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let act = extract_json_string(args, "act")
            .map(|a| a.trim().to_ascii_lowercase())
            .unwrap_or_else(|| fmt!("list"));
        match act.as_str() {
            "list" => {
                let listing = match ctx.host().exec().runs().await {
                    Ok(l)  => l,
                    Err(e) => return Ok(fmt!(
                        "The machine hand did not say what it is still running, so nothing here \
                        is evidence about any server. {}", e.plain())),
                };
                let mine: Vec<RunRow> = run_rows(&listing).into_iter()
                    .filter(|r| r.id.ends_with("-serve"))
                    .collect();
                if mine.is_empty() {
                    return Ok(fmt!("No server of Daimond's is running.\n"));
                }
                let mut s = fmt!("{} server(s) of Daimond's are running:\n\n", mine.len());
                for r in &mine {
                    s.push_str(&fmt!("  {}  {}  pid {}  {}\n", r.id, r.state, r.pid, r.what));
                }
                Ok(s)
            },
            "stop" => {
                let id = match extract_json_string(args, "id").filter(|i| !i.trim().is_empty()) {
                    Some(i) => i,
                    None    => return Ok(refusal_line(
                        "serve 'stop' needs the 'id' that 'start' or 'list' gave -- never a port, \
                        a process id or a path.")),
                };
                if let Err(e) = ctx.host().exec().signal(&id, "term").await {
                    return Ok(fmt!(
                        "Refused: '{}' could not be sent TERM. {} Ask serve {{\"act\":\"list\"}} \
                        what is running before naming one.", id, e.plain()));
                }
                // The listing AFTER the signal is the answer, exactly as `runs` has it: a
                // delivery that succeeded promises nothing about what the process did with it.
                let listing = match ctx.host().exec().runs().await {
                    Ok(l)  => l,
                    Err(e) => return Ok(fmt!(
                        "'{}' was sent TERM and the machine hand did not then say what is still \
                        running, so nothing here is evidence that it stopped. {}", id, e.plain())),
                };
                Ok(runs_report(&listing, Some((id.as_str(), "term"))))
            },
            "start" => Self::serve_start(args, ctx).await,
            other => Ok(refusal_line(&fmt!(
                "serve 'act' is '{}'; it is 'start', 'stop' or 'list'.",
                other.chars().take(40).collect::<String>()))),
        }
    }

    /// Stand a static server up for one folder and report what the listing shows.
    pub(super) async fn serve_start<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let raw = match extract_json_string(args, "path").filter(|p| !p.trim().is_empty()) {
            Some(p) => p,
            None    => return Ok(refusal_line(
                "serve 'start' needs the 'path' of the folder to serve, workspace-relative and \
                inside a folder on this computer added to the workspace.")),
        };
        // A WORKER NEVER SERVES. Nobody is reading its transcript, so nobody would see the URL,
        // and its network is withheld in any case -- said as its own sentence rather than let
        // fall out of the network refusal below, because the two have different answers.
        if ctx.is_unsupervised() {
            return Ok(refusal_line(
                "a worker never serves: nobody is watching its screen, so there would be nobody \
                to show the page to. Report what you have and let the daimon or the user serve \
                it."));
        }
        let path = res!(Self::scoped(ctx, &raw));
        // A folder in the browser's own storage has nothing that could listen for it.
        match reach_of(ctx, &raw, &path, Door::Look).await {
            Reach::Refuse(why) => return Ok(refusal_line(&why)),
            Reach::Storage     => return Ok(refusal_line(&fmt!(
                "'{}' is in Daimond's storage, not on this computer, so nothing can listen for \
                it. A single HTML file in the workspace can be shown with web_open('{}'); to \
                serve a FOLDER, ask the user to add one on this computer with the + in the Workspace group.",
                raw, raw))),
            Reach::Machine { abs, .. } => {
                // The network question, asked before anything is composed: a turn that has read
                // a stranger's words has no network, and a server that cannot bind is not a
                // server. `net_step` answers `Withhold` for a worker with nobody to ask.
                if let NetStep::Withhold = net_step(
                    mode(), ctx.net_risk(), ctx.is_unsupervised(), ctx.net_consent())
                {
                    return Ok(refusal_line(
                        "this turn has no network, so nothing in it can listen on a port. That \
                        happens once a turn has read content from outside the workspace. Ask in \
                        a new message for a server, or show a single file with web_open."));
                }
                let port = match extract_json_number(args, "port") {
                    Some(n) if (1_024..=65_535).contains(&n) => n as u16,
                    Some(n) => return Ok(refusal_line(&fmt!(
                        "port {} is not one a program may bind here; give one between 1024 and \
                        65535, or leave 'port' out.", n))),
                    None => SERVE_PORT_BASE,
                };
                let argv = serve_argv(port, &abs);
                match res!(Self::run_exec(Self::Serve.name(), "serve", &argv, Some(raw.clone()),
                    Self::SERVE_TIMEOUT_MS, None, ctx, false).await)
                {
                    Exec::Refused(why) => Ok(why),
                    Exec::Ran { res, .. } => {
                        // `setsid -f` returns at once, so the exec's own exit code says only that
                        // the fork happened. What is standing is the question, and the hand is
                        // the only thing that can answer it.
                        if let Some(reason) = extract_json_string(&res, "refused") {
                            return Ok(refusal_line(&reason));
                        }
                        let id = Self::run_id("serve", ctx);
                        let listing = match ctx.host().exec().runs().await {
                            Ok(l)  => l,
                            Err(e) => return Ok(fmt!(
                                "The command was sent and the machine hand did not then say what \
                                is running, so nothing here says whether {} is being served. {}",
                                abs, e.plain())),
                        };
                        Ok(serve_started(&id, &abs, port, &listing))
                    },
                }
            },
        }
    }

    /// Say what this hand is still running, and stop one of them.
    ///
    /// Short, like [`Tool::verify`] and for the opposite reason: there is no fence to build
    /// because there is nothing here a fence could be built out of.  The only thing the model
    /// supplies is an identifier this app itself issued, and the hand will not act on one it did
    /// not issue -- so the whole of the decision is [`runs_step`], which is pure and tested, and
    /// the whole of the answer is [`runs_report`] over a listing the hand MEASURED.
    ///
    /// # Arguments
    /// * `args` - The raw tool arguments.
    /// * `ctx` - The turn, which is not consulted: a run is the hand's, not a turn's.
    pub(super) async fn runs<H: Host>(args: &str, ctx: &ToolContext<H>) -> Outcome<String> {
        let stop = match runs_step(args) {
            RunsStep::Refuse(why) => return Ok(why),
            RunsStep::List        => None,
            RunsStep::Stop(id, sig) => Some((id, sig)),
            // Answered from the page and not from the machine: what a reload left behind is held
            // there, and the hand was never told the page went away in the first place.
            RunsStep::Read(id) => {
                let answer = match ctx.host().exec().held(&id).await {
                    Ok(a)  => a,
                    Err(e) => return Ok(fmt!(
                        "The output held for '{}' could not be read, so nothing here says whether \
                        there is any. {}", id, e.plain())),
                };
                return Ok(runs_read_report(&id, &answer));
            },
        };
        // **No `status()` gate, and that is a decision rather than an omission.**  Every other
        // route to the hand refuses on `paired`, which `hand/REVIEW.md` §1.14 makes false wherever
        // the page cannot PROVE that the folder it has open is the folder the hand was granted.
        // That rule stands where it was written: it stops a command running against files nobody
        // meant it to touch.  Nothing here runs, reads or writes anything -- one question about
        // what the hand itself started, and one signal to a group it started -- so the rule has
        // nothing to protect, and applying it would make a leaked server unstoppable on exactly
        // the workspaces where it is easiest to leak one: a chat whose folder lives in the
        // browser can never satisfy §1.14, so `runs` would have been built and unreachable.
        //
        // What is left of the gate is the honest half: with no hand there is no link, so the calls
        // below reject with the sentence the relay already writes for a model to act on.
        //
        // The signal first, then the measurement, and the measurement is the answer. A failed
        // delivery comes back as an error here; a delivery that succeeded promises nothing, which
        // is why the listing below is taken afterwards rather than believed instead.
        if let Some((id, sig)) = &stop {
            if let Err(e) = ctx.host().exec().signal(id, sig).await {
                return Ok(fmt!(
                    "Refused: '{}' could not be sent {}. {} Ask what is running before naming one: \
                    only a run this hand started can be named at all.",
                    id, sig.to_uppercase(), e.plain()));
            }
        }
        let listing = match ctx.host().exec().runs().await {
            Ok(l)  => l,
            Err(e) => return Ok(fmt!(
                "The machine hand did not say what it is still running, so nothing here is \
                evidence about anything{}. {}",
                match &stop { Some((id, _)) => fmt!(", '{}' included", id), None => String::new() },
                e.plain())),
        };
        Ok(runs_report(&listing, stop.as_ref().map(|(i, g)| (i.as_str(), g.as_str()))))
    }
}



// ── serve: a static server for a folder, page-side only ──────────────
//
// **How the stray localhost tab happens today.** `run ["bash","dev/world.sh","3","--up"]` starts a
// server in the background; the hand tracks the process group that outlives the command as
// STANDING, and only `runs` can stop it. The model then reaches for `web_open`, and on an https
// origin the browser will not frame an `http://localhost` page, so a tab appears. What `run`
// cannot do: there is no shell, so no `&`; a foreground server blocks until `timeout_ms` and is
// then killed; and a turn with the network withheld cannot bind at all.
//
// **This is the minimal honest version: a composed argv through the same exec door, and then a
// LISTING.** `setsid -f` forks and exits at once, so the direct child returns and the server
// stands in its own group -- exactly the shape the hand already tracks and `runs` already stops.
// What comes back is only what the listing shows: an entry for this run means it started, none
// means it did not, and the result says which two causes it cannot tell apart. A `Req::Serve`
// verb in the hand, with its own loopback server and no python3 dependency, is phase two and is
// deliberately not here.

/// The first port a server is offered when the call does not name one.
pub(super) const SERVE_PORT_BASE: u16 = 8_800;

/// The command one `serve start` becomes.
///
/// **An argv and never a shell line**, like everything else that reaches the hand: `setsid -f`
/// is what detaches it, and there is nothing here for a `&` to be needed for.
///
/// # Arguments
/// * `port` - The loopback port to listen on.
/// * `abs` - The folder to serve, as an absolute path on the machine.
pub(super) fn serve_argv(port: u16, abs: &str) -> Vec<String> {
    vec![
        fmt!("setsid"),
        fmt!("-f"),
        fmt!("python3"),
        fmt!("-m"),
        fmt!("http.server"),
        fmt!("{}", port),
        fmt!("--bind"),
        fmt!("127.0.0.1"),
        fmt!("--directory"),
        fmt!("{}", abs),
    ]
}

/// What `serve start` says, given the listing taken AFTER the command returned.
///
/// **Only what the listing shows.**  A start that says "serving" because the exec returned zero
/// is a start that says it about a port already taken and a python3 that is not installed, and
/// the model then sends the user to a URL nothing is answering.
///
/// # Arguments
/// * `id` - The run identifier this start was given.
/// * `listing` - The hand's `runs` answer, taken after the command returned.
pub(super) fn serve_started(id: &str, abs: &str, port: u16, listing: &str) -> String {
    if run_rows(listing).iter().any(|r| r.id == id) {
        return fmt!(
            "Serving {} at http://127.0.0.1:{} (id {}). It stays up after this turn, so stop it \
            with serve {{\"act\":\"stop\",\"id\":\"{}\"}} before you finish, or with runs. Show it \
            with web_open; on an https page the browser will not frame http://localhost and will \
            open a tab instead.\n",
            abs, port, id, id);
    }
    fmt!(
        "Nothing is serving {}: the run is not in the listing taken after the command returned. \
        Two causes look the same from here and this cannot tell them apart -- port {} was \
        already taken, or python3 is not on this machine. Try another 'port', and ask runs what \
        is standing.\n", abs, port)
}

// ── verify with no name: THIS PROJECT's own check ────────────────────
//
// `verify <name>` runs a verifier out of the tracked tree, outside the command fence, justified
// by provenance: the model supplies a NAME the hand looks up, never an argument vector. That is
// the narrow case and it stays narrow. The broad one -- "does this project pass its own tests" --
// was refused outright, and the model was told to use `run`, which is one more thing for it to
// get right about a project it has just been handed.
//
// **The command comes from a DECLARATION, and it runs inside the fence.** A declaration because
// the hand has no shell, so what it needs is an argv and `package.json`'s `"test": "node --test"`
// is a shell line; `.daimond/verify.json` because every fence already denies that directory, so
// a command cannot rewrite the file that decides how it is judged. Inside the fence because a
// daimon's ordinary turn CAN write that file with `file_write` -- only a command is stopped --
// so the command it names is model-reachable in effect and gets the fence, the toolkits, the
// network question and the consent rung exactly as `run` does.

/// Which manifests a project root holds, as the inference reads them.
#[derive(Default, Clone, Copy)]
pub(super) struct Manifests {
    pub(super) cargo:  bool,
    /// A `package.json` WITH a `scripts.test`; without one there is nothing to run.
    pub(super) npm:    bool,
    pub(super) pytest: bool,
    pub(super) go:     bool,
}

/// What a project's own check is, and where that was written down.
#[derive(Debug)]
pub(super) struct ProjectVerify {
    pub(super) argv:    Vec<String>,
    /// Relative to the project root, as the declaration wrote it.
    pub(super) cwd:     String,
    pub(super) timeout: u64,
    /// Named in the result, because "it ran cargo test" and "somebody declared cargo test" are
    /// different facts and the model is about to report one of them.
    pub(super) source:  String,
}

/// The default budget for a project's own check.
pub(super) const VERIFY_PROJECT_DEFAULT_MS: u64 = 10 * 60 * 1_000;

/// Does this `package.json` declare a test script?
pub(super) fn npm_test_script(text: &str) -> bool {
    // The `scripts` object, then `test` inside it: a top-level `"test"` key somewhere else in the
    // file is not a script, and npm would not run it.
    match text.find("\"scripts\"") {
        Some(i) => text[i..].find("\"test\"").is_some(),
        None    => false,
    }
}

/// The command this project is verified by, or the sentence refusing to guess.
///
/// # Arguments
/// * `decl` - The text of `.daimond/verify.json`, where the project has one.
/// * `has` - Which manifests the project root holds, for the inference.
pub(super) fn project_verify_argv(decl: Option<&str>, has: Manifests) -> Result<ProjectVerify, String> {
    if let Some(text) = decl {
        // A shell line, spelled as one string. Refused by NAME rather than split on spaces: the
        // hand has no shell, and splitting one here would invent a command nobody wrote.
        if extract_json_string_array(text, "argv").is_none() {
            if extract_json_string(text, "argv").is_some() {
                return Err(fmt!(
                    "Refused: .daimond/verify.json gives 'argv' as one string. There is no shell \
                    here, so it must be an array -- the program, then each argument separately, \
                    as [\"npm\",\"test\"] and never \"npm test\"."));
            }
            return Err(fmt!(
                "Refused: .daimond/verify.json has no 'argv'. Write it as \
                {{\"argv\":[\"cargo\",\"test\"]}}, with the program and each argument separate."));
        }
        let argv = extract_json_string_array(text, "argv").unwrap_or_default();
        if argv.is_empty() || argv[0].trim().is_empty() {
            return Err(fmt!(
                "Refused: .daimond/verify.json gives an empty 'argv', so there is no program to \
                run."));
        }
        return Ok(ProjectVerify {
            argv,
            cwd:     extract_json_string(text, "cwd").unwrap_or_else(|| fmt!(".")),
            timeout: extract_json_number(text, "timeout_ms")
                .unwrap_or(VERIFY_PROJECT_DEFAULT_MS),
            source:  fmt!("declared in .daimond/verify.json"),
        });
    }
    // The inference, in the order a monorepo's root is most likely to mean. Each names its own
    // source in the result, because a guess reported as a declaration is a guess nobody can see.
    let guess = |argv: Vec<&str>, from: &str| -> Result<ProjectVerify, String> {
        Ok(ProjectVerify {
            argv:    argv.iter().map(|a| a.to_string()).collect(),
            cwd:     fmt!("."),
            timeout: VERIFY_PROJECT_DEFAULT_MS,
            source:  fmt!("inferred from {}", from),
        })
    };
    if has.cargo  { return guess(vec!["cargo", "test"], "Cargo.toml"); }
    if has.npm    { return guess(vec!["npm", "test"], "package.json"); }
    if has.pytest { return guess(vec!["python3", "-m", "pytest", "-q"], "pyproject.toml"); }
    if has.go     { return guess(vec!["go", "test", "./..."], "go.mod"); }
    Err(fmt!(
        "Refused: nothing says how this project is verified. Write .daimond/verify.json as \
        {{\"argv\":[\"...\"]}}, or add a Cargo.toml, a package.json test script, a pyproject.toml \
        or a go.mod. Give 'name' instead to run one of this repository's own dev/verify_*.mjs."))
}

/// The pass and fail counts a runner this build knows how to read printed, with its name.
///
/// **The exit code is the truth and this is a convenience.**  A runner whose output changes
/// shape answers `None` here and the result says so, rather than reporting a count it guessed.
pub(super) fn verify_summary(out: &str) -> Option<(usize, usize)> {
    // node's TAP trailer, which names its counts after the word.
    if let (Some(p), Some(f)) = (after_word(out, "# pass "), after_word(out, "# fail ")) {
        return Some((p, f));
    }
    // cargo, whose one line carries both words whether the run passed or failed.
    if let Some(i) = out.rfind("test result:") {
        let line = out[i..].lines().next().unwrap_or("");
        if let (Some(p), Some(f)) = (before_word(line, " passed"), before_word(line, " failed")) {
            return Some((p, f));
        }
    }
    // pytest, which says "N passed" always and "M failed" only when some did.
    if let Some(p) = before_word(out, " passed") {
        return Some((p, before_word(out, " failed").unwrap_or(0)));
    }
    None
}

/// The number written immediately after `word`, e.g. the 17 of "# pass 17".
pub(super) fn after_word(text: &str, word: &str) -> Option<usize> {
    let i = text.rfind(word)? + word.len();
    let digits: String = text[i..].trim_start()
        .chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<usize>().ok()
}

/// The number written immediately before `word`, e.g. the 17 of "17 passed".
pub(super) fn before_word(text: &str, word: &str) -> Option<usize> {
    let i = text.rfind(word)?;
    let mut digits: Vec<char> = text[..i].chars().rev()
        .take_while(|c| c.is_ascii_digit()).collect();
    digits.reverse();
    digits.into_iter().collect::<String>().parse::<usize>().ok()
}

/// What became of a command handed to [`Tool::run_exec`].
///
/// The two halves are kept apart because they are read by different code: a refusal is Daimond
/// speaking, in a sentence the model acts on directly, and a result is the hand's, which each
/// caller shapes for itself -- `run_result` for a command, `verify_project_result` for a check.
/// A refusal dressed as a program's stderr is a model fixing the wrong thing.
pub(super) enum Exec {
    /// It did not run, and this says why.
    Refused(String),
    /// It ran.  `no_net`, `tainting` and `read_only` are properties of the fence it ran INSIDE,
    /// captured beside it rather than re-derived afterwards -- see [`Tool::run_result`].
    Ran {
        res:       String,
        no_net:    NetCut,
        tainting:  bool,
        read_only: bool,    // nothing was writable: the hand does not meter removals
        after:     String,  // the toolchain question a "not found" raised, answered
    },
}

/// What a command's result says when a walk met the one directory every fence denies.
///
/// Written for the model to act on: it names the cause, says the results are otherwise complete,
/// says not to treat the exit code as a failure, and says what to do differently.  A walk that
/// stopped on `.daimond` and reported "Permission denied" is the single most likely way an agent
/// meets the fence without being told it has.
pub(super) const DENIED_DIR_NOTE: &str =
    "\n[the '.daimond' directory is Daimond's own, and every command is denied it -- that is the \
    fence working, not a broken permission. A walk of the whole workspace (find, du, tar, grep -r) \
    reports it and then exits non-zero even though everything else was read, so the results above \
    are complete apart from that one directory. Do not re-run it with sudo or hunt for the cause: \
    start the walk lower down, or exclude that directory, and read the non-zero status as this and \
    not as a failure.]";

/// What a command's result says when its stderr shows a symbolic link the fence denied, however
/// the command reached it.
///
/// Written for the model to act on, exactly like [`DENIED_DIR_NOTE`] beside it: it names the
/// cause, says it is the fence working rather than a fault, and says not to retry or install
/// anything to fix it. Phrased for AFTER the run, unlike `symlink_refusal`'s pre-emptive sentence
/// -- this one describes what already happened rather than what is about to be refused.
pub(super) const SYMLINK_DENIED_NOTE: &str =
    "\n[that command tried to create a symbolic link, and a fenced command cannot create one \
    anywhere -- not in the folders it may write, not in its own scratch directory. That is the \
    fence working, not a transient permission error and not something a retry or an install \
    fixes: the capability is withheld by design, because a link is half of a leak, including into \
    the Ore replica this tree records into, which absorbs the CONTENT of a link that leaves the \
    working copy into a signed history that cannot forget. Do not retry it or chase the \
    permission as if it were a bug. Where a reference inside the workspace will do, copy instead \
    -- 'cp -r' for a directory, a plain 'cp' for a file -- and reach for a hard link only where \
    the target is a single file on the same filesystem; where the link genuinely needs to reach \
    outside the workspace, ask the user to make it themselves.]";

/// What a command's result says when the turn ran it with the network refused.
///
/// Written for the model to act on rather than to explain: it names the cause, says the project is
/// not at fault, tells it not to retry, and says what to do instead. A rule with no reason
/// attached is a rule a model argues with, and a build error with no cause attached is one it
/// reports as a broken project (`hand/REVIEW.md` §1.13).
pub(super) const NO_NET_NOTE: &str =
    "\n[no network: this turn has already read content from outside your workspace, so a command \
    in it reaches the network only if the user says it may, and this one did not get that -- they \
    declined, or there was nobody to ask. A fetch, install or clone fails for that reason and not \
    because the project is broken — say so rather than retrying, and ask in a new message for \
    anything that needs to reach out.]";

/// Whether a command ran without the network, and on whose rule (D-20261024-01).
///
/// Two rules take it, and they need different sentences.  The hand's is a question: the user
/// said no, or nobody was there to say yes.  The runner's (Kimberlite, a whole-home machine) asks
/// nobody: a chat that has read outside content runs its commands offline, automatically, and a
/// new chat has the network again.  Telling a runner's model to ask is telling it to put a
/// question that has no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetCut {
    Online,     // the command had the network
    Asked,      // the hand's rule: withheld for want of a yes
    Tainted,    // the runner's rule: the chat read outside content
}

impl NetCut {

    /// What a command built on a fence with network `net` ran under, on a whole-home machine or not.
    pub fn of(net: bool, whole_home: bool) -> Self {
        match (net, whole_home) {
            (true,  _)      => Self::Online,
            (false, true)   => Self::Tainted,
            (false, false)  => Self::Asked,
        }
    }

    /// The line a command's result ends with when it ran offline; empty where it did not.
    pub fn note(self) -> &'static str {
        match self {
            Self::Online    => "",
            Self::Asked     => NO_NET_NOTE,
            Self::Tainted   => RUNNER_NO_NET_NOTE,
        }
    }
}

/// What a runner's command result says after Kimberlite's own reason for withholding the network.
pub(super) const RUNNER_NO_NET_RULE: &str = runner_no_net_rule!();

/// [`NO_NET_NOTE`] on a whole-home machine, where nobody is asked (D-20261024-01).
pub(super) const RUNNER_NO_NET_NOTE: &str = concat!("\n[no network: this chat has read content from outside \
    the user's own files, so its commands now run offline. ", runner_no_net_rule!(), "]");

/// What a command's result says when every folder was read-only to it (see [`command_fence`]).
///
/// Written for the model to act on, as [`NO_NET_NOTE`] is: the cause, that the command is not at
/// fault, what still works, and whose move it is.
pub(super) const READ_ONLY_NOTE: &str =
    "\n[read-only: the machine hand on this computer is older than the deletion meter, so every \
    folder was read-only to this command -- it could read, and could not write, create, remove or \
    rename anything. A 'Permission denied' or 'Read-only file system' above is that and not a \
    fault in the command. Nor can a file tool change anything there: nothing is written through \
    this hand until the user updates it, which Daimond has already told them how to do.]";

/// What identifies [`NO_NET_NOTE`] in a result the browser is holding.
///
/// The note is prose and will be reworded; its opening is not, so this is what a reader matches
/// on.  Held to the note it stands for by
/// `test_the_no_network_mark_opens_the_note_and_finds_it_in_a_result`, because a mark that has
/// drifted from its note is a surface that goes quiet without anything failing.
#[cfg(any(target_arch = "wasm32", test))]
pub const NO_NET_MARK: &str = "[no network:";

/// Did the command behind this result run with the network refused?
///
/// Asked of the RESULT rather than of the chat, and the difference is the whole point of the
/// function: [`crate::wasm::app::DaimondApp::net_state`] says what the NEXT command would get,
/// where a page drawing a line about the command that has just come back has to say what THAT
/// one got.  The note is written beside the fence it was built from, so the result carries the
/// answer and nothing has to be re-derived.
///
/// # Arguments
/// * `result` - A tool result, as the page received it.
#[cfg(any(target_arch = "wasm32", test))]
pub fn ran_without_net(result: &str) -> bool {
    result.contains(NO_NET_MARK)
}

// The most bytes of a command the spend notice will write back into the call it suggests.
//
// Past this the suggestion names the argument instead of the whole call: a hundred-argument
// command line quoted back would cost more than the bytes the notice is saving.
pub(super) const SPEND_ARGV_MAX: usize = 240;

// The longest an argument may be and still be quoted back as the file the command was about.
//
// A model-chosen argument is unbounded, and a notice that repeats a kilobyte of it twice costs
// more than the bytes it is saving.
pub(super) const SPEND_SUBJECT_MAX: usize = 200;

/// Which command door a spend notice is speaking through.
///
/// Two doors reach a process -- `run` in the browser, through the machine hand, and `shell` on the
/// native build -- and they take their command in different shapes.  A notice that told the shell
/// door to send an `argv` array would be a refusal the model cannot act on, which is the one thing
/// this notice must never be.
pub(super) enum SpendCall<'a> {
    Argv(&'a [String]),     // `run`: the program and each argument, separately
    Command(&'a str),       // `shell`: one command line
}

impl<'a> SpendCall<'a> {

    /// The tool's own name, for the tag on every line of the notice.
    pub(super) fn tool(&self) -> &'static str {
        match self {
            Self::Argv(_)    => "run",
            Self::Command(_) => "shell",
        }
    }

    /// The cheaper questions, spelled the way THIS door takes them.
    pub(super) fn narrower(&self) -> &'static str {
        match self {
            Self::Argv(_) =>
                "\"grep\",\"-n\",\"<what you are looking for>\",\"<file>\" for a name; \
                \"sed\",\"-n\",\"400,460p\",\"<file>\" for a region you can already name; \
                \"wc\",\"-l\",\"<file>\" for a count; \"head\" or \"tail\" for the ends",
            Self::Command(_) =>
                "grep -n <what you are looking for> <file> for a name; sed -n '400,460p' <file> \
                for a region you can already name; wc -l <file> for a count; head or tail for \
                the ends",
        }
    }

    /// The file this command was about, as the notice's own suggestions should name it.
    ///
    /// The first argument that is not the program, does not begin with `-`, and looks like a path
    /// -- it holds a `/` or a `.`.  A guess, and a cheap one: where it guesses wrong the model is
    /// handed a runnable shape with the wrong name in it and fixes the name, and where nothing
    /// looks like a path it falls back to a placeholder rather than inventing one.
    pub(super) fn subject(&self) -> String {
        let looks = |a: &str| !a.starts_with('-')
            && (a.contains('/') || a.contains('.'))
            && a.len() <= SPEND_SUBJECT_MAX;
        let found = match self {
            Self::Argv(argv)   => argv.iter().skip(1)
                                    .find(|a| looks(a)).cloned(),
            Self::Command(cmd) => cmd.split_whitespace().skip(1)
                                    .find(|a| looks(a)).map(|a| a.to_string()),
        };
        found.unwrap_or_else(|| fmt!("<file>"))
    }

    /// The two calls that read a file in parts, spelled for THIS door and naming THIS file.
    ///
    /// Named rather than described because a sentence that names an action is the only kind this
    /// codebase has measured moving a model: a brief naming `file_search` was the first thing that
    /// made an arm reach for the search door, and a brief forbidding `cargo` changed nothing at
    /// all.  So where there is no number left to offer, what goes in its place is a call, not a
    /// prohibition.
    ///
    /// The placeholders differ by door on purpose.  `run` takes an argv array and no shell reads
    /// it, so `<what you are looking for>` arrives literally; the same angle brackets on a shell
    /// command line are redirections, so that door is given a word instead.
    pub(super) fn in_parts(&self) -> (String, String) {
        let f = self.subject();
        match self {
            Self::Argv(_) => (
                fmt!("{{\"argv\":[\"grep\",\"-n\",\"<what you are looking for>\",\"{}\"]}}",
                    json_escape(&f)),
                fmt!("{{\"argv\":[\"sed\",\"-n\",\"400,460p\",\"{}\"]}}", json_escape(&f)),
            ),
            Self::Command(_) => (
                fmt!("grep -n PATTERN {}", f),
                fmt!("sed -n '400,460p' {}", f),
            ),
        }
    }

    /// The exact call that takes `ask` bytes of the same command's output.
    ///
    /// # Arguments
    /// * `ask` - The `max_bytes` the model would have to name.
    pub(super) fn retry(&self, ask: usize) -> String {
        match self {
            Self::Argv(argv) => {
                let parts: Vec<String> =
                    argv.iter().map(|a| fmt!("\"{}\"", json_escape(a))).collect();
                let whole = fmt!("[{}]", parts.join(","));
                if whole.len() <= SPEND_ARGV_MAX {
                    fmt!("{{\"argv\":{},\"max_bytes\":{}}}", whole, ask)
                } else {
                    fmt!("the same argv with \"max_bytes\":{} added", ask)
                }
            },
            Self::Command(cmd) => {
                let q = fmt!("\"{}\"", json_escape(cmd));
                if q.len() <= SPEND_ARGV_MAX {
                    fmt!("{{\"command\":{},\"max_bytes\":{}}}", q, ask)
                } else {
                    fmt!("the same command with \"max_bytes\":{} added", ask)
                }
            },
        }
    }
}

/// Cut a command's output to what the call agreed to spend, and say so where it did.
///
/// **The one gate both command doors go through.**  `run` and `shell` had the same hole -- the cap
/// was applied after the fact and the model was told afterwards -- and two answers to it would
/// eventually be two different answers.  What it cannot do is stand in FRONT of the command: a
/// pipeline's output has no size until it has run.  So it stands in front of the conversation,
/// which is where the cost actually is.
///
/// # Arguments
/// * `s` - The command's output, already defanged, cut in place where it is too big.
/// * `call` - Which door this is, and what was run.
/// * `cap` - What the call asked for, or `None` where it asked for nothing.
/// * `room` - The most this result could carry whatever was asked.
/// * `left` - What the TURN has left of [`TURN_SPEND_BUDGET`], from
///   [`ToolContext::spend_left`].  Never bounds a result below [`RUN_SPEND_MIN`]: a turn out of
///   budget is narrowed to the size of an answer, not stopped, because a refusal with no way
///   through ends the turn and that is the worst outcome there is.
pub(super) fn spend_gate(
    s:     &mut String,
    call:  SpendCall<'_>,
    cap:   Option<usize>,
    room:  usize,
    left:  usize,
)
    -> Option<String>
{
    let asked = cap.is_some();
    let want  = cap.unwrap_or(RUN_SPEND_UNASKED);
    // The floor, and the whole of what "the budget is gone" means here.
    let left  = left.max(RUN_SPEND_MIN);
    let cap   = want.min(room).min(left);
    let total = s.len();
    if total <= cap {
        return None;
    }
    // Which of the three ceilings actually bound this result, because each wants a different
    // sentence and a model told the wrong one repairs the wrong thing. The turn's wins ties: it is
    // the one a larger `max_bytes` cannot lift, so it must not be reported as one that can.
    let limit = if left <= want.min(room) {
        SpendLimit::Turn
    } else if room <= want {
        SpendLimit::Result
    } else if asked {
        SpendLimit::Ask
    } else {
        SpendLimit::Unasked
    };
    // A call that named a number gets that number. A call that named none gets a PEEK, which is a
    // quarter of even the unasked ceiling: what it is short of is the price, not the bytes.
    *s = head_and_tail(s, if asked { cap } else { RUN_PEEK.min(cap) });
    Some(spend_notice(call, total, cap, room, left, limit))
}

/// The most of a command's output this call agreed to take into the conversation.
///
/// `None` and `Some(RUN_SPEND_UNASKED)` are different answers and the difference is the whole
/// design: a call that said nothing gets a peek and the price, and a call that named a number gets
/// that number.  Reading an absent argument as its default would collapse the two.
///
/// # Arguments
/// * `args` - The raw tool arguments, read for `max_bytes`.
pub(super) fn spend_cap(args: &str) -> Option<usize> {
    if !arg_given(args, "max_bytes") {
        return None;
    }
    Some(uint_arg(args, "max_bytes", RUN_SPEND_UNASKED, MAX_OUTPUT).max(RUN_SPEND_MIN))
}

// What a spend notice says when the TURN is the ceiling, and the one place it is spelled.
//
// Named once because three things read it: the notice writes it, `ToolRegistry::with_budget_line`
// withholds the turn's own line when it is already there, and a check asserts it.  A second
// paragraph repeating the first is the noise that teaches a reader to skip the one that matters.
pub(super) const TURN_SPENT_SAID: &str = "THIS TURN HAS TAKEN WHAT IT CAN TAKE IN WHOLE FILES";

// The opening of every spend notice, and the tell that a result already carries one.
pub(super) const SPEND_NOTICE_MARK: &str = "] the command printed ";

/// A size a model can judge and cannot spend.
///
/// **The exact byte count was itself an argument.**  A refusal that ends *"the command printed
/// 1233315 bytes"* has handed a model an integer, and `max_bytes` silently clamps anything past
/// [`MAX_OUTPUT`] -- so copying it back buys the whole result ceiling, which is the very thing the
/// refusal was declining to spend.  Rendered with a unit it says the same decision-relevant thing
/// -- this is enormous, do not take it whole -- and is no longer a number to paste.
///
/// The one exact figure left anywhere in a spend notice is the `max_bytes` of an offer that will
/// actually be honoured.
///
/// # Arguments
/// * `n` - Bytes.
pub(super) fn in_units(n: usize) -> String {
    if n < 1_000 {
        return fmt!("{} bytes", n);
    }
    if n < 1_000_000 {
        return fmt!("{} KB", (n + 500) / 1_000);
    }
    fmt!("{}.{} MB", n / 1_000_000, (n % 1_000_000) / 100_000)
}

/// Which ceiling bound a result, because each one wants a different sentence.
///
/// A model told the wrong reason repairs the wrong thing: told "ask for more" when no larger
/// number exists, it asks for more.  That is not hypothetical.  On 2026-08-25 a refusal ended
/// *"79727 bytes is the most any one tool result can carry, so there is no larger number to ask
/// for"*, and the daimon's very next call was `{"argv":["cat","-n",…],"max_bytes":79727}`.  The
/// sentence meant "do not bother asking"; it was read as "ask for this", and every guard behind it
/// then worked exactly as designed, because a call naming `max_bytes` has by definition asked.
pub(super) enum SpendLimit {
    Ask,        // the call named a number, and the output is past it
    Unasked,    // the call named none, so `RUN_SPEND_UNASKED` applied
    Result,     // one result cannot carry more, whatever is asked
    Turn,       // this turn has taken what it can take in whole files
}

/// What the model reads when a command printed more than this call agreed to spend.
///
/// **Judged by the sentence and not by the cap.**  A lane learned on `file_edit` that a refusal
/// which does not say how to succeed costs the run anyway, so the notice always carries the SIZE,
/// so the model knows what it turned down, and always carries A CALL IT CAN MAKE NEXT.
///
/// **What that next call is depends on whether a number can still help**, and this is the fix for
/// the fault in [`SpendLimit`].  Where a larger `max_bytes` would work, it is named -- that is the
/// escape hatch the whole design rests on, and without it this trades an expensive success for a
/// cheap failure.  Where a larger `max_bytes` CANNOT work -- at the result ceiling, or with the
/// turn's budget spent -- no byte figure is named at all, because the evidence says a number in a
/// refusal is read as an argument to pass whatever the words around it say.  What goes there
/// instead is the `grep -n` and the `sed -n` range, spelled for this door and naming this
/// command's own file.
///
/// # Arguments
/// * `call` - Which door this is, and what was run, for the calls it suggests.
/// * `total` - Bytes the command printed.
/// * `cap` - The ceiling this result was actually held to.
/// * `room` - The most any one result could carry, whatever is asked.
/// * `left` - What the turn has left, floor included, for the deliberate ask it may offer.
/// * `limit` - Which ceiling bound it, which decides everything after the first line.
pub(super) fn spend_notice(
    call:  SpendCall<'_>,
    total: usize,
    cap:   usize,
    room:  usize,
    left:  usize,
    limit: SpendLimit,
)
    -> String
{
    let tag = call.tool();
    // The size, and no second figure beside it. `shown` used to be here and is gone: it was a
    // number a model can legally pass as `max_bytes` to buy back exactly what it already had.
    let mut out = fmt!(
        "\n[{}{}{}. This result carries the head and the tail of it, with the middle cut out.",
        tag, SPEND_NOTICE_MARK, in_units(total));
    let (by_name, by_range) = call.in_parts();
    match limit {
        // No larger number exists. Naming one here is what sent a daimon round the loop this
        // whole notice exists to prevent, so what goes here is two calls and no figure.
        SpendLimit::Result => {
            out.push_str(&fmt!(
                "\n[{}] THIS IS THE LARGEST RESULT THERE IS, so the rest of that output cannot \
                arrive in one piece however it is asked for. Take it in parts: {} to find the \
                lines you want, then {} to read them.",
                tag, by_name, by_range));
            return out;
        },
        // The turn's own budget, which is the one ceiling a bigger `max_bytes` cannot lift. Said
        // as a state and a way through rather than as an allowance: a figure a model can see
        // approaching a wall is a figure it will spend to.
        SpendLimit::Turn => {
            out.push_str(&fmt!(
                "\n[{}] {}, so a larger max_bytes will not change this result and neither will \
                running it again. Nothing is stopped: a question whose ANSWER is small still \
                arrives whole -- {} for a name, {} for a range, and a count or a head or a tail \
                for the shape of it.",
                tag, TURN_SPENT_SAID, by_name, by_range));
            return out;
        },
        // A call that named a number is not lectured about the number it named.
        SpendLimit::Ask => {
            out.push_str(&fmt!(" This call asked for {} of it.", in_units(cap)));
        },
        SpendLimit::Unasked => {
            out.push_str(&fmt!(
                " More than {} in one result is not spent unless the call asks for it: a \
                tool result stays in the conversation for the rest of the turn and is sent again \
                on every later round, so a whole file read this way is paid for many times over.",
                in_units(cap)));
        },
    }
    out.push_str(&fmt!(
        "\n[{}] ASK A NARROWER QUESTION and you pay for the answer instead of the file: {}.",
        tag, call.narrower()));
    // The deliberate ask, offered only where it BUYS something. Below a kilobyte more than this
    // result already carries it is a menu item that costs a call and returns the same text, which
    // is the shape of failure the measured fault took.
    let ask = total.min(room).min(left);
    if ask >= cap.saturating_add(RUN_SPEND_MIN) {
        out.push_str(&fmt!(
            "\n[{}] OR TAKE IT DELIBERATELY, with {} -- and the same working directory you used. \
            That runs the command a second time, so do not do it with one that changes anything.",
            tag, call.retry(ask)));
        if ask < total {
            out.push_str(" Even then only part of it fits in one result.");
        }
    }
    out
}
