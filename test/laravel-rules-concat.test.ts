import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// FormRequest rules frequently concatenate a runtime value into a uniqueness
// rule: 'sometimes|unique:users,email,' . $this->user()->id. The static rule
// prefix must still be recovered instead of dropping the whole field, and the
// dynamic operand must not be guessed. Fields without an explicit type rule
// validate scalar strings, so min/max map to string length constraints.
const SOURCE = `<?php
namespace App\\Http\\Requests\\Api {
    use Illuminate\\Foundation\\Http\\FormRequest;

    class UpdateUser extends FormRequest {
        protected function validationData() { return $this->get('user') ?: []; }
        public function authorize() { return true; }
        public function rules() {
            return [
                'username' => 'sometimes|max:50|alpha_num|unique:users,username,' . $this->user()->id,
                'email' => 'sometimes|email|max:255|unique:users,email,' . $this->user()->id,
                'password' => 'sometimes|min:6',
                'bio' => 'sometimes|nullable|max:255',
                'image' => 'sometimes|nullable|url',
            ];
        }
    }

    class RegisterUser extends FormRequest {
        protected function validationData() { return $this->get('user') ?: []; }
        public function authorize() { return true; }
        public function rules() {
            return [
                'username' => 'required|max:50|alpha_num|unique:users,username',
                'email' => 'required|email|max:255|unique:users,email',
                'password' => 'required|min:6',
            ];
        }
    }
}

namespace App\\Http\\Controllers\\Api {
    class UserController {
        public function update(\\App\\Http\\Requests\\Api\\UpdateUser $request) {
            return response()->json(['user' => ['email' => 'a@b.c']]);
        }
        public function store(\\App\\Http\\Requests\\Api\\RegisterUser $request) {
            return response()->json(['user' => ['email' => 'a@b.c']]);
        }
    }
}

namespace {
    use Illuminate\\Support\\Facades\\Route;
    Route::group(['namespace' => 'Api'], function () {
        Route::match(['put', 'patch'], 'user', 'UserController@update');
        Route::post('users', 'UserController@store');
    });
}
`;

it("recovers static rules from concatenated uniqueness values and string length constraints", async () => {
  const root = await mkdtemp(join(tmpdir(), "laravel-rules-concat-"));
  try {
    await writeFile(join(root, "composer.json"), JSON.stringify({ require: { "laravel/framework": "^11" } }));
    await writeFile(join(root, "routes.php"), SOURCE);
    const result = await scanProject({ root });
    const doc = (await result.convert()).document as any;

    for (const method of ["put", "patch"] as const) {
      const wrapper = doc.paths["/user"][method].requestBody.content["application/json"].schema;
      const props = wrapper.properties.user.properties;
      // "sometimes" makes every nested field optional; only the wrapper is required.
      expect(wrapper.required).toEqual(["user"]);
      expect(wrapper.properties.user.required).toBeUndefined();
      // The concatenated uniqueness value no longer discards the field.
      expect(props.username).toEqual({ type: "string", maxLength: 50 });
      expect(props.email).toEqual({ type: "string", format: "email", maxLength: 255 });
      // min:6 applies to the implicit scalar string even without a "string" rule.
      expect(props.password).toEqual({ type: "string", minLength: 6 });
      expect(props.bio).toEqual({ type: ["string", "null"], maxLength: 255 });
      expect(props.image).toEqual({ type: ["string", "null"], format: "uri" });
    }

    const register = doc.paths["/users"].post.requestBody.content["application/json"].schema
      .properties.user.properties;
    expect(register.username).toEqual({ type: "string", maxLength: 50, minLength: 1 });
    expect(register.email).toEqual({ type: "string", format: "email", maxLength: 255, minLength: 1 });
    expect(register.password).toEqual({ type: "string", minLength: 6 });
    expect(doc.paths["/users"].post.requestBody.content["application/json"].schema.properties.user.required)
      .toEqual(["username", "email", "password"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
