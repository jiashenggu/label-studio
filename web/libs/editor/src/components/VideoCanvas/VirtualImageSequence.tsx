import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

/**
 * Configuration for frame URL resolution
 */
export type FrameUrlConfig =
  | {
      /** Array of frame URLs, indexed by frame number (0-based internally, 1-based for user) */
      type: "array";
      urls: string[];
    }
  | {
      /** Pattern-based URL with {frame} placeholder, e.g., "/frames/frame_{frame}.jpg" */
      type: "pattern";
      pattern: string;
      /** Total number of frames */
      totalFrames: number;
      /** Starting frame number in filenames (default: 0) */
      startFrame?: number;
      /** Zero-padding width for frame numbers (default: 0, no padding) */
      padWidth?: number;
    };

export interface VirtualImageSequenceProps {
  /** Frame URL configuration */
  frameConfig: FrameUrlConfig;
  /** Frames per second for playback (default: 24) */
  framerate?: number;
  /** Number of frames to preload ahead (default: 10) */
  preloadAhead?: number;
  /** Number of frames to keep cached behind (default: 5) */
  cacheBeforeSize?: number;
  /** Called when sequence is ready to display */
  onLoad?: (data: { width: number; height: number; duration: number; length: number }) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** Called on play */
  onPlay?: () => void;
  /** Called on pause */
  onPause?: () => void;
  /** Called when playback ends */
  onEnded?: () => void;
  /** Called when current time updates */
  onTimeUpdate?: () => void;
  /** Called after seeking completes */
  onSeeked?: () => void;
  /** Called when buffering state changes */
  onWaiting?: () => void;
  /** Called when buffering ends */
  onPlaying?: () => void;
  /** Playback speed multiplier */
  speed?: number;
  /** Whether audio is muted (no-op for images, included for API compatibility) */
  muted?: boolean;
}

/**
 * Interface that mimics HTMLVideoElement for compatibility with VideoCanvas
 */
export interface ImageSequenceRef {
  // Video-like properties
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly duration: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly networkState: number;
  readonly error: MediaError | null;
  currentTime: number;
  playbackRate: number;
  muted: boolean;
  volume: number;

  // Video-like methods
  play(): Promise<void>;
  pause(): void;
  load(): void;

  // Image sequence specific
  readonly currentFrame: number;
  readonly totalFrames: number;
  getCurrentImage(): HTMLImageElement | null;

  // For canvas drawing compatibility - this is what drawImage needs
  readonly drawableSource: CanvasImageSource | null;

  // Constants for compatibility
  readonly NETWORK_IDLE: number;
  readonly NETWORK_LOADING: number;
}

// Image cache entry
interface CacheEntry {
  image: HTMLImageElement;
  loaded: boolean;
  error: boolean;
}

/**
 * VirtualImageSequence - A component that provides a video-like interface for JPEG sequences
 *
 * This enables VideoRectangle annotations on image sequences (like packds format)
 * without needing to convert them to actual video files.
 */
export const VirtualImageSequence = forwardRef<ImageSequenceRef, VirtualImageSequenceProps>(
  (
    {
      frameConfig,
      framerate = 24,
      preloadAhead = 10,
      cacheBeforeSize = 5,
      onLoad,
      onError,
      onPlay,
      onPause,
      onEnded,
      onTimeUpdate,
      onSeeked,
      onWaiting,
      onPlaying,
      speed = 1,
      muted = true,
    },
    ref,
  ) => {
    // All state stored in refs to avoid re-renders
    const stateRef = useRef({
      isReady: false,
      dimensions: { width: 0, height: 0 },
      currentFrame: 0,
      isPlaying: false,
      hasEnded: false,
      isBuffering: false,
    });

    // Refs for mutable values
    const imageCache = useRef<Map<number, CacheEntry>>(new Map());
    const playbackInterval = useRef<ReturnType<typeof setInterval> | null>(null);
    const playbackRateRef = useRef(speed);

    // Store callbacks in refs to avoid dependency issues
    const callbacksRef = useRef({
      onLoad,
      onError,
      onPlay,
      onPause,
      onEnded,
      onTimeUpdate,
      onSeeked,
      onWaiting,
      onPlaying,
    });

    // Update callbacks ref when props change
    useEffect(() => {
      callbacksRef.current = {
        onLoad,
        onError,
        onPlay,
        onPause,
        onEnded,
        onTimeUpdate,
        onSeeked,
        onWaiting,
        onPlaying,
      };
    });

    // Calculate total frames
    const totalFrames = frameConfig.type === "array" ? frameConfig.urls.length : frameConfig.totalFrames;
    const duration = totalFrames / framerate;

    // Get URL for a specific frame (0-based index)
    const getFrameUrl = useCallback(
      (frameIndex: number): string => {
        if (frameConfig.type === "array") {
          return frameConfig.urls[frameIndex] ?? "";
        }

        const startFrame = frameConfig.startFrame ?? 0;
        const padWidth = frameConfig.padWidth ?? 0;
        const frameNumber = frameIndex + startFrame;
        const paddedFrame = padWidth > 0 ? String(frameNumber).padStart(padWidth, "0") : String(frameNumber);

        return frameConfig.pattern.replace("{frame}", paddedFrame);
      },
      [frameConfig],
    );

    // Load a single frame image
    const loadFrame = useCallback(
      (frameIndex: number): Promise<HTMLImageElement> => {
        return new Promise((resolve, reject) => {
          // Check cache first
          const cached = imageCache.current.get(frameIndex);
          if (cached?.loaded && cached.image) {
            resolve(cached.image);
            return;
          }
          if (cached?.error) {
            reject(new Error(`Frame ${frameIndex} failed to load`));
            return;
          }

          const img = new Image();
          img.crossOrigin = "anonymous";

          // Create cache entry immediately to prevent duplicate loads
          imageCache.current.set(frameIndex, { image: img, loaded: false, error: false });

          img.onload = () => {
            imageCache.current.set(frameIndex, { image: img, loaded: true, error: false });
            resolve(img);
          };

          img.onerror = () => {
            imageCache.current.set(frameIndex, { image: img, loaded: false, error: true });
            reject(new Error(`Failed to load frame ${frameIndex}: ${getFrameUrl(frameIndex)}`));
          };

          img.src = getFrameUrl(frameIndex);
        });
      },
      [getFrameUrl],
    );

    // Preload frames around current position
    const preloadFrames = useCallback(
      (centerFrame: number) => {
        const start = Math.max(0, centerFrame - cacheBeforeSize);
        const end = Math.min(totalFrames - 1, centerFrame + preloadAhead);

        // Load frames in priority order (closest first)
        const framesToLoad: number[] = [];
        for (let i = centerFrame; i <= end; i++) framesToLoad.push(i);
        for (let i = centerFrame - 1; i >= start; i--) framesToLoad.push(i);

        framesToLoad.forEach((frameIndex) => {
          if (!imageCache.current.has(frameIndex)) {
            loadFrame(frameIndex).catch(() => {
              // Silent fail for preloading - errors will surface when frame is actually needed
            });
          }
        });

        // Clean up old cache entries to prevent memory bloat
        const minKeep = Math.max(0, centerFrame - cacheBeforeSize * 2);
        const maxKeep = Math.min(totalFrames - 1, centerFrame + preloadAhead * 2);

        imageCache.current.forEach((_, key) => {
          if (key < minKeep || key > maxKeep) {
            imageCache.current.delete(key);
          }
        });
      },
      [totalFrames, preloadAhead, cacheBeforeSize, loadFrame],
    );

    // Get current frame image
    const getCurrentImage = useCallback((): HTMLImageElement | null => {
      const cached = imageCache.current.get(stateRef.current.currentFrame);
      return cached?.loaded ? cached.image : null;
    }, []);

    // Stop playback
    const stopPlayback = useCallback(() => {
      if (playbackInterval.current) {
        clearInterval(playbackInterval.current);
        playbackInterval.current = null;
      }
    }, []);

    // Start playback
    const startPlayback = useCallback(() => {
      if (playbackInterval.current) return;

      const state = stateRef.current;
      if (state.currentFrame >= totalFrames - 1) {
        // Reset to beginning if at end
        state.currentFrame = 0;
        state.hasEnded = false;
      }

      const frameInterval = 1000 / (framerate * playbackRateRef.current);

      playbackInterval.current = setInterval(() => {
        const state = stateRef.current;
        const nextFrame = state.currentFrame + 1;

        if (nextFrame >= totalFrames) {
          // End of sequence
          stopPlayback();
          state.hasEnded = true;
          state.isPlaying = false;
          callbacksRef.current.onEnded?.();
          return;
        }

        // Check if next frame is loaded
        const cached = imageCache.current.get(nextFrame);
        if (!cached?.loaded) {
          // Buffering needed
          if (!state.isBuffering) {
            state.isBuffering = true;
            callbacksRef.current.onWaiting?.();
          }
          return;
        }

        if (state.isBuffering) {
          state.isBuffering = false;
          callbacksRef.current.onPlaying?.();
        }

        state.currentFrame = nextFrame;
        preloadFrames(nextFrame);
        callbacksRef.current.onTimeUpdate?.();
      }, frameInterval);
    }, [framerate, totalFrames, preloadFrames, stopPlayback]);

    // Initialize - load first frame to get dimensions
    useEffect(() => {
      loadFrame(0)
        .then((img) => {
          stateRef.current.dimensions = { width: img.naturalWidth, height: img.naturalHeight };
          stateRef.current.isReady = true;
          preloadFrames(0);
          callbacksRef.current.onLoad?.({
            width: img.naturalWidth,
            height: img.naturalHeight,
            duration,
            length: totalFrames,
          });
        })
        .catch((err) => {
          callbacksRef.current.onError?.(err);
        });

      return () => {
        // Cleanup
        stopPlayback();
        imageCache.current.clear();
      };
    }, [frameConfig, loadFrame, preloadFrames, duration, totalFrames, stopPlayback]);

    // Update playback rate when speed changes
    useEffect(() => {
      playbackRateRef.current = speed;
      if (stateRef.current.isPlaying) {
        stopPlayback();
        startPlayback();
      }
    }, [speed, stopPlayback, startPlayback]);

    // Expose video-like interface via ref
    useImperativeHandle(
      ref,
      () => ({
        // Video-like properties
        get videoWidth() {
          return stateRef.current.dimensions.width;
        },
        get videoHeight() {
          return stateRef.current.dimensions.height;
        },
        get duration() {
          return duration;
        },
        get readyState() {
          return stateRef.current.isReady ? 4 : 0; // 4 = HAVE_ENOUGH_DATA
        },
        get paused() {
          return !stateRef.current.isPlaying;
        },
        get ended() {
          return stateRef.current.hasEnded;
        },
        get networkState() {
          return stateRef.current.isBuffering ? 2 : 1; // 2 = NETWORK_LOADING, 1 = NETWORK_IDLE
        },
        get error() {
          return null;
        },
        get currentTime() {
          return stateRef.current.currentFrame / framerate;
        },
        set currentTime(time: number) {
          const targetFrame = Math.max(0, Math.min(totalFrames - 1, Math.round(time * framerate)));
          stateRef.current.currentFrame = targetFrame;
          stateRef.current.hasEnded = false;
          preloadFrames(targetFrame);
          callbacksRef.current.onSeeked?.();
          callbacksRef.current.onTimeUpdate?.();
        },
        get playbackRate() {
          return playbackRateRef.current;
        },
        set playbackRate(rate: number) {
          playbackRateRef.current = rate;
        },
        muted: muted,
        volume: 1,

        // Video-like methods
        async play() {
          stateRef.current.isPlaying = true;
          stateRef.current.hasEnded = false;
          startPlayback();
          callbacksRef.current.onPlay?.();
        },
        pause() {
          stateRef.current.isPlaying = false;
          stopPlayback();
          callbacksRef.current.onPause?.();
        },
        load() {
          // Reset state
          stopPlayback();
          stateRef.current.currentFrame = 0;
          stateRef.current.isPlaying = false;
          stateRef.current.hasEnded = false;
          imageCache.current.clear();
          preloadFrames(0);
        },

        // Image sequence specific
        get currentFrame() {
          return stateRef.current.currentFrame;
        },
        get totalFrames() {
          return totalFrames;
        },
        getCurrentImage,

        // For canvas drawing - returns the current frame's Image element
        get drawableSource(): CanvasImageSource | null {
          return getCurrentImage();
        },

        // Constants
        NETWORK_IDLE: 1,
        NETWORK_LOADING: 2,
      }),
      [duration, framerate, totalFrames, muted, startPlayback, stopPlayback, preloadFrames, getCurrentImage],
    );

    // This component doesn't render anything visible
    return null;
  },
);

VirtualImageSequence.displayName = "VirtualImageSequence";

/**
 * Helper function to detect if a source configuration is for an image sequence
 */
export function isImageSequenceConfig(config: unknown): config is FrameUrlConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return (
    (c.type === "array" && Array.isArray(c.urls)) ||
    (c.type === "pattern" && typeof c.pattern === "string" && typeof c.totalFrames === "number")
  );
}

/**
 * Parse frame configuration from various input formats
 */
export function parseFrameConfig(input: string | string[] | FrameUrlConfig): FrameUrlConfig | null {
  // Already a valid config
  if (isImageSequenceConfig(input)) {
    return input;
  }

  // Array of URLs
  if (Array.isArray(input)) {
    return {
      type: "array",
      urls: input,
    };
  }

  // Try to parse as JSON
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (isImageSequenceConfig(parsed)) {
        return parsed;
      }
      if (Array.isArray(parsed)) {
        return {
          type: "array",
          urls: parsed,
        };
      }
    } catch {
      // Not JSON, could be a pattern or single URL
    }
  }

  return null;
}
