using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/api/orders", (OrderInput input) =>
    Results.Created($"/api/orders/{input.Id}", new Order(input.Id, input.Amount)));

app.MapDelete("/api/orders/{id}", (string id) => Results.NoContent());

app.MapMethods("/api/ping", new[] { "GET", "HEAD" }, () => Results.Ok(new { pong = true }));

app.MapGet("/api/legacy/{id}", (string id) =>
    Results.Redirect($"/api/orders/{id}"));

app.MapGet("/api/reports/{name}", (string name) =>
    Results.File(Array.Empty<byte>(), "application/pdf", $"{name}.pdf"));

app.Run("http://localhost:8094");

public record OrderInput(string Id, decimal Amount);
public record Order(string Id, decimal Amount);
