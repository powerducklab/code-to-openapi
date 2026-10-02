from fastapi import FastAPI

from app.routers.comments import router as comments_router

app = FastAPI(title="path-alias-api")
app.include_router(comments_router, prefix="/articles")
