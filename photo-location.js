/* GPS metadata stays in the browser; only coordinates go to the horizon API. */
"use strict";
async function readPhotoLocation(file) {
  if (!file.size) throw new Error("This photo is empty. Choose the original photo file.");
  if (file.size > 100 * 1024 * 1024)
    throw new Error("Choose a photo smaller than 100 MB.");
  let gps;
  try {
    gps = await exifr.parse(file, {
      pick: ["GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef",
        "GPSImgDirection", "GPSImgDirectionRef", "GPSAltitude", "GPSAltitudeRef",
        "GPSHPositioningError", "GPSSpeed", "GPSSpeedRef"],
      translateValues: false,
    });
  } catch {
    throw new Error("Could not read this photo. Choose an original JPEG, HEIC, TIFF, or PNG file.");
  }
  if (!gps || gps.GPSLatitude == null || gps.GPSLongitude == null)
    throw new Error("No GPS coordinates in this photo. Choose an original with location data; sharing or exporting can remove it.");
  const { latitude, longitude } = gps;
  if (!["N", "S"].includes(gps.GPSLatitudeRef) ||
      !["E", "W"].includes(gps.GPSLongitudeRef) ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    throw new Error("This photo has incomplete or invalid GPS coordinates. Choose another original photo.");
  // Image direction is the camera's bearing. GPSTrack is travel direction,
  // and Orientation describes pixel rotation; neither can align the skyline.
  const direction = gps.GPSImgDirection;
  const photoBearing = Number.isFinite(direction) && direction >= 0 && direction <= 360
    ? direction % 360 : null;
  const directionRef = gps.GPSImgDirectionRef === "T" ? "true north"
    : gps.GPSImgDirectionRef === "M" ? "magnetic north" : "unspecified north reference";
  return { latitude, longitude, ...photoMeasurements(gps), altitudeAccuracy: null,
    photoBearing, directionRef };
}

function photoMeasurements(gps) {
  const valid = value => Number.isFinite(value) && value >= 0;
  // EXIF defines zero as the default when the reference tag is omitted.
  const rawRef = gps.GPSAltitudeRef;
  const altitudeRef = rawRef == null ? 0
    : (ArrayBuffer.isView(rawRef) || Array.isArray(rawRef)) && rawRef.length === 1 ? rawRef[0] : rawRef;
  const altitude = valid(gps.GPSAltitude) && [0, 1, 2, 3].includes(altitudeRef)
    ? gps.GPSAltitude * (altitudeRef === 1 || altitudeRef === 3 ? -1 : 1) : null;
  const speedFactor = { K: 1 / 3.6, M: 1609.344 / 3600, N: 1852 / 3600 }[gps.GPSSpeedRef];
  return {
    altitude,
    accuracy: valid(gps.GPSHPositioningError) ? gps.GPSHPositioningError : null,
    speed: valid(gps.GPSSpeed) && speedFactor ? gps.GPSSpeed * speedFactor : null,
  };
}
