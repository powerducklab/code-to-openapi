import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

const pkg = JSON.stringify({ dependencies: { express: "*" } });

async function scan(root: string, files: Record<string, string>) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), pkg);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, join(path, "..")), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const result = await scanProject({ root });
  const converted = await result.convert();
  return { result, doc: converted.document as any };
}

const statusCodes = (doc: any, path: string, method: string) =>
  Object.keys(doc.paths[path][method].responses).sort();

it("attaches an inline four-argument error handler response to routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "eh-inline-"));
  try {
    const app = `
const express = require('express');
const app = express();
app.get('/users/:id', (req, res) => res.json({ id: 1 }));
app.use((err, req, res, next) => {
  res.status(500).json({ error: { message: err.message } });
});
app.listen(3000);
`;
    const { doc } = await scan(root, { "app.js": app });
    expect(statusCodes(doc, "/users/{id}", "get")).toEqual(["200", "500"]);
    const body = doc.paths["/users/{id}"].get.responses["500"].content["application/json"].schema;
    expect(body.properties.error).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves a CommonJS required error handler with status branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "eh-cjs-"));
  try {
    const handler = `
function errorHandler(err, req, res, next) {
  if (err.status === 404) return res.status(404).json({ error: { code: 'not_found' } });
  if (err.name === 'CastError') return res.status(400).json({ error: { code: 'bad_id' } });
  return res.status(500).json({ error: { code: 'internal' } });
}
module.exports = errorHandler;
`;
    const app = `
const express = require('express');
const errorHandler = require('./middleware/errorHandler');
const app = express();
app.get('/items/:id', (req, res, next) => {
  const item = null;
  if (!item) { const err = new Error('missing'); err.status = 404; return next(err); }
  res.json(item);
});
app.use(errorHandler);
app.listen(3000);
`;
    const { doc } = await scan(root, {
      "middleware/errorHandler.js": handler,
      "app.js": app,
    });
    expect(statusCodes(doc, "/items/{id}", "get")).toEqual(["200", "400", "404", "500"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves an ESM default-imported error handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "eh-esm-"));
  try {
    const handler = `
export default function errorHandler(err, req, res, next) {
  return res.status(500).json({ error: { code: 'internal' } });
}
`;
    const app = `
import express from 'express';
import errorHandler from './middleware/errorHandler.js';
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(errorHandler);
app.listen(3000);
`;
    const { doc } = await scan(root, {
      "middleware/errorHandler.js": handler,
      "app.js": app,
    });
    expect(statusCodes(doc, "/health", "get")).toEqual(["200", "500"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the numeric fallback of a dynamic err.status || 500 expression", async () => {
  const root = await mkdtemp(join(tmpdir(), "eh-dyn-"));
  try {
    const app = `
const express = require('express');
const app = express();
app.get('/a', (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: { message: err.message } });
});
app.listen(3000);
`;
    const { doc } = await scan(root, { "app.js": app });
    expect(statusCodes(doc, "/a", "get")).toEqual(["200", "500"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("maps a bare dynamic status with no fallback to default instead of fabricating a code", async () => {
  const root = await mkdtemp(join(tmpdir(), "eh-default-"));
  try {
    const app = `
const express = require('express');
const app = express();
app.get('/a', (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => {
  res.status(err.status).json({ error: { message: err.message } });
});
app.listen(3000);
`;
    const { doc } = await scan(root, { "app.js": app });
    expect(statusCodes(doc, "/a", "get")).toEqual(["200", "default"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps three-argument request middleware separate from error handlers", async () => {
  const root = await mkdtemp(join(tmpdir(), "eh-three-"));
  try {
    const app = `
const express = require('express');
const app = express();
app.use((req, res, next) => { req.requestId = 'abc'; next(); });
app.get('/a', (req, res) => res.json({ requestId: req.requestId }));
app.listen(3000);
`;
    const { doc } = await scan(root, { "app.js": app });
    expect(statusCodes(doc, "/a", "get")).toEqual(["200"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
