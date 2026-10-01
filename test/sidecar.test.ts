import { describe, expect, it } from "vitest";

import {
  affectedFiles,
  diffSidecars,
  type DiscoverySidecar,
} from "../src/core/sidecar.js";

const base: DiscoverySidecar = {
  version: 1,
  scannedAt: "2026-09-01T00:00:00.000Z",
  language: "typescript",
  framework: "express",
  files: {
    "src/app.ts": "aaa",
    "src/routes/users.ts": "bbb",
  },
  routes: [
    {
      key: "get /users",
      method: "get",
      path: "/users",
      file: "src/routes/users.ts",
      fingerprint: "f1",
    },
    {
      key: "post /users",
      method: "post",
      path: "/users",
      file: "src/routes/users.ts",
      fingerprint: "f2",
    },
  ],
};

describe("diffSidecars", () => {
  it("reports added, changed and removed files", () => {
    const current: DiscoverySidecar = {
      ...base,
      scannedAt: "2026-09-02T00:00:00.000Z",
      files: {
        "src/app.ts": "aaa",
        "src/routes/users.ts": "ccc",
        "src/routes/orders.ts": "ddd",
      },
      routes: base.routes,
    };
    const diff = diffSidecars(base, current);
    expect(diff.changedFiles).toEqual(["src/routes/users.ts"]);
    expect(diff.addedFiles).toEqual(["src/routes/orders.ts"]);
    expect(diff.removedFiles).toEqual([]);
    expect(affectedFiles(diff).sort()).toEqual([
      "src/routes/orders.ts",
      "src/routes/users.ts",
    ]);
  });

  it("classifies route changes by stable key and fingerprint", () => {
    const current: DiscoverySidecar = {
      ...base,
      files: base.files,
      routes: [
        { ...base.routes[0]!, fingerprint: "f1-changed" },
        {
          key: "get /orders",
          method: "get",
          path: "/orders",
          file: "src/routes/orders.ts",
          fingerprint: "f3",
        },
      ],
    };
    const diff = diffSidecars(base, current);
    const kinds = new Map(diff.routeChanges.map((c) => [c.kind, c]));
    expect(kinds.get("changed")?.current?.key).toBe("get /users");
    expect(kinds.get("added")?.current?.key).toBe("get /orders");
    expect(kinds.get("removed")?.previous?.key).toBe("post /users");
  });

  it("treats a missing previous sidecar as a full add", () => {
    const diff = diffSidecars(undefined, base);
    expect(diff.addedFiles.sort()).toEqual([
      "src/app.ts",
      "src/routes/users.ts",
    ]);
    expect(diff.removedFiles).toEqual([]);
    expect(diff.routeChanges).toHaveLength(2);
    expect(diff.routeChanges.every((c) => c.kind === "added")).toBe(true);
  });
});
