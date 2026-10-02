from fastapi import FastAPI

from app.items import router as items_router

app = FastAPI(title="sqlmodel-api")
app.include_router(items_router)
