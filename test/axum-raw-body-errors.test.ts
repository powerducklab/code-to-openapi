import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/index.js";

it("axum: untagged Bytes body, Err(StatusCode) arm, and Result<String> text", async () => {
  const root = await mkdtemp(join(tmpdir(), "axum-raw-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "Cargo.toml"),
      `[package]\nname = "kv"\nversion = "0.1.0"\n[dependencies]\naxum = "0.8"\n`,
    );
    await writeFile(
      join(root, "src", "main.rs"),
      `use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Router, routing::get};

#[derive(Default)]
struct App;

async fn kv_get(Path(key): Path<String>, State(app): State<App>) -> Result<Bytes, StatusCode> {
    if key.is_empty() {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Bytes::from_static(b"v"))
}

async fn kv_set(Path(key): Path<String>, State(app): State<App>, bytes: Bytes) {}

async fn whoami() -> Result<String, StatusCode> {
    Ok(String::from("alice"))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/{key}", get(kv_get).post(kv_set))
        .route("/whoami", get(whoami))
        .with_state(App);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
    );
    const result = await scanProject({ root });
    const converted = await result.convert();
    expect(converted.documentValid).toBe(true);
    const doc = converted.document as any;
    const ops = result.project.operations;

    const post = ops.find((o: any) => o.path === "/{key}" && o.method === "post")!;
    expect(post.requestBody.content[0].mediaType).toBe("application/octet-stream");
    expect(post.requestBody.content[0].schema).toEqual({ type: "string", format: "binary" });

    const get = ops.find((o: any) => o.path === "/{key}" && o.method === "get")!;
    const getStatuses = Object.keys(doc.paths["/{key}"].get.responses).sort();
    expect(getStatuses).toContain("200");
    expect(getStatuses).toContain("404");
    expect(get.responses.find((r: any) => r.statusCode === "404")?.content).toBeUndefined();

    const who = ops.find((o: any) => o.path === "/whoami" && o.method === "get")!;
    expect(who.responses[0].content[0].mediaType).toBe("text/plain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
