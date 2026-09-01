import * as THREE from 'three';

const SLOTS = 8;
const PX = 128;

/** Digits 0-7 baked into one strip. Seven glyphs is the whole alphabet the
 *  game needs, so every number in the rock costs exactly one draw call. */
function makeAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = PX * SLOTS;
  canvas.height = PX;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(PX * 0.74)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.fillStyle = '#ffffff';
  for (let d = 0; d < SLOTS; d++) ctx.fillText(String(d), d * PX + PX / 2, PX * 0.54);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}

/** Colourblind-safe ramp: hue and lightness both move with the number, so the
 *  reading survives any single-channel colour deficiency. */
export const DIGIT_COLORS = [
  '#ffffff', '#5cc8f5', '#5fd8a4', '#ffb454', '#c2a4ef', '#ff8f7a', '#ffe066', '#ffffff',
].map((c) => new THREE.Color(c));

/** Billboarded instanced quads. The vertex shader offsets in view space, so
 *  every digit faces the camera without a per-instance matrix update. */
export class DigitField {
  readonly mesh: THREE.Mesh;
  private readonly iPos: THREE.InstancedBufferAttribute;
  private readonly iDigit: THREE.InstancedBufferAttribute;
  private readonly iColor: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;

  constructor(capacity: number) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position!);
    geo.setAttribute('uv', base.attributes.uv!);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.iDigit = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.iPos, this.iDigit, this.iColor]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos);
    geo.setAttribute('iDigit', this.iDigit);
    geo.setAttribute('iColor', this.iColor);
    geo.instanceCount = 0;
    this.geometry = geo;

    const material = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: makeAtlas() }, uSize: { value: 0.8 } },
      vertexShader: `
        attribute vec3 iPos;
        attribute float iDigit;
        attribute vec3 iColor;
        uniform float uSize;
        varying vec2 vUv;
        varying float vDigit;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vDigit = iDigit;
          vColor = iColor;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          mv.xy += position.xy * uSize;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uAtlas;
        varying vec2 vUv;
        varying float vDigit;
        varying vec3 vColor;
        void main() {
          float a = texture2D(uAtlas, vec2((vUv.x + vDigit) / ${SLOTS}.0, vUv.y)).a;
          if (a < 0.18) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  set size(v: number) {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uSize!.value = v;
  }

  begin(): void { this.geometry.instanceCount = 0; }

  add(x: number, y: number, z: number, digit: number): void {
    const i = this.geometry.instanceCount;
    if (i * 3 + 2 >= this.iPos.array.length) return;
    (this.iPos.array as Float32Array).set([x, y, z], i * 3);
    (this.iDigit.array as Float32Array)[i] = digit;
    const c = DIGIT_COLORS[Math.min(digit, SLOTS - 1)]!;
    (this.iColor.array as Float32Array).set([c.r, c.g, c.b], i * 3);
    this.geometry.instanceCount = i + 1;
  }

  end(): void {
    this.iPos.needsUpdate = true;
    this.iDigit.needsUpdate = true;
    this.iColor.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    const m = this.mesh.material as THREE.ShaderMaterial;
    (m.uniforms.uAtlas!.value as THREE.Texture).dispose();
    m.dispose();
  }
}
