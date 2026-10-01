from enum import Enum
from typing import List, Optional

from fastapi import APIRouter, Body, Cookie, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.security import APIKeyHeader
from pydantic import BaseModel

router = APIRouter(prefix="/shops", tags=["shops"])
orphan = APIRouter(prefix="/orphan")

api_key_header = APIKeyHeader(name="X-API-Key")


class SortOrder(str, Enum):
    asc = "asc"
    desc = "desc"


class Product(BaseModel):
    sku: str
    price: float
    in_stock: bool = True


class ProductCreate(BaseModel):
    sku: str
    price: float


class Error(BaseModel):
    detail: str


@router.get("", response_model=List[Product])
def list_products(
    q: Optional[str] = None,
    tags: List[str] = Query(default=[]),
    sort: SortOrder = SortOrder.asc,
    x_tenant: Optional[str] = Header(default=None),
    session: Optional[str] = Cookie(default=None),
):
    return []


@router.post("", status_code=201, response_model=Product, responses={400: {"model": Error}})
def create_product(payload: ProductCreate):
    if payload.price < 0:
        raise HTTPException(status_code=400, detail="bad price")
    return Product(sku=payload.sku, price=payload.price)


@router.get("/{product_id}")
def get_product(product_id: int, api_key: str = Depends(api_key_header)):
    if product_id <= 0:
        raise HTTPException(status_code=404, detail="missing")
    return {"sku": "x", "price": 1.0}


@router.put("/{product_id}")
async def replace_product(
    product_id: int,
    title: str = Body(...),
    note: Optional[str] = Body(None),
):
    return {"sku": title}


@router.post("/upload")
async def upload_product(
    file: UploadFile = File(...),
    category: str = Form(...),
):
    return {"category": category}


@router.api_route("/ping", methods=["GET", "HEAD"])
def ping():
    return {"ok": True}


@orphan.get("/lonely")
def lonely():
    return {}


class StorageClient:
    def get(self, key: str) -> str:
        return key

    def post(self, key: str, value: str) -> None:
        pass
