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

// An interface-typed field dispatches to a concrete implementation. When every
// implementation normalizes its slice result (nil guard), the wire value is
// provably non-null even though the declared interface return is a nullable slice.
it("proves non-nil slices through interface method implementations", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-iface-narrow-"));
  try {
    await writeFile(join(root, "go.mod"), "module example\ngo 1.22");
    await writeFile(
      join(root, "main.go"),
      `package main
import("encoding/json";"net/http")
type Item struct { Name string \x60json:"name"\x60 }
type Storage interface { List() ([]Item, error) }
type goodService struct{}
func (s *goodService) List() ([]Item, error) {
\tvar items []Item
\tfor _, x := range []Item{{Name:"a"}} { items = append(items, x) }
\tif items == nil { items = []Item{} }
\treturn items, nil
}
type Server struct{ store Storage }
func (s *Server) list(w http.ResponseWriter, r *http.Request) {
\titems, _ := s.store.List()
\tjson.NewEncoder(w).Encode(map[string]any{"items": items})
}
func main(){ s:=&Server{store:&goodService{}}; m:=http.NewServeMux(); m.HandleFunc("GET /items", s.list) }`,
    );
    const doc = (await (await scanProject({ root })).convert()).document as any;
    const schema = doc.paths["/items"].get.responses["200"].content["application/json"].schema;
    expect(schema.properties.items.type).toBe("array");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// When an implementation can return nil on another branch, the slice must stay
// nullable; the proof never forces non-null against a real nil return.
it("keeps slices nullable when an implementation has a nil return branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-iface-nil-"));
  try {
    await writeFile(join(root, "go.mod"), "module example\ngo 1.22");
    await writeFile(
      join(root, "main.go"),
      `package main
import("encoding/json";"net/http")
type Item struct { Name string \x60json:"name"\x60 }
type Storage interface { List() ([]Item, error) }
type maybeService struct{}
func (s *maybeService) List() ([]Item, error) {
\tif true { return nil, nil }
\treturn []Item{{Name:"a"}}, nil
}
type Server struct{ store Storage }
func (s *Server) list(w http.ResponseWriter, r *http.Request) {
\titems, _ := s.store.List()
\tjson.NewEncoder(w).Encode(map[string]any{"items": items})
}
func main(){ s:=&Server{store:&maybeService{}}; m:=http.NewServeMux(); m.HandleFunc("GET /items", s.list) }`,
    );
    const doc = (await (await scanProject({ root })).convert()).document as any;
    const schema = doc.paths["/items"].get.responses["200"].content["application/json"].schema;
    expect(schema.properties.items.type).toContain("null");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Hand-written validators (`if u.Field == ""` / `u.Field.IsZero()` -> 422) define
// required request fields even though the struct tags carry no binding rule.
it("recovers required request fields from a hand-written validate function", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-validate-"));
  try {
    await writeFile(join(root, "go.mod"), "module example\ngo 1.22");
    await writeFile(
      join(root, "main.go"),
      `package main
import("encoding/json";"net/http";"time")
type User struct {
\tName string \x60json:"name"\x60
\tDob  time.Time \x60json:"dob"\x60
\tNote string \x60json:"note"\x60
}
func validateUser(u User) []string {
\tvar errs []string
\tif u.Name == "" { errs = append(errs, "name is required") }
\tif u.Dob.IsZero() { errs = append(errs, "dob is required") }
\treturn errs
}
func create(w http.ResponseWriter, r *http.Request) {
\tvar u User
\tif err := json.NewDecoder(r.Body).Decode(&u); err != nil { w.WriteHeader(400); return }
\tif errs := validateUser(u); len(errs) > 0 { w.WriteHeader(422); return }
\tjson.NewEncoder(w).Encode(u)
}
func main(){ m:=http.NewServeMux(); m.HandleFunc("POST /users", create) }`,
    );
    const doc = (await (await scanProject({ root })).convert()).document as any;
    const schema = doc.paths["/users"].post.requestBody.content["application/json"].schema;
    expect(schema.$ref).toBeUndefined();
    expect(schema.required.sort()).toEqual(["dob", "name"]);
    // `note` is read by no emptiness check and must not be marked required.
    expect(schema.required).not.toContain("note");
    expect(schema.properties.note).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
