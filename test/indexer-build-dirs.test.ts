import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexProject } from "../src/core/indexer.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "c2o-indexer-"));
  // Maven build output next to a pom.xml must be ignored.
  mkdirSync(join(root, "target", "classes"), { recursive: true });
  writeFileSync(join(root, "pom.xml"), "<project/>");
  writeFileSync(join(root, "target", "classes", "Generated.java"), "class Generated {}");
  // A Java source package literally named "target" must stay indexed.
  mkdirSync(join(root, "src", "main", "java", "demo", "target"), { recursive: true });
  writeFileSync(
    join(root, "src", "main", "java", "demo", "target", "Thing.java"),
    "package demo.target; class Thing {}",
  );
  // A "bin" source folder without .NET project markers must stay indexed.
  mkdirSync(join(root, "src", "main", "java", "demo", "bin"), { recursive: true });
  writeFileSync(
    join(root, "src", "main", "java", "demo", "bin", "BinThing.java"),
    "package demo.bin; class BinThing {}",
  );
  // Dependency directories are always ignored.
  mkdirSync(join(root, "node_modules", "lib"), { recursive: true });
  writeFileSync(join(root, "node_modules", "lib", "index.js"), "module.exports = {}");
  // .NET build output next to a csproj must be ignored.
  mkdirSync(join(root, "dotnet", "bin", "Debug"), { recursive: true });
  writeFileSync(join(root, "dotnet", "App.csproj"), "<Project/>");
  writeFileSync(join(root, "dotnet", "bin", "Debug", "App.dll"), "binary");
  // A Java-style source package named "env" must stay indexed.
  mkdirSync(join(root, "src", "main", "java", "demo", "env"), { recursive: true });
  writeFileSync(
    join(root, "src", "main", "java", "demo", "env", "EnvDto.java"),
    "package demo.env; class EnvDto {}",
  );
  // A real Python virtualenv named "env" (pyvenv.cfg marker) must be ignored.
  mkdirSync(join(root, "env", "bin"), { recursive: true });
  writeFileSync(join(root, "env", "pyvenv.cfg"), "home = /usr/bin\n");
  writeFileSync(join(root, "env", "bin", "activate"), "# shell\n");
  writeFileSync(join(root, "env", "polluted.py"), "import os\n");
  // A source folder named "venv" without virtualenv markers must stay indexed.
  mkdirSync(join(root, "src", "main", "python", "venv"), { recursive: true });
  writeFileSync(
    join(root, "src", "main", "python", "venv", "config.py"),
    "SETTINGS = {}\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("indexer build directory detection", () => {
  it("ignores real build output but keeps source packages with the same name", () => {
    const index = indexProject(root);
    const paths = index.files.map((f) => f.path);
    expect(paths).toContain("src/main/java/demo/target/Thing.java");
    expect(paths).toContain("src/main/java/demo/bin/BinThing.java");
    expect(paths).toContain("src/main/java/demo/env/EnvDto.java");
    expect(paths).toContain("src/main/python/venv/config.py");
    expect(paths.some((p) => p.startsWith("target/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dotnet/bin/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("env/"))).toBe(false);
  });
});
