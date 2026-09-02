import { BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshLambertMaterial, ConeGeometry } from 'three';
import type { AircraftConfig } from '../sim/aircraft';

/** A blocky but correctly proportioned airframe, built from the same numbers
 *  the physics uses — the wings sit where the lifting surfaces are and the gear
 *  where the contact points are, so the chase view shows the aeroplane the
 *  simulation is actually flying. */
export function buildAircraftModel(cfg: AircraftConfig): { group: Group; gear: Group; prop: Mesh | null } {
  const group = new Group();
  const jet = cfg.engine.kind === 'jet';
  const body = new MeshLambertMaterial({ color: new Color(jet ? '#e8eaec' : '#dfe3e6') });
  const accent = new MeshLambertMaterial({ color: new Color(jet ? '#1d3f6b' : '#b2402f') });
  const dark = new MeshLambertMaterial({ color: new Color('#26292c') });

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

  for (const s of cfg.surfaces) {
    if (s.name.startsWith('wing')) {
      const w = new Mesh(new BoxGeometry(span / 2, 0.20, jet ? 2.0 : 1.55), body);
      w.position.set(s.pos[0] * 1.05 + Math.sign(s.pos[0]) * span * 0.18, s.pos[1] + (jet ? -0.35 : 0.55), s.pos[2]);
      w.rotation.z = Math.sign(s.pos[0]) * 0.04;
      group.add(w);
      const tip = new Mesh(new BoxGeometry(0.16, 0.5, 1.0), accent);
      tip.position.set(Math.sign(s.pos[0]) * (span / 2 + s.pos[0] * 1.05 + Math.sign(s.pos[0]) * span * 0.18) * 0.999, s.pos[1] + (jet ? -0.2 : 0.7), s.pos[2]);
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
      const nacelle = new Mesh(new CylinderGeometry(0.62, 0.58, 2.4, 10), dark);
      nacelle.rotation.x = Math.PI / 2;
      nacelle.position.set(s * 1.5, 0.35, 3.4);
      group.add(nacelle);
    }
  } else {
    const spinner = new Mesh(new ConeGeometry(0.28, 0.6, 10), accent);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -4.55;
    group.add(spinner);
    prop = new Mesh(new BoxGeometry(3.4, 0.16, 0.05), dark);
    prop.position.z = -4.4;
    group.add(prop);
  }

  const gear = new Group();
  for (const leg of cfg.gear) {
    const strut = new Mesh(new BoxGeometry(0.10, Math.abs(leg.pos[1]) * 0.8, 0.10), dark);
    strut.position.set(leg.pos[0], leg.pos[1] * 0.55, leg.pos[2]);
    gear.add(strut);
    const wheel = new Mesh(new CylinderGeometry(0.32, 0.32, 0.20, 10), dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(leg.pos[0], leg.pos[1], leg.pos[2]);
    gear.add(wheel);
  }
  group.add(gear);

  return { group, gear, prop };
}
