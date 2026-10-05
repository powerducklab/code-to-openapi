import { expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// A service tagged kernel.event_listener/kernel.exception owns the final error
// response: it maps the throwable class to a status (a getStatusCode() branch or
// a get_class() switch, including default_statement) and to an error body, then
// wraps it in a static error envelope. Thrown classes are matched in the
// controller and in same-class private helpers.
async function scanProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), "symfony-exc-listener-"));
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "src/Utils"), { recursive: true });
  await mkdir(join(root, "src/Exception"), { recursive: true });
  await mkdir(join(root, "src/Listener"), { recursive: true });
  await mkdir(join(root, "src/Controller"), { recursive: true });

  await writeFile(
    join(root, "config/services.yaml"),
    `services:
  kernel.listener.exception_listener:
    class: App\\Listener\\ExceptionListener
    tags:
      - { name: kernel.event_listener, event: kernel.exception, method: onKernelException }
`,
  );

  await writeFile(
    join(root, "src/Utils/Jttp.php"),
    `<?php
namespace App\\Utils;
class Jttp {
  const STATUS_SUCCESS = 'success';
  const STATUS_ERROR = 'error';
  const FIELD_STATUS = 'status';
  const FIELD_CODE = 'code';
  const FIELD_MESSAGE = 'message';
  const FIELD_DATA = 'data';
  const FIELD_ERROR = 'error';
  private $status;
  private $code;
  private $message;
  private $data;
  private $error;
  public function __construct(string $status, int $code, ?string $message, ?array $data, ?array $error) {
    $this->status = $status;
    $this->code = $code;
    $this->message = $message;
    $this->data = $data;
    $this->error = $error;
  }
  public static function success(?array $data = null): Jttp {
    return new static(static::STATUS_SUCCESS, 200, 'OK', $data, null);
  }
  public static function error(int $statusCode, ?string $statusCodeMessage = null, ?array $error = null): Jttp {
    return new static(static::STATUS_ERROR, $statusCode, $statusCodeMessage, null, $error);
  }
  public function toArray(): array {
    $res = [];
    $res[self::FIELD_STATUS] = $this->status;
    $res[self::FIELD_CODE] = $this->code;
    $res[self::FIELD_MESSAGE] = $this->message;
    switch ($this->status) {
      case self::STATUS_SUCCESS:
        $res[self::FIELD_DATA] = $this->data;
        break;
      case self::STATUS_ERROR:
        $res[self::FIELD_ERROR] = $this->error;
        break;
    }
    return $res;
  }
}
`,
  );

  await writeFile(
    join(root, "src/Exception/FormException.php"),
    `<?php
namespace App\\Exception;
use Symfony\\Component\\HttpKernel\\Exception\\HttpException;
class FormException extends HttpException {
  public function __construct(int $statusCode = 400, string $message = null) {
    parent::__construct($statusCode, $message);
  }
  public function getErrors(): array { return []; }
}
`,
  );

  await writeFile(
    join(root, "src/Listener/ExceptionListener.php"),
    `<?php
namespace App\\Listener;
use App\\Exception\\FormException;
use App\\Utils\\Jttp;
use Symfony\\Component\\HttpFoundation\\Response;
class ExceptionListener {
  public function onKernelException($event) {
    $throwable = $event->getThrowable();
    $type = get_class($throwable);
    $statusCode = 500;
    $error = [];
    if (method_exists($throwable, 'getStatusCode')) {
      $statusCode = $throwable->getStatusCode();
    } else {
      switch ($type) {
        case 'Symfony\\Component\\Routing\\Exception\\ResourceNotFoundException':
          $statusCode = Response::HTTP_NOT_FOUND;
          break;
        default:
          $statusCode = Response::HTTP_INTERNAL_SERVER_ERROR;
          break;
      }
    }
    switch ($type) {
      case 'App\\Exception\\FormException':
        $data = [];
        foreach ($throwable->getErrors() as $e) {
          $data[$e->getOrigin()->getName()] = $e->getMessage();
        }
        $error['form'] = $data;
        break;
      default:
        $message = $throwable->getMessage();
        $error['detail'] = $message;
        break;
    }
    $content = Jttp::error($statusCode, null, $error)->toArray();
  }
}
`,
  );

  await writeFile(
    join(root, "src/Controller/BookController.php"),
    `<?php
namespace App\\Controller;
use App\\Exception\\FormException;
use Symfony\\Component\\Routing\\Annotation\\Route;
use Symfony\\Component\\Routing\\Exception\\ResourceNotFoundException;
class BookController {
  #[Route('/books/{id}', methods: ['GET'])]
  public function get($id) {
    $book = null;
    if (!$book) { throw new ResourceNotFoundException("Resource $id not found"); }
    return $book;
  }
  #[Route('/books', methods: ['POST'])]
  public function post() {
    return $this->save();
  }
  private function save() {
    throw new FormException();
  }
}
`,
  );

  const result = await scanProject({ root });
  const doc = (await result.convert()).document as any;
  await rm(root, { recursive: true, force: true });
  return doc;
}

it("maps a switch-mapped vendor exception to 404 with the detail error envelope", async () => {
  const doc = await scanProjectFixture();
  const responses = doc.paths["/books/{id}"].get.responses;
  expect(Object.keys(responses)).toContain("404");
  expect(Object.keys(responses)).not.toContain("500");
  const schema = responses["404"].content["application/json"].schema;
  expect(schema.required).toEqual(["status", "code", "message", "error"]);
  expect(schema.properties.status.const).toBe("error");
  expect(schema.properties.code.const).toBe(404);
  expect(schema.properties.message.type).toBe("string");
  expect(schema.properties.error.properties.detail.type).toBe("string");
  expect(schema["x-audit-exact-properties"]).toBe(true);
});

it("reads the inherited getStatusCode default for FormException thrown in a helper", async () => {
  const doc = await scanProjectFixture();
  const responses = doc.paths["/books"].post.responses;
  expect(Object.keys(responses)).toContain("400");
  const schema = responses["400"].content["application/json"].schema;
  expect(schema.properties.code.const).toBe(400);
  const form = schema.properties.error.properties.form;
  expect(form.type).toBe("object");
  expect(form.additionalProperties.type).toBe("string");
});
