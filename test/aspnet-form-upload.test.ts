import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

// Native-verified with .NET 10: [FromForm] scalar parameters bind multipart
// fields using the parameter (or [FromForm(Name=...)] alias) name, while a
// [FromForm] DTO flattens its properties using the original C# property names
// (no camelCase policy). Non-nullable reference/IFormFile members are required;
// value types default instead of failing when absent; `= null!` stays required.
async function scanCSharp(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'aspnet-form-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

const usings = `
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
`;

it('binds mixed scalar fields, files, aliases and optional files into one form schema', async () => {
  const program = usings + `
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();

[ApiController]
[Route("")]
public class UploadController : ControllerBase
{
    [HttpPost("/upload-mixed")]
    public IActionResult Mixed(
        [FromForm] string title,
        [FromForm] int? count,
        [FromForm] IFormFile file,
        [FromForm(Name = "alt_file")] IFormFile? extra)
        => Ok(new { title });
}
`;
  const doc = await scanCSharp({ 'Program.cs': program });
  const body = doc.paths['/upload-mixed'].post.requestBody;
  expect(body.required).toBe(true);
  const schema = body.content['multipart/form-data'].schema;

  expect(schema.properties.title).toEqual({ type: 'string' });
  expect(schema.properties.count.type).toContain('integer');
  expect(schema.properties.file).toEqual({ type: 'string', format: 'binary' });
  // The [FromForm(Name=...)] alias wins over the parameter name.
  expect(schema.properties.alt_file).toEqual({ type: 'string', format: 'binary' });
  expect(schema.properties.extra).toBeUndefined();

  expect(schema.required.sort()).toEqual(['file', 'title']);
});

it('flattens a [FromForm] DTO preserving property names with nested file lists', async () => {
  const program = usings + `
using System.Collections.Generic;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
var app = builder.Build();
app.MapControllers();

public class UploadForm
{
    public string Title { get; set; } = "";
    public IFormFile File { get; set; } = null!;
    public List<IFormFile>? Attachments { get; set; }
    public int Count { get; set; }
}

[ApiController]
[Route("")]
public class UploadController : ControllerBase
{
    [HttpPost("/upload-dto")]
    public IActionResult Dto([FromForm] UploadForm form) => Ok(new { form.Title });
}
`;
  const doc = await scanCSharp({ 'Program.cs': program });
  const body = doc.paths['/upload-dto'].post.requestBody;
  const schema = body.content['multipart/form-data'].schema;

  // Form model binding keeps the original PascalCase property names.
  expect(schema.properties.Title).toEqual({ type: 'string' });
  expect(schema.properties.File).toEqual({ type: 'string', format: 'binary' });
  expect(schema.properties.Attachments).toEqual({
    type: 'array',
    items: { type: 'string', format: 'binary' },
  });
  expect(schema.properties.Count.type).toBe('integer');

  // Value type Count is not required (binds to 0); null! does not make File optional.
  expect(schema.required.sort()).toEqual(['File', 'Title']);
});
