use serde::Serialize;

/// Best-effort process memory counters with one platform-neutral wire schema.
///
/// Every field is optional because operating-system accounting and permissions differ. The
/// adapter maps Windows working set and Linux RSS to `resident_bytes`; callers never need a
/// platform branch to graph the process's currently resident memory.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)] // The cross-platform schema states each unit explicitly.
pub(super) struct MemorySnapshot {
    resident_bytes: Option<u64>,
    physical_footprint_bytes: Option<u64>,
    virtual_bytes: Option<u64>,
    private_bytes: Option<u64>,
    committed_bytes: Option<u64>,
    anonymous_bytes: Option<u64>,
}

#[tauri::command]
pub(super) async fn memory_snapshot() -> Result<MemorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(platform::snapshot)
        .await
        .map_err(|error| format!("memory snapshot task failed: {error}"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn kib_to_bytes(value: u64) -> Option<u64> {
    value.checked_mul(1024)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn whitespace_numbers(text: &str) -> impl Iterator<Item = u64> + '_ {
    text.split_whitespace()
        .filter_map(|value| value.replace(',', "").parse().ok())
}

#[cfg(target_os = "linux")]
mod platform {
    use std::fs;

    use super::{MemorySnapshot, kib_to_bytes};

    pub(super) fn snapshot() -> MemorySnapshot {
        let status = fs::read_to_string("/proc/self/status").ok();
        let rollup = fs::read_to_string("/proc/self/smaps_rollup").ok();
        let resident_bytes = status
            .as_deref()
            .and_then(|text| kib_field(text, "VmRSS"))
            .and_then(kib_to_bytes);
        let anonymous_bytes = rollup
            .as_deref()
            .and_then(|text| kib_field(text, "Anonymous"))
            .or_else(|| {
                status
                    .as_deref()
                    .and_then(|text| kib_field(text, "RssAnon"))
            })
            .and_then(kib_to_bytes);
        let private_bytes = rollup.as_deref().and_then(|text| {
            let mut total = 0_u64;
            let mut available = false;
            for field in ["Private_Clean", "Private_Dirty", "Private_Hugetlb"] {
                if let Some(value) = kib_field(text, field) {
                    available = true;
                    total = total.checked_add(value)?;
                }
            }
            if available { kib_to_bytes(total) } else { None }
        });
        MemorySnapshot {
            resident_bytes,
            private_bytes,
            anonymous_bytes,
            ..MemorySnapshot::default()
        }
    }

    fn kib_field(text: &str, field: &str) -> Option<u64> {
        for line in text.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name == field {
                return value.split_whitespace().next()?.parse().ok();
            }
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_linux_status_and_rollup_fields() {
            let status = "VmRSS:\t128 kB\nRssAnon:\t80 kB\n";
            let rollup = concat!(
                "Rss: 128 kB\n",
                "Private_Clean: 7 kB\n",
                "Private_Dirty: 11 kB\n",
                "Private_Hugetlb: 13 kB\n",
                "Anonymous: 79 kB\n",
            );

            assert_eq!(kib_field(status, "VmRSS"), Some(128));
            assert_eq!(kib_field(rollup, "Private_Clean"), Some(7));
            assert_eq!(kib_field(rollup, "Anonymous"), Some(79));
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::{Command, Stdio};

    use super::{MemorySnapshot, kib_to_bytes, whitespace_numbers};

    pub(super) fn snapshot() -> MemorySnapshot {
        let pid = std::process::id().to_string();
        let ps = Command::new("/bin/ps")
            .args(["-o", "rss=", "-o", "vsz=", "-p", &pid])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok());
        let mut ps_values = ps.as_deref().map(whitespace_numbers);
        let resident_bytes = ps_values
            .as_mut()
            .and_then(Iterator::next)
            .and_then(kib_to_bytes);
        let virtual_bytes = ps_values
            .as_mut()
            .and_then(Iterator::next)
            .and_then(kib_to_bytes);
        MemorySnapshot {
            resident_bytes,
            physical_footprint_bytes: physical_footprint(&pid),
            virtual_bytes,
            ..MemorySnapshot::default()
        }
    }

    fn physical_footprint(pid: &str) -> Option<u64> {
        let output = Command::new("/usr/bin/footprint")
            .args(["-p", pid])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())?;
        let text = String::from_utf8(output.stdout).ok()?;
        text.lines()
            .find(|line| line.to_ascii_lowercase().contains("physical footprint"))
            .and_then(parse_human_bytes)
    }

    fn parse_human_bytes(line: &str) -> Option<u64> {
        let value = line.split_once(':').map_or(line, |(_, value)| value).trim();
        let mut parts = value.split_whitespace();
        let number = parts.next()?.replace(',', "");
        let multiplier = match parts.next().unwrap_or("B").to_ascii_lowercase().as_str() {
            "b" | "bytes" => 1_u64,
            "kb" | "k" | "kib" => 1024_u64,
            "mb" | "m" | "mib" => 1024_u64 * 1024,
            "gb" | "g" | "gib" => 1024_u64 * 1024 * 1024,
            _ => return None,
        };
        let (whole, fraction) = number
            .split_once('.')
            .map_or((number.as_str(), ""), |parts| parts);
        let whole = whole.parse::<u64>().ok()?.checked_mul(multiplier)?;
        if fraction.is_empty() {
            return Some(whole);
        }
        let fraction = fraction.trim_end_matches('0');
        if fraction.is_empty() {
            return Some(whole);
        }
        let scale = 10_u64.checked_pow(u32::try_from(fraction.len()).ok()?)?;
        let fraction = fraction
            .parse::<u64>()
            .ok()?
            .checked_mul(multiplier)?
            .checked_add(scale / 2)?
            / scale;
        whole.checked_add(fraction)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_macos_footprint_units() {
            assert_eq!(
                parse_human_bytes("Physical footprint: 12.5 MB"),
                Some(13_107_200)
            );
            assert_eq!(parse_human_bytes("Physical footprint: unavailable"), None);
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::process::{Command, Stdio};

    use super::{MemorySnapshot, whitespace_numbers};

    pub(super) fn snapshot() -> MemorySnapshot {
        let command = format!(
            "$p=Get-Process -Id {}; [Console]::WriteLine('{{0}} {{1}} {{2}}', \
             $p.WorkingSet64, $p.PrivateMemorySize64, $p.PagedMemorySize64)",
            std::process::id()
        );
        let output = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &command,
            ])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok());
        let mut values = output.as_deref().map(whitespace_numbers);
        MemorySnapshot {
            resident_bytes: values.as_mut().and_then(Iterator::next),
            private_bytes: values.as_mut().and_then(Iterator::next),
            committed_bytes: values.as_mut().and_then(Iterator::next),
            ..MemorySnapshot::default()
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::MemorySnapshot;

    pub(super) fn snapshot() -> MemorySnapshot {
        MemorySnapshot::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_counters_remain_explicit_nulls() {
        let encoded = serde_json::to_value(MemorySnapshot::default()).unwrap();
        assert!(encoded["residentBytes"].is_null());
        assert!(encoded["physicalFootprintBytes"].is_null());
        assert!(encoded["privateBytes"].is_null());
    }
}
