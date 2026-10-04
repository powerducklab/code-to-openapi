import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

it("resolves Prisma include relations and numeric query conversions", async () => {
  const root = await mkdtemp(join(tmpdir(), "express-include-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "*", "@prisma/client": "*" } }),
    );
    await writeFile(
      join(root, "app.ts"),
      `import express from 'express';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const app = express();

// include + nested select: relations are returned fields, not the full entity.
const mapper = (article: any) => ({
  slug: article.slug,
  title: article.title,
  tagList: article.tags.map((t: any) => t.name),
  author: { name: article.author.username },
});
app.get('/posts', async (req, res) => {
  const posts = await db.post.findMany({
    include: {
      author: { select: { username: true, bio: true } },
      tags: true,
      _count: { select: { likes: true } },
    },
  });
  res.json(posts);
});

// mapper projection over an awaited include result.
app.get('/mapped', async (req, res) => {
  const posts = await db.post.findMany({ include: { author: { select: { username: true } }, tags: true } });
  res.json({ posts: posts.map((p: any) => mapper(p)), total: posts.length });
});

// numeric query conversion: Number(req.query.x) narrows to number.
app.get('/search', async (req, res) => {
  res.json({ q: req.query.q, limit: Number(req.query.limit), offset: req.query.offset as unknown });
});
`,
    );
    const result = await scanProject({ root });
    const converted = await result.convert();
    const doc = converted.document as any;
    expect(converted.documentValid).toBe(true);

    const posts = doc.paths["/posts"].get.responses["200"].content["application/json"].schema;
    expect(posts.type).toBe("array");
    const item = posts.items;
    expect(Object.keys(item.properties)).toEqual(["author", "tags", "_count"]);
    expect(Object.keys(item.properties.author.properties).sort()).toEqual(["bio", "username"]);
    expect(item.properties._count.type).toBe("object");
    expect(Object.keys(item.properties._count.properties)).toEqual(["likes"]);

    const mapped = doc.paths["/mapped"].get.responses["200"].content["application/json"].schema;
    const mappedItem = mapped.properties.posts.items;
    expect(Object.keys(mappedItem.properties).sort()).toEqual(["author", "slug", "tagList", "title"]);
    expect([...mappedItem.required].sort()).toEqual(["author", "slug", "tagList", "title"]);
    // The mapper's element is an `any` Prisma row; field names are retained but
    // element types beyond what the include proves stay open (not fabricated).
    expect(mapped.properties.posts.type).toBe("array");
    // Array.length and Prisma counts reach JSON as `number` (TS has no int type),
    // matching the independent API contract rather than OpenAPI `integer`.
    expect(mapped.properties.total.type).toBe("number");

    const search = doc.paths["/search"].get.parameters;
    const limit = search.find((p: any) => p.name === "limit");
    expect(limit.schema.type).toBe("number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
