from typing import Annotated

from fastapi import APIRouter
from sqlmodel import Session, select

from app.models import Hero, HeroPublic

router = APIRouter(prefix="/heroes", tags=["heroes"])


@router.get("", response_model=list[HeroPublic])
def list_heroes(db: Annotated[Session, ...]):
    return db.exec(select(Hero)).all()


@router.get("/{hero_id}", response_model=HeroPublic)
def get_hero(hero_id: int):
    return HeroPublic(id=hero_id, name="x", secret_name="y")
