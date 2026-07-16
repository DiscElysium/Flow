import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import { WaterRenderSystem } from "@/engine/water/WaterRenderSystem";

const MIN_VISIBLE_DEPTH = 0.003;
const VISUAL_EDGE_DEPTH = 0.0015;
// 视觉连续性使用比特效判定更低的水深门槛：极薄的真实水路仍要画出来。
const VISUAL_WET_ENTER_DEPTH = 0.00004;
const VISUAL_WET_EXIT_DEPTH = 0.000005;
const VISUAL_COVERAGE_FULL_DEPTH = VISUAL_WET_ENTER_DEPTH * 4.5;
const RESIDUAL_WATER_DEPTH = 0.00004;
const MIN_TRANSFER_DEPTH = 0.000001;
const COVERABLE_BUMP_HEIGHT = 1.25;
const GRAVITY_PRIORITY_START = 0.035;
const GRAVITY_PRIORITY_FULL = 0.48;
const FLOW_DROP_LOOKAHEAD_CELLS = 5;
const WATER_RENDER_OFFSET = 0.025;
const MIN_VISUAL_WATER_DEPTH = 0.012;

export class WaterSimulation {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly resolution = WORLD_CONFIG.segments + 1;
  private readonly depth = new Float32Array(this.resolution * this.resolution);
  private readonly delta = new Float32Array(this.depth.length);
  private readonly previousTerrain = new Float32Array(this.depth.length);
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
  private readonly lakeFactor = new Float32Array(this.depth.length);
  private readonly shoreFactor = new Float32Array(this.depth.length);
  /** 单帧交换累计量，用完后会写入上面的平滑状态场。 */
  private readonly flowAccumX = new Float32Array(this.depth.length);
  private readonly flowAccumZ = new Float32Array(this.depth.length);
  private readonly outflowAccum = new Float32Array(this.depth.length);
  private readonly incomingAccum = new Float32Array(this.depth.length);
  private readonly incomingX = new Float32Array(this.depth.length);
  private readonly incomingZ = new Float32Array(this.depth.length);
  private readonly dropAccum = new Float32Array(this.depth.length);
  private readonly waterfallEnergy = new Float32Array(this.depth.length);
  private readonly waterfallTarget = new Int32Array(this.depth.length);
  /** 仅供渲染的连续覆盖场，不参与水量交换或任何物理判定。 */
  private readonly visualCoverageRaw = new Float32Array(this.depth.length);
  private readonly visualCoverageBlur = new Float32Array(this.depth.length);
  private readonly visualCoveragePixels = new Uint8Array(this.depth.length);
  private readonly visualSurfaceHeight = new Float32Array(this.depth.length);
  /** 最终交给独立水网格的高度；岸边支撑点从邻近水面继承高度，不再沿山体爬升。 */
  private readonly renderSurfaceHeight = new Float32Array(this.depth.length);
  private readonly visualCoverageTexture: THREE.DataTexture;
  private readonly depthAttribute: THREE.BufferAttribute;
  private readonly flowAttribute: THREE.BufferAttribute;
  private readonly flowSpeedAttribute: THREE.BufferAttribute;
  private readonly turbulenceAttribute: THREE.BufferAttribute;
  private readonly foamAttribute: THREE.BufferAttribute;
  private readonly lakeAttribute: THREE.BufferAttribute;
  private readonly shoreAttribute: THREE.BufferAttribute;
  private readonly renderSystem: WaterRenderSystem;
  private readonly marker = new THREE.Group();
  private renderRefreshElapsed = 0;
  private sourceIndex = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
  ) {
    const geometry = this.createGeometry();
    this.depthAttribute = geometry.getAttribute("aDepth") as THREE.BufferAttribute;
    this.flowAttribute = geometry.getAttribute("aFlow") as THREE.BufferAttribute;
    this.flowSpeedAttribute = geometry.getAttribute("aFlowSpeed") as THREE.BufferAttribute;
    this.turbulenceAttribute = geometry.getAttribute("aTurbulence") as THREE.BufferAttribute;
    this.foamAttribute = geometry.getAttribute("aFoam") as THREE.BufferAttribute;
    this.lakeAttribute = geometry.getAttribute("aLake") as THREE.BufferAttribute;
    this.shoreAttribute = geometry.getAttribute("aShore") as THREE.BufferAttribute;
    this.waterfallTarget.fill(-1);
    this.visualCoverageTexture = new THREE.DataTexture(
      this.visualCoveragePixels,
      this.resolution,
      this.resolution,
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
        uWorldSize: { value: WORLD_CONFIG.size },
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
        uniform vec3 deepColor;
        uniform float uShallowDepth;
        uniform float uDeepDepth;
        uniform float uWorldSize;
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

    this.previousTerrain.set(this.terrain.heights);
    this.createSourceMarker();
    this.setSource(this.terrain.sourceIndex);
    this.updateGeometry();
    this.rebuildRenderGeometry();
  }

  step(deltaTime: number, flowRate: number, flowDelay: number): void {
    const safeDelta = Math.min(deltaTime, 0.045);
    const subDelta = safeDelta / WORLD_CONFIG.water.substeps;
    const safeFlowDelay = THREE.MathUtils.clamp(flowDelay, 0.02, 0.5);
    this.resetFrameAccumulators();

    // ── 指数衰减 recentInflow，解锁随时间的旧流入水量 ──
    // 每经过一个停留时间，约 63% 的锁定水被解锁。
    const decay = Math.exp(-safeDelta / safeFlowDelay);
    for (let i = 0; i < this.recentInflow.length; i += 1) {
      this.recentInflow[i] *= decay;
    }

    for (let pass = 0; pass < WORLD_CONFIG.water.substeps; pass += 1) {
      // 源头注入
      const sourceAdded = WORLD_CONFIG.water.sourceRate * flowRate * subDelta;
      this.depth[this.sourceIndex] += sourceAdded;
      // 源头的水是"新"的 → 加入 recentInflow
      this.recentInflow[this.sourceIndex] += sourceAdded;

      this.delta.fill(0);
      for (let z = 0; z < this.resolution; z += 1) {
        for (let x = 0; x < this.resolution; x += 1) {
          const index = z * this.resolution + x;
          if (x < this.resolution - 1) this.exchange(index, index + 1);
          if (z < this.resolution - 1) this.exchange(index, index + this.resolution);
        }
      }
      for (let i = 0; i < this.depth.length; i += 1) {
        const edge = i < this.resolution || i >= this.depth.length - this.resolution || i % this.resolution === 0 || i % this.resolution === this.resolution - 1;
        const drainage = edge && this.terrain.heights[i] < 0.35 ? 0.992 : 1;
        this.depth[i] = Math.max(
          0,
          (this.depth[i] + this.delta[i] - WORLD_CONFIG.water.evaporation * subDelta) * drainage,
        );
        // 数值求解留下的微量薄膜已经没有可感知体积，继续保留只会让山坡看起来像粘着一层水。
        if (this.depth[i] < RESIDUAL_WATER_DEPTH) {
          this.depth[i] = 0;
          this.recentInflow[i] = 0;
        }
        // recentInflow 不能超过实际水量（蒸发可能让实际水量比锁定量更少）
        if (this.recentInflow[i] > this.depth[i]) this.recentInflow[i] = this.depth[i];
      }
    }
    this.updateFlowState(safeDelta);
    this.updateGeometry();
    // Match main's smoothness: visible water heights follow every simulation
    // frame. Only the more expensive shoreline topology remains rate-limited.
    this.renderSystem.updateDynamicFields(
      this.renderSurfaceHeight,
      this.depth,
      this.flowX,
      this.flowZ,
      this.flowSpeed,
      this.turbulence,
      this.lakeFactor,
    );
    this.renderRefreshElapsed += safeDelta;
    if (this.renderRefreshElapsed >= 0.05) {
      this.renderRefreshElapsed %= 0.05;
      this.rebuildRenderGeometry();
    }
  }

  /** 暴露 ShaderMaterial 以便外部实时调参与调试 */
  get waterMaterial(): THREE.ShaderMaterial {
    return this.mesh.material as THREE.ShaderMaterial;
  }

  getDepthSnapshot(): number[] {
    return Array.from(this.depth);
  }

  restoreDepthSnapshot(values: number[]): void {
    this.depth.fill(0);
    this.depth.set(values.slice(0, this.depth.length));
    this.recentInflow.fill(0);
    this.previousTerrain.set(this.terrain.heights);
    this.resetDynamicState();
    this.setSource(this.terrain.sourceIndex);
    this.updateGeometry();
    this.rebuildRenderGeometry();
  }

  clear(): void {
    this.depth.fill(0);
    this.recentInflow.fill(0);
    this.visualCoverageRaw.fill(0);
    this.visualCoverageBlur.fill(0);
    this.visualCoveragePixels.fill(0);
    this.resetDynamicState();
    this.updateGeometry();
    this.rebuildRenderGeometry();
  }

  syncTerrain(preserveSurface = true): void {
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
    this.previousTerrain.set(this.terrain.heights);
    this.updateGeometry();
    this.rebuildRenderGeometry();
    this.setSource(this.terrain.sourceIndex);
  }

  setSource(index: number): void {
    this.sourceIndex = index;
    const position = this.terrain.indexToWorld(index);
    this.marker.position.set(position.x, position.y + 0.62, position.z);
  }

  updateMarker(time: number, active: boolean): void {
    this.renderSystem.update(time);
    const pulse = 1 + Math.sin(time * 0.004) * 0.1;
    this.marker.scale.setScalar(active ? pulse : 0.88);
    this.marker.rotation.y = time * 0.00035;
    const core = this.marker.getObjectByName("source-core") as THREE.Mesh | undefined;
    if (core && core.material instanceof THREE.MeshStandardMaterial) {
      core.material.emissiveIntensity = active ? 1.25 + Math.sin(time * 0.006) * 0.25 : 0.32;
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
  private exchange(a: number, b: number): void {
    const surfaceA = this.getFlowSurface(a);
    const surfaceB = this.getFlowSurface(b);
    const difference = surfaceA - surfaceB;
    if (Math.abs(difference) < 0.0003) return;

    if (difference > 0 && this.depth[a] > MIN_TRANSFER_DEPTH) {
      // 只有"旧水"可以流出
      const locked = Math.min(this.recentInflow[a], this.depth[a]);
      // 与 main 一致：即使落差很大，新到的水也必须在当前格完成
      // 停留时间。这样从高处到低处会留下连续水链，而不是越级抽空中间格。
      const available = this.depth[a] - locked;
      if (available < MIN_TRANSFER_DEPTH) return;
      const gravityPriority = this.getGravityPriority(a, b);
      const amount = Math.min(available * 0.18, difference * WORLD_CONFIG.water.flow) * gravityPriority;
      if (amount < MIN_TRANSFER_DEPTH) return;
      this.recordTransfer(a, b, amount, difference);
      this.depositTransfer(a, b, amount);
    } else if (difference < 0 && this.depth[b] > MIN_TRANSFER_DEPTH) {
      const locked = Math.min(this.recentInflow[b], this.depth[b]);
      const available = this.depth[b] - locked;
      if (available < MIN_TRANSFER_DEPTH) return;
      const gravityPriority = this.getGravityPriority(b, a);
      const amount = Math.min(available * 0.18, -difference * WORLD_CONFIG.water.flow) * gravityPriority;
      if (amount < MIN_TRANSFER_DEPTH) return;
      this.recordTransfer(b, a, amount, -difference);
      this.depositTransfer(b, a, amount);
    }
  }

  private getGravityPriority(from: number, to: number): number {
    const x = from % this.resolution;
    const z = Math.floor(from / this.resolution);
    const fromSurface = this.getFlowSurface(from);
    let steepestTarget = -1;
    let steepestDrop = 0;
    const consider = (neighbor: number): void => {
      const neighborSurface = this.getFlowSurface(neighbor);
      const drop = fromSurface - neighborSurface;
      if (drop > steepestDrop) {
        steepestDrop = drop;
        steepestTarget = neighbor;
      }
    };
    if (x > 0) consider(from - 1);
    if (x < this.resolution - 1) consider(from + 1);
    if (z > 0) consider(from - this.resolution);
    if (z < this.resolution - 1) consider(from + this.resolution);

    const gravityStrength = THREE.MathUtils.smoothstep(
      steepestDrop,
      GRAVITY_PRIORITY_START,
      GRAVITY_PRIORITY_FULL,
    );
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

  private getFlowSurface(index: number): number {
    return this.getFlowTerrainHeight(index) + this.depth[index];
  }

  private getFlowTerrainHeight(index: number): number {
    const height = this.terrain.heights[index];
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    const bridgeHeights: number[] = [];
    const considerOppositePair = (first: number, second: number): void => {
      const bridgeHeight = Math.max(this.terrain.heights[first], this.terrain.heights[second]);
      const prominence = height - bridgeHeight;
      if (prominence > 0.002 && prominence <= COVERABLE_BUMP_HEIGHT) bridgeHeights.push(bridgeHeight);
    };

    // A monotonic hillside has a higher sample on one side and is preserved.
    // A small spike or one-cell ridge has lower terrain on both opposite sides
    // and is treated as sub-grid roughness, including diagonal ridges.
    if (x > 0 && x < this.resolution - 1) considerOppositePair(index - 1, index + 1);
    if (z > 0 && z < this.resolution - 1) considerOppositePair(index - this.resolution, index + this.resolution);
    if (x > 0 && x < this.resolution - 1 && z > 0 && z < this.resolution - 1) {
      considerOppositePair(index - this.resolution - 1, index + this.resolution + 1);
      considerOppositePair(index - this.resolution + 1, index + this.resolution - 1);
    }
    if (bridgeHeights.length === 0) return height;

    // Use the most conservative valid bridge so terrain remains dominant.
    const hydraulicBridge = Math.max(...bridgeHeights);
    return THREE.MathUtils.lerp(height, hydraulicBridge, 0.94);
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
    const foamDecay = Math.exp(-deltaTime * 2.2);
    // Waterfall classification is deliberately disabled. These output fields
    // remain empty so the renderer cannot create waterfall-only effects.
    this.waterfallEnergy.fill(0);
    this.waterfallTarget.fill(-1);

    for (let index = 0; index < this.depth.length; index += 1) {
      const wet = this.depth[index] > MIN_VISIBLE_DEPTH;
      const effectWet = this.depth[index] > VISUAL_WET_EXIT_DEPTH;
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
      this.shoreFactor[index] = THREE.MathUtils.lerp(this.shoreFactor[index], shore, directionResponse);
      const rawTurbulence = effectWet
        ? THREE.MathUtils.clamp(
          rawDropEnergy * 0.66
            + directionalDropSpeed * 0.52
            + convergence * 0.9
            + rawSpeed * shore * 0.28,
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

      const depthProgress = THREE.MathUtils.clamp((this.depth[index] - 0.08) / 1.25, 0, 1);
      const smoothDepth = depthProgress * depthProgress * (3 - 2 * depthProgress);
      const calmness = smoothDepth * (1 - this.flowSpeed[index]) ** 2 * (1 - this.turbulence[index]);
      this.lakeFactor[index] = THREE.MathUtils.lerp(this.lakeFactor[index], calmness, energyResponse);

    }
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
      if (targetX < 0 || targetX >= this.resolution || targetZ < 0 || targetZ >= this.resolution) break;
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
      if (sampleX < 0 || sampleX >= this.resolution || sampleZ < 0 || sampleZ >= this.resolution) continue;
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
    if (x < this.resolution - 1 && this.depth[index + 1] <= MIN_VISIBLE_DEPTH) return true;
    if (z > 0 && this.depth[index - this.resolution] <= MIN_VISIBLE_DEPTH) return true;
    if (z < this.resolution - 1 && this.depth[index + this.resolution] <= MIN_VISIBLE_DEPTH) return true;
    return false;
  }

  private resetDynamicState(): void {
    this.flowX.fill(0);
    this.flowZ.fill(0);
    this.flowSpeed.fill(0);
    this.dropEnergy.fill(0);
    this.turbulence.fill(0);
    this.foam.fill(0);
    this.lakeFactor.fill(0);
    this.shoreFactor.fill(0);
    this.waterfallEnergy.fill(0);
    this.waterfallTarget.fill(-1);
    this.resetFrameAccumulators();
  }

  private createGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array(this.depth.length * 3);
    const depthValues = new Float32Array(this.depth.length);
    const indices: number[] = [];
    const half = WORLD_CONFIG.size / 2;

    for (let z = 0; z < this.resolution; z += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = z * this.resolution + x;
        positions[index * 3] = x * this.terrain.cellSize - half;
        positions[index * 3 + 1] = this.terrain.heights[index] - 0.06;
        positions[index * 3 + 2] = z * this.terrain.cellSize - half;
      }
    }
    for (let z = 0; z < WORLD_CONFIG.segments; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segments; x += 1) {
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

  private updateVisualCoverage(): void {
    // Unlike the old binary wet/dry mask, coverage now approaches a continuous
    // depth target every frame. The persistent surface shader samples this
    // field bilinearly, so a front advances inside a cell instead of appearing
    // as one newly-created triangle every 0.05 seconds.
    for (let index = 0; index < this.depth.length; index += 1) {
      const targetCoverage = this.depth[index] <= VISUAL_WET_EXIT_DEPTH
        ? 0
        : THREE.MathUtils.smoothstep(
          this.depth[index],
          VISUAL_WET_EXIT_DEPTH,
          VISUAL_COVERAGE_FULL_DEPTH,
        );
      const response = targetCoverage > this.visualCoverageRaw[index] ? 0.2 : 0.08;
      this.visualCoverageRaw[index] = THREE.MathUtils.lerp(
        this.visualCoverageRaw[index],
        targetCoverage,
        response,
      );
      if (targetCoverage === 0 && this.visualCoverageRaw[index] < 0.001) this.visualCoverageRaw[index] = 0;
    }

    for (let z = 0; z < this.resolution; z += 1) {
      const row = z * this.resolution;
      for (let x = 0; x < this.resolution; x += 1) {
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

    for (let z = 0; z < this.resolution; z += 1) {
      const previousRow = Math.max(0, z - 1) * this.resolution;
      const row = z * this.resolution;
      const nextRow = Math.min(this.resolution - 1, z + 1) * this.resolution;
      for (let x = 0; x < this.resolution; x += 1) {
        const index = row + x;
        const blurred = (
          this.visualCoverageBlur[previousRow + x]
          + this.visualCoverageBlur[index] * 2
          + this.visualCoverageBlur[nextRow + x]
        ) * 0.25;
        const leftX = Math.max(0, x - 1);
        const rightX = Math.min(this.resolution - 1, x + 1);
        const leftWet = this.visualCoverageRaw[row + leftX] > 0.5;
        const rightWet = this.visualCoverageRaw[row + rightX] > 0.5;
        const backWet = this.visualCoverageRaw[previousRow + x] > 0.5;
        const frontWet = this.visualCoverageRaw[nextRow + x] > 0.5;
        const backLeftWet = this.visualCoverageRaw[previousRow + leftX] > 0.5;
        const backRightWet = this.visualCoverageRaw[previousRow + rightX] > 0.5;
        const frontLeftWet = this.visualCoverageRaw[nextRow + leftX] > 0.5;
        const frontRightWet = this.visualCoverageRaw[nextRow + rightX] > 0.5;
        const leftTwoWet = x >= 2 && this.visualCoverageRaw[row + x - 2] > 0.5;
        const rightTwoWet = x + 2 < this.resolution && this.visualCoverageRaw[row + x + 2] > 0.5;
        const backTwoWet = z >= 2 && this.visualCoverageRaw[(z - 2) * this.resolution + x] > 0.5;
        const frontTwoWet = z + 2 < this.resolution && this.visualCoverageRaw[(z + 2) * this.resolution + x] > 0.5;
        // 补连接在真实湿区之间的一至两格细缝，不向孤立岸边无条件扩张。
        const bridgesWetSegments = (leftWet && rightWet)
          || (backWet && frontWet)
          || (backLeftWet && frontRightWet)
          || (backRightWet && frontLeftWet)
          || (leftWet && rightTwoWet)
          || (rightWet && leftTwoWet)
          || (backWet && frontTwoWet)
          || (frontWet && backTwoWet);
        const connectionBridge = bridgesWetSegments ? 0.82 : 0;
        // 保住很窄的单格水流，同时用邻域值把尖锐的三角形边缘圆钝化。
        const coverage = Math.max(this.visualCoverageRaw[index] * 0.88, blurred, connectionBridge);
        this.visualCoveragePixels[index] = Math.round(THREE.MathUtils.clamp(coverage, 0, 1) * 255);
      }
    }
    this.visualCoverageTexture.needsUpdate = true;
  }

  private updateGeometry(): void {
    this.updateVisualCoverage();
    const position = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;

    for (let i = 0; i < this.depth.length; i += 1) {
      const targetSurfaceHeight = this.terrain.heights[i]
        + Math.max(MIN_VISUAL_WATER_DEPTH, this.depth[i])
        + WATER_RENDER_OFFSET;
      if (this.visualSurfaceHeight[i] === 0 || this.depth[i] <= VISUAL_EDGE_DEPTH) {
        this.visualSurfaceHeight[i] = targetSurfaceHeight;
      } else {
        // 湖泊水位使用更强的视觉平滑，避免物理格点的微量交换被放大成颤抖。
        const lakeStability = THREE.MathUtils.clamp(this.lakeFactor[i], 0, 1);
        const response = THREE.MathUtils.lerp(0.34, 0.055, lakeStability);
        this.visualSurfaceHeight[i] = THREE.MathUtils.lerp(this.visualSurfaceHeight[i], targetSurfaceHeight, response);
      }
    }

    this.renderSurfaceHeight.set(this.visualSurfaceHeight);
    for (let z = 0; z < this.resolution; z += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const index = z * this.resolution + x;
        const isTrueWaterSample = this.visualCoverageRaw[index] > 0.5
          && this.depth[index] > VISUAL_WET_EXIT_DEPTH;
        if (this.visualCoveragePixels[index] <= 8 || isTrueWaterSample) continue;

        let heightSum = 0;
        let weightSum = 0;
        // 模糊遮罩扩出的岸边顶点不是水量格，只负责给水面切边；其高度应来自水，而不是山坡。
        for (let radius = 1; radius <= 2 && weightSum === 0; radius += 1) {
          for (let dz = -radius; dz <= radius; dz += 1) {
            const neighborZ = z + dz;
            if (neighborZ < 0 || neighborZ >= this.resolution) continue;
            for (let dx = -radius; dx <= radius; dx += 1) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
              const neighborX = x + dx;
              if (neighborX < 0 || neighborX >= this.resolution) continue;
              const neighbor = neighborZ * this.resolution + neighborX;
              if (this.depth[neighbor] <= VISUAL_WET_EXIT_DEPTH) continue;
              const distance = Math.hypot(dx, dz);
              const weight = 1 / Math.max(distance, 1);
              heightSum += this.visualSurfaceHeight[neighbor] * weight;
              weightSum += weight;
            }
          }
        }
        if (weightSum > 0) this.renderSurfaceHeight[index] = heightSum / weightSum;
      }
    }

    for (let i = 0; i < this.depth.length; i += 1) {
      position.setY(i, this.renderSurfaceHeight[i]);
      this.depthAttribute.setX(i, this.depth[i]);
      this.flowAttribute.setXY(i, this.flowX[i], this.flowZ[i]);
      this.flowSpeedAttribute.setX(i, this.flowSpeed[i]);
      this.turbulenceAttribute.setX(i, this.turbulence[i]);
      this.foamAttribute.setX(i, this.foam[i]);
      this.lakeAttribute.setX(i, this.lakeFactor[i]);
      this.shoreAttribute.setX(i, this.shoreFactor[i]);
    }
    position.needsUpdate = true;
    this.depthAttribute.needsUpdate = true;
    this.flowAttribute.needsUpdate = true;
    this.flowSpeedAttribute.needsUpdate = true;
    this.turbulenceAttribute.needsUpdate = true;
    this.foamAttribute.needsUpdate = true;
    this.lakeAttribute.needsUpdate = true;
    this.shoreAttribute.needsUpdate = true;
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
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.36;
    this.marker.add(halo);
    this.scene.add(this.marker);
  }
}
