import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

// Mirrors the Echo RealWorld constructor pattern: a constructor allocates the
// slice with make(), every appended element comes from new(T), and element
// slices are also make()-initialized. Those success-path values can never
// serialize as null, even though the declared slice/pointer types are nullable.
it("proves constructor make/new/append allocations are non-nil on the success path", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-ctor-narrow-"));
  try {
    await writeFile(join(root, "go.mod"), "module example\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.0.0");
    await writeFile(
      join(root, "main.go"),
      `package main
import "github.com/labstack/echo/v4"

type author struct {
\tUsername string  \x60json:"username"\x60
\tBio      *string \x60json:"bio"\x60
}
type item struct {
\tSlug   string   \x60json:"slug"\x60
\tTags   []string \x60json:"tags"\x60
\tAuthor author   \x60json:"author"\x60
}
type listResponse struct {
\tItems []*item \x60json:"items"\x60
\tTotal int     \x60json:"total"\x60
}
func newList(names []string) *listResponse {
\tr := new(listResponse)
\tr.Items = make([]*item, 0)
\tfor _, name := range names {
\t\tit := new(item)
\t\tit.Slug = name
\t\tit.Tags = make([]string, 0)
\t\tr.Items = append(r.Items, it)
\t}
\tr.Total = len(names)
\treturn r
}
func handle(c echo.Context) error {
\treturn c.JSON(200, newList([]string{"a", "b"}))
}
func main() { e := echo.New(); e.GET("/list", handle) }`,
    );
    const doc = (await (await scanProject({ root })).convert()).document as any;
    const schema = doc.paths["/list"].get.responses["200"].content["application/json"].schema;

    // The constructor specialization is inlined so it can diverge from the
    // nullable declared component.
    expect(schema.type).toBe("object");
    const items = schema.properties.items;
    expect(items.type).toBe("array");
    expect(Array.isArray(items.type)).toBe(false);
    // Each appended element is new(item), never nil.
    const element = items.items;
    expect(element.type).toBe("object");
    // Element tags are make()-initialized, never null.
    expect(element.properties.tags.type).toBe("array");
    // A pointer field without omitempty is still emitted (required key), but its
    // value can be null; the constructor proof must not force it non-null.
    const bio = element.properties.author.properties.bio;
    expect(bio.type).toContain("null");
    expect(element.properties.author.required).toContain("bio");
    expect(schema.required).toContain("items");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
