from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlmodel import Session

from app.config import get_settings
from app.database import create_database_engine

engine = create_database_engine(get_settings())


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
