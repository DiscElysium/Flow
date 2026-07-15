import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ModelsConfig, StoredModelInstance, ModelPreset } from "@/engine/types";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";
import type { ScenerySystem } from "@/engine/scenery/ScenerySystem";

type RuntimeInstance = {
  group: THREE.Group;
  modelPath: string;
  x: number;
  z: number;
  rotation: number;
  scale: number;
  heightOffset: number;
  dockToTerrain: boolean;
};

/**
 * Manages external GLTF/GLB model loading, placement, height docking, and
 * save-state serialization.  Works alongside ScenerySystem — this handles
 * imported models while ScenerySystem handles procedural trees/rocks.
 */
export class ModelManager {
  private readonly group = new THREE.Group();
  private readonly loadedGltfs = new Map<string, THREE.Group>();
  private instances: RuntimeInstance[] = [];
  private sceneryGroup: THREE.Group | null = null;
  private scenery?: ScenerySystem;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    private readonly config: ModelsConfig,
  ) {
    this.group.name = "custom-models";
    this.scene.add(this.group);
  }

  /** Pass the ScenerySystem reference so scenery replacement can read placements. */
  attachScenery(scenery: ScenerySystem): void {
    this.scenery = scenery;
  }

  /** Load all GLTFs from config, clone instances, and place at configured positions. */
  async initialize(): Promise<void> {
    for (const preset of this.config.presets) {
      await this.loadPreset(preset);
    }

    if (this.config.replaceTrees?.enabled || this.config.replaceRocks?.enabled) {
      this.applySceneryReplacement();
    }
  }

  /** Re-dock all terrain-following instances after terrain edits. */
  refreshHeights(): void {
    for (const inst of this.instances) {
      if (!inst.dockToTerrain) continue;
      const y = this.terrain.heightAt(inst.x, inst.z);
      inst.group.position.y = y + inst.heightOffset;
    }

    // Re-dock scenery replacement instances too
    if (this.sceneryGroup) {
      for (const child of this.sceneryGroup.children) {
        // world-space position is stored in the group; read x,z and recompute y
        const x = child.position.x;
        const z = child.position.z;
        child.position.y = this.terrain.heightAt(x, z);
      }
    }
  }

  /** Serialize placed instances for save data. Y is NOT stored — derived from terrain on load. */
  getInstanceData(): StoredModelInstance[] {
    return this.instances.map((inst) => ({
      modelPath: inst.modelPath,
      x: inst.x,
      z: inst.z,
      rotation: inst.rotation,
      scale: inst.scale,
    }));
  }

  /** Restore model instances from saved data. Clears current instances first. */
  async loadInstanceData(data: StoredModelInstance[]): Promise<void> {
    // Clear existing instances
    this.clearInstances();

    if (!data || data.length === 0) return;

    for (const stored of data) {
      try {
        const cached = await this.ensureLoaded(stored.modelPath);
        const clone = cached.clone(true);
        const y = this.terrain.heightAt(stored.x, stored.z);

        clone.position.set(stored.x, y, stored.z);
        clone.rotation.y = stored.rotation;
        clone.scale.setScalar(stored.scale);
        this.applyShadows(clone, true, true);
        this.group.add(clone);

        this.instances.push({
          group: clone,
          modelPath: stored.modelPath,
          x: stored.x,
          z: stored.z,
          rotation: stored.rotation,
          scale: stored.scale,
          heightOffset: 0,
          dockToTerrain: true,
        });
      } catch (err) {
        console.warn(`Failed to restore model "${stored.modelPath}":`, err);
      }
    }
  }

  /** Replace procedural scenery with custom GLTF models. */
  async replaceScenery(treePath?: string, rockPath?: string): Promise<void> {
    this.clearSceneryReplacement();

    if (!this.scenery) return;

    const group = new THREE.Group();
    group.name = "scenery-replacement";

    if (treePath) {
      try {
        const treeScene = await this.ensureLoaded(treePath);
        for (const placement of this.scenery.treePlacements) {
          const clone = treeScene.clone(true);
          const y = this.terrain.heightAt(placement.x, placement.z);
          clone.position.set(placement.x, y, placement.z);
          clone.rotation.y = placement.rotation;
          clone.scale.setScalar(placement.scale);
          this.applyShadows(clone, true, true);
          group.add(clone);
        }
      } catch (err) {
        console.warn(`Failed to load tree replacement model "${treePath}":`, err);
      }
    }

    if (rockPath) {
      try {
        const rockScene = await this.ensureLoaded(rockPath);
        for (const placement of this.scenery.rockPlacements) {
          const clone = rockScene.clone(true);
          const y = this.terrain.heightAt(placement.x, placement.z);
          clone.position.set(placement.x, y, placement.z);
          clone.rotation.y = placement.rotation;
          clone.scale.setScalar(placement.scale);
          this.applyShadows(clone, true, true);
          group.add(clone);
        }
      } catch (err) {
        console.warn(`Failed to load rock replacement model "${rockPath}":`, err);
      }
    }

    if (group.children.length > 0) {
      this.scene.add(group);
      this.sceneryGroup = group;
      this.scenery.setVisible(false);
    }
  }

  /** Remove scenery replacement instances and restore procedural visibility. */
  clearSceneryReplacement(): void {
    if (this.sceneryGroup) {
      this.disposeGroup(this.sceneryGroup);
      this.scene.remove(this.sceneryGroup);
      this.sceneryGroup = null;
    }
    this.scenery?.setVisible(true);
  }

  dispose(): void {
    this.clearSceneryReplacement();
    this.clearInstances();
    // Dispose cached GLTFs
    for (const cached of this.loadedGltfs.values()) {
      this.disposeGroup(cached);
    }
    this.loadedGltfs.clear();
    this.scene.remove(this.group);
  }

  /* ---- private helpers ---- */

  private async loadPreset(preset: ModelPreset): Promise<void> {
    const modelPath = preset.modelPath;
    let sourceScene: THREE.Group;
    try {
      sourceScene = await this.ensureLoaded(modelPath);
    } catch (err) {
      console.warn(`Failed to load model "${modelPath}" for preset "${preset.name}":`, err);
      return;
    }

    for (const cfg of preset.instances) {
      const clone = sourceScene.clone(true);
      const rotation = cfg.rotation ?? 0;
      const scale = cfg.scale ?? 1;
      const heightOffset = preset.heightOffset ?? 0;
      const dockToTerrain = preset.dockToTerrain ?? true;

      const y = dockToTerrain
        ? this.terrain.heightAt(cfg.x, cfg.z) + heightOffset
        : heightOffset;

      clone.position.set(cfg.x, y, cfg.z);
      clone.rotation.y = rotation;
      clone.scale.setScalar(scale);
      this.applyShadows(clone, preset.castShadow ?? true, preset.receiveShadow ?? true);
      this.group.add(clone);

      this.instances.push({
        group: clone,
        modelPath,
        x: cfg.x,
        z: cfg.z,
        rotation,
        scale,
        heightOffset,
        dockToTerrain,
      });
    }
  }

  /** Load a GLTF model, caching by path. */
  private async ensureLoaded(modelPath: string): Promise<THREE.Group> {
    const cached = this.loadedGltfs.get(modelPath);
    if (cached) return cached;

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(modelPath);
    const scene = gltf.scene;
    this.loadedGltfs.set(modelPath, scene);
    // Don't add the cached source to any visible group — it's just a template
    return scene;
  }

  private applyShadows(group: THREE.Group, cast: boolean, receive: boolean): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = cast;
        child.receiveShadow = receive;
      }
    });
  }

  private applySceneryReplacement(): void {
    const treePath = this.config.replaceTrees?.enabled
      ? this.config.replaceTrees.modelPath
      : undefined;
    const rockPath = this.config.replaceRocks?.enabled
      ? this.config.replaceRocks.modelPath
      : undefined;
    this.replaceScenery(treePath, rockPath);
  }

  private clearInstances(): void {
    for (const inst of this.instances) {
      this.group.remove(inst.group);
      this.disposeGroup(inst.group);
    }
    this.instances = [];
  }

  private disposeGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
  }
}
