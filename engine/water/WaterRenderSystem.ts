import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import { WaterGameEffects } from "@/engine/water/WaterGameEffects";
import type { VisualFlowField } from "@/engine/water/VisualFlowField";

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

export const WATER_SHORE_ISO_LEVEL = 0.22;
// Keep depth-derived colours on the same visual timeline as the interpolated
// surface. These offsets mirror the render lift applied by WaterSimulation.
const WATER_SURFACE_OFFSET = 0.025;
const ROCK_SURFACE_EXTRA_OFFSET = 0.04;
// WaterSimulation intentionally lowers dry shoreline support vertices by
// 0.008 so coverage softening can keep a sloping stream wider than one grid
// line. Let that thin support layer survive the terrain-intersection mask,
// while fragments buried any deeper remain clipped.
const SHORE_SUPPORT_UNDERLAP_ALLOWANCE = 0.01;
const TERRAIN_INTERSECTION_FEATHER = 0.004;
const LAKE_BLEND_START = 0.52;
const LAKE_BLEND_END = 0.78;
const LAKE_WAVE_BLEND_START = 0.3;
const LAKE_WAVE_BLEND_END = 0.62;
// Calm lake geometry uses a separate real-time clock and fixed world-space
// waves. Simulation flow rate can therefore change water coverage rapidly
// without changing the wave phase or making the low-poly facets flicker.
const LAKE_WAVE_SHORE_DEPTH = 0.035;
const LAKE_WAVE_FULL_DEPTH = 0.18;
// Calibrated against the featured map's visible water-depth distribution so
// shallow channels, lake shelves, basin water, and the deepest cells do not
// collapse into the same two colours.
const DEPTH_COLOR_SHORE = 0.04;
const DEPTH_COLOR_SHALLOW = 0.45;
const DEPTH_COLOR_MIDDLE = 1.15;
const DEPTH_COLOR_BASIN = 2.7;
const DEPTH_COLOR_DEEP = 5;
const DEPTH_COLOR_ABYSS = 7.2;

/**
 * 只负责把模拟状态转换成独立水体网格。
 * 不持有、不修改水深、流向或流量，因此不会反向影响物理模拟。
 */
export class WaterRenderSystem {
  private readonly group = new THREE.Group();
  private readonly shoreColor = new THREE.Color("#49a6a3");
  private readonly shallowColor = new THREE.Color("#2f8994");
  private readonly middleColor = new THREE.Color("#216c80");
  private readonly basinColor = new THREE.Color("#15566f");
  private readonly deepColor = new THREE.Color("#0c415e");
  private readonly abyssColor = new THREE.Color("#072c49");
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
  private readonly surfaceMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.surfaceMaterial);
  private readonly waterfallMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.waterfallMaterial);
  private readonly surfaceStatePixelsA: Float32Array;
  private readonly surfaceStatePixelsB: Float32Array;
  private readonly surfaceStateTextureA: THREE.DataTexture;
  private readonly surfaceStateTextureB: THREE.DataTexture;
  private readonly visualTimeUniform = { value: 0 };
  private readonly effects: WaterGameEffects;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    private readonly visualCoverageTexture: THREE.DataTexture,
    visualFlowField: VisualFlowField,
  ) {
    const stateValueCount = this.terrain.resolutionX * this.terrain.resolutionZ * 4;
    this.surfaceStatePixelsA = new Float32Array(stateValueCount);
    this.surfaceStatePixelsB = new Float32Array(stateValueCount);
    this.surfaceStateTextureA = this.createSurfaceStateTexture(
      this.surfaceStatePixelsA,
      "water-surface-state-a",
    );
    this.surfaceStateTextureB = this.createSurfaceStateTexture(
      this.surfaceStatePixelsB,
      "water-surface-state-b",
    );
    this.surfaceMesh.geometry.dispose();
    this.surfaceMesh.geometry = this.createFixedSurfaceGeometry();
    this.configureMotionMaterial(this.surfaceMaterial, false);
    this.group.name = "independent-water-render";
    this.surfaceMesh.name = "water-surfaces";
    this.waterfallMesh.name = "waterfalls";
    this.surfaceMesh.renderOrder = 3;
    this.waterfallMesh.renderOrder = 4;
    this.surfaceMesh.castShadow = false;
    this.surfaceMesh.receiveShadow = false;
    this.waterfallMesh.castShadow = false;
    this.waterfallMesh.receiveShadow = false;
    this.group.add(this.surfaceMesh, this.waterfallMesh);
    this.scene.add(this.group);
    this.effects = new WaterGameEffects(this.scene, this.terrain, visualFlowField);
  }

  update(time: number): void {
    this.visualTimeUniform.value = time * 0.001;
    this.effects.update(time);
  }

  /** Refresh static terrain inputs without rebuilding water topology or effects. */
  syncTerrainFields(changedIndices?: readonly number[], recomputeBounds = true): void {
    const geometry = this.surfaceMesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const surfaceOffset = geometry.getAttribute("waterSurfaceOffset") as THREE.BufferAttribute | undefined;
    if (!position || !surfaceOffset) return;

    const positionValues = position.array as Float32Array;
    const surfaceOffsetValues = surfaceOffset.array as Float32Array;
    const indices = changedIndices ?? Array.from({ length: position.count }, (_, index) => index);
    let firstChanged = position.count;
    let lastChanged = -1;
    for (const index of indices) {
      if (index < 0 || index >= position.count) continue;
      positionValues[index * 3 + 1] = this.terrain.heights[index];
      surfaceOffsetValues[index] = WATER_SURFACE_OFFSET
        + (this.terrain.isRockIndex(index) ? ROCK_SURFACE_EXTRA_OFFSET : 0);
      firstChanged = Math.min(firstChanged, index);
      lastChanged = Math.max(lastChanged, index);
    }
    if (lastChanged < firstChanged) return;

    position.clearUpdateRanges();
    surfaceOffset.clearUpdateRanges();
    position.addUpdateRange(firstChanged * 3, (lastChanged - firstChanged + 1) * 3);
    surfaceOffset.addUpdateRange(firstChanged, lastChanged - firstChanged + 1);
    position.needsUpdate = true;
    surfaceOffset.needsUpdate = true;
    if (recomputeBounds) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
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
    this.updateDynamicTextures(
      surfaceHeights,
      depth,
      flowX,
      flowZ,
      flowSpeed,
      turbulence,
      lakeFactor,
    );
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
    const waterfall = this.createBuffers();
    // The surface keeps one indexed grid forever. Its outer vertices settle
    // onto the terrain, so there is no separate vertical shoreline wall.
    this.updateDynamicTextures(
      surfaceHeights,
      depth,
      flowX,
      flowZ,
      flowSpeed,
      turbulence,
      lakeFactor,
    );
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
    this.waterfallMesh.geometry.dispose();
    this.effects.dispose();
    this.surfaceMaterial.dispose();
    this.waterfallMaterial.dispose();
    this.surfaceStateTextureA.dispose();
    this.surfaceStateTextureB.dispose();
  }

  private configureMotionMaterial(material: THREE.MeshStandardMaterial, waterfall: boolean): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterCoverage = { value: this.visualCoverageTexture };
      shader.uniforms.uWaterStateA = { value: this.surfaceStateTextureA };
      shader.uniforms.uWaterStateB = { value: this.surfaceStateTextureB };
      shader.uniforms.uWaterVisualTime = this.visualTimeUniform;
      shader.uniforms.uWaterWorldSize = { value: new THREE.Vector2(WORLD_CONFIG.sizeX, WORLD_CONFIG.sizeZ) };
      shader.uniforms.uWaterShoreColor = { value: this.shoreColor };
      shader.uniforms.uWaterShallowColor = { value: this.shallowColor };
      shader.uniforms.uWaterMiddleColor = { value: this.middleColor };
      shader.uniforms.uWaterBasinColor = { value: this.basinColor };
      shader.uniforms.uWaterDeepColor = { value: this.deepColor };
      shader.uniforms.uWaterAbyssColor = { value: this.abyssColor };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform sampler2D uWaterCoverage;
          uniform sampler2D uWaterStateA;
          uniform sampler2D uWaterStateB;
          uniform float uWaterVisualTime;
          uniform vec2 uWaterWorldSize;
          uniform vec3 uWaterShoreColor;
          uniform vec3 uWaterShallowColor;
          uniform vec3 uWaterMiddleColor;
          uniform vec3 uWaterBasinColor;
          uniform vec3 uWaterDeepColor;
          uniform vec3 uWaterAbyssColor;
          attribute vec2 waterDataUv;
          attribute float waterSurfaceOffset;
          varying float vWaterLake;
          varying float vWaterDepth;
          varying float vWaterTerrainClearance;
          varying float vWaterLakeWave;
          varying vec3 vWaterWorldPosition;

          vec3 resolveWaterDepthColor(float depth) {
            if (depth < ${DEPTH_COLOR_SHALLOW.toFixed(2)}) {
              return mix(
                uWaterShoreColor,
                uWaterShallowColor,
                smoothstep(${DEPTH_COLOR_SHORE.toFixed(2)}, ${DEPTH_COLOR_SHALLOW.toFixed(2)}, depth)
              );
            }
            if (depth < ${DEPTH_COLOR_MIDDLE.toFixed(2)}) {
              return mix(
                uWaterShallowColor,
                uWaterMiddleColor,
                smoothstep(${DEPTH_COLOR_SHALLOW.toFixed(2)}, ${DEPTH_COLOR_MIDDLE.toFixed(2)}, depth)
              );
            }
            if (depth < ${DEPTH_COLOR_BASIN.toFixed(2)}) {
              return mix(
                uWaterMiddleColor,
                uWaterBasinColor,
                smoothstep(${DEPTH_COLOR_MIDDLE.toFixed(2)}, ${DEPTH_COLOR_BASIN.toFixed(2)}, depth)
              );
            }
            if (depth < ${DEPTH_COLOR_DEEP.toFixed(2)}) {
              return mix(
                uWaterBasinColor,
                uWaterDeepColor,
                smoothstep(${DEPTH_COLOR_BASIN.toFixed(2)}, ${DEPTH_COLOR_DEEP.toFixed(2)}, depth)
              );
            }
            return mix(
              uWaterDeepColor,
              uWaterAbyssColor,
              smoothstep(${DEPTH_COLOR_DEEP.toFixed(2)}, ${DEPTH_COLOR_ABYSS.toFixed(2)}, depth)
            );
          }`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vec4 waterStateA = texture2D(uWaterStateA, waterDataUv);
          vec4 waterStateB = texture2D(uWaterStateB, waterDataUv);
          float waterLake = waterStateB.b;
          float waterDepth = waterStateA.g;
          float waterTerrainClearance = waterStateB.a;
          transformed.y = waterStateA.r;
          vWaterLake = waterLake;
          vWaterDepth = waterDepth;
          // Keep almost the whole lake on one restrained amplitude. Only the
          // shallow rim fades toward zero, so no arbitrary deep/high patch can
          // dominate the lake. Both waves are continuous in world space and
          // advance on real visual time rather than simulation flow rate.
          float lakeWaveArea = smoothstep(
            ${LAKE_WAVE_BLEND_START.toFixed(2)},
            ${LAKE_WAVE_BLEND_END.toFixed(2)},
            waterLake
          );
          float lakeShoreFade = smoothstep(
            ${LAKE_WAVE_SHORE_DEPTH.toFixed(3)},
            ${LAKE_WAVE_FULL_DEPTH.toFixed(3)},
            waterDepth
          );
          vec2 lakeWaveWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
          float lakeWaveA = sin(
            dot(lakeWaveWorldXZ, normalize(vec2(0.88, 0.48))) * 0.4488
            + uWaterVisualTime * 0.44
          );
          float lakeWaveB = sin(
            dot(lakeWaveWorldXZ, normalize(vec2(-0.35, 0.94))) * 0.2856
            + uWaterVisualTime * 0.31
            + 1.7
          );
          float lakeWaveOffset = lakeWaveArea * lakeShoreFade
            * (lakeWaveA * 0.115 + lakeWaveB * 0.055);
          transformed.y += lakeWaveOffset;
          vWaterLakeWave = lakeWaveOffset;
          float waterVisualDepth = max(0.0, waterTerrainClearance - waterSurfaceOffset);
          vColor = vec4(resolveWaterDepthColor(waterVisualDepth), 1.0);
          vWaterTerrainClearance = waterTerrainClearance;
          // Flow velocity is expressed by the separate crest and foam effects.
          // Keep the shared low-poly surface on the interpolated physical
          // height so high discharge cannot shake facets or flash their colour.
          vWaterWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );

      const motionCode = waterfall
        ? ``
        : `
          vec2 waterCoverageUv = clamp(vWaterWorldPosition.xz / uWaterWorldSize + 0.5, 0.0, 1.0);
          float waterCoverageSample = texture2D(uWaterCoverage, waterCoverageUv).r;
          float waterEdgeCoverage = smoothstep(0.075, 0.31, waterCoverageSample);
          if (waterEdgeCoverage < 0.012) discard;
          // The coverage field marks the deliberate shoreline support layer.
          // Give only that layer enough clearance to survive its small visual
          // underlap; steep-bank support that lies deeper in terrain still
          // fails this mask and cannot reintroduce mountain penetration.
          float shoreSupportMask = smoothstep(0.04, 0.10, waterCoverageSample);
          float supportedTerrainClearance = vWaterTerrainClearance
            + shoreSupportMask * ${SHORE_SUPPORT_UNDERLAP_ALLOWANCE.toFixed(3)};
          float terrainIntersectionCoverage = smoothstep(
            -${TERRAIN_INTERSECTION_FEATHER.toFixed(3)},
            ${TERRAIN_INTERSECTION_FEATHER.toFixed(3)},
            supportedTerrainClearance
          );
          if (terrainIntersectionCoverage < 0.012) discard;
          diffuseColor.a *= terrainIntersectionCoverage;
          diffuseColor.a *= waterEdgeCoverage;
          float lakeWeight = smoothstep(${LAKE_WAVE_BLEND_START.toFixed(2)}, ${LAKE_WAVE_BLEND_END.toFixed(2)}, vWaterLake);
          vec3 waterDx = dFdx(vWaterWorldPosition);
          vec3 waterDy = dFdy(vWaterWorldPosition);
          vec3 waterDynamicNormal = normalize(cross(waterDx, waterDy));
          if (waterDynamicNormal.y < 0.0) waterDynamicNormal *= -1.0;
          float waterNormalStability = mix(0.72, 0.62, lakeWeight);
          waterDynamicNormal = normalize(mix(waterDynamicNormal, vec3(0.0, 1.0, 0.0), waterNormalStability));
          vec3 waterViewDirection = normalize(cameraPosition - vWaterWorldPosition);
          float waterFresnel = pow(1.0 - clamp(dot(waterDynamicNormal, waterViewDirection), 0.0, 1.0), 2.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.31, 0.56, 0.59), waterFresnel * 0.2);
          // Preserve the depth-derived hue, then layer inexpensive faceted
          // lighting over it. This uses the normal and wave height already in
          // the shader: no extra textures, render pass, or CPU work.
          vec3 lakeLightDirection = normalize(vec3(-0.45, 0.78, 0.38));
          float lakeFacetLight = smoothstep(
            0.76,
            0.88,
            dot(waterDynamicNormal, lakeLightDirection)
          );
          float lakeHeightLight = smoothstep(-0.09, 0.09, vWaterLakeWave);
          float lakeSurfaceLight = lakeFacetLight * 0.68 + lakeHeightLight * 0.32;
          float lakeLightMultiplier = mix(0.9, 1.14, lakeSurfaceLight);
          diffuseColor.rgb *= mix(1.0, lakeLightMultiplier, lakeWeight);
          float depthOpacity = smoothstep(0.025, 1.35, vWaterDepth);
          diffuseColor.a *= mix(0.58, 0.96, depthOpacity);`;

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform sampler2D uWaterCoverage;
          uniform vec2 uWaterWorldSize;
          varying float vWaterLake;
          varying float vWaterDepth;
          varying float vWaterTerrainClearance;
          varying float vWaterLakeWave;
          varying vec3 vWaterWorldPosition;`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
          ${waterfall ? "" : `float lakeLightingWeight = smoothstep(${LAKE_WAVE_BLEND_START.toFixed(2)}, ${LAKE_WAVE_BLEND_END.toFixed(2)}, vWaterLake);
          float waterLightingStability = mix(0.72, 0.62, lakeLightingWeight);
          vec3 stableWaterViewNormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          normal = normalize(mix(normal, stableWaterViewNormal, waterLightingStability));`}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          ${motionCode}`,
        );
    };
    material.customProgramCacheKey = () => waterfall ? "waterfall-motion-v9" : "surface-motion-v20-lake-facets-017";
  }

  private createSurfaceStateTexture(data: Float32Array, name: string): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      data,
      this.terrain.resolutionX,
      this.terrain.resolutionZ,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    texture.name = name;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createFixedSurfaceGeometry(): THREE.BufferGeometry {
    const vertexCount = this.terrain.resolutionX * this.terrain.resolutionZ;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Uint8Array(vertexCount * 3);
    const dataUvs = new Float32Array(vertexCount * 2);
    const surfaceOffsets = new Float32Array(vertexCount);
    const indices: number[] = [];
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;

    for (let z = 0; z < this.terrain.resolutionZ; z += 1) {
      for (let x = 0; x < this.terrain.resolutionX; x += 1) {
        const index = z * this.terrain.resolution + x;
        positions[index * 3] = x * this.terrain.cellSize - halfX;
        positions[index * 3 + 1] = this.terrain.heights[index];
        positions[index * 3 + 2] = z * this.terrain.cellSize - halfZ;
        colors[index * 3] = 255;
        colors[index * 3 + 1] = 255;
        colors[index * 3 + 2] = 255;
        dataUvs[index * 2] = (x + 0.5) / this.terrain.resolutionX;
        dataUvs[index * 2 + 1] = (z + 0.5) / this.terrain.resolutionZ;
        surfaceOffsets[index] = WATER_SURFACE_OFFSET
          + (this.terrain.isRockIndex(index) ? ROCK_SURFACE_EXTRA_OFFSET : 0);
      }
    }
    for (let z = 0; z < this.terrain.resolutionZ - 1; z += 1) {
      for (let x = 0; x < this.terrain.resolutionX - 1; x += 1) {
        const a = z * this.terrain.resolution + x;
        const b = a + 1;
        const c = a + this.terrain.resolution;
        const d = c + 1;
        if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
    geometry.setAttribute("waterDataUv", new THREE.BufferAttribute(dataUvs, 2));
    geometry.setAttribute("waterSurfaceOffset", new THREE.BufferAttribute(surfaceOffsets, 1));
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

  private updateDynamicTextures(
    surfaceHeights: Float32Array,
    depth: Float32Array,
    flowX: Float32Array,
    flowZ: Float32Array,
    flowSpeed: Float32Array,
    turbulence: Float32Array,
    lakeFactor: Float32Array,
  ): void {
    const cellCount = this.terrain.resolutionX * this.terrain.resolutionZ;
    for (let index = 0; index < cellCount; index += 1) {
      const offset = index * 4;
      this.surfaceStatePixelsA[offset] = surfaceHeights[index];
      this.surfaceStatePixelsA[offset + 1] = depth[index];
      this.surfaceStatePixelsA[offset + 2] = flowX[index];
      this.surfaceStatePixelsA[offset + 3] = flowZ[index];
      this.surfaceStatePixelsB[offset] = flowSpeed[index];
      this.surfaceStatePixelsB[offset + 1] = turbulence[index];
      this.surfaceStatePixelsB[offset + 2] = lakeFactor[index];
      // Preserve the old buffer path's exact color and shoreline input. This
      // subtraction must use the current terrain array after map loads/edits.
      this.surfaceStatePixelsB[offset + 3] = surfaceHeights[index] - this.terrain.heights[index];
    }
    this.surfaceStateTextureA.needsUpdate = true;
    this.surfaceStateTextureB.needsUpdate = true;
  }
}
