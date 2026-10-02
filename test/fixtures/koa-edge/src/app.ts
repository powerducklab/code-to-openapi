import Koa from "koa";
import usersRouter from "./routes/users.js";
import ordersRouter from "./routes/orders.js";

const app = new Koa();

app.use(usersRouter.routes());
app.use(usersRouter.allowedMethods());
app.use(ordersRouter.routes());

export default app;
