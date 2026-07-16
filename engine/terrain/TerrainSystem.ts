import * as THREE from "three";
import { TERRAIN_PALETTE, WATERED_TERRAIN_PALETTE, WORLD_CONFIG } from "@/engine/config";
import { hash2D } from "@/engine/math/random";
import { MountainGenerator } from "@/engine/terrain/MountainGenerator";
import type { MountainData, TerrainTool } from "@/engine/types";

type Point = [number, number, number];

export class TerrainSystem {
  readonly resolution = WORLD_CONFIG.segments + 1;
  readonly cellSize = WORLD_CONFIG.size / WORLD_CONFIG.segments;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  heights: Float32Array<ArrayBufferLike> = new Float32Array(this.resolution * this.resolution);
  sourceIndex = 0;
  peakIndex = 0;
  minHeight: number = WORLD_CONFIG.minHeight;
  maxHeight: number = WORLD_CONFIG.maxHeight;

  private originalHeights: Float32Array<ArrayBufferLike> = new Float32Array(this.heights.length);
  private readonly watered = new Uint8Array(this.resolution * this.resolution);
  private readonly permanentlyGreen = new Uint8Array(this.resolution * this.resolution);
  private readonly greenableCells = new Uint8Array(WORLD_CONFIG.segments * WORLD_CONFIG.segments);
  private dryColors = new Float32Array(0);
  private wateredColors = new Float32Array(0);
  private readonly generator = new MountainGenerator();
  private seedHash = 0;

  constructor(private readonly scene: THREE.Scene, seed: string) {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.93,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = "procedural-mountain";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);
    this.regenerate(seed);
  }

  regenerate(seed: string): MountainData {
    const mountain = this.generator.generate(seed);
    this.heights = mountain.heights;
    this.originalHeights = mountain.heights.slice();
    this.sourceIndex = mountain.sourceIndex;
    this.peakIndex = mountain.peakIndex;
    this.minHeight = mountain.minHeight;
    this.maxHeight = mountain.maxHeight;
    this.seedHash = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    this.watered.fill(0);
    this.permanentlyGreen.fill(0);
    this.rebuildGeometry();
    return mountain;
  }

  reset(): void {
    this.heights.set(this.originalHeights);
    this.recalculateRange();
    this.rebuildGeometry();
  }

  /** Apply the water-proximity mask used by both the terrain and nearby trees. */
  updateWateredArea(nextWatered: Uint8Array): void {
    if (nextWatered.length !== this.watered.length) return;

    let changed = false;
    for (let i = 0; i < this.watered.length; i += 1) {
      if (this.watered[i] === nextWatered[i]) continue;
      this.watered[i] = nextWatered[i];
      changed = true;
    }
    if (!changed) return;
    this.refreshTerrainColors();
  }

  /** Whether a world-space point is green due to paint or nearby water. */
  isGreenAt(worldX: number, worldZ: number): boolean {
    const { x, z } = this.worldToGrid(worldX, worldZ);
    const index = z * this.resolution + x;
    return this.permanentlyGreen[index] !== 0 || this.watered[index] !== 0;
  }

  getGroundPaintState(): number[] {
    return Array.from(this.permanentlyGreen);
  }

  loadGroundPaintState(state?: readonly number[]): void {
    this.permanentlyGreen.fill(0);
    if (state) {
      const length = Math.min(state.length, this.permanentlyGreen.length);
      for (let i = 0; i < length; i += 1) this.permanentlyGreen[i] = state[i] ? 1 : 0;
    }
    this.refreshTerrainColors();
  }

  /** Share of currently yellow, colorable ground that is green because of water. */
  getWateredYellowPercentage(): number {
    let yellowCells = 0;
    let wateredYellowCells = 0;

    for (let z = 0; z < WORLD_CONFIG.segments; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segments; x += 1) {
        const cellIndex = z * WORLD_CONFIG.segments + x;
        if (this.greenableCells[cellIndex] === 0 || this.cellHasPermanentGreen(x, z)) continue;
        yellowCells += 1;
        if (this.cellHasWater(x, z)) wateredYellowCells += 1;
      }
    }

    return yellowCells > 0 ? (wateredYellowCells / yellowCells) * 100 : 0;
  }

  applyBrush(
    worldX: number,
    worldZ: number,
    tool: TerrainTool,
    radius: number,
    strength: number,
    deltaTime: number,
  ): boolean {
    if (tool === "orbit") return false;
    const center = this.worldToGrid(worldX, worldZ);
    const gridRadius = Math.ceil(radius / this.cellSize);
    if (tool === "paint-green" || tool === "paint-yellow") {
      return this.applyGroundPaint(center, gridRadius, worldX, worldZ, radius, tool === "paint-green");
    }
    const before = tool === "smooth" ? this.heights.slice() : this.heights;
    let changed = false;

    for (let z = Math.max(1, center.z - gridRadius); z <= Math.min(this.resolution - 2, center.z + gridRadius); z += 1) {
      for (let x = Math.max(1, center.x - gridRadius); x <= Math.min(this.resolution - 2, center.x + gridRadius); x += 1) {
        const position = this.indexToWorld(z * this.resolution + x);
        const distance = Math.hypot(position.x - worldX, position.z - worldZ);
        if (distance >= radius) continue;
        const normalized = 1 - distance / radius;
        const falloff = normalized * normalized * (3 - 2 * normalized);
        const index = z * this.resolution + x;
        const current = this.heights[index];
        let next = current;

        if (tool === "smooth") {
          const average = (
            before[index] +
            before[index - 1] +
            before[index + 1] +
            before[index - this.resolution] +
            before[index + this.resolution]
          ) / 5;
          next = THREE.MathUtils.lerp(current, average, Math.min(1, deltaTime * strength * 0.55 * falloff));
        } else {
          const direction = tool === "carve" ? -1 : 1;
          next = current + direction * strength * deltaTime * falloff;
        }

        next = THREE.MathUtils.clamp(next, WORLD_CONFIG.minHeight, WORLD_CONFIG.maxHeight);
        if (Math.abs(next - current) > 0.00001) {
          this.heights[index] = next;
          changed = true;
        }
      }
    }

    if (changed) {
      this.recalculateRange();
      this.rebuildGeometry();
    }
    return changed;
  }

  heightAt(worldX: number, worldZ: number): number {
    const half = WORLD_CONFIG.size / 2;
    const gx = THREE.MathUtils.clamp((worldX + half) / this.cellSize, 0, WORLD_CONFIG.segments);
    const gz = THREE.MathUtils.clamp((worldZ + half) / this.cellSize, 0, WORLD_CONFIG.segments);
    const x0 = Math.min(WORLD_CONFIG.segments - 1, Math.floor(gx));
    const z0 = Math.min(WORLD_CONFIG.segments - 1, Math.floor(gz));
    const tx = gx - x0;
    const tz = gz - z0;
    const i00 = z0 * this.resolution + x0;
    const i10 = i00 + 1;
    const i01 = i00 + this.resolution;
    const i11 = i01 + 1;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.heights[i00], this.heights[i10], tx),
      THREE.MathUtils.lerp(this.heights[i01], this.heights[i11], tx),
      tz,
    );
  }

  slopeAt(worldX: number, worldZ: number): number {
    const left = this.heightAt(worldX - this.cellSize, worldZ);
    const right = this.heightAt(worldX + this.cellSize, worldZ);
    const back = this.heightAt(worldX, worldZ - this.cellSize);
    const front = this.heightAt(worldX, worldZ + this.cellSize);
    return Math.hypot(right - left, front - back) / (this.cellSize * 2);
  }

  indexToWorld(index: number): THREE.Vector3 {
    const x = index % this.resolution;
    const z = Math.floor(index / this.resolution);
    const half = WORLD_CONFIG.size / 2;
    return new THREE.Vector3(x * this.cellSize - half, this.heights[index], z * this.cellSize - half);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private worldToGrid(worldX: number, worldZ: number): { x: number; z: number } {
    const half = WORLD_CONFIG.size / 2;
    return {
      x: Math.round(THREE.MathUtils.clamp((worldX + half) / this.cellSize, 0, WORLD_CONFIG.segments)),
      z: Math.round(THREE.MathUtils.clamp((worldZ + half) / this.cellSize, 0, WORLD_CONFIG.segments)),
    };
  }

  private rebuildGeometry(): void {
    const verticesPerCell = 6;
    const positions = new Float32Array(WORLD_CONFIG.segments * WORLD_CONFIG.segments * verticesPerCell * 3);
    const colors = new Float32Array(positions.length);
    const dryColors = new Float32Array(positions.length);
    const wateredColors = new Float32Array(positions.length);
    const half = WORLD_CONFIG.size / 2;
    let cursor = 0;
    this.greenableCells.fill(0);

    const point = (x: number, z: number): Point => {
      const index = z * this.resolution + x;
      return [x * this.cellSize - half, this.heights[index], z * this.cellSize - half];
    };

    for (let z = 0; z < WORLD_CONFIG.segments; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segments; x += 1) {
        const p00 = point(x, z);
        const p10 = point(x + 1, z);
        const p01 = point(x, z + 1);
        const p11 = point(x + 1, z + 1);
        const triangles: [Point, Point, Point][] = (x + z) % 2 === 0
          ? [[p00, p01, p10], [p10, p01, p11]]
          : [[p00, p01, p11], [p00, p11, p10]];

        triangles.forEach((triangle, triangleIndex) => {
          const faceColors = this.faceColors(triangle, x, z, triangleIndex);
          if (!faceColors.dry.equals(faceColors.watered)) {
            this.greenableCells[z * WORLD_CONFIG.segments + x] = 1;
          }
          const color = this.cellIsGreen(x, z) ? faceColors.watered : faceColors.dry;
          for (const vertex of triangle) {
            positions[cursor] = vertex[0];
            colors[cursor] = color.r;
            dryColors[cursor] = faceColors.dry.r;
            wateredColors[cursor] = faceColors.watered.r;
            cursor += 1;
            positions[cursor] = vertex[1];
            colors[cursor] = color.g;
            dryColors[cursor] = faceColors.dry.g;
            wateredColors[cursor] = faceColors.watered.g;
            cursor += 1;
            positions[cursor] = vertex[2];
            colors[cursor] = color.b;
            dryColors[cursor] = faceColors.dry.b;
            wateredColors[cursor] = faceColors.watered.b;
            cursor += 1;
          }
        });
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.dryColors = dryColors;
    this.wateredColors = wateredColors;
  }

  private faceColors(
    triangle: [Point, Point, Point],
    x: number,
    z: number,
    triangleIndex: number,
  ): { dry: THREE.Color; watered: THREE.Color } {
    const [a, b, c] = triangle;
    const edgeA = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const edgeB = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const normal = edgeA.cross(edgeB).normalize();
    const slope = 1 - Math.max(0, normal.y);
    const height = (a[1] + b[1] + c[1]) / 3;
    const normalizedHeight = THREE.MathUtils.clamp((height - this.minHeight) / Math.max(1, this.maxHeight - this.minHeight), 0, 1);
    const variation = 0.91 + hash2D(x * 2 + triangleIndex, z, this.seedHash) * 0.16;
    let base: string = TERRAIN_PALETTE.meadow;
    let wateredBase: string = WATERED_TERRAIN_PALETTE.meadow;

    if (height < 0.6) {
      base = TERRAIN_PALETTE.valley;
      wateredBase = WATERED_TERRAIN_PALETTE.valley;
    } else if (normalizedHeight < 0.31) {
      const isEarth = slope > 0.42;
      base = isEarth ? TERRAIN_PALETTE.earth : TERRAIN_PALETTE.meadow;
      wateredBase = isEarth ? WATERED_TERRAIN_PALETTE.earth : WATERED_TERRAIN_PALETTE.meadow;
    } else if (normalizedHeight < 0.52) {
      const isRock = slope > 0.34;
      base = isRock ? TERRAIN_PALETTE.rock : TERRAIN_PALETTE.pine;
      wateredBase = isRock ? TERRAIN_PALETTE.rock : WATERED_TERRAIN_PALETTE.pine;
    } else if (normalizedHeight < 0.72) {
      base = slope > 0.18 ? TERRAIN_PALETTE.rock : TERRAIN_PALETTE.highRock;
      wateredBase = base;
    } else if (slope > 0.36) {
      base = TERRAIN_PALETTE.highRock;
      wateredBase = base;
    } else {
      base = normalizedHeight > 0.82 ? TERRAIN_PALETTE.snow : TERRAIN_PALETTE.snowShadow;
      wateredBase = base;
    }

    return {
      dry: new THREE.Color(base).multiplyScalar(variation),
      watered: new THREE.Color(wateredBase).multiplyScalar(variation),
    };
  }

  private cellIsGreen(x: number, z: number): boolean {
    const topLeft = z * this.resolution + x;
    return this.vertexIsGreen(topLeft)
      || this.vertexIsGreen(topLeft + 1)
      || this.vertexIsGreen(topLeft + this.resolution)
      || this.vertexIsGreen(topLeft + this.resolution + 1);
  }

  private cellHasPermanentGreen(x: number, z: number): boolean {
    const topLeft = z * this.resolution + x;
    return this.permanentlyGreen[topLeft] !== 0
      || this.permanentlyGreen[topLeft + 1] !== 0
      || this.permanentlyGreen[topLeft + this.resolution] !== 0
      || this.permanentlyGreen[topLeft + this.resolution + 1] !== 0;
  }

  private cellHasWater(x: number, z: number): boolean {
    const topLeft = z * this.resolution + x;
    return this.watered[topLeft] !== 0
      || this.watered[topLeft + 1] !== 0
      || this.watered[topLeft + this.resolution] !== 0
      || this.watered[topLeft + this.resolution + 1] !== 0;
  }

  private refreshTerrainColors(): void {
    const attribute = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (!attribute || this.dryColors.length !== attribute.array.length) return;
    const colors = attribute.array as Float32Array;
    const valuesPerCell = 18;
    let cursor = 0;

    for (let z = 0; z < WORLD_CONFIG.segments; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segments; x += 1) {
        const source = this.cellIsGreen(x, z) ? this.wateredColors : this.dryColors;
        for (let i = 0; i < valuesPerCell; i += 1) colors[cursor + i] = source[cursor + i];
        cursor += valuesPerCell;
      }
    }
    attribute.needsUpdate = true;
  }

  private vertexIsGreen(index: number): boolean {
    return this.permanentlyGreen[index] !== 0 || this.watered[index] !== 0;
  }

  private applyGroundPaint(
    center: { x: number; z: number },
    gridRadius: number,
    worldX: number,
    worldZ: number,
    radius: number,
    makeGreen: boolean,
  ): boolean {
    const nextValue = makeGreen ? 1 : 0;
    let changed = false;

    for (let z = Math.max(0, center.z - gridRadius); z <= Math.min(this.resolution - 1, center.z + gridRadius); z += 1) {
      for (let x = Math.max(0, center.x - gridRadius); x <= Math.min(this.resolution - 1, center.x + gridRadius); x += 1) {
        const index = z * this.resolution + x;
        const position = this.indexToWorld(index);
        if (Math.hypot(position.x - worldX, position.z - worldZ) >= radius) continue;
        if (this.permanentlyGreen[index] === nextValue) continue;
        this.permanentlyGreen[index] = nextValue;
        changed = true;
      }
    }

    if (changed) this.refreshTerrainColors();
    return changed;
  }

  private recalculateRange(): void {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let peak = 0;
    for (let i = 0; i < this.heights.length; i += 1) {
      minimum = Math.min(minimum, this.heights[i]);
      if (this.heights[i] > maximum) {
        maximum = this.heights[i];
        peak = i;
      }
    }
    this.minHeight = minimum;
    this.maxHeight = maximum;
    this.peakIndex = peak;
  }
}
