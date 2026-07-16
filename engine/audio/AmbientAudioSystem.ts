export type AmbientMix = {
  music: number;
  wind: number;
  water: number;
  birds: number;
};

type AmbientMixInput = {
  viewDistance: number;
  waterPresence: number;
  forestPresence: number;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const smoothstep = (minimum: number, maximum: number, value: number): number => {
  const normalized = clamp01((value - minimum) / (maximum - minimum));
  return normalized * normalized * (3 - 2 * normalized);
};

/** Pure mix calculation kept separate so the distance transitions can be checked without browser audio. */
export function computeAmbientMix({
  viewDistance,
  waterPresence,
  forestPresence,
}: AmbientMixInput): AmbientMix {
  const closeView = 1 - smoothstep(42, 95, viewDistance);
  const forestView = 1 - smoothstep(65, 130, viewDistance);

  return {
    music: 0.2,
    wind: smoothstep(65, 150, viewDistance) * 0.38,
    water: closeView * clamp01(waterPresence) * 0.5,
    birds: forestView * clamp01(forestPresence) * 0.36,
  };
}

export class AmbientAudioSystem {
  private readonly tracks: Record<keyof AmbientMix, HTMLAudioElement>;
  private readonly current: AmbientMix = { music: 0, wind: 0, water: 0, birds: 0 };
  private started = false;
  private starting = false;

  constructor() {
    this.tracks = {
      music: this.createTrack("/audio/water-through-the-mountain.mp3"),
      wind: this.createTrack("/audio/mountain-wind.mp3"),
      water: this.createTrack("/audio/gentle-river.mp3"),
      birds: this.createTrack("/audio/forest-birds.mp3"),
    };
    document.addEventListener("pointerdown", this.unlock, true);
    document.addEventListener("keydown", this.unlock, true);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  update(deltaTime: number, input: AmbientMixInput): void {
    const target = this.started
      ? computeAmbientMix(input)
      : { music: 0, wind: 0, water: 0, birds: 0 };
    const blend = 1 - Math.exp(-Math.max(0, deltaTime) * 1.8);

    for (const key of Object.keys(this.tracks) as (keyof AmbientMix)[]) {
      this.current[key] += (target[key] - this.current[key]) * blend;
      this.tracks[key].volume = clamp01(this.current[key]);
    }
  }

  dispose(): void {
    document.removeEventListener("pointerdown", this.unlock, true);
    document.removeEventListener("keydown", this.unlock, true);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    for (const track of Object.values(this.tracks)) {
      track.pause();
      track.removeAttribute("src");
      track.load();
    }
  }

  private createTrack(source: string): HTMLAudioElement {
    const audio = new Audio(source);
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0;
    return audio;
  }

  private unlock = (): void => {
    if (this.started || this.starting) return;
    this.starting = true;
    void Promise.allSettled(Object.values(this.tracks).map((track) => track.play()))
      .then((results) => {
        this.started = results.some((result) => result.status === "fulfilled");
      })
      .finally(() => {
        this.starting = false;
      });
  };

  private onVisibilityChange = (): void => {
    const muted = document.hidden;
    for (const track of Object.values(this.tracks)) track.muted = muted;
  };
}
