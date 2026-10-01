import { describe, expect, it } from "vitest";

import {
  affectedFiles,
  buildSidecar,
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

describe("buildSidecar", () => {
  it("fingerprints routes from source hash and operation contract", () => {
    const files = [
      {
        path: "src/app.ts",
        absolutePath: "/repo/src/app.ts",
        content: "export const x = 1;",
        bytes: 18,
        hash: "hash-app",
        language: "typescript",
      },
    ];
    const operation = {
      method: "get",
      path: "/users",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer" },
          confidence: "high",
        },
      ],
      responses: [{ statusCode: "200", description: "", content: [], confidence: "high" }],
      confidence: "high",
      origin: { file: "src/app.ts", line: 12 },
      gaps: [],
    } as never;
    const sidecar = buildSidecar({
      files,
      operations: [operation],
      language: "typescript",
      framework: "express",
    });
    expect(sidecar.version).toBe(1);
    expect(sidecar.files["src/app.ts"]).toBe("hash-app");
    expect(sidecar.routes).toHaveLength(1);
    expect(sidecar.routes[0]).toMatchObject({
      key: "get /users",
      method: "get",
      path: "/users",
      file: "src/app.ts",
      line: 12,
    });
    expect(sidecar.routes[0]!.fingerprint).toHaveLength(64);

    // Same source, same contract -> identical fingerprint.
    const again = buildSidecar({ files, operations: [operation] });
    expect(again.routes[0]!.fingerprint).toBe(sidecar.routes[0]!.fingerprint);

    // A changed response contract changes the fingerprint even without edits.
    const changed = {
      ...operation,
      responses: [
        { statusCode: "200", description: "", content: [], confidence: "high" },
        { statusCode: "404", description: "", content: [], confidence: "high" },
      ],
    } as never;
    const changedSidecar = buildSidecar({ files, operations: [changed] });
    expect(changedSidecar.routes[0]!.fingerprint).not.toBe(
      sidecar.routes[0]!.fingerprint,
    );
  });
});
