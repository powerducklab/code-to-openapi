using Demo.Models;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new HealthStatus("ok")))
   .WithName("GetHealth");

app.MapPost("/products", ([FromBody] CreateProduct product) =>
    Results.Created($"/products/{product.Sku}", product))
   .WithName("CreateProduct");

app.MapDelete("/products/{id}", (string id) => Results.NoContent())
   .WithName("DeleteProduct");

app.Run();
