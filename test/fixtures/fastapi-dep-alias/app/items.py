from typing import Annotated, Optional

from fastapi import APIRouter, Query

from app.deps import CurrentUser, SessionDep

router = APIRouter(prefix="/items", tags=["items"])


@router.get("")
def list_items(
    session: SessionDep,
    current_user: CurrentUser,
    q: Annotated[Optional[str], Query(description="search")] = None,
):
    return []
