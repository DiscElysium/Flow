import * as THREE from "three";
import { TERRAIN_PALETTE, WORLD_CONFIG } from "@/engine/config";
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
    this.rebuildGeometry();
    return mountain;
  }

  reset(): void {
    this.heights.set(this.originalHeights);
    this.recalculateRange();
    this.rebuildGeometry();
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
    const half = WORLD_CONFIG.size / 2;
    let cursor = 0;

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
          const color = this.faceColor(triangle, x, z, triangleIndex);
          for (const vertex of triangle) {
            positions[cursor] = vertex[0];
            colors[cursor] = color.r;
            cursor += 1;
            positions[cursor] = vertex[1];
            colors[cursor] = color.g;
            cursor += 1;
            positions[cursor] = vertex[2];
            colors[cursor] = color.b;
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
  }

  private faceColor(triangle: [Point, Point, Point], x: number, z: number, triangleIndex: number): THREE.Color {
    const [a, b, c] = triangle;
    const edgeA = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const edgeB = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const normal = edgeA.cross(edgeB).normalize();
    const slope = 1 - Math.max(0, normal.y);
    const height = (a[1] + b[1] + c[1]) / 3;
    const normalizedX = ((x + 0.5) / WORLD_CONFIG.segments) * 2 - 1;
    const normalizedHeight = THREE.MathUtils.clamp((height - this.minHeight) / Math.max(1, this.maxHeight - this.minHeight), 0, 1);
    const variation = 0.91 + hash2D(x * 2 + triangleIndex, z, this.seedHash) * 0.16;
    let base: string = TERRAIN_PALETTE.meadow;

    if (normalizedX > 0.5 && height < WORLD_CONFIG.seaLevel - 0.2) base = TERRAIN_PALETTE.seabed;
    else if (normalizedX > 0.48 && height < 0.18) base = TERRAIN_PALETTE.wetSand;
    else if (normalizedX > 0.45 && height < 0.95) base = TERRAIN_PALETTE.sand;
    else if (height < 0.6) base = TERRAIN_PALETTE.valley;
    else if (normalizedHeight < 0.31) base = slope > 0.42 ? TERRAIN_PALETTE.earth : TERRAIN_PALETTE.meadow;
    else if (normalizedHeight < 0.52) base = slope > 0.34 ? TERRAIN_PALETTE.rock : TERRAIN_PALETTE.pine;
    else if (normalizedHeight < 0.72) base = slope > 0.18 ? TERRAIN_PALETTE.rock : TERRAIN_PALETTE.highRock;
    else if (slope > 0.36) base = TERRAIN_PALETTE.highRock;
    else base = normalizedHeight > 0.82 ? TERRAIN_PALETTE.snow : TERRAIN_PALETTE.snowShadow;

    return new THREE.Color(base).multiplyScalar(variation);
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
