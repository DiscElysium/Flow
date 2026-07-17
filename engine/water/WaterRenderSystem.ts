import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import { WaterGameEffects } from "@/engine/water/WaterGameEffects";

type Sample = {
  x: number;
  y: number;
  z: number;
  sourceA: number;
  sourceB: number;
  sourceMix: number;
  heightOffset: number;
  terrainY: number;
  coverage: number;
  depth: number;
  flowX: number;
  flowZ: number;
  flowSpeed: number;
  lake: number;
};

type GeometryBuffers = {
  positions: number[];
  colors: number[];
  depths: number[];
  flows: number[];
  speeds: number[];
  lakes: number[];
  sourcesA: number[];
  sourcesB: number[];
  sourceMixes: number[];
  heightOffsets: number[];
};

const SHORE_ISO_LEVEL = 0.22;
const SHORE_SKIRT_DEPTH = 0.075;
const SHORE_SKIRT_INSET = 0.045;
const SHORE_SKIRT_TOP_DROP = 0.018;
const TERRAIN_CLEARANCE_START = 0.006;
const TERRAIN_CLEARANCE_FULL = 0.045;

/**
 * 只负责把模拟状态转换成独立水体网格。
 * 不持有、不修改水深、流向或流量，因此不会反向影响物理模拟。
 */
export class WaterRenderSystem {
  private readonly group = new THREE.Group();
  private readonly shallowColor = new THREE.Color("#287786");
  private readonly middleColor = new THREE.Color("#14546b");
  private readonly deepColor = new THREE.Color("#093a54");
  private readonly waterfallTint = new THREE.Color("#328a98");
  private readonly depthColorScratch = new THREE.Color();
  private readonly surfaceMaterial = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.48,
    metalness: 0.02,
    flatShading: true,
    transparent: true,
    opacity: 1,
    emissive: "#061923",
    emissiveIntensity: 0.1,
    depthTest: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  private readonly waterfallMaterial = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.84,
    metalness: 0,
    flatShading: true,
    emissive: "#071c25",
    emissiveIntensity: 0.12,
    depthTest: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  private readonly shoreSkirtMaterial = new THREE.MeshBasicMaterial({
    // The volume wall sits at the shallow shoreline, so use the same shallow
    // surface colour without per-triangle depth colours or animated lighting.
    // Its geometry still follows the water height, but its colour can no
    // longer turn into a moving blue mosaic when the topology is rebuilt.
    color: "#287786",
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  private readonly surfaceMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.surfaceMaterial);
  private readonly shoreSkirtMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.shoreSkirtMaterial);
  private readonly waterfallMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.waterfallMaterial);
  private readonly timeUniform = { value: 0 };
  private readonly effects: WaterGameEffects;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    private readonly visualCoverageTexture: THREE.DataTexture,
  ) {
    this.surfaceMesh.geometry.dispose();
    this.surfaceMesh.geometry = this.createFixedSurfaceGeometry();
    this.configureMotionMaterial(this.surfaceMaterial, false);
    this.group.name = "independent-water-render";
    this.surfaceMesh.name = "water-surfaces";
    this.shoreSkirtMesh.name = "water-shore-volume";
    this.waterfallMesh.name = "waterfalls";
    this.surfaceMesh.renderOrder = 3;
    this.shoreSkirtMesh.renderOrder = 2;
    this.waterfallMesh.renderOrder = 4;
    this.surfaceMesh.castShadow = false;
    this.surfaceMesh.receiveShadow = false;
    this.shoreSkirtMesh.castShadow = false;
    this.shoreSkirtMesh.receiveShadow = false;
    this.waterfallMesh.castShadow = false;
    this.waterfallMesh.receiveShadow = false;
    this.group.add(this.shoreSkirtMesh, this.surfaceMesh, this.waterfallMesh);
    this.scene.add(this.group);
    this.effects = new WaterGameEffects(this.scene, this.terrain);
  }

  update(time: number): void {
    this.timeUniform.value = time * 0.001;
    this.effects.update(time);
  }

  updateDynamicFields(
    surfaceHeights: Float32Array,
    depth: Float32Array,
    flowX: Float32Array,
    flowZ: Float32Array,
    flowSpeed: Float32Array,
    turbulence: Float32Array,
    lakeFactor: Float32Array,
  ): void {
    this.updateDynamicMesh(this.surfaceMesh, surfaceHeights, depth, flowX, flowZ, flowSpeed, turbulence, lakeFactor);
    this.updateDynamicMesh(this.shoreSkirtMesh, surfaceHeights, depth, flowX, flowZ, flowSpeed, turbulence, lakeFactor);
  }

  rebuild(
    coveragePixels: Uint8Array,
    surfaceHeights: Float32Array,
    depth: Float32Array,
    flowX: Float32Array,
    flowZ: Float32Array,
    flowSpeed: Float32Array,
    turbulence: Float32Array,
    foam: Float32Array,
    lakeFactor: Float32Array,
    waterfallEnergy: Float32Array,
    waterfallTarget: Int32Array,
  ): void {
    const shoreSkirt = this.createBuffers();
    const waterfall = this.createBuffers();
    const resolution = this.terrain.resolution;
    const half = WORLD_CONFIG.size / 2;

    const sample = (x: number, z: number): Sample => {
      const index = z * resolution + x;
      const y = surfaceHeights[index];
      const terrainY = this.terrain.heights[index];
      // 平整后的岸边支撑点可能落进较高的山体。按真实间隙收缩覆盖，而不是把水再次拉上山坡。
      const clearanceMask = THREE.MathUtils.smoothstep(
        y - terrainY,
        TERRAIN_CLEARANCE_START,
        TERRAIN_CLEARANCE_FULL,
      );
      return {
        x: x * this.terrain.cellSize - half,
        y,
        z: z * this.terrain.cellSize - half,
        sourceA: index,
        sourceB: index,
        sourceMix: 0,
        heightOffset: 0,
        terrainY,
        coverage: coveragePixels[index] / 255 * clearanceMask,
        depth: depth[index],
        flowX: flowX[index],
        flowZ: flowZ[index],
        flowSpeed: flowSpeed[index],
        lake: lakeFactor[index],
      };
    };

    for (let z = 0; z < resolution - 1; z += 1) {
      for (let x = 0; x < resolution - 1; x += 1) {
        const p00 = sample(x, z);
        const p10 = sample(x + 1, z);
        const p11 = sample(x + 1, z + 1);
        const p01 = sample(x, z + 1);
        // Use exactly the same diagonal as the terrain mesh. If the water quad
        // uses the opposite diagonal, its interior can pass through a sloped
        // terrain face even when all four water vertices are above the ground.
        const terrainTriangles: Array<[Sample, Sample, Sample]> = (x + z) % 2 === 0
          ? [[p00, p01, p10], [p10, p01, p11]]
          : [[p00, p01, p11], [p00, p11, p10]];
        for (const triangle of terrainTriangles) {
          const contour = this.triangleContourSegment(...triangle);
          if (contour) {
            const wetSamples = triangle.filter((point) => point.coverage >= SHORE_ISO_LEVEL);
            const wetCenterX = wetSamples.reduce((sum, point) => sum + point.x, 0) / wetSamples.length;
            const wetCenterZ = wetSamples.reduce((sum, point) => sum + point.z, 0) / wetSamples.length;
            this.appendShoreSkirt(contour[0], contour[1], wetCenterX, wetCenterZ, shoreSkirt);
          }
        }
      }
    }

    // Match main's smoothness: the surface keeps one indexed grid forever and
    // only its dynamic attributes change. Rebuilding is now limited to the
    // hidden-under-edge skirt and effect placement.
    this.updateDynamicMesh(this.surfaceMesh, surfaceHeights, depth, flowX, flowZ, flowSpeed, turbulence, lakeFactor);
    this.replaceGeometry(this.shoreSkirtMesh, shoreSkirt);
    this.replaceGeometry(this.waterfallMesh, waterfall);
    // 贴着地形的旧瀑布三角面只用于切走陡坡水面，实际瀑布由独立外抛水幕绘制。
    this.waterfallMesh.visible = false;
    this.effects.rebuild({
      coverage: coveragePixels,
      surfaceHeights,
      depth,
      flowX,
      flowZ,
      flowSpeed,
      turbulence,
      foam,
      lakeFactor,
      waterfallEnergy,
      waterfallTarget,
    });
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.surfaceMesh.geometry.dispose();
    this.shoreSkirtMesh.geometry.dispose();
    this.waterfallMesh.geometry.dispose();
    this.effects.dispose();
    this.surfaceMaterial.dispose();
    this.shoreSkirtMaterial.dispose();
    this.waterfallMaterial.dispose();
  }

  private clipWaterTriangle(a: Sample, b: Sample, c: Sample): Sample[] {
    const input = [a, b, c];
    const output: Sample[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = current.coverage >= SHORE_ISO_LEVEL;
      const previousInside = previous.coverage >= SHORE_ISO_LEVEL;
      if (currentInside !== previousInside) output.push(this.interpolate(previous, current));
      if (currentInside) output.push(current);
    }
    return output;
  }

  private triangleContourSegment(a: Sample, b: Sample, c: Sample): [Sample, Sample] | null {
    const intersections: Sample[] = [];
    for (const [start, end] of [[a, b], [b, c], [c, a]] as Array<[Sample, Sample]>) {
      if ((start.coverage >= SHORE_ISO_LEVEL) !== (end.coverage >= SHORE_ISO_LEVEL)) {
        intersections.push(this.interpolate(start, end));
      }
    }
    return intersections.length === 2 ? [intersections[0], intersections[1]] : null;
  }

  private interpolate(a: Sample, b: Sample): Sample {
    const range = b.coverage - a.coverage;
    const amount = Math.abs(range) > 0.00001
      ? THREE.MathUtils.clamp((SHORE_ISO_LEVEL - a.coverage) / range, 0, 1)
      : 0.5;
    return {
      x: THREE.MathUtils.lerp(a.x, b.x, amount),
      y: THREE.MathUtils.lerp(a.y, b.y, amount),
      z: THREE.MathUtils.lerp(a.z, b.z, amount),
      sourceA: a.sourceA,
      sourceB: b.sourceA,
      sourceMix: amount,
      heightOffset: THREE.MathUtils.lerp(a.heightOffset, b.heightOffset, amount),
      terrainY: THREE.MathUtils.lerp(a.terrainY, b.terrainY, amount),
      coverage: SHORE_ISO_LEVEL,
      depth: THREE.MathUtils.lerp(a.depth, b.depth, amount),
      flowX: THREE.MathUtils.lerp(a.flowX, b.flowX, amount),
      flowZ: THREE.MathUtils.lerp(a.flowZ, b.flowZ, amount),
      flowSpeed: THREE.MathUtils.lerp(a.flowSpeed, b.flowSpeed, amount),
      lake: THREE.MathUtils.lerp(a.lake, b.lake, amount),
    };
  }

  private appendTriangle(
    a: Sample,
    b: Sample,
    c: Sample,
    surface: GeometryBuffers,
  ): void {
    this.appendSample(a, false, surface);
    this.appendSample(b, false, surface);
    this.appendSample(c, false, surface);
  }

  private appendSample(sample: Sample, waterfall: boolean, target: GeometryBuffers): void {
    target.positions.push(sample.x, sample.y, sample.z);
    target.depths.push(sample.depth);
    target.flows.push(sample.flowX, sample.flowZ);
    target.speeds.push(sample.flowSpeed);
    target.lakes.push(sample.lake);
    target.sourcesA.push(sample.sourceA);
    target.sourcesB.push(sample.sourceB);
    target.sourceMixes.push(sample.sourceMix);
    target.heightOffsets.push(sample.heightOffset);
    this.appendDepthColor(sample.depth, waterfall, target.colors);
  }

  private appendShoreSkirt(
    a: Sample,
    b: Sample,
    wetCenterX: number,
    wetCenterZ: number,
    target: GeometryBuffers,
  ): void {
    const midpointX = (a.x + b.x) * 0.5;
    const midpointZ = (a.z + b.z) * 0.5;
    const inwardX = wetCenterX - midpointX;
    const inwardZ = wetCenterZ - midpointZ;
    const inwardLength = Math.hypot(inwardX, inwardZ);
    const insetX = inwardLength > 0.0001 ? inwardX / inwardLength * SHORE_SKIRT_INSET : 0;
    const insetZ = inwardLength > 0.0001 ? inwardZ / inwardLength * SHORE_SKIRT_INSET : 0;
    const topA: Sample = {
      ...a,
      x: a.x + insetX,
      y: a.y - SHORE_SKIRT_TOP_DROP,
      z: a.z + insetZ,
      heightOffset: a.heightOffset - SHORE_SKIRT_TOP_DROP,
    };
    const topB: Sample = {
      ...b,
      x: b.x + insetX,
      y: b.y - SHORE_SKIRT_TOP_DROP,
      z: b.z + insetZ,
      heightOffset: b.heightOffset - SHORE_SKIRT_TOP_DROP,
    };
    const bottomA: Sample = {
      ...topA,
      y: topA.y - SHORE_SKIRT_DEPTH,
      heightOffset: topA.heightOffset - SHORE_SKIRT_DEPTH,
    };
    const bottomB: Sample = {
      ...topB,
      y: topB.y - SHORE_SKIRT_DEPTH,
      heightOffset: topB.heightOffset - SHORE_SKIRT_DEPTH,
    };
    this.appendSample(topA, false, target);
    this.appendSample(bottomA, false, target);
    this.appendSample(topB, false, target);
    this.appendSample(topB, false, target);
    this.appendSample(bottomA, false, target);
    this.appendSample(bottomB, false, target);
  }

  private appendDepthColor(depth: number, waterfall: boolean, colors: number[]): void {
    this.resolveDepthColor(depth, waterfall, this.depthColorScratch);
    colors.push(this.depthColorScratch.r, this.depthColorScratch.g, this.depthColorScratch.b);
  }

  private resolveDepthColor(depth: number, waterfall: boolean, target: THREE.Color): void {
    const shallowToMiddle = THREE.MathUtils.smoothstep(depth, 0.035, 0.34);
    const middleToDeep = THREE.MathUtils.smoothstep(depth, 0.38, 1.85);
    let red = THREE.MathUtils.lerp(this.shallowColor.r, this.middleColor.r, shallowToMiddle);
    let green = THREE.MathUtils.lerp(this.shallowColor.g, this.middleColor.g, shallowToMiddle);
    let blue = THREE.MathUtils.lerp(this.shallowColor.b, this.middleColor.b, shallowToMiddle);
    red = THREE.MathUtils.lerp(red, this.deepColor.r, middleToDeep);
    green = THREE.MathUtils.lerp(green, this.deepColor.g, middleToDeep);
    blue = THREE.MathUtils.lerp(blue, this.deepColor.b, middleToDeep);
    if (waterfall) {
      red = THREE.MathUtils.lerp(red, this.waterfallTint.r, 0.24);
      green = THREE.MathUtils.lerp(green, this.waterfallTint.g, 0.24);
      blue = THREE.MathUtils.lerp(blue, this.waterfallTint.b, 0.24);
    }
    target.setRGB(red, green, blue);
  }

  private configureMotionMaterial(material: THREE.MeshStandardMaterial, waterfall: boolean): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterTime = this.timeUniform;
      shader.uniforms.uWaterCoverage = { value: this.visualCoverageTexture };
      shader.uniforms.uWaterWorldSize = { value: WORLD_CONFIG.size };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uWaterTime;
          uniform sampler2D uWaterCoverage;
          uniform float uWaterWorldSize;
          attribute vec2 waterFlow;
          attribute float waterSpeed;
          attribute float waterTurbulence;
          attribute float waterLake;
          attribute float waterDepth;
          varying vec2 vWaterFlow;
          varying float vWaterSpeed;
          varying float vWaterLake;
          varying float vWaterDepth;
          varying float vLakeWaveHeight;
          varying vec3 vWaterWorldPosition;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vWaterFlow = waterFlow;
          vWaterSpeed = waterSpeed;
          vWaterLake = waterLake;
          vWaterDepth = waterDepth;
          // Fade displacement before the shoreline so the surface and the
          // inset sealing lip share a stable top edge from oblique views.
          float lakeMask = smoothstep(0.24, 0.72, waterLake) * smoothstep(0.025, 0.12, waterDepth);
          float domainA = sin(dot(transformed.xz, normalize(vec2(-0.38, 0.92))) * 0.48 + uWaterTime * 0.17);
          float domainB = sin(dot(transformed.xz, normalize(vec2(0.86, 0.51))) * 0.73 - uWaterTime * 0.11 + 2.3);
          vec2 warped = transformed.xz + vec2(domainA * 0.42 + domainB * 0.18, domainB * 0.36 - domainA * 0.15);
          float waveA = sin(dot(warped, normalize(vec2(0.92, 0.38))) * 1.22 - uWaterTime * 0.96);
          float waveB = sin(dot(warped, normalize(vec2(-0.27, 0.96))) * 1.78 - uWaterTime * 0.57 + 1.7);
          float waveC = sin(dot(warped, normalize(vec2(0.72, -0.69))) * 2.46 - uWaterTime * 0.83 + 3.1);
          float waveD = sin(dot(warped, normalize(vec2(-0.94, -0.34))) * 3.18 - uWaterTime * 0.39 + 0.6);
          // Broad wave groups now have a lifecycle instead of permanently
          // deforming the same low-poly facets. Each envelope travels slowly
          // across the lake, rises to full strength, then fades back to flat.
          float packetClockA = 0.5 + 0.5 * sin(
            dot(warped, normalize(vec2(-0.52, 0.85))) * 0.095
            - uWaterTime * 0.22
            + domainA * 0.24
          );
          float packetClockB = 0.5 + 0.5 * sin(
            dot(warped, normalize(vec2(0.81, 0.59))) * 0.083
            + uWaterTime * 0.17
            + domainB * 0.21
            + 2.1
          );
          float packetLifeA = smoothstep(0.14, 0.82, packetClockA);
          float packetLifeB = smoothstep(0.2, 0.88, packetClockB);
          float calmRipple = waveC * 0.006 + waveD * 0.003;
          float transientWaves = waveA * 0.056 * packetLifeA + waveB * 0.032 * packetLifeB;
          vLakeWaveHeight = (calmRipple + transientWaves) * lakeMask;
          transformed.y += vLakeWaveHeight;
          // Strong drop/convergence energy makes a few broad low-poly facets
          // lift locally. The coverage sample fades this before the shoreline,
          // so turbulence cannot bring back the old flashing water edge.
          vec3 preJumpWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec2 jumpCoverageUv = clamp(preJumpWorld.xz / uWaterWorldSize + 0.5, 0.0, 1.0);
          float jumpInterior = smoothstep(0.26, 0.62, texture2D(uWaterCoverage, jumpCoverageUv).r);
          float jumpStrength = smoothstep(0.1, 0.78, waterTurbulence)
            * jumpInterior
            * (1.0 - smoothstep(0.68, 0.96, waterLake));
          vec2 jumpFlow = length(waterFlow) > 0.04 ? normalize(waterFlow) : vec2(0.7071, 0.7071);
          vec2 jumpSide = vec2(-jumpFlow.y, jumpFlow.x);
          float jumpA = sin(dot(transformed.xz, jumpFlow) * 4.2 - uWaterTime * (1.25 + waterSpeed * 1.35));
          float jumpB = sin(dot(transformed.xz, jumpSide) * 5.6 + uWaterTime * 1.7 + jumpA * 0.72);
          float jumpPulse = pow(max(0.0, jumpA * 0.64 + jumpB * 0.36), 2.0);
          transformed.y += jumpPulse * jumpStrength * (0.006 + waterTurbulence * 0.018);
          vWaterWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );

      const motionCode = waterfall
        ? ``
        : `
          vec2 waterCoverageUv = clamp(vWaterWorldPosition.xz / uWaterWorldSize + 0.5, 0.0, 1.0);
          float waterEdgeCoverage = smoothstep(0.075, 0.31, texture2D(uWaterCoverage, waterCoverageUv).r);
          if (waterEdgeCoverage < 0.012) discard;
          diffuseColor.a *= waterEdgeCoverage;
          float lakeWeight = clamp(vWaterLake, 0.0, 1.0);
          float variation = 0.5 + 0.5 * sin(vWaterWorldPosition.x * 0.37 + vWaterWorldPosition.z * 0.21 + sin(vWaterWorldPosition.z * 0.29) * 1.4);
          float lakeLight = smoothstep(0.018, 0.075, vLakeWaveHeight) * mix(0.04, 0.13, variation) * lakeWeight;
          diffuseColor.rgb = mix(diffuseColor.rgb, min(vec3(1.0), diffuseColor.rgb + vec3(0.06, 0.11, 0.12)), lakeLight);
          vec3 waterDx = dFdx(vWaterWorldPosition);
          vec3 waterDy = dFdy(vWaterWorldPosition);
          vec3 waterDynamicNormal = normalize(cross(waterDx, waterDy));
          if (waterDynamicNormal.y < 0.0) waterDynamicNormal *= -1.0;
          vec3 waterViewDirection = normalize(cameraPosition - vWaterWorldPosition);
          float waterFresnel = pow(1.0 - clamp(dot(waterDynamicNormal, waterViewDirection), 0.0, 1.0), 2.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.31, 0.56, 0.59), waterFresnel * 0.2);
          float depthOpacity = smoothstep(0.025, 1.35, vWaterDepth);
          diffuseColor.a *= mix(0.58, 0.96, depthOpacity);`;

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uWaterTime;
          uniform sampler2D uWaterCoverage;
          uniform float uWaterWorldSize;
          varying vec2 vWaterFlow;
          varying float vWaterSpeed;
          varying float vWaterLake;
          varying float vWaterDepth;
          varying float vLakeWaveHeight;
          varying vec3 vWaterWorldPosition;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          ${motionCode}`,
        );
    };
    material.customProgramCacheKey = () => waterfall ? "waterfall-motion-v4" : "surface-motion-v4";
  }

  private createFixedSurfaceGeometry(): THREE.BufferGeometry {
    const vertexCount = this.terrain.resolution * this.terrain.resolution;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const depths = new Float32Array(vertexCount);
    const flows = new Float32Array(vertexCount * 2);
    const speeds = new Float32Array(vertexCount);
    const turbulences = new Float32Array(vertexCount);
    const lakes = new Float32Array(vertexCount);
    const sourcesA = new Float32Array(vertexCount);
    const sourcesB = new Float32Array(vertexCount);
    const sourceMixes = new Float32Array(vertexCount);
    const heightOffsets = new Float32Array(vertexCount);
    const indices: number[] = [];
    const half = WORLD_CONFIG.size * 0.5;

    for (let z = 0; z < this.terrain.resolution; z += 1) {
      for (let x = 0; x < this.terrain.resolution; x += 1) {
        const index = z * this.terrain.resolution + x;
        positions[index * 3] = x * this.terrain.cellSize - half;
        positions[index * 3 + 1] = this.terrain.heights[index] + 0.025;
        positions[index * 3 + 2] = z * this.terrain.cellSize - half;
        colors[index * 3] = this.shallowColor.r;
        colors[index * 3 + 1] = this.shallowColor.g;
        colors[index * 3 + 2] = this.shallowColor.b;
        sourcesA[index] = index;
        sourcesB[index] = index;
      }
    }
    for (let z = 0; z < this.terrain.resolution - 1; z += 1) {
      for (let x = 0; x < this.terrain.resolution - 1; x += 1) {
        const a = z * this.terrain.resolution + x;
        const b = a + 1;
        const c = a + this.terrain.resolution;
        const d = c + 1;
        if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("waterDepth", new THREE.BufferAttribute(depths, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("waterFlow", new THREE.BufferAttribute(flows, 2).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("waterSpeed", new THREE.BufferAttribute(speeds, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("waterTurbulence", new THREE.BufferAttribute(turbulences, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("waterLake", new THREE.BufferAttribute(lakes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("waterSourceA", new THREE.BufferAttribute(sourcesA, 1));
    geometry.setAttribute("waterSourceB", new THREE.BufferAttribute(sourcesB, 1));
    geometry.setAttribute("waterSourceMix", new THREE.BufferAttribute(sourceMixes, 1));
    geometry.setAttribute("waterHeightOffset", new THREE.BufferAttribute(heightOffsets, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createBuffers(): GeometryBuffers {
    return {
      positions: [],
      colors: [],
      depths: [],
      flows: [],
      speeds: [],
      lakes: [],
      sourcesA: [],
      sourcesB: [],
      sourceMixes: [],
      heightOffsets: [],
    };
  }

  private replaceGeometry(mesh: THREE.Mesh, buffers: GeometryBuffers): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(buffers.colors, 3));
    geometry.setAttribute("waterDepth", new THREE.Float32BufferAttribute(buffers.depths, 1));
    geometry.setAttribute("waterFlow", new THREE.Float32BufferAttribute(buffers.flows, 2));
    geometry.setAttribute("waterSpeed", new THREE.Float32BufferAttribute(buffers.speeds, 1));
    geometry.setAttribute("waterLake", new THREE.Float32BufferAttribute(buffers.lakes, 1));
    geometry.setAttribute("waterSourceA", new THREE.Float32BufferAttribute(buffers.sourcesA, 1));
    geometry.setAttribute("waterSourceB", new THREE.Float32BufferAttribute(buffers.sourcesB, 1));
    geometry.setAttribute("waterSourceMix", new THREE.Float32BufferAttribute(buffers.sourceMixes, 1));
    geometry.setAttribute("waterHeightOffset", new THREE.Float32BufferAttribute(buffers.heightOffsets, 1));
    for (const attributeName of ["position", "waterDepth", "waterFlow", "waterSpeed", "waterLake"]) {
      const attribute = geometry.getAttribute(attributeName);
      if (attribute instanceof THREE.BufferAttribute) attribute.setUsage(THREE.DynamicDrawUsage);
    }
    if (buffers.positions.length > 0) {
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.visible = buffers.positions.length > 0;
  }

  private updateDynamicMesh(
    mesh: THREE.Mesh,
    surfaceHeights: Float32Array,
    depth: Float32Array,
    flowX: Float32Array,
    flowZ: Float32Array,
    flowSpeed: Float32Array,
    turbulence: Float32Array,
    lakeFactor: Float32Array,
  ): void {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const sourceA = geometry.getAttribute("waterSourceA") as THREE.BufferAttribute | undefined;
    const sourceB = geometry.getAttribute("waterSourceB") as THREE.BufferAttribute | undefined;
    const sourceMix = geometry.getAttribute("waterSourceMix") as THREE.BufferAttribute | undefined;
    const heightOffset = geometry.getAttribute("waterHeightOffset") as THREE.BufferAttribute | undefined;
    const depthAttribute = geometry.getAttribute("waterDepth") as THREE.BufferAttribute | undefined;
    const flowAttribute = geometry.getAttribute("waterFlow") as THREE.BufferAttribute | undefined;
    const speedAttribute = geometry.getAttribute("waterSpeed") as THREE.BufferAttribute | undefined;
    const turbulenceAttribute = geometry.getAttribute("waterTurbulence") as THREE.BufferAttribute | undefined;
    const lakeAttribute = geometry.getAttribute("waterLake") as THREE.BufferAttribute | undefined;
    const colorAttribute = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (!position || !sourceA || !sourceB || !sourceMix || !heightOffset
      || !depthAttribute || !flowAttribute || !speedAttribute || !lakeAttribute) return;

    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const a = Math.round(sourceA.getX(vertex));
      const b = Math.round(sourceB.getX(vertex));
      const mix = sourceMix.getX(vertex);
      const interpolate = (values: Float32Array): number => THREE.MathUtils.lerp(values[a], values[b], mix);
      const offset = heightOffset.getX(vertex);
      const dynamicDepth = interpolate(depth);
      position.setY(vertex, interpolate(surfaceHeights) + offset);
      depthAttribute.setX(vertex, dynamicDepth);
      flowAttribute.setXY(vertex, interpolate(flowX), interpolate(flowZ));
      speedAttribute.setX(vertex, interpolate(flowSpeed));
      if (turbulenceAttribute) turbulenceAttribute.setX(vertex, interpolate(turbulence));
      lakeAttribute.setX(vertex, interpolate(lakeFactor));
      if (colorAttribute) {
        this.resolveDepthColor(dynamicDepth, false, this.depthColorScratch);
        colorAttribute.setXYZ(vertex, this.depthColorScratch.r, this.depthColorScratch.g, this.depthColorScratch.b);
      }
    }
    position.needsUpdate = true;
    depthAttribute.needsUpdate = true;
    flowAttribute.needsUpdate = true;
    speedAttribute.needsUpdate = true;
    if (turbulenceAttribute) turbulenceAttribute.needsUpdate = true;
    lakeAttribute.needsUpdate = true;
    if (colorAttribute) colorAttribute.needsUpdate = true;
  }
}
