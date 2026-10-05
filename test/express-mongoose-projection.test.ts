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

it("resolves CommonJS model factories, namespace exports, toJSON, body backfill and null guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "mongoose-cjs-factory-"));
  try {
    const model = `
module.exports = (mongoose) => {
  const schema = mongoose.Schema(
    { name: String, sku: String, active: Boolean },
    { timestamps: true }
  );
  schema.method("toJSON", function () {
    const { __v, _id, ...object } = this.toObject();
    object.id = _id;
    return object;
  });
  return mongoose.model("item", schema);
};
`;
    const namespace = `
const mongoose = require("mongoose");
const db = {};
db.items = require("./item.model.js")(mongoose);
module.exports = db;
`;
    const controller = `
const db = require("../models");
const Item = db.items;
exports.create = (req, res) => {
  if (!req.body || !req.body.name) {
    return res.status(400).send({ message: "name is required" });
  }
  const item = new Item({ name: req.body.name, sku: req.body.sku, active: req.body.active || false });
  item
    .save()
    .then((data) => res.send(data))
    .catch((err) => res.status(500).send({ message: err.message }));
};
exports.findAll = (req, res) => {
  const name = req.query.name;
  const condition = name ? { name: { $regex: new RegExp(name), $options: "i" } } : {};
  Item.find(condition)
    .then((data) => res.send(data))
    .catch((err) => res.status(500).send({ message: err.message }));
};
exports.findOne = (req, res) => {
  Item.findById(req.params.id)
    .then((data) => {
      if (!data) res.status(404).send({ message: "not found" });
      else res.send(data);
    })
    .catch((err) => res.status(500).send({ message: err.message }));
};
exports.update = (req, res) => {
  if (!req.body) return res.status(400).send({ message: "body required" });
  Item.findByIdAndUpdate(req.params.id, req.body)
    .then((data) => {
      if (!data) res.status(404).send({ message: "not found" });
      else res.send({ message: "Item updated." });
    })
    .catch((err) => res.status(500).send({ message: err.message }));
};
`;
    const routes = `
module.exports = (app) => {
  const items = require("../controllers/item.controller.js");
  const router = require("express").Router();
  router.post("/", items.create);
  router.get("/", items.findAll);
  router.get("/:id", items.findOne);
  router.put("/:id", items.update);
  app.use("/api/items", router);
};
`;
    const server = `
const express = require("express");
const app = express();
app.use(express.json());
require("./app/routes/item.routes.js")(app);
app.listen(8080);
`;
    const { doc, result } = await scan(root, {
      "server.js": server,
      "app/models/item.model.js": model,
      "app/models/index.js": namespace,
      "app/controllers/item.controller.js": controller,
      "app/routes/item.routes.js": routes,
    });

    // All routes recalled with no unresolved gaps.
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(
      ["/api/items", "/api/items/{id}"].sort(),
    );
    for (const op of result.project.operations) {
      expect(op.gaps ?? []).toEqual([]);
    }

    // Detail 200 is a single document (null only belongs to the 404 arm); the
    // custom toJSON removes _id/__v and exposes id instead.
    const detail = json200(doc, "/api/items/{id}", "get");
    expect(detail.anyOf).toBeUndefined();
    expect(detail.type).toBe("object");
    expect(detail.properties.id.type).toBe("string");
    expect(detail.properties._id).toBeUndefined();
    expect(detail.properties.__v).toBeUndefined();
    expect(detail.properties.name.type).toBe("string");
    expect(detail.properties.active.type).toBe("boolean");
    expect(detail.properties.createdAt.format).toBe("date-time");

    // List returns an array of the same transformed document.
    const list = json200(doc, "/api/items", "get");
    expect(list.type).toBe("array");
    expect(list.items.properties.id).toBeDefined();
    expect(list.items.properties._id).toBeUndefined();
    expect(list.items.properties.__v).toBeUndefined();

    // Untyped regex query param defaults to string.
    const listOp = doc.paths["/api/items"].get;
    const nameQuery = listOp.parameters.find((p: any) => p.name === "name" && p.in === "query");
    expect(nameQuery.schema.type).toBe("string");

    // Create body: typed from the model, name proven required by the 400 guard.
    const createBody = doc.paths["/api/items"].post.requestBody.content["application/json"].schema;
    expect(createBody.properties.name.type).toBe("string");
    expect(createBody.properties.sku.type).toBe("string");
    expect(createBody.properties.active.type).toBe("boolean");
    expect(createBody.required).toEqual(["name"]);
    const created = doc.paths["/api/items"].post.responses["200"].content["application/json"].schema;
    expect(created.properties.id).toBeDefined();
    expect(created.properties._id).toBeUndefined();
    // Success-path presence: name is proven by the 400 guard and active by its
    // `|| false` default; sku has neither guard nor default and stays optional.
    expect(created.required).toContain("name");
    expect(created.required).toContain("active");
    expect(created.required).toContain("id");
    expect(created.required).not.toContain("sku");

    // Update forwards the whole body: every path accepted, all optional.
    const updateBody = doc.paths["/api/items/{id}"].put.requestBody.content["application/json"].schema;
    expect(Object.keys(updateBody.properties).sort()).toEqual(["active", "name", "sku"]);
    expect(updateBody.required).toBeUndefined();
    const updated = doc.paths["/api/items/{id}"].put.responses["200"].content["application/json"].schema;
    expect(updated.properties.message.type).toBe("string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("proves ternary-default instance fields on save while leaving unguarded fields optional", async () => {
  const root = await mkdtemp(join(tmpdir(), "mongoose-ternary-"));
  try {
    const model = `
import mongoose from 'mongoose';
const flagSchema = new mongoose.Schema({
  flag: Boolean,
  note: String,
});
export default mongoose.model('Flag', flagSchema);
`;
    const app = `
import express from 'express';
import Flag from './models/flag.model';
const app = express();
app.use(express.json());
app.post('/flags', (req, res) => {
  const flag = new Flag({
    flag: req.body.flag ? req.body.flag : false,
    note: req.body.note,
  });
  flag.save().then((data) => res.send(data)).catch((err) => res.status(500).send({ message: err.message }));
});
app.listen(3000);
`;
    const { doc } = await scan(root, {
      "app.ts": app,
      "models/flag.model.ts": model,
    });
    const created = doc.paths["/flags"].post.responses["200"].content["application/json"].schema;
    // `req.body.flag ? req.body.flag : false` always yields a value; note has no
    // guard and no default, so it is optional on the persisted document.
    expect(created.required).toContain("flag");
    expect(created.required).not.toContain("note");
    expect(created.properties.flag.type).toBe("boolean");
    expect(created.properties.note.type).toBe("string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
