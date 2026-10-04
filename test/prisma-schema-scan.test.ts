import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

it("proves Prisma scalar types, nullability and computed mapper fields from schema.prisma", async () => {
  const root = await mkdtemp(join(tmpdir(), "express-prisma-schema-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "*", "@prisma/client": "*" } }),
    );
    await mkdir(join(root, "prisma"));
    await writeFile(
      join(root, "prisma", "schema.prisma"),
      `generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql" url = env("DATABASE_URL") }

model User {
  id        Int       @id @default(autoincrement())
  username  String    @unique
  bio       String?
  image     String?
  articles  Article[]
}

model Tag {
  id    Int    @id @default(autoincrement())
  name  String @unique
}

model Article {
  id            Int      @id @default(autoincrement())
  slug          String   @unique
  title         String
  body          String
  createdAt     DateTime @default(now())
  author        User     @relation(fields: [authorId], references: [id])
  authorId      Int
  tags          Tag[]
  favoritedBy   User[]
}
`,
    );
    await writeFile(
      join(root, "app.ts"),
      `import express from 'express';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const app = express();

const authorMapper = (author: any, id?: number) => ({
  username: author.username,
  bio: author.bio,
  image: author.image,
  following: id ? author.articles.some((a: any) => a.id === id) : false,
});

const articleMapper = (article: any, id?: number) => ({
  slug: article.slug,
  title: article.title,
  body: article.body,
  createdAt: article.createdAt,
  tagList: article.tags.map((tag: any) => tag.name),
  favoritesCount: article.favoritedBy.length,
  author: authorMapper(article.author, id),
});

// findMany + include + mapper: scalar types come from schema.prisma.
app.get('/articles', async (req, res) => {
  const articles = await db.article.findMany({
    include: {
      tags: { select: { name: true } },
      author: { select: { username: true, bio: true, image: true, articles: true } },
      favoritedBy: true,
    },
  });
  const total = await db.article.count();
  res.json({ articles: articles.map((a: any) => articleMapper(a)), articlesCount: total });
});

// update + rest destructuring + spread (favorite pattern).
app.post('/articles/:slug/favorite', async (req, res) => {
  const { _count, ...article } = await db.article.update({
    where: { slug: req.params.slug },
    data: {},
    include: {
      tags: { select: { name: true } },
      author: { select: { username: true, bio: true, image: true, articles: true } },
      favoritedBy: true,
      _count: { select: { favoritedBy: true } },
    },
  });
  const result = {
    ...article,
    author: authorMapper(article.author, 1),
    tagList: article.tags.map((tag: any) => tag.name),
    favoritesCount: _count?.favoritedBy,
  };
  res.json({ article: result });
});
`,
    );
    const result = await scanProject({ root });
    const converted = await result.convert();
    const doc = converted.document as any;
    expect(converted.documentValid).toBe(true);

    const list = doc.paths["/articles"].get.responses["200"].content["application/json"].schema;
    const item = list.properties.articles.items;
    // Scalar types proven from schema.prisma.
    expect(item.properties.slug.type).toBe("string");
    expect(item.properties.title.type).toBe("string");
    expect(item.properties.body.type).toBe("string");
    expect(item.properties.createdAt.type).toBe("string");
    expect(item.properties.createdAt.format).toBe("date-time");
    // Computed mapper fields.
    expect(item.properties.tagList.type).toBe("array");
    expect(item.properties.tagList.items.type).toBe("string");
    expect(item.properties.favoritesCount.type).toBe("number");
    // Nullable author fields: value may be null (type includes null) but the key
    // is always emitted by the mapper, so it stays required.
    const author = item.properties.author;
    expect(author.properties.bio.type).toContain("null");
    expect(author.properties.image.type).toContain("null");
    expect(author.required).toContain("bio");
    expect(author.required).toContain("image");
    // Ternary + Array.some proves a boolean.
    expect(author.properties.following.type).toBe("boolean");
    // count() proves a number.
    expect(list.properties.articlesCount.type).toBe("number");

    // update + rest + spread keeps scalar fields on the favorite response.
    const fav = doc.paths["/articles/{slug}/favorite"].post.responses["200"].content["application/json"].schema;
    const favArticle = fav.properties.article;
    expect(favArticle.properties.slug.type).toBe("string");
    expect(favArticle.properties.title.type).toBe("string");
    expect(favArticle.properties.favoritesCount.type).toBe("number");
    expect(favArticle.required).toContain("slug");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
