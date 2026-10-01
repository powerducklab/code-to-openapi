from fastapi import FastAPI

from .routers import products

app = FastAPI(title="Shop API", version="1.0.0")

app.include_router(products.router, prefix="/api/v1")
app.include_router(products.orders_router, prefix="/api/v1")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
