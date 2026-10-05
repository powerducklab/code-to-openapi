import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

// Native-verified with .NET 10 + FluentValidation 11 + FluentValidation.
// AspNetCore: AddFluentValidationAutoValidation() together with a registered
// validator makes [ApiController] actions return 400 application/problem+json
// (ValidationProblemDetails with an errors map) before the action runs.
const DTO_AND_VALIDATOR = `
public class CreateOrder
{
    public string Name { get; set; } = "";
    public string? Email { get; set; }
    public int Age { get; set; }
    public string? Note { get; set; }
}

public class OrderValidator : AbstractValidator<CreateOrder>
{
    public OrderValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(10);
        RuleFor(x => x.Email).NotEmpty().EmailAddress();
        RuleFor(x => x.Age).InclusiveBetween(18, 120);
        RuleFor(x => x.Note).MaximumLength(5).When(x => x.Note != null);
    }
}

[ApiController]
[Route("")]
public class OrdersController : ControllerBase
{
    [HttpPost("/orders")]
    public IActionResult Create([FromBody] CreateOrder order) => Ok(new { received = order.Name });
}`;

async function scanCSharp(setup: string, extra = "") {
  const root = await mkdtemp(join(tmpdir(), 'aspnet-fv-'));
  await writeFile(join(root, 'Program.cs'), setup + DTO_AND_VALIDATOR + extra);
  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

const usings = `
using FluentValidation;
using FluentValidation.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
`;

it('applies registered FluentValidation rules and adds 400 ValidationProblemDetails', async () => {
  const setup = usings + `
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddFluentValidationAutoValidation();
builder.Services.AddValidatorsFromAssemblyContaining<OrderValidator>();
var app = builder.Build();
app.MapControllers();
`;
  const doc = await scanCSharp(setup);
  const op = doc.paths['/orders'].post;

  // 400 problem+json from the auto-validation pipeline.
  expect(Object.keys(op.responses).sort()).toEqual(['200', '400']);
  expect(op.responses['400'].content['application/problem+json']).toBeDefined();
  const errorsSchema = op.responses['400'].content['application/problem+json'].schema.properties.errors;
  expect(errorsSchema.type).toBe('object');

  const body = op.requestBody.content['application/json'].schema;
  expect(body.properties.name.maxLength).toBe(10);
  expect(body.properties.email.format).toBe('email');
  expect(body.properties.age.minimum).toBe(18);
  expect(body.properties.age.maximum).toBe(120);
  // NotEmpty/NotNull make name and email required; the When()-guarded Note
  // rule keeps its maxLength (harmless when absent) but Note is not required.
  expect(body.required).toContain('name');
  expect(body.required).toContain('email');
  expect(body.required).not.toContain('note');
  expect(body.properties.note.maxLength).toBe(5);
});

it('does not activate validation when the validator is never registered', async () => {
  const setup = usings + `
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddFluentValidationAutoValidation();
var app = builder.Build();
app.MapControllers();
`;
  const doc = await scanCSharp(setup);
  const op = doc.paths['/orders'].post;
  expect(op.responses['400']).toBeUndefined();
  // Body stays the plain component $ref; rules are not overlaid.
  expect(op.requestBody.content['application/json'].schema.$ref).toBeDefined();
});

it('does not add 400 without AddFluentValidationAutoValidation', async () => {
  const setup = usings + `
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddValidatorsFromAssemblyContaining<OrderValidator>();
var app = builder.Build();
app.MapControllers();
`;
  const doc = await scanCSharp(setup);
  const op = doc.paths['/orders'].post;
  expect(op.responses['400']).toBeUndefined();
});
