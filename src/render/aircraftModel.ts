import {
  BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, ConeGeometry, SphereGeometry,
} from 'three';
import type { AircraftConfig } from '../sim/aircraft';

/** A blocky but correctly proportioned airframe, built from the same numbers
 *  the physics uses — the wings sit where the lifting surfaces are and the gear
 *  where the contact points are, so the chase view shows the aeroplane the
 *  simulation is actually flying. */
export function buildAircraftModel(cfg: AircraftConfig): { group: Group; gear: Group; prop: Mesh | null } {
  const group = new Group();
  const jet = cfg.engine.kind === 'jet';
  // Painted aluminium: a little specular, so the airframe catches the sun and
  // reads as a solid object rather than a flat cut-out against the sky.
  const body = new MeshStandardMaterial({ color: new Color(jet ? '#eceef0' : '#e2e6e9'), roughness: 0.36, metalness: 0.28 });
  const accent = new MeshStandardMaterial({ color: new Color(jet ? '#1d3f6b' : '#b2402f'), roughness: 0.34, metalness: 0.22 });
  const dark = new MeshStandardMaterial({ color: new Color('#25282b'), roughness: 0.55, metalness: 0.35 });
  const glassMat = new MeshStandardMaterial({ color: new Color('#16323f'), roughness: 0.12, metalness: 0.55 });

  const span = Math.sqrt(cfg.surfaces[0]!.aspectRatio * cfg.surfaces[0]!.area * 2);
  const len = jet ? 14.4 : 8.3;

  const fuselage = new Mesh(new CylinderGeometry(jet ? 0.86 : 0.62, jet ? 0.52 : 0.42, len, 12), body);
  fuselage.rotation.x = Math.PI / 2;
  fuselage.position.z = len * 0.5 - (jet ? 5.6 : 3.0);
  group.add(fuselage);

  const nose = new Mesh(new ConeGeometry(jet ? 0.86 : 0.62, jet ? 2.2 : 1.5, 12), body);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -(jet ? 5.6 : 3.0) - (jet ? 1.1 : 0.75);
  group.add(nose);

  // Tail cone, so the fuselage tapers instead of ending in a flat disc.
  const tailCone = new Mesh(new ConeGeometry(jet ? 0.52 : 0.42, jet ? 2.6 : 1.7, 12), body);
  tailCone.rotation.x = Math.PI / 2;
  tailCone.position.z = len - (jet ? 5.6 : 3.0) + (jet ? 1.3 : 0.85);
  group.add(tailCone);

  // Cabin glazing: a windscreen and a row of side windows.
  const screen = new Mesh(new SphereGeometry(jet ? 0.80 : 0.58, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), glassMat);
  screen.rotation.x = Math.PI * 0.62;
  screen.position.set(0, jet ? 0.30 : 0.20, jet ? -4.3 : -2.1);
  group.add(screen);
  const rows = jet ? 6 : 2;
  for (let i = 0; i < rows; i++) {
    for (const side of [-1, 1]) {
      const win = new Mesh(new BoxGeometry(0.06, jet ? 0.34 : 0.42, jet ? 0.34 : 0.66), glassMat);
      win.position.set(side * (jet ? 0.84 : 0.60), jet ? 0.24 : 0.16, (jet ? -2.6 : -1.2) + i * (jet ? 0.95 : 1.05));
      group.add(win);
    }
  }

  // Livery stripe down the flank.
  const stripe = new Mesh(new BoxGeometry(jet ? 1.74 : 1.26, 0.14, len * 0.72), accent);
  stripe.position.set(0, jet ? -0.34 : -0.22, len * 0.5 - (jet ? 5.6 : 3.0));
  group.add(stripe);

  for (const s of cfg.surfaces) {
    if (s.name.startsWith('wing')) {
      // Each panel is half the span, centred at a quarter span from the
      // centreline, so the two meet at the fuselage and end exactly at the
      // tips. Deriving the position from the aerodynamic centre instead put
      // the tip marker several metres out past the wing, floating in the air.
      const side = Math.sign(s.pos[0]);
      const y = s.pos[1] + (jet ? -0.35 : 0.55);
      const w = new Mesh(new BoxGeometry(span / 2, 0.20, jet ? 2.0 : 1.55), body);
      w.position.set(side * span * 0.25, y, s.pos[2]);
      w.rotation.z = side * 0.035;
      group.add(w);
      const tip = new Mesh(new BoxGeometry(0.18, 0.34, jet ? 1.5 : 1.2), accent);
      tip.position.set(side * span * 0.5, y + span * 0.5 * 0.035 + 0.06, s.pos[2]);
      group.add(tip);
    } else if (s.name === 'h-stab') {
      const h = new Mesh(new BoxGeometry(Math.sqrt(s.aspectRatio * s.area) * 1.05, 0.14, 1.05), body);
      h.position.set(0, s.pos[1], s.pos[2]);
      group.add(h);
    } else if (s.name === 'v-stab') {
      const v = new Mesh(new BoxGeometry(0.16, Math.sqrt(s.aspectRatio * s.area) * 1.1, 1.35), accent);
      v.position.set(0, s.pos[1] + Math.sqrt(s.aspectRatio * s.area) * 0.5, s.pos[2]);
      group.add(v);
    }
  }

  let prop: Mesh | null = null;
  if (jet) {
    for (const s of [-1, 1]) {
      const nacelle = new Mesh(new CylinderGeometry(0.66, 0.60, 2.6, 12), body);
      nacelle.rotation.x = Math.PI / 2;
      nacelle.position.set(s * 1.62, 0.35, 3.4);
      group.add(nacelle);
      const intake = new Mesh(new CylinderGeometry(0.60, 0.60, 0.35, 12), dark);
      intake.rotation.x = Math.PI / 2;
      intake.position.set(s * 1.62, 0.35, 2.2);
      group.add(intake);
    }
  } else {
    const spinner = new Mesh(new ConeGeometry(0.28, 0.6, 10), accent);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -4.55;
    group.add(spinner);
    // A spinning propeller reads as a translucent disc, not as blades.
    prop = new Mesh(new CylinderGeometry(1.72, 1.72, 0.04, 20), new MeshStandardMaterial({
      color: new Color('#20242a'), roughness: 0.6, transparent: true, opacity: 0.32,
    }));
    prop.rotation.x = Math.PI / 2;
    prop.position.z = -4.42;
    group.add(prop);
  }

  const gear = new Group();
  for (const leg of cfg.gear) {
    const strut = new Mesh(new BoxGeometry(0.10, Math.abs(leg.pos[1]) * 0.8, 0.10), dark);
    strut.position.set(leg.pos[0], leg.pos[1] * 0.55, leg.pos[2]);
    gear.add(strut);
    const wheel = new Mesh(new CylinderGeometry(0.32, 0.32, 0.20, 12), dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(leg.pos[0], leg.pos[1], leg.pos[2]);
    gear.add(wheel);
  }
  group.add(gear);

  return { group, gear, prop };
}
