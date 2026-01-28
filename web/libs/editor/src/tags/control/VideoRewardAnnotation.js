import React, { useState, useEffect } from "react";
import { observer } from "mobx-react";
import { types, getRoot } from "mobx-state-tree";

import Registry from "../../core/Registry";
import { guidGenerator } from "../../core/Helpers";
import ControlBase from "./Base";

/**
 * VideoRewardAnnotation tag enables reward curve annotation for videos.
 * It provides an inline curve editor and rubrics display for annotating
 * reward values over time. This is separate from VideoRectangle and designed for
 * reinforcement learning reward annotation tasks.
 *
 * Use with the following data types: video
 * @example
 * <!--Video Reward Annotation-->
 * <View>
 *   <Header>Annotate the reward curve:</Header>
 *   <Video name="video" value="$video" />
 *   <VideoRewardAnnotation name="reward" toName="video" numStages="3" />
 * </View>
 * @name VideoRewardAnnotation
 * @meta_title Video Reward Annotation Tag for RL Tasks
 * @meta_description Annotate reward curves on videos for reinforcement learning tasks.
 * @param {string} name Name of the element
 * @param {string} toName Name of the video element to control
 * @param {number} [numStages=3] Number of stages for reward annotation
 * @param {string} [stageNames] Comma-separated list of stage names
 * @param {string} [rubric] JSON string containing rubric data for scoring guidance
 */
const TagAttrs = types.model({
  toname: types.maybeNull(types.string),
  numstages: types.optional(types.string, "3"),
  stagenames: types.optional(types.string, ""),
  rubric: types.optional(types.string, ""),
});

const ModelAttrs = types.model("VideoRewardAnnotationModel", {
  pid: types.optional(types.string, guidGenerator),
  type: "videorewardannotation",
});

const Model = types
  .model({})
  .views((self) => ({
    get numStagesValue() {
      return Number.parseInt(self.numstages, 10) || 3;
    },
    get stageNamesArray() {
      if (!self.stagenames) {
        return Array.from({ length: self.numStagesValue }, (_, i) => `Stage ${i}`);
      }
      return self.stagenames.split(",").map((s) => s.trim());
    },
    get rubricData() {
      if (!self.rubric) return null;
      // First try to parse as JSON for backward compatibility
      try {
        return JSON.parse(self.rubric);
      } catch (e) {
        // If JSON parse fails, return as plain string
        return self.rubric;
      }
    },
    get videoObject() {
      const name = self.toname || self.toName;
      const root = getRoot(self);
      return root?.annotationStore?.selected?.names?.get(name);
    },
  }));

const VideoRewardAnnotationModel = types.compose("VideoRewardAnnotationModel", ControlBase, ModelAttrs, TagAttrs, Model);

const HtxVideoRewardAnnotation = observer(({ item }) => {
  const [EditorComponent, setEditorComponent] = useState(null);

  useEffect(() => {
    // Dynamically import the inline editor component
    import("../../components/VideoRewardAnnotation/RewardAnnotationEditor").then((module) => {
      setEditorComponent(() => module.default);
    });
  }, []);

  console.log('[VideoRewardAnnotation] Rendering inline editor');

  if (!EditorComponent) {
    return <div style={{ padding: '20px', textAlign: 'center' }}>Loading reward annotation editor...</div>;
  }

  return (
    <EditorComponent
      item={item}
      videoObject={item.videoObject}
      numStages={item.numStagesValue}
      stageNames={item.stageNamesArray}
      rubric={item.rubricData}
    />
  );
});

Registry.addTag("videorewardannotation", VideoRewardAnnotationModel, HtxVideoRewardAnnotation);

export { HtxVideoRewardAnnotation, VideoRewardAnnotationModel };
