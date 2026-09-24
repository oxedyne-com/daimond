//! Lets the hand link against libseccomp where only the runtime library is installed.
//!
//! `libseccomp-sys` links `-lseccomp`, which needs the unversioned `libseccomp.so` that
//! only a distribution's development package provides.  The runtime `libseccomp.so.2` is
//! present wherever systemd is, and it is all the hand needs at run time, so where the
//! development link is missing a link to the runtime library is made in `OUT_DIR` and
//! handed to the linker.  Nothing is written outside `OUT_DIR`.

use std::path::{
    Path,
    PathBuf,
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let multi = format!("/usr/lib/{}-linux-gnu", arch);
    let dirs = [multi.as_str(), "/usr/lib64", "/usr/lib", "/lib64", "/lib"];
    if std::env::var_os("LIBSECCOMP_LIB_PATH").is_some()
        || dirs.iter().any(|d| Path::new(d).join("libseccomp.so").exists())
    {
        return;
    }
    let out = match std::env::var_os("OUT_DIR") {
        Some(o) => PathBuf::from(o).join("seccomp-link"),
        None    => return,
    };
    for d in dirs {
        let so2 = Path::new(d).join("libseccomp.so.2");
        if !so2.exists() {
            continue;
        }
        let link = out.join("libseccomp.so");
        let _ = std::fs::create_dir_all(&out);
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        if std::os::unix::fs::symlink(&so2, &link).is_ok() {
            println!("cargo:rustc-link-search=native={}", out.display());
        }
        return;
    }
    println!("cargo:warning=libseccomp.so.2 was not found; install libseccomp (the \
        runtime library) or set LIBSECCOMP_LIB_PATH, or the hand will not link.");
}
