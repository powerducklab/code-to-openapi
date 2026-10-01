import uvicorn
from fastapi import FastAPI

from app.routers.items import router as items_router

app = FastAPI(title="Fixture API", version="2.3.4")
app.include_router(items_router, prefix="/api/v1")


class OtherClient:
    def __init__(self):
        self.session = None


decoy = OtherClient()


@decoy.get("/must-not-be-a-route")
def decoy_handler():
    return {}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8090)
