import { createNoise2D } from "simplex-noise";
import { WORLD_CONFIG } from "@/engine/config";
import { hashSeed, mulberry32, range } from "@/engine/math/random";
import type { MountainData } from "@/engine/types";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export class MountainGenerator {
  readonly resolution = WORLD_CONFIG.segments + 1;

  generate(seedLabel: string): MountainData {
    const seed = hashSeed(seedLabel);
    const random = mulberry32(seed);
    const noise = createNoise2D(random);
    const heights = new Float32Array(this.resolution * this.resolution);
    const angle = range(random, -0.72, -0.42);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const peakCenters = [
      { along: range(random, -0.48, -0.33), height: range(random, 4.7, 6.1), width: 0.2 },
      { along: range(random, -0.08, 0.08), height: range(random, 7.4, 9.1), width: 0.22 },
      { along: range(random, 0.31, 0.48), height: range(random, 4.8, 6.6), width: 0.2 },
    ];

    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let peakIndex = 0;

    for (let z = 0; z < this.resolution; z += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const nx = (x / (this.resolution - 1)) * 2 - 1;
        const nz = (z / (this.resolution - 1)) * 2 - 1;

        const warpX = noise(nx * 1.25 + 17.3, nz * 1.25 - 8.1) * 0.1;
        const warpZ = noise(nx * 1.15 - 4.8, nz * 1.15 + 12.7) * 0.1;
        const wx = nx + warpX;
        const wz = nz + warpZ;
        const across = wx * cos + wz * sin;
        const along = -wx * sin + wz * cos;
        const spineOffset = noise(along * 1.35 + 30, 4.2) * 0.12 + Math.sin(along * 4.4) * 0.035;
        const ridgeDistance = Math.abs(across - spineOffset);

        const narrowRidge = Math.exp(-Math.pow(ridgeDistance * 3.55, 1.42));
        const wideShoulder = Math.exp(-Math.pow(ridgeDistance * 1.62, 1.72));
        const edge = Math.max(Math.abs(nx), Math.abs(nz));
        const edgeFade = 1 - smoothstep(0.7, 1, edge);
        const endFade = 1 - smoothstep(0.72, 1.15, Math.abs(along));

        let peaks = 0;
        for (const peak of peakCenters) {
          const da = along - peak.along;
          peaks += peak.height * Math.exp(
            -(da * da) / (peak.width * peak.width) -
              (ridgeDistance * ridgeDistance) / 0.045,
          );
        }

        let ridged = 0;
        let organic = 0;
        let amplitude = 1;
        let frequency = 1.55;
        let amplitudeTotal = 0;
        for (let octave = 0; octave < 5; octave += 1) {
          const sample = noise(wx * frequency + 51.7, wz * frequency - 22.4);
          const ridge = 1 - Math.abs(sample);
          ridged += ridge * ridge * amplitude;
          organic += sample * amplitude;
          amplitudeTotal += amplitude;
          amplitude *= 0.5;
          frequency *= 2.03;
        }
        ridged /= amplitudeTotal;
        organic /= amplitudeTotal;

        const valleyNoise = Math.abs(noise(wx * 2.15 - 70, wz * 2.15 + 14));
        const drainageCut = Math.exp(-valleyNoise * 13) * (1 - narrowRidge) * 2.2;
        const mountainBody = 1.15 + wideShoulder * 5.7 + narrowRidge * 6.4 + peaks;
        const crags = (ridged - 0.42) * (2.8 + narrowRidge * 2.2) + organic * 1.05;
        const basinTilt = (nx * -0.42 + nz * 0.24) * 0.8;
        let height = -0.72 + edgeFade * endFade * (mountainBody + crags - drainageCut) + basinTilt;
        height = Math.max(WORLD_CONFIG.minHeight, Math.min(WORLD_CONFIG.maxHeight, height));

        const index = z * this.resolution + x;
        heights[index] = height;
        if (height > maximum) {
          maximum = height;
          peakIndex = index;
        }
        minimum = Math.min(minimum, height);
      }
    }

    this.erode(heights, 5);

    minimum = Number.POSITIVE_INFINITY;
    maximum = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < heights.length; i += 1) {
      minimum = Math.min(minimum, heights[i]);
      if (heights[i] > maximum) {
        maximum = heights[i];
        peakIndex = i;
      }
    }

    const sourceIndex = this.findGlacierSource(heights, maximum, peakIndex);
    return { heights, peakIndex, sourceIndex, minHeight: minimum, maxHeight: maximum };
  }

  private erode(heights: Float32Array, iterations: number): void {
    const delta = new Float32Array(heights.length);
    const n = this.resolution;
    const talus = 0.74;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      delta.fill(0);
      for (let z = 1; z < n - 1; z += 1) {
        for (let x = 1; x < n - 1; x += 1) {
          const index = z * n + x;
          let lowestIndex = index;
          let largestDrop = 0;
          const neighbors = [index - 1, index + 1, index - n, index + n];
          for (const neighbor of neighbors) {
            const drop = heights[index] - heights[neighbor];
            if (drop > largestDrop) {
              largestDrop = drop;
              lowestIndex = neighbor;
            }
          }
          if (largestDrop > talus) {
            const amount = (largestDrop - talus) * 0.11;
            delta[index] -= amount;
            delta[lowestIndex] += amount;
          }
        }
      }
      for (let i = 0; i < heights.length; i += 1) heights[i] += delta[i];
    }
  }

  private findGlacierSource(heights: Float32Array, maximum: number, peakIndex: number): number {
    const n = this.resolution;
    const peakX = peakIndex % n;
    const peakZ = Math.floor(peakIndex / n);
    let bestIndex = peakIndex;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let z = 4; z < n - 4; z += 1) {
      for (let x = 4; x < n - 4; x += 1) {
        const index = z * n + x;
        const height = heights[index];
        if (height < maximum * 0.6 || height > maximum * 0.9) continue;
        const lowestNeighbor = Math.min(
          heights[index - 1],
          heights[index + 1],
          heights[index - n],
          heights[index + n],
        );
        const drop = height - lowestNeighbor;
        const peakDistance = Math.hypot(x - peakX, z - peakZ) / n;
        const score = drop * 5 + height * 0.09 - peakDistance * 2.4;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    }
    return bestIndex;
  }
}

