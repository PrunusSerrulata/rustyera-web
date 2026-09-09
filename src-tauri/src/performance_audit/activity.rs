use block2::RcBlock;
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

const OPTIONS: NSActivityOptions = NSActivityOptions::UserInitiatedAllowingIdleSystemSleep;

/// The audit is user-requested work; semantic DOM input did not prevent observed throttling.
/// Foundation owns the token for the synchronous block and releases it when the run finishes;
/// no global preference, thread priority, window state, or production code path is changed.
pub(crate) fn run_with_activity(run: fn()) {
    let audit = std::env::var("RUSTYERA_TAURI_PERF_AUDIT").ok();
    let mode = std::env::var("RUSTYERA_TAURI_PERF_WINDOW_MODE").ok();
    if !needs_activity(audit.as_deref(), mode.as_deref()) {
        run();
        return;
    }
    with_activity(move || {
        eprintln!(
            "{{\"type\":\"tauri-performance-activity\",\"mode\":\"user-initiated-allowing-idle-system-sleep\"}}"
        );
        run();
    });
}

fn needs_activity(audit: Option<&str>, mode: Option<&str>) -> bool {
    audit == Some("1") && mode == Some("minimized")
}

fn with_activity(run: impl Fn() + 'static) {
    use std::cell::Cell;
    use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
    use std::rc::Rc;

    // The safe Foundation binding requires an owned 'static callback even for this synchronous API.
    let outcome = Rc::new(Cell::new(Ok(())));
    let callback_outcome = Rc::clone(&outcome);
    let reason = NSString::from_str("RustyEra user-requested minimized performance replay");
    // Return normally through Foundation so its activity ends before Rust unwinding resumes.
    let block = RcBlock::new(move || callback_outcome.set(catch_unwind(AssertUnwindSafe(&run))));
    NSProcessInfo::processInfo()
        .performActivityWithOptions_reason_usingBlock(OPTIONS, &reason, &block);
    drop(block);
    if let Err(payload) = outcome.replace(Ok(())) {
        resume_unwind(payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[test]
    fn activity_only_applies_to_explicit_minimized_audits() {
        assert!(needs_activity(Some("1"), Some("minimized")));
        for audit in [None, Some("0"), Some("true"), Some("")] {
            assert!(!needs_activity(audit, Some("minimized")));
        }
        for mode in [None, Some("visible"), Some("")] {
            assert!(!needs_activity(Some("1"), mode));
        }
    }

    #[test]
    fn activity_does_not_prevent_display_or_system_sleep() {
        assert!(!OPTIONS.intersects(
            NSActivityOptions::IdleDisplaySleepDisabled
                | NSActivityOptions::IdleSystemSleepDisabled
        ));
        assert!(!OPTIONS.contains(NSActivityOptions::LatencyCritical));
    }

    #[test]
    fn activity_executes_its_callback_once_before_returning() {
        let calls = Rc::new(Cell::new(0));
        let callback_calls = Rc::clone(&calls);
        let thread = std::thread::current().id();
        with_activity(move || {
            assert_eq!(std::thread::current().id(), thread);
            callback_calls.set(callback_calls.get() + 1);
        });
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn activity_preserves_panic_payload_after_callback_returns() {
        use std::panic::{AssertUnwindSafe, catch_unwind, panic_any};
        #[derive(Debug, PartialEq)]
        struct OriginalPayload(u64);
        let calls = Rc::new(Cell::new(0));
        let callback_calls = Rc::clone(&calls);
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            with_activity(move || {
                callback_calls.set(callback_calls.get() + 1);
                panic_any(OriginalPayload(47));
            });
        }));
        assert_eq!(calls.get(), 1);
        assert_eq!(
            *outcome.unwrap_err().downcast::<OriginalPayload>().unwrap(),
            OriginalPayload(47)
        );
    }
}
