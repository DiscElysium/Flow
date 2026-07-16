import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);

type CrestOptions = {
  curve: THREE.Curve<THREE.Vector3>;
  surfaceNormal: THREE.Vector3;
  count: number;
  flowSpeed: number;
  pathHalfWidth: number;
  color: THREE.ColorRepresentation;
  opacity: number;
  normalOffset: number;
  renderOrder: number;
  spanRange?: [number, number];
  widthRange?: [number, number];
};

type Crest = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  phase: number;
  speed: number;
  span: number;
  width: number;
  lateral: number;
  wiggle: number;
  seed: number;
};

/**
 * Reusable thin crest ribbons. The path can be horizontal (river) or vertical
 * (waterfall); only the surface normal changes.
 */
export class FlowCrestSystem {
  private readonly crests: Crest[] = [];
  private readonly sampleCount = 12;
  private readonly normal = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly point = new THREE.Vector3();

  constructor(private readonly parent: THREE.Object3D, private readonly options: CrestOptions) {
    this.normal.copy(options.surfaceNormal).normalize();
    const spanRange = options.spanRange ?? [0.055, 0.16];
    const widthRange = options.widthRange ?? [0.025, 0.07];

    for (let i = 0; i < options.count; i += 1) {
      const geometry = this.createRibbonGeometry();
      const material = new THREE.MeshBasicMaterial({
        color: options.color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = options.renderOrder;
      parent.add(mesh);

      const hash = this.hash(i + 1);
      this.crests.push({
        mesh,
        phase: (i + hash * 0.73) / options.count,
        speed: options.flowSpeed * (0.82 + this.hash(i + 19) * 0.38),
        span: THREE.MathUtils.lerp(spanRange[0], spanRange[1], this.hash(i + 31)),
        width: THREE.MathUtils.lerp(widthRange[0], widthRange[1], this.hash(i + 47)),
        lateral: THREE.MathUtils.lerp(-options.pathHalfWidth, options.pathHalfWidth, this.hash(i + 59)),
        wiggle: THREE.MathUtils.lerp(0.06, 0.22, this.hash(i + 71)),
        seed: hash * Math.PI * 2,
      });
    }
  }

  update(seconds: number): void {
    for (const crest of this.crests) {
      const travel = (seconds * crest.speed + crest.phase) % 1;
      const lifeEnvelope = Math.pow(Math.sin(travel * Math.PI), 0.62);
      const center = THREE.MathUtils.lerp(-crest.span * 0.35, 1 + crest.span * 0.35, travel);
      const start = center - crest.span * 0.5;
      const end = center + crest.span * 0.5;

      crest.mesh.visible = end > 0 && start < 1 && lifeEnvelope > 0.04;
      if (!crest.mesh.visible) continue;

      const positions = crest.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let sample = 0; sample <= this.sampleCount; sample += 1) {
        const q = sample / this.sampleCount;
        const t = THREE.MathUtils.clamp(THREE.MathUtils.lerp(start, end, q), 0, 1);
        this.options.curve.getPointAt(t, this.point);
        this.options.curve.getTangentAt(t, this.tangent).normalize();
        this.side.crossVectors(this.normal, this.tangent).normalize();

        const curl = Math.sin(q * Math.PI * 1.6 + crest.seed) * crest.wiggle;
        const lateral = crest.lateral + curl;
        const taper = Math.pow(Math.sin(q * Math.PI), 0.55) * lifeEnvelope;
        const halfWidth = crest.width * taper;
        const base = this.point
          .clone()
          .addScaledVector(this.side, lateral)
          .addScaledVector(this.normal, this.options.normalOffset);

        positions.setXYZ(sample * 2, base.x + this.side.x * halfWidth, base.y + this.side.y * halfWidth, base.z + this.side.z * halfWidth);
        positions.setXYZ(sample * 2 + 1, base.x - this.side.x * halfWidth, base.y - this.side.y * halfWidth, base.z - this.side.z * halfWidth);
      }
      positions.needsUpdate = true;
      crest.mesh.material.opacity = this.options.opacity * lifeEnvelope;
    }
  }

  private createRibbonGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array((this.sampleCount + 1) * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i < this.sampleCount; i += 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return geometry;
  }

  private hash(value: number): number {
    const x = Math.sin(value * 91.345 + 17.17) * 47453.5453;
    return x - Math.floor(x);
  }
}

export type WaveletPreset = {
  center: THREE.Vector3;
  direction: THREE.Vector2;
  phase: number;
  lifetime: number;
  startRadius: number;
  endRadius: number;
  travel: number;
  arc: number;
  rotation: number;
  width: number;
  opacity: number;
};

type Wavelet = WaveletPreset & {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
};

/** Localized arc waves with a shared grow-move-fade lifecycle. */
export class WaveletSystem {
  private readonly wavelets: Wavelet[] = [];
  private readonly sampleCount = 18;

  constructor(
    parent: THREE.Object3D,
    presets: WaveletPreset[],
    color: THREE.ColorRepresentation,
    private readonly renderOrder: number,
  ) {
    for (const preset of presets) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(this.createArcGeometry(), material);
      mesh.frustumCulled = false;
      mesh.renderOrder = renderOrder;
      parent.add(mesh);
      this.wavelets.push({ ...preset, mesh });
    }
  }

  update(seconds: number): void {
    for (const wave of this.wavelets) {
      const age = (seconds / wave.lifetime + wave.phase) % 1;
      const envelope = Math.pow(Math.sin(age * Math.PI), 0.7);
      const radius = THREE.MathUtils.lerp(wave.startRadius, wave.endRadius, age);
      const travelOffset = (age - 0.25) * wave.travel;
      const centerX = wave.center.x + wave.direction.x * travelOffset;
      const centerZ = wave.center.z + wave.direction.y * travelOffset;
      const positions = wave.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;

      for (let i = 0; i <= this.sampleCount; i += 1) {
        const q = i / this.sampleCount;
        const angle = wave.rotation + (q - 0.5) * wave.arc;
        const taper = Math.pow(Math.sin(q * Math.PI), 0.6) * envelope;
        const halfWidth = wave.width * taper;
        const inner = Math.max(0.02, radius - halfWidth);
        const outer = radius + halfWidth;
        positions.setXYZ(i * 2, centerX + Math.cos(angle) * inner, wave.center.y, centerZ + Math.sin(angle) * inner);
        positions.setXYZ(i * 2 + 1, centerX + Math.cos(angle) * outer, wave.center.y, centerZ + Math.sin(angle) * outer);
      }
      positions.needsUpdate = true;
      wave.mesh.material.opacity = wave.opacity * envelope;
      wave.mesh.renderOrder = this.renderOrder;
    }
  }

  private createArcGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array((this.sampleCount + 1) * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i < this.sampleCount; i += 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return geometry;
  }
}

type FoamBubble = {
  mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  phase: number;
  lifetime: number;
  angle: number;
  distance: number;
  size: number;
  rise: number;
  drift: number;
};

/** Small low-poly foam lobes that repeatedly boil up around an impact point. */
export class FoamBubbleSystem {
  private readonly bubbles: FoamBubble[] = [];

  constructor(
    parent: THREE.Object3D,
    private readonly center: THREE.Vector3,
    count: number,
    radius: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      const shade = i % 3 === 0 ? "#cce8e3" : i % 3 === 1 ? "#edf7f3" : "#dcefeb";
      const material = new THREE.MeshBasicMaterial({
        color: shade,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      parent.add(mesh);

      const radial = Math.sqrt(this.hash(i + 41)) * radius;
      this.bubbles.push({
        mesh,
        phase: this.hash(i + 3),
        lifetime: THREE.MathUtils.lerp(0.72, 1.55, this.hash(i + 17)),
        angle: this.hash(i + 29) * Math.PI * 2,
        distance: radial,
        size: THREE.MathUtils.lerp(0.055, 0.19, this.hash(i + 53)),
        rise: THREE.MathUtils.lerp(0.1, 0.48, this.hash(i + 67)),
        drift: THREE.MathUtils.lerp(-0.18, 0.18, this.hash(i + 79)),
      });
    }
  }

  update(seconds: number): void {
    for (const bubble of this.bubbles) {
      const age = (seconds / bubble.lifetime + bubble.phase) % 1;
      const envelope = Math.pow(Math.sin(age * Math.PI), 0.48);
      const spread = 0.62 + age * 0.46;
      const sideways = Math.sin(age * Math.PI * 2 + bubble.phase * 9) * bubble.drift;
      const cos = Math.cos(bubble.angle);
      const sin = Math.sin(bubble.angle);
      bubble.mesh.position.set(
        this.center.x + cos * bubble.distance * spread - sin * sideways,
        this.center.y + age * bubble.rise + Math.sin(age * Math.PI) * 0.06,
        this.center.z + sin * bubble.distance * spread + cos * sideways,
      );
      const scale = bubble.size * envelope;
      bubble.mesh.scale.set(scale * 1.18, scale * 0.82, scale * 1.18);
      bubble.mesh.rotation.set(age * 1.7, bubble.phase * 8 + age * 2.1, age * 0.8);
      bubble.mesh.material.opacity = 0.45 + envelope * 0.42;
    }
  }

  private hash(value: number): number {
    const x = Math.sin(value * 78.233 + 13.913) * 43758.5453;
    return x - Math.floor(x);
  }
}

export function createFoamPatch(
  center: THREE.Vector3,
  radiusX: number,
  radiusZ: number,
  color: THREE.ColorRepresentation,
  seed = 0,
): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const segments = 18;
  const positions: number[] = [center.x, center.y, center.z];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = i / segments * Math.PI * 2;
    const scallop = 0.78 + 0.13 * Math.sin(angle * 3 + seed) + 0.08 * Math.sin(angle * 7 - seed * 0.7);
    positions.push(
      center.x + Math.cos(angle) * radiusX * scallop,
      center.y,
      center.z + Math.sin(angle) * radiusZ * scallop,
    );
    indices.push(0, i + 1, (i + 1) % segments + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.54,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 8;
  return mesh;
}

export function makeHorizontalCurve(points: Array<[number, number, number]>): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal");
}

export function horizontalNormal(): THREE.Vector3 {
  return UP.clone();
}
