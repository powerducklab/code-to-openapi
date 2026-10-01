from typing import Generic, List, Optional, TypeVar

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

T = TypeVar("T")


class Category(BaseModel):
    id: int
    name: str


class Product(BaseModel):
    id: str
    name: str
    price: float
    tags: List[str] = Field(default_factory=list)
    category: Optional[Category] = None


class ApiResponse(BaseModel, Generic[T]):
    code: int
    message: str
    data: T


class PageResult(BaseModel, Generic[T]):
    items: List[T]
    page: int
    per_page: int
    total: int


class ProductCreate(BaseModel):
    name: str
    price: float


router = APIRouter(prefix="/api")


@router.get("/products/{product_id}", response_model=ApiResponse[Product])
def get_product(product_id: str):
    return ApiResponse(code=0, message="ok", data=Product(id=product_id, name="hammer", price=9.99))


@router.get("/products", response_model=ApiResponse[PageResult[Product]])
def list_products(
    page: int = Query(1),
    keyword: Optional[str] = Query(None),
):
    return ApiResponse(code=0, message="ok", data=PageResult(items=[], page=page, per_page=20, total=0))


@router.post("/products", response_model=ApiResponse[Product], status_code=201)
def create_product(payload: ProductCreate):
    return ApiResponse(code=0, message="created", data=Product(id="p-1", name=payload.name, price=payload.price))
