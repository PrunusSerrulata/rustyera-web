# Windows native CPU stacks

This standalone diagnostic tool is **Windows-only**; its PE/PDB symbolization supports **x64/AMD64**
images only, not Windows ARM64 or x86 images. The MSBuild project rejects other operating
systems before restore/build and excludes its C# sources there. The recorder, exporter and symbolizer
also reject unsupported operating systems. It is not referenced by Cargo, npm builds, or normal
Tauri/Web products. macOS's existing `sample` support remains separate; Linux ETW support is absent.

Use this with the existing Tauri performance audit, not as another latency authority. WPR records
CPU scheduling samples with native stacks; periodic thread instruction-pointer snapshots are not a
substitute. No game-specific instrumentation or per-instruction tracing is added.

## Build

Use an installed .NET 10 SDK and local TraceEvent assemblies. Set `TraceEventDirectory` to the
directory containing TraceEvent, FastSerialization, Dia2Lib and TraceReloggerLib, and
`DiagnosticsClientAssembly` to the installed diagnostics-client DLL. Supply both as MSBuild
properties during restore and build, with an explicit ignored `--artifacts-path`. `NuGet.Config`
has no package sources; there is no download fallback. Record the SDK and assembly hashes.

## Record

Run `Record-Cpu.ps1 -OutputDirectory ABSOLUTE_NEW_DIRECTORY -DurationSeconds 300` in an elevated
Windows PowerShell process. The script never elevates itself. Only this recorder needs elevation;
the Tauri application and offline tools should run with ordinary privileges.

Wait for `ready.json` before launching the owned Tauri process so ETW observes its actual birth.
Use the normal release performance-audit build with `CARGO_PROFILE_RELEASE_DEBUG=1` recorded in
the official build identity. Match the exact executable and PDB; optimized code is retained.
Set `RUSTYERA_TAURI_PERF_CPU_WINDOW_LOG` to a new absolute JSONL path for the existing audit's
pre/post action markers. Independently retain the runner-owned process path, PID and creation time.
Do not infer ownership from a matching name. Keep semantic checks outside the action window.

After the target finishes, create `stop.request` in the recorder output directory. Require the
recorder to exit zero and `result.json` to say `recorded`; this proves recording completion only.
The recorder stops or cancels only its UUID-named WPR instance. Its maximum active duration is
900 seconds; stop conversion has a separate 120-second bound. The supervising audit must include
both in its shared deadline. A 1 GiB temporary-file check is a polling limit, not a hard disk quota.

WPR's CPU profile includes system-wide metadata and stacks. Keep the ETL private in the ignored
task directory; only the exporter output is filtered to the selected process and action interval.
Never kill the elevated recorder without allowing its `finally` cleanup; on abnormal host loss,
the saved instance name identifies the only session eligible for manual cancellation.

## Export and symbolize

The exporter takes seven positional arguments:

```text
CpuEtl ETL PID PROCESS_START_MIN_UTC PROCESS_START_MAX_UTC ACTION_START_UTC ACTION_END_UTC NEW_OUTPUT_DIRECTORY
```

UTC markers require `Z` and either three or seven fractional digits. PID and independently recorded
birth bounds must select exactly one ETW process. Samples also match its ProcessIndex. No PID-only
fallback or silently expanded bounds are allowed. Start/end must be within both process and trace
lifetimes. The ETLX conversion and original ETL retain system-wide data; do not publish them.

`samples.jsonl` retains sampled IP, thread, raw Count, weight, address stack, loaded module base,
RVA and PDB GUID/age. `addresses.jsonl` ranks exclusive IP and inclusive frame addresses; inclusive
addresses are deduplicated per sample. `summary.json` reports sample interval, lost events, missing
stacks, unresolved modules and truncation. Incomplete stack evidence exits nonzero and stays
diagnostic-only. Trace-wide loss cannot be attributed to one PID. Unknown addresses remain visible.

For the matching main image, collect unique RVAs from both IP and all stack frames, in batches of
at most 4,096, then run:

```text
node symbolize.mjs EXE PDB RVA_ARRAY_JSON NEW_OUTPUT_JSON LLVM_BIN_DIRECTORY
```

All paths must be local and absolute. The symbolizer checks PE/PDB GUID and age, hashes both files,
uses installed LLVM with network symbol lookup disabled, and retains raw output. Match its identity
again against each exported module's PDB identity before joining. Private Rust functions require
debug information; nearest public symbols from a stripped build are not valid attribution.
Keep unknown modules in the denominator. Inclusive function totals must deduplicate functions per
sample (address deduplication is insufficient with recursion); never add inclusive and exclusive
totals together. CPU samples do not measure blocked time or the frontend's final presentation.

## Validation boundary

Before game use, check the Windows build, unsupported-platform build rejection, UTC boundary
validation, recorder cleanup and a real busy/sleep fixture with known stack symbols. Then capture
the supplied game sequence using its existing single copy and compare complete semantic states.
Profiled timings are diagnostic-only; compare with an unprofiled run of identical source/artifacts.
Report sample coverage and confidence separately from any latency target.
