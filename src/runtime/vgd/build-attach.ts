/**
 * Whether `vg build` should start vgd and/or publish the new map into a slot.
 *
 * Embedding belongs in vgd's embed-worker. `vg build` must not spawn
 * `vg embed --bg` on the interactive path — that child loads ONNX in a
 * second process while the daemon is already warming the same slot.
 * The only spawn left is the `--no-daemon` fallback, which writes the
 * on-disk vector file for the next in-process `vg ask`.
 */

export interface BuildAttachInput {
  /** Commander `--no-daemon` arrives as `daemon: false`. */
  daemon?: boolean;
  /** Commander `--no-publish` arrives as `publish: false`. */
  publish?: boolean;
  fast?: boolean;
  /** Commander `--no-warm` arrives as `warm: false`. */
  warm?: boolean;
  /** Commander `--no-index` arrives as `index: false`. */
  index?: boolean;
}

export interface BuildAttachPlan {
  /** Passed to `attachVgd({ disabled })`. */
  disabled: boolean;
  autoStart: boolean;
  publish: boolean;
  /**
   * Spawn `vg embed --bg` to write the on-disk vector file.
   * True only for `--no-daemon` (no worker to own the index) and never
   * for `--no-publish` / one-shot / `--no-warm`.
   */
  diskEmbedFallback: boolean;
  reason?: string;
}

/** `--fast --no-warm --no-index` is a map write, not a session warm. */
export function isOneShotBuild(input: BuildAttachInput): boolean {
  return input.fast === true && input.warm === false && input.index === false;
}

export function resolveBuildAttach(input: BuildAttachInput = {}): BuildAttachPlan {
  if (input.daemon === false) {
    return {
      disabled: true,
      autoStart: false,
      publish: false,
      diskEmbedFallback: input.warm !== false && !isOneShotBuild(input),
      reason: 'disabled by --no-daemon',
    };
  }

  if (input.publish === false) {
    return {
      disabled: false,
      autoStart: false,
      publish: false,
      diskEmbedFallback: false,
      reason: 'disabled by --no-publish',
    };
  }

  if (isOneShotBuild(input)) {
    return {
      disabled: false,
      autoStart: false,
      publish: false,
      diskEmbedFallback: false,
      reason: 'one-shot (--fast --no-warm --no-index) — map stays on disk only',
    };
  }

  return {
    disabled: false,
    autoStart: true,
    publish: true,
    diskEmbedFallback: false,
  };
}
