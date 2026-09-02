/** International Standard Atmosphere. Density drives every aerodynamic force
 *  and engine output in the sim, so climb performance, true-vs-indicated
 *  airspeed and service ceiling all fall out of this one function. */
export const RHO_SL = 1.225;
export const T_SL = 288.15;
export const P_SL = 101325;
const LAPSE = 0.0065;
const R = 287.05287;
export const G = 9.80665;

export interface AirState { temperature: number; pressure: number; density: number; soundSpeed: number }

export function atmosphere(altitude: number, out: AirState = { temperature: 0, pressure: 0, density: 0, soundSpeed: 0 }): AirState {
  const h = Math.max(-500, altitude);
  let T: number, p: number;
  if (h < 11000) {
    T = T_SL - LAPSE * h;
    p = P_SL * Math.pow(T / T_SL, G / (LAPSE * R));
  } else {
    T = T_SL - LAPSE * 11000;
    const p11 = P_SL * Math.pow(T / T_SL, G / (LAPSE * R));
    p = p11 * Math.exp((-G * (h - 11000)) / (R * T));
  }
  out.temperature = T;
  out.pressure = p;
  out.density = p / (R * T);
  out.soundSpeed = Math.sqrt(1.4 * R * T);
  return out;
}

/** Indicated airspeed: what the pitot tube reads, which is what the pilot
 *  flies. It falls below true airspeed with altitude, which is why the same
 *  approach speed on the dial is a much faster groundspeed at a mountain field. */
export function indicatedAirspeed(trueAirspeed: number, density: number): number {
  return trueAirspeed * Math.sqrt(density / RHO_SL);
}

/** Pressure altitude from a barometer set to `setting` (in inHg). */
export function altimeterReading(pressure: number, settingInHg: number): number {
  const setting = settingInHg * 3386.389;
  return (T_SL / LAPSE) * (1 - Math.pow(pressure / setting, (LAPSE * R) / G));
}

export const MS_TO_KT = 1.943844;
export const KT_TO_MS = 1 / MS_TO_KT;
export const M_TO_FT = 3.280839895;
export const FT_TO_M = 1 / M_TO_FT;
