import { createNoise2D } from "simplex-noise";
import { WORLD_CONFIG } from "@/engine/config";
import { hashSeed, mulberry32, range } from "@/engine/math/random";
import type { MountainData } from "@/engine/types";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
// Generate the full internal relief of a massive mountain, then compress it
// vertically. Together with the larger world size this reads as a huge massif
// seen in miniature, rather than as a single exaggerated high peak.
const MASSIF_VERTICAL_SCALE = 0.72;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export class MountainGenerator {
  readonly resolutionX = WORLD_CONFIG.segmentsX + 1;
  readonly resolutionZ = WORLD_CONFIG.segmentsZ + 1;

  generate(seedLabel: string): MountainData {
    const seed = hashSeed(seedLabel);
    const random = mulberry32(seed);
    const noise = createNoise2D(random);
    // Mountain construction happens on a full square based on the map's long
    // side. Only after terrain shaping and erosion do we crop the playable
    // strip from its center.
    const heights = new Float32Array(this.resolutionX * this.resolutionX);
    // The ridge lives deliberately in the western half of the map. Seeded
    // rotation keeps each generated silhouette distinct without moving the
    // mountain into the plains.
    const angle = range(random, -0.28, 0.22);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const peakCenters = [
      {
        along: range(random, -0.1, 0.1),
        across: range(random, -0.07, 0.07),
        height: range(random, 43, 49),
        alongWidth: range(random, 0.26, 0.33),
        acrossWidth: range(random, 0.2, 0.26),
      },
      {
        along: range(random, -0.58, -0.34),
        across: range(random, -0.16, 0.1),
        height: range(random, 20, 28),
        alongWidth: range(random, 0.16, 0.22),
        acrossWidth: range(random, 0.12, 0.17),
      },
      {
        along: range(random, 0.3, 0.55),
        across: range(random, 0.06, 0.28),
        height: range(random, 17, 24),
        alongWidth: range(random, 0.17, 0.23),
        acrossWidth: range(random, 0.13, 0.18),
      },
      {
        along: range(random, -0.24, 0.03),
        across: range(random, 0.24, 0.39),
        height: range(random, 14, 20),
        alongWidth: range(random, 0.15, 0.22),
        acrossWidth: range(random, 0.12, 0.18),
      },
      {
        along: range(random, 0.05, 0.34),
        across: range(random, -0.38, -0.22),
        height: range(random, 13, 18),
        alongWidth: range(random, 0.16, 0.24),
        acrossWidth: range(random, 0.13, 0.2),
      },
      {
        along: range(random, -0.72, -0.52),
        across: range(random, 0.28, 0.48),
        height: range(random, 9, 15),
        alongWidth: range(random, 0.14, 0.2),
        acrossWidth: range(random, 0.12, 0.17),
      },
    ];
    const basinCenters = [
      {
        along: range(random, -0.34, -0.08),
        across: range(random, 0.08, 0.28),
        depth: range(random, 9, 15),
        alongWidth: range(random, 0.14, 0.23),
        acrossWidth: range(random, 0.12, 0.2),
      },
      {
        along: range(random, 0.12, 0.42),
        across: range(random, -0.25, 0.08),
        depth: range(random, 7, 12),
        alongWidth: range(random, 0.16, 0.26),
        acrossWidth: range(random, 0.14, 0.22),
      },
    ];
    const passCenters = [
      {
        along: range(random, -0.46, -0.28),
        depth: range(random, 10, 15),
        width: range(random, 0.045, 0.07),
        noiseOffset: range(random, 300, 600),
      },
      {
        along: range(random, 0.18, 0.36),
        depth: range(random, 8, 13),
        width: range(random, 0.05, 0.075),
        noiseOffset: range(random, 600, 900),
      },
    ];
    // Stratified, seeded features cover both faces of the massif. Pairing one
    // feature on either side in each along-axis band avoids leaving a broad
    // front or rear face as one uninterrupted plane.
    const faceKnolls = Array.from({ length: 14 }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const band = Math.floor(index / 2);
      const along = -0.72 + (band / 6) * 1.44 + range(random, -0.075, 0.075);
      return {
        along,
        across: side * range(random, 0.25, 0.5),
        height: range(random, 6.5, 13),
        alongWidth: range(random, 0.085, 0.16),
        acrossWidth: range(random, 0.08, 0.145),
      };
    });
    const faceHollows = Array.from({ length: 10 }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const band = Math.floor(index / 2);
      const along = -0.62 + (band / 4) * 1.24 + range(random, -0.07, 0.07);
      return {
        along,
        across: side * range(random, 0.2, 0.47),
        depth: range(random, 3.5, 7.5),
        alongWidth: range(random, 0.075, 0.135),
        acrossWidth: range(random, 0.065, 0.12),
      };
    });
    const spurRidges = Array.from({ length: 8 }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const band = Math.floor(index / 2);
      return {
        side,
        along: -0.58 + (band / 3) * 1.16 + range(random, -0.08, 0.08),
        start: range(random, 0.08, 0.14),
        length: range(random, 0.3, 0.46),
        height: range(random, 6, 11),
        width: range(random, 0.045, 0.085),
        bend: range(random, -0.11, 0.11),
        noiseOffset: range(random, 950, 1250),
      };
    });
    // A separate lower range fills the middle-left of the map. Stratification
    // guarantees broad coverage while seeded jitter keeps it from reading as
    // a grid. These use max blending below so overlapping hills cannot stack
    // into another summit as high as the primary peak.
    const midlandPeaks = Array.from({ length: 12 }, (_, index) => {
      const lane = index % 3;
      const band = Math.floor(index / 3);
      return {
        x: -0.47 + lane * 0.16 + range(random, -0.055, 0.055),
        z: -0.64 + (band / 3) * 1.28 + range(random, -0.09, 0.09),
        height: range(random, 8, 17) * (1 - lane * 0.08),
        xWidth: range(random, 0.075, 0.135),
        zWidth: range(random, 0.09, 0.17),
      };
    });
    const midlandValleys = Array.from({ length: 9 }, (_, index) => {
      const lane = index % 3;
      const band = Math.floor(index / 3);
      return {
        x: -0.41 + lane * 0.16 + range(random, -0.055, 0.055),
        z: -0.5 + band * 0.5 + range(random, -0.095, 0.095),
        depth: range(random, 5, 11),
        xWidth: range(random, 0.06, 0.115),
        zWidth: range(random, 0.075, 0.14),
      };
    });

    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let peakIndex = 0;

    for (let z = 0; z < this.resolutionX; z += 1) {
      for (let x = 0; x < this.resolutionX; x += 1) {
        const nx = (x / (this.resolutionX - 1)) * 2 - 1;
        const nz = (z / (this.resolutionX - 1)) * 2 - 1;

        const warpX = noise(nx * 1.25 + 17.3, nz * 1.25 - 8.1) * 0.085;
        const warpZ = noise(nx * 1.15 - 4.8, nz * 1.15 + 12.7) * 0.085;
        const wx = nx + warpX;
        const wz = nz + warpZ;
        // Keep the massif against the distant western/northern boundary. Its
        // hidden back face is allowed to continue beyond the visible square,
        // leaving the playable strip focused on the descending front face.
        const mountainX = wx + 0.68;
        const mountainZ = wz + 0.34;
        const across = mountainX * cos + mountainZ * sin;
        const along = -mountainX * sin + mountainZ * cos;
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
        // Keep the summit and back face untouched, but let the plain-facing
        // slope shed its elevation across a longer run toward the east.
        const leftHalfMask = 1 - smoothstep(-0.34, 0.3, nx);
        const mountainEnvelope = Math.exp(
          -Math.pow(Math.abs(mountainX) / 0.76, 2.15)
          -Math.pow(Math.abs(along) / 1.02, 5.2),
        ) * leftHalfMask * edgeFade * endFade;
        const faceEnvelope = Math.exp(
          -Math.pow(Math.abs(mountainX) / 0.86, 2.05)
          -Math.pow(Math.abs(along) / 1.04, 5),
        ) * (1 - smoothstep(-0.22, 0.34, nx)) * edgeFade * endFade;
        const mainPeak = peakCenters[0];
        const mainPeakDistance = Math.hypot(
          (along - mainPeak.along) / (mainPeak.alongWidth * 1.15),
          (across - mainPeak.across) / (mainPeak.acrossWidth * 1.15),
        );
        const midlandEnvelope = smoothstep(-0.72, -0.52, nx)
          * (1 - smoothstep(-0.02, 0.14, nx))
          * (1 - smoothstep(0.76, 0.96, Math.abs(nz)))
          * smoothstep(0.72, 1.32, mainPeakDistance)
          * edgeFade;

        let peaks = 0;
        let peakShoulders = 0;
        for (const [peakNumber, peak] of peakCenters.entries()) {
          const da = along - peak.along;
          const dc = across - peak.across;
          // The primary summit uses a softer dome so it has one readable high
          // point without becoming a sharp cone. Side peaks stay broader.
          const capPower = peakNumber === 0 ? 2.25 : 2.85;
          const roundedCap = Math.exp(
            -Math.pow(Math.abs(da) / peak.alongWidth, capPower)
            -Math.pow(Math.abs(dc) / peak.acrossWidth, capPower),
          );
          peaks += peak.height * roundedCap;
          const brokenShoulder = Math.exp(
            -Math.pow(Math.abs(da) / (peak.alongWidth * 1.75), 2.1)
            -Math.pow(Math.abs(dc) / (peak.acrossWidth * 1.8), 2.05),
          );
          peakShoulders += peak.height * 0.22 * brokenShoulder;
        }
        let basins = 0;
        for (const basin of basinCenters) {
          const da = along - basin.along;
          const dc = across - basin.across;
          basins += basin.depth * Math.exp(
            -Math.pow(Math.abs(da) / basin.alongWidth, 2.4)
            -Math.pow(Math.abs(dc) / basin.acrossWidth, 2.3),
          );
        }
        let faceKnollHeight = 0;
        for (const knoll of faceKnolls) {
          const da = along - knoll.along;
          const dc = across - knoll.across;
          faceKnollHeight += knoll.height * Math.exp(
            -Math.pow(Math.abs(da) / knoll.alongWidth, 2.35)
            -Math.pow(Math.abs(dc) / knoll.acrossWidth, 2.25),
          );
        }
        let faceHollowDepth = 0;
        for (const hollow of faceHollows) {
          const da = along - hollow.along;
          const dc = across - hollow.across;
          faceHollowDepth += hollow.depth * Math.exp(
            -Math.pow(Math.abs(da) / hollow.alongWidth, 2.15)
            -Math.pow(Math.abs(dc) / hollow.acrossWidth, 2.05),
          );
        }
        let spurHeight = 0;
        for (const spur of spurRidges) {
          const sideAcross = (across - spineOffset) * spur.side;
          const progress = clamp01((sideAcross - spur.start) / spur.length);
          const reach = smoothstep(spur.start - 0.035, spur.start + 0.02, sideAcross)
            * (1 - smoothstep(
              spur.start + spur.length - 0.05,
              spur.start + spur.length + 0.035,
              sideAcross,
            ));
          const noisyBend = noise(
            progress * 1.8 + spur.noiseOffset,
            spur.noiseOffset * 0.27,
          ) * 0.025;
          const branchAlong = spur.along
            + Math.sin(progress * Math.PI) * spur.bend
            + noisyBend;
          const branchWidth = spur.width * (0.72 + progress * 0.7);
          const ridgeProfile = Math.exp(
            -Math.pow(Math.abs(along - branchAlong) / branchWidth, 1.75),
          );
          spurHeight += spur.height
            * (1 - progress * 0.42)
            * (0.72 + Math.sin(progress * Math.PI) * 0.28)
            * ridgeProfile
            * reach;
        }
        let midlandPeakHeight = 0;
        for (const peak of midlandPeaks) {
          const dx = wx - peak.x;
          const dz = wz - peak.z;
          const dome = peak.height * Math.exp(
            -Math.pow(Math.abs(dx) / peak.xWidth, 2.45)
            -Math.pow(Math.abs(dz) / peak.zWidth, 2.3),
          );
          midlandPeakHeight = Math.max(midlandPeakHeight, dome);
        }
        let midlandValleyDepth = 0;
        for (const valley of midlandValleys) {
          const dx = wx - valley.x;
          const dz = wz - valley.z;
          const hollow = valley.depth * Math.exp(
            -Math.pow(Math.abs(dx) / valley.xWidth, 2.2)
            -Math.pow(Math.abs(dz) / valley.zWidth, 2.05),
          );
          midlandValleyDepth = Math.max(midlandValleyDepth, hollow);
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
        let crossPasses = 0;
        for (const pass of passCenters) {
          const bend = noise(across * 2.2 + pass.noiseOffset, pass.noiseOffset * 0.31) * 0.055;
          const passDistance = Math.abs(along - pass.along + bend);
          const passReach = Math.exp(-Math.pow(Math.abs(across) / 0.7, 4));
          crossPasses += pass.depth
            * Math.exp(-Math.pow(passDistance / pass.width, 1.75))
            * passReach;
        }
        // Noise-zero contours form winding gullies which divide the broad
        // massif into connected blocks instead of one continuous stone base.
        const fractureA = Math.exp(-Math.abs(noise(wx * 1.8 + 391, wz * 1.8 - 221)) * 14);
        const fractureB = Math.exp(-Math.abs(noise(wx * 3.1 - 147, wz * 3.1 + 318)) * 18);
        const fractureValleys = (fractureA * 7.5 + fractureB * 3.8)
          * (0.35 + (1 - wideShoulder) * 0.65);
        const macroHighlands = noise(wx * 0.78 + 233, wz * 0.78 - 164) * 0.5 + 0.5;
        const regionalShelf = noise(wx * 1.42 - 118, wz * 1.42 + 205) * 0.5 + 0.5;
        const blockField = noise(wx * 0.96 + 512, wz * 0.96 - 417) * 0.5 + 0.5;
        const massifBase = (
          2.8
          + macroHighlands * 7.2
          + smoothstep(0.5, 0.82, regionalShelf) * 4.8
        ) * (0.58 + smoothstep(0.27, 0.73, blockField) * 0.7);
        // Two thresholded noise shelves introduce genuine slope breaks. The
        // thermal pass below softens their edges without erasing the cliffs.
        const coarseCliffField = noise(
          wx * 1.18 + organic * 0.12 + 611,
          wz * 1.18 - organic * 0.12 - 507,
        );
        const fineCliffField = noise(wx * 2.45 - 284, wz * 2.45 + 763);
        const cliffShelves = (
          smoothstep(-0.08, 0.08, coarseCliffField) * 4.8
          + smoothstep(0.22, 0.38, fineCliffField) * 2.5
        ) * (0.3 + wideShoulder * 0.7);
        const faceDistance = Math.abs(across - spineOffset);
        const faceBand = smoothstep(0.16, 0.27, faceDistance)
          * (1 - smoothstep(0.6, 0.76, faceDistance));
        const faceNoise = noise(wx * 3.75 + 1047, wz * 3.75 - 936) * 0.5 + 0.5;
        const faceRelief = (smoothstep(0.22, 0.78, faceNoise) - 0.5)
          * 5.2
          * faceBand;
        const mountainBody = massifBase
          + wideShoulder * 5.2
          + narrowRidge * 8.2
          + eastRidge * 12.5
          + westRidge * 9.5
          + peakShoulders
          + peaks
          + cliffShelves
          - basins;
        const crags = (ridged - 0.42) * (4.1 + narrowRidge * 3.2) + organic * 1.75;

        // A broken band of foothills interrupts the overall descent and makes
        // the mountain read as a range with shoulders, hollows and low passes.
        const foothillBand = smoothstep(-0.5, -0.2, nx) * (1 - smoothstep(0.1, 0.42, nx));
        const foothillField = noise(nx * 3.15 + 126, nz * 3.15 - 77) * 0.5 + 0.5;
        const foothillDetail = noise(nx * 6.4 - 43, nz * 6.4 + 15) * 0.5 + 0.5;
        const foothillHeight = foothillBand
          * smoothstep(0.39, 0.72, foothillField)
          * (2.2 + foothillDetail * 3.8)
          * edgeFade;
        const piedmontRise = smoothstep(-0.46, -0.18, nx);
        const piedmontFade = 1 - smoothstep(-0.18, 0.46, nx);
        const piedmontNoise = noise(nx * 1.72 + 184, nz * 1.72 - 112) * 0.5 + 0.5;
        const piedmontBase = piedmontRise
          * piedmontFade
          * (8.5 + piedmontNoise * 4.2)
          * endFade
          * edgeFade;
        const rollingFoothills = piedmontRise
          * (1 - smoothstep(0.04, 0.44, nx))
          * smoothstep(0.46, 0.76, piedmontNoise)
          * (1.8 + foothillDetail * 3.2)
          * edgeFade;
        const transitionHillBand = smoothstep(-0.4, -0.22, nx)
          * (1 - smoothstep(0.1, 0.38, nx));
        const transitionHillField = noise(nx * 2.7 + 932, nz * 2.7 - 814) * 0.5 + 0.5;
        const transitionHillDetail = noise(nx * 5.6 - 286, nz * 5.6 + 741) * 0.5 + 0.5;
        const transitionHills = transitionHillBand
          * smoothstep(0.42, 0.72, transitionHillField)
          * (0.75 + transitionHillDetail * 1.45)
          * edgeFade;
        const footScarpLine = -0.24 + noise(nz * 1.35 + 307, 19.2) * 0.09;
        const scarpPresence = smoothstep(
          0.48,
          0.68,
          noise(nz * 3.2 - 58, nx * 0.8 + 449) * 0.5 + 0.5,
        );
        const footScarp = (1 - smoothstep(footScarpLine - 0.018, footScarpLine + 0.025, nx))
          * smoothstep(-0.72, -0.46, nx)
          * scarpPresence
          * (3.5 + foothillDetail * 2.5)
          * endFade
          * edgeFade;
        const foothillGully = Math.exp(
          -Math.abs(noise(nx * 2.25 + 857, nz * 2.25 - 692)) * 15,
        ) * foothillBand
          * smoothstep(1, 4, foothillHeight)
          * (2.2 + foothillDetail * 2.4);

        // The eastern half is a broad plain with seed-dependent low hills.
        const plainLarge = noise(nx * 1.45 + 104, nz * 1.45 - 31) * 0.5 + 0.5;
        const plainDetail = noise(nx * 4.1 - 19, nz * 4.1 + 58) * 0.5 + 0.5;
        const hillPockets = smoothstep(0.48, 0.82, plainLarge) * (0.7 + plainDetail * 1.8);
        const plainHeight = 1.15 + hillPockets + noise(nx * 2.25 + 8, nz * 2.25 - 61) * 0.38;

        // A noisy coastline creates a non-uniform beach, then sinks into a
        // shallow procedural seabed at the far-right edge.
        const coastline = 0.82
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
          (
            mountainBody
            + crags
            - drainageCut
            - branchingValleys
            - crossPasses
            - fractureValleys
          ) * mountainEnvelope
          + (faceKnollHeight + spurHeight - faceHollowDepth + faceRelief) * faceEnvelope
          + (midlandPeakHeight - midlandValleyDepth) * midlandEnvelope
          + foothillHeight
          + piedmontBase
          + rollingFoothills
          + transitionHills
          + footScarp
          - foothillGully
        ) * MASSIF_VERTICAL_SCALE;
        // A broad west-to-east grade keeps the entire long map visibly
        // descending from the mountain end toward the coast, including the
        // quieter foothill and plain regions between the two.
        const longitudinalGrade = (1 - smoothstep(-0.9, 0.64, nx)) * 4.2;
        let height = coastalHeight + mountainHeight + longitudinalGrade;
        height = Math.max(WORLD_CONFIG.baseMinHeight, Math.min(WORLD_CONFIG.baseMaxHeight, height));

        const index = z * this.resolutionX + x;
        heights[index] = height;
        if (height > maximum) {
          maximum = height;
          peakIndex = index;
        }
        minimum = Math.min(minimum, height);
      }
    }

    this.erode(heights, 12);

    for (let index = 0; index < heights.length; index += 1) {
      const scaledHeight = WORLD_CONFIG.seaLevel
        + (heights[index] - WORLD_CONFIG.seaLevel) * WORLD_CONFIG.verticalScale;
      heights[index] = Math.max(WORLD_CONFIG.minHeight, Math.min(WORLD_CONFIG.maxHeight, scaledHeight));
    }

    const croppedHeights = new Float32Array(this.resolutionX * this.resolutionZ);
    const cropStartZ = Math.floor((this.resolutionX - this.resolutionZ) * 0.5);
    minimum = Number.POSITIVE_INFINITY;
    maximum = Number.NEGATIVE_INFINITY;
    peakIndex = 0;
    for (let z = 0; z < this.resolutionZ; z += 1) {
      const squareRow = (z + cropStartZ) * this.resolutionX;
      const croppedRow = z * this.resolutionX;
      for (let x = 0; x < this.resolutionX; x += 1) {
        const index = croppedRow + x;
        const height = heights[squareRow + x];
        croppedHeights[index] = height;
        minimum = Math.min(minimum, height);
        if (height > maximum) {
          maximum = height;
          peakIndex = index;
        }
      }
    }

    const sourceIndex = this.findGlacierSource(croppedHeights, maximum, peakIndex);
    return {
      heights: croppedHeights,
      squareHeights: heights,
      activeCropStartZ: cropStartZ,
      peakIndex,
      sourceIndex,
      minHeight: minimum,
      maxHeight: maximum,
    };
  }

  private erode(heights: Float32Array, iterations: number): void {
    const delta = new Float32Array(heights.length);
    const width = this.resolutionX;
    const rows = this.resolutionX;
    const talus = 0.65;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      delta.fill(0);
      for (let z = 1; z < rows - 1; z += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = z * width + x;
          let lowestIndex = index;
          let largestDrop = 0;
          const neighbors = [index - 1, index + 1, index - width, index + width];
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
    const width = this.resolutionX;
    const rows = this.resolutionZ;
    const peakX = peakIndex % width;
    const peakZ = Math.floor(peakIndex / width);
    let bestIndex = peakIndex;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let z = 4; z < rows - 4; z += 1) {
      for (let x = 4; x < width - 4; x += 1) {
        const index = z * width + x;
        const height = heights[index];
        if (height < maximum * 0.7 || height > maximum * 0.96) continue;
        const lowestNeighbor = Math.min(
          heights[index - 1],
          heights[index + 1],
          heights[index - width],
          heights[index + width],
        );
        const drop = height - lowestNeighbor;
        const peakDistance = Math.hypot(
          (x - peakX) / (width - 1),
          (z - peakZ) / (width - 1),
        );
        if (peakDistance < 0.025 || peakDistance > 0.14) continue;
        const eastward = (x - peakX) / (width - 1);
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

