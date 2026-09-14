using System.Globalization;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing.Etlx;

// Offline only: no TraceEventSession, WPR, SymbolReader, network or symbol server.
if (!OperatingSystem.IsWindows())
    throw new PlatformNotSupportedException("Native CPU ETW export is Windows-only.");
if (args.Length != 7)
    throw new ArgumentException("ETL PID PROCESS_START_MIN_UTC PROCESS_START_MAX_UTC WINDOW_START_UTC WINDOW_END_UTC OUTPUT_DIRECTORY");
string etl = Path.GetFullPath(args[0]);
if (new FileInfo(etl).Length > 1024L * 1024 * 1024)
    throw new ArgumentException("ETL exceeds 1 GiB limit");
int pid = int.Parse(args[1], CultureInfo.InvariantCulture);
DateTime ParseUtc(string text) => CpuUtc.Parse(text);
DateTime birthMin = ParseUtc(args[2]), birthMax = ParseUtc(args[3]);
DateTime windowStart = ParseUtc(args[4]), windowEnd = ParseUtc(args[5]);
if (pid <= 0 || birthMin > birthMax || windowStart >= windowEnd || !File.Exists(etl))
    throw new ArgumentException("Invalid PID, input or time window");
string output = Path.GetFullPath(args[6]);
if (Directory.Exists(output))
    throw new IOException("Output directory must not exist; do not overwrite another capture");
Directory.CreateDirectory(output);
Environment.SetEnvironmentVariable("_NT_SYMBOL_PATH", "");
Environment.SetEnvironmentVariable("_NT_ALT_SYMBOL_PATH", "");
string etlxPath = Path.Combine(output, "cpu.etlx");
using var conversionLog = new StreamWriter(Path.Combine(output, "conversion.log"));
var options = new TraceLogOptions {
    LocalSymbolsOnly = true,
    AlwaysResolveSymbols = false,
    ShouldResolveSymbols = _ => false,
    ContinueOnError = false,
    ConversionLog = conversionLog
};
TraceLog.CreateFromEventTraceLogFile(etl, etlxPath, options);
conversionLog.Flush();
using var log = new TraceLog(etlxPath);
var candidates = log.Processes.Where(p => p.ProcessID == pid
    && p.StartTime.ToUniversalTime() >= birthMin
    && p.StartTime.ToUniversalTime() <= birthMax).ToArray();
if (candidates.Length != 1)
    throw new InvalidOperationException($"Expected one PID/start identity; found {candidates.Length}. No PID-only fallback.");
var process = candidates[0];
if (windowStart < process.StartTime.ToUniversalTime()
    || windowEnd > process.EndTime.ToUniversalTime())
    throw new InvalidOperationException("Requested action interval is outside the selected process lifetime");
// Reject wholly out-of-trace windows; do not silently rank an unrelated interval.
if (windowStart < log.SessionStartTime.ToUniversalTime()
    || windowEnd > log.SessionEndTime.ToUniversalTime())
    throw new InvalidOperationException("Requested action interval is outside the recorded trace");
var counts = new Dictionary<string, AddressCount>(StringComparer.Ordinal);
AddressFrame Resolve(ulong address, double timeMs) {
    // LoadedModules, unlike ModuleFile.ImageBase, handles this process and ASLR lifetime.
    var loaded = process.LoadedModules.GetModuleContainingAddress(address, timeMs);
    var module = loaded?.ModuleFile;
    ulong? rva = loaded is null ? null : address - loaded.ImageBase;
    return new AddressFrame($"0x{address:x}", module?.FilePath,
        loaded is null ? null : $"0x{loaded.ImageBase:x}",
        rva is null ? null : $"0x{rva:x}",
        module?.PdbName, module?.PdbSignature.ToString(), module?.PdbAge);
}
AddressCount Count(AddressFrame frame) {
    string key = frame.ModulePath is null ? "unknown:" + frame.Address
        : frame.ModulePath + "|" + frame.PdbSignature + "|" + frame.PdbAge + "|" + frame.Rva;
    if (!counts.TryGetValue(key, out var count)) {
        if (counts.Count >= 1_000_000) throw new InvalidOperationException("Unique-address limit reached");
        counts.Add(key, count = new AddressCount(frame));
    }
    return count;
}
long sampleEvents = 0, sampleWeight = 0, noStackEvents = 0, noStackWeight = 0;
long unresolvedFrameOccurrences = 0;
long unresolvedIpEvents = 0, unresolvedIpWeight = 0;
using var samples = new StreamWriter(Path.Combine(output, "samples.jsonl"));
using var source = log.Events.GetSource();
int? processExitStatus = null;
source.Kernel.ProcessStop += stopped => {
    if (stopped.ProcessID == pid && stopped.Process()?.ProcessIndex == process.ProcessIndex)
        processExitStatus = stopped.ExitStatus;
};
source.Kernel.PerfInfoSample += sample => {
    if (sample.ProcessID != pid) return;
    var owner = sample.Process();
    if (owner is null || owner.ProcessIndex != process.ProcessIndex) return;
    DateTime utc = sample.TimeStamp.ToUniversalTime();
    if (utc < windowStart || utc >= windowEnd) return;
    long weight = sample.Count > 0 ? sample.Count : 1;
    sampleEvents++;
    if (sampleEvents > 1_000_000) throw new InvalidOperationException("Sample limit reached");
    sampleWeight += weight;
    var ip = Resolve(sample.InstructionPointer, sample.TimeStampRelativeMSec);
    if (ip.ModulePath is null) { unresolvedIpEvents++; unresolvedIpWeight += weight; }
    var exclusive = Count(ip);
    exclusive.ExclusiveEvents++;
    exclusive.ExclusiveWeight += weight;
    var stack = log.GetCallStackForEvent(sample);
    var frames = new List<AddressFrame>();
    var inclusive = new HashSet<AddressCount>(); // Recursion counts once per sampled address.
    if (stack is null) {
        noStackEvents++;
        noStackWeight += weight;
    }
    for (var current = stack; current is not null; current = current.Caller) {
        if (frames.Count >= 4096) throw new InvalidOperationException("Stack depth limit reached");
        var frame = Resolve(current.CodeAddress.Address, sample.TimeStampRelativeMSec);
        if (frame.ModulePath is null) unresolvedFrameOccurrences++;
        frames.Add(frame);
        inclusive.Add(Count(frame));
    }
    foreach (var count in inclusive) {
        count.InclusiveEvents++;
        count.InclusiveWeight += weight;
    }
    samples.WriteLine(JsonSerializer.Serialize(new {
        utc, relativeMs = sample.TimeStampRelativeMSec,
        pid, tid = sample.ThreadID, rawCount = sample.Count, weight,
        instructionPointer = ip, stack = frames
    }));
};
source.Process();
samples.Flush();
using (var aggregate = new StreamWriter(Path.Combine(output, "addresses.jsonl")))
    foreach (var count in counts.Values.OrderByDescending(c => c.ExclusiveWeight))
        aggregate.WriteLine(JsonSerializer.Serialize(count));
var qualityIssues = new List<string>();
if (log.EventsLost != 0) qualityIssues.Add($"trace-events-lost:{log.EventsLost}");
if (!log.HasCallStacks) qualityIssues.Add("trace-has-no-call-stacks");
if (noStackEvents != 0) qualityIssues.Add($"samples-without-stack:{noStackEvents}");
if (unresolvedFrameOccurrences != 0) qualityIssues.Add($"unresolved-module-frames:{unresolvedFrameOccurrences}");
if (unresolvedIpEvents != 0) qualityIssues.Add($"unresolved-instruction-pointers:{unresolvedIpEvents}");
if (sampleEvents == 0) qualityIssues.Add("no-target-samples");
if (log.Truncated) qualityIssues.Add("truncated-trace");
File.WriteAllText(Path.Combine(output, "summary.json"), JsonSerializer.Serialize(new {
    pid, processIndex = process.ProcessIndex.ToString(),
    processStartUtc = process.StartTime.ToUniversalTime(),
    processEndUtc = process.EndTime.ToUniversalTime(), process.ImageFileName,
    processExitStatus,
    birthMin, birthMax, windowStart, windowEnd,
    sessionStartUtc = log.SessionStartTime.ToUniversalTime(),
    sessionEndUtc = log.SessionEndTime.ToUniversalTime(),
    sampleEvents, sampleWeight, noStackEvents, noStackWeight, unresolvedFrameOccurrences,
    unresolvedIpEvents, unresolvedIpWeight,
    eventsLost = log.EventsLost, truncated = log.Truncated,
    hasCallStacks = log.HasCallStacks,
    sampleIntervalMs = log.SampleProfileInterval.TotalMilliseconds,
    uniqueAddresses = counts.Count,
    symbolResolution = "disabled; module/RVA only",
    parseComplete = sampleEvents > 0 && !log.Truncated,
    stackEvidenceComplete = qualityIssues.Count == 0,
    qualityIssues
}, new JsonSerializerOptions { WriteIndented = true }));
if (qualityIssues.Count != 0)
    throw new InvalidOperationException("Incomplete stack evidence; see summary.json. Raw samples are retained for diagnosis only.");

record AddressFrame(string Address, string? ModulePath, string? LoadBase, string? Rva,
    string? PdbName, string? PdbSignature, int? PdbAge);
sealed class AddressCount(AddressFrame frame) {
    public AddressFrame Frame { get; } = frame;
    public long ExclusiveEvents { get; set; }
    public long ExclusiveWeight { get; set; }
    public long InclusiveEvents { get; set; }
    public long InclusiveWeight { get; set; }
}
