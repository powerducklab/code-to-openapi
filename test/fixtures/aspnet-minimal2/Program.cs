using Microsoft.AspNetCore.Http.HttpResults;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Top-level minimal API with explicit [FromQuery]/[FromRoute] binding.
app.MapGet("/products/{id}", (int id, [FromQuery] string? q) =>
    Results.Ok(new Product(id, q ?? "")));

// MapGroup chained prefix: /api/v1/todos.
var v1 = app.MapGroup("/api/v1");
v1.MapGet("/todos", () => Results.Ok(new[] { new Todo(1, "a") }));
v1.MapPost("/todos", (CreateTodo cmd) => Results.Created($"/api/v1/todos/{cmd.Title}", new Todo(1, cmd.Title)));

// Chained group directly on the builder.
app.MapGroup("/api/v2").MapGet("/items/{id}", ([FromRoute] int id) =>
    id == 0 ? Results.NotFound() : Results.Ok(new Todo(id, "x")));

// TypedResults responses with non-200 status.
app.MapGet("/broken", () => TypedResults.BadRequest(new Problem { Detail = "bad" }));

app.Run();

record Product(int Id, string Q);
record Todo(int Id, string Title);
record CreateTodo(string Title);
record Problem(string? Detail);
