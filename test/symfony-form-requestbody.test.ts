import { expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// A Symfony Form type defines the request body: buildForm() field types and
// constraints decide required/type, the entity getters fill untyped fields,
// and submitting `$body['data']` wraps the body in an outer `data` key.
async function scanFormFixture() {
  const root = await mkdtemp(join(tmpdir(), "symfony-form-"));
  await mkdir(join(root, "src/Entity"), { recursive: true });
  await mkdir(join(root, "src/Form"), { recursive: true });
  await mkdir(join(root, "src/Controller"), { recursive: true });

  await writeFile(
    join(root, "src/Entity/Book.php"),
    `<?php
namespace App\\Entity;
class Book {
  private $title;
  private $pages;
  public function getTitle(): ?string { return $this->title; }
  public function getPages(): ?int { return $this->pages; }
}
`,
  );

  await writeFile(
    join(root, "src/Form/BookType.php"),
    `<?php
namespace App\\Form;
use App\\Entity\\Book;
use Symfony\\Component\\Form\\AbstractType;
use Symfony\\Component\\Form\\Extension\\Core\\Type\\TextType;
use Symfony\\Component\\Validator\\Constraints\\NotBlank;
class BookType extends AbstractType {
  public function buildForm($builder, array $options) {
    $builder
      ->add('title', TextType::class, ['required' => true, 'constraints' => [new NotBlank()]])
      ->add('pages');
  }
  public function configureOptions($resolver) {
    $resolver->setDefaults(['data_class' => Book::class, 'csrf_protection' => false]);
  }
}
`,
  );

  await writeFile(
    join(root, "src/Controller/BookController.php"),
    `<?php
namespace App\\Controller;
use App\\Entity\\Book;
use App\\Form\\BookType;
use Symfony\\Component\\HttpFoundation\\JsonResponse;
use Symfony\\Component\\HttpFoundation\\Request;
use Symfony\\Component\\Routing\\Annotation\\Route;
class BookController {
  #[Route('/books', methods: ['POST'])]
  public function post(Request $request) {
    $book = new Book();
    $body = json_decode($request->getContent(), true);
    $form = $this->createForm(BookType::class, $book);
    $form->submit($body['data']);
    return $this->handleView($book);
  }
  private function handleView($data) {
    return new JsonResponse($data);
  }
}
`,
  );

  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

it("infers the Symfony Form request body wrapped in the submitted data key", async () => {
  const doc = await scanFormFixture();
  const schema = doc.paths["/books"].post.requestBody.content["application/json"].schema;
  expect(schema.required).toEqual(["data"]);
  const data = schema.properties.data;
  expect(data.required).toEqual(["title"]);
  expect(data.properties.title.type).toBe("string");
  expect(data.properties.pages.type).toEqual(["integer", "null"]);
});
