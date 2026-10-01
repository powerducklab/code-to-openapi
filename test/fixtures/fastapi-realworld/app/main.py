from fastapi import FastAPI

from app.routers.products import router as product_router

app = FastAPI(title="Shop API")
app.include_router(product_router)
