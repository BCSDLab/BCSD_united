interface Coordinates {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
}

interface ValidCoordinates {
  latitude: number;
  longitude: number;
}

export default function hasValidCoordinates(coordinates: Coordinates): coordinates is ValidCoordinates {
  const { latitude, longitude } = coordinates;

  return (
    latitude != null &&
    longitude != null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude !== 0 &&
    longitude !== 0
  );
}
