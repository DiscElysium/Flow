import * as THREE from "three";
import { WORLD_CONFIG } from "@/engine/config";
import { hashSeed, mulberry32, range } from "@/engine/math/random";
import type { TerrainSystem } from "@/engine/terrain/TerrainSystem";

type CloudState = {
  group: THREE.Group;
  speed: number;
  baseY: number;
  phase: number;
  minX: number;
  maxX: number;
  layer: "mountain" | "high" | "coast";
};

type BirdMember = {
  group: THREE.Group;
  leftWing: THREE.Mesh;
  rightWing: THREE.Mesh;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  phase: number;
};

type FlightState = {
  direction: 1 | -1;
  startX: number;
  endX: number;
  targetX: number;
  targetZ: number;
  baseY: number;
  elapsed: number;
  duration: number;
  birds: BirdMember[];
};

const TRIGGER_MIN_X = -WORLD_CONFIG.sizeX * 0.12;
const TRIGGER_MAX_X = WORLD_CONFIG.sizeX * 0.4;
const CLOUD_WRAP = WORLD_CONFIG.sizeX * 0.86;

function createWingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([
      -0.12, 0, 0,
      0.22, 0, side * 0.64,
      -0.18, 0, side * 0.92,
    ], 3),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

/** Distant low-poly clouds plus irrigation-triggered bird flights. */
export class SkyWildlifeSystem {
  private readonly cloudRoot = new THREE.Group();
  private readonly birdRoot = new THREE.Group();
  private readonly cloudGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly cloudMaterials = [
    new THREE.MeshBasicMaterial({
      color: "#eef2ef",
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      fog: false,
    }),
    new THREE.MeshBasicMaterial({
      color: "#dce5e2",
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      fog: false,
    }),
  ];
  private readonly bodyGeometry = new THREE.OctahedronGeometry(0.28, 0);
  private readonly leftWingGeometry = createWingGeometry(1);
  private readonly rightWingGeometry = createWingGeometry(-1);
  private readonly birdMaterial = new THREE.MeshStandardMaterial({
    color: "#111412",
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  private clouds: CloudState[] = [];
  private random: () => number = Math.random;
  private flight: FlightState | null = null;
  private nextFlightDelay = 5;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: TerrainSystem,
    seed: string,
  ) {
    this.cloudRoot.name = "procedural-cloud-layer";
    this.birdRoot.name = "irrigation-bird-flock";
    this.scene.add(this.cloudRoot, this.birdRoot);
    this.regenerate(seed);
  }

  regenerate(seed: string): void {
    this.random = mulberry32(hashSeed(`${seed}:sky-wildlife`));
    this.rebuildClouds();
    this.finishFlight();
    this.nextFlightDelay = range(this.random, 4, 8);
  }

  update(deltaTime: number, timeMs: number): void {
    this.updateClouds(deltaTime, timeMs);

    if (this.flight) {
      this.updateFlight(deltaTime, timeMs);
      return;
    }

    this.nextFlightDelay -= deltaTime;
    if (this.nextFlightDelay > 0) return;
    const target = this.terrain.findWateredGreenPointInXRange(
      TRIGGER_MIN_X,
      TRIGGER_MAX_X,
      this.random,
    );
    if (!target) {
      this.nextFlightDelay = range(this.random, 2.5, 4.5);
      return;
    }
    this.beginFlight(target);
  }

  dispose(): void {
    this.finishFlight();
    this.cloudRoot.clear();
    this.scene.remove(this.cloudRoot, this.birdRoot);
    this.cloudGeometry.dispose();
    this.cloudMaterials.forEach((material) => material.dispose());
    this.bodyGeometry.dispose();
    this.leftWingGeometry.dispose();
    this.rightWingGeometry.dispose();
    this.birdMaterial.dispose();
  }

  private rebuildClouds(): void {
    this.cloudRoot.clear();
    this.clouds = [];
    const verticalScale = WORLD_CONFIG.verticalScale;

    const layerCounts = {
      mountain: 6,
      high: 5,
      coast: 5,
    } as const;

    for (const layer of ["mountain", "high", "coast"] as const) {
      for (let cloudIndex = 0; cloudIndex < layerCounts[layer]; cloudIndex += 1) {
        const group = new THREE.Group();
        const isLong = cloudIndex === 0 ? false : cloudIndex === 1 ? true : this.random() < 0.52;
        const isWide = cloudIndex === 0 ? false : cloudIndex === 1 ? true : this.random() < 0.48;
        const length = isLong
          ? range(this.random, 24, 40)
          : range(this.random, 10, 19);
        const width = isWide
          ? range(this.random, 10, 17)
          : range(this.random, 5, 8.5);
        const thickness = range(this.random, 0.8, 1.55);
        const blockCount = 3 + Math.floor(this.random() * 4);

        for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
          const material = this.cloudMaterials[blockIndex % this.cloudMaterials.length];
          const block = new THREE.Mesh(this.cloudGeometry, material);
          const isCore = blockIndex === 0;
          block.position.set(
            isCore ? 0 : range(this.random, -length * 0.39, length * 0.39),
            isCore ? 0 : this.random() < 0.28 ? thickness * 0.28 : 0,
            isCore ? 0 : range(this.random, -width * 0.36, width * 0.36),
          );
          block.scale.set(
            length * (isCore ? 0.68 : range(this.random, 0.2, 0.43)),
            thickness * (isCore ? 0.78 : range(this.random, 0.58, 0.92)),
            width * (isCore ? 0.64 : range(this.random, 0.4, 0.68)),
          );
          block.castShadow = false;
          block.receiveShadow = false;
          group.add(block);
        }

        let baseY: number;
        let minX: number;
        let maxX: number;
        let minZ: number;
        let maxZ: number;
        let speed: number;

        if (layer === "mountain") {
          baseY = Math.max(
            36 * verticalScale,
            this.terrain.maxHeight - range(this.random, 8 * verticalScale, 19 * verticalScale),
          );
          minX = -CLOUD_WRAP;
          maxX = WORLD_CONFIG.sizeX * 0.14;
          minZ = -WORLD_CONFIG.sizeZ * 0.58;
          maxZ = WORLD_CONFIG.sizeZ * 0.58;
          speed = range(this.random, 0.09, 0.22);
        } else if (layer === "high") {
          baseY = this.terrain.maxHeight + range(
            this.random,
            28 * verticalScale,
            58 * verticalScale,
          );
          minX = -CLOUD_WRAP;
          maxX = CLOUD_WRAP;
          minZ = -WORLD_CONFIG.sizeZ * 0.72;
          maxZ = WORLD_CONFIG.sizeZ * 0.72;
          speed = range(this.random, 0.12, 0.28);
        } else {
          baseY = range(this.random, 22 * verticalScale, 39 * verticalScale);
          minX = WORLD_CONFIG.sizeX * 0.23;
          maxX = CLOUD_WRAP;
          minZ = -WORLD_CONFIG.sizeZ * 0.64;
          maxZ = WORLD_CONFIG.sizeZ * 0.64;
          speed = range(this.random, 0.07, 0.18);
        }

        group.position.set(
          range(this.random, minX, maxX),
          baseY,
          range(this.random, minZ, maxZ),
        );
        group.rotation.y = Math.PI * 0.5;
        this.cloudRoot.add(group);
        this.clouds.push({
          group,
          speed,
          baseY,
          phase: range(this.random, 0, Math.PI * 2),
          minX,
          maxX,
          layer,
        });
      }
    }
  }

  private updateClouds(deltaTime: number, timeMs: number): void {
    for (const cloud of this.clouds) {
      cloud.group.position.x += cloud.speed * deltaTime;
      if (cloud.group.position.x > cloud.maxX) cloud.group.position.x = cloud.minX;
      cloud.group.position.y = cloud.baseY
        + Math.sin(timeMs * 0.00008 + cloud.phase) * 0.42 * WORLD_CONFIG.verticalScale;
    }
  }

  private beginFlight(target: THREE.Vector3): void {
    this.birdRoot.clear();
    const direction: 1 | -1 = this.random() < 0.5 ? 1 : -1;
    const edge = WORLD_CONFIG.sizeX * 0.5 + 22;
    const startX = direction > 0 ? -edge : edge;
    const endX = -startX;
    const speed = range(this.random, 16, 22);
    const birdCount = 8 + Math.floor(this.random() * 5);
    const birds: BirdMember[] = [];

    for (let index = 0; index < birdCount; index += 1) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeometry, this.birdMaterial);
      body.scale.set(1.55, 0.62, 0.62);
      const leftWing = new THREE.Mesh(this.leftWingGeometry, this.birdMaterial);
      const rightWing = new THREE.Mesh(this.rightWingGeometry, this.birdMaterial);
      group.add(body, leftWing, rightWing);
      group.rotation.y = direction < 0 ? Math.PI : 0;
      group.scale.setScalar(range(this.random, 0.82, 1.18));
      this.birdRoot.add(group);

      const rank = index === 0 ? 0 : Math.ceil(index / 2);
      const formationSide = index === 0 ? 0 : index % 2 === 0 ? 1 : -1;
      birds.push({
        group,
        leftWing,
        rightWing,
        offsetX: -direction * rank * range(this.random, 1.45, 1.85),
        offsetY: index === 0 ? 0 : range(this.random, -0.35, 0.7),
        offsetZ: formationSide * rank * range(this.random, 1.05, 1.38),
        phase: range(this.random, 0, Math.PI * 2),
      });
    }

    this.flight = {
      direction,
      startX,
      endX,
      targetX: target.x,
      targetZ: target.z,
      baseY: Math.max(
        24 * WORLD_CONFIG.verticalScale,
        target.y + range(
          this.random,
          15 * WORLD_CONFIG.verticalScale,
          22 * WORLD_CONFIG.verticalScale,
        ),
      ),
      elapsed: 0,
      duration: Math.abs(endX - startX) / speed,
      birds,
    };
  }

  private updateFlight(deltaTime: number, timeMs: number): void {
    const flight = this.flight;
    if (!flight) return;
    flight.elapsed += deltaTime;
    const progress = flight.elapsed / flight.duration;
    if (progress >= 1.04) {
      this.finishFlight();
      this.nextFlightDelay = range(this.random, 14, 26);
      return;
    }

    const clampedProgress = THREE.MathUtils.clamp(progress, 0, 1);
    const leaderX = THREE.MathUtils.lerp(flight.startX, flight.endX, clampedProgress);
    const targetProgress = (flight.targetX - flight.startX) / (flight.endX - flight.startX);
    const leaderZ = flight.targetZ
      + Math.sin((clampedProgress - targetProgress) * Math.PI * 2) * 0.9;
    const leaderY = flight.baseY
      + Math.sin(clampedProgress * Math.PI) * 4 * WORLD_CONFIG.verticalScale;

    for (const bird of flight.birds) {
      const bob = Math.sin(timeMs * 0.006 + bird.phase) * 0.18;
      bird.group.position.set(
        leaderX + bird.offsetX,
        leaderY + bird.offsetY + bob,
        leaderZ + bird.offsetZ,
      );
      const flap = Math.sin(timeMs * 0.014 + bird.phase) * 0.78;
      bird.leftWing.rotation.x = flap;
      bird.rightWing.rotation.x = -flap;
      bird.group.rotation.z = Math.sin(timeMs * 0.0028 + bird.phase) * 0.08;
    }
  }

  private finishFlight(): void {
    this.flight = null;
    this.birdRoot.clear();
  }
}
