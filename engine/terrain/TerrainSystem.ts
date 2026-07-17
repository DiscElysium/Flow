import * as THREE from "three";
import { TERRAIN_PALETTE, WATERED_TERRAIN_PALETTE, WORLD_CONFIG } from "@/engine/config";
import { hash2D } from "@/engine/math/random";
import { MountainGenerator } from "@/engine/terrain/MountainGenerator";
import type { MountainData, TerrainTool } from "@/engine/types";

type Point = [number, number, number];
type Point2 = { x: number; z: number };
type RockComponent = { group: number; indices: number[] };
const scaledWorldHeight = (baseHeight: number): number => WORLD_CONFIG.seaLevel
  + (baseHeight - WORLD_CONFIG.seaLevel) * WORLD_CONFIG.verticalScale;

export class TerrainSystem {
  readonly resolutionX = WORLD_CONFIG.segmentsX + 1;
  readonly resolutionZ = WORLD_CONFIG.segmentsZ + 1;
  /** Row stride retained under the old name for flat-array indexing. */
  readonly resolution = this.resolutionX;
  readonly cellSize = WORLD_CONFIG.size / WORLD_CONFIG.segments;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly backgroundMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly rockMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  heights: Float32Array<ArrayBufferLike> = new Float32Array(this.resolutionX * this.resolutionZ);
  sourceIndex = 0;
  peakIndex = 0;
  minHeight: number = WORLD_CONFIG.minHeight;
  maxHeight: number = WORLD_CONFIG.maxHeight;

  private originalHeights: Float32Array<ArrayBufferLike> = new Float32Array(this.heights.length);
  private readonly watered = new Uint8Array(this.resolutionX * this.resolutionZ);
  private readonly permanentlyGreen = new Uint8Array(this.resolutionX * this.resolutionZ);
  private readonly rockPaint = new Uint8Array(this.resolutionX * this.resolutionZ);
  private readonly rockGroups = new Uint32Array(this.resolutionX * this.resolutionZ);
  /** Exact height of the visible low-poly stone at each covered terrain sample. */
  private readonly rockSurfaceHeights = new Float32Array(this.resolutionX * this.resolutionZ);
  private readonly rockVisualSink = new Float32Array(this.resolutionX * this.resolutionZ);
  private readonly greenableCells = new Uint8Array(WORLD_CONFIG.segmentsX * WORLD_CONFIG.segmentsZ);
  private squareHeights: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private activeCropStartZ = 0;
  private dryColors = new Float32Array(0);
  private wateredColors = new Float32Array(0);
  private readonly generator = new MountainGenerator();
  private seedHash = 0;
  private nextRockGroupId = 1;
  private activeRockGroupId = 0;
  private rockBodiesDirty = false;

  constructor(private readonly scene: THREE.Scene, seed: string) {
    const material = this.createTerrainMaterial();
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = "procedural-mountain";
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);

    this.backgroundMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.createTerrainMaterial());
    this.backgroundMesh.name = "static-side-terrain";
    this.backgroundMesh.castShadow = false;
    this.backgroundMesh.receiveShadow = true;
    this.backgroundMesh.matrixAutoUpdate = false;
    this.backgroundMesh.updateMatrix();
    this.scene.add(this.backgroundMesh);

    this.rockMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.98,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    this.rockMesh.name = "painted-low-poly-boulders";
    this.rockMesh.castShadow = true;
    this.rockMesh.receiveShadow = true;
    this.rockMesh.renderOrder = 1;
    this.scene.add(this.rockMesh);
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
    this.squareHeights = mountain.squareHeights;
    this.activeCropStartZ = mountain.activeCropStartZ;
    this.seedHash = Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    this.watered.fill(0);
    // New terrain begins as healthy green ground. The yellow brush can still
    // opt individual areas back into the water-responsive dry state.
    this.permanentlyGreen.fill(1);
    this.rockPaint.fill(0);
    this.rockGroups.fill(0);
    this.rockSurfaceHeights.fill(Number.NaN);
    this.rockVisualSink.fill(0);
    this.nextRockGroupId = 1;
    this.activeRockGroupId = 0;
    this.rebuildRockBodies();
    this.rebuildRockVisualSink();
    this.rebuildBackgroundGeometry();
    this.rebuildGeometry();
    return mountain;
  }

  reset(): void {
    this.heights.set(this.originalHeights);
    const largestGroup = this.findLargestRockGroup();
    for (let group = 1; group <= largestGroup; group += 1) this.sculptRockGroupHeight(group);
    this.rebuildRockBodies();
    this.rebuildRockVisualSink();
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
    return this.rockPaint[index] === 0 && (this.permanentlyGreen[index] !== 0 || this.watered[index] !== 0);
  }

  /** Whether this point is green specifically because it is near visible water. */
  isWateredAt(worldX: number, worldZ: number): boolean {
    const { x, z } = this.worldToGrid(worldX, worldZ);
    return this.watered[z * this.resolution + x] !== 0;
  }

  isRockIndex(index: number): boolean {
    return index >= 0 && index < this.rockPaint.length && this.rockPaint[index] !== 0;
  }

  /** Pick a genuinely water-greened terrain point inside a world-space X band. */
  findWateredGreenPointInXRange(
    minWorldX: number,
    maxWorldX: number,
    random: () => number = Math.random,
  ): THREE.Vector3 | null {
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;
    const startX = THREE.MathUtils.clamp(
      Math.floor((Math.min(minWorldX, maxWorldX) + halfX) / this.cellSize),
      0,
      WORLD_CONFIG.segmentsX - 1,
    );
    const endX = THREE.MathUtils.clamp(
      Math.ceil((Math.max(minWorldX, maxWorldX) + halfX) / this.cellSize),
      0,
      WORLD_CONFIG.segmentsX - 1,
    );
    let selectedX = -1;
    let selectedZ = -1;
    let candidates = 0;

    for (let z = 0; z < WORLD_CONFIG.segmentsZ; z += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const cellIndex = z * WORLD_CONFIG.segmentsX + x;
        if (this.greenableCells[cellIndex] === 0 || this.cellHasRock(x, z) || !this.cellHasWater(x, z)) continue;
        candidates += 1;
        if (random() <= 1 / candidates) {
          selectedX = x;
          selectedZ = z;
        }
      }
    }

    // Ignore a few isolated wet vertices; a visible green patch should exist
    // before wildlife treats the river as established habitat.
    if (candidates < 6 || selectedX < 0 || selectedZ < 0) return null;
    const worldX = (selectedX + 0.5) * this.cellSize - halfX;
    const worldZ = (selectedZ + 0.5) * this.cellSize - halfZ;
    return new THREE.Vector3(worldX, this.heightAt(worldX, worldZ), worldZ);
  }

  getGroundPaintState(): number[] {
    return Array.from(this.permanentlyGreen);
  }

  loadGroundPaintState(state?: readonly number[]): void {
    const hasSavedPaint = Boolean(state && state.length > 0);
    this.permanentlyGreen.fill(hasSavedPaint ? 0 : 1);
    if (hasSavedPaint && state) {
      const length = Math.min(state.length, this.permanentlyGreen.length);
      for (let i = 0; i < length; i += 1) this.permanentlyGreen[i] = state[i] ? 1 : 0;
    }
    this.refreshTerrainColors();
  }

  getRockPaintState(): number[] {
    return Array.from(this.rockPaint);
  }

  getRockGroupState(): number[] {
    return Array.from(this.rockGroups);
  }

  loadRockPaintState(
    state?: readonly number[],
    groups?: readonly number[],
    heightsIntegrated = false,
  ): void {
    this.rockPaint.fill(0);
    this.rockGroups.fill(0);
    if (state) {
      const length = Math.min(state.length, this.rockPaint.length);
      for (let i = 0; i < length; i += 1) this.rockPaint[i] = state[i] ? 1 : 0;
    }
    let largestGroup = 0;
    if (groups) {
      const length = Math.min(groups.length, this.rockGroups.length);
      for (let i = 0; i < length; i += 1) {
        if (this.rockPaint[i] === 0) continue;
        const group = Math.max(0, Math.floor(groups[i] ?? 0));
        this.rockGroups[i] = group;
        largestGroup = Math.max(largestGroup, group);
      }
    }
    this.assignGroupsToUngroupedRock(largestGroup + 1);
    this.nextRockGroupId = Math.max(largestGroup + 1, this.findLargestRockGroup() + 1);
    if (!heightsIntegrated) {
      for (let group = 1; group < this.nextRockGroupId; group += 1) this.sculptRockGroupHeight(group);
    }
    this.activeRockGroupId = 0;
    this.rockBodiesDirty = false;
    this.rebuildRockBodies();
    this.rebuildRockVisualSink();
    this.rebuildGeometry();
  }

  beginStroke(tool: TerrainTool): void {
    this.activeRockGroupId = tool === "paint-rock" ? this.nextRockGroupId++ : 0;
  }

  finishStroke(): void {
    const completedRockGroup = this.activeRockGroupId;
    this.activeRockGroupId = 0;
    if (completedRockGroup !== 0) {
      this.sealRockGroupFootprint(completedRockGroup);
      this.sculptRockGroupHeight(completedRockGroup);
    }
    if (!this.rockBodiesDirty) return;
    this.rockBodiesDirty = false;
    this.rebuildRockBodies();
    this.rebuildRockVisualSink();
    this.rebuildGeometry();
  }

  /** Share of currently yellow, colorable ground that is green because of water. */
  getWateredYellowPercentage(): number {
    let yellowCells = 0;
    let wateredYellowCells = 0;

    for (let z = 0; z < WORLD_CONFIG.segmentsZ; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segmentsX; x += 1) {
        const cellIndex = z * WORLD_CONFIG.segmentsX + x;
        if (this.greenableCells[cellIndex] === 0 || this.cellHasPermanentGreen(x, z) || this.cellHasRock(x, z)) continue;
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
    protectRock = false,
  ): boolean {
    if (tool === "orbit") return false;
    const center = this.worldToGrid(worldX, worldZ);
    const gridRadius = Math.ceil(radius / this.cellSize);
    if (tool === "paint-green" || tool === "paint-yellow" || tool === "paint-rock") {
      return this.applySurfacePaint(center, gridRadius, worldX, worldZ, radius, tool);
    }
    const before = tool === "smooth" ? this.heights.slice() : this.heights;
    let changed = false;

    for (let z = Math.max(1, center.z - gridRadius); z <= Math.min(this.resolutionZ - 2, center.z + gridRadius); z += 1) {
      for (let x = Math.max(1, center.x - gridRadius); x <= Math.min(this.resolutionX - 2, center.x + gridRadius); x += 1) {
        const position = this.indexToWorld(z * this.resolution + x);
        const distance = Math.hypot(position.x - worldX, position.z - worldZ);
        if (distance >= radius) continue;
        const normalized = 1 - distance / radius;
        const falloff = normalized * normalized * (3 - 2 * normalized);
        const index = z * this.resolution + x;
        const protectedRock = this.rockPaint[index] !== 0
          && (tool === "smooth" || (protectRock && (tool === "carve" || tool === "raise")));
        if (protectedRock) continue;
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
      this.rockBodiesDirty = true;
    }
    return changed;
  }

  heightAt(worldX: number, worldZ: number): number {
    const gx = THREE.MathUtils.clamp(
      (worldX + WORLD_CONFIG.sizeX * 0.5) / this.cellSize,
      0,
      WORLD_CONFIG.segmentsX,
    );
    const gz = THREE.MathUtils.clamp(
      (worldZ + WORLD_CONFIG.sizeZ * 0.5) / this.cellSize,
      0,
      WORLD_CONFIG.segmentsZ,
    );
    const x0 = Math.min(WORLD_CONFIG.segmentsX - 1, Math.floor(gx));
    const z0 = Math.min(WORLD_CONFIG.segmentsZ - 1, Math.floor(gz));
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

  /** Sample the exact alternating triangle split used by the visible low-poly terrain. */
  surfaceHeightAt(worldX: number, worldZ: number): number {
    const gx = THREE.MathUtils.clamp(
      (worldX + WORLD_CONFIG.sizeX * 0.5) / this.cellSize,
      0,
      WORLD_CONFIG.segmentsX,
    );
    const gz = THREE.MathUtils.clamp(
      (worldZ + WORLD_CONFIG.sizeZ * 0.5) / this.cellSize,
      0,
      WORLD_CONFIG.segmentsZ,
    );
    const x0 = Math.min(WORLD_CONFIG.segmentsX - 1, Math.floor(gx));
    const z0 = Math.min(WORLD_CONFIG.segmentsZ - 1, Math.floor(gz));
    const tx = gx - x0;
    const tz = gz - z0;
    const i00 = z0 * this.resolution + x0;
    const h00 = this.heights[i00];
    const h10 = this.heights[i00 + 1];
    const h01 = this.heights[i00 + this.resolution];
    const h11 = this.heights[i00 + this.resolution + 1];

    if ((x0 + z0) % 2 === 0) {
      return tx + tz <= 1
        ? h00 + (h10 - h00) * tx + (h01 - h00) * tz
        : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
    }

    return tz >= tx
      ? h00 + (h01 - h00) * tz + (h11 - h01) * tx
      : h00 + (h10 - h00) * tx + (h11 - h10) * tz;
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
    return new THREE.Vector3(
      x * this.cellSize - WORLD_CONFIG.sizeX * 0.5,
      this.heights[index],
      z * this.cellSize - WORLD_CONFIG.sizeZ * 0.5,
    );
  }

  /** Return the nearest terrain vertex for a world-space position. */
  indexAt(worldX: number, worldZ: number): number {
    const { x, z } = this.worldToGrid(worldX, worldZ);
    return z * this.resolution + x;
  }

  dispose(): void {
    this.scene.remove(this.mesh, this.backgroundMesh);
    this.scene.remove(this.rockMesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.backgroundMesh.geometry.dispose();
    this.backgroundMesh.material.dispose();
    this.rockMesh.geometry.dispose();
    this.rockMesh.material.dispose();
  }

  private worldToGrid(worldX: number, worldZ: number): { x: number; z: number } {
    return {
      x: Math.round(THREE.MathUtils.clamp((worldX + WORLD_CONFIG.sizeX * 0.5) / this.cellSize, 0, WORLD_CONFIG.segmentsX)),
      z: Math.round(THREE.MathUtils.clamp((worldZ + WORLD_CONFIG.sizeZ * 0.5) / this.cellSize, 0, WORLD_CONFIG.segmentsZ)),
    };
  }

  private rebuildGeometry(): void {
    const verticesPerCell = 6;
    const positions = new Float32Array(WORLD_CONFIG.segmentsX * WORLD_CONFIG.segmentsZ * verticesPerCell * 3);
    const colors = new Float32Array(positions.length);
    const dryColors = new Float32Array(positions.length);
    const wateredColors = new Float32Array(positions.length);
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;
    let cursor = 0;
    this.greenableCells.fill(0);
    type TerrainPoint = { position: Point; index: number };

    const point = (x: number, z: number): TerrainPoint => {
      const index = z * this.resolution + x;
      return {
        position: [x * this.cellSize - halfX, this.heights[index], z * this.cellSize - halfZ],
        index,
      };
    };

    for (let z = 0; z < WORLD_CONFIG.segmentsZ; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segmentsX; x += 1) {
        const p00 = point(x, z);
        const p10 = point(x + 1, z);
        const p01 = point(x, z + 1);
        const p11 = point(x + 1, z + 1);
        const triangles: [TerrainPoint, TerrainPoint, TerrainPoint][] = (x + z) % 2 === 0
          ? [[p00, p01, p10], [p10, p01, p11]]
          : [[p00, p01, p11], [p00, p11, p10]];

        triangles.forEach((triangle, triangleIndex) => {
          const trianglePoints: [Point, Point, Point] = [
            triangle[0].position,
            triangle[1].position,
            triangle[2].position,
          ];
          const faceColors = this.faceColors(trianglePoints, x, z, triangleIndex);
          if (!faceColors.dry.equals(faceColors.watered)) {
            this.greenableCells[z * WORLD_CONFIG.segmentsX + x] = 1;
          }
          const color = this.cellIsGreen(x, z) ? faceColors.watered : faceColors.dry;
          for (const vertex of triangle) {
            const rockSurface = this.rockSurfaceHeights[vertex.index];
            const terrainSink = this.rockVisualSink[vertex.index];
            // The terrain below a boulder is only a hidden support surface. Clamp
            // it beneath the exact faceted stone height so it can never pierce the
            // stone after neighboring ground is carved or raised.
            const displayHeight = Number.isFinite(rockSurface)
              ? Math.min(vertex.position[1], rockSurface - 0.025 - terrainSink)
              : vertex.position[1];
            positions[cursor] = vertex.position[0];
            colors[cursor] = color.r;
            dryColors[cursor] = faceColors.dry.r;
            wateredColors[cursor] = faceColors.watered.r;
            cursor += 1;
            positions[cursor] = displayHeight;
            colors[cursor] = color.g;
            dryColors[cursor] = faceColors.dry.g;
            wateredColors[cursor] = faceColors.watered.g;
            cursor += 1;
            positions[cursor] = vertex.position[2];
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

  private createTerrainMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.93,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  }

  /** Build the two non-interactive side strips once from the full square map. */
  private rebuildBackgroundGeometry(): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const half = WORLD_CONFIG.sizeX * 0.5;
    const zStep = 4;
    const activeEndZ = this.activeCropStartZ + WORLD_CONFIG.segmentsZ;
    type BackgroundPoint = { position: Point };

    const point = (x: number, z: number): BackgroundPoint => ({
      position: [
        x * this.cellSize - half,
        this.squareHeights[z * this.resolutionX + x],
        z * this.cellSize - half,
      ],
    });

    const appendStrip = (startZ: number, endZ: number): void => {
      for (let z = startZ; z < endZ; z += zStep) {
        const nextZ = Math.min(endZ, z + zStep);
        for (let x = 0; x < WORLD_CONFIG.segmentsX; x += 1) {
          const p00 = point(x, z);
          const p10 = point(x + 1, z);
          const p01 = point(x, nextZ);
          const p11 = point(x + 1, nextZ);
          const triangles: [BackgroundPoint, BackgroundPoint, BackgroundPoint][] = (x + z) % 2 === 0
            ? [[p00, p01, p10], [p10, p01, p11]]
            : [[p00, p01, p11], [p00, p11, p10]];

          triangles.forEach((triangle, triangleIndex) => {
            const trianglePoints: [Point, Point, Point] = [
              triangle[0].position,
              triangle[1].position,
              triangle[2].position,
            ];
            const color = this.faceColors(trianglePoints, x, z, triangleIndex).watered;
            for (const vertex of triangle) {
              positions.push(...vertex.position);
              colors.push(color.r, color.g, color.b);
            }
          });
        }
      }
    };

    appendStrip(0, this.activeCropStartZ);
    appendStrip(activeEndZ, WORLD_CONFIG.segmentsX);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    if (positions.length > 0) {
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    this.backgroundMesh.geometry.dispose();
    this.backgroundMesh.geometry = geometry;
    this.backgroundMesh.visible = positions.length > 0;
  }

  /** Rebuild every stroke/component as one self-contained, coarse faceted boulder. */
  private rebuildRockBodies(): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;
    let faceIndex = 0;
    this.rockSurfaceHeights.fill(Number.NaN);

    const addFace = (
      a: Point,
      b: Point,
      c: Point,
      baseColor: string,
      group: number,
      surfaceFaces: Array<[Point, Point, Point]>,
    ): void => {
      // Clockwise X/Z winding points the face normal upward in Three.js coordinates.
      const signedArea = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
      const second = signedArea > 0 ? c : b;
      const third = signedArea > 0 ? b : c;
      surfaceFaces.push([a, second, third]);
      const variation = 0.91 + hash2D(faceIndex * 3 + group, group * 7 + faceIndex, this.seedHash) * 0.17;
      const color = new THREE.Color(baseColor).multiplyScalar(variation);
      for (const point of [a, second, third]) {
        positions.push(point[0], point[1], point[2]);
        colors.push(color.r, color.g, color.b);
      }
      faceIndex += 1;
    };

    for (const component of this.collectRockComponents()) {
      const surfaceFaces: Array<[Point, Point, Point]> = [];
      const samples = component.indices.map((index) => ({
        x: (index % this.resolution) * this.cellSize - halfX,
        z: Math.floor(index / this.resolution) * this.cellSize - halfZ,
      }));
      let hull = this.convexHull(samples);
      if (hull.length < 3) continue;
      hull = this.enrichHull(hull, 8);
      hull = this.reduceHull(hull, 16);

      const centroid = hull.reduce((sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }), { x: 0, z: 0 });
      centroid.x /= hull.length;
      centroid.z /= hull.length;

      const outline = hull.map((point, index) => {
        const dx = point.x - centroid.x;
        const dz = point.z - centroid.z;
        const length = Math.max(0.001, Math.hypot(dx, dz));
        const irregularity = hash2D(index * 13 + component.group, component.group * 5 + index, this.seedHash);
        // Roughly half a cell reaches the real boundary shared with open ground,
        // so the coarse stone mesh and neighboring terrain meet at one contour.
        const expansion = this.cellSize * (0.46 + irregularity * 0.08);
        return {
          x: THREE.MathUtils.clamp(point.x + (dx / length) * expansion, -halfX + 0.02, halfX - 0.02),
          z: THREE.MathUtils.clamp(point.z + (dz / length) * expansion, -halfZ + 0.02, halfZ - 0.02),
        };
      });

      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (const point of outline) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
      const shortSpan = Math.max(this.cellSize, Math.min(maxX - minX, maxZ - minZ));

      const outerRing: Point[] = outline.map((point) => [
        point.x,
        this.heightAt(point.x, point.z),
        point.z,
      ]);
      const innerRing: Point[] = outline.map((point, index) => {
        const scaleNoise = hash2D(index * 5 + 29, component.group * 11 + index, this.seedHash + 31);
        const scale = 0.57 + scaleNoise * 0.055;
        const x = THREE.MathUtils.lerp(centroid.x, point.x, scale);
        const z = THREE.MathUtils.lerp(centroid.z, point.z, scale);
        return [x, this.heightAt(x, z), z];
      });
      const crestNoise = hash2D(component.group * 19 + 5, component.group * 3 + 41, this.seedHash);
      const crestAngle = crestNoise * Math.PI * 2;
      const crestOffset = Math.min(shortSpan * 0.08, this.cellSize * 0.55);
      const crestX = centroid.x + Math.cos(crestAngle) * crestOffset;
      const crestZ = centroid.z + Math.sin(crestAngle) * crestOffset;
      const crest: Point = [
        crestX,
        this.heightAt(crestX, crestZ),
        crestZ,
      ];

      for (let i = 0; i < outline.length; i += 1) {
        const next = (i + 1) % outline.length;
        if ((i + component.group) % 2 === 0) {
          addFace(outerRing[i], innerRing[next], outerRing[next], "#59615d", component.group, surfaceFaces);
          addFace(outerRing[i], innerRing[i], innerRing[next], "#626a66", component.group, surfaceFaces);
        } else {
          addFace(outerRing[i], innerRing[i], outerRing[next], "#59615d", component.group, surfaceFaces);
          addFace(outerRing[next], innerRing[i], innerRing[next], "#626a66", component.group, surfaceFaces);
        }
        addFace(innerRing[i], crest, innerRing[next], "#6d7470", component.group, surfaceFaces);
      }

      this.rasterizeRockSurface(surfaceFaces, minX, maxX, minZ, maxZ);
    }

    // Water and all other height-driven systems use the same surface that is
    // actually rendered. The lowered support terrain remains a display-only
    // concern inside rebuildGeometry().
    for (let index = 0; index < this.heights.length; index += 1) {
      const rockSurface = this.rockSurfaceHeights[index];
      if (this.rockPaint[index] !== 0 && Number.isFinite(rockSurface)) {
        this.heights[index] = rockSurface;
      }
    }
    this.recalculateRange();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    if (positions.length > 0) {
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    this.rockMesh.geometry.dispose();
    this.rockMesh.geometry = geometry;
    this.rockMesh.visible = positions.length > 0;
  }

  /** Sample the rendered stone triangles back onto the hydraulic terrain grid. */
  private rasterizeRockSurface(
    faces: Array<[Point, Point, Point]>,
    minWorldX: number,
    maxWorldX: number,
    minWorldZ: number,
    maxWorldZ: number,
  ): void {
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;
    const startX = THREE.MathUtils.clamp(Math.floor((minWorldX + halfX) / this.cellSize) - 1, 0, this.resolutionX - 1);
    const endX = THREE.MathUtils.clamp(Math.ceil((maxWorldX + halfX) / this.cellSize) + 1, 0, this.resolutionX - 1);
    const startZ = THREE.MathUtils.clamp(Math.floor((minWorldZ + halfZ) / this.cellSize) - 1, 0, this.resolutionZ - 1);
    const endZ = THREE.MathUtils.clamp(Math.ceil((maxWorldZ + halfZ) / this.cellSize) + 1, 0, this.resolutionZ - 1);

    for (let z = startZ; z <= endZ; z += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const worldX = x * this.cellSize - halfX;
        const worldZ = z * this.cellSize - halfZ;
        let surface = Number.NEGATIVE_INFINITY;
        for (const face of faces) {
          const sampled = this.triangleHeightAt(worldX, worldZ, face);
          if (sampled !== null) surface = Math.max(surface, sampled);
        }
        if (!Number.isFinite(surface)) continue;
        const index = z * this.resolution + x;
        const previous = this.rockSurfaceHeights[index];
        this.rockSurfaceHeights[index] = Number.isFinite(previous) ? Math.max(previous, surface) : surface;
      }
    }
  }

  private triangleHeightAt(worldX: number, worldZ: number, face: [Point, Point, Point]): number | null {
    const [a, b, c] = face;
    const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(denominator) < 0.000001) return null;
    const weightA = ((b[2] - c[2]) * (worldX - c[0]) + (c[0] - b[0]) * (worldZ - c[2])) / denominator;
    const weightB = ((c[2] - a[2]) * (worldX - c[0]) + (a[0] - c[0]) * (worldZ - c[2])) / denominator;
    const weightC = 1 - weightA - weightB;
    const epsilon = -0.0001;
    if (weightA < epsilon || weightB < epsilon || weightC < epsilon) return null;
    return weightA * a[1] + weightB * b[1] + weightC * c[1];
  }

  private collectRockComponents(): RockComponent[] {
    const components: RockComponent[] = [];
    const visited = new Uint8Array(this.rockPaint.length);
    const neighborOffsets = [-1, 0, 1];

    for (let start = 0; start < this.rockPaint.length; start += 1) {
      const group = this.rockGroups[start];
      if (visited[start] !== 0 || this.rockPaint[start] === 0 || group === 0) continue;
      const queue = [start];
      const indices: number[] = [];
      visited[start] = 1;

      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        indices.push(index);
        const x = index % this.resolution;
        const z = Math.floor(index / this.resolution);
        for (const dz of neighborOffsets) {
          for (const dx of neighborOffsets) {
            if (dx === 0 && dz === 0) continue;
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= this.resolutionX || nz >= this.resolutionZ) continue;
            const neighbor = nz * this.resolution + nx;
            if (visited[neighbor] !== 0 || this.rockPaint[neighbor] === 0 || this.rockGroups[neighbor] !== group) continue;
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
      }
      if (indices.length >= 3) components.push({ group, indices });
    }
    return components;
  }

  private convexHull(points: Point2[]): Point2[] {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
    if (sorted.length <= 3) return sorted;
    const cross = (origin: Point2, a: Point2, b: Point2): number =>
      (a.x - origin.x) * (b.z - origin.z) - (a.z - origin.z) * (b.x - origin.x);
    const lower: Point2[] = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper: Point2[] = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
  }

  private reduceHull(points: Point2[], maximum: number): Point2[] {
    const reduced = [...points];
    while (reduced.length > maximum) {
      let removeAt = 0;
      let smallestCorner = Number.POSITIVE_INFINITY;
      for (let i = 0; i < reduced.length; i += 1) {
        const previous = reduced[(i - 1 + reduced.length) % reduced.length];
        const current = reduced[i];
        const next = reduced[(i + 1) % reduced.length];
        const corner = Math.abs(
          (current.x - previous.x) * (next.z - current.z)
          - (current.z - previous.z) * (next.x - current.x),
        );
        if (corner < smallestCorner) {
          smallestCorner = corner;
          removeAt = i;
        }
      }
      reduced.splice(removeAt, 1);
    }
    return reduced;
  }

  private enrichHull(points: Point2[], minimum: number): Point2[] {
    const enriched = [...points];
    while (enriched.length < minimum) {
      let longestEdge = 0;
      let longestLength = -1;
      for (let i = 0; i < enriched.length; i += 1) {
        const next = enriched[(i + 1) % enriched.length];
        const length = Math.hypot(next.x - enriched[i].x, next.z - enriched[i].z);
        if (length > longestLength) {
          longestLength = length;
          longestEdge = i;
        }
      }
      const nextIndex = (longestEdge + 1) % enriched.length;
      const a = enriched[longestEdge];
      const b = enriched[nextIndex];
      enriched.splice(longestEdge + 1, 0, { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 });
    }
    return enriched;
  }

  private assignGroupsToUngroupedRock(firstGroup: number): void {
    let nextGroup = Math.max(1, firstGroup);
    const visited = new Uint8Array(this.rockPaint.length);
    for (let start = 0; start < this.rockPaint.length; start += 1) {
      if (visited[start] !== 0 || this.rockPaint[start] === 0 || this.rockGroups[start] !== 0) continue;
      const queue = [start];
      visited[start] = 1;
      this.rockGroups[start] = nextGroup;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        const x = index % this.resolution;
        const z = Math.floor(index / this.resolution);
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dz === 0) continue;
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= this.resolutionX || nz >= this.resolutionZ) continue;
            const neighbor = nz * this.resolution + nx;
            if (visited[neighbor] !== 0 || this.rockPaint[neighbor] === 0 || this.rockGroups[neighbor] !== 0) continue;
            visited[neighbor] = 1;
            this.rockGroups[neighbor] = nextGroup;
            queue.push(neighbor);
          }
        }
      }
      nextGroup += 1;
    }
  }

  private findLargestRockGroup(): number {
    let largest = 0;
    for (let i = 0; i < this.rockGroups.length; i += 1) largest = Math.max(largest, this.rockGroups[i]);
    return largest;
  }

  /** Close small gaps inside a stroke so the visible boulder and protected footprint agree. */
  private sealRockGroupFootprint(group: number): void {
    const points: Point2[] = [];
    for (let index = 0; index < this.rockGroups.length; index += 1) {
      if (this.rockPaint[index] === 0 || this.rockGroups[index] !== group) continue;
      points.push({ x: index % this.resolution, z: Math.floor(index / this.resolution) });
    }
    const hull = this.convexHull(points);
    if (hull.length < 3) return;
    const minX = Math.max(0, Math.floor(Math.min(...hull.map((point) => point.x))));
    const maxX = Math.min(this.resolutionX - 1, Math.ceil(Math.max(...hull.map((point) => point.x))));
    const minZ = Math.max(0, Math.floor(Math.min(...hull.map((point) => point.z))));
    const maxZ = Math.min(this.resolutionZ - 1, Math.ceil(Math.max(...hull.map((point) => point.z))));

    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        let inside = true;
        for (let i = 0; i < hull.length; i += 1) {
          const a = hull[i];
          const b = hull[(i + 1) % hull.length];
          if ((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x) < -0.0001) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        const index = z * this.resolution + x;
        this.rockPaint[index] = 1;
        this.rockGroups[index] = group;
        this.permanentlyGreen[index] = 0;
        this.rockBodiesDirty = true;
      }
    }
  }

  /** Shape the real simulation height field into a low, coherent stone cap. */
  private sculptRockGroupHeight(group: number): void {
    const indices: number[] = [];
    const halfX = WORLD_CONFIG.sizeX * 0.5;
    const halfZ = WORLD_CONFIG.sizeZ * 0.5;
    let meanX = 0;
    let meanZ = 0;
    let meanHeight = 0;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < this.rockGroups.length; index += 1) {
      if (this.rockPaint[index] === 0 || this.rockGroups[index] !== group) continue;
      indices.push(index);
      const x = (index % this.resolution) * this.cellSize - halfX;
      const z = Math.floor(index / this.resolution) * this.cellSize - halfZ;
      meanX += x;
      meanZ += z;
      meanHeight += this.heights[index];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (indices.length < 3) return;
    meanX /= indices.length;
    meanZ /= indices.length;
    meanHeight /= indices.length;

    // Least-squares plane retains the large-scale terrain slope while removing
    // the small grid bumps that previously pierced the coarse stone surface.
    let xx = 0;
    let zz = 0;
    let xz = 0;
    let xh = 0;
    let zh = 0;
    for (const index of indices) {
      const x = (index % this.resolution) * this.cellSize - halfX - meanX;
      const z = Math.floor(index / this.resolution) * this.cellSize - halfZ - meanZ;
      const height = this.heights[index] - meanHeight;
      xx += x * x;
      zz += z * z;
      xz += x * z;
      xh += x * height;
      zh += z * height;
    }
    const determinant = xx * zz - xz * xz;
    const slopeX = Math.abs(determinant) > 0.0001
      ? THREE.MathUtils.clamp((xh * zz - zh * xz) / determinant, -1.8, 1.8)
      : 0;
    const slopeZ = Math.abs(determinant) > 0.0001
      ? THREE.MathUtils.clamp((zh * xx - xh * xz) / determinant, -1.8, 1.8)
      : 0;
    const shortSpan = Math.max(this.cellSize, Math.min(maxX - minX, maxZ - minZ));
    const longSpan = Math.max(maxX - minX, maxZ - minZ);
    const capHeight = THREE.MathUtils.clamp(shortSpan * 0.055 + longSpan * 0.018, 0.18, 0.58);
    const searchRadius = 5;

    for (const index of indices) {
      const gridX = index % this.resolution;
      const gridZ = Math.floor(index / this.resolution);
      let nearestEdge = searchRadius + 1;
      for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
        for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
          const x = gridX + dx;
          const z = gridZ + dz;
          const outside = x < 0 || z < 0 || x >= this.resolutionX || z >= this.resolutionZ;
          if (!outside) {
            const neighbor = z * this.resolution + x;
            if (this.rockPaint[neighbor] !== 0 && this.rockGroups[neighbor] === group) continue;
          }
          nearestEdge = Math.min(nearestEdge, Math.hypot(dx, dz));
        }
      }

      const normalized = THREE.MathUtils.clamp((nearestEdge - 0.5) / 3, 0, 1);
      const profile = normalized * normalized * (3 - 2 * normalized);
      const worldX = gridX * this.cellSize - halfX;
      const worldZ = gridZ * this.cellSize - halfZ;
      const planeHeight = meanHeight + slopeX * (worldX - meanX) + slopeZ * (worldZ - meanZ);
      const targetHeight = planeHeight + capHeight * profile;
      this.heights[index] = THREE.MathUtils.lerp(this.heights[index], targetHeight, profile);
    }
    this.recalculateRange();
    this.rockBodiesDirty = true;
  }

  /** Hide only the interior terrain grid; boundary vertices remain shared with open ground. */
  private rebuildRockVisualSink(): void {
    this.rockVisualSink.fill(0);
    const radius = 2;
    for (let index = 0; index < this.rockPaint.length; index += 1) {
      if (this.rockPaint[index] === 0) continue;
      const gridX = index % this.resolution;
      const gridZ = Math.floor(index / this.resolution);
      let nearestOpenGround = radius + 1;
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = gridX + dx;
          const z = gridZ + dz;
          const outside = x < 0 || z < 0 || x >= this.resolutionX || z >= this.resolutionZ;
          if (!outside && this.rockPaint[z * this.resolution + x] !== 0) continue;
          nearestOpenGround = Math.min(nearestOpenGround, Math.hypot(dx, dz));
        }
      }
      const normalized = THREE.MathUtils.clamp((nearestOpenGround - 1.42) / 0.85, 0, 1);
      const smooth = normalized * normalized * (3 - 2 * normalized);
      this.rockVisualSink[index] = smooth * 0.16;
    }
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
    const normalizedX = ((x + 0.5) / WORLD_CONFIG.segmentsX) * 2 - 1;
    const normalizedHeight = THREE.MathUtils.clamp((height - this.minHeight) / Math.max(1, this.maxHeight - this.minHeight), 0, 1);
    const variation = 0.91 + hash2D(x * 2 + triangleIndex, z, this.seedHash) * 0.16;
    let base: string = TERRAIN_PALETTE.meadow;
    let wateredBase: string = WATERED_TERRAIN_PALETTE.meadow;

    if (normalizedX > 0.5 && height < scaledWorldHeight(WORLD_CONFIG.seaLevel - 0.2)) {
      base = TERRAIN_PALETTE.seabed;
      wateredBase = base;
    } else if (normalizedX > 0.48 && height < scaledWorldHeight(0.18)) {
      base = TERRAIN_PALETTE.wetSand;
      wateredBase = base;
    } else if (normalizedX > 0.45 && height < scaledWorldHeight(0.95)) {
      base = TERRAIN_PALETTE.sand;
      wateredBase = base;
    } else if (height < scaledWorldHeight(0.6)) {
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

  private cellHasRock(x: number, z: number): boolean {
    const topLeft = z * this.resolution + x;
    return this.rockPaint[topLeft] !== 0
      && this.rockPaint[topLeft + 1] !== 0
      && this.rockPaint[topLeft + this.resolution] !== 0
      && this.rockPaint[topLeft + this.resolution + 1] !== 0;
  }

  private cellIsGreen(x: number, z: number): boolean {
    const topLeft = z * this.resolution + x;
    return this.vertexIsGreen(topLeft)
      || this.vertexIsGreen(topLeft + 1)
      || this.vertexIsGreen(topLeft + this.resolution)
      || this.vertexIsGreen(topLeft + this.resolution + 1);
  }

  private refreshTerrainColors(): void {
    const attribute = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (!attribute || this.dryColors.length !== attribute.array.length) return;
    const colors = attribute.array as Float32Array;
    const valuesPerCell = 18;
    let cursor = 0;
    for (let z = 0; z < WORLD_CONFIG.segmentsZ; z += 1) {
      for (let x = 0; x < WORLD_CONFIG.segmentsX; x += 1) {
        const source = this.cellIsGreen(x, z) ? this.wateredColors : this.dryColors;
        for (let i = 0; i < valuesPerCell; i += 1) colors[cursor + i] = source[cursor + i];
        cursor += valuesPerCell;
      }
    }
    attribute.needsUpdate = true;
  }

  private vertexIsGreen(index: number): boolean {
    return this.rockPaint[index] === 0 && (this.permanentlyGreen[index] !== 0 || this.watered[index] !== 0);
  }

  private applySurfacePaint(
    center: { x: number; z: number },
    gridRadius: number,
    worldX: number,
    worldZ: number,
    radius: number,
    tool: "paint-green" | "paint-yellow" | "paint-rock",
  ): boolean {
    let changed = false;
    let rockChanged = false;
    const strokeGroup = tool === "paint-rock"
      ? (this.activeRockGroupId || this.nextRockGroupId++)
      : 0;

    for (let z = Math.max(0, center.z - gridRadius); z <= Math.min(this.resolutionZ - 1, center.z + gridRadius); z += 1) {
      for (let x = Math.max(0, center.x - gridRadius); x <= Math.min(this.resolutionX - 1, center.x + gridRadius); x += 1) {
        const index = z * this.resolution + x;
        const position = this.indexToWorld(index);
        if (Math.hypot(position.x - worldX, position.z - worldZ) >= radius) continue;
        const nextGreen = tool === "paint-green" ? 1 : 0;
        const nextRock = tool === "paint-rock" ? 1 : 0;
        const nextGroup = nextRock !== 0 ? strokeGroup : 0;
        if (
          this.permanentlyGreen[index] === nextGreen
          && this.rockPaint[index] === nextRock
          && this.rockGroups[index] === nextGroup
        ) continue;
        this.permanentlyGreen[index] = nextGreen;
        if (this.rockPaint[index] !== nextRock || this.rockGroups[index] !== nextGroup) rockChanged = true;
        this.rockPaint[index] = nextRock;
        this.rockGroups[index] = nextGroup;
        changed = true;
      }
    }

    if (changed) {
      if (rockChanged) {
        this.rockBodiesDirty = true;
      }
      this.refreshTerrainColors();
    }
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
