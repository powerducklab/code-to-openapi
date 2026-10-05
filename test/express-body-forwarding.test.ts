import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

const pkg = JSON.stringify({
  dependencies: { express: "*", typescript: "*" },
  devDependencies: { typescript: "*" },
});

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

const operation = (result: any, path: string, method: string) =>
  result.project.operations.find(
    (op: any) => op.path === path && op.method === method.toLowerCase(),
  );

it("forwards a typed DTO parameter through a spread-wrapped request body", async () => {
  const root = await mkdtemp(join(tmpdir(), "body-typed-"));
  try {
    const model = `
export interface RegisterInput {
  email: string;
  username: string;
  password: string;
  image?: string;
}
`;
    const service = `
import { RegisterInput } from './model';
export async function createUser(input: RegisterInput) {
  return { user: { email: input.email, username: input.username } };
}
`;
    const app = `
import express from 'express';
import { createUser } from './service';
const app = express();
app.post('/users', async (req, res) => {
  const user = await createUser({ ...req.body.user, demo: false });
  res.status(201).json({ user });
});
app.listen(3000);
`;
    const { result, doc } = await scan(root, {
      "src/model.ts": model,
      "src/service.ts": service,
      "src/app.ts": app,
    });
    const op = operation(result, "/users", "post");
    expect(op?.gaps ?? []).not.toContain("body-schema-unknown");
    const schema = doc.paths["/users"].post.requestBody.content["application/json"].schema;
    const user = schema.properties.user;
    const resolved = user.$ref
      ? doc.components.schemas[user.$ref.split("/").pop()]
      : user;
    expect(resolved.properties.email).toBeTruthy();
    expect(resolved.properties.username).toBeTruthy();
    expect(resolved.properties.password).toBeTruthy();
    // Optional field is not marked required.
    expect(resolved.required ?? []).not.toContain("image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("infers field types for an any DTO parameter from destructuring and runtime checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "body-any-"));
  try {
    const service = `
export async function createArticle(article: any) {
  const { title, description, body, tagList } = article;
  const tags = Array.isArray(tagList) ? tagList : [];
  if (!title) { throw new Error('title required'); }
  return { article: { title, description, body, tagList: tags } };
}
`;
    const app = `
import express from 'express';
import { createArticle } from './service';
const app = express();
app.post('/articles', async (req, res) => {
  const article = await createArticle(req.body.article);
  res.status(201).json({ article });
});
app.listen(3000);
`;
    const { result, doc } = await scan(root, {
      "src/service.ts": service,
      "src/app.ts": app,
    });
    const op = operation(result, "/articles", "post");
    expect(op?.gaps ?? []).not.toContain("body-schema-unknown");
    const fields =
      doc.paths["/articles"].post.requestBody.content["application/json"].schema.properties.article
        .properties;
    expect(fields.title.type).toBe("string");
    expect(fields.description.type).toBe("string");
    expect(fields.body.type).toBe("string");
    expect(fields.tagList.type).toBe("array");
    expect(fields.tagList.items.type).toBe("string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("nests a deeply wrapped body field (req.body.comment.body)", async () => {
  const root = await mkdtemp(join(tmpdir(), "body-nested-"));
  try {
    const service = `
export async function addComment(body: string, slug: string) {
  return { id: 1, body, slug };
}
`;
    const app = `
import express from 'express';
import { addComment } from './service';
const app = express();
app.post('/articles/:slug/comments', async (req, res) => {
  const comment = await addComment(req.body.comment.body, req.params.slug);
  res.json({ comment });
});
app.listen(3000);
`;
    const { result, doc } = await scan(root, {
      "src/service.ts": service,
      "src/app.ts": app,
    });
    const op = operation(result, "/articles/{slug}/comments", "post");
    expect(op?.gaps ?? []).not.toContain("body-schema-unknown");
    const schema =
      doc.paths["/articles/{slug}/comments"].post.requestBody.content["application/json"].schema;
    expect(schema.properties.comment.properties.body.type).toBe("string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not flag query params proven through Number() wrappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "body-query-"));
  try {
    const service = `
export async function getFeed(offset: number, limit: number) {
  return { articles: [], articlesCount: 0, skip: offset || 0, take: limit || 10 };
}
`;
    const app = `
import express from 'express';
import { getFeed } from './service';
const app = express();
app.get('/feed', async (req, res) => {
  const result = await getFeed(Number(req.query.offset), Number(req.query.limit));
  res.json(result);
});
app.listen(3000);
`;
    const { result, doc } = await scan(root, {
      "src/service.ts": service,
      "src/app.ts": app,
    });
    const op = operation(result, "/feed", "get");
    expect(op?.gaps ?? []).not.toContain("query-unknown");
    const queryParams = doc.paths["/feed"].get.parameters.filter((p: any) => p.in === "query");
    const byName = Object.fromEntries(queryParams.map((p: any) => [p.name, p.schema.type]));
    expect(byName.offset).toBe("number");
    expect(byName.limit).toBe("number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("types err.message as a string in an error-handling middleware response", async () => {
  const root = await mkdtemp(join(tmpdir(), "body-err-"));
  try {
    const app = `
import express, { ErrorRequestHandler } from 'express';
const app = express();
app.get('/ping', (req, res) => res.json({ ok: true }));
const handler: ErrorRequestHandler = (err, req, res, next) => {
  res.status(500).json({ message: err.message });
};
app.use(handler);
app.listen(3000);
`;
    const { doc } = await scan(root, { "src/app.ts": app });
    const body = doc.paths["/ping"].get.responses["500"].content["application/json"].schema;
    expect(body.properties.message.type).toBe("string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
