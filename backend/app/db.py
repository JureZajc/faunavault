from __future__ import annotations

from typing import Annotated

from fastapi import Depends
from sqlalchemy import Engine, event
from sqlmodel import Session, create_engine

from app.config import Settings, get_settings


def create_database_engine(settings: Settings) -> Engine:
    engine = create_engine(
        settings.resolved_database_url,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, _record) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    return engine


engine = create_database_engine(get_settings())


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
