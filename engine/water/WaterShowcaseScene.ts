import * as THREE from "three";
import {
  FlowCrestSystem,
  FoamBubbleSystem,
  horizontalNormal,
  makeHorizontalCurve,
  WaveletSystem,
  type WaveletPreset,
} from "@/engine/water/WaterShowcaseEffects";

export class WaterShowcaseScene {
  readonly scene = new THREE.Scene();

  private readonly animatedMaterials: THREE.ShaderMaterial[] = [];
  private readonly crestSystems: FlowCrestSystem[] = [];
  private readonly waveletSystems: WaveletSystem[] = [];
  private readonly foamBubbleSystems: FoamBubbleSystem[] = [];

  constructor() {
    this.scene.background = new THREE.Color("#b9c9c4");
    this.scene.fog = new THREE.FogExp2("#c8d4cf", 0.009);
    this.createLighting();
    this.createGround();
    this.createRiverZone();
    this.createLakeZone();
    this.createWaterfallZone();
  }

  update(time: number): void {
    const seconds = time * 0.001;
    for (const material of this.animatedMaterials) material.uniforms.uTime.value = seconds;
    for (const system of this.crestSystems) system.update(seconds);
    for (const system of this.waveletSystems) system.update(seconds);
    for (const system of this.foamBubbleSystems) system.update(seconds);
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach((material) => materials.add(material));
      else materials.add(object.material);
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.scene.clear();
  }

  private createLighting(): void {
    this.scene.add(new THREE.HemisphereLight("#edf5f1", "#59655d", 2.25));
    const sun = new THREE.DirectionalLight("#fff1d5", 3.2);
    sun.position.set(-18, 28, 22);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight("#a9d6dc", 1.1);
    rim.position.set(22, 12, -18);
    this.scene.add(rim);
  }

  private createGround(): void {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(58, 32),
      new THREE.MeshStandardMaterial({ color: "#819384", roughness: 1, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.72;
    this.scene.add(ground);
  }

  private createRiverZone(): void {
    const centerX = -14;
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(10.5, 0.8, 24),
      new THREE.MeshStandardMaterial({ color: "#708772", roughness: 1, flatShading: true }),
    );
    platform.position.set(centerX, -0.28, 0);
    this.scene.add(platform);

    const curve = makeHorizontalCurve([
      [centerX - 0.9, 0.22, -11],
      [centerX + 1.15, 0.24, -6.8],
      [centerX - 1.2, 0.2, -2.1],
      [centerX + 1.0, 0.18, 2.7],
      [centerX - 0.75, 0.16, 7.2],
      [centerX + 0.35, 0.14, 11],
    ]);
    const river = new THREE.Mesh(this.createRiverRibbon(curve, 2.9, 96), this.createRiverMaterial());
    river.renderOrder = 3;
    this.scene.add(river);

    this.crestSystems.push(new FlowCrestSystem(this.scene, {
      curve,
      surfaceNormal: horizontalNormal(),
      count: 15,
      flowSpeed: 0.115,
      pathHalfWidth: 1.05,
      color: "#b8e6df",
      opacity: 0.72,
      normalOffset: 0.035,
      renderOrder: 6,
      spanRange: [0.045, 0.13],
      widthRange: [0.018, 0.052],
    }));

    const bankMaterial = new THREE.MeshStandardMaterial({ color: "#5f755f", roughness: 1, flatShading: true });
    const rockMaterial = new THREE.MeshStandardMaterial({ color: "#84908a", roughness: 1, flatShading: true });
    const bankPositions: Array<[number, number, number, number]> = [
      [-18.1, 0.35, -8.5, 1.2], [-10.2, 0.3, -5.1, 0.9], [-18.2, 0.28, -0.5, 1.0],
      [-9.9, 0.3, 3.3, 1.1], [-18.0, 0.25, 7.2, 0.85], [-10.1, 0.25, 9.1, 1.0],
    ];
    for (let i = 0; i < bankPositions.length; i += 1) {
      const [x, y, z, scale] = bankPositions[i];
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(scale, 0), i % 2 === 0 ? bankMaterial : rockMaterial);
      rock.position.set(x, y, z);
      rock.scale.y = 0.6;
      rock.rotation.set(0.2, i * 0.74, -0.08);
      this.scene.add(rock);
    }
  }

  private createLakeZone(): void {
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(7.25, 7.8, 0.85, 20),
      new THREE.MeshStandardMaterial({ color: "#758b76", roughness: 1, flatShading: true }),
    );
    platform.position.y = -0.25;
    this.scene.add(platform);

    const lake = new THREE.Mesh(this.createRadialWaterGeometry(6.25, 14, 48), this.createLakeMaterial());
    lake.position.y = 0.24;
    lake.renderOrder = 3;
    this.scene.add(lake);

    const lakeWavelets: WaveletPreset[] = [
      this.wavelet(-2.8, -2.0, 0.05, 4.8, 0.58, 1.75, 1.9, 1.38, -0.15, 0.078, 0.56),
      this.wavelet(0.2, -2.7, 0.22, 5.4, 0.5, 1.52, 1.55, 1.22, 0.12, 0.07, 0.5),
      this.wavelet(2.3, -1.0, 0.41, 4.4, 0.54, 1.68, 1.7, 1.48, -0.06, 0.076, 0.54),
      this.wavelet(-1.7, 0.5, 0.62, 5.8, 0.62, 1.92, 1.45, 1.3, 0.08, 0.082, 0.48),
      this.wavelet(1.4, 1.2, 0.78, 4.9, 0.46, 1.58, 1.75, 1.42, -0.18, 0.072, 0.52),
      this.wavelet(-0.2, 3.0, 0.91, 5.2, 0.56, 1.82, 1.35, 1.2, 0.16, 0.078, 0.46),
    ];
    this.waveletSystems.push(new WaveletSystem(this.scene, lakeWavelets, "#a9ddd7", 7));

    const stoneMaterial = new THREE.MeshStandardMaterial({ color: "#87928d", roughness: 1, flatShading: true });
    for (let i = 0; i < 9; i += 1) {
      const angle = i / 9 * Math.PI * 2 + 0.15;
      const radius = 6.75 + (i % 3) * 0.18;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.75 + (i % 2) * 0.22, 0), stoneMaterial);
      stone.position.set(Math.cos(angle) * radius, 0.24, Math.sin(angle) * radius);
      stone.scale.y = 0.58;
      stone.rotation.y = angle;
      this.scene.add(stone);
    }
  }

  private createWaterfallZone(): void {
    const centerX = 14;
    const rockMaterial = new THREE.MeshStandardMaterial({ color: "#7d8883", roughness: 1, flatShading: true });
    const cliff = new THREE.Mesh(new THREE.BoxGeometry(10, 6.6, 8.5, 2, 3, 2), rockMaterial);
    cliff.position.set(centerX, 2.65, -4.0);
    this.scene.add(cliff);

    const upperCurve = makeHorizontalCurve([
      [centerX, 6.03, -5.7], [centerX - 0.15, 6.03, -3.8], [centerX + 0.1, 6.03, -1.8], [centerX, 6.03, 0.58],
    ]);
    const upperWater = new THREE.Mesh(this.createRiverRibbon(upperCurve, 4.8, 32), this.createRiverMaterial());
    upperWater.renderOrder = 3;
    this.scene.add(upperWater);
    this.crestSystems.push(new FlowCrestSystem(this.scene, {
      curve: upperCurve,
      surfaceNormal: horizontalNormal(),
      count: 10,
      flowSpeed: 0.18,
      pathHalfWidth: 1.75,
      color: "#d6ece7",
      opacity: 0.7,
      normalOffset: 0.035,
      renderOrder: 6,
      spanRange: [0.055, 0.18],
      widthRange: [0.02, 0.052],
    }));

    const waterfall = new THREE.Mesh(this.createWaterfallSheetGeometry(4.8, 5.75, 12, 22), this.createWaterfallMaterial());
    waterfall.position.set(centerX, 3.1, 0);
    waterfall.renderOrder = 4;
    this.scene.add(waterfall);

    const fallCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(centerX, 5.86, 0.62),
      new THREE.Vector3(centerX + 0.08, 4.55, 1.02),
      new THREE.Vector3(centerX - 0.12, 3.15, 1.36),
      new THREE.Vector3(centerX + 0.06, 1.8, 1.58),
      new THREE.Vector3(centerX, 0.38, 1.7),
    ], false, "centripetal");
    this.crestSystems.push(new FlowCrestSystem(this.scene, {
      curve: fallCurve,
      surfaceNormal: new THREE.Vector3(0, 0, 1),
      count: 18,
      flowSpeed: 0.28,
      pathHalfWidth: 1.78,
      color: "#e2f2ed",
      opacity: 0.78,
      normalOffset: 0.07,
      renderOrder: 7,
      spanRange: [0.055, 0.2],
      widthRange: [0.018, 0.058],
    }));

    const lowerPlatform = new THREE.Mesh(
      new THREE.CylinderGeometry(7.4, 7.9, 0.9, 20),
      new THREE.MeshStandardMaterial({ color: "#6e8371", roughness: 1, flatShading: true }),
    );
    lowerPlatform.position.set(centerX, -0.25, 4.7);
    this.scene.add(lowerPlatform);

    const lowerPool = new THREE.Mesh(this.createRadialWaterGeometry(6.25, 12, 40), this.createLakeMaterial(0.72));
    lowerPool.position.set(centerX, 0.25, 4.7);
    lowerPool.renderOrder = 3;
    this.scene.add(lowerPool);

    const impactCenter = new THREE.Vector3(centerX, 0.39, 1.9);
    this.foamBubbleSystems.push(new FoamBubbleSystem(this.scene, impactCenter, 34, 1.65));

    const impactWaves: WaveletPreset[] = [
      this.impactWavelet(impactCenter, 0.0, 2.5, 0.28, 1.9, 1.1, -0.55, 0.065, 0.62),
      this.impactWavelet(impactCenter, 0.28, 3.0, 0.35, 2.45, 0.92, 0.15, 0.058, 0.54),
      this.impactWavelet(impactCenter, 0.55, 2.7, 0.24, 2.05, 1.0, 0.72, 0.07, 0.6),
      this.impactWavelet(impactCenter, 0.78, 3.2, 0.42, 2.7, 0.82, 1.95, 0.055, 0.48),
    ];
    this.waveletSystems.push(new WaveletSystem(this.scene, impactWaves, "#eef7f3", 9));

    const sideRocks: Array<[number, number, number, number]> = [
      [9.2, 1.0, 0.2, 1.5], [18.6, 1.2, 0.0, 1.8], [8.3, 0.4, 4.7, 1.1], [19.5, 0.5, 5.6, 1.3],
    ];
    for (let i = 0; i < sideRocks.length; i += 1) {
      const [x, y, z, scale] = sideRocks[i];
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(scale, 0), rockMaterial);
      rock.position.set(x, y, z);
      rock.scale.y = 0.75;
      rock.rotation.y = i * 0.8;
      this.scene.add(rock);
    }
  }

  private wavelet(
    x: number,
    z: number,
    phase: number,
    lifetime: number,
    startRadius: number,
    endRadius: number,
    travel: number,
    arc: number,
    rotationOffset: number,
    width: number,
    opacity: number,
  ): WaveletPreset {
    const flowAngle = Math.PI * 0.44;
    const travelAngle = flowAngle + Math.PI * 0.5;
    return {
      center: new THREE.Vector3(x, 0.39, z),
      direction: new THREE.Vector2(Math.cos(travelAngle), Math.sin(travelAngle)),
      phase,
      lifetime,
      startRadius,
      endRadius,
      travel,
      arc,
      rotation: flowAngle + Math.PI * 0.5 + rotationOffset,
      width,
      opacity,
    };
  }

  private impactWavelet(
    center: THREE.Vector3,
    phase: number,
    lifetime: number,
    startRadius: number,
    endRadius: number,
    arc: number,
    rotation: number,
    width: number,
    opacity: number,
  ): WaveletPreset {
    return {
      center: center.clone().setY(center.y + 0.025),
      direction: new THREE.Vector2(0, 1),
      phase,
      lifetime,
      startRadius,
      endRadius,
      travel: 0,
      arc,
      rotation,
      width,
      opacity,
    };
  }

  private createRiverRibbon(curve: THREE.Curve<THREE.Vector3>, width: number, segments: number): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3();

    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const point = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t).normalize();
      side.crossVectors(up, tangent).normalize();
      const localWidth = width * (0.9 + Math.sin(t * Math.PI) * 0.12);
      const left = point.clone().addScaledVector(side, localWidth * 0.5);
      const right = point.clone().addScaledVector(side, -localWidth * 0.5);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      uvs.push(0, t, 1, t);
      if (i < segments) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createRadialWaterGeometry(radius: number, rings: number, segments: number): THREE.BufferGeometry {
    const positions: number[] = [0, 0, 0];
    const uvs: number[] = [0.5, 0.5];
    const indices: number[] = [];

    for (let ring = 1; ring <= rings; ring += 1) {
      const r = radius * ring / rings;
      for (let segment = 0; segment < segments; segment += 1) {
        const angle = segment / segments * Math.PI * 2;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;
        positions.push(x, 0, z);
        uvs.push(x / (radius * 2) + 0.5, z / (radius * 2) + 0.5);
      }
    }

    for (let segment = 0; segment < segments; segment += 1) {
      indices.push(0, segment + 1, (segment + 1) % segments + 1);
    }
    for (let ring = 1; ring < rings; ring += 1) {
      const innerStart = 1 + (ring - 1) * segments;
      const outerStart = 1 + ring * segments;
      for (let segment = 0; segment < segments; segment += 1) {
        const next = (segment + 1) % segments;
        const a = innerStart + segment;
        const b = innerStart + next;
        const c = outerStart + segment;
        const d = outerStart + next;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createWaterfallSheetGeometry(width: number, height: number, columns: number, rows: number): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let row = 0; row <= rows; row += 1) {
      const v = row / rows;
      const down = 1 - v;
      const forwardThrow = 0.58 + Math.pow(down, 0.72) * 1.08 + Math.sin(down * Math.PI) * 0.12;
      const rowWidth = width * (0.9 + Math.sin(down * Math.PI) * 0.08 + down * 0.04);
      for (let column = 0; column <= columns; column += 1) {
        const u = column / columns;
        const x = (u - 0.5) * rowWidth;
        const y = (v - 0.5) * height;
        const scallop = Math.sin(u * Math.PI * 5 + down * 2.4) * 0.035 * Math.sin(u * Math.PI);
        positions.push(x, y, forwardThrow + scallop);
        uvs.push(u, v);
      }
    }

    const stride = columns + 1;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = row * stride + column;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createRiverMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      depthWrite: true,
      uniforms: {
        uShallow: { value: new THREE.Color("#318a9b") },
        uDeep: { value: new THREE.Color("#0b4968") },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        varying vec2 vUv;
        void main() {
          float channelDepth = smoothstep(0.0, 0.82, 1.0 - abs(vUv.x - 0.5) * 2.0);
          vec3 color = mix(uShallow, uDeep, channelDepth * 0.86);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }

  private createLakeMaterial(amplitudeScale = 1): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uAmplitudeScale: { value: amplitudeScale },
        uShallow: { value: new THREE.Color("#2e8998") },
        uDeep: { value: new THREE.Color("#083f5d") },
        uLight: { value: new THREE.Color("#78bcc0") },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uAmplitudeScale;
        varying vec2 vUv;
        varying float vHeight;
        varying float vEdge;
        varying float vVariation;

        void main() {
          vec3 p = position;
          float radius = length(position.xz);
          float edgeFade = 1.0 - smoothstep(4.85, 6.22, radius);
          float domainA = sin(dot(position.xz, normalize(vec2(-0.38, 0.92))) * 0.48 + uTime * 0.17);
          float domainB = sin(dot(position.xz, normalize(vec2(0.86, 0.51))) * 0.73 - uTime * 0.11 + 2.3);
          vec2 warped = position.xz + vec2(domainA * 0.42 + domainB * 0.18, domainB * 0.36 - domainA * 0.15);
          float waveA = sin(dot(warped, normalize(vec2(0.92, 0.38))) * 1.22 - uTime * 0.96);
          float waveB = sin(dot(warped, normalize(vec2(-0.27, 0.96))) * 1.78 - uTime * 0.57 + 1.7);
          float waveC = sin(dot(warped, normalize(vec2(0.72, -0.69))) * 2.46 - uTime * 0.83 + 3.1);
          float waveD = sin(dot(warped, normalize(vec2(-0.94, -0.34))) * 3.18 - uTime * 0.39 + 0.6);
          float height = (waveA * 0.092 + waveB * 0.058 + waveC * 0.034 + waveD * 0.018) * edgeFade * uAmplitudeScale;
          p.y += max(-0.055, height);
          vHeight = height;
          vEdge = smoothstep(0.3, 1.0, radius / 6.25);
          vVariation = 0.5 + 0.5 * sin(domainA * 2.7 + domainB * 1.9 + waveC * 0.8);
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        uniform vec3 uLight;
        varying float vHeight;
        varying float vEdge;
        varying float vVariation;
        void main() {
          vec3 depthColor = mix(uDeep, uShallow, vEdge * 0.82);
          float crestLight = smoothstep(0.038, 0.125, vHeight) * mix(0.055, 0.15, vVariation);
          gl_FragColor = vec4(mix(depthColor, uLight, crestLight), 1.0);
        }
      `,
    });
    material.name = "showcase-directional-lake";
    this.animatedMaterials.push(material);
    return material;
  }

  private createWaterfallMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color("#378fa0") },
        uDeep: { value: new THREE.Color("#10536f") },
      },
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec3 p = position;
          float edgeFade = sin(uv.x * 3.14159265);
          p.z += (sin(position.x * 1.65 + position.y * 0.48 - uTime * 1.5) * 0.07
            + sin(position.x * 3.1 - position.y * 0.24 - uTime * 0.85) * 0.028) * edgeFade;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        varying vec2 vUv;
        void main() {
          float center = smoothstep(0.0, 0.86, 1.0 - abs(vUv.x - 0.5) * 2.0);
          vec3 color = mix(uShallow, uDeep, center * 0.58 + (1.0 - vUv.y) * 0.12);
          gl_FragColor = vec4(color, 0.97);
        }
      `,
      transparent: true,
    });
    material.name = "showcase-waterfall-sheet";
    this.animatedMaterials.push(material);
    return material;
  }
}
