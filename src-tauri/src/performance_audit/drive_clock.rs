use std::time::{Duration, Instant};

/// The existing native drive wall interval includes lock contention and synchronous SQL replies.
/// Thread CPU excludes sleeping, descheduling and work on the separate SQL owner thread. It is
/// attribution, not a replacement for response time or an estimate of total probe overhead.
pub(crate) struct NativeDriveClock {
    wall: Instant,
    cpu: Option<Duration>,
    setup: Duration,
    // A thread-clock interval must never be moved to another worker before finish.
    same_thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct NativeDriveTiming {
    pub wall: Duration,
    pub setup: Duration,
    pub thread_cpu: Option<Duration>,
}

impl NativeDriveClock {
    pub fn start() -> Self {
        Self {
            wall: Instant::now(),
            cpu: thread_cpu_time(),
            setup: Duration::ZERO,
            same_thread: std::marker::PhantomData,
        }
    }

    /// Includes all three host lock acquisitions, and message submission on the fused path.
    pub fn drive_ready(&mut self) {
        self.setup = self.wall.elapsed();
    }

    pub fn finish(self) -> NativeDriveTiming {
        let wall = self.wall.elapsed();
        let cpu = cpu_difference(self.cpu, thread_cpu_time());
        NativeDriveTiming {
            wall,
            setup: self.setup,
            thread_cpu: cpu,
        }
    }
}

fn cpu_difference(start: Option<Duration>, end: Option<Duration>) -> Option<Duration> {
    end?.checked_sub(start?)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn thread_cpu_time() -> Option<Duration> {
    // Safe, in-process clock read: no subprocess, allocation, snapshot, or privilege change.
    Duration::try_from(rustix::time::clock_gettime(
        rustix::time::ClockId::ThreadCPUTime,
    ))
    .ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn thread_cpu_time() -> Option<Duration> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_deltas_preserve_missing_counters_and_reject_backwards_time() {
        let first = Some(Duration::from_nanos(900));
        let second = Some(Duration::from_nanos(1100));
        assert_eq!(
            cpu_difference(first, second),
            Some(Duration::from_nanos(200))
        );
        assert_eq!(cpu_difference(first, None), None);
        assert_eq!(cpu_difference(None, second), None);
        assert_eq!(cpu_difference(second, first), None);
    }

    #[test]
    fn drive_clock_keeps_setup_inside_wall_time() {
        let mut clock = NativeDriveClock::start();
        clock.drive_ready();
        let timing = clock.finish();
        assert!(timing.wall >= timing.setup);
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(timing.thread_cpu.is_some());
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert!(timing.thread_cpu.is_none());
    }
}
