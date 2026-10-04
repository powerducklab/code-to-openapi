import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "drf-py");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("Django REST Framework pack", () => {
  it("produces a valid document with ModelViewSet CRUD routes under the router mount", async () => {
    const { result, converted } = await scan();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    // Router-generated CRUD for ArticleViewSet (DefaultRouter mounted at /api/).
    const list = op(ops, "get", "/api/articles/");
    expect(list.responses[0].content[0].mediaType).toBe("application/json");

    const create = op(ops, "post", "/api/articles/");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/ArticleSerializer",
    });
    expect(create.responses[0].statusCode).toBe("201");

    const retrieve = op(ops, "get", "/api/articles/{pk}/");
    expect(retrieve.parameters.map((p: any) => p.name)).toEqual(["pk"]);

    const put = op(ops, "put", "/api/articles/{pk}/");
    expect(put.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/ArticleSerializer",
    });

    const del = op(ops, "delete", "/api/articles/{pk}/");
    expect(del.responses[0].statusCode).toBe("204");
  });

  it("expands @action extra routes and GenericViewSet partial routes", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const favorite = op(ops, "post", "/api/articles/{pk}/favorite/");
    expect(favorite).toBeDefined();

    const feed = op(ops, "get", "/api/articles/feed/");
    expect(feed).toBeDefined();

    const commentsList = op(ops, "get", "/api/articles/{article_slug}/comments/");
    expect(commentsList.parameters.map((p: any) => p.name)).toEqual(["article_slug"]);

    const commentsCreate = op(ops, "post", "/api/articles/{article_slug}/comments/");
    expect(commentsCreate.responses[0].statusCode).toBe("201");
  });

  it("treats a viewset whose serializer is only resolved in get_serializer_class() as an honest gap", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const draftsList = op(ops, "get", "/api/drafts/");
    expect(draftsList.gaps).toContain("response-schema-unknown");

    const draftsCreate = op(ops, "post", "/api/drafts/");
    expect(draftsCreate.requestBody.content[0].schema).toEqual({});
    expect(draftsCreate.gaps).toContain("body-schema-unknown");
  });

  it("wires APIView / GenericAPIView / @api_view through Django urlpatterns", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const health = op(ops, "get", "/health/");
    expect(health).toBeDefined();

    const healthDel = op(ops, "delete", "/health/");
    expect(healthDel.responses[0].statusCode).toBe("204");

    const echo = op(ops, "post", "/echo/");
    expect(echo.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/ProfileSerializer",
    });

    op(ops, "get", "/ping/");
    op(ops, "post", "/ping/");

    const profile = op(ops, "get", "/profiles/{username}/");
    expect(profile.parameters.map((p: any) => p.name)).toEqual(["username"]);
  });

  it("builds serializer components with nested serializers and ListField", async () => {
    const { result } = await scan();
    const components = new Map(
      result.project.components.map((c: any) => [c.name, c.schema]),
    );

    const article = components.get("ArticleSerializer");
    expect(article).toBeDefined();
    expect(article.properties.title).toEqual({ type: "string", minLength: 1 });
    expect(article.properties.author).toEqual({
      $ref: "#/components/schemas/ProfileSerializer",
      readOnly: true,
    });
    expect(article.properties.tag_list).toEqual({
      type: "array",
      items: { type: "string" },
    });
    // SerializerMethodField carries no inspectable return shape: honest gap.
    expect(article.properties.rating).toEqual({readOnly: true});

    const comment = components.get("CommentSerializer");
    expect(comment.properties.author).toEqual({
      $ref: "#/components/schemas/ProfileSerializer",
      readOnly: true,
    });
  });
});
