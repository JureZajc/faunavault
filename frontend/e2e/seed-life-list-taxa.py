"""Seed local taxonomy for Sighting browser tests without network services."""

import json
import os
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

root = Path(os.environ["FAUNAVAULT_E2E_ROOT"]).resolve()
database = root / "data" / "faunavault.db"
if (
    root.parent != Path(tempfile.gettempdir()).resolve()
    or not root.name.startswith("faunavault-e2e-")
    or database.resolve() != database
):
    raise RuntimeError("Refusing to seed taxonomy outside disposable E2E storage")

taxa = {}
with sqlite3.connect(f"{database.as_uri()}?mode=rw", uri=True) as connection:
    for key, name, scientific_name in (
        ("fox", "Red fox", "Vulpes vulpes"),
        ("owl", "Barn owl", "Tyto alba"),
        ("raven", "Common raven", "Corvus corax"),
    ):
        connection.execute(
            """INSERT INTO taxon (provider, external_taxon_id, common_name,
                   scientific_name, canonical_name, taxonomic_rank, synchronized_at)
               VALUES ('local', ?, ?, ?, ?, 'SPECIES', ?)
               ON CONFLICT (provider, external_taxon_id) DO NOTHING""",
            (
                f"life-list-e2e-{key}",
                f"Fixture {name}",
                scientific_name,
                scientific_name,
                datetime.now(UTC).replace(tzinfo=None).isoformat(sep=" "),
            ),
        )
        row = connection.execute(
            "SELECT id FROM taxon WHERE provider = 'local' AND external_taxon_id = ?",
            (f"life-list-e2e-{key}",),
        ).fetchone()
        taxa[key] = row[0]

print(json.dumps(taxa))
