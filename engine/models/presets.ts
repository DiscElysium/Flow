import type { ModelsConfig } from "@/engine/types";

/**
 * User-editable model configuration.
 *
 * Place your .glb / .gltf files inside `public/models/` and reference them
 * here by path, e.g. `"/models/cabin.glb"`.
 *
 * Each preset can have multiple instances placed at different world-space
 * (x, z) coordinates.  The Y coordinate is always derived from the terrain
 * surface so models sit correctly even after the terrain is edited.
 */
export const MODELS_CONFIG: ModelsConfig = {
  presets: [
    // Example — add your own models below:
    // {
    //   name: "Mountain Cabin",
    //   modelPath: "/models/cabin.glb",
    //   instances: [
    //     { x: 8, z: 12, rotation: Math.PI * 0.25, scale: 1.2 },
    //     { x: -10, z: -7, rotation: -0.5, scale: 1.0 },
    //   ],
    //   heightOffset: 0.15,
    // },
    // {
    //   name: "Fence Posts",
    //   modelPath: "/models/fence_post.glb",
    //   instances: [
    //     { x: -5, z: 15 },
    //     { x: -4, z: 15.5 },
    //     { x: -3, z: 16 },
    //   ],
    //   dockToTerrain: true,
    // },
  ],
  // replaceTrees: { enabled: true, modelPath: "/models/pine_tree.glb" },
  // replaceRocks: { enabled: true, modelPath: "/models/boulder.glb" },
};
