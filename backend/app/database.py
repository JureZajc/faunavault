from __future__ import annotations

import sqlite3

from sqlalchemy import Engine, event
from sqlmodel import create_engine

from app.config import Settings


def unicode_lower(value: object | None) -> str:
    return str(value or "").lower()


def configure_sqlite_connection(connection) -> None:
    connection.create_function(
        "faunavault_unicode_lower",
        1,
        unicode_lower,
        deterministic=True,
    )
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


@event.listens_for(Engine, "connect")
def configure_sqlite_engine_connection(connection, _record) -> None:
    if isinstance(connection, sqlite3.Connection):
        configure_sqlite_connection(connection)


def create_database_engine(settings: Settings) -> Engine:
    return create_engine(
        settings.resolved_database_url,
        connect_args={"check_same_thread": False},
    )
