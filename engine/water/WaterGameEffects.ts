import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

export type WaterEffectFields = {
  coverage: Uint8Array;
  surfaceHeights: Float32Array;
  depth: Float32Array;
  flowX: Float32Array;
  flowZ: Float32Array;
  flowSpeed: Float32Array;
  turbulence: Float32Array;
  foam: Float32Array;
  lakeFactor: Float32Array;
  waterfallEnergy: Float32Array;
  waterfallTarget: Int32Array;
};

type CrestBuffers = {
  positions: number[];
  phases: number[];
  alongs: number[];
  flows: number[];
  speeds: number[];
  centers: number[];
  strengths: number[];
  indices: number[];
};

type SheetBuffers = {
  positions: number[];
  uvs: number[];
  energies: number[];
  speeds: number[];
  phases: number[];
  widths: number[];
  depths: number[];
  indices: number[];
};

type Impact = {
  center: THREE.Vector3;
  energy: number;
  speed: number;
  seed: number;
};

type RiverAnchor = {
  directionX: number;
  directionZ: number;
  speed: number;
  lateralOffset: number;
  unstableFrames: number;
};

type TurbulenceAnchor = RiverAnchor & {
  strength: number;
};

type FoamAnchor = {
  center: THREE.Vector3;
  strength: number;
  flowX: number;
  flowZ: number;
  unstableFrames: number;
};

const MAX_RIVER_CRESTS = 240;
const MAX_TURBULENCE_CRESTS = 180;
const MAX_LAKE_CRESTS = 80;
const MAX_WATERFALLS = 6;
const MAX_BUBBLES = 480;
const MAX_FOAM_ANCHORS = 64;
const WATERFALL_MIN_TOTAL_DROP = 3.6;
const WATERFALL_MIN_AVERAGE_SLOPE = 1.15;
const WATERFALL_SEARCH_CELLS = 6;

/** Converts stable simulation fields into the approved low-poly water effects. */
export class WaterGameEffects {
  private readonly group = new THREE.Group();
  private readonly timeUniform = { value: 0 };
  private readonly riverMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.createCrestMaterial("#eef7f2", false, false, 0.76));
  private readonly turbulenceMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    this.createCrestMaterial("#dceee9", false, false, 0.58, true),
  );
  private readonly lakeMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.createCrestMaterial("#c7e6df", true, true, 0.5));
  private readonly impactWaveMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.createCrestMaterial("#eef7f3", true, false, 0.58));
  private readonly waterfallMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.createWaterfallMaterial());
  private readonly bubbleGeometry = new THREE.IcosahedronGeometry(1, 0);
  private readonly bubbleMaterial = new THREE.MeshBasicMaterial({
    color: "#e5f3ef",
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
  private readonly bubbles = new THREE.InstancedMesh(this.bubbleGeometry, this.bubbleMaterial, MAX_BUBBLES);
  private readonly impacts: Impact[] = [];
  private readonly riverAnchors = new Map<number, RiverAnchor>();
  private readonly turbulenceAnchors = new Map<number, TurbulenceAnchor>();
  private readonly foamAnchors = new Map<number, FoamAnchor>();
  private readonly lakeAnchors = new Set<number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly color = new THREE.Color();

  constructor(private readonly scene: THREE.Scene, private readonly terrain: TerrainSystem) {
    this.group.name = "dynamic-water-effects";
    this.riverMesh.name = "river-curve-crests";
    this.turbulenceMesh.name = "turbulence-broken-crests";
    this.lakeMesh.name = "lake-local-wavelets";
    this.impactWaveMesh.name = "waterfall-impact-waves";
    this.waterfallMesh.name = "projected-waterfall-sheets";
    this.riverMesh.renderOrder = 6;
    this.turbulenceMesh.renderOrder = 8;
    this.lakeMesh.renderOrder = 7;
    this.waterfallMesh.renderOrder = 7;
    this.impactWaveMesh.renderOrder = 9;
    this.bubbles.renderOrder = 10;
    // 实例位置会随真实瀑布落点持续变化，不能使用初始单位几何的包围球裁剪。
    this.bubbles.frustumCulled = false;
    this.bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bubbles.count = 0;
    this.group.add(
      this.riverMesh,
      this.turbulenceMesh,
      this.lakeMesh,
      this.waterfallMesh,
      this.impactWaveMesh,
      this.bubbles,
    );
    this.scene.add(this.group);
  }

  update(time: number): void {
    const seconds = time * 0.001;
    this.timeUniform.value = seconds;
    this.updateBubbles(seconds);
  }

  rebuild(fields: WaterEffectFields): void {
    const river = this.createCrestBuffers();
    const turbulence = this.createCrestBuffers();
    const lake = this.createCrestBuffers();
    const impactWaves = this.createCrestBuffers();
    const sheets = this.createSheetBuffers();
    this.impacts.length = 0;

    this.buildRiverCrests(fields, river);
    this.buildTurbulenceCrests(fields, turbulence);
    this.buildLakeWavelets(fields, lake);
    this.buildFoamAnchors(fields);

    this.replaceCrestGeometry(this.riverMesh, river);
    this.replaceCrestGeometry(this.turbulenceMesh, turbulence);
    this.replaceCrestGeometry(this.lakeMesh, lake);
    this.replaceCrestGeometry(this.impactWaveMesh, impactWaves);
    this.replaceSheetGeometry(sheets);
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const mesh of [this.riverMesh, this.turbulenceMesh, this.lakeMesh, this.impactWaveMesh, this.waterfallMesh]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.bubbleGeometry.dispose();
    this.bubbleMaterial.dispose();
  }

  private buildRiverCrests(fields: WaterEffectFields, buffers: CrestBuffers): void {
    const resolution = this.terrain.resolution;

    // Existing crests use relaxed exit thresholds and must remain unstable for
    // several rebuilds before removal. This prevents the 20 Hz effect rebuild
    // from toggling whole ribbons when speed or coverage hovers near a cutoff.
    for (const [index, anchor] of this.riverAnchors) {
      const directionLength = Math.hypot(fields.flowX[index], fields.flowZ[index]);
      const fullyDry = fields.coverage[index] < 5 || fields.depth[index] < 0.00004;
      if (fullyDry) {
        this.riverAnchors.delete(index);
        continue;
      }

      const stable = fields.coverage[index] >= 95
        && fields.flowSpeed[index] >= 0.04
        && fields.lakeFactor[index] <= 0.72
        && directionLength >= 0.04;
      if (!stable) {
        anchor.unstableFrames += 1;
        if (anchor.unstableFrames >= 10) this.riverAnchors.delete(index);
        continue;
      }

      anchor.unstableFrames = 0;
      const targetX = fields.flowX[index] / directionLength;
      const targetZ = fields.flowZ[index] / directionLength;
      anchor.directionX = THREE.MathUtils.lerp(anchor.directionX, targetX, 0.18);
      anchor.directionZ = THREE.MathUtils.lerp(anchor.directionZ, targetZ, 0.18);
      const smoothedDirectionLength = Math.hypot(anchor.directionX, anchor.directionZ);
      if (smoothedDirectionLength > 0.0001) {
        anchor.directionX /= smoothedDirectionLength;
        anchor.directionZ /= smoothedDirectionLength;
      }
      anchor.speed = THREE.MathUtils.lerp(anchor.speed, fields.flowSpeed[index], 0.18);
    }

    // New crests still need to pass the stricter visual checks. Once admitted,
    // their anchor keeps identity, phase and lateral placement stable.
    for (let z = 1; z < resolution - 1 && this.riverAnchors.size < MAX_RIVER_CRESTS; z += 1) {
      for (let x = 1; x < resolution - 1 && this.riverAnchors.size < MAX_RIVER_CRESTS; x += 1) {
        const index = z * resolution + x;
        if (this.riverAnchors.has(index)) continue;
        const speed = fields.flowSpeed[index];
        if (fields.coverage[index] < 150 || speed < 0.1 || fields.lakeFactor[index] > 0.58) continue;
        const chance = 0.038 + speed * 0.085;
        if (this.hash(x, z, 3) > chance) continue;
        const directionLength = Math.hypot(fields.flowX[index], fields.flowZ[index]);
        if (directionLength < 0.08) continue;

        const direction = new THREE.Vector2(fields.flowX[index] / directionLength, fields.flowZ[index] / directionLength);
        const sideX = Math.round(-direction.y);
        const sideZ = Math.round(direction.x);
        const leftIndex = (z + sideZ) * resolution + x + sideX;
        const rightIndex = (z - sideZ) * resolution + x - sideX;
        const bothSidesWet = fields.coverage[leftIndex] >= 110 && fields.coverage[rightIndex] >= 110;
        const narrowChannel = fields.coverage[index] >= 190
          && (fields.coverage[leftIndex] >= 85 || fields.coverage[rightIndex] >= 85);
        // 宽河继续限制在中央；窄河允许单侧有水，但会收紧横向偏移，避免线条跑到岸上。
        if (!bothSidesWet && !narrowChannel) continue;

        const length = THREE.MathUtils.lerp(0.52, 1.08, speed) * THREE.MathUtils.lerp(0.86, 1.1, this.hash(x, z, 7));
        const endpointCells = Math.max(1, Math.ceil(length * 0.5 / this.terrain.cellSize));
        const startX = THREE.MathUtils.clamp(Math.round(x - direction.x * endpointCells), 1, resolution - 2);
        const startZ = THREE.MathUtils.clamp(Math.round(z - direction.y * endpointCells), 1, resolution - 2);
        const endX = THREE.MathUtils.clamp(Math.round(x + direction.x * endpointCells), 1, resolution - 2);
        const endZ = THREE.MathUtils.clamp(Math.round(z + direction.y * endpointCells), 1, resolution - 2);
        if (fields.coverage[startZ * resolution + startX] < 100 || fields.coverage[endZ * resolution + endX] < 100) continue;
        const lateralScale = bothSidesWet ? 0.38 : 0.14;
        const lateral = (this.hash(x, z, 13) - 0.5) * this.terrain.cellSize * lateralScale;
        this.riverAnchors.set(index, {
          directionX: direction.x,
          directionZ: direction.y,
          speed,
          lateralOffset: lateral,
          unstableFrames: 0,
        });
      }
    }

    let count = 0;
    for (const [index, anchor] of this.riverAnchors) {
      if (count >= MAX_RIVER_CRESTS) break;
      const x = index % resolution;
      const z = Math.floor(index / resolution);
      const direction = new THREE.Vector2(anchor.directionX, anchor.directionZ);
      const side = new THREE.Vector2(-direction.y, direction.x);
      const center = this.gridPosition(x, z, fields.surfaceHeights[index] + 0.008);
      center.x += side.x * anchor.lateralOffset;
      center.z += side.y * anchor.lateralOffset;
      const length = THREE.MathUtils.lerp(0.52, 1.08, anchor.speed) * THREE.MathUtils.lerp(0.86, 1.1, this.hash(x, z, 7));
      const width = THREE.MathUtils.lerp(0.025, 0.07, this.hash(x, z, 11));
      this.appendCurveRibbon(
        buffers,
        center,
        direction,
        length,
        width,
        this.hash(x, z, 17),
        fields,
        8,
        anchor.speed,
        1,
      );
      count += 1;
    }
  }

  private buildTurbulenceCrests(fields: WaterEffectFields, buffers: CrestBuffers): void {
    const resolution = this.terrain.resolution;

    // Keep the same deterministic anchor while a turbulent patch fluctuates.
    // Only its direction/strength ease toward the latest simulation field.
    for (const [index, anchor] of this.turbulenceAnchors) {
      if (fields.coverage[index] < 5 || fields.depth[index] < 0.000005) {
        this.turbulenceAnchors.delete(index);
        continue;
      }
      const stillWet = fields.coverage[index] >= 75 && fields.depth[index] > 0.00004;
      if (!stillWet || fields.turbulence[index] < 0.07) {
        anchor.unstableFrames += 1;
        if (anchor.unstableFrames >= 12) this.turbulenceAnchors.delete(index);
        continue;
      }

      anchor.unstableFrames = 0;
      const direction = this.resolveEffectDirection(
        index,
        fields,
        new THREE.Vector2(anchor.directionX, anchor.directionZ),
      );
      anchor.directionX = THREE.MathUtils.lerp(anchor.directionX, direction.x, 0.22);
      anchor.directionZ = THREE.MathUtils.lerp(anchor.directionZ, direction.y, 0.22);
      const length = Math.hypot(anchor.directionX, anchor.directionZ);
      if (length > 0.0001) {
        anchor.directionX /= length;
        anchor.directionZ /= length;
      }
      const targetStrength = THREE.MathUtils.smoothstep(fields.turbulence[index], 0.08, 0.78);
      anchor.strength = THREE.MathUtils.lerp(anchor.strength, targetStrength, 0.2);
      const targetSpeed = THREE.MathUtils.clamp(
        Math.max(fields.flowSpeed[index], 0.14 + targetStrength * 0.5),
        0,
        1,
      );
      anchor.speed = THREE.MathUtils.lerp(anchor.speed, targetSpeed, 0.2);
    }

    const candidates: number[] = [];
    for (let z = 1; z < resolution - 1; z += 1) {
      for (let x = 1; x < resolution - 1; x += 1) {
        const index = z * resolution + x;
        if (this.turbulenceAnchors.has(index)) continue;
        const rawStrength = fields.turbulence[index];
        if (rawStrength < 0.18
          || fields.coverage[index] < 150
          || fields.depth[index] < 0.00004
          || fields.lakeFactor[index] > 0.78
          || this.countWetNeighbours(index, fields, 105) < 2) continue;
        const strength = THREE.MathUtils.smoothstep(rawStrength, 0.1, 0.82);
        if (this.hash(x, z, 89) > 0.02 + strength * 0.065) continue;
        candidates.push(index);
      }
    }
    candidates.sort((a, b) => fields.turbulence[b] - fields.turbulence[a]);

    for (const index of candidates) {
      if (this.turbulenceAnchors.size >= MAX_TURBULENCE_CRESTS) break;
      const x = index % resolution;
      const z = Math.floor(index / resolution);
      const strength = THREE.MathUtils.smoothstep(fields.turbulence[index], 0.1, 0.82);
      const direction = this.resolveEffectDirection(index, fields);
      this.turbulenceAnchors.set(index, {
        directionX: direction.x,
        directionZ: direction.y,
        speed: THREE.MathUtils.clamp(Math.max(fields.flowSpeed[index], 0.14 + strength * 0.5), 0, 1),
        strength,
        lateralOffset: (this.hash(x, z, 97) - 0.5) * this.terrain.cellSize * 0.3,
        unstableFrames: 0,
      });
    }

    let count = 0;
    for (const [index, anchor] of this.turbulenceAnchors) {
      if (count >= MAX_TURBULENCE_CRESTS) break;
      const x = index % resolution;
      const z = Math.floor(index / resolution);
      const direction = new THREE.Vector2(anchor.directionX, anchor.directionZ);
      const side = new THREE.Vector2(-direction.y, direction.x);
      const center = this.gridPosition(x, z, fields.surfaceHeights[index] + 0.034);
      center.x += side.x * anchor.lateralOffset;
      center.z += side.y * anchor.lateralOffset;
      const length = THREE.MathUtils.lerp(0.24, 0.54, anchor.strength)
        * THREE.MathUtils.lerp(0.84, 1.14, this.hash(x, z, 101));
      const width = THREE.MathUtils.lerp(0.016, 0.038, this.hash(x, z, 103))
        * THREE.MathUtils.lerp(0.78, 1, anchor.strength);
      this.appendCurveRibbon(
        buffers,
        center,
        direction,
        length,
        width,
        this.hash(x, z, 107),
        fields,
        5,
        anchor.speed,
        anchor.strength,
        0.034,
      );
      count += 1;
    }
  }

  private buildFoamAnchors(fields: WaterEffectFields): void {
    const resolution = this.terrain.resolution;

    for (const [index, anchor] of this.foamAnchors) {
      if (fields.coverage[index] < 5 || fields.depth[index] < 0.000005) {
        this.foamAnchors.delete(index);
        continue;
      }
      const remains = fields.coverage[index] >= 70
        && fields.depth[index] > 0.00004
        && fields.foam[index] > 0.018;
      if (!remains) {
        anchor.unstableFrames += 1;
        anchor.strength = THREE.MathUtils.lerp(anchor.strength, 0, 0.14);
        if (anchor.unstableFrames >= 12) this.foamAnchors.delete(index);
        continue;
      }

      anchor.unstableFrames = 0;
      const targetStrength = THREE.MathUtils.smoothstep(fields.foam[index], 0.035, 0.28);
      anchor.strength = THREE.MathUtils.lerp(anchor.strength, targetStrength, 0.24);
      anchor.center.y = THREE.MathUtils.lerp(anchor.center.y, fields.surfaceHeights[index] + 0.034, 0.34);
      const direction = this.resolveEffectDirection(
        index,
        fields,
        new THREE.Vector2(anchor.flowX, anchor.flowZ),
      );
      anchor.flowX = THREE.MathUtils.lerp(anchor.flowX, direction.x, 0.18);
      anchor.flowZ = THREE.MathUtils.lerp(anchor.flowZ, direction.y, 0.18);
    }

    const candidates: number[] = [];
    for (let z = 1; z < resolution - 1; z += 1) {
      for (let x = 1; x < resolution - 1; x += 1) {
        const index = z * resolution + x;
        if (this.foamAnchors.has(index)
          || fields.foam[index] < 0.045
          || fields.coverage[index] < 150
          || fields.depth[index] < 0.00004
          || !this.isLocalFoamPeak(index, fields.foam)) continue;
        candidates.push(index);
      }
    }
    candidates.sort((a, b) => fields.foam[b] - fields.foam[a]);

    for (const index of candidates) {
      if (this.foamAnchors.size >= MAX_FOAM_ANCHORS) break;
      const x = index % resolution;
      const z = Math.floor(index / resolution);
      if (this.hasNearbyFoamAnchor(x, z, 2)) continue;
      const direction = this.resolveEffectDirection(index, fields);
      this.foamAnchors.set(index, {
        center: this.gridPosition(x, z, fields.surfaceHeights[index] + 0.034),
        strength: THREE.MathUtils.smoothstep(fields.foam[index], 0.035, 0.28),
        flowX: direction.x,
        flowZ: direction.y,
        unstableFrames: 0,
      });
    }
  }

  private buildLakeWavelets(fields: WaterEffectFields, buffers: CrestBuffers): void {
    const resolution = this.terrain.resolution;
    for (const index of this.lakeAnchors) {
      // 锚点只有在水真正退去时才移除，避免湖泊判定的小幅波动让整条浪线闪现。
      if (fields.coverage[index] < 70 || fields.depth[index] < 0.018 || fields.lakeFactor[index] < 0.03) {
        this.lakeAnchors.delete(index);
      }
    }

    for (let z = 2; z < resolution - 2 && this.lakeAnchors.size < MAX_LAKE_CRESTS; z += 1) {
      for (let x = 2; x < resolution - 2 && this.lakeAnchors.size < MAX_LAKE_CRESTS; x += 1) {
        const index = z * resolution + x;
        const lake = fields.lakeFactor[index];
        if (this.lakeAnchors.has(index)) continue;
        if (fields.coverage[index] < 175 || fields.depth[index] < 0.08 || lake < 0.36) continue;
        if (this.hash(x, z, 23) > 0.032 + lake * 0.035) continue;
        this.lakeAnchors.add(index);
      }
    }

    let count = 0;
    for (const index of this.lakeAnchors) {
        if (count >= MAX_LAKE_CRESTS) break;
        const x = index % resolution;
        const z = Math.floor(index / resolution);
        const lake = fields.lakeFactor[index];
        const phase = this.hash(x, z, 29);
        const center = this.gridPosition(x, z, fields.surfaceHeights[index] + 0.018);
        const radius = THREE.MathUtils.lerp(0.48, 1.35, this.hash(x, z, 31));
        const arc = THREE.MathUtils.lerp(1.08, 1.55, this.hash(x, z, 37));
        const rotation = Math.PI * (0.86 + this.hash(x, z, 41) * 0.24);
        const direction = new THREE.Vector2(Math.cos(rotation), Math.sin(rotation));
        const surfaceStrength = THREE.MathUtils.smoothstep(lake, 0.24, 0.72);
        this.appendArcRibbon(
          buffers,
          center,
          radius,
          arc,
          rotation,
          0.055 + lake * 0.035,
          phase,
          direction,
          16,
          surfaceStrength,
        );
        count += 1;
    }
  }

  private buildWaterfalls(fields: WaterEffectFields, sheets: SheetBuffers, impactWaves: CrestBuffers): void {
    const resolution = this.terrain.resolution;
    type WaterfallCandidate = { index: number; target: number; energy: number; speed: number };
    const candidateMap = new Map<number, WaterfallCandidate>();
    for (let index = 0; index < fields.waterfallEnergy.length; index += 1) {
      if (fields.waterfallTarget[index] < 0 || fields.waterfallEnergy[index] < 0.07 || fields.coverage[index] < 120) continue;
      candidateMap.set(index, {
        index,
        target: fields.waterfallTarget[index],
        energy: fields.waterfallEnergy[index],
        speed: THREE.MathUtils.clamp(Math.max(fields.flowSpeed[index], fields.waterfallEnergy[index] * 0.72), 0, 1),
      });
    }

    // 后备视觉判定：只要真实湿区已经到达明显崖边，就直接寻找流向前方的低点。
    // 它不改变水量，只避免瞬时交换能量太小而导致高悬崖始终不显示瀑布。
    for (let z = 2; z < resolution - 2; z += 1) {
      for (let x = 2; x < resolution - 2; x += 1) {
        const index = z * resolution + x;
        // 崖边水层通常会因重力快速变薄；只要达到真实可见水深就允许形成瀑布。
        if (candidateMap.has(index) || fields.coverage[index] < 120 || fields.depth[index] < 0.0008) continue;
        const flowLength = Math.hypot(fields.flowX[index], fields.flowZ[index]);
        const directions: Array<[number, number]> = [];
        if (flowLength > 0.06) {
          const flowX = fields.flowX[index] / flowLength;
          const flowZ = fields.flowZ[index] / flowLength;
          directions.push(Math.abs(flowX) >= Math.abs(flowZ) ? [Math.sign(flowX), 0] : [0, Math.sign(flowZ)]);
        }
        directions.push([1, 0], [-1, 0], [0, 1], [0, -1]);

        let target = -1;
        let bestDrop = 0;
        let bestSlope = 0;
        let bestScore = 0;
        const usedDirections = new Set<string>();
        for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
          const [dx, dz] = directions[directionIndex];
          const key = `${dx},${dz}`;
          if (usedDirections.has(key)) continue;
          usedDirections.add(key);
          let foundAlongDirection = false;
          for (let distance = 1; distance <= WATERFALL_SEARCH_CELLS; distance += 1) {
            const candidateX = x + dx * distance;
            const candidateZ = z + dz * distance;
            if (candidateX < 0 || candidateX >= resolution || candidateZ < 0 || candidateZ >= resolution) break;
            const candidate = candidateZ * resolution + candidateX;
            const drop = this.terrain.heights[index] - this.terrain.heights[candidate];
            const horizontalDistance = Math.max(this.terrain.cellSize * distance, 0.001);
            const averageSlope = drop / horizontalDistance;
            if (drop < WATERFALL_MIN_TOTAL_DROP || averageSlope < WATERFALL_MIN_AVERAGE_SLOPE) continue;
            const score = drop * (0.72 + Math.min(averageSlope, 4) * 0.28);
            if (score > bestScore) {
              bestScore = score;
              bestDrop = drop;
              bestSlope = averageSlope;
              target = candidate;
            }
            foundAlongDirection = true;
          }
          // 真实流向前方已经形成陡坎时直接采用；只有没找到时才检查其他方向。
          if (directionIndex === 0 && foundAlongDirection && flowLength > 0.06) break;
        }
        if (target < 0) continue;
        const energy = THREE.MathUtils.clamp(
          0.3
            + fields.flowSpeed[index] * 0.38
            + (bestDrop - WATERFALL_MIN_TOTAL_DROP) / 12 * 0.2
            + (bestSlope - WATERFALL_MIN_AVERAGE_SLOPE) / 4 * 0.18,
          0.3,
          1,
        );
        const speed = THREE.MathUtils.clamp(Math.max(fields.flowSpeed[index], energy * 0.72), 0, 1);
        candidateMap.set(index, { index, target, energy, speed });
      }
    }
    const candidates = Array.from(candidateMap.values())
      .sort((a, b) => b.energy - a.energy)
      .slice(0, 180);
    const clusters: WaterfallCandidate[][] = [];
    for (const candidate of candidates) {
      const sourceX = candidate.index % resolution;
      const sourceZ = Math.floor(candidate.index / resolution);
      const targetX = candidate.target % resolution;
      const targetZ = Math.floor(candidate.target / resolution);
      const candidateDirection = new THREE.Vector2(targetX - sourceX, targetZ - sourceZ).normalize();
      const cluster = clusters.find((members) => members.some((member) => {
        const memberX = member.index % resolution;
        const memberZ = Math.floor(member.index / resolution);
        const memberTargetX = member.target % resolution;
        const memberTargetZ = Math.floor(member.target / resolution);
        const memberDirection = new THREE.Vector2(memberTargetX - memberX, memberTargetZ - memberZ).normalize();
        const sameLedgeHeight = Math.abs(this.terrain.heights[member.index] - this.terrain.heights[candidate.index]) < 1.15;
        return Math.hypot(sourceX - memberX, sourceZ - memberZ) <= 3.35
          && candidateDirection.dot(memberDirection) > 0.72
          && sameLedgeHeight;
      }));
      if (cluster) cluster.push(candidate);
      else clusters.push([candidate]);
    }
    clusters.sort((a, b) => Math.max(...b.map((item) => item.energy)) - Math.max(...a.map((item) => item.energy)));

    for (const members of clusters.slice(0, MAX_WATERFALLS)) {
      let sourceX = 0;
      let sourceZ = 0;
      let targetX = 0;
      let targetZ = 0;
      let startY = 0;
      let targetY = 0;
      let energySum = 0;
      let speedSum = 0;
      let depthSum = 0;
      for (const member of members) {
        const sx = member.index % resolution;
        const sz = Math.floor(member.index / resolution);
        const tx = member.target % resolution;
        const tz = Math.floor(member.target / resolution);
        sourceX += sx;
        sourceZ += sz;
        targetX += tx;
        targetZ += tz;
        startY += fields.surfaceHeights[member.index];
        targetY += this.terrain.heights[member.target] + Math.max(0.02, fields.depth[member.target]) + 0.025;
        energySum += member.energy;
        speedSum += member.speed;
        depthSum += fields.depth[member.index];
      }
      const memberCount = members.length;
      sourceX /= memberCount;
      sourceZ /= memberCount;
      targetX /= memberCount;
      targetZ /= memberCount;
      startY /= memberCount;
      targetY /= memberCount;
      const energy = energySum / memberCount;
      const speed = speedSum / memberCount;
      const sourceDepth = depthSum / memberCount;
      const direction = new THREE.Vector2(targetX - sourceX, targetZ - sourceZ).normalize();
      if (direction.lengthSq() < 0.5) continue;
      const side = new THREE.Vector2(-direction.y, direction.x);

      let lateralMin = Number.POSITIVE_INFINITY;
      let lateralMax = Number.NEGATIVE_INFINITY;
      for (const member of members) {
        const sx = member.index % resolution;
        const sz = Math.floor(member.index / resolution);
        const lateral = ((sx - sourceX) * side.x + (sz - sourceZ) * side.y) * this.terrain.cellSize;
        lateralMin = Math.min(lateralMin, lateral);
        lateralMax = Math.max(lateralMax, lateral);
      }
      const ledgeSpan = Number.isFinite(lateralMin) ? lateralMax - lateralMin : 0;
      const width = THREE.MathUtils.clamp(
        ledgeSpan + this.terrain.cellSize * (1.15 + energy * 0.75),
        this.terrain.cellSize * 1.25,
        this.terrain.cellSize * 7.5,
      );
      const start = this.gridPosition(sourceX, sourceZ, startY + 0.03);
      const targetPosition = this.gridPosition(targetX, targetZ, targetY + 0.09);
      const end = targetPosition.clone().add(
        new THREE.Vector3(direction.x, 0, direction.y).multiplyScalar(this.terrain.cellSize * 0.82),
      );
      const seed = members[0].index;
      const phase = this.hash(Math.round(sourceX), Math.round(sourceZ), 53);
      this.appendWaterfallSheet(sheets, start, end, direction, side, width, sourceDepth, energy, speed, phase);

      const impactCenter = end.clone();
      impactCenter.y = targetY + 0.13;
      const impactStrength = THREE.MathUtils.clamp(energy * 0.58 + speed * 0.62, 0.35, 1);
      this.impacts.push({ center: impactCenter, energy: impactStrength, speed, seed });
      for (let wave = 0; wave < 3; wave += 1) {
        const wavePhase = (phase + wave * 0.31) % 1;
        const radius = 0.28 + wave * 0.14 + energy * 0.22 + width * 0.06;
        const rotation = phase * Math.PI * 2 + wave * 1.7;
        this.appendArcRibbon(
          impactWaves,
          impactCenter.clone().add(new THREE.Vector3(0, 0.045, 0)),
          radius,
          0.82 + wave * 0.18,
          rotation,
          0.055 + energy * 0.025,
          wavePhase,
          new THREE.Vector2(0, 0),
          14,
        );
      }
    }
  }

  private appendCurveRibbon(
    buffers: CrestBuffers,
    center: THREE.Vector3,
    direction: THREE.Vector2,
    length: number,
    width: number,
    phase: number,
    fields: WaterEffectFields,
    segments: number,
    speed: number,
    surfaceStrength: number,
    heightOffset = 0.008,
  ): void {
    // Trace the ribbon through the vector field in both directions. A single
    // centre-cell direction produces independent comma shapes; following the
    // neighbouring cells makes one crest bend through a turn like a stream.
    const points = Array.from({ length: segments + 1 }, () => new THREE.Vector2());
    const middle = Math.floor(segments * 0.5);
    const stepLength = length / segments;
    points[middle].set(center.x, center.z);

    const forward = direction.clone().normalize();
    for (let i = middle + 1; i <= segments; i += 1) {
      const previous = points[i - 1];
      const sampled = this.sampleFlowDirection(previous.x, previous.y, fields, forward);
      forward.lerp(sampled, 0.62).normalize();
      points[i].copy(previous).addScaledVector(forward, stepLength);
    }

    const backward = direction.clone().normalize();
    for (let i = middle - 1; i >= 0; i -= 1) {
      const next = points[i + 1];
      const sampled = this.sampleFlowDirection(next.x, next.y, fields, backward);
      backward.lerp(sampled, 0.62).normalize();
      points[i].copy(next).addScaledVector(backward, -stepLength);
    }

    const startIndex = buffers.positions.length / 3;
    for (let i = 0; i <= segments; i += 1) {
      const q = i / segments;
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(segments, i + 1)];
      const tangent = next.clone().sub(previous);
      if (tangent.lengthSq() < 0.000001) tangent.copy(direction);
      else tangent.normalize();
      const side = new THREE.Vector2(-tangent.y, tangent.x);
      // Keep only a very small organic offset; the main curve now comes from
      // the real flow field rather than an arbitrary sinusoidal bend.
      const curl = Math.sin(q * Math.PI * 1.7 + phase * Math.PI * 2) * length * 0.018;
      const halfWidth = width * Math.pow(Math.sin(q * Math.PI), 0.58);
      const x = points[i].x + side.x * curl;
      const z = points[i].y + side.y * curl;
      const y = this.sampleSurface(x, z, fields) + heightOffset;
      for (const sign of [1, -1]) {
        buffers.positions.push(x + side.x * halfWidth * sign, y, z + side.y * halfWidth * sign);
        buffers.phases.push(phase);
        buffers.alongs.push(q);
        buffers.flows.push(tangent.x, tangent.y);
        buffers.speeds.push(speed);
        buffers.centers.push(center.x, center.y, center.z);
        buffers.strengths.push(surfaceStrength);
      }
    }
    this.appendStripIndices(buffers.indices, startIndex, segments);
  }

  private appendArcRibbon(
    buffers: CrestBuffers,
    center: THREE.Vector3,
    radius: number,
    arc: number,
    rotation: number,
    width: number,
    phase: number,
    direction: THREE.Vector2,
    segments: number,
    surfaceStrength = 1,
    effectSpeed = 0.12,
  ): void {
    const startIndex = buffers.positions.length / 3;
    for (let i = 0; i <= segments; i += 1) {
      const q = i / segments;
      const angle = rotation + (q - 0.5) * arc;
      const taper = Math.pow(Math.sin(q * Math.PI), 0.58);
      const halfWidth = width * taper;
      for (const radial of [radius - halfWidth, radius + halfWidth]) {
        buffers.positions.push(
          center.x + Math.cos(angle) * radial,
          center.y,
          center.z + Math.sin(angle) * radial,
        );
        buffers.phases.push(phase);
        buffers.alongs.push(q);
        buffers.flows.push(direction.x, direction.y);
        buffers.speeds.push(effectSpeed);
        buffers.centers.push(center.x, center.y, center.z);
        buffers.strengths.push(surfaceStrength);
      }
    }
    this.appendStripIndices(buffers.indices, startIndex, segments);
  }

  private appendWaterfallSheet(
    buffers: SheetBuffers,
    start: THREE.Vector3,
    end: THREE.Vector3,
    direction: THREE.Vector2,
    side: THREE.Vector2,
    width: number,
    sourceDepth: number,
    energy: number,
    speed: number,
    phase: number,
  ): void {
    const columns = 4;
    const rows = 12;
    const startIndex = buffers.positions.length / 3;
    for (let row = 0; row <= rows; row += 1) {
      const t = row / rows;
      const fallT = t * t * 0.72 + t * 0.28;
      // 向崖外抛出水幕，避免水带与近乎同角度的山体表面重合后被深度测试吞掉。
      const throwDistance = Math.sin(t * Math.PI) * width * (0.4 + energy * 0.16);
      const centerX = THREE.MathUtils.lerp(start.x, end.x, t) + direction.x * throwDistance;
      const centerY = THREE.MathUtils.lerp(start.y, end.y, fallT);
      const centerZ = THREE.MathUtils.lerp(start.z, end.z, t) + direction.y * throwDistance;
      const rowWidth = width * (0.86 + t * 0.2 + Math.sin(t * Math.PI) * 0.08);
      for (let column = 0; column <= columns; column += 1) {
        const u = column / columns;
        const across = (u - 0.5) * rowWidth;
        const scallop = Math.sin(u * Math.PI * 5 + t * 3 + phase * 5) * width * 0.018 * Math.sin(u * Math.PI);
        buffers.positions.push(
          centerX + side.x * across + direction.x * scallop,
          centerY,
          centerZ + side.y * across + direction.y * scallop,
        );
        buffers.uvs.push(u, t);
        buffers.energies.push(energy);
        buffers.speeds.push(speed);
        buffers.phases.push(phase);
        buffers.widths.push(width);
        buffers.depths.push(sourceDepth);
      }
    }
    const stride = columns + 1;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = startIndex + row * stride + column;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        buffers.indices.push(a, b, c, b, d, c);
      }
    }
  }

  private updateBubbles(seconds: number): void {
    let cursor = 0;
    for (const impact of this.impacts) {
      // 与测试场一致，用一群短生命周期的低模小浪花持续表现落点的“沸腾”，数量由冲击和流速共同决定。
      const count = Math.min(40, 20 + Math.round(impact.energy * 12 + impact.speed * 8));
      for (let i = 0; i < count && cursor < MAX_BUBBLES; i += 1) {
        const phase = this.hash(impact.seed, i, 61);
        const lifetime = THREE.MathUtils.lerp(0.68, 1.45, this.hash(impact.seed, i, 67));
        const age = (seconds / lifetime + phase) % 1;
        const envelope = Math.pow(Math.sin(age * Math.PI), 0.48);
        const angle = this.hash(impact.seed, i, 71) * Math.PI * 2;
        const distance = Math.sqrt(this.hash(impact.seed, i, 73)) * this.terrain.cellSize * (0.78 + impact.energy * 1.85);
        const spread = 0.6 + age * 0.5;
        const rise = age * THREE.MathUtils.lerp(0.1, 0.48, this.hash(impact.seed, i, 79)) * (0.78 + impact.energy * 0.48);
        this.position.set(
          impact.center.x + Math.cos(angle) * distance * spread,
          impact.center.y + rise + Math.sin(age * Math.PI) * 0.06,
          impact.center.z + Math.sin(angle) * distance * spread,
        );
        const size = THREE.MathUtils.lerp(0.06, 0.2, this.hash(impact.seed, i, 83)) * envelope;
        this.scale.set(size * 1.22, size * 0.78, size * 1.22);
        this.quaternion.setFromEuler(new THREE.Euler(age * 1.7, phase * 8 + age * 2.1, age * 0.8));
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.bubbles.setMatrixAt(cursor, this.matrix);
        this.color.set(i % 3 === 0 ? "#cce8e3" : i % 3 === 1 ? "#edf7f3" : "#dcefeb");
        this.bubbles.setColorAt(cursor, this.color);
        cursor += 1;
      }
    }

    // Foam uses the same rounded low-poly lobes as the showcase, but ordinary
    // turbulent water gets only a few flatter bubbles per local foam peak.
    for (const [index, foam] of this.foamAnchors) {
      const count = 1 + Math.round(foam.strength * 3);
      const directionLength = Math.hypot(foam.flowX, foam.flowZ);
      const directionX = directionLength > 0.001 ? foam.flowX / directionLength : 0;
      const directionZ = directionLength > 0.001 ? foam.flowZ / directionLength : 0;
      for (let i = 0; i < count && cursor < MAX_BUBBLES; i += 1) {
        const phase = this.hash(index, i, 109);
        const lifetime = THREE.MathUtils.lerp(0.85, 1.6, this.hash(index, i, 113));
        const age = (seconds / lifetime + phase) % 1;
        const envelope = Math.pow(Math.sin(age * Math.PI), 0.48);
        const angle = this.hash(index, i, 127) * Math.PI * 2;
        const radius = this.terrain.cellSize * (0.14 + foam.strength * 0.34);
        const distance = Math.sqrt(this.hash(index, i, 131)) * radius;
        const spread = 0.58 + age * 0.34;
        const flowDrift = age * this.terrain.cellSize * (0.05 + foam.strength * 0.13);
        const sideways = Math.sin(age * Math.PI * 2 + phase * 9) * this.terrain.cellSize * 0.035;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        this.position.set(
          foam.center.x + cos * distance * spread - sin * sideways + directionX * flowDrift,
          foam.center.y
            + Math.sin(age * Math.PI)
              * THREE.MathUtils.lerp(0.022, 0.075, this.hash(index, i, 137))
              * (0.62 + foam.strength * 0.38),
          foam.center.z + sin * distance * spread + cos * sideways + directionZ * flowDrift,
        );
        const size = THREE.MathUtils.lerp(0.045, 0.13, this.hash(index, i, 139))
          * THREE.MathUtils.lerp(0.72, 1, foam.strength)
          * envelope;
        this.scale.set(size * 1.18, size * 0.82, size * 1.18);
        this.quaternion.setFromEuler(new THREE.Euler(age * 1.7, phase * 8 + age * 2.1, age * 0.8));
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.bubbles.setMatrixAt(cursor, this.matrix);
        const shade = (index + i) % 3;
        this.color.set(shade === 0 ? "#cce8e3" : shade === 1 ? "#edf7f3" : "#dcefeb");
        this.bubbles.setColorAt(cursor, this.color);
        cursor += 1;
      }
    }
    this.bubbles.count = cursor;
    this.bubbles.visible = cursor > 0;
    this.bubbles.instanceMatrix.needsUpdate = true;
    if (this.bubbles.instanceColor) this.bubbles.instanceColor.needsUpdate = true;
  }

  private createCrestMaterial(
    color: THREE.ColorRepresentation,
    grow: boolean,
    followLakeSurface: boolean,
    opacity: number,
    strengthDrivenAlpha = false,
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      uniforms: {
        uTime: this.timeUniform,
        uColor: { value: new THREE.Color(color) },
      },
      vertexShader: `
        uniform float uTime;
        attribute float effectPhase;
        attribute float effectStrength;
        attribute float effectSpeed;
        attribute float effectAlong;
        attribute vec2 effectFlow;
        attribute vec3 effectCenter;
        varying float vLife;
        varying float vTrail;
        varying float vStrength;
        void main() {
          vec3 p = position;
          // River crests use the normalized speed recorded by their own water
          // cell. The UI dwell-time value is never passed to this material.
          // Keep lifecycle time independent from the changing cell speed: if
          // speed multiplies absolute uTime, every field refresh jumps the age
          // and therefore the alpha envelope, which reads as flicker.
          float localFlowSpeed = clamp(effectSpeed, 0.0, 1.0);
          float visibleFlowSpeed = smoothstep(0.05, 0.62, localFlowSpeed);
          float age = fract(uTime * ${grow ? "0.18" : "0.14"} + effectPhase);
          vLife = pow(sin(age * 3.14159265), 0.65);
          vStrength = effectStrength;
          float flowHead = 0.5 + (age - 0.5) * mix(0.55, 1.55, visibleFlowSpeed);
          vTrail = ${grow ? "1.0" : "1.0 - smoothstep(0.32, 0.58, abs(effectAlong - flowHead))"};
          ${grow
            ? `p.xz = effectCenter.xz + (p.xz - effectCenter.xz) * (0.72 + age * 0.72) + effectFlow * (age - 0.22) * 0.55;${followLakeSurface ? "" : " p.y += sin(age * 3.14159265) * 0.025;"}`
            : ""}
          ${followLakeSurface ? `
          float domainA = sin(dot(p.xz, normalize(vec2(-0.38, 0.92))) * 0.48 + uTime * 0.17);
          float domainB = sin(dot(p.xz, normalize(vec2(0.86, 0.51))) * 0.73 - uTime * 0.11 + 2.3);
          vec2 warped = p.xz + vec2(domainA * 0.42 + domainB * 0.18, domainB * 0.36 - domainA * 0.15);
          float waveA = sin(dot(warped, normalize(vec2(0.92, 0.38))) * 1.22 - uTime * 0.96);
          float waveB = sin(dot(warped, normalize(vec2(-0.27, 0.96))) * 1.78 - uTime * 0.57 + 1.7);
          float waveC = sin(dot(warped, normalize(vec2(0.72, -0.69))) * 2.46 - uTime * 0.83 + 3.1);
          float waveD = sin(dot(warped, normalize(vec2(-0.94, -0.34))) * 3.18 - uTime * 0.39 + 0.6);
          float localWave = (waveA * 0.092 + waveB * 0.058 + waveC * 0.034 + waveD * 0.018) * effectStrength;
          p.y += max(-0.055, localWave);` : ""}
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vLife;
        varying float vTrail;
        varying float vStrength;
        void main() {
          float strengthAlpha = ${strengthDrivenAlpha ? "mix(0.35, 1.0, clamp(vStrength, 0.0, 1.0))" : "1.0"};
          gl_FragColor = vec4(uColor, vLife * vTrail * strengthAlpha * ${opacity.toFixed(2)});
        }
      `,
    });
  }

  private createWaterfallMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: this.timeUniform,
        // 与普通水面使用同一套青蓝基色，白色只留给稀疏的含气水纹。
        uShallow: { value: new THREE.Color("#287786") },
        uMiddle: { value: new THREE.Color("#14546b") },
        uDeep: { value: new THREE.Color("#093a54") },
        uFoam: { value: new THREE.Color("#e1f1ec") },
      },
      vertexShader: `
        uniform float uTime;
        attribute float effectEnergy;
        attribute float effectSpeed;
        attribute float effectPhase;
        attribute float effectWidth;
        attribute float effectDepth;
        varying vec2 vUv;
        varying float vEnergy;
        varying float vSpeed;
        varying float vPhase;
        varying float vWidth;
        varying float vDepth;
        void main() {
          vec3 p = position;
          p.y += sin(uv.x * 11.0 + uv.y * 5.0 - uTime * (0.32 + effectSpeed * 0.42) + effectPhase * 6.0) * 0.025 * effectEnergy;
          vUv = uv;
          vEnergy = effectEnergy;
          vSpeed = effectSpeed;
          vPhase = effectPhase;
          vWidth = effectWidth;
          vDepth = effectDepth;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uShallow;
        uniform vec3 uMiddle;
        uniform vec3 uDeep;
        uniform vec3 uFoam;
        varying vec2 vUv;
        varying float vEnergy;
        varying float vSpeed;
        varying float vPhase;
        varying float vWidth;
        varying float vDepth;
        void main() {
          float shallowToMiddle = smoothstep(0.035, 0.34, vDepth);
          float middleToDeep = smoothstep(0.38, 1.85, vDepth);
          vec3 color = mix(uShallow, uMiddle, shallowToMiddle);
          color = mix(color, uDeep, middleToDeep);
          float laneCyclesA = max(1.0, vWidth * 1.35);
          float laneCyclesB = max(1.0, vWidth * 0.82);
          float laneA = 0.5 + 0.5 * sin(vUv.x * 6.2831853 * laneCyclesA + sin(vUv.y * 6.0 + vPhase * 6.0) * 1.45);
          float laneB = 0.5 + 0.5 * sin(vUv.x * 6.2831853 * laneCyclesB - sin(vUv.y * 8.0 - vPhase * 4.0) * 1.2 + 1.9);
          float narrowStreak = max(smoothstep(0.94, 0.992, laneA), smoothstep(0.955, 0.995, laneB));
          // White streaks descend deliberately slowly; flow speed only adds a
          // restrained variation instead of turning the sheet almost white.
          float lanePhase = floor(vUv.x * max(2.0, laneCyclesA)) * 0.137 + vPhase;
          float travel = fract(vUv.y * mix(1.55, 2.05, vSpeed) - uTime * mix(0.12, 0.38, vSpeed) + lanePhase);
          float longSegment = 1.0 - smoothstep(0.18, 0.46, abs(travel - 0.5));
          float slowPulse = 0.76 + 0.24 * sin(vUv.y * 14.0 - uTime * (0.48 + vSpeed * 0.76) + vUv.x * 6.0 + vPhase * 8.0);
          float foam = clamp(narrowStreak * longSegment * slowPulse * (0.14 + vEnergy * 0.18 + vSpeed * 0.12), 0.0, 0.52);
          color = mix(color, uFoam, foam);
          gl_FragColor = vec4(color, 0.97);
        }
      `,
    });
  }

  private replaceCrestGeometry(mesh: THREE.Mesh, buffers: CrestBuffers): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("effectPhase", new THREE.Float32BufferAttribute(buffers.phases, 1));
    geometry.setAttribute("effectAlong", new THREE.Float32BufferAttribute(buffers.alongs, 1));
    geometry.setAttribute("effectFlow", new THREE.Float32BufferAttribute(buffers.flows, 2));
    geometry.setAttribute("effectSpeed", new THREE.Float32BufferAttribute(buffers.speeds, 1));
    geometry.setAttribute("effectCenter", new THREE.Float32BufferAttribute(buffers.centers, 3));
    geometry.setAttribute("effectStrength", new THREE.Float32BufferAttribute(buffers.strengths, 1));
    geometry.setIndex(buffers.indices);
    if (buffers.positions.length > 0) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    mesh.geometry.dispose();
    mesh.geometry = geometry;
    mesh.visible = buffers.positions.length > 0;
  }

  private replaceSheetGeometry(buffers: SheetBuffers): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uvs, 2));
    geometry.setAttribute("effectEnergy", new THREE.Float32BufferAttribute(buffers.energies, 1));
    geometry.setAttribute("effectSpeed", new THREE.Float32BufferAttribute(buffers.speeds, 1));
    geometry.setAttribute("effectPhase", new THREE.Float32BufferAttribute(buffers.phases, 1));
    geometry.setAttribute("effectWidth", new THREE.Float32BufferAttribute(buffers.widths, 1));
    geometry.setAttribute("effectDepth", new THREE.Float32BufferAttribute(buffers.depths, 1));
    geometry.setIndex(buffers.indices);
    if (buffers.positions.length > 0) {
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    this.waterfallMesh.geometry.dispose();
    this.waterfallMesh.geometry = geometry;
    this.waterfallMesh.visible = buffers.positions.length > 0;
  }

  private appendStripIndices(indices: number[], start: number, segments: number): void {
    for (let i = 0; i < segments; i += 1) {
      const a = start + i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  private createCrestBuffers(): CrestBuffers {
    return { positions: [], phases: [], alongs: [], flows: [], speeds: [], centers: [], strengths: [], indices: [] };
  }

  private createSheetBuffers(): SheetBuffers {
    return { positions: [], uvs: [], energies: [], speeds: [], phases: [], widths: [], depths: [], indices: [] };
  }

  private gridPosition(x: number, z: number, y: number): THREE.Vector3 {
    const half = WORLD_CONFIG.size * 0.5;
    return new THREE.Vector3(x * this.terrain.cellSize - half, y, z * this.terrain.cellSize - half);
  }

  private sampleSurface(worldX: number, worldZ: number, fields: WaterEffectFields): number {
    const half = WORLD_CONFIG.size * 0.5;
    const gx = THREE.MathUtils.clamp((worldX + half) / this.terrain.cellSize, 0, this.terrain.resolution - 1);
    const gz = THREE.MathUtils.clamp((worldZ + half) / this.terrain.cellSize, 0, this.terrain.resolution - 1);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(this.terrain.resolution - 1, x0 + 1);
    const z1 = Math.min(this.terrain.resolution - 1, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const row0 = z0 * this.terrain.resolution;
    const row1 = z1 * this.terrain.resolution;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(fields.surfaceHeights[row0 + x0], fields.surfaceHeights[row0 + x1], tx),
      THREE.MathUtils.lerp(fields.surfaceHeights[row1 + x0], fields.surfaceHeights[row1 + x1], tx),
      tz,
    );
  }

  private sampleFlowDirection(
    worldX: number,
    worldZ: number,
    fields: WaterEffectFields,
    fallback: THREE.Vector2,
  ): THREE.Vector2 {
    const half = WORLD_CONFIG.size * 0.5;
    const gx = THREE.MathUtils.clamp((worldX + half) / this.terrain.cellSize, 0, this.terrain.resolution - 1);
    const gz = THREE.MathUtils.clamp((worldZ + half) / this.terrain.cellSize, 0, this.terrain.resolution - 1);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(this.terrain.resolution - 1, x0 + 1);
    const z1 = Math.min(this.terrain.resolution - 1, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const row0 = z0 * this.terrain.resolution;
    const row1 = z1 * this.terrain.resolution;
    const interpolate = (values: Float32Array): number => THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(values[row0 + x0], values[row0 + x1], tx),
      THREE.MathUtils.lerp(values[row1 + x0], values[row1 + x1], tx),
      tz,
    );
    const sampled = new THREE.Vector2(interpolate(fields.flowX), interpolate(fields.flowZ));
    if (sampled.lengthSq() < 0.0064) return fallback.clone();
    return sampled.normalize();
  }

  private resolveEffectDirection(
    index: number,
    fields: WaterEffectFields,
    fallback?: THREE.Vector2,
  ): THREE.Vector2 {
    const direct = new THREE.Vector2(fields.flowX[index], fields.flowZ[index]);
    if (direct.lengthSq() >= 0.0025) return direct.normalize();

    const resolution = this.terrain.resolution;
    const x = index % resolution;
    const z = Math.floor(index / resolution);
    let bestScore = -1;
    let bestDirection: THREE.Vector2 | undefined;
    for (let dz = -1; dz <= 1; dz += 1) {
      const sampleZ = z + dz;
      if (sampleZ < 0 || sampleZ >= resolution) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const sampleX = x + dx;
        if (sampleX < 0 || sampleX >= resolution) continue;
        const sample = sampleZ * resolution + sampleX;
        const direction = new THREE.Vector2(fields.flowX[sample], fields.flowZ[sample]);
        if (direction.lengthSq() < 0.0025) continue;
        const score = fields.flowSpeed[sample] * (fields.coverage[sample] / 255);
        if (score <= bestScore) continue;
        bestScore = score;
        bestDirection = direction.normalize();
      }
    }
    if (bestDirection) return bestDirection;
    if (fallback && fallback.lengthSq() > 0.0001) return fallback.clone().normalize();
    const angle = this.hash(x, z, 149) * Math.PI * 2;
    return new THREE.Vector2(Math.cos(angle), Math.sin(angle));
  }

  private countWetNeighbours(index: number, fields: WaterEffectFields, minimumCoverage: number): number {
    const resolution = this.terrain.resolution;
    const x = index % resolution;
    const z = Math.floor(index / resolution);
    let count = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      const sampleZ = z + dz;
      if (sampleZ < 0 || sampleZ >= resolution) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const sampleX = x + dx;
        if (sampleX < 0 || sampleX >= resolution) continue;
        if (fields.coverage[sampleZ * resolution + sampleX] >= minimumCoverage) count += 1;
      }
    }
    return count;
  }

  private isLocalFoamPeak(index: number, foam: Float32Array): boolean {
    const resolution = this.terrain.resolution;
    const x = index % resolution;
    const z = Math.floor(index / resolution);
    const value = foam[index];
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) continue;
        const sample = (z + dz) * resolution + x + dx;
        if (foam[sample] > value + 0.004) return false;
      }
    }
    return true;
  }

  private hasNearbyFoamAnchor(x: number, z: number, cellRadius: number): boolean {
    const resolution = this.terrain.resolution;
    for (const index of this.foamAnchors.keys()) {
      const anchorX = index % resolution;
      const anchorZ = Math.floor(index / resolution);
      if (Math.max(Math.abs(anchorX - x), Math.abs(anchorZ - z)) <= cellRadius) return true;
    }
    return false;
  }

  private hash(x: number, z: number, salt: number): number {
    const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return value - Math.floor(value);
  }
}
