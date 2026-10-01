from fastapi import FastAPI

from app.routers.products import router as product_router

app = FastAPI(title="edge-api", version="3.1.0")

app.include_router(product_router, prefix="/v1")
