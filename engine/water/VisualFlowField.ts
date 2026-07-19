import { WORLD_CONFIG } from "@/engine/config";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

const MIN_VISUAL_FLOW_DEPTH = 0.00004;
const FLUX_MEMORY_SECONDS = 0.52;
const DIRECTION_LAG_SECONDS = 0.38;
const CONFIDENCE_LAG_SECONDS = 0.3;
const SPATIAL_SMOOTHING_PASSES = 2;
const FLUX_CONFIDENCE_SCALE = 0.035;

export type VisualFlowSample = {
  directionX: number;
  directionZ: number;
  confidence: number;
};

export type VisualFlowUpdate = {
  depth: Float32Array;
  edgeFluxX: Float32Array;
  edgeFluxZ: Float32Array;
  outgoingFlux: Float32Array;
  incomingFlux: Float32Array;
  updatedCellMarks: Uint32Array;
  updatedCellMark: number;
};

/**
 * A render-only flow field built from a short history of actual cell-edge
 * transfers. It is deliberately separate from the instantaneous physics
 * direction so visual streamlines cannot inherit one-cell, one-frame turns.
 */
export class VisualFlowField {
  readonly directionX: Float32Array;
  readonly directionZ: Float32Array;
  readonly confidence: Float32Array;

  private readonly resolutionX: number;
  private readonly resolutionZ: number;
  private readonly cellSize: number;
  private readonly accumulatedFluxX: Float32Array;
  private readonly accumulatedFluxZ: Float32Array;
  private readonly accumulatedTraffic: Float32Array;
  private readonly smoothX: Float32Array;
  private readonly smoothZ: Float32Array;
  private readonly smoothTraffic: Float32Array;
  private readonly scratchX: Float32Array;
  private readonly scratchZ: Float32Array;
  private readonly scratchTraffic: Float32Array;

  constructor(private readonly terrain: TerrainSystem) {
    this.resolutionX = terrain.resolutionX;
    this.resolutionZ = terrain.resolutionZ;
    this.cellSize = terrain.cellSize;
    const cellCount = this.resolutionX * this.resolutionZ;
    this.directionX = new Float32Array(cellCount);
    this.directionZ = new Float32Array(cellCount);
    this.confidence = new Float32Array(cellCount);
    this.accumulatedFluxX = new Float32Array(cellCount);
    this.accumulatedFluxZ = new Float32Array(cellCount);
    this.accumulatedTraffic = new Float32Array(cellCount);
    this.smoothX = new Float32Array(cellCount);
    this.smoothZ = new Float32Array(cellCount);
    this.smoothTraffic = new Float32Array(cellCount);
    this.scratchX = new Float32Array(cellCount);
    this.scratchZ = new Float32Array(cellCount);
    this.scratchTraffic = new Float32Array(cellCount);
  }

  update(deltaTime: number, fields: VisualFlowUpdate): void {
    const safeDelta = Math.max(0.001, deltaTime);
    const fluxResponse = 1 - Math.exp(-safeDelta / FLUX_MEMORY_SECONDS);
    const directionResponse = 1 - Math.exp(-safeDelta / DIRECTION_LAG_SECONDS);
    const confidenceResponse = 1 - Math.exp(-safeDelta / CONFIDENCE_LAG_SECONDS);

    for (let index = 0; index < this.directionX.length; index += 1) {
      if (fields.depth[index] <= MIN_VISUAL_FLOW_DEPTH) {
        this.accumulatedFluxX[index] = 0;
        this.accumulatedFluxZ[index] = 0;
        this.accumulatedTraffic[index] = 0;
        this.smoothX[index] = 0;
        this.smoothZ[index] = 0;
        this.smoothTraffic[index] = 0;
        this.directionX[index] = 0;
        this.directionZ[index] = 0;
        this.confidence[index] = 0;
        continue;
      }

      const updated = fields.updatedCellMarks[index] === fields.updatedCellMark;
      const rawFluxX = updated ? fields.edgeFluxX[index] / safeDelta : 0;
      const rawFluxZ = updated ? fields.edgeFluxZ[index] / safeDelta : 0;
      const rawTraffic = updated
        ? (fields.outgoingFlux[index] + fields.incomingFlux[index] * 0.42) / safeDelta
        : 0;
      this.accumulatedFluxX[index] += (rawFluxX - this.accumulatedFluxX[index]) * fluxResponse;
      this.accumulatedFluxZ[index] += (rawFluxZ - this.accumulatedFluxZ[index]) * fluxResponse;
      this.accumulatedTraffic[index] += (rawTraffic - this.accumulatedTraffic[index]) * fluxResponse;
      this.smoothX[index] = this.accumulatedFluxX[index];
      this.smoothZ[index] = this.accumulatedFluxZ[index];
      this.smoothTraffic[index] = this.accumulatedTraffic[index];
    }

    let inputX = this.smoothX;
    let inputZ = this.smoothZ;
    let inputTraffic = this.smoothTraffic;
    let outputX = this.scratchX;
    let outputZ = this.scratchZ;
    let outputTraffic = this.scratchTraffic;
    for (let pass = 0; pass < SPATIAL_SMOOTHING_PASSES; pass += 1) {
      this.smoothWetCells(
        fields.depth,
        inputX,
        inputZ,
        inputTraffic,
        outputX,
        outputZ,
        outputTraffic,
      );
      [inputX, outputX] = [outputX, inputX];
      [inputZ, outputZ] = [outputZ, inputZ];
      [inputTraffic, outputTraffic] = [outputTraffic, inputTraffic];
    }

    for (let index = 0; index < this.directionX.length; index += 1) {
      if (fields.depth[index] <= MIN_VISUAL_FLOW_DEPTH) continue;
      const targetX = inputX[index];
      const targetZ = inputZ[index];
      const targetLength = Math.hypot(targetX, targetZ);
      const traffic = Math.max(0, inputTraffic[index]);
      const coherence = Math.min(1, targetLength / Math.max(traffic, 0.000001));
      const intensity = 1 - Math.exp(-traffic / FLUX_CONFIDENCE_SCALE);
      const targetConfidence = intensity * Math.pow(coherence, 0.7);

      if (targetLength > 0.000001 && targetConfidence > 0.001) {
        const normalizedX = targetX / targetLength;
        const normalizedZ = targetZ / targetLength;
        this.directionX[index] += (normalizedX - this.directionX[index]) * directionResponse;
        this.directionZ[index] += (normalizedZ - this.directionZ[index]) * directionResponse;
        const directionLength = Math.hypot(this.directionX[index], this.directionZ[index]);
        if (directionLength > 0.000001) {
          this.directionX[index] /= directionLength;
          this.directionZ[index] /= directionLength;
        }
      }
      this.confidence[index] += (targetConfidence - this.confidence[index]) * confidenceResponse;
      if (this.confidence[index] < 0.001) {
        this.confidence[index] = 0;
        this.directionX[index] = 0;
        this.directionZ[index] = 0;
      }
    }
  }

  clear(): void {
    this.directionX.fill(0);
    this.directionZ.fill(0);
    this.confidence.fill(0);
    this.accumulatedFluxX.fill(0);
    this.accumulatedFluxZ.fill(0);
    this.accumulatedTraffic.fill(0);
    this.smoothX.fill(0);
    this.smoothZ.fill(0);
    this.smoothTraffic.fill(0);
    this.scratchX.fill(0);
    this.scratchZ.fill(0);
    this.scratchTraffic.fill(0);
  }

  sampleWorld(worldX: number, worldZ: number, output: VisualFlowSample): VisualFlowSample {
    const gridX = (worldX + WORLD_CONFIG.sizeX * 0.5) / this.cellSize;
    const gridZ = (worldZ + WORLD_CONFIG.sizeZ * 0.5) / this.cellSize;
    if (
      gridX < 0
      || gridZ < 0
      || gridX > this.resolutionX - 1
      || gridZ > this.resolutionZ - 1
    ) {
      output.directionX = 0;
      output.directionZ = 0;
      output.confidence = 0;
      return output;
    }

    output.directionX = this.sampleBilinear(this.directionX, gridX, gridZ);
    output.directionZ = this.sampleBilinear(this.directionZ, gridX, gridZ);
    output.confidence = this.sampleBilinear(this.confidence, gridX, gridZ);
    const length = Math.hypot(output.directionX, output.directionZ);
    if (length > 0.000001) {
      output.directionX /= length;
      output.directionZ /= length;
    } else {
      output.directionX = 0;
      output.directionZ = 0;
      output.confidence = 0;
    }
    return output;
  }

  /** Trace a continuous streamline using bilinear field samples and RK2. */
  traceRK2(
    startWorldX: number,
    startWorldZ: number,
    directionSign: 1 | -1,
    stepDistance: number,
    maxSteps: number,
    minimumConfidence = 0.08,
  ): number[] {
    const points = [startWorldX, startWorldZ];
    const currentSample: VisualFlowSample = { directionX: 0, directionZ: 0, confidence: 0 };
    const midpointSample: VisualFlowSample = { directionX: 0, directionZ: 0, confidence: 0 };
    const visits = new Map<number, number>();
    let x = startWorldX;
    let z = startWorldZ;

    for (let step = 0; step < maxSteps; step += 1) {
      this.sampleWorld(x, z, currentSample);
      if (currentSample.confidence < minimumConfidence) break;
      const midpointX = x + currentSample.directionX * directionSign * stepDistance * 0.5;
      const midpointZ = z + currentSample.directionZ * directionSign * stepDistance * 0.5;
      this.sampleWorld(midpointX, midpointZ, midpointSample);
      if (midpointSample.confidence < minimumConfidence * 0.72) break;

      const nextX = x + midpointSample.directionX * directionSign * stepDistance;
      const nextZ = z + midpointSample.directionZ * directionSign * stepDistance;
      if (!this.isInsideWorld(nextX, nextZ)) break;
      if (Math.hypot(nextX - x, nextZ - z) < stepDistance * 0.3) break;

      x = nextX;
      z = nextZ;
      points.push(x, z);
      const gridX = Math.round((x + WORLD_CONFIG.sizeX * 0.5) / this.cellSize);
      const gridZ = Math.round((z + WORLD_CONFIG.sizeZ * 0.5) / this.cellSize);
      const index = gridZ * this.resolutionX + gridX;
      const visitCount = (visits.get(index) ?? 0) + 1;
      if (visitCount > 3) break;
      visits.set(index, visitCount);
    }
    return points;
  }

  private smoothWetCells(
    depth: Float32Array,
    inputX: Float32Array,
    inputZ: Float32Array,
    inputTraffic: Float32Array,
    outputX: Float32Array,
    outputZ: Float32Array,
    outputTraffic: Float32Array,
  ): void {
    for (let z = 0; z < this.resolutionZ; z += 1) {
      for (let x = 0; x < this.resolutionX; x += 1) {
        const index = z * this.resolutionX + x;
        if (depth[index] <= MIN_VISUAL_FLOW_DEPTH) {
          outputX[index] = 0;
          outputZ[index] = 0;
          outputTraffic[index] = 0;
          continue;
        }

        const ownX = inputX[index];
        const ownZ = inputZ[index];
        const ownLength = Math.hypot(ownX, ownZ);
        let totalWeight = 2.35;
        let totalX = ownX * totalWeight;
        let totalZ = ownZ * totalWeight;
        let totalTraffic = inputTraffic[index] * totalWeight;
        for (let direction = 0; direction < 4; direction += 1) {
          let neighbor = -1;
          if (direction === 0 && x > 0) neighbor = index - 1;
          else if (direction === 1 && x < this.resolutionX - 1) neighbor = index + 1;
          else if (direction === 2 && z > 0) neighbor = index - this.resolutionX;
          else if (direction === 3 && z < this.resolutionZ - 1) neighbor = index + this.resolutionX;
          if (neighbor < 0 || depth[neighbor] <= MIN_VISUAL_FLOW_DEPTH) continue;
          const neighborX = inputX[neighbor];
          const neighborZ = inputZ[neighbor];
          const neighborLength = Math.hypot(neighborX, neighborZ);
          let alignmentGate = 1;
          if (ownLength > 0.000001 && neighborLength > 0.000001) {
            const alignment = (ownX * neighborX + ownZ * neighborZ) / (ownLength * neighborLength);
            alignmentGate = 0.24 + Math.max(0, alignment) * 0.76;
          }
          const depthRatio = Math.min(depth[index], depth[neighbor])
            / Math.max(depth[index], depth[neighbor], 0.000001);
          const weight = (0.42 + depthRatio * 0.34) * alignmentGate;
          totalWeight += weight;
          totalX += neighborX * weight;
          totalZ += neighborZ * weight;
          totalTraffic += inputTraffic[neighbor] * weight;
        }
        outputX[index] = totalX / totalWeight;
        outputZ[index] = totalZ / totalWeight;
        outputTraffic[index] = totalTraffic / totalWeight;
      }
    }
  }

  private sampleBilinear(values: Float32Array, gridX: number, gridZ: number): number {
    const x0 = Math.floor(gridX);
    const z0 = Math.floor(gridZ);
    const x1 = Math.min(this.resolutionX - 1, x0 + 1);
    const z1 = Math.min(this.resolutionZ - 1, z0 + 1);
    const tx = gridX - x0;
    const tz = gridZ - z0;
    const row0 = z0 * this.resolutionX;
    const row1 = z1 * this.resolutionX;
    const a = values[row0 + x0] + (values[row0 + x1] - values[row0 + x0]) * tx;
    const b = values[row1 + x0] + (values[row1 + x1] - values[row1 + x0]) * tx;
    return a + (b - a) * tz;
  }

  private isInsideWorld(worldX: number, worldZ: number): boolean {
    return worldX >= -WORLD_CONFIG.sizeX * 0.5
      && worldX <= WORLD_CONFIG.sizeX * 0.5
      && worldZ >= -WORLD_CONFIG.sizeZ * 0.5
      && worldZ <= WORLD_CONFIG.sizeZ * 0.5;
  }
}
