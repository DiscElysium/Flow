export const WORLD_CONFIG = {
  size: 92,
  segments: 168,
  minHeight: -2.5,
  maxHeight: 44,
  brush: {
    radius: 4.2,
    strength: 5.4,
    minRadius: 1.6,
    maxRadius: 9.6,
  },
  water: {
    sourceRate: 0.8,
    flow: 0.14,
    substeps: 3,
    evaporation: 0.00001,
  },
  camera: {
    fov: 43,
    near: 0.1,
    far: 360,
    position: [30, 23, 31] as [number, number, number],
    target: [0, 6.4, 0] as [number, number, number],
  },
} as const;

export const TERRAIN_PALETTE = {
  valley: "#87947a",
  meadow: "#71856b",
  pine: "#506b5c",
  earth: "#786f62",
  rock: "#858681",
  highRock: "#a5a8a5",
  snowShadow: "#c9d7d8",
  snow: "#eef2ee",
} as const;

