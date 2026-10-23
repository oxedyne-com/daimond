//! The sync port: design (2)'s carrier, as a trait.

/// The sync port a [`Host`](super::Host) carries.  Its methods arrive with their call sites.
pub trait SyncPort {}
