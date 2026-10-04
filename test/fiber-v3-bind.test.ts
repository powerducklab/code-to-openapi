import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/index.js';

it('recognizes Fiber v3 body binding without treating database Get as a header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fiber-v3-'));
  try {
    await writeFile(join(root, 'go.mod'), 'module example\n\ngo 1.22\n\nrequire github.com/gofiber/fiber/v3 v3.0.0');
    await writeFile(join(root, 'main.go'), `package main
import "github.com/gofiber/fiber/v3"
type Input struct { Name string \`json:"name"\` }
func create(c fiber.Ctx) error {
 input := new(Input)
 c.Bind().Body(input)
 db.Get("not-a-header")
 return c.JSON(Input{Name:"ok"})
}
func main(){app:=fiber.New();app.Post("/items",create)}`);
    const result = await scanProject({ root });
    const converted = await result.convert();
    const op = converted.document.paths['/items'].post;
    expect(op.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/input_Input' });
    expect(op.parameters ?? []).toEqual([]);
    expect(converted.document.components.schemas.input_Input.required ?? []).toEqual([]);
    expect(converted.document.components.schemas.Input.required).toEqual(['name']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
