import { types } from "mobx-state-tree";

import NormalizationMixin from "../mixins/Normalization";
import RegionsMixin from "../mixins/Regions";
import Registry from "../core/Registry";
import { AreaMixin } from "../mixins/AreaMixin";
import { onlyProps, VideoRegion } from "./VideoRegion";
import { interpolateProp } from "../utils/props";

const Model = types
  .model("VideoRectangleRegionModel", {
    type: "videorectangleregion",
  })
  .volatile(() => ({
    props: ["x", "y", "width", "height", "rotation"],
  }))
  .views((self) => ({
    // Binary search to find the insertion point for a given frame in the sorted sequence.
    // Returns the index of the first element with frame >= target, or sequence.length if none.
    _bsearch(targetFrame) {
      const seq = self.sequence;
      let lo = 0;
      let hi = seq.length;

      while (lo < hi) {
        const mid = (lo + hi) >>> 1;

        if (seq[mid].frame < targetFrame) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }

      return lo;
    },

    getShape(frame) {
      const seq = self.sequence;

      if (seq.length === 0) return null;

      // Binary search: find first index where seq[idx].frame >= frame
      const idx = self._bsearch(frame);

      // Exact match
      if (idx < seq.length && seq[idx].frame === frame) {
        return onlyProps(self.props, seq[idx]);
      }

      // frame is before all keypoints
      if (idx === 0) return null;

      const prev = seq[idx - 1];

      // frame is after all keypoints — clamp to last
      if (idx >= seq.length) return onlyProps(self.props, prev);

      // Interpolate between prev and next
      const next = seq[idx];

      return Object.fromEntries(self.props.map((prop) => [prop, interpolateProp(prev, next, frame, prop)]));
    },

    getVisibility() {
      return true;
    },
  }))
  .actions((self) => ({
    updateShape(data, frame) {
      const newItem = {
        ...data,
        frame,
        enabled: true,
      };

      const kp = self.closestKeypoint(frame);
      const index = self.sequence.findIndex((item) => item.frame >= frame);

      if (index < 0) {
        self.sequence = [...self.sequence, newItem];
      } else {
        const keypoint = {
          ...(self.sequence[index] ?? {}),
          ...data,
          enabled: kp?.enabled ?? true,
          frame,
        };

        self.sequence = [
          ...self.sequence.slice(0, index),
          keypoint,
          ...self.sequence.slice(index + (self.sequence[index].frame === frame)),
        ];
      }
    },
  }));

const VideoRectangleRegionModel = types.compose(
  "VideoRectangleRegionModel",
  RegionsMixin,
  VideoRegion,
  AreaMixin,
  NormalizationMixin,
  Model,
);

Registry.addRegionType(VideoRectangleRegionModel, "video");

export { VideoRectangleRegionModel };
