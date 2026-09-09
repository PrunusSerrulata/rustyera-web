use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Instant;

/// Cooperative cancellation: an entered filesystem syscall cannot be preempted.
#[derive(Clone)]
pub(crate) struct StorageExecution {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    outcome: Arc<AtomicU8>,
    #[cfg(test)]
    hook: Option<Arc<dyn Fn(Phase) + Send + Sync>>,
    #[cfg(test)]
    clock: Option<Arc<std::sync::Mutex<Instant>>>,
}

impl StorageExecution {
    #[cfg(any(test, feature = "native-sql"))]
    pub(crate) fn new(deadline: Instant, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            deadline,
            cancelled,
            outcome: Arc::new(AtomicU8::new(0)),
            #[cfg(test)]
            hook: None,
            #[cfg(test)]
            clock: None,
        }
    }

    pub(crate) fn checkpoint(&self) -> io::Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "storage execution cancelled",
            ));
        }
        let now = Instant::now();
        #[cfg(test)]
        let now = self
            .clock
            .as_ref()
            .map_or(now, |clock| *clock.lock().unwrap());
        if now >= self.deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "storage execution deadline exceeded",
            ));
        }
        Ok(())
    }

    #[cfg(any(test, feature = "native-sql"))]
    pub(crate) fn publication_attempted(&self) -> bool {
        self.outcome.load(Ordering::Acquire) != 0
    }

    #[cfg(any(test, feature = "native-sql"))]
    pub(crate) fn publication_completed(&self) -> bool {
        self.outcome.load(Ordering::Acquire) == 2
    }

    #[cfg(test)]
    fn phase(&self, phase: Phase) {
        if let Some(hook) = &self.hook {
            hook(phase);
        }
    }
}

pub(super) fn checkpoint(execution: Option<&StorageExecution>) -> io::Result<()> {
    execution.map_or(Ok(()), StorageExecution::checkpoint)
}

/// Existing compound path/resource/list helpers remain synchronous, but may not
/// continue into the next operation after cancellation or deadline expiration.
pub(super) fn checked<T>(
    execution: Option<&StorageExecution>,
    operation: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    checkpoint(execution)?;
    let result = operation();
    checkpoint(execution)?;
    result
}

pub(super) fn publish<T>(
    execution: Option<&StorageExecution>,
    operation: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    #[cfg(test)]
    if let Some(execution) = execution {
        execution.phase(Phase::BeforePublication);
    }
    checkpoint(execution)?;
    if let Some(execution) = execution {
        // A later callback can enter another publication on the same guard.
        // Attempted remains true even if that syscall subsequently fails.
        execution.outcome.store(1, Ordering::Release);
    }
    let result = operation();
    if result.is_ok()
        && let Some(execution) = execution
    {
        execution.outcome.store(2, Ordering::Release);
    }
    #[cfg(test)]
    if let Some(execution) = execution {
        execution.phase(Phase::AfterPublication);
    }
    // Never replace the observed publication result with a late cancellation.
    result
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    ReadChunk,
    BeforePublication,
    AfterPublication,
}

#[cfg(test)]
pub(super) fn read_chunk(execution: Option<&StorageExecution>) {
    if let Some(execution) = execution {
        execution.phase(Phase::ReadChunk);
    }
}

#[cfg(test)]
mod tests;
