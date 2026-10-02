var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Standard lambda minimal API (already supported).
app.MapGet("/health", () => Results.Ok(new { Status = "ok" }));

app.Run();
