"""Geographic predicates shared by rectangular catalog and circular searches."""

import math

from sqlalchemy import and_, or_

from app.models import Photo
from app.services.metadata_health import gps_present

# IUGG mean Earth radius (meters). Distances are spherical, not ellipsoidal.
EARTH_RADIUS_M = 6_371_008.8
DISTANCE_TOLERANCE_M = 0.000001


def valid_coordinates(latitude, longitude) -> bool:
    return all(
        isinstance(value, (int, float))
        and math.isfinite(value)
        and low <= value <= high
        for value, low, high in ((latitude, -90, 90), (longitude, -180, 180))
    )


def bounding_box_condition(south, north, west, east):
    return and_(
        gps_present(),
        Photo.latitude.between(south, north),
        Photo.longitude.between(west, east)
        if west < east
        else or_(Photo.longitude >= west, Photo.longitude <= east),
    )


def radius_bounds(latitude: float, longitude: float, radius_m: float):
    """Conservative spherical-cap bounds, including tolerance and both poles."""
    angular = (radius_m + DISTANCE_TOLERANCE_M) / EARTH_RADIUS_M
    lat = math.radians(latitude)
    south, north = max(-math.pi / 2, lat - angular), min(math.pi / 2, lat + angular)
    if south <= -math.pi / 2 or north >= math.pi / 2:
        west, east = -180.0, 180.0
    else:
        delta = math.degrees(math.asin(min(1.0, math.sin(angular) / math.cos(lat))))
        west = (longitude - delta + 180) % 360 - 180
        east = (longitude + delta + 180) % 360 - 180
    return math.degrees(south), math.degrees(north), west, east


def great_circle_distance_m(lat1: float, lon1: float, lat2: float, lon2: float):
    """Haversine with wrapped longitude difference and round-off clamping."""
    # At an exact pole all longitudes describe the same point. Avoid allowing
    # cos(pi/2) roundoff to invent tiny distances or reorder those ties.
    cos1 = 0.0 if abs(lat1) == 90 else math.cos(math.radians(lat1))
    cos2 = 0.0 if abs(lat2) == 90 else math.cos(math.radians(lat2))
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    delta_lon = math.radians((lon2 - lon1 + 180) % 360 - 180)
    haversine = (
        math.sin((lat2 - lat1) / 2) ** 2 + cos1 * cos2 * math.sin(delta_lon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(max(0.0, min(1.0, haversine))))
