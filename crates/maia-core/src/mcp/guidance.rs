/// Maximum advisory guidance, in UTF-8 bytes.
pub const MAX_GUIDANCE_BYTES: usize = 2000;

/// Route tools that may carry guidance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidanceRoute {
    /// `spawn_task`.
    Spawn,
    /// `continue_task`.
    Continue,
    /// `link_task`.
    Link,
    /// `inspect_task`.
    Inspect,
    /// `cancel_task`.
    Cancel,
    /// `retry_task`.
    Retry,
}

/// Why guidance was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidanceError {
    /// The route tool has no guidance field.
    NotAllowed,
    /// The text is longer than [`MAX_GUIDANCE_BYTES`].
    TooLong,
}

/// Accepts guidance for spawn, continue, and link.
///
/// # Errors
///
/// Returns [`GuidanceError::NotAllowed`] when the route cannot carry guidance,
/// and [`GuidanceError::TooLong`] when the byte length exceeds the cap.
pub fn guidance_for_route(
    route: GuidanceRoute,
    guidance: Option<&str>,
) -> Result<Option<String>, GuidanceError> {
    let Some(text) = guidance else {
        return Ok(None);
    };
    if !matches!(
        route,
        GuidanceRoute::Spawn | GuidanceRoute::Continue | GuidanceRoute::Link
    ) {
        return Err(GuidanceError::NotAllowed);
    }
    if text.len() > MAX_GUIDANCE_BYTES {
        return Err(GuidanceError::TooLong);
    }
    Ok(Some(text.to_owned()))
}
