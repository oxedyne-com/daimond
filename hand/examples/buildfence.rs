// buildfence -- can a fenced `cargo` compile this repository?
//
// Written on 2026-08-25 to settle BLOCKERS B6 with a measurement rather than an
// argument.  The question is whether a daimon can be given a truthful "does this
// build" through the ordinary `run` door, inside the fence that door applies.
// Reasoning about it is unreliable in the same way `fenceprobe` is kept for:
// Landlock's union semantics do not read the way they behave, and cargo's own
// failure for an unreadable path dependency is a manifest error rather than a
// permission one, so a reader who has not seen it guesses wrong.
//
//   cargo run --release --example buildfence --manifest-path hand/Cargo.toml -- <root>
//   cargo run --release --example buildfence --manifest-path hand/Cargo.toml -- <root> --with-fe2o3
//   cargo run --release --example buildfence --manifest-path hand/Cargo.toml -- <root> --with-fe2o3 --deny-history
//
// WHAT IT ANSWERED, 2026-08-25, measured on this machine and recorded here so the
// next reader does not have to spend the build: without fe2o3 the fenced cargo
// cannot read `fe2o3_core/Cargo.toml` and stops there with Permission denied;
// with fe2o3 read-only a COLD `cargo check` of the hand compiles four fe2o3
// crates from source in 12 s; and denying that tree's `.ore` and `.git` inside
// the same grant costs the build nothing while both histories stay refused.
//
// `<root>` is the folder the user granted, and defaults to the working
// directory.  The
// second form adds the fe2o3 tree read-only, which is the widening the blocker is
// asking about; the third denies that tree's `.ore` and `.git` inside the same
// grant, which is the question of whether the widening can be made narrow enough
// to be worth taking.  The three runs together say what each costs.
use daimond_hand::fence::{Fence, Unfenced};
use daimond_hand::wire::FenceSpec;

use std::path::PathBuf;
use std::process::Command;

// Where fe2o3 lives, which every crate in this repository depends on BY PATH.
// Overridable, because the answer is about the SHAPE of the dependency and not
// about this machine: set BUILDFENCE_FE2O3 to ask the same question elsewhere.
const FE2O3_DEFAULT: &str = "/home/jason/usr/code/rust/fe2o3";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let with_fe2o3   = args.iter().any(|a| a == "--with-fe2o3");
    let deny_history = args.iter().any(|a| a == "--deny-history");
    // A reflux fixture is a whole crate at the granted root, so the question there
    // is asked of the root itself rather than of `hand/`.
    let lib_here     = args.iter().any(|a| a == "--lib-here");
    let root = match args.iter().find(|a| !a.starts_with("--")) {
        Some(r) => r.clone(),
        None    => match std::env::current_dir() {
            Ok(d)  => format!("{}", d.display()),
            Err(e) => { println!("no root given and no working directory: {}", e); return; },
        },
    };
    let fe2o3 = std::env::var("BUILDFENCE_FE2O3")
        .unwrap_or_else(|_| FE2O3_DEFAULT.to_string());
    let home = match std::env::var("HOME") {
        Ok(h)  => h,
        Err(_) => { println!("no HOME, so no toolkit roots to compute."); return; },
    };
    // The rust toolkit's roots, exactly as `Toolkit::grants` names them in the
    // app and `TOOLKIT_ROOTS` clamps them in the hand.
    let mut rw: Vec<String> = vec![
        root.clone(),
        format!("{}/.cargo/registry", home),
        format!("{}/.cargo/git", home),
        format!("{}/.cargo/.package-cache", home),
        format!("{}/.cache/cargo-targets", home),
    ];
    let mut ro: Vec<String> = vec![
        format!("{}/.cargo/bin", home),
        format!("{}/.rustup", home),
    ];
    let mut deny: Vec<String> = Vec::new();
    if with_fe2o3 {
        ro.push(fe2o3.clone());
    }
    if deny_history {
        deny.push(format!("{}/.ore", fe2o3));
        deny.push(format!("{}/.git", fe2o3));
    }
    // A scratch, because `Scratch` gives every real run one and points TMPDIR at
    // it -- without it a fenced cargo dies part way through on a temp directory.
    let scratch = format!("{}/.cache/daimond/buildfence-scratch", home);
    if let Err(e) = std::fs::create_dir_all(&scratch) {
        println!("could not make a scratch at {}: {}", scratch, e);
        return;
    }
    rw.push(scratch.clone());

    let spec = FenceSpec { rw: rw.clone(), ro: ro.clone(), deny: deny.clone(), net: false };
    println!("root       {}", root);
    println!("rw         {}", rw.join("\n           "));
    println!("ro         {}", ro.join("\n           "));
    println!("deny       {}", if deny.is_empty() { "(none)".to_string() } else { deny.join("\n           ") });
    println!("net        false");

    let f = Fence::detect();
    let plan = match f.plan(&spec, &Unfenced::Refuse) {
        Ok(p)  => p,
        Err(e) => { println!("plan failed: {}", e); return; },
    };
    match plan.apply() {
        Ok(_)  => println!("--- fence applied ---"),
        Err(e) => { println!("apply failed: {}", e); return; },
    }

    // What the widening exposes, asked directly rather than inferred: a source
    // file of fe2o3, and then the two histories.  The signed one holds a key.
    for probe in [
        format!("{}/fe2o3_core/Cargo.toml", fe2o3),
        format!("{}/.ore/config", fe2o3),
        format!("{}/.git/HEAD", fe2o3),
    ] {
        println!("read {:<58} {}", probe,
            match std::fs::File::open(&probe) { Ok(_) => "PERMITTED", Err(_) => "refused" });
    }

    // The question, asked of the cheapest thing that has to read every manifest:
    // `cargo metadata` resolves the graph and nothing else, so a refusal here is
    // about READING the dependency and not about compiling it.
    let jobs = match lib_here {
        true  => vec![("check --lib, at the root", vec!["check", "--offline", "--lib",
                                                        "--message-format", "short"])],
        false => vec![
            ("metadata, repository root", vec!["metadata", "--offline", "--no-deps",
                                               "--format-version", "1", "--manifest-path", "Cargo.toml"]),
            ("check, the hand",           vec!["check", "--offline", "--message-format", "short",
                                               "--manifest-path", "hand/Cargo.toml"]),
        ],
    };
    for (what, argv) in jobs {
        let out = Command::new("cargo")
            .args(&argv)
            .current_dir(PathBuf::from(&root))
            .env_clear()
            .env("HOME", &home)
            .env("PATH", format!("{}/.cargo/bin:/usr/local/bin:/usr/bin:/bin", home))
            .env("TMPDIR", &scratch)
            // Inherited, so the probe measures the same build a caller would get.
            // Named explicitly rather than passed through by `env_clear`'s absence,
            // because a fenced cargo writing somewhere the fence does not grant is
            // the second way this question is answered wrongly.
            .env("CARGO_TARGET_DIR", std::env::var("CARGO_TARGET_DIR")
                 .unwrap_or_else(|_| format!("{}/.cache/cargo-targets/buildfence", home)))
            .output();
        match out {
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr);
                println!("\n== {} -> exit {:?}", what, o.status.code());
                for line in err.lines().take(8) {
                    println!("   {}", line);
                }
            },
            Err(e) => println!("\n== {} -> could not spawn cargo: {}", what, e),
        }
    }
}
