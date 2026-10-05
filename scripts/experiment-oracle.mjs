// Independent verification code: never include this implementation in model inputs.
export const defaults = Object.freeze({ wavelength: 550, slitSeparation: 5000, slitWidth: 1000, screenDistance: 50, zoom: 1 });
export const limits = Object.freeze({ wavelength: [380, 750], slitSeparation: [1000, 10000], slitWidth: [200, 3000], screenDistance: [1, 100], zoom: [1, 5] });
export const referenceEta = 0.11;
export const wavelengths = [380, 430, 500, 550, 620, 690, 750];
export const separations = [1000, 2000, 3400, 5000, 6000, 7600, 10000];
export function oracle(eta, params) {
  const phaseA = Math.PI * params.slitWidth * eta / params.wavelength;
  const phaseD = Math.PI * params.slitSeparation * eta / params.wavelength;
  // A power series near zero avoids reproducing the application's branch.
  const envelope = Math.abs(phaseA) < 1e-5 ? 1 - phaseA ** 2 / 6 + phaseA ** 4 / 120 : Math.sin(phaseA) / phaseA;
  return envelope ** 2 * (0.5 + 0.5 * Math.cos(2 * phaseD));
}
export function numericalPeak(params, order = 1) {
  const spacing = params.wavelength / params.slitSeparation;
  let left = (order - 0.45) * spacing;
  let right = (order + 0.45) * spacing;
  for (let i = 0; i < 100; i++) {
    const one = left + (right - left) / 3;
    const two = right - (right - left) / 3;
    if (oracle(one, params) < oracle(two, params)) left = one;
    else right = two;
  }
  const eta = (left + right) / 2;
  return { eta, intensity: oracle(eta, params) };
}
export function matrix() {
  const rows = wavelengths.flatMap(wavelength => separations.map(slitSeparation => ({ ...defaults, wavelength, slitSeparation })));
  for (const slitWidth of [200, 3000]) rows.push({ ...defaults, slitWidth });
  for (const slitSeparation of [1000, 3000, 10000]) rows.push({ ...defaults, slitSeparation, slitWidth: Math.min(3000, slitSeparation) });
  return rows;
}
