import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import type { VisualFlowField, VisualFlowSample } from "@/engine/water/VisualFlowField";

const INITIAL_RIPPLE_POOL_SIZE = 128;
const RIBBON_SEGMENTS = 10;
const LANE_REFRESH_SECONDS = 0.7;
const MIN_FLOW_CONFIDENCE = 0.11;
const MIN_LANE_SPACING_CELLS = 3;
const MIN_LATERAL_INTERIOR_SCORE = 1.3;
const INTERIOR_COVERAGE = 150;

export type RiverFlowFields = {
  coverage: Uint8Array;
  surfaceHeights: Float32Array;
  depth: Float32Array;
  flowSpeed: Float32Array;
  lakeFactor: Float32Array;
};

type FlowLane = {
  key: number;
  positions: Float32Array;
  distances: Float32Array;
  totalLength: number;
  visualSpeed: number;
  spacing: number;
  nextSpawnTime: number;
  lastSeenTime: number;
  spawnSequence: number;
  acceptingSpawns: boolean;
};

type FlowRipple = {
  lane: FlowLane | null;
  headDistance: number;
  length: number;
  width: number;
  speedScale: number;
  tone: number;
  opacity: number;
  age: number;
  fadeInSeconds: number;
};

type PathSample = {
  x: number;
  y: number;
  z: number;
};

/**
 * Moving river highlights. Lanes are selected by spatial separation rather
 * than a total-count ceiling; ripple objects and GPU storage grow on demand.
 */
export class RiverFlowRibbons {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly lanes = new Map<number, FlowLane>();
  private readonly activeRipples: FlowRipple[] = [];
  private readonly freeRipples: FlowRipple[] = [];
  private readonly laneOccupancy: Uint8Array;
  private fields: RiverFlowFields | null = null;
  private ribbonCapacity = INITIAL_RIPPLE_POOL_SIZE;
  private lastUpdateTime = 0;
  private lastLaneRefreshTime = -Infinity;
  private lanesDirty = true;
  private readonly flowSample: VisualFlowSample = {
    directionX: 0,
    directionZ: 0,
    confidence: 0,
  };

  constructor(
    private readonly terrain: TerrainSystem,
    private readonly visualFlowField: VisualFlowField,
  ) {
    this.laneOccupancy = new Uint8Array(terrain.resolutionX * terrain.resolutionZ);
    for (let index = 0; index < INITIAL_RIPPLE_POOL_SIZE; index += 1) {
      this.freeRipples.push(this.createRipple());
    }
    this.mesh = new THREE.Mesh(
      this.createGeometry(this.ribbonCapacity),
      this.createMaterial(),
    );
    this.mesh.name = "advected-river-flow-ribbons";
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setFields(fields: RiverFlowFields): void {
    this.fields = fields;
    this.lanesDirty = true;
  }

  update(timeSeconds: number): void {
    if (!this.fields) return;
    this.mesh.material.uniforms.uTime.value = timeSeconds;
    const deltaTime = this.lastUpdateTime > 0
      ? THREE.MathUtils.clamp(timeSeconds - this.lastUpdateTime, 0, 0.05)
      : 0;
    this.lastUpdateTime = timeSeconds;

    if (
      this.lanesDirty
      || timeSeconds - this.lastLaneRefreshTime >= LANE_REFRESH_SECONDS
    ) {
      this.refreshLanes(timeSeconds);
      this.lastLaneRefreshTime = timeSeconds;
      this.lanesDirty = false;
    }

    if (deltaTime > 0) {
      this.spawnFromLanes(timeSeconds);
      this.advanceRipples(deltaTime);
    }
    this.uploadGeometry();
  }

  clear(): void {
    for (const ripple of this.activeRipples) this.releaseRipple(ripple);
    this.activeRipples.length = 0;
    this.lanes.clear();
    this.fields = null;
    this.mesh.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.lanesDirty = true;
    this.lastUpdateTime = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private refreshLanes(timeSeconds: number): void {
    const fields = this.fields;
    if (!fields) return;
    const resolutionX = this.terrain.resolutionX;
    const resolutionZ = this.terrain.resolutionZ;
    const candidates: Array<{ index: number; score: number }> = [];
    this.laneOccupancy.fill(0);

    for (let z = 1; z < resolutionZ - 1; z += 1) {
      for (let x = 1; x < resolutionX - 1; x += 1) {
        const index = z * resolutionX + x;
        const confidence = this.visualFlowField.confidence[index];
        if (!this.isRiverCell(index, fields, confidence)) continue;
        const directionX = this.visualFlowField.directionX[index];
        const directionZ = this.visualFlowField.directionZ[index];
        const upstreamX = THREE.MathUtils.clamp(Math.round(x - directionX * 1.5), 0, resolutionX - 1);
        const upstreamZ = THREE.MathUtils.clamp(Math.round(z - directionZ * 1.5), 0, resolutionZ - 1);
        const upstreamIndex = upstreamZ * resolutionX + upstreamX;
        const upstreamConfidence = this.isRiverCell(
          upstreamIndex,
          fields,
          this.visualFlowField.confidence[upstreamIndex],
        ) ? this.visualFlowField.confidence[upstreamIndex] : 0;
        const upstreamEdge = Math.max(0, confidence - upstreamConfidence);
        const lateralInterior = this.getLateralInteriorScore(
          x,
          z,
          directionX,
          directionZ,
          fields,
        );
        if (lateralInterior < MIN_LATERAL_INTERIOR_SCORE) continue;
        candidates.push({
          index,
          // Start with the river interior, then let spatial separation add
          // evenly spaced side lanes. Edge cells no longer claim the whole
          // channel before a center lane is considered.
          score: upstreamEdge * 1.35
            + confidence
            + lateralInterior * 0.58
            + (fields.coverage[index] / 255) * 0.18
            + this.hash(index, 17) * 0.025,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    const seenLaneKeys = new Set<number>();
    const activeCounts = this.countActiveRipplesByLane();
    const stepDistance = this.terrain.cellSize * 0.62;
    const maxSteps = Math.ceil(Math.hypot(resolutionX, resolutionZ) * 1.8);
    for (const candidate of candidates) {
      if (this.laneOccupancy[candidate.index] !== 0) continue;
      const seedX = candidate.index % resolutionX;
      const seedZ = Math.floor(candidate.index / resolutionX);
      const worldX = seedX * this.terrain.cellSize - WORLD_CONFIG.sizeX * 0.5;
      const worldZ = seedZ * this.terrain.cellSize - WORLD_CONFIG.sizeZ * 0.5;
      const upstream = this.trimToRiver(
        this.visualFlowField.traceRK2(worldX, worldZ, -1, stepDistance, maxSteps, MIN_FLOW_CONFIDENCE),
        fields,
      );
      const downstream = this.trimToRiver(
        this.visualFlowField.traceRK2(worldX, worldZ, 1, stepDistance, maxSteps, MIN_FLOW_CONFIDENCE),
        fields,
      );
      const path2D = this.combineDirections(upstream, downstream);
      if (path2D.length < 10) continue;
      // Spacing is a constraint on the complete streamline, not only on its
      // seed. This prevents separate upstream lanes from merging into two
      // nearly coincident ribbons farther downstream.
      if (this.pathTouchesOccupiedLane(path2D)) continue;
      const builtPath = this.buildWorldPath(path2D, fields);
      if (!builtPath || builtPath.totalLength < this.terrain.cellSize * 3.5) continue;
      const key = this.pathStartKey(builtPath.positions);
      if (seenLaneKeys.has(key)) {
        this.markLaneSpacing(path2D);
        continue;
      }
      seenLaneKeys.add(key);
      this.markLaneSpacing(path2D);

      const sampledSpeed = this.sampleBilinear(fields.flowSpeed, worldX, worldZ);
      const visualSpeed = 0.58 + Math.sqrt(THREE.MathUtils.clamp(sampledSpeed, 0, 1)) * 1.62;
      const spacing = THREE.MathUtils.lerp(11.5, 7.8, THREE.MathUtils.clamp(sampledSpeed, 0, 1));
      const existing = this.lanes.get(key);
      if (existing) {
        existing.lastSeenTime = timeSeconds;
        existing.acceptingSpawns = true;
        existing.visualSpeed = THREE.MathUtils.lerp(existing.visualSpeed, visualSpeed, 0.25);
        existing.spacing = THREE.MathUtils.lerp(existing.spacing, spacing, 0.25);
        if ((activeCounts.get(existing) ?? 0) === 0) {
          existing.positions = builtPath.positions;
          existing.distances = builtPath.distances;
          existing.totalLength = builtPath.totalLength;
        }
        continue;
      }

      const lane: FlowLane = {
        key,
        positions: builtPath.positions,
        distances: builtPath.distances,
        totalLength: builtPath.totalLength,
        visualSpeed,
        spacing,
        nextSpawnTime: timeSeconds + spacing / visualSpeed,
        lastSeenTime: timeSeconds,
        spawnSequence: 0,
        acceptingSpawns: true,
      };
      this.lanes.set(key, lane);
      this.prewarmLane(lane);
    }

    for (const [key, lane] of this.lanes) {
      if (seenLaneKeys.has(key)) continue;
      // A lane that no longer satisfies the full interior/spacing test must
      // stop immediately; active ripples release on the next frame.
      lane.acceptingSpawns = false;
      this.lanes.delete(key);
    }
  }

  private spawnFromLanes(timeSeconds: number): void {
    for (const lane of this.lanes.values()) {
      if (!lane.acceptingSpawns || lane.totalLength < lane.spacing) continue;
      if (timeSeconds < lane.nextSpawnTime) continue;
      this.spawnRipple(lane, 0);
      lane.nextSpawnTime = timeSeconds + lane.spacing / lane.visualSpeed;
    }
  }

  private prewarmLane(lane: FlowLane): void {
    const offset = lane.spacing * (0.35 + this.hash(lane.key, 31) * 0.45);
    for (let headDistance = offset; headDistance < lane.totalLength; headDistance += lane.spacing) {
      this.spawnRipple(lane, headDistance);
    }
  }

  private spawnRipple(lane: FlowLane, prewarmHeadDistance: number): void {
    const ripple = this.freeRipples.pop() ?? this.createRipple();
    const seed = lane.spawnSequence;
    lane.spawnSequence += 1;
    ripple.lane = lane;
    ripple.length = THREE.MathUtils.lerp(1.15, 2.05, this.hash(lane.key, seed + 41));
    ripple.width = THREE.MathUtils.lerp(0.128, 0.218, this.hash(lane.key, seed + 73));
    ripple.speedScale = THREE.MathUtils.lerp(0.9, 1.08, this.hash(lane.key, seed + 97));
    ripple.tone = this.hash(lane.key, seed + 113);
    ripple.opacity = THREE.MathUtils.lerp(0.92, 0.99, this.hash(lane.key, seed + 137));
    ripple.fadeInSeconds = THREE.MathUtils.lerp(0.28, 0.48, this.hash(lane.key, seed + 151));
    ripple.age = prewarmHeadDistance > 0 ? ripple.fadeInSeconds : 0;
    ripple.headDistance = prewarmHeadDistance > 0
      ? Math.max(ripple.length, prewarmHeadDistance)
      : ripple.length;
    if (ripple.headDistance >= lane.totalLength) {
      this.releaseRipple(ripple);
      return;
    }
    this.activeRipples.push(ripple);
  }

  private advanceRipples(deltaTime: number): void {
    const fields = this.fields;
    if (!fields) return;
    const sample: PathSample = { x: 0, y: 0, z: 0 };
    const before: PathSample = { x: 0, y: 0, z: 0 };
    const after: PathSample = { x: 0, y: 0, z: 0 };
    let write = 0;
    for (let read = 0; read < this.activeRipples.length; read += 1) {
      const ripple = this.activeRipples[read];
      const lane = ripple.lane;
      if (!lane) continue;
      if (!lane.acceptingSpawns) {
        this.releaseRipple(ripple);
        continue;
      }
      ripple.age += deltaTime;
      ripple.headDistance += lane.visualSpeed * ripple.speedScale * deltaTime;
      if (
        ripple.headDistance >= lane.totalLength
        || !this.isRippleInsideWater(ripple, fields, sample, before, after)
      ) {
        this.releaseRipple(ripple);
        continue;
      }
      this.activeRipples[write] = ripple;
      write += 1;
    }
    this.activeRipples.length = write;
  }

  private uploadGeometry(): void {
    const count = this.activeRipples.length;
    this.ensureRibbonCapacity(count);
    const geometry = this.mesh.geometry;
    const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const uvs = (geometry.getAttribute("flowUv") as THREE.BufferAttribute).array as Float32Array;
    const alphas = (geometry.getAttribute("rippleAlpha") as THREE.BufferAttribute).array as Float32Array;
    const tones = (geometry.getAttribute("rippleTone") as THREE.BufferAttribute).array as Float32Array;
    const sample: PathSample = { x: 0, y: 0, z: 0 };
    const before: PathSample = { x: 0, y: 0, z: 0 };
    const after: PathSample = { x: 0, y: 0, z: 0 };

    for (let rippleIndex = 0; rippleIndex < count; rippleIndex += 1) {
      const ripple = this.activeRipples[rippleIndex];
      const lane = ripple.lane!;
      const fadeIn = THREE.MathUtils.smoothstep(ripple.age, 0, ripple.fadeInSeconds);
      const fadeOutDistance = Math.max(ripple.length * 0.9, lane.visualSpeed * 0.45);
      const fadeOut = THREE.MathUtils.smoothstep(
        lane.totalLength - ripple.headDistance,
        0,
        fadeOutDistance,
      );
      const alpha = ripple.opacity * fadeIn * fadeOut;
      let fallbackSideX = 1;
      let fallbackSideZ = 0;

      for (let segment = 0; segment <= RIBBON_SEGMENTS; segment += 1) {
        const along = segment / RIBBON_SEGMENTS;
        const distance = ripple.headDistance - ripple.length + ripple.length * along;
        this.samplePath(lane, distance, sample);
        this.samplePath(lane, Math.max(0, distance - 0.12), before);
        this.samplePath(lane, Math.min(lane.totalLength, distance + 0.12), after);
        const tangentX = after.x - before.x;
        const tangentZ = after.z - before.z;
        const tangentLength = Math.hypot(tangentX, tangentZ);
        let sideX = fallbackSideX;
        let sideZ = fallbackSideZ;
        if (tangentLength > 0.00001) {
          sideX = -tangentZ / tangentLength;
          sideZ = tangentX / tangentLength;
          fallbackSideX = sideX;
          fallbackSideZ = sideZ;
        }
        const taper = 0.72 + Math.sin(along * Math.PI) * 0.28;
        const halfWidth = ripple.width * taper * 0.5;
        const baseVertex = (rippleIndex * (RIBBON_SEGMENTS + 1) + segment) * 2;
        for (let side = 0; side < 2; side += 1) {
          const sign = side === 0 ? -1 : 1;
          const vertex = baseVertex + side;
          const positionOffset = vertex * 3;
          const uvOffset = vertex * 2;
          positions[positionOffset] = sample.x + sideX * halfWidth * sign;
          positions[positionOffset + 1] = sample.y + 0.012;
          positions[positionOffset + 2] = sample.z + sideZ * halfWidth * sign;
          uvs[uvOffset] = along;
          uvs[uvOffset + 1] = side;
          alphas[vertex] = alpha;
          tones[vertex] = ripple.tone;
        }
      }
    }

    const vertexCount = count * (RIBBON_SEGMENTS + 1) * 2;
    this.updateAttribute(geometry.getAttribute("position") as THREE.BufferAttribute, vertexCount * 3);
    this.updateAttribute(geometry.getAttribute("flowUv") as THREE.BufferAttribute, vertexCount * 2);
    this.updateAttribute(geometry.getAttribute("rippleAlpha") as THREE.BufferAttribute, vertexCount);
    this.updateAttribute(geometry.getAttribute("rippleTone") as THREE.BufferAttribute, vertexCount);
    geometry.setDrawRange(0, count * RIBBON_SEGMENTS * 6);
    this.mesh.visible = count > 0;
  }

  private buildWorldPath(
    path2D: number[],
    fields: RiverFlowFields,
  ): { positions: Float32Array; distances: Float32Array; totalLength: number } | null {
    const positions: number[] = [];
    const pushPoint = (x: number, y: number, z: number): void => {
      positions.push(x, y, z);
    };
    let previousX = path2D[0];
    let previousZ = path2D[1];
    let previousY = this.sampleBilinear(fields.surfaceHeights, previousX, previousZ) + 0.02;
    pushPoint(previousX, previousY, previousZ);

    for (let index = 2; index < path2D.length; index += 2) {
      const x = path2D[index];
      const z = path2D[index + 1];
      const y = this.sampleBilinear(fields.surfaceHeights, x, z) + 0.02;
      const drop = previousY - y;
      if (drop > 0.8) {
        const subdivisions = THREE.MathUtils.clamp(Math.ceil(drop / 0.65), 2, 14);
        const directionX = x - previousX;
        const directionZ = z - previousZ;
        const horizontalLength = Math.hypot(directionX, directionZ);
        const normalizedX = horizontalLength > 0.0001 ? directionX / horizontalLength : 0;
        const normalizedZ = horizontalLength > 0.0001 ? directionZ / horizontalLength : 0;
        const bow = Math.min(this.terrain.cellSize * 0.2, drop * 0.035);
        for (let division = 1; division <= subdivisions; division += 1) {
          const t = division / subdivisions;
          const outward = Math.sin(t * Math.PI) * bow;
          pushPoint(
            THREE.MathUtils.lerp(previousX, x, t) + normalizedX * outward,
            THREE.MathUtils.lerp(previousY, y, t),
            THREE.MathUtils.lerp(previousZ, z, t) + normalizedZ * outward,
          );
        }
      } else {
        pushPoint(x, y, z);
      }
      previousX = x;
      previousY = y;
      previousZ = z;
    }
    if (positions.length < 6) return null;

    const pointCount = positions.length / 3;
    const distances = new Float32Array(pointCount);
    let totalLength = 0;
    for (let point = 1; point < pointCount; point += 1) {
      const previousOffset = (point - 1) * 3;
      const offset = point * 3;
      const horizontalDistance = Math.hypot(
        positions[offset] - positions[previousOffset],
        positions[offset + 2] - positions[previousOffset + 2],
      );
      const verticalDistance = Math.abs(positions[offset + 1] - positions[previousOffset + 1]);
      // The same s parameter continues down a fall, but vertical distance is
      // compressed so a crest accelerates and stretches instead of taking
      // many seconds to crawl down a tall cliff.
      totalLength += Math.hypot(horizontalDistance, verticalDistance * 0.28);
      distances[point] = totalLength;
    }
    return { positions: new Float32Array(positions), distances, totalLength };
  }

  private trimToRiver(points: number[], fields: RiverFlowFields): number[] {
    const trimmed: number[] = [];
    for (let index = 0; index < points.length; index += 2) {
      const worldX = points[index];
      const worldZ = points[index + 1];
      if (!this.isRiverWorldPoint(worldX, worldZ, fields)) break;
      trimmed.push(worldX, worldZ);
    }
    return trimmed;
  }

  private combineDirections(upstream: number[], downstream: number[]): number[] {
    const combined: number[] = [];
    for (let index = upstream.length - 2; index >= 0; index -= 2) {
      combined.push(upstream[index], upstream[index + 1]);
    }
    for (let index = 2; index < downstream.length; index += 2) {
      combined.push(downstream[index], downstream[index + 1]);
    }
    return combined;
  }

  private markLaneSpacing(path2D: number[]): void {
    const resolutionX = this.terrain.resolutionX;
    const resolutionZ = this.terrain.resolutionZ;
    for (let offset = 0; offset < path2D.length; offset += 2) {
      const centerX = Math.round((path2D[offset] + WORLD_CONFIG.sizeX * 0.5) / this.terrain.cellSize);
      const centerZ = Math.round((path2D[offset + 1] + WORLD_CONFIG.sizeZ * 0.5) / this.terrain.cellSize);
      for (let dz = -MIN_LANE_SPACING_CELLS; dz <= MIN_LANE_SPACING_CELLS; dz += 1) {
        const z = centerZ + dz;
        if (z < 0 || z >= resolutionZ) continue;
        for (let dx = -MIN_LANE_SPACING_CELLS; dx <= MIN_LANE_SPACING_CELLS; dx += 1) {
          if (dx * dx + dz * dz > MIN_LANE_SPACING_CELLS * MIN_LANE_SPACING_CELLS) continue;
          const x = centerX + dx;
          if (x < 0 || x >= resolutionX) continue;
          this.laneOccupancy[z * resolutionX + x] = 1;
        }
      }
    }
  }

  private pathTouchesOccupiedLane(path2D: number[]): boolean {
    const resolutionX = this.terrain.resolutionX;
    const resolutionZ = this.terrain.resolutionZ;
    for (let offset = 0; offset < path2D.length; offset += 2) {
      const x = Math.round((path2D[offset] + WORLD_CONFIG.sizeX * 0.5) / this.terrain.cellSize);
      const z = Math.round((path2D[offset + 1] + WORLD_CONFIG.sizeZ * 0.5) / this.terrain.cellSize);
      if (x < 0 || x >= resolutionX || z < 0 || z >= resolutionZ) return true;
      if (this.laneOccupancy[z * resolutionX + x] !== 0) return true;
    }
    return false;
  }

  private isRiverCell(index: number, fields: RiverFlowFields, confidence: number): boolean {
    return confidence >= MIN_FLOW_CONFIDENCE
      && fields.coverage[index] >= 135
      && fields.depth[index] > 0.00004
      && fields.flowSpeed[index] >= 0.045
      && this.riverWeight(fields.lakeFactor[index]) > 0.08;
  }

  private getLateralInteriorScore(
    gridX: number,
    gridZ: number,
    directionX: number,
    directionZ: number,
    fields: RiverFlowFields,
  ): number {
    const worldX = gridX * this.terrain.cellSize - WORLD_CONFIG.sizeX * 0.5;
    const worldZ = gridZ * this.terrain.cellSize - WORLD_CONFIG.sizeZ * 0.5;
    const sideX = -directionZ;
    const sideZ = directionX;
    let leftClearance = 0;
    let rightClearance = 0;
    let leftOpen = true;
    let rightOpen = true;
    for (let step = 1; step <= 4; step += 1) {
      const distance = this.terrain.cellSize * step * 0.72;
      if (leftOpen) {
        leftOpen = this.isWetCrossSectionPoint(
          worldX + sideX * distance,
          worldZ + sideZ * distance,
          fields,
        );
        if (leftOpen) leftClearance = step;
      }
      if (rightOpen) {
        rightOpen = this.isWetCrossSectionPoint(
          worldX - sideX * distance,
          worldZ - sideZ * distance,
          fields,
        );
        if (rightOpen) rightClearance = step;
      }
    }
    return Math.min(leftClearance, rightClearance)
      + (leftClearance + rightClearance) * 0.18;
  }

  private isWetCrossSectionPoint(
    worldX: number,
    worldZ: number,
    fields: RiverFlowFields,
  ): boolean {
    if (!this.isInsideWorld(worldX, worldZ)) return false;
    return this.sampleBilinear(fields.coverage, worldX, worldZ) >= INTERIOR_COVERAGE
      && this.sampleBilinear(fields.depth, worldX, worldZ) > 0.00002
      && this.riverWeight(this.sampleBilinear(fields.lakeFactor, worldX, worldZ)) > 0.025;
  }

  private isRiverWorldPoint(worldX: number, worldZ: number, fields: RiverFlowFields): boolean {
    if (!this.isWetCrossSectionPoint(worldX, worldZ, fields)) return false;
    this.visualFlowField.sampleWorld(worldX, worldZ, this.flowSample);
    if (this.flowSample.confidence < MIN_FLOW_CONFIDENCE * 0.72) return false;
    const sideX = -this.flowSample.directionZ;
    const sideZ = this.flowSample.directionX;
    const margin = this.terrain.cellSize * 0.58;
    return this.isWetCrossSectionPoint(worldX + sideX * margin, worldZ + sideZ * margin, fields)
      && this.isWetCrossSectionPoint(worldX - sideX * margin, worldZ - sideZ * margin, fields);
  }

  private isRippleInsideWater(
    ripple: FlowRipple,
    fields: RiverFlowFields,
    sample: PathSample,
    before: PathSample,
    after: PathSample,
  ): boolean {
    const lane = ripple.lane;
    if (!lane) return false;
    for (let check = 0; check < 3; check += 1) {
      const along = 0.12 + check * 0.38;
      const distance = ripple.headDistance - ripple.length + ripple.length * along;
      this.samplePath(lane, distance, sample);
      this.samplePath(lane, Math.max(0, distance - 0.12), before);
      this.samplePath(lane, Math.min(lane.totalLength, distance + 0.12), after);
      const tangentX = after.x - before.x;
      const tangentZ = after.z - before.z;
      const tangentLength = Math.hypot(tangentX, tangentZ);
      if (tangentLength < 0.00001) return false;
      const sideX = -tangentZ / tangentLength;
      const sideZ = tangentX / tangentLength;
      const margin = this.terrain.cellSize * 0.52 + ripple.width * 0.55;
      if (
        !this.isWetCrossSectionPoint(sample.x, sample.z, fields)
        || !this.isWetCrossSectionPoint(sample.x + sideX * margin, sample.z + sideZ * margin, fields)
        || !this.isWetCrossSectionPoint(sample.x - sideX * margin, sample.z - sideZ * margin, fields)
      ) return false;
    }
    return true;
  }

  private riverWeight(lakeFactor: number): number {
    return 1 - THREE.MathUtils.smoothstep(lakeFactor, 0.52, 0.78);
  }

  private isInsideWorld(worldX: number, worldZ: number): boolean {
    return worldX >= -WORLD_CONFIG.sizeX * 0.5
      && worldX <= WORLD_CONFIG.sizeX * 0.5
      && worldZ >= -WORLD_CONFIG.sizeZ * 0.5
      && worldZ <= WORLD_CONFIG.sizeZ * 0.5;
  }

  private sampleBilinear(values: Float32Array | Uint8Array, worldX: number, worldZ: number): number {
    const gridX = THREE.MathUtils.clamp(
      (worldX + WORLD_CONFIG.sizeX * 0.5) / this.terrain.cellSize,
      0,
      this.terrain.resolutionX - 1,
    );
    const gridZ = THREE.MathUtils.clamp(
      (worldZ + WORLD_CONFIG.sizeZ * 0.5) / this.terrain.cellSize,
      0,
      this.terrain.resolutionZ - 1,
    );
    const x0 = Math.floor(gridX);
    const z0 = Math.floor(gridZ);
    const x1 = Math.min(this.terrain.resolutionX - 1, x0 + 1);
    const z1 = Math.min(this.terrain.resolutionZ - 1, z0 + 1);
    const tx = gridX - x0;
    const tz = gridZ - z0;
    const row0 = z0 * this.terrain.resolutionX;
    const row1 = z1 * this.terrain.resolutionX;
    const a = THREE.MathUtils.lerp(values[row0 + x0], values[row0 + x1], tx);
    const b = THREE.MathUtils.lerp(values[row1 + x0], values[row1 + x1], tx);
    return THREE.MathUtils.lerp(a, b, tz);
  }

  private samplePath(lane: FlowLane, distance: number, output: PathSample): void {
    const target = THREE.MathUtils.clamp(distance, 0, lane.totalLength);
    let low = 0;
    let high = lane.distances.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (lane.distances[middle] <= target) low = middle;
      else high = middle;
    }
    const startDistance = lane.distances[low];
    const endDistance = lane.distances[high];
    const t = endDistance > startDistance
      ? (target - startDistance) / (endDistance - startDistance)
      : 0;
    const startOffset = low * 3;
    const endOffset = high * 3;
    output.x = THREE.MathUtils.lerp(lane.positions[startOffset], lane.positions[endOffset], t);
    output.y = THREE.MathUtils.lerp(lane.positions[startOffset + 1], lane.positions[endOffset + 1], t);
    output.z = THREE.MathUtils.lerp(lane.positions[startOffset + 2], lane.positions[endOffset + 2], t);
  }

  private pathStartKey(positions: Float32Array): number {
    const x = THREE.MathUtils.clamp(
      Math.round((positions[0] + WORLD_CONFIG.sizeX * 0.5) / this.terrain.cellSize),
      0,
      this.terrain.resolutionX - 1,
    );
    const z = THREE.MathUtils.clamp(
      Math.round((positions[2] + WORLD_CONFIG.sizeZ * 0.5) / this.terrain.cellSize),
      0,
      this.terrain.resolutionZ - 1,
    );
    return z * this.terrain.resolutionX + x;
  }

  private countActiveRipplesByLane(): Map<FlowLane, number> {
    const counts = new Map<FlowLane, number>();
    for (const ripple of this.activeRipples) {
      if (!ripple.lane) continue;
      counts.set(ripple.lane, (counts.get(ripple.lane) ?? 0) + 1);
    }
    return counts;
  }

  private createRipple(): FlowRipple {
    return {
      lane: null,
      headDistance: 0,
      length: 0,
      width: 0,
      speedScale: 1,
      tone: 0,
      opacity: 0,
      age: 0,
      fadeInSeconds: 0.35,
    };
  }

  private releaseRipple(ripple: FlowRipple): void {
    ripple.lane = null;
    this.freeRipples.push(ripple);
  }

  private ensureRibbonCapacity(required: number): void {
    if (required <= this.ribbonCapacity) return;
    while (this.ribbonCapacity < required) this.ribbonCapacity *= 2;
    const previous = this.mesh.geometry;
    this.mesh.geometry = this.createGeometry(this.ribbonCapacity);
    previous.dispose();
  }

  private createGeometry(capacity: number): THREE.BufferGeometry {
    const verticesPerRibbon = (RIBBON_SEGMENTS + 1) * 2;
    const vertexCount = capacity * verticesPerRibbon;
    const indices = new Uint32Array(capacity * RIBBON_SEGMENTS * 6);
    for (let ribbon = 0; ribbon < capacity; ribbon += 1) {
      const vertexBase = ribbon * verticesPerRibbon;
      const indexBase = ribbon * RIBBON_SEGMENTS * 6;
      for (let segment = 0; segment < RIBBON_SEGMENTS; segment += 1) {
        const a = vertexBase + segment * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        const offset = indexBase + segment * 6;
        indices[offset] = a;
        indices[offset + 1] = c;
        indices[offset + 2] = b;
        indices[offset + 3] = b;
        indices[offset + 4] = c;
        indices[offset + 5] = d;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("flowUv", new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("rippleAlpha", new THREE.BufferAttribute(new Float32Array(vertexCount), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("rippleTone", new THREE.BufferAttribute(new Float32Array(vertexCount), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    return geometry;
  }

  private createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
      uniforms: {
        uTime: { value: 0 },
        crestColor: { value: new THREE.Color("#ffffff") },
      },
      vertexShader: `
        attribute vec2 flowUv;
        attribute float rippleAlpha;
        attribute float rippleTone;
        varying vec2 vFlowUv;
        varying float vRippleAlpha;
        varying float vRippleTone;
        void main() {
          vFlowUv = flowUv;
          vRippleAlpha = rippleAlpha;
          vRippleTone = rippleTone;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 crestColor;
        varying vec2 vFlowUv;
        varying float vRippleAlpha;
        varying float vRippleTone;
        void main() {
          float bodyCoordinate = abs(vFlowUv.y * 2.0 - 1.0);
          float phase = vRippleTone * 6.2831853;
          float broadSection = 0.5 + 0.5 * sin(vFlowUv.x * 18.8495559 - uTime * 0.62 + phase);
          float smallSection = 0.5 + 0.5 * sin(vFlowUv.x * 34.5575192 + uTime * 0.27 + phase * 1.73);
          float slowSection = 0.5 + 0.5 * sin(vFlowUv.x * 9.4247779 - uTime * 0.18 + phase * 0.43);
          float sectionShape = broadSection * 0.52 + smallSection * 0.33 + slowSection * 0.15;
          float widthSection = mix(0.36, 1.0, sectionShape);
          float widthMask = 1.0 - smoothstep(
            max(0.0, widthSection - 0.12),
            widthSection,
            bodyCoordinate
          );
          float headTail = smoothstep(0.0, 0.055, vFlowUv.x)
            * smoothstep(0.0, 0.065, 1.0 - vFlowUv.x);
          float alpha = vRippleAlpha * widthMask * headTail;
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(crestColor, alpha);
        }
      `,
    });
  }

  private updateAttribute(attribute: THREE.BufferAttribute, usedValues: number): void {
    attribute.clearUpdateRanges();
    if (usedValues > 0) attribute.addUpdateRange(0, usedValues);
    attribute.needsUpdate = true;
  }

  private hash(a: number, b: number): number {
    const value = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return value - Math.floor(value);
  }
}
