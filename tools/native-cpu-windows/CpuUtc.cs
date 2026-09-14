using System.Globalization;

public static class CpuUtc
{
    public static DateTime Parse(string text) => DateTimeOffset.ParseExact(
        text,
        ["yyyy-MM-dd'T'HH:mm:ss.fff'Z'", "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'"],
        CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal).UtcDateTime;
}
