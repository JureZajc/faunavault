def validate_bounding_box(south, north, west, east) -> None:
    """Validate the shape of a box after its numeric fields have been parsed."""
    if south is north is west is east is None:
        return
    if south is None or north is None or west is None or east is None:
        raise ValueError("provide all four bbox coordinates together")
    if south >= north:
        raise ValueError("bbox_south must be less than bbox_north")
    if west == east or (west == 180 and east == -180):
        raise ValueError("bounding box must have non-zero longitude width")
