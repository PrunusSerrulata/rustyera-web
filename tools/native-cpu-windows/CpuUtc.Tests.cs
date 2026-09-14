using System.Globalization;

var expected = new DateTime(2026, 9, 14, 1, 2, 3, 456, DateTimeKind.Utc);
if (CpuUtc.Parse("2026-09-14T01:02:03.4561234Z") != expected.AddTicks(1234))
    throw new Exception("Sub-millisecond UTC precision lost");
foreach (var culture in new[] { "en-US", "zh-CN" }) {
    CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture);
    foreach (var text in new[] { "2026-09-14T01:02:03.456Z", "2026-09-14T01:02:03.4560000Z" })
        if (CpuUtc.Parse(text) != expected || CpuUtc.Parse(text).Kind != DateTimeKind.Utc)
            throw new Exception("UTC marker changed");
}
foreach (var text in new[] { "2026-09-14T01:02:03.456", "2026-09-14T01:02:03.456+08:00", "", "2026-09-14 01:02:03" }) {
    try { CpuUtc.Parse(text); }
    catch (FormatException) { continue; }
    throw new Exception("Accepted ambiguous timestamp: " + text);
}
Console.WriteLine("UTC marker checks passed");
