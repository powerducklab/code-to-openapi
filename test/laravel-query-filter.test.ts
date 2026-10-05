import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// The reflection-driven QueryFilter pattern (popularized by laravel QueryFilter
// packages) maps a filter class's own single-argument methods to query
// parameters, and a constructed paginator reads limit/offset from the global
// request() helper. Classes live in PSR-4 files like a real project.
const FILES: Record<string, string> = {
  "app/Filters/Filter.php": `<?php
namespace App\\Filters;
use ReflectionClass;
use Illuminate\\Http\\Request;
abstract class Filter {
    protected $request;
    public function __construct(Request $request) { $this->request = $request; }
    protected function getFilterMethods() {
        $class = new ReflectionClass(static::class);
        return array_filter(array_map(function ($m) use ($class) {
            return $m->class === $class->getName() ? $m->name : null;
        }, $class->getMethods()));
    }
    protected function getFilters() {
        return array_filter($this->request->only($this->getFilterMethods()));
    }
    public function apply($builder) {
        foreach ($this->getFilters() as $name => $value) {
            if (method_exists($this, $name)) { $this->$name($value); }
        }
        return $builder;
    }
}
`,
  "app/Filters/ArticleFilter.php": `<?php
namespace App\\Filters;
class ArticleFilter extends Filter {
    protected function author($username) { return $this->builder; }
    protected function favorited($username) { return $this->builder; }
    protected function tag($name) { return $this->builder; }
}
`,
  "app/Pagination/Paginator.php": `<?php
namespace App\\Pagination;
class Paginator {
    public function __construct($builder, $limit = 20, $offset = 0) {
        $limit = request()->get('limit', $limit);
        $offset = request()->input('offset', $offset);
    }
}
`,
  "app/Http/Controllers/Api/ArticleController.php": `<?php
namespace App\\Http\\Controllers\\Api;
use App\\Filters\\ArticleFilter;
use App\\Pagination\\Paginator;
class ArticleController {
    public function index(ArticleFilter $filter) {
        new Paginator(Article::all());
        return response()->json(['articles' => [], 'articlesCount' => 0]);
    }
    public function feed() {
        new Paginator(Article::all());
        return response()->json(['articles' => [], 'articlesCount' => 0]);
    }
}
`,
  "routes/api.php": `<?php
use Illuminate\\Support\\Facades\\Route;
Route::group(['namespace' => 'App\\Http\\Controllers\\Api'], function () {
    Route::get('articles', 'ArticleController@index');
    Route::get('articles/feed', 'ArticleController@feed');
});
`,
};

it("recovers reflection query-filter keys and constructed paginator parameters", async () => {
  const root = await mkdtemp(join(tmpdir(), "laravel-query-filter-"));
  try {
    await writeFile(join(root, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11" } }));
    for (const [relative, content] of Object.entries(FILES)) {
      const file = join(root, relative);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    }
    const result = await scanProject({ root });
    const doc = (await result.convert()).document as any;

    const names = (path: string) =>
      doc.paths[path].get.parameters.map((p: any) => [p.name, p.in, p.schema.type]);

    expect(names("/articles")).toEqual(
      expect.arrayContaining([
        ["author", "query", "string"],
        ["favorited", "query", "string"],
        ["tag", "query", "string"],
        ["limit", "query", "integer"],
        ["offset", "query", "integer"],
      ]),
    );
    // The feed action has no filter parameter but still constructs the paginator.
    expect(names("/articles/feed")).toEqual(
      expect.arrayContaining([
        ["limit", "query", "integer"],
        ["offset", "query", "integer"],
      ]),
    );
    expect(names("/articles/feed").find((p: any[]) => p[0] === "author")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
