from typing import Annotated

from fastapi import APIRouter, Path

router = APIRouter(prefix="/{slug}/comments", tags=["comments"])


@router.delete("/{commentId}")
async def delete_comment(
    slug: Annotated[str, Path(title="Article slug")],
    comment_id: Annotated[int, Path(title="Comment id", alias="commentId")],
) -> None:
    return None
