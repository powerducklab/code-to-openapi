from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession


async def get_session() -> AsyncSession:
    ...


async def get_token(request: Request) -> str:
    return request.headers.get("authorization", "")


async def get_current_user(token: Annotated[str, Depends(get_token)]) -> int:
    return 1


SessionDep = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[int, Depends(get_current_user)]
