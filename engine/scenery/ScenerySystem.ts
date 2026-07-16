import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hashSeed, mulberry32, range } from "@/engine/math/random";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

type Placement = { x: number; z: number; scale: number; rotation: number; color: THREE.Color };

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

export class ScenerySystem {
  private readonly group = new THREE.Group();
  private trees: Placement[] = [];
  private rocks: Placement[] = [];
  private treeGreen = new Uint8Array(0);
  private canopy?: THREE.InstancedMesh;
  private deadCrown?: THREE.InstancedMesh;
  private trunks?: THREE.InstancedMesh;
  private rockMesh?: THREE.InstancedMesh;

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
    const half = 43.5;
    const exclusion = 8.6;
    this.trees = [];
    this.rocks = [];

    for (let attempt = 0; attempt < 3200 && this.trees.length < 190; attempt += 1) {
      const x = range(random, -half, half);
      const z = range(random, -half, half);
      const height = this.terrain.heightAt(x, z);
      const slope = this.terrain.slopeAt(x, z);
      if (height < 0.3 || height > this.terrain.maxHeight * 0.47 || slope > 0.78) continue;
      if (Math.abs(x) < exclusion && Math.abs(z) < exclusion) continue;
      const scale = range(random, 0.62, 1.32) * (1 - Math.max(0, height) / this.terrain.maxHeight * 0.24);
      const tint = new THREE.Color("#466457").lerp(new THREE.Color("#6e8068"), random() * 0.42);
      this.trees.push({ x, z, scale, rotation: random() * Math.PI * 2, color: tint });
    }

    for (let attempt = 0; attempt < 1600 && this.rocks.length < 64; attempt += 1) {
      const x = range(random, -half, half);
      const z = range(random, -half, half);
      const height = this.terrain.heightAt(x, z);
      const slope = this.terrain.slopeAt(x, z);
      if (height < this.terrain.maxHeight * 0.25 || height > this.terrain.maxHeight * 0.78 || slope < 0.25) continue;
      const tint = new THREE.Color("#858983").lerp(new THREE.Color("#b2b4ae"), random() * 0.35);
      this.rocks.push({ x, z, scale: range(random, 0.4, 1.1), rotation: random() * Math.PI * 2, color: tint });
    }

    this.treeGreen = new Uint8Array(this.trees.length);
    this.buildTrees();
    this.buildRocks();
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

  private clearMeshes(): void {
    for (const mesh of [this.canopy, this.deadCrown, this.trunks, this.rockMesh]) {
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
  }
}
