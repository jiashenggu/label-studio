import React, { useState, useEffect } from "react";
import { observer } from "mobx-react";
import { types, getRoot } from "mobx-state-tree";

import Registry from "../../core/Registry";
import { guidGenerator } from "../../core/Helpers";
import ControlBase from "./Base";

/**
 * VideoRewardAnnotation tag enables reward curve annotation for videos.
 * It provides a popup window with a curve editor and rubrics display for annotating
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
  .volatile(() => ({
    isEditorOpen: false,
  }))
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
      if (!self.rubric) return [];
      try {
        return JSON.parse(self.rubric);
      } catch (e) {
        console.error("Failed to parse rubric JSON:", e);
        return [];
      }
    },
    get videoObject() {
      const name = self.toname || self.toName;
      const root = getRoot(self);
      return root?.annotationStore?.selected?.names?.get(name);
    },
  }))
  .actions((self) => ({
    openEditor() {
      self.isEditorOpen = true;
    },
    closeEditor() {
      self.isEditorOpen = false;
    },
  }));

const VideoRewardAnnotationModel = types.compose("VideoRewardAnnotationModel", ControlBase, ModelAttrs, TagAttrs, Model);

const HtxVideoRewardAnnotation = observer(({ item }) => {
  const [ModalComponent, setModalComponent] = useState(null);

  useEffect(() => {
    console.log('[VideoRewardAnnotation] Component mounted, item:', item);
    // Dynamically import the modal component
    import("../../components/VideoRewardAnnotation/RewardAnnotationModal").then((module) => {
      console.log('[VideoRewardAnnotation] Modal component loaded');
      setModalComponent(() => module.default);
    });
  }, []);

  const handleOpenEditor = () => {
    console.log('[VideoRewardAnnotation] Button clicked, opening editor');
    console.log('[VideoRewardAnnotation] item.isEditorOpen before:', item.isEditorOpen);
    item.openEditor();
    console.log('[VideoRewardAnnotation] item.isEditorOpen after:', item.isEditorOpen);
  };

  const handleCloseEditor = () => {
    console.log('[VideoRewardAnnotation] Closing editor');
    item.closeEditor();
  };

  console.log('[VideoRewardAnnotation] Rendering, isEditorOpen:', item.isEditorOpen, 'ModalComponent:', !!ModalComponent);

  return (
    <div className="htx-video-reward-annotation">
      <button
        type="button"
        onClick={handleOpenEditor}
        style={{
          padding: "8px 16px",
          backgroundColor: "#e94560",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <span>Open Reward Annotation Editor</span>
      </button>

      {item.isEditorOpen && ModalComponent && (
        <ModalComponent
          item={item}
          videoObject={item.videoObject}
          numStages={item.numStagesValue}
          stageNames={item.stageNamesArray}
          rubric={item.rubricData}
          onClose={handleCloseEditor}
        />
      )}
    </div>
  );
});

Registry.addTag("videorewardannotation", VideoRewardAnnotationModel, HtxVideoRewardAnnotation);

export { HtxVideoRewardAnnotation, VideoRewardAnnotationModel };
