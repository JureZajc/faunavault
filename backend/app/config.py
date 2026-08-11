from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _default_image_root() -> Path:
    if os.name == "nt":
        return Path("E:/FaunaVault/data/images")
    return Path("/mnt/e/FaunaVault/data/images")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = BACKEND_DIR / "data"
    image_dir: Path = Field(default_factory=_default_image_root)
    database_url: str = "sqlite:///./data/faunavault.db"
    ollama_base_url: str = "http://localhost:11434"
    ai_primary_model: str = "qwen3-vl:8b"
    ai_fallback_model: str = "gemma4:e4b"
    ai_confidence_threshold: float = Field(default=0.65, ge=0, le=1)
    gbif_base_url: str = "https://api.gbif.org/v1"
    max_upload_bytes: int = Field(default=50 * 1024 * 1024, ge=1)
    max_image_pixels: int = Field(default=80_000_000, ge=1)

    @field_validator("data_dir", "image_dir", mode="after")
    @classmethod
    def expand_path(cls, value: Path) -> Path:
        return value.expanduser()

    @property
    def resolved_database_url(self) -> str:
        url = make_url(self.database_url)
        if url.get_backend_name() != "sqlite":
            raise ValueError("FaunaVault supports SQLite database URLs only")
        if not url.database or url.database == ":memory:":
            return self.database_url

        database_path = Path(url.database).expanduser()
        if not database_path.is_absolute():
            database_path = (BACKEND_DIR / database_path).resolve()
        return str(url.set(database=str(database_path)))

    @property
    def database_path(self) -> Path | None:
        url = make_url(self.resolved_database_url)
        if not url.database or url.database == ":memory:":
            return None
        return Path(url.database)

    @property
    def image_dirs(self) -> dict[str, Path]:
        return {
            "original": self.image_dir / "original",
            "resized": self.image_dir / "resized",
            "thumbs": self.image_dir / "thumbs",
        }

    @property
    def staging_dir(self) -> Path:
        return self.image_dir / ".staging"

    @property
    def purge_dir(self) -> Path:
        return self.image_dir / ".purge"


@lru_cache
def get_settings() -> Settings:
    return Settings()
