import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// A Fractal-style codebase: string "Controller@action" routes inside a group
// namespace, an injected presenter/transformer, resource routes with an
// options array, and FormRequest payload wrappers. None of the framework
// classes extend Laravel's JsonResource; the contracts must be recovered
// structurally.
const SOURCE = `<?php
namespace App\\Http\\Controllers\\Api {
    use Illuminate\\Foundation\\Http\\FormRequest;

    class ApiRequest extends FormRequest {
        public function authorize() { return true; }
        public function rules() { return []; }
    }
    class CreateComment extends ApiRequest {
        protected function validationData() { return $this->get('comment') ?: []; }
        public function rules() {
            return ['body' => 'required|string'];
        }
    }
    class DeleteComment extends ApiRequest {
        public function authorize() { return true; }
    }
    class DynamicRequest extends ApiRequest {
        public function rules() { return $this->customRules(); }
    }

    abstract class Transformer {
        protected $resourceName = 'data';
        public function collection($data) {
            return [str_plural($this->resourceName) => $data->map([$this, 'transform'])];
        }
        public function item($data) {
            return [$this->resourceName => $this->transform($data)];
        }
        public function paginate($p) {
            $name = str_plural($this->resourceName);
            return array_merge([$name => $p->getData()->map([$this, 'transform'])], [$name . 'Count' => $p->getTotal()]);
        }
        public abstract function transform($data);
    }
    class UserTransformer extends Transformer {
        protected $resourceName = 'user';
        public function transform($data) {
            return ['email' => $data['email'], 'token' => $data['token'], 'username' => $data['username']];
        }
    }
    class TagTransformer extends Transformer {
        protected $resourceName = 'tag';
        public function transform($data) { return $data; }
    }
    class ArticleTransformer extends Transformer {
        protected $resourceName = 'article';
        public function transform($data) {
            return [
                'title' => $data['title'],
                'favoritesCount' => $data['favoritesCount'],
                'author' => ['username' => $data['user']['username'], 'following' => $data['user']['following']],
            ];
        }
    }
    class CommentTransformer extends Transformer {
        protected $resourceName = 'comment';
        public function transform($data) {
            return ['id' => $data['id'], 'body' => $data['body']];
        }
    }

    class ApiController {
        protected function respond($data, $statusCode = 200) { return response()->json($data, $statusCode); }
        protected function respondWithTransformer($data, $statusCode = 200) {
            if ($data instanceof \\Illuminate\\Support\\Collection) { $data = $this->transformer->collection($data); }
            else { $data = $this->transformer->item($data); }
            return $this->respond($data, $statusCode);
        }
        protected function respondWithPagination($p) {
            return $this->respond($this->transformer->paginate($p));
        }
        protected function respondSuccess() { return $this->respond(null); }
        protected function respondError($message, $statusCode) {
            return $this->respond(['errors' => ['message' => $message, 'status_code' => $statusCode]], $statusCode);
        }
        protected function respondFailedLogin() {
            return $this->respond(['errors' => ['email or password' => 'is invalid']], 422);
        }
    }
    class AuthController extends ApiController {
        public function __construct(UserTransformer $transformer) { $this->transformer = $transformer; }
        public function login() {
            $user = auth()->user();
            if (!$user) { return $this->respondFailedLogin(); }
            return $this->respondWithTransformer($user);
        }
    }
    class TagController extends ApiController {
        public function __construct(TagTransformer $transformer) { $this->transformer = $transformer; }
        public function index() {
            $tags = Tag::all()->pluck('name');
            return $this->respondWithTransformer($tags);
        }
    }
    class ArticleController extends ApiController {
        public function __construct(ArticleTransformer $transformer) { $this->transformer = $transformer; }
        public function index() {
            $articles = Article::paginate();
            return $this->respondWithPagination($articles);
        }
    }
    class CommentController extends ApiController {
        public function __construct(CommentTransformer $transformer) { $this->transformer = $transformer; }
        public function index(Article $article) {
            $comments = $article->comments()->get();
            return $this->respondWithTransformer($comments);
        }
        public function store(CreateComment $request, Article $article) {
            $comment = $article->comments()->create(['body' => $request->input('comment.body')]);
            return $this->respondWithTransformer($comment);
        }
        public function destroy(DeleteComment $request, $article, Comment $comment) {
            $comment->delete();
            return $this->respondSuccess();
        }
        public function dynamic(DynamicRequest $request) {
            return $this->respondSuccess();
        }
    }
}

namespace {
    use Illuminate\\Support\\Facades\\Route;
    Route::group(['namespace' => 'Api'], function () {
        Route::post('users/login', 'AuthController@login');
        Route::get('tags', 'TagController@index');
        Route::get('articles', 'ArticleController@index');
        Route::resource('articles/{article}/comments', 'CommentController', [
            'only' => ['index', 'store', 'destroy'],
        ]);
        Route::post('dynamic', 'CommentController@dynamic');
    });
}
`;

it("resolves string actions, injected transformers and resource options across namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "laravel-transformer-"));
  try {
    await writeFile(join(root, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11" } }));
    await writeFile(join(root, "routes.php"), SOURCE);
    const result = await scanProject({ root });
    const doc = (await result.convert()).document as any;
    const paths = doc.paths;

    // String "Controller@action" inside a group namespace resolves to an item
    // transformer payload plus the named 422 failure branch.
    const login = paths["/users/login"].post;
    const loginOk = login.responses["200"].content["application/json"].schema;
    expect(loginOk.properties.user.properties).toEqual({
      email: { type: "string" },
      token: { type: "string" },
      username: { type: "string" },
    });
    const loginFail = login.responses["422"].content["application/json"].schema;
    expect(loginFail.properties.errors.properties["email or password"]).toEqual({ type: "string" });

    // A collection of scalar records (transform() returns the value as-is).
    const tags = paths["/tags"].get.responses["200"].content["application/json"].schema;
    expect(tags.properties.tags).toEqual({ type: "array", items: { type: "string" } });

    // Pagination wrapper with a count and a nested object presenter.
    const articles = paths["/articles"].get.responses["200"].content["application/json"].schema;
    expect(articles.properties.articlesCount).toEqual({ type: "integer" });
    const articleItem = articles.properties.articles.items.properties;
    expect(articleItem.title).toEqual({ type: "string" });
    expect(articleItem.favoritesCount).toEqual({ type: "integer" });
    expect(articleItem.author.properties).toEqual({
      username: { type: "string" },
      following: { type: "boolean" },
    });

    // Slash-nested resource with a third-argument options array: only
    // index/store/destroy exist, bindings are singularized correctly and no
    // create/edit HTML routes are emitted.
    const commentsBase = "/articles/{article}/comments";
    expect(paths[commentsBase].get).toBeTruthy();
    expect(paths[commentsBase].post).toBeTruthy();
    expect(paths[`${commentsBase}/{comment}`].delete).toBeTruthy();
    expect(paths[`${commentsBase}/create`]).toBeUndefined();
    expect(paths[`${commentsBase}/{comment}`].put).toBeUndefined();
    expect(paths[`${commentsBase}/{comment}`].get).toBeUndefined();

    const commentList = paths[commentsBase].get.responses["200"].content["application/json"].schema;
    expect(commentList.properties.comments.items.properties).toEqual({
      id: { type: "integer" },
      body: { type: "string" },
    });

    // validationData() wraps the rules under the "comment" key.
    const storeBody = paths[commentsBase].post.requestBody.content["application/json"].schema;
    expect(storeBody.properties.comment.properties.body).toEqual({ type: "string", minLength: 1 });
    expect(storeBody.required).toEqual(["comment"]);
    const storeResp = paths[commentsBase].post.responses["200"].content["application/json"].schema;
    expect(storeResp.properties.comment.properties.id).toEqual({ type: "integer" });

    // An authorization-only request (no own rules) documents an empty success.
    const destroy = paths[`${commentsBase}/{comment}`].delete;
    expect(destroy.requestBody).toBeUndefined();
    expect(destroy.responses["200"].content["application/json"].schema.nullable).toBe(true);

    // A dynamic rules() method that cannot be read stays an explicit gap rather
    // than being mistaken for an empty body.
    const dynamic = result.project.operations.find(
      (o) => o.path === "/dynamic" && o.method === "post",
    );
    expect(dynamic?.gaps).toContain("body-schema-unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
