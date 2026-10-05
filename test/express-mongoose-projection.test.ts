import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

const pkg = JSON.stringify({ dependencies: { express: "*", mongoose: "*" } });

const userModel = `
import mongoose from 'mongoose';
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, select: false },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  bio: String,
}, { timestamps: true });
const User = mongoose.model('User', userSchema);
export default User;
`;

const postModel = `
import mongoose from 'mongoose';
const postSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: String,
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coAuthors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  tags: [String],
  published: { type: Boolean, default: false },
  views: { type: Number, default: 0 },
  meta: { votes: Number },
}, { timestamps: true });
const Post = mongoose.model('Post', postSchema);
export default Post;
`;

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

function json200(doc: any, path: string, method: string) {
  return doc.paths[path][method].responses["200"].content["application/json"].schema;
}

it("projects Mongoose find/findOne/create shapes with select:false hidden and populate expanded", async () => {
  const root = await mkdtemp(join(tmpdir(), "mongoose-"));
  try {
    const app = `
import express from 'express';
import User from './models/user.model';
import Post from './models/post.model';
const app = express();
app.get('/posts', async (req, res) => res.json(await Post.find().populate('author', 'name email').lean()));
app.get('/posts/:id', async (req, res) => res.json(await Post.findById(req.params.id).populate('author')));
app.post('/posts', async (req, res) => res.status(201).json(await Post.create(req.body)));
app.get('/users', async (req, res) => res.json(await User.find()));
app.get('/users/count', async (req, res) => res.json(await User.countDocuments()));
app.get('/users/:id', async (req, res) => res.json(await User.findById(req.params.id)));
app.patch('/posts/:id', async (req, res) => res.json(await Post.findByIdAndUpdate(req.params.id, req.body, { new: true })));
app.delete('/posts/:id', async (req, res) => res.json(await Post.findByIdAndDelete(req.params.id)));
app.delete('/users/:id', async (req, res) => res.json(await User.deleteOne({ _id: req.params.id })));
app.get('/titles', async (req, res) => res.json(await Post.find().select('title tags')));
app.listen(3000);
`;
    const { doc, result } = await scan(root, {
      "app.ts": app,
      "models/user.model.ts": userModel,
      "models/post.model.ts": postModel,
    });
    expect(result.project.operations.every((o: any) => !o.gaps?.includes("response-schema-unknown"))).toBe(true);

    const posts = json200(doc, "/posts", "get");
    const postItem = posts.items;
    expect(postItem.type).toBe("object");
    expect(postItem.properties.title).toBeDefined();
    expect(postItem.properties.tags.type).toBe("array");
    expect(postItem.properties.meta.properties.votes.type).toBe("number");
    // populate('author','name email') -> object with only name/email/_id, never password.
    const author = postItem.properties.author;
    expect(author.type).toBe("object");
    expect(Object.keys(author.properties).sort()).toEqual(["_id", "email", "name"]);
    expect(author.properties.password).toBeUndefined();
    // coAuthors array of refs unpopulated stays string ids.
    expect(postItem.properties.coAuthors.items.type).toBe("string");
    expect(postItem.properties.createdAt.format).toBe("date-time");

    // Full populate on detail endpoint; User password is select:false -> absent.
    const detail = json200(doc, "/posts/{id}", "get");
    const detailObj = detail.anyOf.find((b: any) => b.type === "object");
    const fullAuthor = detailObj.properties.author;
    expect(fullAuthor.properties.name).toBeDefined();
    expect(fullAuthor.properties.password).toBeUndefined();
    expect(detail.anyOf.some((b: any) => b.type === "null")).toBe(true);

    // create returns a single document (not an array).
    const created = doc.paths["/posts"].post.responses["201"].content["application/json"].schema;
    expect(created.type).toBe("object");
    expect(created.properties.title).toBeDefined();

    // find() always returns an array; select:false password never leaks.
    const users = json200(doc, "/users", "get");
    expect(users.type).toBe("array");
    expect(users.items.properties.password).toBeUndefined();
    expect(users.items.properties.email).toBeDefined();
    expect(users.items.properties.role.enum).toEqual(["admin", "user"]);

    // countDocuments -> integer, not a document.
    expect(json200(doc, "/users/count", "get")).toEqual({ type: "integer" });

    // deleteOne -> acknowledged/deletedCount result object.
    const del = json200(doc, "/users/{id}", "delete");
    expect(del.properties.deletedCount.type).toBe("integer");
    expect(del.required).toContain("acknowledged");

    // Inclusion select keeps only title/tags plus _id by default.
    const titles = json200(doc, "/titles", "get");
    expect(Object.keys(titles.items.properties).sort()).toEqual(["_id", "tags", "title"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("supports CommonJS require models and update result shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mongoose-cjs-"));
  try {
    const model = `
const mongoose = require('mongoose');
const itemSchema = new mongoose.Schema({ sku: { type: String, required: true }, qty: Number });
module.exports = mongoose.model('Item', itemSchema);
`;
    const app = `
const express = require('express');
const Item = require('./models/item.model');
const app = express();
app.get('/items', async (req, res) => res.json(await Item.find({ qty: { $gte: 1 } })));
app.put('/items/:id', async (req, res) => res.json(await Item.updateOne({ _id: req.params.id }, { qty: 5 })));
app.post('/items/bulk', async (req, res) => res.json(await Item.insertMany(req.body.items)));
app.listen(3000);
`;
    const { doc } = await scan(root, {
      "app.js": app,
      "models/item.model.js": model,
    });
    const items = json200(doc, "/items", "get");
    expect(items.type).toBe("array");
    expect(items.items.properties.sku).toBeDefined();
    const upd = json200(doc, "/items/{id}", "put");
    expect(upd.properties.modifiedCount.type).toBe("integer");
    expect(upd.properties.matchedCount).toBeDefined();
    const bulk = json200(doc, "/items/bulk", "post");
    expect(bulk.type).toBe("array");
    expect(bulk.items.properties.sku).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
