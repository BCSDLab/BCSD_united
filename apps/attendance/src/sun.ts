/** Browser-side NOAA sunrise/sunset calculation for Byeongcheon-myeon. */
export const solarThemeScript: string = `
function isByeongcheonDay(now) {
  const latitude = 36.76;
  const longitude = 127.30;
  const radians = Math.PI / 180;
  const degrees = 180 / Math.PI;
  const dayMs = 86400000;

  // Get the Korean calendar date without depending on the viewer's timezone.
  const koreanDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const midnightUtc = Date.UTC(koreanDate.getUTCFullYear(), koreanDate.getUTCMonth(), koreanDate.getUTCDate());
  const julianDay = midnightUtc / dayMs + 2440587.5;

  function solarPosition(jd) {
    const t = (jd - 2451545) / 36525;
    const meanLongitude = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360;
    const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const center = Math.sin(meanAnomaly * radians) * (1.914602 - t * (0.004817 + 0.000014 * t))
      + Math.sin(2 * meanAnomaly * radians) * (0.019993 - 0.000101 * t)
      + Math.sin(3 * meanAnomaly * radians) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const apparentLongitude = meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega * radians);
    const obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
      + 0.00256 * Math.cos(omega * radians);
    const declination = Math.asin(Math.sin(obliquity * radians) * Math.sin(apparentLongitude * radians));
    const y = Math.tan(obliquity * radians / 2) ** 2;
    const equationOfTime = 4 * degrees * (y * Math.sin(2 * meanLongitude * radians)
      - 2 * eccentricity * Math.sin(meanAnomaly * radians)
      + 4 * eccentricity * y * Math.sin(meanAnomaly * radians) * Math.cos(2 * meanLongitude * radians)
      - 0.5 * y * y * Math.sin(4 * meanLongitude * radians)
      - 1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * radians));
    return { declination, equationOfTime };
  }

  // The 90.833-degree zenith accounts for atmospheric refraction and the solar disc.
  function solarEvent(isSunrise) {
    let minutes = 720 - 4 * longitude;
    for (let i = 0; i < 3; i++) {
      const position = solarPosition(julianDay + minutes / 1440);
      const cosineHourAngle = (Math.cos(90.833 * radians) - Math.sin(latitude * radians) * Math.sin(position.declination))
        / (Math.cos(latitude * radians) * Math.cos(position.declination));
      // These cases cannot occur at Byeongcheon, but avoid an invalid acos at the limits.
      if (cosineHourAngle > 1) return null;
      if (cosineHourAngle < -1) return null;
      const hourAngle = Math.acos(cosineHourAngle) * degrees;
      minutes = 720 - 4 * (longitude + (isSunrise ? hourAngle : -hourAngle)) - position.equationOfTime;
    }
    return midnightUtc + minutes * 60000;
  }

  const sunrise = solarEvent(true);
  const sunset = solarEvent(false);
  return sunrise !== null && sunset !== null && now.getTime() >= sunrise && now.getTime() < sunset;
}
`;
