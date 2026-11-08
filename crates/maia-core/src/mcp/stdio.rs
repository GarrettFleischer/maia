/// Why a stdio server was not started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioError<E> {
    /// Containment cannot run an unattended process.
    Containment,
    /// The spawn function failed after containment allowed it.
    Spawn(E),
}

/// Spawns a stdio server only when containment is ready.
///
/// When `containment_ready` is false, `spawn` is dropped without being called.
///
/// # Errors
///
/// Returns [`StdioError::Containment`] or [`StdioError::Spawn`].
pub fn open_stdio<T, E>(
    containment_ready: bool,
    spawn: impl FnOnce() -> Result<T, E>,
) -> Result<T, StdioError<E>> {
    if !containment_ready {
        return Err(StdioError::Containment);
    }
    spawn().map_err(StdioError::Spawn)
}
