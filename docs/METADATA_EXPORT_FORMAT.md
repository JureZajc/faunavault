# FaunaVault metadata export format v10

FaunaVault metadata export is a deterministic, portable description of the
archive's Photos, Animals, locally stored Taxa, manual Collections and their
memberships, Smart Collection definitions, Import Sessions, Trips & Events, Trash state, and authoritative original-file inventory.
It contains no media bytes and is not a backup, restore format, or supported
import format.

## Version and top-level structure

`archive-metadata.json` is the authoritative artifact. Its top-level fields are:

| Field | Meaning |
| --- | --- |
| `format_version` | Metadata export representation version; v10 is `10`. |
| `source_database_schema_version` | Schema of the SQLite snapshot used to produce this export. |
| `counts` | Photo, active, Trash, Animal, Taxon, manual Collection, membership, Smart Collection, Import Session, Trip/Event, Event membership, and original-byte totals. |
| `photos` | All active and Trash Photos, ordered by local ID. |
| `animals` | All Animals, including those without Photos, ordered by local ID. |
| `taxa` | All locally stored Taxa, including unreferenced rows, ordered by local ID. |
| `collections` | All user-defined Collections, ordered by local ID. |
| `collection_photos` | All Collection membership pairs, including memberships to Trash Photos, ordered by Collection ID then Photo ID. |
| `smart_collections` | Saved versioned catalog queries, ordered by local ID. |
| `archive_events` | All Trips and Events, including empty ones, ordered by local ID. |
| `archive_event_photos` | All Event membership pairs, including Trash Photos, ordered by Event ID then Photo ID. |
| `import_sessions` | All historical sessions, including empty and unfinished ones, ordered by canonical UUID string. |

Export format and database schema versions have separate compatibility
lifecycles. Consumers should reject unsupported `format_version` values but
ignore unknown fields added compatibly to a supported version. Historical v1
exports contain only Photos, Animals, and Taxa; v2 added Collections. Version 3
adds the durable Photo capture-metadata contract. Version 4 adds human review
timestamps. Version 5 adds Smart Collection definitions. Version 6 adds retained capture/GPS source values and manual override markers. Version 7 adds personal Photo Favorites and Ratings. Version 8 adds independent Photo culling decisions. Version 9 adds Import Sessions and Photo provenance. Version 10 adds Trips & Events and their explicit memberships. FaunaVault emits only v10.

There is deliberately no export timestamp. For an unchanged archive, repeated
exports have byte-identical authoritative content. A user may put a date in the
destination directory name without making it part of the data contract.

## JSON records

Each Photo contains these fields:

```text
id
import_session_id
is_favorite
rating
culling_state
original_filename
archive_relative_original_path
media_type
original_size_bytes
original_sha256
captured_at
captured_at_offset_minutes
camera_make
camera_model
lens_model
image_width
image_height
latitude
longitude
extracted_captured_at
extracted_captured_at_offset_minutes
extracted_latitude
extracted_longitude
capture_metadata_overridden
location_metadata_overridden
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
reviewed_at
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
`reviewed_at` records when a person accepted or changed classification metadata; null
means no human review is recorded. A new AI result clears it.
Capture/GPS-only edits, Restore, and Favorite/Rating/culling-only edits do not change this review timestamp.

`is_favorite` is a required JSON boolean. `rating` is a required nullable integer:
null means unrated; 1–5 means an explicit personal rating. The two fields are
independent, survive Trash/restore, and never encode AI confidence. CSV uses
`true`/`false` for Favorite, integers for ratings, and the existing `\N` null
sentinel for unrated. Historical v1–v6 artifacts remain unchanged; consumers must
explicitly support the artifact version.

`culling_state` is a required nullable string: null means undecided; `pick` and
`reject` are explicit user decisions. Reject is independent of Trash; Pick is
independent of Favorite and Rating. Active and trashed Photos both retain it.
CSV adds a `culling_state` column using `pick`, `reject`, or the existing `\N`
null sentinel. Smart Collection query version 1 can additionally store
`culling_state: "pick" | "reject" | "undecided"`; omission/null means no culling
filter. Existing saved queries remain valid. Historical v1–v7 exports stay
unchanged; consumers must explicitly support v10.

`import_session_id` is a required nullable canonical UUID string referencing an
`import_sessions` record in this artifact. Legacy Photos remain null; provenance
is never inferred from timestamps. Trash retains membership. The session remains
after permanent deletion, so `imported_count` can exceed surviving membership.

Each Import Session contains `id`, stable `source_kind` (`browser_upload` or
`folder_import` today), nullable safe `label`, UTC `started_at`, nullable UTC
`completed_at`, `imported_count`, and nullable aggregate `duplicate_count`,
`visual_duplicate_skipped_count`, `unsupported_count`, and `failed_count`.
Completed sessions have nonnegative outcomes; unfinished summaries may be null.
Browser retries replace final reported queue outcomes within the original
session. The server's original imported total remains authoritative even when an
upload response was lost. Labels contain at most 200 printable characters and
no path separators. No source path, failed filename, attempt log, or derived
culling aggregate is exported. `counts.import_sessions` includes all sessions.

`captured_at` is the effective camera-local wall time, extracted or manually supplied, or null. It is never
derived from upload time, filesystem metadata, a filename, or `created_at`.
`captured_at_offset_minutes` independently records a valid paired extracted or manually supplied UTC offset;
null means the UTC offset is unknown. Dimensions describe the
EXIF-oriented logical original. GPS is emitted only as a complete latitude and
longitude pair and remains local metadata; export performs no geocoding or
network access.

`extracted_captured_at`, `extracted_captured_at_offset_minutes`,
`extracted_latitude`, and `extracted_longitude` retain the original extraction
separately from the effective values, with the same timestamp/number/null rules.
`capture_metadata_overridden` and `location_metadata_overridden` are JSON booleans.
A true marker with null effective values means the user intentionally cleared
that group; extraction must not repopulate it. False means there is no manual
override. Schema-15 migration initializes the retained source from the prior
persisted baseline. Restore re-reads the original and clears both markers.

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

Each Collection contains:

```text
id
name
created_at
updated_at
```

The internal normalized uniqueness key is never exported. Each
`collection_photos` record contains only `collection_id` and `photo_id`.
Membership is organizational metadata and is exported even when the referenced
Photo is in Trash.

Each Smart Collection exports `id`, `name`, `query_version`, structured `query`,
`created_at`, and `updated_at`. Query version 1 contains the supported catalog
search, status, category or uncategorized, verified taxon ID, capture date range,
sort, order, Favorites, exact/minimum/Unrated rating, culling, and optional
`import_session_id` criteria. Smart
Collections have no Photo membership pairs.

Photo `animal_id` and Animal `taxon_id` are either JSON `null` or references to
records present in the same export. Every Collection membership references both
a Collection and a Photo in the export. Local integer IDs are stable within the
archive and all arrays use ascending ID order; membership pairs use ascending
`(collection_id, photo_id)` order.

## Encoding, timestamps, and nulls

- JSON is UTF-8 without a BOM, uses visible Unicode, two-space indentation,
  deterministic key ordering, LF newlines, and one final newline.
- Every optional field is present. Absence is JSON `null`, never an empty-string
  substitute, `"NULL"`, or `"None"`. Persisted empty strings remain empty.
- Archive timestamps are UTC ISO-8601 strings in the fixed form
  `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Current SQLite timestamps without offsets have
  FaunaVault UTC semantics; offset-aware legacy values are converted to UTC.
- Photo capture timestamps use fixed
  `YYYY-MM-DDTHH:MM:SS.ffffff` camera-local text without a suffix. They are not
  normalized to UTC; the optional signed offset is exported separately in
  `captured_at_offset_minutes`.
- SHA-256 values are exactly 64 lowercase hexadecimal characters.

## Optional photo CSV

`photos.csv` is an optional convenience view with one row per Photo in the same
order as JSON. Independent Animals and Taxa remain available only in JSON. Its
fixed columns are:

```text
photo_id
import_session_id
import_source_kind
import_label
import_started_at
import_completed_at
is_favorite
rating
culling_state
lifecycle_state
original_filename
archive_relative_original_path
media_type
original_size_bytes
original_sha256
captured_at
captured_at_offset_minutes
camera_make
camera_model
lens_model
image_width
image_height
latitude
longitude
extracted_captured_at
extracted_captured_at_offset_minutes
extracted_latitude
extracted_longitude
capture_metadata_overridden
location_metadata_overridden
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
reviewed_at
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

Capture offsets and dimensions use decimal integers. GPS uses locale-independent
decimal-dot numbers. Capture timestamps use the same zone-free fixed text as
JSON. Override flags use lowercase `true`/`false` in CSV.

## Version history

- v1: Photos, Animals, and Taxa.
- v2: Collections and Collection memberships.
- v3: persisted Photo capture time/offset, camera, lens, dimensions, and GPS.
- v4: nullable Photo human review timestamp.
- v5: versioned Smart Collection query definitions.
- v6: effective capture/GPS values with retained extraction and manual override state.
- v7: required Photo Favorite boolean and nullable integer Rating from 1–5.
- v8: required nullable Photo culling state (`pick`, `reject`, or null), plus
  optional shared Smart Collection culling criteria.
- v9: ordered Import Sessions and their total, historical aggregate outcomes,
  required nullable Photo session membership, optional version-1 Smart Collection
  session criteria, and five CSV provenance columns. Session-only history is
  available in JSON; legacy Photo provenance columns are `\N` in CSV.

- v10: ordered Trips & Events, all authoritative metadata and explicit membership
  pairs including Trash, with Event and membership counts. photos.csv is unchanged.

## Deliberate exclusions

The format excludes originals and all other media bytes, derivative inventory,
perceptual hashes, derived Albums, Collection normalized-name keys,
classification-job history and failures, duplicate candidates, duplicate-review
dismissals and scan bookkeeping,
application configuration, credentials, absolute database/image paths, staging
and purge paths, database internals, and export bookkeeping. There is no import
or restore guarantee. Keep verified FaunaVault backups containing SQLite and
image bytes for disaster recovery.

## Trips & Events (v10)

`archive_events` contains `id`, `kind` (`trip` or `event`), `title`,
`start_date`, `end_date`, nullable `location_label` and `notes`, and
`created_at` / `updated_at`. Dates use canonical `YYYY-MM-DD` and must be ordered;
timestamps use the existing UTC serialization. Titles have normalized whitespace;
notes preserve internal line breaks as plain text. Duplicate titles are allowed.

`archive_event_photos` contains only `event_id` and `photo_id`. IDs are positive,
records and membership pairs are unique and sorted, and both referenced records
must exist in the same export. The `counts` object adds `archive_events` and
`archive_event_memberships`. Empty Events and memberships to Trash Photos are
authoritative data and are included. `photos.csv` is unchanged: as with
Collections, these many-to-many relationships belong in the authoritative JSON.
