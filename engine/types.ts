export type TerrainTool = "orbit" | "carve" | "raise" | "smooth" | "paint-green" | "paint-yellow" | "paint-rock";

export type MountainData = {
  heights: Float32Array;
  /** Full static square used to render non-interactive side scenery. */
  squareHeights: Float32Array;
  /** First square-grid row occupied by the active simulation strip. */
  activeCropStartZ: number;
  peakIndex: number;
  sourceIndex: number;
  minHeight: number;
  maxHeight: number;
};

export type WorldStats = {
  elevation: number;
  peak: number;
  waterVolume: number;
  wateredYellowPercent: number;
  fps: number;
};

export type WorldEventHandlers = {
  onReady?: () => void;
  onStats?: (stats: WorldStats) => void;
  onTerrainEdit?: () => void;
  onWaterSourcePlacementChange?: (placing: boolean) => void;
};

export type MapSaveData = {
  /** Grid dimensions allow saves to be validated after world-shape changes. */
  gridWidth?: number;
  gridHeight?: number;
  /** Vertical scale used when the save was written. */
  verticalScale?: number;
  heights: number[];
  waterDepths: number[];
  sourceIndex: number;
  peakIndex: number;
  minHeight: number;
  maxHeight: number;
  seed: string;
  /** Legacy guided-camera setting retained only for old save compatibility. */
  playCameraHeight?: number;
  /** Permanently green ground painted by the user. Omitted by older saves. */
  groundPaint?: number[];
  /** Protective ground covered by user-painted low-poly boulders. Omitted by older saves. */
  rockPaint?: number[];
  /** Per-vertex stroke group used to rebuild each painted low-poly boulder. */
  rockGroups?: number[];
  /** True when saved terrain heights already include the boulder surface profile. */
  rockHeightsIntegrated?: boolean;
  /** Placed custom model instances (Y derived from terrain on load). */
  modelInstances: StoredModelInstance[];
};

export type SavedMapMeta = {
  id: string;
  name: string;
  createdAt: number;
  seed: string;
  peakHeight: number;
};

/* ---- External model import types ---- */

/** A single instance placement defined in the model config. */
export type ModelInstanceConfig = {
  x: number;
  z: number;
  /** Y-axis rotation in radians. Default 0. */
  rotation?: number;
  /** Uniform scale. Default 1. */
  scale?: number;
};

/** A named group of model instances sharing the same GLTF source. */
export type ModelPreset = {
  /** Human-readable label, e.g. "Mountain Cabin". */
  name: string;
  /** Path to GLTF/GLB file, served from public/, e.g. "/models/cabin.glb". */
  modelPath: string;
  /** Positions for each instance of this model. */
  instances: ModelInstanceConfig[];
  /** Extra Y offset added above terrain surface after height docking. Default 0. */
  heightOffset?: number;
  /** When true (default), dock model bottom to terrain.heightAt(x,z). */
  dockToTerrain?: boolean;
  /** Whether the model casts shadows. Default true. */
  castShadow?: boolean;
  /** Whether the model receives shadows. Default true. */
  receiveShadow?: boolean;
};

/** Top-level models configuration. */
export type ModelsConfig = {
  presets: ModelPreset[];
  /** If enabled, procedural trees are replaced by a GLTF at the same seed-derived positions. */
  replaceTrees?: { enabled: boolean; modelPath: string };
  /** If enabled, procedural rocks are replaced by a GLTF at the same seed-derived positions. */
  replaceRocks?: { enabled: boolean; modelPath: string };
};

/** Stored representation of a single model instance in save data.
 *  Y-coordinate is NOT stored — always derived from terrain.heightAt(x,z) on restore. */
export type StoredModelInstance = {
  modelPath: string;
  x: number;
  z: number;
  rotation: number;
  scale: number;
};
