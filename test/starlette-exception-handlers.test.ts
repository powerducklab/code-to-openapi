import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

async function scanPy(source: string) {
  const root = await mkdtemp(join(tmpdir(), "starlette-eh-"));
  await writeFile(join(root, "app.py"), source);
  const result = await scanProject({ root });
  const converted = await result.convert();
  await rm(root, { recursive: true, force: true });
  return converted.document as any;
}

function mediaFor(doc: any, path: string, code: string): string[] {
  const response = doc.paths[path].get.responses[code];
  return response?.content ? Object.keys(response.content) : [];
}
function codes(doc: any, path: string): string[] {
  return Object.keys(doc.paths[path].get.responses).sort();
}

it("maps a built-in HTTPException to its status with text/plain body", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.exceptions import HTTPException
async def forbid(request):
    raise HTTPException(status_code=403, detail="forbidden")
async def ok(request):
    return JSONResponse({"ok": True})
app = Starlette(routes=[Route("/ok", ok), Route("/forbid", forbid)])
`);
  expect(codes(doc, "/forbid")).toEqual(["403"]);
  expect(mediaFor(doc, "/forbid", "403")).toEqual(["text/plain; charset=utf-8"]);
});

it("resolves a custom exception class registered in exception_handlers", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
class NotEnoughCoffee(Exception):
    pass
async def coffee_handler(request, exc):
    return JSONResponse(status_code=418, content={"detail": "coffee"})
async def coffee(request):
    raise NotEnoughCoffee()
app = Starlette(routes=[Route("/coffee", coffee)],
                exception_handlers={NotEnoughCoffee: coffee_handler})
`);
  expect(codes(doc, "/coffee")).toEqual(["418"]);
  expect(mediaFor(doc, "/coffee", "418")).toEqual(["application/json"]);
  const schema = doc.paths["/coffee"].get.responses["418"].content["application/json"].schema;
  expect(schema.properties.detail.type).toBe("string");
});

it("resolves an integer-keyed handler overriding the built-in HTTP status", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.exceptions import HTTPException
async def custom404(request, exc):
    return JSONResponse(status_code=404, content={"error": "missing"})
async def missing(request):
    raise HTTPException(status_code=404)
app = Starlette(routes=[Route("/missing", missing)],
                exception_handlers={404: custom404})
`);
  expect(codes(doc, "/missing")).toEqual(["404"]);
  expect(mediaFor(doc, "/missing", "404")).toEqual(["application/json"]);
});

it("supports @app.exception_handler and add_exception_handler", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.exceptions import HTTPException
async def conflict(request):
    raise HTTPException(status_code=409)
async def gone(request):
    raise HTTPException(status_code=410)
app = Starlette(routes=[Route("/conflict", conflict), Route("/gone", gone)])
@app.exception_handler(409)
async def h409(request, exc):
    return JSONResponse(status_code=409, content={"error": "conflict"})
async def h410(request, exc):
    return JSONResponse(status_code=410, content={"error": "gone"})
app.add_exception_handler(410, h410)
`);
  expect(mediaFor(doc, "/conflict", "409")).toEqual(["application/json"]);
  expect(mediaFor(doc, "/gone", "410")).toEqual(["application/json"]);
});

it("emits a plain 500 for an unregistered exception in production mode", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
async def boom(request):
    raise ValueError("kaboom")
app = Starlette(routes=[Route("/boom", boom)])
`);
  expect(codes(doc, "/boom")).toEqual(["500"]);
  expect(mediaFor(doc, "/boom", "500")).toEqual(["text/plain; charset=utf-8"]);
});

it("content-negotiates the traceback when debug=True", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
async def boom(request):
    raise ValueError("kaboom")
app = Starlette(routes=[Route("/boom", boom)], debug=True)
`);
  const media = mediaFor(doc, "/boom", "500");
  expect(media).toContain("text/html; charset=utf-8");
  expect(media).toContain("text/plain; charset=utf-8");
});

it("routes an unregistered exception through a BaseHTTPMiddleware except block", async () => {
  const doc = await scanPy(`
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
async def ok(request):
    return JSONResponse({"ok": True})
async def forbid(request):
    raise HTTPException(status_code=403, detail="no")
async def boom(request):
    raise ValueError("kaboom")
class Catch(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        try:
            return await call_next(request)
        except Exception:
            return JSONResponse(status_code=503, content={"error": "mw"})
app = Starlette(routes=[Route("/ok", ok), Route("/forbid", forbid), Route("/boom", boom)],
                middleware=[Middleware(Catch)])
`);
  // Normal and HTTPException routes are not wrapped in the middleware error.
  expect(codes(doc, "/ok")).toEqual(["200"]);
  expect(codes(doc, "/forbid")).toEqual(["403"]);
  // The unregistered exception surfaces from the middleware except block.
  expect(codes(doc, "/boom")).toEqual(["503"]);
  expect(mediaFor(doc, "/boom", "503")).toEqual(["application/json"]);
});
