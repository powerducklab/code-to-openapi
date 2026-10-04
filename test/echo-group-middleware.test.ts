import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scanProject} from '../src/index.js';

// Group-level auth middleware returns 401 from its per-request closure. The
// protected group inherits that response; a public route and a Skipper-exempt
// GET must not. Bound request structs honor validate:"required" tags.
it('associates Echo group middleware responses and validate tags',async()=>{
 const root=await mkdtemp(join(tmpdir(),'echo-groupmw-'));
 try{
  await writeFile(join(root,'go.mod'),'module example\ngo 1.22\nrequire github.com/labstack/echo/v4 v4.0.0');
  await writeFile(join(root,'main.go'),`package main
import "github.com/labstack/echo/v4"

type apiError struct { Errors map[string]string \x60json:"errors"\x60 }

func newError(msg string) apiError {
 e := apiError{}
 e.Errors = map[string]string{"body": msg}
 return e
}

// Auth delegates to AuthWithConfig, mirroring the echo realworld JWT/JWTWithConfig layout.
func Auth() echo.MiddlewareFunc { return AuthWithConfig() }

func AuthWithConfig() echo.MiddlewareFunc {
 return func(next echo.HandlerFunc) echo.HandlerFunc {
  return func(c echo.Context) error {
   if c.Request().Header.Get("Authorization") == "" {
    return c.JSON(401, newError("missing token"))
   }
   return next(c)
  }
 }
}

type createRequest struct {
 Title string \x60json:"title" validate:"required"\x60
}

func (r *createRequest) bind(c echo.Context) error {
 if err := c.Bind(r); err != nil { return err }
 return c.Validate(r)
}

func secret(c echo.Context) error { return c.JSON(200, map[string]any{"ok": true}) }
func health(c echo.Context) error { return c.JSON(200, map[string]any{"up": true}) }
func create(c echo.Context) error {
 r := &createRequest{}
 if err := r.bind(c); err != nil { return c.JSON(422, newError("invalid")) }
 return c.JSON(201, map[string]any{"created": true})
}

func main() {
 e := echo.New()
 authMiddleware := Auth()
 g := e.Group("/api", authMiddleware)
 g.GET("/secret", secret)
 g.POST("/things", create)
 e.GET("/health", health)
}`);
  const converted=await (await scanProject({root})).convert();
  expect(converted.documentValid).toBe(true);
  const doc=converted.document as any;

  // Protected group routes inherit the middleware 401 response.
  const secret=doc.paths['/api/secret'].get.responses;
  expect(Object.keys(secret).sort()).toContain('401');
  const createOp=doc.paths['/api/things'].post.responses;
  expect(Object.keys(createOp).sort()).toContain('401');

  // The public, ungrouped route has no middleware 401.
  expect(doc.paths['/health'].get.responses['401']).toBeUndefined();

  // validate:"required" is honored on the bound request body.
  const media=doc.paths['/api/things'].post.requestBody.content['application/json'];
  const ref=media.schema.$ref as string;
  const inputSchema=ref ? doc.components.schemas[ref.split('/').pop()!] : media.schema;
  expect(inputSchema.required).toContain('title');
 }finally{
  await rm(root,{recursive:true,force:true});
 }
});
