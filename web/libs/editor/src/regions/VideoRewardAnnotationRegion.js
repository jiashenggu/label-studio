import { types } from "mobx-state-tree";

import NormalizationMixin from "../mixins/Normalization";
import RegionsMixin from "../mixins/Regions";
import Registry from "../core/Registry";
import { AreaMixin } from "../mixins/AreaMixin";
import { AnnotationMixin } from "../mixins/AnnotationMixin";
import { guidGenerator } from "../core/Helpers";
import { VideoModel } from "../tags/object/Video";

/**
 * VideoRewardAnnotationRegionModel stores reward curve annotation data for videos.
 * It contains control points and dense rewards that define a reward curve over time.
 */
const Model = types
  .model("VideoRewardAnnotationRegionModel", {
    id: types.optional(types.identifier, guidGenerator),
    pid: types.optional(types.string, guidGenerator),
    type: "videorewardannotationregion",
    object: types.late(() => types.reference(VideoModel)),

    // Control points define the key points of the reward curve
    // Each point has: time (seconds), reward (value), type ('normal' or 'step')
    controlPoints: types.frozen([]),

    // Dense rewards are interpolated values for each frame
    denseRewards: types.frozen([]),

    // Curve fitting method used
    fitMethod: types.optional(types.string, "pchip"),

    // Number of stages for this annotation
    numStages: types.optional(types.number, 3),
  })
  .volatile(() => ({
    hideable: true,
  }))
  .views((self) => ({
    get parent() {
      return self.object;
    },

    /**
     * Get the reward value at a specific frame
     * @param {number} frame - The frame number
     * @returns {number|null} The reward value or null if not available
     */
    getRewardAtFrame(frame) {
      if (!self.denseRewards || self.denseRewards.length === 0) {
        return null;
      }
      const index = Math.min(frame, self.denseRewards.length - 1);
      return self.denseRewards[index];
    },

    /**
     * Get the reward value at a specific time
     * @param {number} time - Time in seconds
     * @param {number} fps - Frames per second
     * @returns {number|null} The reward value or null if not available
     */
    getRewardAtTime(time, fps = 30) {
      const frame = Math.floor(time * fps);
      return self.getRewardAtFrame(frame);
    },

    /**
     * Find the closest control point to a given time
     * @param {number} time - Time in seconds
     * @param {number} threshold - Maximum distance threshold in seconds
     * @returns {object|null} The closest control point or null
     */
    findClosestControlPoint(time, threshold = 0.1) {
      if (!self.controlPoints || self.controlPoints.length === 0) {
        return null;
      }
      let closest = null;
      let minDist = threshold;
      for (const point of self.controlPoints) {
        const dist = Math.abs(point.time - time);
        if (dist < minDist) {
          minDist = dist;
          closest = point;
        }
      }
      return closest;
    },
  }))
  .actions((self) => ({
    /**
     * Add a control point
     * @param {number} time - Time in seconds
     * @param {number} reward - Reward value
     * @param {string} pointType - 'normal' or 'step'
     */
    addControlPoint(time, reward, pointType = "normal") {
      const newPoint = { time, reward, type: pointType };
      const points = [...self.controlPoints, newPoint];
      points.sort((a, b) => a.time - b.time);
      self.controlPoints = points;
      // Clear dense rewards since curve needs refitting
      self.denseRewards = [];
    },

    /**
     * Update a control point at a specific index
     * @param {number} index - Index of the control point
     * @param {object} updates - Object with time, reward, and/or type updates
     */
    updateControlPoint(index, updates) {
      if (index < 0 || index >= self.controlPoints.length) return;
      const points = [...self.controlPoints];
      points[index] = { ...points[index], ...updates };
      points.sort((a, b) => a.time - b.time);
      self.controlPoints = points;
      self.denseRewards = [];
    },

    /**
     * Remove a control point at a specific index
     * @param {number} index - Index of the control point to remove
     */
    removeControlPoint(index) {
      if (index < 0 || index >= self.controlPoints.length) return;
      const points = [...self.controlPoints];
      points.splice(index, 1);
      self.controlPoints = points;
      self.denseRewards = [];
    },

    /**
     * Set all control points at once
     * @param {Array} points - Array of control point objects
     */
    setControlPoints(points) {
      const sortedPoints = [...points].sort((a, b) => a.time - b.time);
      self.controlPoints = sortedPoints;
      self.denseRewards = [];
    },

    /**
     * Set the dense rewards array
     * @param {Array} rewards - Array of reward values
     */
    setDenseRewards(rewards) {
      self.denseRewards = rewards;
    },

    /**
     * Set the curve fitting method
     * @param {string} method - 'linear', 'pchip', 'cubic', or 'akima'
     */
    setFitMethod(method) {
      self.fitMethod = method;
    },

    /**
     * Clear all annotation data
     */
    clearAnnotation() {
      self.controlPoints = [];
      self.denseRewards = [];
    },

    /**
     * Serialize the region for saving
     */
    serialize() {
      const { framerate, length: framesCount } = self.object;
      const duration = self.object?.ref?.current?.duration ?? 0;

      return {
        value: {
          framesCount,
          duration,
          controlPoints: self.controlPoints,
          denseRewards: self.denseRewards,
          fitMethod: self.fitMethod,
          numStages: self.numStages,
        },
      };
    },
  }));

const VideoRewardAnnotationRegionModel = types.compose(
  "VideoRewardAnnotationRegionModel",
  RegionsMixin,
  AreaMixin,
  AnnotationMixin,
  NormalizationMixin,
  Model,
);

Registry.addRegionType(VideoRewardAnnotationRegionModel, "video");

export { VideoRewardAnnotationRegionModel };
