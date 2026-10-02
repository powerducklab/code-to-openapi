from starlette.applications import Starlette
from starlette.endpoints import HTTPEndpoint, WebSocketEndpoint
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
import uvicorn


async def list_articles(request):
    return JSONResponse({"items": []})


async def get_article(request):
    return JSONResponse({"id": "fixed", "title": "x"})


async def create_article(request):
    body = await request.json()
    return JSONResponse({"id": 1}, status_code=201)


async def not_found(request):
    return JSONResponse({"detail": "missing"}, status_code=404)


class Users(HTTPEndpoint):
    async def get(self, request):
        return JSONResponse({"users": []})

    async def post(self, request):
        payload = await request.json()
        return JSONResponse({}, status_code=201)


class WsChat(WebSocketEndpoint):
    encoding = "json"

    async def on_receive(self, websocket):
        data = await websocket.receive_json()
        await websocket.send_json({"echo": data})


users_app = Starlette(routes=[
    Route("/", Users),
])

app = Starlette(routes=[
    Route("/articles", list_articles, methods=["GET"]),
    Route("/articles/{article_id}", get_article, methods=["GET"]),
    Route("/articles", create_article, methods=["POST"]),
    Route("/missing", not_found, methods=["GET"]),
    Mount("/users", app=users_app),
    WebSocketRoute("/ws/chat", WsChat),
])

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8011)
