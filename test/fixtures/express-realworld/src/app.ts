import express, { Request, Response, Router } from "express";

interface Product {
  id: string;
  name: string;
  price: number;
  tags: string[];
  category: { id: number; name: string };
}

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface PageResult<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
}

interface ProductListQuery {
  page: number;
  keyword?: string;
}

interface CreateProductBody {
  name: string;
  price: number;
}

const app = express();
const api = Router();
app.use(express.json());

api.get(
  "/products/:id",
  (req: Request<{ id: string }>, res: Response<ApiResponse<Product>>) => {
    res.json({
      code: 0,
      message: "ok",
      data: {
        id: req.params.id,
        name: "hammer",
        price: 9.99,
        tags: ["tool"],
        category: { id: 1, name: "hardware" },
      },
    });
  },
);

api.get(
  "/products",
  (
    req: Request<Record<string, never>, unknown, unknown, ProductListQuery>,
    res: Response<ApiResponse<PageResult<Product>>>,
  ) => {
    void req.query.page;
    res.json({
      code: 0,
      message: "ok",
      data: { items: [], page: 1, perPage: 20, total: 0 },
    });
  },
);

api.post(
  "/products",
  (
    req: Request<Record<string, never>, unknown, CreateProductBody>,
    res: Response<ApiResponse<Product>>,
  ) => {
    res.status(201).json({
      code: 0,
      message: "created",
      data: {
        id: "p-1",
        name: req.body.name,
        price: req.body.price,
        tags: [],
        category: { id: 1, name: "hardware" },
      },
    });
  },
);

app.use("/api", api);
app.listen(3000);
