from fastapi import APIRouter, Depends, FastAPI, status

from app import deps

router = APIRouter()


# The route declares no `item_id` handler parameter; it is pulled from the
# attribute-style dependency Depends(deps.fetch_item). The decorator uses the
# starlette status.HTTP_204_NO_CONTENT constant rather than a bare integer.
@router.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(item=Depends(deps.fetch_item)) -> None:
    return None


app = FastAPI()
app.include_router(router, prefix="/api")
