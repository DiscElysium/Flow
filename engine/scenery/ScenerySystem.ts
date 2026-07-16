import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WORLD_CONFIG } from "@/engine/config";
import { hashSeed, mulberry32, range } from "@/engine/math/random";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

type Placement = { x: number; z: number; scale: number; rotation: number; color: THREE.Color };

const FLOWER_WASH_DEPTH = 0.006;
const HIDDEN_SCALE = 0.0001;

function createDeadCrownGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const addBranch = (
    length: number,
    topRadius: number,
    bottomRadius: number,
    position: THREE.Vector3,
    rotation: THREE.Euler,
  ) => {
    const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, length, 5);
    const matrix = new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(rotation),
      new THREE.Vector3(1, 1, 1),
    );
    geometry.applyMatrix4(matrix);
    parts.push(geometry);
  };

  addBranch(1.55, 0.025, 0.08, new THREE.Vector3(0, 0, 0), new THREE.Euler());
  addBranch(0.78, 0.018, 0.045, new THREE.Vector3(-0.24, -0.05, 0), new THREE.Euler(0, 0, 0.72));
  addBranch(0.7, 0.016, 0.042, new THREE.Vector3(0.22, 0.13, 0.02), new THREE.Euler(0, 0, -0.78));
  addBranch(0.62, 0.014, 0.038, new THREE.Vector3(0, 0.29, 0.2), new THREE.Euler(0.72, 0.08, 0));
  addBranch(0.55, 0.014, 0.034, new THREE.Vector3(0.02, 0.43, -0.17), new THREE.Euler(-0.78, -0.12, 0));

  const merged = mergeGeometries(parts, false);
  parts.forEach((geometry) => geometry.dispose());
  return merged ?? new THREE.CylinderGeometry(0.025, 0.08, 1.55, 5);
}

function createGrassGeometry(): THREE.BufferGeometry {
  const blades: THREE.BufferGeometry[] = [];
  for (let index = 0; index < 3; index += 1) {
    const height = 0.065 + index * 0.012;
    const blade = new THREE.PlaneGeometry(0.045, height);
    blade.translate((index - 1) * 0.017, height * 0.5, 0);
    blade.rotateY(index * Math.PI / 3);
    blades.push(blade);
  }
  const merged = mergeGeometries(blades, false);
  blades.forEach((blade) => blade.dispose());
  return merged ?? new THREE.PlaneGeometry(0.045, 0.08);
}

function createFlowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.009, 0.014, 0.17, 3);
  stem.translate(0, 0.085, 0);
  parts.push(stem);

  const top = new THREE.CircleGeometry(0.095, 5);
  top.rotateX(-Math.PI / 2);
  top.translate(0, 0.18, 0);
  parts.push(top);

  for (const rotation of [0, Math.PI / 2]) {
    const side = new THREE.CircleGeometry(0.07, 5);
    side.rotateY(rotation);
    side.translate(0, 0.17, 0);
    parts.push(side);
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return merged ?? new THREE.CircleGeometry(0.095, 5);
}

export class ScenerySystem {
  private readonly group = new THREE.Group();
  private trees: Placement[] = [];
  private rocks: Placement[] = [];
  private grass: Placement[] = [];
  private flowers: Placement[] = [];
  private treeGreen = new Uint8Array(0);
  private grassGrowth = new Float32Array(0);
  private grassSubmerged = new Uint8Array(0);
  private flowerGrowth = new Float32Array(0);
  private flowerDestroyed = new Uint8Array(0);
  private canopy?: THREE.InstancedMesh;
  private deadCrown?: THREE.InstancedMesh;
  private trunks?: THREE.InstancedMesh;
  private rockMesh?: THREE.InstancedMesh;
  private grassMesh?: THREE.InstancedMesh;
  private flowerMesh?: THREE.InstancedMesh;

  /** Read-only access to procedural tree placements for scenery replacement. */
  get treePlacements(): Readonly<Placement[]> {
    return this.trees;
  }

  /** Read-only access to procedural rock placements for scenery replacement. */
  get rockPlacements(): Readonly<Placement[]> {
    return this.rocks;
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    seed: string,
  ) {
    this.group.name = "low-poly-scenery";
    this.scene.add(this.group);
    this.regenerate(seed);
  }

  regenerate(seed: string): void {
    this.clearMeshes();
    const random = mulberry32(hashSeed(`${seed}-scenery`));
    const half = WORLD_CONFIG.size * 0.47;
    const exclusion = 8.6;
    this.trees = [];
    this.rocks = [];
    this.grass = [];
    this.flowers = [];

    for (let attempt = 0; attempt < 6000 && this.trees.length < 360; attempt += 1) {
      const x = range(random, -half, half);
      const z = range(random, -half, half);
      const height = this.terrain.heightAt(x, z);
      const slope = this.terrain.slopeAt(x, z);
      const heightRatio = Math.max(0, height) / this.terrain.maxHeight;
      if (height < 0.3 || heightRatio > 0.82 || slope > 0.78) continue;
      if (heightRatio > 0.47) {
        const alpineProgress = THREE.MathUtils.smoothstep(heightRatio, 0.47, 0.82);
        const alpineDensity = THREE.MathUtils.lerp(0.2, 0.035, alpineProgress);
        if (random() > alpineDensity) continue;
      }
      if (Math.abs(x) < exclusion && Math.abs(z) < exclusion) continue;
      const scale = range(random, 0.62, 1.32) * (1 - heightRatio * 0.42);
      const tint = new THREE.Color("#466457")
        .lerp(new THREE.Color("#788078"), heightRatio * 0.48 + random() * 0.24);
      this.trees.push({ x, z, scale, rotation: random() * Math.PI * 2, color: tint });
    }

    const source = this.terrain.indexToWorld(this.terrain.sourceIndex);
    let alpineTreeCount = this.trees.filter((tree) => (
      this.terrain.heightAt(tree.x, tree.z) / this.terrain.maxHeight > 0.47
    )).length;
    for (let attempt = 0; attempt < 3200 && alpineTreeCount < 6; attempt += 1) {
      const x = range(random, -half, 0);
      const z = range(random, -half, half);
      const height = this.terrain.heightAt(x, z);
      const heightRatio = height / this.terrain.maxHeight;
      const slope = this.terrain.slopeAt(x, z);
      if (heightRatio < 0.5 || heightRatio > 0.78 || slope > 0.68) continue;
      if (Math.hypot(x - source.x, z - source.z) < 3.2) continue;
      if (random() > 0.38) continue;
      const scale = range(random, 0.44, 0.78) * (1 - heightRatio * 0.22);
      const tint = new THREE.Color("#53665d").lerp(new THREE.Color("#858b84"), random() * 0.5);
      this.trees.push({ x, z, scale, rotation: random() * Math.PI * 2, color: tint });
      alpineTreeCount += 1;
    }

    for (let attempt = 0; attempt < 2800 && this.rocks.length < 108; attempt += 1) {
      const x = range(random, -half, half);
      const z = range(random, -half, half);
      const height = this.terrain.heightAt(x, z);
      const slope = this.terrain.slopeAt(x, z);
      if (height < this.terrain.maxHeight * 0.25 || height > this.terrain.maxHeight * 0.78 || slope < 0.25) continue;
      const tint = new THREE.Color("#858983").lerp(new THREE.Color("#b2b4ae"), random() * 0.35);
      this.rocks.push({ x, z, scale: range(random, 0.4, 1.1), rotation: random() * Math.PI * 2, color: tint });
    }

    // Ground cover uses its own seed so later tree/rock tuning does not reshuffle it.
    // Candidates stay hidden until flowing water turns their ground green.
    const coverRandom = mulberry32(hashSeed(`${seed}-ground-cover`));
    const grassColors = ["#91aa95", "#a6b89f", "#b7c3aa"];
    const flowerColors = ["#f2e7bb", "#e2c65c", "#bca3dc", "#dfa9b5"];

    for (let attempt = 0; attempt < 11000 && this.grass.length < 1500; attempt += 1) {
      const x = range(coverRandom, -half, half);
      const z = range(coverRandom, -half, half);
      const height = this.terrain.heightAt(x, z);
      const heightRatio = height / this.terrain.maxHeight;
      if (height < 0.3 || heightRatio > 0.58 || this.terrain.slopeAt(x, z) > 0.54) continue;
      const base = new THREE.Color(grassColors[Math.floor(coverRandom() * grassColors.length)]);
      base.multiplyScalar(range(coverRandom, 0.88, 1.08));
      this.grass.push({
        x,
        z,
        scale: range(coverRandom, 0.58, 1.18),
        rotation: coverRandom() * Math.PI * 2,
        color: base,
      });
    }

    // Flowers are denser than grass accents, but stay in close little colonies.
    for (let attempt = 0; attempt < 320 && this.flowers.length < 900; attempt += 1) {
      const centerX = range(coverRandom, -half + 1, half - 1);
      const centerZ = range(coverRandom, -half + 1, half - 1);
      const centerHeight = this.terrain.heightAt(centerX, centerZ);
      const centerHeightRatio = centerHeight / this.terrain.maxHeight;
      if (centerHeight < 0.35 || centerHeightRatio > 0.52 || this.terrain.slopeAt(centerX, centerZ) > 0.42) continue;

      const clusterSize = Math.floor(range(coverRandom, 7, 15));
      for (let member = 0; member < clusterSize && this.flowers.length < 900; member += 1) {
        const angle = coverRandom() * Math.PI * 2;
        const radius = Math.pow(coverRandom(), 1.8) * 0.85;
        const x = centerX + Math.cos(angle) * radius;
        const z = centerZ + Math.sin(angle) * radius;
        const height = this.terrain.heightAt(x, z);
        const heightRatio = height / this.terrain.maxHeight;
        if (height < 0.35 || heightRatio > 0.52 || this.terrain.slopeAt(x, z) > 0.42) continue;
        this.flowers.push({
          x,
          z,
          scale: range(coverRandom, 0.68, 1.18),
          rotation: coverRandom() * Math.PI * 2,
          color: new THREE.Color(flowerColors[Math.floor(coverRandom() * flowerColors.length)]),
        });
      }
    }

    this.treeGreen = new Uint8Array(this.trees.length);
    this.grassGrowth = new Float32Array(this.grass.length);
    this.grassSubmerged = new Uint8Array(this.grass.length);
    this.flowerGrowth = new Float32Array(this.flowers.length);
    this.flowerDestroyed = new Uint8Array(this.flowers.length);
    this.buildTrees();
    this.buildRocks();
    this.buildGroundCover();
    this.refreshHeights();
  }

  refreshHeights(): void {
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();

    this.trees.forEach((tree, index) => {
      const height = this.terrain.heightAt(tree.x, tree.z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tree.rotation);
      const isGreen = this.treeGreen[index] !== 0;
      scale.setScalar(isGreen ? tree.scale : 0.0001);
      position.set(tree.x, height + 0.96 * tree.scale, tree.z);
      matrix.compose(position, quaternion, scale);
      this.canopy?.setMatrixAt(index, matrix);

      scale.setScalar(isGreen ? 0.0001 : tree.scale);
      matrix.compose(position, quaternion, scale);
      this.deadCrown?.setMatrixAt(index, matrix);

      scale.set(tree.scale, tree.scale, tree.scale);
      position.set(tree.x, height + 0.28 * tree.scale, tree.z);
      matrix.compose(position, quaternion, scale);
      this.trunks?.setMatrixAt(index, matrix);
    });
    if (this.canopy) this.canopy.instanceMatrix.needsUpdate = true;
    if (this.deadCrown) this.deadCrown.instanceMatrix.needsUpdate = true;
    if (this.trunks) this.trunks.instanceMatrix.needsUpdate = true;

    this.rocks.forEach((rock, index) => {
      const height = this.terrain.heightAt(rock.x, rock.z);
      quaternion.setFromEuler(new THREE.Euler(rock.rotation * 0.18, rock.rotation, rock.rotation * 0.11));
      scale.set(rock.scale * 1.2, rock.scale * 0.68, rock.scale);
      position.set(rock.x, height + 0.25 * rock.scale, rock.z);
      matrix.compose(position, quaternion, scale);
      this.rockMesh?.setMatrixAt(index, matrix);
    });
    if (this.rockMesh) this.rockMesh.instanceMatrix.needsUpdate = true;

    this.refreshGroundCoverMatrices();
  }

  /** Trees are green only when they stand on the irrigated terrain mask. */
  updateTreeWatering(isWateredAt: (x: number, z: number) => boolean): void {
    if (!this.canopy) return;

    let changed = false;
    for (let i = 0; i < this.trees.length; i++) {
      const tree = this.trees[i];
      const next = isWateredAt(tree.x, tree.z) ? 1 : 0;
      if (this.treeGreen[i] === next) continue;
      this.treeGreen[i] = next;
      changed = true;
    }
    if (changed) this.refreshHeights();
  }

  /** Bird ambience strength near irrigated low-altitude forest. */
  greenForestPresenceAt(worldX: number, worldZ: number, radius = 18): number {
    const focusHeightRatio = this.terrain.heightAt(worldX, worldZ) / this.terrain.maxHeight;
    if (focusHeightRatio > 0.52) return 0;

    let strongest = 0;
    let nearbyDensity = 0;
    for (let index = 0; index < this.trees.length; index += 1) {
      if (this.treeGreen[index] === 0) continue;
      const tree = this.trees[index];
      if (this.terrain.heightAt(tree.x, tree.z) / this.terrain.maxHeight > 0.5) continue;
      const distance = Math.hypot(tree.x - worldX, tree.z - worldZ);
      if (distance >= radius) continue;
      const presence = 1 - THREE.MathUtils.smoothstep(distance, 3, radius);
      strongest = Math.max(strongest, presence);
      nearbyDensity += presence * 0.12;
    }
    return THREE.MathUtils.clamp(strongest * 0.62 + nearbyDensity, 0, 1);
  }

  /** Grow tiny ground cover beside water; direct flow bends grass and washes visible flowers away. */
  updateGroundCoverWatering(
    isWateredAt: (x: number, z: number) => boolean,
    waterDepthAt: (x: number, z: number) => number,
    elapsedSeconds: number,
  ): void {
    const elapsed = THREE.MathUtils.clamp(elapsedSeconds, 0.01, 1);
    let changed = false;

    for (let index = 0; index < this.grass.length; index += 1) {
      const plant = this.grass[index];
      const watered = isWateredAt(plant.x, plant.z);
      const submerged = waterDepthAt(plant.x, plant.z) >= FLOWER_WASH_DEPTH ? 1 : 0;
      const current = this.grassGrowth[index];
      const target = watered ? 1 : 0;
      const speed = target > current ? 1.25 : 2.5;
      const next = target > current
        ? Math.min(target, current + elapsed * speed)
        : Math.max(target, current - elapsed * speed);
      if (Math.abs(next - current) > 0.0001 || this.grassSubmerged[index] !== submerged) changed = true;
      this.grassGrowth[index] = next;
      this.grassSubmerged[index] = submerged;
    }

    for (let index = 0; index < this.flowers.length; index += 1) {
      const flower = this.flowers[index];
      const current = this.flowerGrowth[index];
      const submerged = waterDepthAt(flower.x, flower.z) >= FLOWER_WASH_DEPTH;

      if (this.flowerDestroyed[index] === 0 && submerged && current >= 0.05) {
        this.flowerDestroyed[index] = 1;
        changed = true;
      }

      const canGrow = this.flowerDestroyed[index] === 0
        && !submerged
        && isWateredAt(flower.x, flower.z);
      const target = canGrow ? 1 : 0;
      const speed = target > current ? 0.9 : 4;
      const next = target > current
        ? Math.min(target, current + elapsed * speed)
        : Math.max(target, current - elapsed * speed);
      if (Math.abs(next - current) > 0.0001) changed = true;
      this.flowerGrowth[index] = next;
    }

    if (changed) this.refreshGroundCoverMatrices();
  }

  /** Show or hide the entire procedural scenery group. Used when custom models replace procedural scenery. */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.clearMeshes();
    this.scene.remove(this.group);
  }

  private buildTrees(): void {
    const canopyGeometry = new THREE.ConeGeometry(0.55, 1.85, 5, 2);
    const trunkGeometry = new THREE.CylinderGeometry(0.08, 0.11, 0.55, 5);
    this.canopy = new THREE.InstancedMesh(canopyGeometry, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), this.trees.length);
    this.deadCrown = new THREE.InstancedMesh(
      createDeadCrownGeometry(),
      new THREE.MeshStandardMaterial({ color: "#705943", roughness: 1, flatShading: true }),
      this.trees.length,
    );
    this.trunks = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshStandardMaterial({ color: "#625c4e", roughness: 1, flatShading: true }), this.trees.length);
    this.canopy.castShadow = true;
    this.canopy.receiveShadow = true;
    this.deadCrown.castShadow = true;
    this.deadCrown.receiveShadow = true;
    this.trunks.castShadow = true;
    this.trees.forEach((tree, index) => this.canopy?.setColorAt(index, tree.color));
    if (this.canopy.instanceColor) this.canopy.instanceColor.needsUpdate = true;
    this.group.add(this.canopy, this.deadCrown, this.trunks);
  }

  private buildRocks(): void {
    this.rockMesh = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.48, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.98, flatShading: true }),
      this.rocks.length,
    );
    this.rockMesh.castShadow = true;
    this.rockMesh.receiveShadow = true;
    this.rocks.forEach((rock, index) => this.rockMesh?.setColorAt(index, rock.color));
    if (this.rockMesh.instanceColor) this.rockMesh.instanceColor.needsUpdate = true;
    this.group.add(this.rockMesh);
  }

  private buildGroundCover(): void {
    const grassMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 1,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    this.grassMesh = new THREE.InstancedMesh(createGrassGeometry(), grassMaterial, this.grass.length);
    this.grassMesh.name = "watered-grass-tufts";
    this.grassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.grassMesh.frustumCulled = false;
    this.grass.forEach((plant, index) => this.grassMesh?.setColorAt(index, plant.color));
    if (this.grassMesh.instanceColor) this.grassMesh.instanceColor.needsUpdate = true;

    const flowerMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.92,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    this.flowerMesh = new THREE.InstancedMesh(createFlowerGeometry(), flowerMaterial, this.flowers.length);
    this.flowerMesh.name = "watered-wildflowers";
    this.flowerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flowerMesh.frustumCulled = false;
    this.flowers.forEach((flower, index) => this.flowerMesh?.setColorAt(index, flower.color));
    if (this.flowerMesh.instanceColor) this.flowerMesh.instanceColor.needsUpdate = true;
    this.group.add(this.grassMesh, this.flowerMesh);
  }

  private refreshGroundCoverMatrices(): void {
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();

    this.grass.forEach((plant, index) => {
      const growth = this.grassGrowth[index];
      const submerged = this.grassSubmerged[index] !== 0;
      quaternion.setFromEuler(new THREE.Euler(submerged ? Math.PI * 0.34 : 0, plant.rotation, 0));
      if (growth <= 0.001) scale.setScalar(HIDDEN_SCALE);
      else scale.set(plant.scale * growth, plant.scale * growth * (submerged ? 0.5 : 1), plant.scale * growth);
      position.set(plant.x, this.terrain.heightAt(plant.x, plant.z) + 0.012, plant.z);
      matrix.compose(position, quaternion, scale);
      this.grassMesh?.setMatrixAt(index, matrix);
    });
    if (this.grassMesh) this.grassMesh.instanceMatrix.needsUpdate = true;

    this.flowers.forEach((flower, index) => {
      const growth = this.flowerGrowth[index];
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), flower.rotation);
      scale.setScalar(growth <= 0.001 ? HIDDEN_SCALE : flower.scale * growth);
      position.set(flower.x, this.terrain.heightAt(flower.x, flower.z) + 0.014, flower.z);
      matrix.compose(position, quaternion, scale);
      this.flowerMesh?.setMatrixAt(index, matrix);
    });
    if (this.flowerMesh) this.flowerMesh.instanceMatrix.needsUpdate = true;
  }

  private clearMeshes(): void {
    for (const mesh of [this.canopy, this.deadCrown, this.trunks, this.rockMesh, this.grassMesh, this.flowerMesh]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material.dispose();
    }
    this.canopy = undefined;
    this.deadCrown = undefined;
    this.trunks = undefined;
    this.rockMesh = undefined;
    this.grassMesh = undefined;
    this.flowerMesh = undefined;
  }
}
