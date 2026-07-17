export const WORLD_CONFIG = {
  /** Legacy feature scale used for brush/effect sizing. */
  size: 188,
  /** Mountain-to-sea world length: twice the former square map. */
  sizeX: 376,
  /** Cross-valley width: two thirds of the former square map. */
  sizeZ: 125.33333333333333,
  segments: 168,
  /** Real rectangular grid dimensions; every cell remains square. */
  segmentsX: 336,
  segmentsZ: 112,
  /** Vertical relief is scaled around sea level after terrain generation. */
  verticalScale: 3,
  baseMinHeight: -5,
  baseMaxHeight: 78,
  minHeight: -14.64,
  maxHeight: 234.36,
  seaLevel: -0.18,
  brush: {
    radius: 3.2,
    strength: 5.4,
    minRadius: 1.2,
    maxRadius: 16,
    minStrength: 1,
    maxStrength: 20,
  },
  water: {
    sourceRate: 0.8,
    flow: 0.14,
    substeps: 3,
    evaporation: 0.00001,
    irrigationRadius: 3,
    minIrrigationRadius: 0.5,
    maxIrrigationRadius: 8,
  },
  camera: {
    fov: 43,
    // 提高近裁面以增加深度缓冲精度，减少水面与地表之间的闪线。
    near: 0.5,
    far: 1600,
    position: [278, 342, 238] as [number, number, number],
    target: [-22, 24, 0] as [number, number, number],
  },
} as const;

export const TERRAIN_PALETTE = {
  valley: "#dfcf8c",
  meadow: "#d8c477",
  pine: "#c6ae64",
  earth: "#9b8663",
  rock: "#858681",
  highRock: "#a5a8a5",
  snowShadow: "#c9d7d8",
  snow: "#eef2ee",
  sand: "#c9b77e",
  wetSand: "#9e936f",
  seabed: "#617b72",
} as const;

/** The original cool terrain palette, restored wherever flowing water irrigates the ground. */
export const WATERED_TERRAIN_PALETTE = {
  valley: "#87947a",
  meadow: "#71856b",
  pine: "#506b5c",
  earth: "#667866",
} as const;
