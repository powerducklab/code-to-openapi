import express, { Request, Response, Router } from "express";

interface Article {
  id: number;
  title: string;
  tags: string[];
}

interface ArticleBody {
  title: string;
  body: string;
}

interface ListQuery {
  q?: string;
  page: number;
}

const app = express();
const api = Router();

app.use(express.json());

// Decoy: a plain service object that happens to expose get/post methods.
// It must never be treated as an Express router.
class CacheClient {
  get(key: string): string | undefined {
    return key;
  }
  post(key: string, value: string): void {
    void key;
    void value;
  }
}
const cache = new CacheClient();
cache.get("warmup");
cache.post("warmup", "1");

// Inline arrow handlers with typed generics.
api.get(
  "/articles",
  (req: Request<Record<string, never>, unknown, unknown, ListQuery>, res: Response<Article[]>) => {
    const q = req.query.q;
    const page = req.query.page;
    void q;
    void page;
    res.json([{ id: 1, title: "hello", tags: ["a"] }]);
  },
);

api.post(
  "/articles",
  (req: Request<Record<string, never>, unknown, ArticleBody>, res: Response<Article>) => {
    const created: Article = { id: 2, title: req.body.title, tags: [] };
    res.status(202).json(created);
  },
);

// app.route() chaining with a named function handler.
function getArticle(req: Request<{ id: string }>, res: Response<Article | { error: string }>) {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ id, title: "hello", tags: [] });
}
api.route("/articles/:id").get(getArticle).patch((req: Request<{ id: string }, unknown, ArticleBody>, res) => {
  res.json({ id: Number(req.params.id), title: req.body.title, tags: [] });
});

// Optional parameter and wildcard routes.
api.get("/users/:userId?", (req, res) => {
  const userId = req.params.userId;
  res.json({ userId: userId ?? null });
});
api.get("/files/*", (_req, res) => {
  res.sendStatus(204);
});

// Multiple static paths in one call.
app.get(["/ping", "/healthz"], (_req, res) => {
  res.json({ ok: true });
});

// Cookie, header and non-JSON response.
api.get("/export", (req, res) => {
  const session = req.cookies.session;
  const trace = req.header("X-Trace");
  void session;
  void trace;
  res.setHeader("Content-Type", "text/csv");
  res.status(200).send("id,title\n1,hello\n");
});

// Redirect and explicit 302.
api.get("/old-articles", (_req, res) => {
  res.redirect("/api/articles");
});

// SSE stream with a typed event payload.
api.get("/events", (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const tick = { id: 1, at: new Date().toISOString() };
  res.write(`event: tick\n`);
  res.write(`data: ${JSON.stringify(tick)}\n\n`);
  res.end();
});

app.use("/api", api);

// router.all covers every verb but is emitted once as GET.
app.all("/ready", (_req, res) => {
  res.send("ready");
});

app.listen(3000);
