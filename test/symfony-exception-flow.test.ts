import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// Thrown Symfony HttpKernel exceptions become error responses through the
// kernel.exception event. The exception subclass fixes the status; the generic
// HttpException carries an explicit status; any other unhandled exception is a
// 500 whose body depends on kernel.debug and the error renderer.
async function scanController(methods: string) {
  const root = await mkdtemp(join(tmpdir(), "symfony-exception-"));
  await writeFile(
    join(root, "BookController.php"),
    `<?php
namespace App\\Controller;
use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\Routing\\Annotation\\Route;
use Symfony\\Component\\HttpKernel\\Exception\\NotFoundHttpException;
use Symfony\\Component\\HttpKernel\\Exception\\AccessDeniedHttpException;
use Symfony\\Component\\HttpKernel\\Exception\\HttpException;
class BookController extends AbstractController {
${methods}
}
`,
  );
  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

it("maps HttpException subclasses and explicit statuses alongside success", async () => {
  const doc = await scanController(`
  #[Route('/books/{id}', methods: ['GET'])]
  public function show(int $id) {
    if ($id <= 0) throw new NotFoundHttpException('not found');
    if ($id === 9) throw new HttpException(429, 'slow down');
    return $this->json(['id' => $id]);
  }
  #[Route('/denied', methods: ['GET'])]
  public function denied() {
    throw new AccessDeniedHttpException('forbidden');
  }
`);
  expect(Object.keys(doc.paths["/books/{id}"].get.responses).sort()).toEqual([
    "200",
    "404",
    "429",
  ]);
  expect(Object.keys(doc.paths["/denied"].get.responses)).toContain("403");
});

it("marks a non-HTTP exception as an uncertain 500", async () => {
  const doc = await scanController(`
  #[Route('/boom', methods: ['GET'])]
  public function boom() {
    throw new \\RuntimeException('unexpected');
  }
`);
  const responses = doc.paths["/boom"].get.responses;
  expect(Object.keys(responses)).toContain("500");
  expect(responses["500"].description).toMatch(/debug|renderer/i);
});
