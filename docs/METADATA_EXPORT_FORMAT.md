# FaunaVault metadata export format v1

FaunaVault metadata export is a deterministic, portable description of the
archive's Photos, Animals, locally stored Taxa, Trash state, and authoritative
original-file inventory. It contains no media bytes and is not a backup, restore
format, or supported import format.

## Version and top-level structure

`archive-metadata.json` is the authoritative artifact. Its top-level fields are:

| Field | Meaning |
| --- | --- |
| `format_version` | Metadata export representation version; v1 is `1`. |
| `source_database_schema_version` | Schema of the SQLite snapshot used to produce this export. |
| `counts` | Photo, active, Trash, Animal, Taxon, and original-byte totals. |
| `photos` | All active and Trash Photos, ordered by local ID. |
| `animals` | All Animals, including those without Photos, ordered by local ID. |
| `taxa` | All locally stored Taxa, including unreferenced rows, ordered by local ID. |

Export format and database schema versions have separate compatibility
lifecycles. A database migration does not automatically require export format
v2. Consumers should reject unsupported `format_version` values but ignore
unknown fields added compatibly to a supported version.

There is deliberately no export timestamp. For an unchanged archive, repeated
exports have byte-identical authoritative content. A user may put a date in the
destination directory name without making it part of the data contract.

## JSON records

Each Photo contains these fields:

```text
id
original_filename
archive_relative_original_path
media_type
original_size_bytes
original_sha256
display_title
common_name
breed_guess
species_guess
category
confidence
description
tags
status
animal_id
lifecycle_state
deleted_at
created_at
updated_at
```

`archive_relative_original_path` is a normalized POSIX path of the form
`images/original/<stored filename>`. The stored filename is therefore available
as its basename without a redundant field. Size and lowercase SHA-256 describe
the original bytes streamed and verified during export. No resized or thumbnail
path, checksum, or content is included.

`lifecycle_state` is `active` or `trash`. Active records have `deleted_at: null`;
Trash records have a timestamp. `status` is the durable Photo classification
outcome, not classification-job execution state. `tags` is always a JSON string
array and retains its stored order.

Each Animal contains:

```text
id
identifier
display_name
taxon_id
legacy_common_name
legacy_species_name
taxonomy_status
taxonomy_note
created_at
updated_at
```

The normalized `legacy_species_group` and derived album membership are omitted.
Verified grouping follows `taxon_id`; legacy grouping can be reconstructed from
the preserved legacy species name.

Each Taxon contains:

```text
id
provider
external_taxon_id
scientific_name
canonical_name
common_name
rank
kingdom
phylum
class
order
family
genus
species
synchronized_at
```

Provider taxon IDs are strings. These records describe the local taxonomy
snapshot; export never contacts GBIF.

Photo `animal_id` and Animal `taxon_id` are either JSON `null` or references to
records present in the same export. Local integer IDs are stable within the
archive and all arrays use ascending ID order.

## Encoding, timestamps, and nulls

- JSON is UTF-8 without a BOM, uses visible Unicode, two-space indentation,
  deterministic key ordering, LF newlines, and one final newline.
- Every optional field is present. Absence is JSON `null`, never an empty-string
  substitute, `"NULL"`, or `"None"`. Persisted empty strings remain empty.
- Timestamps are UTC ISO-8601 strings in the fixed form
  `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Current SQLite timestamps without offsets have
  FaunaVault UTC semantics; offset-aware legacy values are converted to UTC.
- SHA-256 values are exactly 64 lowercase hexadecimal characters.

## Optional photo CSV

`photos.csv` is an optional convenience view with one row per Photo in the same
order as JSON. Independent Animals and Taxa remain available only in JSON. Its
fixed columns are:

```text
photo_id
lifecycle_state
original_filename
archive_relative_original_path
media_type
original_size_bytes
original_sha256
display_title
common_name
breed_guess
species_guess
category
confidence
description
tags
status
animal_id
animal_identifier
animal_display_name
taxon_id
taxon_provider
taxon_external_id
taxon_scientific_name
taxon_common_name
deleted_at
created_at
updated_at
```

CSV is UTF-8 without a BOM and uses LF record endings. Python's `csv` module
provides quoting for commas, quotes, and embedded newlines. Tags are compact JSON
arrays within their cell, so punctuation inside a tag is unambiguous.

CSV uses the literal two-character value `\N` for null. An actual empty string
is an empty cell. To preserve arbitrary text unambiguously, a non-null value that
starts with a backslash receives one additional leading backslash. A decoder
maps exact `\N` to null and otherwise removes one slash from values beginning
with two backslashes.

## Deliberate exclusions

The format excludes originals and all other media bytes, derivative inventory,
perceptual hashes, derived albums, classification-job history and failures,
application configuration, credentials, absolute database/image paths, staging
and purge paths, database internals, and export bookkeeping. There is no import
or restore guarantee. Keep verified FaunaVault backups containing SQLite and
image bytes for disaster recovery.
