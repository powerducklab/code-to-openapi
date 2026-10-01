from enum import Enum
from typing import Generic, List, Optional, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    code: int = 0
    message: str = "ok"
    data: Optional[T] = None


class PageResult(BaseModel, Generic[T]):
    items: List[T]
    total: int
    page: int
    page_size: int


class Category(str, Enum):
    electronics = "electronics"
    books = "books"
    food = "food"


class Review(BaseModel):
    id: int
    author: str
    rating: int = Field(ge=1, le=5)
    comment: Optional[str] = None


class Product(BaseModel):
    id: int
    sku: str
    name: str
    price: float
    category: Category
    tags: List[str] = Field(default_factory=list)
    reviews: List[Review] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)


class ProductCreate(BaseModel):
    sku: str
    name: str
    price: float = Field(gt=0)
    category: Category
    tags: List[str] = Field(default_factory=list)


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    price: Optional[float] = None
    tags: Optional[List[str]] = None


class Order(BaseModel):
    id: int
    product_id: int
    quantity: int
    total: float
    status: str
