import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

// Native-verified with .NET 10 (AddProblemDetails + UseExceptionHandler +
// AddExceptionHandler<T>): a handler writing via WriteAsJsonAsync produces
// application/json; Results.Problem(...).ExecuteAsync produces application/
// problem+json; unhandled domain exceptions (including KeyNotFoundException,
// which is NOT auto-mapped to 404) become 500 application/problem+json.
const CONTROLLERS = `
using Microsoft.AspNetCore.Mvc;
[ApiController]
public class DemoController : ControllerBase
{
    [HttpGet("/coffee")] public IActionResult Coffee() => throw new CoffeeException();
    [HttpGet("/conflict")] public IActionResult Conflict() => throw new ConflictEx();
    [HttpGet("/boom")] public IActionResult Boom() => throw new System.InvalidOperationException();
    [HttpGet("/missing")] public IActionResult Missing() => throw new KeyNotFoundException();
    [HttpGet("/mixed")] public object Mixed(int id)
    {
        if (id < 0) throw new CoffeeException();
        return new { id = id };
    }
}
public class CoffeeException : System.Exception {}
public class ConflictEx : System.Exception {}

public class CoffeeHandler : Microsoft.AspNetCore.Diagnostics.IExceptionHandler
{
    public async System.Threading.Tasks.ValueTask<bool> TryHandleAsync(Microsoft.AspNetCore.Http.HttpContext ctx, System.Exception ex, System.Threading.CancellationToken ct)
    {
        if (ex is not CoffeeException) return false;
        ctx.Response.StatusCode = Microsoft.AspNetCore.Http.StatusCodes.Status418ImATeapot;
        await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Status = 418, Title = "coffee" }, cancellationToken: ct);
        return true;
    }
}
public class ConflictHandler : Microsoft.AspNetCore.Diagnostics.IExceptionHandler
{
    public async System.Threading.Tasks.ValueTask<bool> TryHandleAsync(Microsoft.AspNetCore.Http.HttpContext ctx, System.Exception ex, System.Threading.CancellationToken ct)
    {
        if (ex is not ConflictEx) return false;
        await Results.Problem(title: "conflict", statusCode: 409).ExecuteAsync(ctx);
        return true;
    }
}`;

async function scanCSharp(files: Record<string,string>) {
  const root = await mkdtemp(join(tmpdir(), 'aspnet-err-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

it('associates registered IExceptionHandler responses and ProblemDetails fallback', async () => {
  const setup = `
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<CoffeeHandler>();
builder.Services.AddExceptionHandler<ConflictHandler>();
builder.Services.AddControllers();
var app = builder.Build();
app.UseExceptionHandler();
app.MapControllers();
`;
  const doc = await scanCSharp({ 'Program.cs': setup + CONTROLLERS });

  expect(Object.keys(doc.paths['/coffee'].get.responses)).toEqual(['418']);
  expect(doc.paths['/coffee'].get.responses['418'].content['application/json']).toBeDefined();

  expect(Object.keys(doc.paths['/conflict'].get.responses)).toEqual(['409']);
  expect(doc.paths['/conflict'].get.responses['409'].content['application/problem+json']).toBeDefined();

  // Unhandled framework/domain exceptions fall back to 500 ProblemDetails.
  expect(Object.keys(doc.paths['/boom'].get.responses)).toEqual(['500']);
  expect(doc.paths['/boom'].get.responses['500'].content['application/problem+json']).toBeDefined();

  // KeyNotFoundException is not automatically translated to 404.
  expect(Object.keys(doc.paths['/missing'].get.responses)).toEqual(['500']);

  // A success branch plus a handled exception keeps both.
  const mixed = doc.paths['/mixed'].get.responses;
  expect(Object.keys(mixed).sort()).toEqual(['200', '418']);
});

it('does not activate an IExceptionHandler that was never registered', async () => {
  const setup = `
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddControllers();
var app = builder.Build();
app.UseExceptionHandler();
app.MapControllers();
`;
  const doc = await scanCSharp({ 'Program.cs': setup + CONTROLLERS });
  // CoffeeHandler exists in source but AddExceptionHandler<CoffeeHandler>() was
  // never called, so CoffeeException falls through to the 500 problem fallback.
  expect(Object.keys(doc.paths['/coffee'].get.responses)).toEqual(['500']);
  expect(doc.paths['/coffee'].get.responses['500'].content['application/problem+json']).toBeDefined();
});

it('leaves unhandled exceptions unknown without AddProblemDetails', async () => {
  const setup = `
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();
`;
  const doc = await scanCSharp({ 'Program.cs': setup + CONTROLLERS });
  const op = doc.paths['/boom'].get;
  // No provable error contract: a default low-confidence response is reported.
  expect(op.responses['500']).toBeUndefined();
  expect(op.responses.default).toBeDefined();
});

it('associates exceptions thrown in minimal API lambdas', async () => {
  const setup = `
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<CoffeeHandler>();
var app = builder.Build();
app.UseExceptionHandler();
app.MapGet("/latte", () => throw new CoffeeException());
app.MapGet("/ok", () => new { value = 1 });
`;
  const doc = await scanCSharp({ 'Program.cs': setup + `
public class CoffeeException : System.Exception {}
public class CoffeeHandler : Microsoft.AspNetCore.Diagnostics.IExceptionHandler
{
    public async System.Threading.Tasks.ValueTask<bool> TryHandleAsync(Microsoft.AspNetCore.Http.HttpContext ctx, System.Exception ex, System.Threading.CancellationToken ct)
    {
        if (ex is not CoffeeException) return false;
        ctx.Response.StatusCode = Microsoft.AspNetCore.Http.StatusCodes.Status418ImATeapot;
        await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Status = 418 }, cancellationToken: ct);
        return true;
    }
}` });
  expect(Object.keys(doc.paths['/latte'].get.responses)).toEqual(['418']);
  expect(Object.keys(doc.paths['/ok'].get.responses)).toEqual(['200']);
});
