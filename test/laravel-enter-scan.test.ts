import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

describe("Laravel shard/enter hardening", () => {
  it("expands dot-nested apiResource into nested path segments", async () => {
    const result = await scanProject({
      root: "test/fixtures/laravel-enter",
      includeTests: true,
    });
    expect(result.report.frameworks).toContain("laravel");
    const converted = await result.convert();
    expect(converted.documentValid).toBe(true);

    const paths = Object.keys((converted.document as any).paths);
    // Nested resource 'albums.songs' must become nested URIs, not dotted paths.
    expect(paths).toContain("/api/albums/{album}/songs");
    expect(paths).toContain("/api/albums/{album}/songs/{song}");
    expect(paths).not.toContainEqual(expect.stringContaining(".songs"));
  });

  it("declares one route binding per nested segment on item routes", async () => {
    const result = await scanProject({
      root: "test/fixtures/laravel-enter",
      includeTests: true,
    });
    const byKey = new Map(
      result.project.operations.map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]),
    );
    const show = byKey.get("GET /api/albums/{album}/songs/{song}")!;
    expect(show).toBeTruthy();
    const paramNames = show.parameters.map((p) => `${p.in}:${p.name}`).sort();
    expect(paramNames).toEqual(["path:album", "path:song"]);
  });

  it("does not emit DI-injected repositories as path parameters", async () => {
    const result = await scanProject({
      root: "test/fixtures/laravel-enter",
      includeTests: true,
    });
    const byKey = new Map(
      result.project.operations.map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]),
    );
    const overview = byKey.get("GET /api/overview")!;
    expect(overview).toBeTruthy();
    // SongRepository $repository is container-injected, not a route segment.
    expect(overview.parameters.map((p) => p.name)).not.toContain("repository");
    expect(overview.parameters).toHaveLength(0);
  });

  it("binds single-resource route-model parameters", async () => {
    const result = await scanProject({
      root: "test/fixtures/laravel-enter",
      includeTests: true,
    });
    const byKey = new Map(
      result.project.operations.map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]),
    );
    const showAlbum = byKey.get("GET /api/albums/{album}")!;
    expect(showAlbum).toBeTruthy();
    expect(showAlbum.parameters).toContainEqual(
      expect.objectContaining({ name: "album", in: "path", required: true }),
    );
  });
});
