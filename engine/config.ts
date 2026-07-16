export const WORLD_CONFIG = {
  size: 188,
  segments: 168,
  minHeight: -5,
  maxHeight: 78,
  seaLevel: -0.18,
  brush: {
    radius: 3.2,
    strength: 5.4,
    minRadius: 1.2,
    maxRadius: 8,
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
    far: 620,
    position: [132, 104, 156] as [number, number, number],
    target: [-8, 8, 0] as [number, number, number],
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
