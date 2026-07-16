import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import { hashSeed, mulberry32, range } from "@/engine/math/random";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

type Placement = { x: number; z: number; scale: number; rotation: number; color: THREE.Color };

export class ScenerySystem {
  private readonly group = new THREE.Group();
  private trees: Placement[] = [];
  private rocks: Placement[] = [];
  private canopy?: THREE.InstancedMesh;
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
    const half = WORLD_CONFIG.size * 0.47;
    const exclusion = 8.6;
    this.trees = [];
    this.rocks = [];

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
      scale.setScalar(tree.scale);
      position.set(tree.x, height + 0.96 * tree.scale, tree.z);
      matrix.compose(position, quaternion, scale);
      this.canopy?.setMatrixAt(index, matrix);

      scale.set(tree.scale, tree.scale, tree.scale);
      position.set(tree.x, height + 0.28 * tree.scale, tree.z);
      matrix.compose(position, quaternion, scale);
      this.trunks?.setMatrixAt(index, matrix);
    });
    if (this.canopy) this.canopy.instanceMatrix.needsUpdate = true;
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
    this.trunks = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshStandardMaterial({ color: "#625c4e", roughness: 1, flatShading: true }), this.trees.length);
    this.canopy.castShadow = true;
    this.canopy.receiveShadow = true;
    this.trunks.castShadow = true;
    this.trees.forEach((tree, index) => this.canopy?.setColorAt(index, tree.color));
    if (this.canopy.instanceColor) this.canopy.instanceColor.needsUpdate = true;
    this.group.add(this.canopy, this.trunks);
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
    for (const mesh of [this.canopy, this.trunks, this.rockMesh]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material.dispose();
    }
    this.canopy = undefined;
    this.trunks = undefined;
    this.rockMesh = undefined;
  }
}

