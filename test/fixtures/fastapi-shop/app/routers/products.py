from typing import Annotated, List, Optional

from fastapi import APIRouter, Body, Cookie, Depends, File, Form, Header, HTTPException, Path, Query, UploadFile
from fastapi.responses import StreamingResponse

from ..schemas import (
    ApiResponse,
    Order,
    PageResult,
    Product,
    ProductCreate,
    ProductUpdate,
    Review,
)

router = APIRouter(prefix="/products", tags=["products"])


class Pagination:
    def __init__(
        self,
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(alias="pageSize", ge=1, le=100)] = 20,
        keyword: Annotated[Optional[str], Query()] = None,
    ):
        self.page = page
        self.page_size = page_size
        self.keyword = keyword


@router.get("", response_model=ApiResponse[PageResult[Product]])
def list_products(pagination: Annotated[Pagination, Depends()]):
    return ApiResponse(data=PageResult(items=[], total=0, page=pagination.page, page_size=pagination.page_size))


@router.post("", response_model=ApiResponse[Product], status_code=201)
def create_product(payload: ProductCreate, x_request_id: Annotated[str, Header()] = "x"):
    return ApiResponse(data=Product(id=1, sku=payload.sku, name=payload.name, price=payload.price, category=payload.category))


@router.get("/{product_id:int}", response_model=ApiResponse[Product])
def get_product(product_id: Annotated[int, Path(...)], session: Annotated[Optional[str], Cookie()] = None):
    if product_id <= 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return ApiResponse(data=Product(id=product_id, sku="A", name="A", price=1.0, category="books"))


@router.put("/{product_id:int}", response_model=ApiResponse[Product])
def update_product(product_id: int, payload: ProductUpdate):
    return ApiResponse(data=Product(id=product_id, sku="A", name=payload.name or "A", price=payload.price or 1.0, category="books"))


@router.patch("/{product_id:int}", response_model=ApiResponse[Product])
def patch_product(product_id: int, payload: Annotated[dict, Body()], fields: Annotated[List[str], Body()]):
    return ApiResponse(data=Product(id=product_id, sku="A", name="A", price=1.0, category="books"))


@router.delete("/{product_id:int}", status_code=204)
def delete_product(product_id: int):
    return None


@router.post("/{product_id:int}/reviews", response_model=ApiResponse[Review], status_code=201)
def add_review(product_id: int, review: Review):
    return ApiResponse(data=review)


@router.post("/upload")
async def upload_product_image(
    product_id: Annotated[int, Form()],
    file: UploadFile = File(...),
    caption: Annotated[str, Form()] = "",
):
    return {"product_id": product_id, "filename": file.filename, "caption": caption}


@router.get("/{product_id:int}/events")
def product_events(product_id: int):
    def stream():
        yield b"event: update\ndata: {}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


orders_router = APIRouter(prefix="/orders", tags=["orders"])


@orders_router.get("", response_model=ApiResponse[List[Order]])
def list_orders():
    return ApiResponse(data=[])


@orders_router.get("/{order_id}", response_model=ApiResponse[Order], responses={404: {"model": dict}})
def get_order(order_id: int):
    if order_id <= 0:
        raise HTTPException(status_code=404, detail="Order not found")
    return ApiResponse(data=Order(id=order_id, product_id=1, quantity=1, total=1.0, status="new"))
