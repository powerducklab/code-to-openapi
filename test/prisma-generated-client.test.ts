import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

it("resolves a generated Prisma client, scalar-only include, delete, and query destructuring", async () => {
  const root = await mkdtemp(join(tmpdir(), "prisma-generated-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "*", "@prisma/client": "*" } }),
    );
    await mkdir(join(root, "prisma"));
    await writeFile(
      join(root, "prisma", "schema.prisma"),
      `generator client { provider = "prisma-client" output = "./generated" }
datasource db { provider = "postgresql" url = env("DATABASE_URL") }

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  published Boolean  @default(false)
  author    User?    @relation(fields: [authorId], references: [id])
  authorId  Int?
}
`,
    );
    await writeFile(
      join(root, "app.ts"),
      `import express from 'express';
import { PrismaClient } from './prisma/generated/client';
const prisma = new PrismaClient();
const app = express();
app.use(express.json());

app.get('/feed', async (req, res) => {
  const { searchString, skip, take, orderBy } = req.query;
  const posts = await prisma.post.findMany({
    where: { published: true },
    include: { author: true },
    take: Number(take) || undefined,
    skip: Number(skip) || undefined,
  });
  res.json(posts);
});

app.delete('/post/:id', async (req, res) => {
  const { id } = req.params;
  const post = await prisma.post.delete({ where: { id: Number(id) } });
  res.json(post);
});

app.post('/post', async (req, res) => {
  const { title, content, authorEmail } = req.body;
  const result = await prisma.post.create({
    data: { title, content, author: { connect: { email: authorEmail } } },
  });
  res.json(result);
});
`,
    );
    const result = await scanProject({ root });
    const converted = await result.convert();
    expect(converted.documentValid).toBe(true);
    const doc = converted.document as any;
    const ops = result.project.operations;

    const feed = ops.find((o: any) => o.path === "/feed" && o.method === "get")!;
    expect(feed.gaps).not.toContain("response-schema-unknown");
    const feedSchema = doc.paths["/feed"].get.responses["200"].content["application/json"].schema;
    expect(feedSchema.type).toBe("array");
    const feedProps = feedSchema.items.properties;
    expect(feedProps.author.type).toBe("object");
    // A bare include:{author:true} returns only the author's scalar fields;
    // it must not cascade the User.posts relation or emit untyped markers.
    expect(feedProps.author.properties.email.type).toBe("string");
    expect(feedProps.author.properties.posts).toBeUndefined();
    // Query values arrive on the wire as strings regardless of later Number().
    const queryNames = doc.paths["/feed"].get.parameters.map((p: any) => p.name).sort();
    expect(queryNames).toEqual(["orderBy", "searchString", "skip", "take"]);
    expect(doc.paths["/feed"].get.parameters.every((p: any) => p.schema.type === "string")).toBe(true);

    const del = ops.find((o: any) => o.path === "/post/{id}" && o.method === "delete")!;
    expect(del.gaps).not.toContain("response-schema-unknown");
    expect(doc.paths["/post/{id}"].delete.responses["200"].content["application/json"].schema.properties.id).toBeDefined();

    // An untyped JSON request body is honestly flagged for the visible AI
    // review instead of being fabricated.
    const create = ops.find((o: any) => o.path === "/post" && o.method === "post")!;
    expect(create.gaps).toContain("body-schema-unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
