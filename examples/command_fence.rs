//! Prints the fence the page sends a hand for a command, composed from that hand's own handshake.
//!
//! `dev/verify_handdelete.mjs` runs this with the `hello` of each hand it drives, so the exec it
//! sends carries a fence built by `command_fence` -- the page's own function -- and not one the
//! verifier wrote out for itself (audit F2, 2026-09-23).  Beside it, as `spec`, is `fence_spec`:
//! what the page sent before the gate, which the verifier sends too, to show the window it closes.
//!
//!   cargo run --example command_fence -- '<status json>' [<mark> ...]
//!
//! `<status json>` is what `DaimondHand.status()` resolves: `{"paired":true,"root":...,"caps":[...]}`.
//! With no mark the turn is unscoped and the fence is the granted root, which is the owner's own
//! case; each mark is a folder, relative to the root, attached to one Diamond.

use oxedyne_daimond::tools::{
    command_fence,
    diamond_bounds,
    fence_spec,
    Machine,
};

use oxedyne_fe2o3_core::prelude::*;

fn main() -> Outcome<()> {
    let mut args = std::env::args().skip(1);
    let status = res!(args.next().ok_or_else(|| err!(
        "usage: command_fence '<status json>' [<mark> ...]"; Missing, Input)));
    let marks: Vec<String> = args.collect();
    let m = Machine::from_status(&status);
    if !m.rooted() {
        return Err(err!("the status names no granted root: {}", status; Missing, Input));
    }
    let bounds = if marks.is_empty() {
        Vec::new()
    } else {
        diamond_bounds("diamonds/verify", &marks, &[])
    };
    println!(r#"{{"command":{},"spec":{}}}"#,
        command_fence(&bounds, &m, false).to_json(),
        fence_spec(&bounds, &m, false).to_json());
    Ok(())
}
