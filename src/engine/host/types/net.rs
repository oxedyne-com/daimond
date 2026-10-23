//! Types the net port names, shared by every host.

/// The bytes of a raw fetch, and the content type the site sent them under.
pub struct RawPage {
    pub bytes:        Vec<u8>,
    pub content_type: String,
}

