import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import { isOceanOutflowPosition } from "@/engine/water/OceanSystem";
import { WATER_SHORE_ISO_LEVEL, WaterRenderSystem } from "@/engine/water/WaterRenderSystem";

const MIN_VISIBLE_DEPTH = 0.003;
const VISUAL_EDGE_DEPTH = 0.0015;
// 视觉连续性使用比特效判定更低的水深门槛：极薄的真实水路仍要画出来。
const VISUAL_WET_ENTER_DEPTH = 0.00004;
const VISUAL_WET_EXIT_DEPTH = 0.000005;
const VISUAL_COVERAGE_FULL_DEPTH = VISUAL_WET_ENTER_DEPTH * 4.5;
const RESIDUAL_WATER_DEPTH = 0.00004;
const MIN_TRANSFER_DEPTH = 0.000001;
const MIN_SURFACE_DIFFERENCE = 0.0003;
const WATER_SLEEP_STABLE_SUBSTEPS = 9;
const WATER_SLEEP_AUDIT_STEPS = 8;
const COVERABLE_BUMP_HEIGHT = 1.25 * WORLD_CONFIG.verticalScale;
const GRAVITY_PRIORITY_START = 0.035;
const GRAVITY_PRIORITY_FULL = 0.48;
const FLOW_DROP_LOOKAHEAD_CELLS = 5;
const WATER_RENDER_OFFSET = 0.025;
const MIN_VISUAL_WATER_DEPTH = 0.012;
const SHORE_UNDERLAP_DEPTH = 0.008;
const FLOWING_SHORE_GROUND_CLEARANCE = 0.006;
const PHYSICS_FIXED_DELTA = 1 / 30;
const MAX_PHYSICS_STEPS_PER_FRAME = 4;
const REFERENCE_RENDER_DELTA = 1 / 60;
const REFERENCE_PHYSICS_SUBSTEP = REFERENCE_RENDER_DELTA / WORLD_CONFIG.water.substeps;
const AVAILABLE_TRANSFER_RATE = -Math.log1p(-0.18) / REFERENCE_PHYSICS_SUBSTEP;
const SURFACE_TRANSFER_RATE = -Math.log1p(-WORLD_CONFIG.water.flow) / REFERENCE_PHYSICS_SUBSTEP;
const VISUAL_COVERAGE_RISE_RATE = -Math.log1p(-0.2) / REFERENCE_RENDER_DELTA;
const VISUAL_COVERAGE_FALL_RATE = -Math.log1p(-0.08) / REFERENCE_RENDER_DELTA;
const LAKE_SHAPE_RADIUS_CELLS = 2;
const LAKE_SHORE_INFLUENCE_RADIUS_CELLS = 2;
const LAKE_SHORE_CALM_START = 0.52;
const LAKE_SHORE_CALM_FULL = 0.72;
const LAKE_AXIS_PAIRS = [
  [-2, 0, 2, 0, 4],
  [0, -2, 0, 2, 4],
  [-2, -2, 2, 2, 4 * Math.SQRT2],
  [-2, 2, 2, -2, 4 * Math.SQRT2],
] as const;
const RENDER_TOPOLOGY_INTERVAL = 1 / 7;
const WATER_SHORE_ISO_BYTE = Math.round(WATER_SHORE_ISO_LEVEL * 255);
// Rebuild only when coverage crosses a threshold that changes shoreline or
// effect eligibility. Intermediate alpha changes remain texture-only.
const WATER_COVERAGE_REBUILD_THRESHOLDS = [
  5,
  WATER_SHORE_ISO_BYTE,
  70,
  75,
  85,
  95,
  100,
  110,
  120,
  150,
  175,
  190,
] as const;

function coverageState(value: number): number {
  let state = 0;
  while (
    state < WATER_COVERAGE_REBUILD_THRESHOLDS.length
    && value >= WATER_COVERAGE_REBUILD_THRESHOLDS[state]
  ) state += 1;
  return state;
}

export type WaterPerformanceStats = {
  physicsMs: number;
  geometryMs: number;
  topologyMs: number;
};

export class WaterSimulation {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly resolutionX = WORLD_CONFIG.segmentsX + 1;
  private readonly resolutionZ = WORLD_CONFIG.segmentsZ + 1;
  private readonly resolution = this.resolutionX;
  private readonly depth = new Float32Array(this.resolutionX * this.resolutionZ);
  private readonly delta = new Float32Array(this.depth.length);
  private readonly previousTerrain = new Float32Array(this.depth.length);
  private readonly previousRockMask = new Uint8Array(this.depth.length);
  /**
   * 每个格子最近一段停留时间内流入的水量（深度，不是绝对高度）。
   * 按指数衰减，只有 recentInflow 之外的水才能流出。
   * 这样持续有流入的地方，旧水仍然可以流出，只有新到的那部分被锁定。
   */
  private readonly recentInflow = new Float32Array(this.depth.length);
  /** 归一化后的每格二维流向与流速，供水面动画和特效共用。 */
  private readonly flowX = new Float32Array(this.depth.length);
  private readonly flowZ = new Float32Array(this.depth.length);
  private readonly flowSpeed = new Float32Array(this.depth.length);
  private readonly dropEnergy = new Float32Array(this.depth.length);
  private readonly turbulence = new Float32Array(this.depth.length);
  private readonly foam = new Float32Array(this.depth.length);
  private readonly lakeShapeRaw = new Float32Array(this.depth.length);
  private readonly lakeFactor = new Float32Array(this.depth.length);
  /** 单帧交换累计量，用完后会写入上面的平滑状态场。 */
  private readonly flowAccumX = new Float32Array(this.depth.length);
  private readonly flowAccumZ = new Float32Array(this.depth.length);
  private readonly outflowAccum = new Float32Array(this.depth.length);
  private readonly incomingAccum = new Float32Array(this.depth.length);
  private readonly incomingX = new Float32Array(this.depth.length);
  private readonly incomingZ = new Float32Array(this.depth.length);
  private readonly dropAccum = new Float32Array(this.depth.length);
  /** 地形不变时水力高度不变；只在地形编辑影响到自身或一圈邻格时重算。 */
  private readonly flowTerrainHeight = new Float32Array(this.depth.length);
  private readonly flowTerrainDirtyMarks = new Uint32Array(this.depth.length);
  private flowTerrainDirtyMark = 0;
  /** 同一物理子步内 depth 尚未落盘，重力目标可精确复用。 */
  private readonly gravityTarget = new Int32Array(this.depth.length);
  private readonly gravityDrop = new Float32Array(this.depth.length);
  private readonly gravityStrength = new Float32Array(this.depth.length);
  /** 真正含水的格子；使用预分配列表，避免每个物理子步创建 Set。 */
  private readonly activeWaterIndices = new Int32Array(this.depth.length);
  private readonly activeWaterPositions = new Int32Array(this.depth.length);
  private activeWaterCount = 0;
  /** 仍需求解的含水格；稳定湖区保留水量和渲染数据，但退出每子步交换。 */
  private readonly awakeWaterIndices = new Int32Array(this.depth.length);
  private readonly awakeWaterPositions = new Int32Array(this.depth.length);
  private readonly sleepStablePasses = new Uint8Array(this.depth.length);
  private awakeWaterCount = 0;
  private sleepAuditCursor = 0;
  /** 唤醒水格及正交相邻一圈，按旧实现的升序交换顺序复用。 */
  private readonly physicsCellIndices = new Int32Array(this.depth.length);
  private readonly physicsCellScratch = new Int32Array(this.depth.length);
  private readonly physicsCellMarks = new Uint32Array(this.depth.length);
  private readonly physicsRadixCounts = new Uint32Array(256);
  private readonly physicsRadixPassCount = Math.ceil(
    Math.max(1, Math.ceil(Math.log2(this.depth.length) / 8)) / 2,
  ) * 2;
  private physicsCellMark = 0;
  private physicsCellCount = 0;
  /** 本帧需要更新流速、泡沫或湖泊响应的格子。 */
  private readonly frameFlowCellIndices = new Int32Array(this.depth.length);
  private readonly frameFlowCellMarks = new Uint32Array(this.depth.length);
  private frameFlowCellMark = 0;
  private frameFlowCellCount = 0;
  /** 上一帧仍有动态状态需要衰减的格子。 */
  private readonly flowStateCellIndices = new Int32Array(this.depth.length);
  private flowStateCellCount = 0;
  private readonly waterfallEnergy = new Float32Array(this.depth.length);
  private readonly waterfallTarget = new Int32Array(this.depth.length);
  /** 仅供渲染的连续覆盖场，不参与水量交换或任何物理判定。 */
  private readonly visualCoverageRaw = new Float32Array(this.depth.length);
  private readonly previousVisualCoverageRaw = new Float32Array(this.depth.length);
  private readonly visualCoverageBlur = new Float32Array(this.depth.length);
  private readonly visualCoveragePixels = new Uint8Array(this.depth.length);
  private readonly previousVisualSurfaceHeight = new Float32Array(this.depth.length);
  private readonly visualSurfaceHeight = new Float32Array(this.depth.length);
  /** 最终交给独立水网格的高度；只由前后物理状态插值，不再受覆盖遮罩二次改写。 */
  private readonly renderSurfaceHeight = new Float32Array(this.depth.length);
  private readonly visualCoverageTexture: THREE.DataTexture;
  private readonly renderSystem: WaterRenderSystem;
  private readonly marker = new THREE.Group();
  private physicsAccumulator = 0;
  private renderRefreshElapsed = 0;
  private renderTopologyDirty = false;
  private readonly performanceStats: WaterPerformanceStats = {
    physicsMs: 0,
    geometryMs: 0,
    topologyMs: 0,
  };
  private sourceIndex = 0;
  private sourceEditing = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
  ) {
    const geometry = this.createGeometry();
    this.activeWaterPositions.fill(-1);
    this.awakeWaterPositions.fill(-1);
    this.gravityTarget.fill(-1);
    this.waterfallTarget.fill(-1);
    this.visualCoverageTexture = new THREE.DataTexture(
      this.visualCoveragePixels,
      this.resolutionX,
      this.resolutionZ,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.visualCoverageTexture.name = "water-visual-coverage";
    this.visualCoverageTexture.minFilter = THREE.LinearFilter;
    this.visualCoverageTexture.magFilter = THREE.LinearFilter;
    this.visualCoverageTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.visualCoverageTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.visualCoverageTexture.generateMipmaps = false;
    this.visualCoverageTexture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: {
        shallowColor: { value: new THREE.Color("#45b3b8") },
        deepColor: { value: new THREE.Color("#175f82") },
        uShallowDepth: { value: 0.04 },
        uDeepDepth: { value: 2.5 },
        uTime: { value: 0.0 },
        uWorldSize: { value: new THREE.Vector2(WORLD_CONFIG.sizeX, WORLD_CONFIG.sizeZ) },
        uVisualCoverage: { value: this.visualCoverageTexture },
      },
      vertexShader: `
        attribute float aDepth;
        attribute vec2 aFlow;
        attribute float aFlowSpeed;
        attribute float aTurbulence;
        attribute float aFoam;
        attribute float aLake;
        attribute float aShore;

        varying float vDepth;
        varying vec2 vFlow;
        varying float vFlowSpeed;
        varying float vTurbulence;
        varying float vFoam;
        varying float vLake;
        varying float vShore;
        varying vec3 vWorldPosition;

        void main() {
          vDepth = aDepth;
          vFlow = aFlow;
          vFlowSpeed = aFlowSpeed;
          vTurbulence = aTurbulence;
          vFoam = aFoam;
          vLake = aLake;
          vShore = aShore;
          // 顶点完全不做视觉位移，水岸边界不会因为动画发生几何抖动。
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 shallowColor;
        uniform vec3 midColor;
        uniform vec3 deepColor;
        uniform float uShallowDepth;
        uniform float uMidDepth;
        uniform float uDeepDepth;
        uniform vec2 uWorldSize;
        uniform sampler2D uVisualCoverage;

        varying float vDepth;
        varying vec2 vFlow;
        varying float vFlowSpeed;
        varying float vTurbulence;
        varying float vFoam;
        varying float vLake;
        varying float vShore;
        varying vec3 vWorldPosition;

        void main() {
          // 覆盖场是独立于地形三角面的双线性纹理，边缘不再沿三角形对角线切出尖角。
          vec2 coverageUv = clamp(vWorldPosition.xz / uWorldSize + 0.5, 0.0, 1.0);
          float coverageField = texture2D(uVisualCoverage, coverageUv).r;
          // 固定的世界空间过渡，不随镜头或时间变化，避免边缘闪线。
          float waterCoverage = smoothstep(0.12, 0.32, coverageField);
          if (waterCoverage < 0.02) discard;

          float visualDepth = max(vDepth, waterCoverage * 0.008);
          float depthMix = smoothstep(uShallowDepth, uDeepDepth, visualDepth);
          vec3 color = mix(shallowColor, deepColor, depthMix);

          // 暂时只保留稳定纯色水面；不再有移动浅色块、轮廓线或亮边动画。
          gl_FragColor = vec4(color, waterCoverage);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "legacy-water-surface-data";
    this.mesh.renderOrder = 3;
    // 原地形贴皮只保留为暂时的数据载体，不再参与绘制。
    this.mesh.visible = false;
    this.renderSystem = new WaterRenderSystem(this.scene, this.terrain, this.visualCoverageTexture);

    this.rebuildFlowTerrainHeightCache();
    this.previousTerrain.set(this.terrain.heights);
    this.captureTerrainStaticState();
    this.createSourceMarker();
    this.setSource(this.terrain.sourceIndex);
    this.refreshRenderImmediately();
  }

  step(deltaTime: number, flowRate: number, flowDelay: number): void {
    const safeDelta = THREE.MathUtils.clamp(
      deltaTime,
      0,
      PHYSICS_FIXED_DELTA * MAX_PHYSICS_STEPS_PER_FRAME,
    );
    const physicsStart = performance.now();
    const safeFlowDelay = THREE.MathUtils.clamp(flowDelay, 0.02, 0.5);
    this.physicsAccumulator = Math.min(
      PHYSICS_FIXED_DELTA * MAX_PHYSICS_STEPS_PER_FRAME,
      this.physicsAccumulator + safeDelta,
    );
    let physicsSteps = 0;
    let coverageTopologyChanged = false;
    while (
      this.physicsAccumulator + Number.EPSILON >= PHYSICS_FIXED_DELTA
      && physicsSteps < MAX_PHYSICS_STEPS_PER_FRAME
    ) {
      this.previousVisualSurfaceHeight.set(this.visualSurfaceHeight);
      this.simulatePhysicsStep(PHYSICS_FIXED_DELTA, flowRate, safeFlowDelay);
      this.updateVisualSurfaceState(PHYSICS_FIXED_DELTA);
      coverageTopologyChanged = this.updateVisualCoverage(PHYSICS_FIXED_DELTA)
        || coverageTopologyChanged;
      this.physicsAccumulator -= PHYSICS_FIXED_DELTA;
      physicsSteps += 1;
    }
    if (this.physicsAccumulator < 1e-8) this.physicsAccumulator = 0;
    this.recordPerformance("physicsMs", performance.now() - physicsStart);

    const geometryStart = performance.now();
    const interpolationAlpha = THREE.MathUtils.clamp(
      this.physicsAccumulator / PHYSICS_FIXED_DELTA,
      0,
      1,
    );
    if (coverageTopologyChanged) this.renderTopologyDirty = true;
    this.updateGeometry(interpolationAlpha);
    this.uploadDynamicRenderFields();
    this.recordPerformance("geometryMs", performance.now() - geometryStart);

    this.renderRefreshElapsed = Math.min(
      RENDER_TOPOLOGY_INTERVAL,
      this.renderRefreshElapsed + safeDelta,
    );
    if (this.renderTopologyDirty && this.renderRefreshElapsed >= RENDER_TOPOLOGY_INTERVAL) {
      const topologyStart = performance.now();
      this.rebuildRenderGeometry();
      this.recordPerformance("topologyMs", performance.now() - topologyStart);
      this.renderTopologyDirty = false;
      this.renderRefreshElapsed = 0;
    }
  }

  private simulatePhysicsStep(deltaTime: number, flowRate: number, flowDelay: number): void {
    const subDelta = deltaTime / WORLD_CONFIG.water.substeps;
    const availableTransferResponse = 1 - Math.exp(-AVAILABLE_TRANSFER_RATE * subDelta);
    const surfaceTransferResponse = 1 - Math.exp(-SURFACE_TRANSFER_RATE * subDelta);
    this.beginFrameFlowCells();

    // ── 指数衰减 recentInflow，解锁随时间的旧流入水量 ──
    // 每经过一个停留时间，约 63% 的锁定水被解锁。
    const decay = Math.exp(-deltaTime / flowDelay);
    for (let activeOffset = 0; activeOffset < this.activeWaterCount; activeOffset += 1) {
      this.recentInflow[this.activeWaterIndices[activeOffset]] *= decay;
    }

    for (let pass = 0; pass < WORLD_CONFIG.water.substeps; pass += 1) {
      // 源头注入
      const sourceAdded = WORLD_CONFIG.water.sourceRate * flowRate * subDelta;
      this.depth[this.sourceIndex] += sourceAdded;
      // 源头的水是"新"的 → 加入 recentInflow
      this.recentInflow[this.sourceIndex] += sourceAdded;
      this.addActiveWaterCell(this.sourceIndex);

      this.collectPhysicsCells();
      for (let physicsOffset = 0; physicsOffset < this.physicsCellCount; physicsOffset += 1) {
        const index = this.physicsCellIndices[physicsOffset];
        this.delta[index] = 0;
        // The ocean is a one-way sink. Clear any saved/previous depth before
        // exchange so it can never push water back onto the simulated terrain.
        if (this.isOceanOutflowCell(index)) {
          this.depth[index] = 0;
          this.recentInflow[index] = 0;
        }
      }
      this.prepareGravityPriorities();
      for (let physicsOffset = 0; physicsOffset < this.physicsCellCount; physicsOffset += 1) {
        const index = this.physicsCellIndices[physicsOffset];
        const x = index % this.resolution;
        const z = Math.floor(index / this.resolution);
        if (
          x < this.resolutionX - 1
          && this.physicsCellMarks[index + 1] === this.physicsCellMark
        ) {
          this.exchange(index, index + 1, availableTransferResponse, surfaceTransferResponse);
        }
        if (
          z < this.resolutionZ - 1
          && this.physicsCellMarks[index + this.resolution] === this.physicsCellMark
        ) {
          this.exchange(index, index + this.resolution, availableTransferResponse, surfaceTransferResponse);
        }
      }

      for (let physicsOffset = 0; physicsOffset < this.physicsCellCount; physicsOffset += 1) {
        const index = this.physicsCellIndices[physicsOffset];
        const nextDepth = Math.max(
          0,
          this.depth[index] + this.delta[index] - WORLD_CONFIG.water.evaporation * subDelta,
        );
        if (this.isOceanOutflowCell(index)) {
          this.depth[index] = 0;
          this.recentInflow[index] = 0;
          this.deleteActiveWaterCell(index);
          continue;
        }
        this.depth[index] = nextDepth;
        // 数值求解留下的微量薄膜已经没有可感知体积，继续保留只会让山坡看起来像粘着一层水。
        if (this.depth[index] < RESIDUAL_WATER_DEPTH) {
          this.depth[index] = 0;
          this.recentInflow[index] = 0;
          this.deleteActiveWaterCell(index);
        } else {
          this.addActiveWaterCell(index, false);
        }
        // recentInflow 不能超过实际水量（蒸发可能让实际水量比锁定量更少）
        if (this.recentInflow[index] > this.depth[index]) {
          this.recentInflow[index] = this.depth[index];
        }
      }
      this.applySleepingEvaporation(subDelta);
      this.updateAwakeWaterCells();
    }
    this.auditSleepingWaterCells();
    this.updateFlowState(deltaTime);
  }

  /** 暴露 ShaderMaterial 以便外部实时调参与调试 */
  get waterMaterial(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial;
  }

  get performance(): Readonly<WaterPerformanceStats> {
    return this.performanceStats;
  }

  getDepthSnapshot(): number[] {
    return Array.from(this.depth);
  }

  restoreDepthSnapshot(values: number[]): void {
    this.depth.fill(0);
    this.depth.set(values.slice(0, this.depth.length));
    this.recentInflow.fill(0);
    // Map loading replaces the complete terrain and rock fields before water
    // is restored. Rebuild the hydraulic cache here so physics cannot keep
    // following the previously generated mountain and appear to tunnel out
    // through an unrelated low point on the back side.
    this.rebuildFlowTerrainHeightCache();
    this.previousTerrain.set(this.terrain.heights);
    this.resetDynamicState();
    this.rebuildActiveWaterCells();
    this.renderSystem.syncTerrainFields();
    this.captureTerrainStaticState();
    this.setSource(this.terrain.sourceIndex);
    this.refreshRenderImmediately();
  }

  clear(): void {
    this.depth.fill(0);
    this.recentInflow.fill(0);
    this.visualCoverageRaw.fill(0);
    this.previousVisualCoverageRaw.fill(0);
    this.visualCoverageBlur.fill(0);
    this.visualCoveragePixels.fill(0);
    this.visualCoverageTexture.needsUpdate = true;
    this.resetDynamicState();
    this.refreshRenderImmediately();
  }

  syncTerrain(preserveSurface = true): void {
    this.rebuildFlowTerrainHeightCache();
    if (preserveSurface) {
      for (let i = 0; i < this.depth.length; i += 1) {
        const terrainDelta = this.terrain.heights[i] - this.previousTerrain[i];
        if (terrainDelta > 0.0001) {
          // 地形上升：挤出该位置的水，避免水嵌入山体
          this.depth[i] = Math.max(0, this.depth[i] - terrainDelta);
        }
        // 地形下降：不凭空生成水，水只能从源头流过来
        if (this.depth[i] < 0.0003) this.depth[i] = 0;
      }
    } else {
      this.depth.fill(0);
      this.recentInflow.fill(0);
    }
    this.resetDynamicState();
    this.rebuildActiveWaterCells();
    this.renderSystem.syncTerrainFields();
    this.captureTerrainStaticState();
    this.previousTerrain.set(this.terrain.heights);
    this.refreshRenderImmediately();
    this.setSource(this.terrain.sourceIndex);
  }

  /**
   * Lightweight terrain synchronization for a continuous sculpting stroke.
   * Preserve all derived water state so a lake cannot repeatedly fall back to
   * the river render path while the pointer moves across the terrain.
   */
  syncTerrainDuringStroke(changedIndices: readonly number[]): void {
    this.refreshFlowTerrainHeightCache(changedIndices);
    const changedStaticIndices: number[] = [];
    for (const index of changedIndices) {
      if (index < 0 || index >= this.depth.length) continue;
      const terrainDelta = this.terrain.heights[index] - this.previousTerrain[index];
      const rockMask = this.terrain.isRockIndex(index) ? 1 : 0;
      const terrainChanged = Math.abs(terrainDelta) > 0.0001;
      const rockChanged = rockMask !== this.previousRockMask[index];
      if (terrainChanged || rockChanged) {
        changedStaticIndices.push(index);
        this.previousRockMask[index] = rockMask;
        this.wakeWaterNeighborhood(index);
      }
      if (!terrainChanged) continue;

      if (terrainDelta > 0) {
        this.depth[index] = Math.max(0, this.depth[index] - terrainDelta);
      }
      if (this.depth[index] < 0.0003) {
        this.depth[index] = 0;
        this.recentInflow[index] = 0;
        this.deleteActiveWaterCell(index);
      } else {
        if (this.recentInflow[index] > this.depth[index]) {
          this.recentInflow[index] = this.depth[index];
        }
        this.addActiveWaterCell(index);
      }
      this.previousTerrain[index] = this.terrain.heights[index];
    }

    this.renderSystem.syncTerrainFields(changedStaticIndices, false);
    // Keep the current absolute water surface during the stroke. The regular
    // fixed-30 Hz update will move it toward the new physical target and upload
    // the two shared state textures once on the normal render path.
  }

  /** Perform at most one topology/effect reconciliation when a stroke ends. */
  finishTerrainStroke(): void {
    this.rebuildFlowTerrainHeightCache();
    this.rebuildActiveWaterCells();
    this.renderSystem.syncTerrainFields();
    this.captureTerrainStaticState();
    this.previousTerrain.set(this.terrain.heights);
    this.updateVisualCoverage(PHYSICS_FIXED_DELTA);
    this.uploadDynamicRenderFields();
    // One post-stroke rebuild keeps shoreline and effect geometry consistent
    // with the final terrain without resetting lake, flow, or foam fields.
    this.rebuildRenderGeometry();
    this.renderTopologyDirty = false;
    this.renderRefreshElapsed = 0;
  }

  setSource(index: number): void {
    this.sourceIndex = index;
    const position = this.terrain.indexToWorld(index);
    this.marker.position.set(position.x, position.y + 0.62, position.z);
  }

  raycastSource(raycaster: THREE.Raycaster): THREE.Intersection | null {
    return raycaster.intersectObject(this.marker, true)[0] ?? null;
  }

  setSourceEditing(editing: boolean): void {
    this.sourceEditing = editing;
  }

  updateMarker(time: number, active: boolean): void {
    this.renderSystem.update(time);
    const pulse = 1 + Math.sin(time * 0.004) * 0.1;
    this.marker.scale.setScalar(this.sourceEditing ? 1.2 + pulse * 0.08 : active ? pulse : 0.88);
    this.marker.rotation.y = time * 0.00035;
    const core = this.marker.getObjectByName("source-core") as THREE.Mesh | undefined;
    if (core && core.material instanceof THREE.MeshStandardMaterial) {
      core.material.emissiveIntensity = this.sourceEditing
        ? 2 + Math.sin(time * 0.008) * 0.35
        : active ? 1.25 + Math.sin(time * 0.006) * 0.25 : 0.32;
    }
    const halo = this.marker.getObjectByName("source-halo") as THREE.Mesh | undefined;
    if (halo && halo.material instanceof THREE.MeshBasicMaterial) {
      halo.material.opacity = this.sourceEditing ? 0.92 : 0.48;
    }
  }

  /** 查询任意世界坐标的水深（双线性插值），供外部系统查询 */
  depthAt(worldX: number, worldZ: number): number {
    const fx = (worldX + WORLD_CONFIG.sizeX * 0.5) / this.terrain.cellSize;
    const fz = (worldZ + WORLD_CONFIG.sizeZ * 0.5) / this.terrain.cellSize;
    const x0 = Math.max(0, Math.min(this.resolutionX - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(this.resolutionZ - 2, Math.floor(fz)));
    const tx = fx - x0;
    const tz = fz - z0;
    const idx = (z0: number, x0: number) => z0 * this.resolution + x0;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.depth[idx(z0, x0)], this.depth[idx(z0, x0 + 1)], tx),
      THREE.MathUtils.lerp(this.depth[idx(z0 + 1, x0)], this.depth[idx(z0 + 1, x0 + 1)], tx),
      tz,
    );
  }

  /** Mark every terrain vertex within `radius` world units of visible water. */
  fillProximityMask(target: Uint8Array, radius: number): void {
    if (target.length !== this.depth.length) return;
    target.fill(0);

    const radiusInCells = Math.ceil(radius / this.terrain.cellSize);
    const radiusSquared = radius * radius;
    for (let waterIndex = 0; waterIndex < this.depth.length; waterIndex += 1) {
      if (this.depth[waterIndex] < 0.004) continue;
      const waterX = waterIndex % this.resolution;
      const waterZ = Math.floor(waterIndex / this.resolution);

      for (let dz = -radiusInCells; dz <= radiusInCells; dz += 1) {
        const z = waterZ + dz;
        if (z < 0 || z >= this.resolutionZ) continue;
        for (let dx = -radiusInCells; dx <= radiusInCells; dx += 1) {
          const x = waterX + dx;
          if (x < 0 || x >= this.resolutionX) continue;
          const distanceSquared = (dx * dx + dz * dz) * this.terrain.cellSize * this.terrain.cellSize;
          if (distanceSquared <= radiusSquared) target[z * this.resolution + x] = 1;
        }
      }
    }
  }

  get volume(): number {
    let sum = 0;
    for (let i = 0; i < this.depth.length; i += 1) sum += this.depth[i];
    return sum * this.terrain.cellSize * this.terrain.cellSize;
  }

  dispose(): void {
    this.scene.remove(this.mesh, this.marker);
    this.renderSystem.dispose();
    this.visualCoverageTexture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.marker.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
      }
    });
  }

  /**
   * 相邻两格之间的水量交换。
   * 只有"旧水"（超出 recentInflow 的部分）才能流出；
   * 刚流入的水会按当前流速对应的停留时间锁定，之后随指数衰减逐步解锁。
   */
  private exchange(
    a: number,
    b: number,
    availableTransferResponse: number,
    surfaceTransferResponse: number,
  ): void {
    const surfaceA = this.getFlowSurface(a);
    const surfaceB = this.getFlowSurface(b);
    const difference = surfaceA - surfaceB;
    if (Math.abs(difference) < MIN_SURFACE_DIFFERENCE) return;

    if (difference > 0 && this.depth[a] > MIN_TRANSFER_DEPTH) {
      // 只有"旧水"可以流出
      const locked = Math.min(this.recentInflow[a], this.depth[a]);
      // 与 main 一致：即使落差很大，新到的水也必须在当前格完成
      // 停留时间。这样从高处到低处会留下连续水链，而不是越级抽空中间格。
      const available = this.depth[a] - locked;
      if (available < MIN_TRANSFER_DEPTH) return;
      const gravityPriority = this.getGravityPriority(a, b);
      const amount = Math.min(
        available * availableTransferResponse,
        difference * surfaceTransferResponse,
      ) * gravityPriority;
      if (amount < MIN_TRANSFER_DEPTH) return;
      this.recordTransfer(a, b, amount, difference);
      this.depositTransfer(a, b, amount);
    } else if (difference < 0 && this.depth[b] > MIN_TRANSFER_DEPTH) {
      const locked = Math.min(this.recentInflow[b], this.depth[b]);
      const available = this.depth[b] - locked;
      if (available < MIN_TRANSFER_DEPTH) return;
      const gravityPriority = this.getGravityPriority(b, a);
      const amount = Math.min(
        available * availableTransferResponse,
        -difference * surfaceTransferResponse,
      ) * gravityPriority;
      if (amount < MIN_TRANSFER_DEPTH) return;
      this.recordTransfer(b, a, amount, -difference);
      this.depositTransfer(b, a, amount);
    }
  }

  private getGravityPriority(from: number, to: number): number {
    const fromSurface = this.getFlowSurface(from);
    const steepestTarget = this.gravityTarget[from];
    const steepestDrop = this.gravityDrop[from];
    const gravityStrength = this.gravityStrength[from];
    if (gravityStrength <= 0.0001 || steepestTarget < 0) return 1;
    if (to === steepestTarget) {
      // The lowest neighbour gets the main discharge capacity.
      return THREE.MathUtils.lerp(1, 1.65, gravityStrength);
    }

    const targetDrop = Math.max(0, fromSurface - this.getFlowSurface(to));
    const relativeDrop = THREE.MathUtils.clamp(targetDrop / Math.max(steepestDrop, 0.0001), 0, 1);
    // Only a direction that is almost as low as the steepest neighbour may
    // share the flow. Clearly higher side cells receive no downhill spread.
    const equallyLow = THREE.MathUtils.smoothstep(relativeDrop, 0.82, 0.985);
    const secondaryWeight = equallyLow * 0.48;
    return THREE.MathUtils.lerp(1, secondaryWeight, gravityStrength);
  }

  private prepareGravityPriorities(): void {
    for (let offset = 0; offset < this.physicsCellCount; offset += 1) {
      const index = this.physicsCellIndices[offset];
      const x = index % this.resolution;
      const z = Math.floor(index / this.resolution);
      const sourceSurface = this.getFlowSurface(index);
      let steepestTarget = -1;
      let steepestDrop = 0;

      if (x > 0) {
        const target = index - 1;
        const drop = sourceSurface - this.getFlowSurface(target);
        if (drop > steepestDrop) {
          steepestDrop = drop;
          steepestTarget = target;
        }
      }
      if (x < this.resolutionX - 1) {
        const target = index + 1;
        const drop = sourceSurface - this.getFlowSurface(target);
        if (drop > steepestDrop) {
          steepestDrop = drop;
          steepestTarget = target;
        }
      }
      if (z > 0) {
        const target = index - this.resolution;
        const drop = sourceSurface - this.getFlowSurface(target);
        if (drop > steepestDrop) {
          steepestDrop = drop;
          steepestTarget = target;
        }
      }
      if (z < this.resolutionZ - 1) {
        const target = index + this.resolution;
        const drop = sourceSurface - this.getFlowSurface(target);
        if (drop > steepestDrop) {
          steepestDrop = drop;
          steepestTarget = target;
        }
      }

      this.gravityTarget[index] = steepestTarget;
      this.gravityDrop[index] = steepestDrop;
      this.gravityStrength[index] = THREE.MathUtils.smoothstep(
        steepestDrop,
        GRAVITY_PRIORITY_START,
        GRAVITY_PRIORITY_FULL,
      );
    }
  }

  private getFlowSurface(index: number): number {
    return this.getFlowTerrainHeight(index) + this.depth[index];
  }

  private getFlowTerrainHeight(index: number): number {
    return this.flowTerrainHeight[index];
  }

  private calculateFlowTerrainHeight(index: number): number {
    const height = this.terrain.heights[index];
    // A painted stone is intentional macro geometry, not a one-cell terrain
    // bump. Preserve its exact rendered surface in the hydraulic calculation.
    if (this.terrain.isRockIndex(index)) return height;
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    let hydraulicBridge = Number.NEGATIVE_INFINITY;
    const considerOppositePair = (first: number, second: number): void => {
      const bridgeHeight = Math.max(this.terrain.heights[first], this.terrain.heights[second]);
      const prominence = height - bridgeHeight;
      if (prominence > 0.002 && prominence <= COVERABLE_BUMP_HEIGHT) {
        hydraulicBridge = Math.max(hydraulicBridge, bridgeHeight);
      }
    };

    // A monotonic hillside has a higher sample on one side and is preserved.
    // A small spike or one-cell ridge has lower terrain on both opposite sides
    // and is treated as sub-grid roughness, including diagonal ridges.
    if (x > 0 && x < this.resolutionX - 1) considerOppositePair(index - 1, index + 1);
    if (z > 0 && z < this.resolutionZ - 1) considerOppositePair(index - this.resolution, index + this.resolution);
    if (x > 0 && x < this.resolutionX - 1 && z > 0 && z < this.resolutionZ - 1) {
      considerOppositePair(index - this.resolution - 1, index + this.resolution + 1);
      considerOppositePair(index - this.resolution + 1, index + this.resolution - 1);
    }
    if (!Number.isFinite(hydraulicBridge)) return height;

    // Use the most conservative valid bridge so terrain remains dominant.
    return THREE.MathUtils.lerp(height, hydraulicBridge, 0.94);
  }

  private rebuildFlowTerrainHeightCache(): void {
    for (let index = 0; index < this.flowTerrainHeight.length; index += 1) {
      this.flowTerrainHeight[index] = this.calculateFlowTerrainHeight(index);
    }
  }

  private refreshFlowTerrainHeightCache(changedIndices: readonly number[]): void {
    this.flowTerrainDirtyMark = this.nextCellMark(
      this.flowTerrainDirtyMarks,
      this.flowTerrainDirtyMark,
    );
    for (const changedIndex of changedIndices) {
      if (changedIndex < 0 || changedIndex >= this.depth.length) continue;
      const changedX = changedIndex % this.resolution;
      const changedZ = Math.floor(changedIndex / this.resolution);
      for (let dz = -1; dz <= 1; dz += 1) {
        const z = changedZ + dz;
        if (z < 0 || z >= this.resolutionZ) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = changedX + dx;
          if (x < 0 || x >= this.resolutionX) continue;
          const index = z * this.resolution + x;
          if (this.flowTerrainDirtyMarks[index] === this.flowTerrainDirtyMark) continue;
          this.flowTerrainDirtyMarks[index] = this.flowTerrainDirtyMark;
          this.flowTerrainHeight[index] = this.calculateFlowTerrainHeight(index);
        }
      }
    }
  }

  private depositTransfer(from: number, to: number, amount: number): void {
    this.delta[from] -= amount;
    this.delta[to] += amount;
    this.recentInflow[to] += amount;
  }

  private resetFrameAccumulators(): void {
    this.flowAccumX.fill(0);
    this.flowAccumZ.fill(0);
    this.outflowAccum.fill(0);
    this.incomingAccum.fill(0);
    this.incomingX.fill(0);
    this.incomingZ.fill(0);
    this.dropAccum.fill(0);
  }

  private nextCellMark(marks: Uint32Array, currentMark: number): number {
    if (currentMark >= 0xfffffffe) {
      marks.fill(0);
      return 1;
    }
    return currentMark + 1;
  }

  private beginFrameFlowCells(): void {
    this.frameFlowCellMark = this.nextCellMark(
      this.frameFlowCellMarks,
      this.frameFlowCellMark,
    );
    this.frameFlowCellCount = 0;
    for (let offset = 0; offset < this.flowStateCellCount; offset += 1) {
      this.prepareFrameFlowCell(this.flowStateCellIndices[offset]);
    }
  }

  private prepareFrameFlowCell(index: number): void {
    if (this.frameFlowCellMarks[index] === this.frameFlowCellMark) return;
    this.frameFlowCellMarks[index] = this.frameFlowCellMark;
    this.frameFlowCellIndices[this.frameFlowCellCount] = index;
    this.frameFlowCellCount += 1;
    this.flowAccumX[index] = 0;
    this.flowAccumZ[index] = 0;
    this.outflowAccum[index] = 0;
    this.incomingAccum[index] = 0;
    this.incomingX[index] = 0;
    this.incomingZ[index] = 0;
    this.dropAccum[index] = 0;
  }

  private collectPhysicsCells(): void {
    this.physicsCellMark = this.nextCellMark(this.physicsCellMarks, this.physicsCellMark);
    this.physicsCellCount = 0;
    for (let awakeOffset = 0; awakeOffset < this.awakeWaterCount; awakeOffset += 1) {
      const index = this.awakeWaterIndices[awakeOffset];
      const x = index % this.resolution;
      const z = Math.floor(index / this.resolution);
      this.addPhysicsCell(index);
      if (x > 0) this.addPhysicsCell(index - 1);
      if (x < this.resolutionX - 1) this.addPhysicsCell(index + 1);
      if (z > 0) this.addPhysicsCell(index - this.resolution);
      if (z < this.resolutionZ - 1) this.addPhysicsCell(index + this.resolution);
    }
    this.sortPhysicsCells();
  }

  private addPhysicsCell(index: number): void {
    if (this.physicsCellMarks[index] === this.physicsCellMark) return;
    this.physicsCellMarks[index] = this.physicsCellMark;
    this.physicsCellIndices[this.physicsCellCount] = index;
    this.physicsCellCount += 1;
    this.prepareFrameFlowCell(index);
  }

  /** Reusable four-pass radix sort preserves the old ascending exchange order. */
  private sortPhysicsCells(): void {
    if (this.physicsCellCount <= 1) return;
    let input = this.physicsCellIndices;
    let output = this.physicsCellScratch;
    for (let pass = 0; pass < this.physicsRadixPassCount; pass += 1) {
      const shift = pass * 8;
      this.physicsRadixCounts.fill(0);
      for (let offset = 0; offset < this.physicsCellCount; offset += 1) {
        this.physicsRadixCounts[(input[offset] >>> shift) & 0xff] += 1;
      }
      let writeOffset = 0;
      for (let bucket = 0; bucket < this.physicsRadixCounts.length; bucket += 1) {
        const bucketCount = this.physicsRadixCounts[bucket];
        this.physicsRadixCounts[bucket] = writeOffset;
        writeOffset += bucketCount;
      }
      for (let offset = 0; offset < this.physicsCellCount; offset += 1) {
        const index = input[offset];
        const bucket = (index >>> shift) & 0xff;
        output[this.physicsRadixCounts[bucket]] = index;
        this.physicsRadixCounts[bucket] += 1;
      }
      const swap = input;
      input = output;
      output = swap;
    }
  }

  private addActiveWaterCell(index: number, wake = true): void {
    if (wake) this.addAwakeWaterCell(index);
    if (this.activeWaterPositions[index] >= 0) return;
    this.activeWaterPositions[index] = this.activeWaterCount;
    this.activeWaterIndices[this.activeWaterCount] = index;
    this.activeWaterCount += 1;
  }

  private deleteActiveWaterCell(index: number): void {
    this.deleteAwakeWaterCell(index);
    const offset = this.activeWaterPositions[index];
    if (offset < 0) return;
    const lastOffset = this.activeWaterCount - 1;
    const lastIndex = this.activeWaterIndices[lastOffset];
    this.activeWaterIndices[offset] = lastIndex;
    this.activeWaterPositions[lastIndex] = offset;
    this.activeWaterPositions[index] = -1;
    this.activeWaterCount = lastOffset;
  }

  private clearActiveWaterCells(): void {
    this.clearAwakeWaterCells();
    for (let offset = 0; offset < this.activeWaterCount; offset += 1) {
      this.activeWaterPositions[this.activeWaterIndices[offset]] = -1;
    }
    this.activeWaterCount = 0;
    this.sleepAuditCursor = 0;
  }

  private addAwakeWaterCell(index: number): void {
    if (this.awakeWaterPositions[index] >= 0) return;
    this.awakeWaterPositions[index] = this.awakeWaterCount;
    this.awakeWaterIndices[this.awakeWaterCount] = index;
    this.awakeWaterCount += 1;
  }

  private deleteAwakeWaterCell(index: number): void {
    const offset = this.awakeWaterPositions[index];
    if (offset < 0) return;
    const lastOffset = this.awakeWaterCount - 1;
    const lastIndex = this.awakeWaterIndices[lastOffset];
    this.awakeWaterIndices[offset] = lastIndex;
    this.awakeWaterPositions[lastIndex] = offset;
    this.awakeWaterPositions[index] = -1;
    this.awakeWaterCount = lastOffset;
    this.sleepStablePasses[index] = 0;
  }

  private clearAwakeWaterCells(): void {
    for (let offset = 0; offset < this.awakeWaterCount; offset += 1) {
      this.awakeWaterPositions[this.awakeWaterIndices[offset]] = -1;
    }
    this.awakeWaterCount = 0;
    this.sleepStablePasses.fill(0);
  }

  private rebuildActiveWaterCells(): void {
    this.clearActiveWaterCells();
    for (let index = 0; index < this.depth.length; index += 1) {
      if (this.isOceanOutflowCell(index)) {
        this.depth[index] = 0;
        this.recentInflow[index] = 0;
        continue;
      }
      if (this.depth[index] >= RESIDUAL_WATER_DEPTH) {
        this.addActiveWaterCell(index);
      } else {
        this.recentInflow[index] = 0;
      }
    }
  }

  private applySleepingEvaporation(subDelta: number): void {
    if (WORLD_CONFIG.water.evaporation <= 0) return;
    let offset = 0;
    while (offset < this.activeWaterCount) {
      const index = this.activeWaterIndices[offset];
      if (this.physicsCellMarks[index] === this.physicsCellMark) {
        offset += 1;
        continue;
      }
      this.depth[index] = Math.max(
        0,
        this.depth[index] - WORLD_CONFIG.water.evaporation * subDelta,
      );
      if (this.depth[index] < RESIDUAL_WATER_DEPTH || this.isOceanOutflowCell(index)) {
        this.depth[index] = 0;
        this.recentInflow[index] = 0;
        this.deleteActiveWaterCell(index);
        continue;
      }
      if (this.recentInflow[index] > this.depth[index]) {
        this.recentInflow[index] = this.depth[index];
      }
      offset += 1;
    }
  }

  private updateAwakeWaterCells(): void {
    for (let offset = 0; offset < this.physicsCellCount; offset += 1) {
      const index = this.physicsCellIndices[offset];
      if (this.activeWaterPositions[index] < 0) {
        this.deleteAwakeWaterCell(index);
        continue;
      }
      if (this.shouldWaterCellBeAwake(index, true)) {
        this.sleepStablePasses[index] = 0;
        this.addAwakeWaterCell(index);
        continue;
      }
      const stablePasses = Math.min(255, this.sleepStablePasses[index] + 1);
      this.sleepStablePasses[index] = stablePasses;
      if (stablePasses >= WATER_SLEEP_STABLE_SUBSTEPS) {
        this.deleteAwakeWaterCell(index);
      }
    }
  }

  private shouldWaterCellBeAwake(index: number, includeCurrentActivity: boolean): boolean {
    if (index === this.sourceIndex) return true;
    if (this.depth[index] < RESIDUAL_WATER_DEPTH) return false;
    if (this.recentInflow[index] > MIN_TRANSFER_DEPTH) return true;
    if (
      includeCurrentActivity
      && (
        Math.abs(this.delta[index]) >= MIN_TRANSFER_DEPTH
        || this.outflowAccum[index] >= MIN_TRANSFER_DEPTH
        || this.incomingAccum[index] >= MIN_TRANSFER_DEPTH
      )
    ) return true;

    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    if (x > 0 && this.canWaterExchange(index, index - 1)) return true;
    if (x < this.resolutionX - 1 && this.canWaterExchange(index, index + 1)) return true;
    if (z > 0 && this.canWaterExchange(index, index - this.resolution)) return true;
    if (z < this.resolutionZ - 1 && this.canWaterExchange(index, index + this.resolution)) return true;
    return false;
  }

  private canWaterExchange(index: number, neighbor: number): boolean {
    const difference = this.getFlowSurface(index) - this.getFlowSurface(neighbor);
    if (Math.abs(difference) < MIN_SURFACE_DIFFERENCE) return false;
    const source = difference > 0 ? index : neighbor;
    const locked = Math.min(this.recentInflow[source], this.depth[source]);
    return this.depth[source] - locked >= MIN_TRANSFER_DEPTH;
  }

  private auditSleepingWaterCells(): void {
    if (this.activeWaterCount === 0) {
      this.sleepAuditCursor = 0;
      return;
    }
    const auditCount = Math.max(
      1,
      Math.ceil(this.activeWaterCount / WATER_SLEEP_AUDIT_STEPS),
    );
    for (let audited = 0; audited < auditCount && this.activeWaterCount > 0; audited += 1) {
      if (this.sleepAuditCursor >= this.activeWaterCount) this.sleepAuditCursor = 0;
      const index = this.activeWaterIndices[this.sleepAuditCursor];
      this.sleepAuditCursor += 1;
      // Periodically refresh lake/flow render classification even while the
      // physical cell remains asleep; no persistent render lock is introduced.
      this.prepareFrameFlowCell(index);
      if (
        this.awakeWaterPositions[index] < 0
        && this.shouldWaterCellBeAwake(index, false)
      ) {
        this.sleepStablePasses[index] = 0;
        this.addAwakeWaterCell(index);
      }
    }
  }

  private wakeWaterNeighborhood(index: number): void {
    const centerX = index % this.resolution;
    const centerZ = Math.floor(index / this.resolution);
    for (let dz = -1; dz <= 1; dz += 1) {
      const z = centerZ + dz;
      if (z < 0 || z >= this.resolutionZ) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = centerX + dx;
        if (x < 0 || x >= this.resolutionX) continue;
        const neighbor = z * this.resolution + x;
        if (this.activeWaterPositions[neighbor] < 0) continue;
        this.sleepStablePasses[neighbor] = 0;
        this.addAwakeWaterCell(neighbor);
      }
    }
  }

  private isOceanOutflowCell(index: number): boolean {
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    return isOceanOutflowPosition(
      x * this.terrain.cellSize - WORLD_CONFIG.sizeX * 0.5,
      z * this.terrain.cellSize - WORLD_CONFIG.sizeZ * 0.5,
      this.terrain.heights[index],
    );
  }

  private recordTransfer(from: number, to: number, amount: number, surfaceDrop: number): void {
    const fromX = from % this.resolution;
    const fromZ = Math.floor(from / this.resolution);
    const toX = to % this.resolution;
    const toZ = Math.floor(to / this.resolution);
    const directionX = toX - fromX;
    const directionZ = toZ - fromZ;

    this.flowAccumX[from] += directionX * amount;
    this.flowAccumZ[from] += directionZ * amount;
    // 新到达的水也继承主要流向，让波纹在水头处连续，而不是等下一格流出后才出现。
    this.flowAccumX[to] += directionX * amount * 0.42;
    this.flowAccumZ[to] += directionZ * amount * 0.42;
    this.outflowAccum[from] += amount;
    this.incomingAccum[to] += amount;
    this.incomingX[to] += directionX * amount;
    this.incomingZ[to] += directionZ * amount;

    const dropContribution = amount * Math.max(0, surfaceDrop);
    this.dropAccum[from] += dropContribution;
    this.dropAccum[to] += dropContribution * 0.58;

  }

  private updateFlowState(deltaTime: number): void {
    const directionResponse = 1 - Math.exp(-deltaTime * 12);
    const energyResponse = 1 - Math.exp(-deltaTime * 8);
    const lakeShapeResponse = 1 - Math.exp(-deltaTime * 4);
    const foamDecay = Math.exp(-deltaTime * 2.2);
    // Waterfall classification is deliberately disabled. These output fields
    // remain empty so the renderer cannot create waterfall-only effects.
    for (let offset = 0; offset < this.frameFlowCellCount; offset += 1) {
      const index = this.frameFlowCellIndices[offset];
      this.lakeShapeRaw[index] = this.getLakeShapeFactor(index);
    }

    for (let offset = 0; offset < this.frameFlowCellCount; offset += 1) {
      const index = this.frameFlowCellIndices[offset];
      const wet = this.depth[index] > MIN_VISIBLE_DEPTH;
      const effectWet = this.depth[index] > VISUAL_WET_EXIT_DEPTH;
      const lakeShape = this.getLakeRenderShapeFactor(index);
      const flowLength = Math.hypot(this.flowAccumX[index], this.flowAccumZ[index]);
      const fluxSpeed = effectWet
        ? THREE.MathUtils.clamp((this.outflowAccum[index] + this.incomingAccum[index] * 0.35) / Math.max(deltaTime, 0.001) / 0.22, 0, 1)
        : 0;
      if (flowLength > 0.000001) {
        const targetX = this.flowAccumX[index] / flowLength;
        const targetZ = this.flowAccumZ[index] / flowLength;
        this.flowX[index] = THREE.MathUtils.lerp(this.flowX[index], targetX, directionResponse);
        this.flowZ[index] = THREE.MathUtils.lerp(this.flowZ[index], targetZ, directionResponse);
        const smoothedLength = Math.hypot(this.flowX[index], this.flowZ[index]);
        if (smoothedLength > 1) {
          this.flowX[index] /= smoothedLength;
          this.flowZ[index] /= smoothedLength;
        }
      }
      const rawDropEnergy = THREE.MathUtils.clamp(this.dropAccum[index] / Math.max(deltaTime, 0.001) * 2.2, 0, 1);
      const directionalDropSpeed = effectWet
        ? this.getDirectionalDropSpeed(index, this.flowX[index], this.flowZ[index])
        : 0;
      // Flux alone makes a thin stream on a large descent look slow. Combine
      // the actual exchange rate with cumulative hydraulic drop and impact
      // energy, while keeping the result normalized for rendering.
      const rawSpeed = effectWet
        ? THREE.MathUtils.clamp(Math.max(fluxSpeed, directionalDropSpeed, rawDropEnergy * 0.78), 0, 1)
        : 0;
      this.flowSpeed[index] = THREE.MathUtils.lerp(this.flowSpeed[index], rawSpeed, energyResponse);

      this.dropEnergy[index] = THREE.MathUtils.lerp(this.dropEnergy[index], rawDropEnergy, energyResponse);
      const coherentIncoming = Math.hypot(this.incomingX[index], this.incomingZ[index]);
      const convergence = THREE.MathUtils.clamp(
        (this.incomingAccum[index] - coherentIncoming) / Math.max(deltaTime, 0.001) / 0.1,
        0,
        1,
      );

      const shore = wet && this.hasDryNeighbor(index) ? 1 : 0;
      const lakeShoreCalm = THREE.MathUtils.smoothstep(
        lakeShape,
        LAKE_SHORE_CALM_START,
        LAKE_SHORE_CALM_FULL,
      );
      const rawTurbulence = effectWet
        ? THREE.MathUtils.clamp(
          rawDropEnergy * 0.66
            + directionalDropSpeed * 0.52
            + convergence * 0.9
            + rawSpeed * shore * (1 - lakeShoreCalm) * 0.28,
          0,
          1,
        )
        : 0;
      this.turbulence[index] = THREE.MathUtils.lerp(this.turbulence[index], rawTurbulence, energyResponse);
      this.foam[index] = THREE.MathUtils.clamp(
        this.foam[index] * foamDecay + Math.max(0, this.turbulence[index] - 0.48) * deltaTime * 1.65,
        0,
        1,
      );

      // Lake identity comes from the water body's shape, not its instantaneous
      // speed. A deep channel can therefore keep flowing without switching the
      // same facets between the river and lake render paths every physics tick.
      this.lakeFactor[index] = THREE.MathUtils.lerp(
        this.lakeFactor[index],
        lakeShape,
        lakeShapeResponse,
      );

    }

    this.flowStateCellCount = 0;
    for (let offset = 0; offset < this.frameFlowCellCount; offset += 1) {
      const index = this.frameFlowCellIndices[offset];
      const lakeTarget = this.depth[index] > VISUAL_WET_EXIT_DEPTH
        ? this.getLakeRenderShapeFactor(index)
        : 0;
      const keepState = this.flowSpeed[index] > 0.001
        || this.dropEnergy[index] > 0.001
        || this.turbulence[index] > 0.001
        || this.foam[index] > 0.001
        || Math.abs(this.lakeFactor[index] - lakeTarget) > 0.001;
      if (keepState) {
        this.flowStateCellIndices[this.flowStateCellCount] = index;
        this.flowStateCellCount += 1;
      } else {
        this.flowX[index] = 0;
        this.flowZ[index] = 0;
        this.flowSpeed[index] = 0;
        this.dropEnergy[index] = 0;
        this.turbulence[index] = 0;
        this.foam[index] = 0;
        // A settled wet cell retains its current render value until an awake
        // neighbour or periodic audit recomputes it. This is event-driven
        // invalidation, not a lake classification lock.
        if (this.depth[index] <= VISUAL_WET_EXIT_DEPTH) {
          this.lakeShapeRaw[index] = 0;
          this.lakeFactor[index] = 0;
        }
      }
    }
  }

  /**
   * Identify broad, level water bodies from four opposite sample axes.
   * Width and slope stay continuous: one shallow endpoint or one temporarily
   * steep high-flow axis cannot flip the whole cell between lake and river.
   * Neither flow speed nor turbulence enters this classification.
   */
  private getLakeShapeFactor(index: number): number {
    const localDepth = this.depth[index];
    if (localDepth <= 0.04) return 0;

    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    if (
      x < LAKE_SHAPE_RADIUS_CELLS
      || x >= this.resolutionX - LAKE_SHAPE_RADIUS_CELLS
      || z < LAKE_SHAPE_RADIUS_CELLS
      || z >= this.resolutionZ - LAKE_SHAPE_RADIUS_CELLS
    ) return 0;

    let wetAxisSupport = 0;
    let weightedAxisSlope = 0;
    for (const [ax, az, bx, bz, distanceCells] of LAKE_AXIS_PAIRS) {
      const first = (z + az) * this.resolution + x + ax;
      const second = (z + bz) * this.resolution + x + bx;
      const firstWetSupport = THREE.MathUtils.smoothstep(
        this.depth[first],
        VISUAL_WET_ENTER_DEPTH,
        MIN_VISIBLE_DEPTH,
      );
      const secondWetSupport = THREE.MathUtils.smoothstep(
        this.depth[second],
        VISUAL_WET_ENTER_DEPTH,
        MIN_VISIBLE_DEPTH,
      );
      const axisWetSupport = Math.min(firstWetSupport, secondWetSupport);
      if (axisWetSupport <= 0) continue;

      const firstSurface = this.getFlowSurface(first);
      const secondSurface = this.getFlowSurface(second);
      const axisSlope = Math.abs(firstSurface - secondSurface)
        / (distanceCells * this.terrain.cellSize);
      wetAxisSupport += axisWetSupport;
      weightedAxisSlope += axisSlope * axisWetSupport;
    }

    const width = THREE.MathUtils.smoothstep(
      wetAxisSupport / LAKE_AXIS_PAIRS.length,
      0.34,
      0.72,
    );
    const averageAxisSlope = wetAxisSupport > 0
      ? weightedAxisSlope / wetAxisSupport
      : Number.POSITIVE_INFINITY;
    const flatness = 1 - THREE.MathUtils.smoothstep(averageAxisSlope, 0.018, 0.14);
    const depthSupport = THREE.MathUtils.smoothstep(localDepth, 0.04, 0.28);
    return width * flatness * depthSupport;
  }

  /**
   * Extend only the current frame's stable lake core across its shallow rim.
   * Reading the raw shape field prevents the influence from propagating down
   * an attached river over subsequent ticks, so this is neither a lock nor a
   * persistent render classification field.
   */
  private getLakeRenderShapeFactor(index: number): number {
    const localShape = this.lakeShapeRaw[index];
    if (this.depth[index] <= VISUAL_WET_EXIT_DEPTH || localShape >= 0.92) return localShape;

    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    let shoreInfluence = 0;
    for (let radius = 1; radius <= LAKE_SHORE_INFLUENCE_RADIUS_CELLS; radius += 1) {
      const falloff = radius === 1 ? 0.92 : 0.76;
      for (let dz = -radius; dz <= radius; dz += 1) {
        const neighborZ = z + dz;
        if (neighborZ < 0 || neighborZ >= this.resolutionZ) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const neighborX = x + dx;
          if (neighborX < 0 || neighborX >= this.resolutionX) continue;
          const neighbor = neighborZ * this.resolution + neighborX;
          shoreInfluence = Math.max(shoreInfluence, this.lakeShapeRaw[neighbor] * falloff);
        }
      }
    }
    return Math.max(localShape, shoreInfluence);
  }

  /**
   * Estimate a stable downhill speed from the approximate upstream water
   * surface to lower surfaces several cells ahead. This deliberately samples
   * the hydraulic height field instead of triangle normals: low-poly face
   * changes should not make the speed alternate from triangle to triangle.
   */
  private getDirectionalDropSpeed(index: number, directionX: number, directionZ: number): number {
    const directionLength = Math.hypot(directionX, directionZ);
    if (directionLength < 0.04) return 0;

    const dx = directionX / directionLength;
    const dz = directionZ / directionLength;
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    const sourceSurface = this.getCrossFlowSurface(index, dx, dz);
    let bestDrop = 0;
    let bestSlope = 0;
    let previousTarget = -1;

    for (let cells = 1; cells <= FLOW_DROP_LOOKAHEAD_CELLS; cells += 1) {
      const targetX = Math.round(x + dx * cells);
      const targetZ = Math.round(z + dz * cells);
      if (targetX < 0 || targetX >= this.resolutionX || targetZ < 0 || targetZ >= this.resolutionZ) break;
      const target = targetZ * this.resolution + targetX;
      if (target === previousTarget) continue;
      previousTarget = target;

      const targetSurface = this.getCrossFlowSurface(target, dx, dz);
      const drop = Math.max(0, sourceSurface - targetSurface);
      const horizontalDistance = Math.max(this.terrain.cellSize, Math.hypot(targetX - x, targetZ - z) * this.terrain.cellSize);
      bestDrop = Math.max(bestDrop, drop);
      bestSlope = Math.max(bestSlope, drop / horizontalDistance);
    }

    // A short sharp descent and a longer cumulative descent can both create a
    // fast current. The two smooth thresholds reject tiny polygon roughness.
    // Enter the fast-flow range earlier: a clearly descending channel should
    // not need waterfall-scale height loss before its local crests accelerate.
    const slopeStrength = THREE.MathUtils.smoothstep(bestSlope, 0.04, 0.55);
    const dropStrength = THREE.MathUtils.smoothstep(bestDrop, 0.04, 1.0);
    return THREE.MathUtils.clamp(slopeStrength * 0.72 + dropStrength * 0.62, 0, 1);
  }

  /** Average only across wet neighbours perpendicular to the current flow. */
  private getCrossFlowSurface(index: number, directionX: number, directionZ: number): number {
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    const sideX = Math.round(-directionZ);
    const sideZ = Math.round(directionX);
    let surface = this.getFlowSurface(index);
    let weight = 1;

    for (const sign of [-1, 1]) {
      const sampleX = x + sideX * sign;
      const sampleZ = z + sideZ * sign;
      if (sampleX < 0 || sampleX >= this.resolutionX || sampleZ < 0 || sampleZ >= this.resolutionZ) continue;
      const sample = sampleZ * this.resolution + sampleX;
      if (this.depth[sample] <= VISUAL_WET_EXIT_DEPTH) continue;
      surface += this.getFlowSurface(sample) * 0.5;
      weight += 0.5;
    }
    return surface / weight;
  }

  private hasDryNeighbor(index: number): boolean {
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    if (x > 0 && this.depth[index - 1] <= MIN_VISIBLE_DEPTH) return true;
    if (x < this.resolutionX - 1 && this.depth[index + 1] <= MIN_VISIBLE_DEPTH) return true;
    if (z > 0 && this.depth[index - this.resolution] <= MIN_VISIBLE_DEPTH) return true;
    if (z < this.resolutionZ - 1 && this.depth[index + this.resolution] <= MIN_VISIBLE_DEPTH) return true;
    return false;
  }

  private resetDynamicState(): void {
    this.clearActiveWaterCells();
    this.flowStateCellCount = 0;
    this.frameFlowCellCount = 0;
    this.physicsCellCount = 0;
    this.flowX.fill(0);
    this.flowZ.fill(0);
    this.flowSpeed.fill(0);
    this.dropEnergy.fill(0);
    this.turbulence.fill(0);
    this.foam.fill(0);
    this.lakeShapeRaw.fill(0);
    this.lakeFactor.fill(0);
    this.waterfallEnergy.fill(0);
    this.waterfallTarget.fill(-1);
    this.resetFrameAccumulators();
  }

  private createGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array(this.depth.length * 3);
    const depthValues = new Float32Array(this.depth.length);
    const indices: number[] = [];
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;

    for (let z = 0; z < this.resolutionZ; z += 1) {
      for (let x = 0; x < this.resolutionX; x += 1) {
        const index = z * this.resolution + x;
        positions[index * 3] = x * this.terrain.cellSize - halfX;
        positions[index * 3 + 1] = this.terrain.heights[index] - 0.06;
        positions[index * 3 + 2] = z * this.terrain.cellSize - halfZ;
      }
    }
    for (let z = 0; z < WORLD_CONFIG.segmentsZ; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segmentsX; x += 1) {
        const a = z * this.resolution + x;
        const b = a + 1;
        const c = a + this.resolution;
        const d = c + 1;
        if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aDepth", new THREE.BufferAttribute(depthValues, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aFlow", new THREE.BufferAttribute(new Float32Array(this.depth.length * 2), 2).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aFlowSpeed", new THREE.BufferAttribute(new Float32Array(this.depth.length), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aTurbulence", new THREE.BufferAttribute(new Float32Array(this.depth.length), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aFoam", new THREE.BufferAttribute(new Float32Array(this.depth.length), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aLake", new THREE.BufferAttribute(new Float32Array(this.depth.length), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aShore", new THREE.BufferAttribute(new Float32Array(this.depth.length), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  private getUpstreamVisualCoverage(index: number): number {
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    const flowLength = Math.hypot(this.flowX[index], this.flowZ[index]);
    const upstreamX = flowLength > 0.05 ? -this.flowX[index] / flowLength : 0;
    const upstreamZ = flowLength > 0.05 ? -this.flowZ[index] / flowLength : 0;
    let directedCoverage = 0;
    let adjacentCoverage = 0;

    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const neighborX = x + dx;
      const neighborZ = z + dz;
      if (
        neighborX < 0
        || neighborX >= this.resolutionX
        || neighborZ < 0
        || neighborZ >= this.resolutionZ
      ) continue;

      const neighbor = neighborZ * this.resolution + neighborX;
      const neighborCoverage = this.previousVisualCoverageRaw[neighbor];
      adjacentCoverage = Math.max(adjacentCoverage, neighborCoverage);
      if (flowLength <= 0.05) continue;

      const alignment = dx * upstreamX + dz * upstreamZ;
      if (alignment <= 0.12) continue;
      directedCoverage = Math.max(
        directedCoverage,
        neighborCoverage * THREE.MathUtils.lerp(0.82, 1, alignment),
      );
    }

    // A newly reached cell already inherits incoming flow in the physics
    // state. The fallback covers momentary zero/turning flow without letting a
    // disconnected destination reveal itself before an adjacent visible cell.
    return directedCoverage > 0.001 ? directedCoverage : adjacentCoverage;
  }

  private updateVisualCoverage(deltaTime: number, snapToDepth = false): boolean {
    let textureChanged = false;
    let topologyChanged = false;
    this.previousVisualCoverageRaw.set(this.visualCoverageRaw);
    const riseResponse = 1 - Math.exp(-deltaTime * VISUAL_COVERAGE_RISE_RATE);
    const fallResponse = 1 - Math.exp(-deltaTime * VISUAL_COVERAGE_FALL_RATE);

    // Grow only from the previously visible water front into an adjacent wet
    // cell. A destination can no longer show up as a detached patch and then
    // be joined later by a two-cell bridge.
    for (let index = 0; index < this.depth.length; index += 1) {
      const targetCoverage = this.depth[index] <= VISUAL_WET_EXIT_DEPTH
        ? 0
        : THREE.MathUtils.smoothstep(
          this.depth[index],
          VISUAL_WET_EXIT_DEPTH,
          VISUAL_COVERAGE_FULL_DEPTH,
        );
      const previousCoverage = this.previousVisualCoverageRaw[index];
      if (snapToDepth) {
        this.visualCoverageRaw[index] = targetCoverage;
      } else if (targetCoverage <= previousCoverage) {
        this.visualCoverageRaw[index] = THREE.MathUtils.lerp(
          previousCoverage,
          targetCoverage,
          fallResponse,
        );
      } else {
        const connectedCeiling = index === this.sourceIndex
          ? targetCoverage
          : Math.max(previousCoverage, this.getUpstreamVisualCoverage(index));
        this.visualCoverageRaw[index] = THREE.MathUtils.lerp(
          previousCoverage,
          Math.min(targetCoverage, connectedCeiling),
          riseResponse,
        );
      }
      if (targetCoverage === 0 && this.visualCoverageRaw[index] < 0.001) this.visualCoverageRaw[index] = 0;
    }

    for (let z = 0; z < this.resolutionZ; z += 1) {
      const row = z * this.resolution;
      for (let x = 0; x < this.resolutionX; x += 1) {
        const index = row + x;
        const left = row + Math.max(0, x - 1);
        const right = row + Math.min(this.resolution - 1, x + 1);
        this.visualCoverageBlur[index] = (
          this.visualCoverageRaw[left]
          + this.visualCoverageRaw[index] * 2
          + this.visualCoverageRaw[right]
        ) * 0.25;
      }
    }

    for (let z = 0; z < this.resolutionZ; z += 1) {
      const previousRow = Math.max(0, z - 1) * this.resolution;
      const row = z * this.resolution;
      const nextRow = Math.min(this.resolutionZ - 1, z + 1) * this.resolution;
      for (let x = 0; x < this.resolutionX; x += 1) {
        const index = row + x;
        const blurred = (
          this.visualCoverageBlur[previousRow + x]
          + this.visualCoverageBlur[index] * 2
          + this.visualCoverageBlur[nextRow + x]
        ) * 0.25;
        const leftX = Math.max(0, x - 1);
        const rightX = Math.min(this.resolution - 1, x + 1);
        const orthogonalSupport = Math.max(
          this.visualCoverageRaw[row + leftX],
          this.visualCoverageRaw[row + rightX],
          this.visualCoverageRaw[previousRow + x],
          this.visualCoverageRaw[nextRow + x],
        ) * 0.28;
        const diagonalSupport = Math.max(
          this.visualCoverageRaw[previousRow + leftX],
          this.visualCoverageRaw[previousRow + rightX],
          this.visualCoverageRaw[nextRow + leftX],
          this.visualCoverageRaw[nextRow + rightX],
        ) * 0.16;
        // Widen a one-cell stream locally instead of filling gaps between
        // already-visible endpoints. Both supports remain attached to a real
        // wet cell, so they cannot create a detached destination patch.
        const coverage = Math.max(
          this.visualCoverageRaw[index] * 0.94,
          blurred * 1.35,
          orthogonalSupport,
          diagonalSupport,
        );
        const previousPixel = this.visualCoveragePixels[index];
        const nextPixel = Math.round(THREE.MathUtils.clamp(coverage, 0, 1) * 255);
        if (nextPixel !== previousPixel) {
          textureChanged = true;
          if (coverageState(previousPixel) !== coverageState(nextPixel)) topologyChanged = true;
          this.visualCoveragePixels[index] = nextPixel;
        }
      }
    }
    if (textureChanged) this.visualCoverageTexture.needsUpdate = true;
    return topologyChanged;
  }

  private getUnclampedVisualWaterHeight(index: number): number {
    const renderOffset = this.terrain.isRockIndex(index)
      ? WATER_RENDER_OFFSET + 0.04
      : WATER_RENDER_OFFSET;
    // Flow treats an isolated one-cell lake-bottom bump as sub-grid roughness
    // so water can pass across it. Render from that same hydraulic surface;
    // otherwise the real bump height is added back here and becomes a single
    // water vertex that appears stuck above a lake whose level is falling.
    return this.getFlowTerrainHeight(index)
      + Math.max(MIN_VISUAL_WATER_DEPTH, this.depth[index])
      + renderOffset;
  }

  private getShoreSupportHeight(index: number): number {
    const terrainUnderlap = this.terrain.heights[index] - SHORE_UNDERLAP_DEPTH;
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    let adjacentWaterHeightSum = 0;
    let adjacentWaterWeightSum = 0;

    // Coverage softening can expose the dry vertex beside a wet cell. On an
    // uphill bank, burying it below only its own terrain still leaves it above
    // the water and makes the shared triangle climb the slope. Derive a local
    // water plane from all adjacent wet cells so diagonal/downhill streams keep
    // their width instead of collapsing toward the lowest neighbour.
    for (let dz = -1; dz <= 1; dz += 1) {
      const sampleZ = z + dz;
      if (sampleZ < 0 || sampleZ >= this.resolutionZ) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const sampleX = x + dx;
        if (sampleX < 0 || sampleX >= this.resolutionX) continue;
        const sample = sampleZ * this.resolution + sampleX;
        if (this.depth[sample] <= VISUAL_WET_EXIT_DEPTH) continue;
        const weight = dx === 0 || dz === 0 ? 1 : Math.SQRT1_2;
        adjacentWaterHeightSum += this.getUnclampedVisualWaterHeight(sample) * weight;
        adjacentWaterWeightSum += weight;
      }
    }

    if (adjacentWaterWeightSum === 0) return terrainUnderlap;

    const adjacentWaterFloor = adjacentWaterHeightSum / adjacentWaterWeightSum
      - SHORE_UNDERLAP_DEPTH;
    // A tiny clearance keeps sloping rivers and waterfall sheets wider than a
    // single grid line. The adjacent-water cap still wins on an uphill bank,
    // where the support remains inside terrain and cannot climb the slope.
    return Math.min(
      this.terrain.heights[index] + FLOWING_SHORE_GROUND_CLEARANCE,
      adjacentWaterFloor,
    );
  }

  private getTargetVisualSurfaceHeight(index: number): number {
    const waterSurfaceHeight = this.getUnclampedVisualWaterHeight(index);
    const wetPresence = THREE.MathUtils.smoothstep(
      this.depth[index],
      VISUAL_WET_EXIT_DEPTH,
      VISUAL_WET_ENTER_DEPTH,
    );
    return THREE.MathUtils.lerp(
      this.getShoreSupportHeight(index),
      waterSurfaceHeight,
      wetPresence,
    );
  }

  private updateVisualSurfaceState(deltaTime: number): void {
    const responseScale = deltaTime / REFERENCE_RENDER_DELTA;
    for (let i = 0; i < this.depth.length; i += 1) {
      const targetSurfaceHeight = this.getTargetVisualSurfaceHeight(i);
      if (this.visualSurfaceHeight[i] === 0 || this.depth[i] <= VISUAL_EDGE_DEPTH) {
        this.visualSurfaceHeight[i] = targetSurfaceHeight;
      } else {
        const lakeStability = THREE.MathUtils.clamp(this.lakeFactor[i], 0, 1);
        const referenceResponse = THREE.MathUtils.lerp(0.34, 0.055, lakeStability);
        const response = 1 - Math.pow(1 - referenceResponse, responseScale);
        this.visualSurfaceHeight[i] = THREE.MathUtils.lerp(
          this.visualSurfaceHeight[i],
          targetSurfaceHeight,
          response,
        );
      }
    }
  }

  private snapVisualSurfaceState(): void {
    this.physicsAccumulator = 0;
    for (let i = 0; i < this.depth.length; i += 1) {
      const targetSurfaceHeight = this.getTargetVisualSurfaceHeight(i);
      this.visualSurfaceHeight[i] = targetSurfaceHeight;
      this.previousVisualSurfaceHeight[i] = targetSurfaceHeight;
      this.renderSurfaceHeight[i] = targetSurfaceHeight;
    }
  }

  private updateGeometry(interpolationAlpha: number): void {
    for (let i = 0; i < this.depth.length; i += 1) {
      this.renderSurfaceHeight[i] = THREE.MathUtils.lerp(
        this.previousVisualSurfaceHeight[i],
        this.visualSurfaceHeight[i],
        interpolationAlpha,
      );
    }

    // The hidden legacy mesh is intentionally left untouched. It remains only
    // as a compatibility material/data carrier; the visible render system owns
    // all dynamic vertex uploads.
  }

  private uploadDynamicRenderFields(): void {
    this.renderSystem.updateDynamicFields(
      this.renderSurfaceHeight,
      this.depth,
      this.flowX,
      this.flowZ,
      this.flowSpeed,
      this.turbulence,
      this.lakeFactor,
    );
  }

  private captureTerrainStaticState(): void {
    for (let index = 0; index < this.previousRockMask.length; index += 1) {
      this.previousRockMask[index] = this.terrain.isRockIndex(index) ? 1 : 0;
    }
  }

  private refreshRenderImmediately(): void {
    this.snapVisualSurfaceState();
    this.updateVisualCoverage(PHYSICS_FIXED_DELTA, true);
    this.updateGeometry(1);
    this.rebuildRenderGeometry();
    this.renderTopologyDirty = false;
    this.renderRefreshElapsed = 0;
  }

  private recordPerformance(metric: keyof WaterPerformanceStats, sampleMs: number): void {
    const current = this.performanceStats[metric];
    this.performanceStats[metric] = current === 0
      ? sampleMs
      : THREE.MathUtils.lerp(current, sampleMs, 0.12);
  }

  private rebuildRenderGeometry(): void {
    this.renderSystem.rebuild(
      this.visualCoveragePixels,
      this.renderSurfaceHeight,
      this.depth,
      this.flowX,
      this.flowZ,
      this.flowSpeed,
      this.turbulence,
      this.foam,
      this.lakeFactor,
      this.waterfallEnergy,
      this.waterfallTarget,
    );
  }

  private createSourceMarker(): void {
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({
        color: "#b8efeb",
        emissive: "#3fc8ca",
        emissiveIntensity: 0.5,
        roughness: 0.24,
        metalness: 0.05,
      }),
    );
    core.name = "source-core";
    core.castShadow = true;
    this.marker.add(core);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.48, 0.54, 24),
      new THREE.MeshBasicMaterial({ color: "#8de1df", transparent: true, opacity: 0.48, side: THREE.DoubleSide }),
    );
    halo.name = "source-halo";
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.36;
    this.marker.add(halo);

    // Make the small crystal forgiving to click without changing its appearance.
    const hitTarget = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    hitTarget.name = "source-hit-target";
    this.marker.add(hitTarget);
    this.scene.add(this.marker);
  }
}
