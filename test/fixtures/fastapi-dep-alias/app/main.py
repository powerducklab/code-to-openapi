from fastapi import FastAPI

from app.items import router as items_router

app = FastAPI(title="dep-alias-api")
app.include_router(items_router)
