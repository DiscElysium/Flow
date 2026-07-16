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
    // The ridge lives deliberately in the western half of the map. Seeded
    // rotation keeps each generated silhouette distinct without moving the
    // mountain into the plains.
    const angle = range(random, -0.28, 0.22);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const peakCenters = [
      { along: range(random, -0.5, -0.36), height: range(random, 12, 16), width: 0.25 },
      { along: range(random, -0.08, 0.08), height: range(random, 21, 26), width: 0.31 },
      { along: range(random, 0.34, 0.5), height: range(random, 13, 17), width: 0.26 },
    ];

    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let peakIndex = 0;

    for (let z = 0; z < this.resolution; z += 1) {
      for (let x = 0; x < this.resolution; x += 1) {
        const nx = (x / (this.resolution - 1)) * 2 - 1;
        const nz = (z / (this.resolution - 1)) * 2 - 1;

        const warpX = noise(nx * 1.25 + 17.3, nz * 1.25 - 8.1) * 0.085;
        const warpZ = noise(nx * 1.15 - 4.8, nz * 1.15 + 12.7) * 0.085;
        const wx = nx + warpX;
        const wz = nz + warpZ;
        const mountainX = wx + 0.5;
        const across = mountainX * cos + wz * sin;
        const along = -mountainX * sin + wz * cos;
        const primaryBend = noise(along * 0.82 + 30, 4.2) * 0.18;
        const secondaryBend = noise(along * 2.85 - 17, -31.4) * 0.062;
        const curlPhase = noise(along * 0.7 + 11, 12.8) * 1.7;
        const spineOffset = primaryBend
          + secondaryBend
          + Math.sin(along * 5.1 + curlPhase) * 0.045;
        const ridgeDistance = Math.abs(across - spineOffset);

        const forkPulse = noise(along * 1.15 + 74, -9.8) * 0.5 + 0.5;
        const eastSpine = spineOffset
          + 0.21
          + forkPulse * 0.085
          + noise(along * 3.1 + 63, -18.4) * 0.07;
        const westSpine = spineOffset
          - 0.225
          - (1 - forkPulse) * 0.095
          + noise(along * 2.7 - 24, 39.1) * 0.075;
        const eastRidgeDistance = Math.abs(across - eastSpine);
        const westRidgeDistance = Math.abs(across - westSpine);

        const narrowRidge = Math.exp(-Math.pow(ridgeDistance * 4.05, 1.48));
        const wideShoulder = Math.exp(-Math.pow(ridgeDistance * 2.02, 1.78));
        const ridgeModulation = 0.7
          + (noise(along * 3.3 + 91, across * 1.4 - 47) * 0.5 + 0.5) * 0.56;
        const eastRidge = Math.exp(-Math.pow(eastRidgeDistance * 5.3, 1.62)) * ridgeModulation;
        const westRidge = Math.exp(-Math.pow(westRidgeDistance * 4.9, 1.68))
          * (1.32 - ridgeModulation * 0.42);
        const edge = Math.max(Math.abs(nx), Math.abs(nz));
        const edgeFade = 1 - smoothstep(0.88, 1, edge);
        const endFade = 1 - smoothstep(0.72, 1.08, Math.abs(along));
        // Begin the eastern falloff much earlier so elevation is shed across
        // a long shoulder instead of collapsing at the mountain's foot.
        const leftHalfMask = 1 - smoothstep(-0.34, 0.14, nx);
        const mountainEnvelope = Math.exp(
          -Math.pow(Math.abs(mountainX) / 0.68, 2.3) - Math.pow(along / 0.92, 6),
        ) * leftHalfMask * edgeFade * endFade;

        let peaks = 0;
        for (const peak of peakCenters) {
          const da = along - peak.along;
          // Super-Gaussian caps stay broad and rounded near their summit,
          // avoiding a stack of sharp cone-like peaks.
          const roundedCap = Math.exp(
            -Math.pow(Math.abs(da) / peak.width, 3.15)
            -Math.pow(ridgeDistance / 0.205, 3.05),
          );
          peaks += peak.height * roundedCap;
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
        const drainageCut = Math.exp(-valleyNoise * 13) * (1 - narrowRidge) * 2.7;
        const eastValleySpine = spineOffset + 0.125 + noise(along * 2.45 + 8, 71.2) * 0.036;
        const westValleySpine = spineOffset - 0.145 + noise(along * 2.2 - 51, -26.5) * 0.042;
        const eastValley = Math.exp(-Math.pow(Math.abs(across - eastValleySpine) * 9.2, 1.8));
        const westValley = Math.exp(-Math.pow(Math.abs(across - westValleySpine) * 8.5, 1.8));
        const valleyPulse = 0.58 + (noise(along * 3.7 - 12, 84.6) * 0.5 + 0.5) * 0.7;
        const branchingValleys = (eastValley * 6.5 + westValley * 4.8) * valleyPulse;
        const mountainBody = 3.2
          + wideShoulder * 7.2
          + narrowRidge * 10.2
          + eastRidge * 20
          + westRidge * 15
          + peaks;
        const crags = (ridged - 0.42) * (4.1 + narrowRidge * 3.2) + organic * 1.75;

        // A broken band of foothills interrupts the overall descent and makes
        // the mountain read as a range with shoulders, hollows and low passes.
        const foothillBand = smoothstep(-0.5, -0.2, nx) * (1 - smoothstep(0.08, 0.3, nx));
        const foothillField = noise(nx * 3.15 + 126, nz * 3.15 - 77) * 0.5 + 0.5;
        const foothillDetail = noise(nx * 6.4 - 43, nz * 6.4 + 15) * 0.5 + 0.5;
        const foothillHeight = foothillBand
          * smoothstep(0.39, 0.72, foothillField)
          * (2.2 + foothillDetail * 3.8)
          * edgeFade;
        const piedmontRise = smoothstep(-0.46, -0.18, nx);
        const piedmontFade = 1 - smoothstep(-0.18, 0.38, nx);
        const piedmontNoise = noise(nx * 1.72 + 184, nz * 1.72 - 112) * 0.5 + 0.5;
        const piedmontBase = piedmontRise
          * piedmontFade
          * (8.5 + piedmontNoise * 4.2)
          * endFade
          * edgeFade;
        const rollingFoothills = piedmontRise
          * (1 - smoothstep(-0.02, 0.36, nx))
          * smoothstep(0.46, 0.76, piedmontNoise)
          * (1.8 + foothillDetail * 3.2)
          * edgeFade;

        // The eastern half is a broad plain with seed-dependent low hills.
        const plainLarge = noise(nx * 1.45 + 104, nz * 1.45 - 31) * 0.5 + 0.5;
        const plainDetail = noise(nx * 4.1 - 19, nz * 4.1 + 58) * 0.5 + 0.5;
        const hillPockets = smoothstep(0.48, 0.82, plainLarge) * (0.7 + plainDetail * 1.8);
        const plainHeight = 1.15 + hillPockets + noise(nx * 2.25 + 8, nz * 2.25 - 61) * 0.38;

        // A noisy coastline creates a non-uniform beach, then sinks into a
        // shallow procedural seabed at the far-right edge.
        const coastline = 0.68
          + noise(nz * 1.55 + 211, -14.7) * 0.048
          + noise(nz * 4.8 - 83, 42.3) * 0.014;
        const beachStart = coastline - 0.13;
        const seaStart = coastline + 0.035;
        const beachBlend = smoothstep(beachStart, seaStart, nx);
        const beachHeight = 0.62
          + noise(nx * 5.2 + 17, nz * 5.2 - 5) * 0.14
          - smoothstep(beachStart, seaStart, nx) * 0.82;
        const oceanProgress = smoothstep(seaStart, 1, nx);
        const seaDepth = WORLD_CONFIG.seaLevel
          - 0.14
          - oceanProgress * 4.15
          + noise(nx * 2.8 - 91, nz * 2.8 + 27) * (0.08 + oceanProgress * 0.2);
        const landToBeach = plainHeight * (1 - beachBlend) + beachHeight * beachBlend;
        const seaBlend = smoothstep(0.58, 1, beachBlend);
        const coastalHeight = landToBeach * (1 - seaBlend) + seaDepth * seaBlend;

        const mountainHeight = (
          mountainBody + crags - drainageCut - branchingValleys
        ) * mountainEnvelope
          + foothillHeight
          + piedmontBase
          + rollingFoothills;
        let height = coastalHeight + mountainHeight;
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

    this.erode(heights, 16);

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
    const talus = 0.5;

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
        if (height < maximum * 0.7 || height > maximum * 0.96) continue;
        const lowestNeighbor = Math.min(
          heights[index - 1],
          heights[index + 1],
          heights[index - n],
          heights[index + n],
        );
        const drop = height - lowestNeighbor;
        const peakDistance = Math.hypot(x - peakX, z - peakZ) / n;
        if (peakDistance < 0.025 || peakDistance > 0.14) continue;
        const eastward = (x - peakX) / n;
        const score = drop * 5 + height * 0.14 - peakDistance * 12 + eastward * 3.2;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    }
    return bestIndex;
  }
}

