import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// Laravel error branches never return normally: abort()/abort_if()/
// abort_unless() and thrown framework exceptions still produce documented
// error responses. HttpResponseException carries the exact response that is
// sent. Static analysis only; no PHP runtime is required.
async function scanController(controllerBody: string) {
  const root = await mkdtemp(join(tmpdir(), "laravel-exception-"));
  await writeFile(
    join(root, "routes.php"),
    `<?php
use Illuminate\\Support\\Facades\\Route;
use App\\Http\\Controllers\\XController;
Route::get('/a', [XController::class, 'a']);
Route::get('/b', [XController::class, 'b']);
Route::get('/c', [XController::class, 'c']);
Route::get('/d', [XController::class, 'd']);
Route::get('/e', [XController::class, 'e']);
`,
  );
  await writeFile(
    join(root, "XController.php"),
    `<?php
namespace App\\Http\\Controllers;
class XController {
${controllerBody}
}
`,
  );
  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

function statuses(doc: any, path: string): Record<string, any> {
  return doc.paths[path].get.responses;
}

it("maps abort, abort_if and abort_unless to their status codes", async () => {
  const doc = await scanController(`
  public function a() {
    abort(404);
  }
  public function b() {
    abort_if(true, 400);
  }
  public function c() {
    abort_unless(false, 403, 'denied');
  }
  public function d() { return response()->json(['ok' => true]); }
  public function e() { return response()->json(['ok' => true]); }
`);
  expect(Object.keys(statuses(doc, "/a"))).toContain("404");
  expect(Object.keys(statuses(doc, "/b"))).toContain("400");
  expect(Object.keys(statuses(doc, "/c"))).toContain("403");
});

it("maps framework exceptions and preserves the success branch", async () => {
  const doc = await scanController(`
  public function a() {
    $item = $this->find();
    if (!$item) throw new \\Illuminate\\Database\\Eloquent\\ModelNotFoundException();
    return response()->json(['id' => 1]);
  }
  public function b() { return response()->json(['ok' => true]); }
  public function c() { return response()->json(['ok' => true]); }
  public function d() {
    throw new \\Illuminate\\Auth\\Access\\AuthorizationException();
  }
  public function e() { return response()->json(['ok' => true]); }
`);
  const a = statuses(doc, "/a");
  expect(Object.keys(a).sort()).toEqual(["200", "404"]);
  expect(Object.keys(statuses(doc, "/d"))).toContain("403");
});

it("uses the exact response carried by HttpResponseException", async () => {
  const doc = await scanController(`
  public function a() {
    throw new \\Illuminate\\Http\\Exceptions\\HttpResponseException(response()->json(['error' => 'bad'], 422));
  }
  public function b() { return response()->json(['ok' => true]); }
  public function c() { return response()->json(['ok' => true]); }
  public function d() { return response()->json(['ok' => true]); }
  public function e() { return response()->json(['ok' => true]); }
`);
  const responses = statuses(doc, "/a");
  expect(Object.keys(responses)).toEqual(["422"]);
  expect(
    responses["422"].content["application/json"].schema.properties.error,
  ).toEqual({ type: "string" });
});

it("marks an unknown thrown exception as an uncertain 500", async () => {
  const doc = await scanController(`
  public function a() {
    throw new \\App\\Exceptions\\CustomThingException('boom');
  }
  public function b() { return response()->json(['ok' => true]); }
  public function c() { return response()->json(['ok' => true]); }
  public function d() { return response()->json(['ok' => true]); }
  public function e() { return response()->json(['ok' => true]); }
`);
  const responses = statuses(doc, "/a");
  expect(Object.keys(responses)).toContain("500");
  // The uncertain body is described rather than asserted as an exact schema.
  expect(responses["500"].description).toMatch(/debug/i);
});
