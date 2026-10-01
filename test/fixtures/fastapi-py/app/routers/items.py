from datetime import datetime
from enum import Enum
from typing import Annotated, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/items", tags=["items"])
orphan_router = APIRouter(prefix="/orphan")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/token")


class Color(str, Enum):
    red = "red"
    blue = "blue"


class ItemBase(BaseModel):
    name: str
    price: float
    color: Optional[Color] = None
    tags: List[str] = []


class ItemCreate(ItemBase):
    pass


class Item(ItemBase):
    id: int
    created_at: datetime


@router.get("", summary="List items")
def list_items(
    q: Annotated[Optional[str], Query(max_length=50)] = None,
    limit: int = 20,
    x_tenant: Annotated[str | None, Header()] = None,
):
    return []


@router.post("", status_code=201, response_model=Item)
def create_item(payload: ItemCreate):
    return payload


@router.get("/{item_id}", response_model=Item)
def get_item(item_id: int, token: str = Depends(oauth2_scheme)):
    return {}


@router.get("/stream")
async def stream_items():
    async def event_generator():
        yield {"event": "ping", "data": "{}"}

    return EventSourceResponse(event_generator())


@router.get(f"/dynamic/{1 + 1}")
def dynamic_route():
    return {}


@orphan_router.get("/lonely")
def lonely():
    return {}


class DecoyService:
    def get(self, path):
        return path
