import React, { useState, useEffect, useRef, useCallback } from "react";
import { observer } from "mobx-react";
import { fitCurve, clamp } from "./curveFitting";
import "./RewardAnnotationEditor.scss";

// Stage colors for background (pastel)
const STAGE_COLORS = [
  "rgba(255, 230, 230, 0.8)", // Stage 0: Light red/pink
  "rgba(255, 230, 204, 0.8)", // Stage 1: Light orange
  "rgba(255, 255, 204, 0.8)", // Stage 2: Light yellow
  "rgba(230, 255, 230, 0.8)", // Stage 3: Light green
  "rgba(230, 243, 255, 0.8)", // Stage 4: Light blue
  "rgba(240, 230, 255, 0.8)", // Stage 5: Light purple
];

// Canvas padding
const PADDING = { top: 30, right: 30, bottom: 50, left: 60 };

const RewardAnnotationEditor = observer(({ item, videoObject, numStages, stageNames, rubric }) => {
  console.log('[RewardAnnotationEditor] Rendering inline with props:', { item, videoObject, numStages, stageNames, rubric });
  
  // State
  const [controlPoints, setControlPoints] = useState([]);
  const [denseRewards, setDenseRewards] = useState([]);
  const [selectedPointIndex, setSelectedPointIndex] = useState(-1);
  const [fitMethod, setFitMethod] = useState("pchip");
  const [currentTime, setCurrentTime] = useState(0);
  const [showRubric, setShowRubric] = useState(false);
  const [autoFit, setAutoFit] = useState(true);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState(null);

  // Refs
  const canvasRef = useRef(null);

  // Video info
  const duration = videoObject?.ref?.current?.duration || 60;
  const fps = videoObject?.framerate || 30;

  // Validate duration and fps
  const validDuration = !isNaN(duration) && duration > 0 ? duration : 60;
  const validFps = !isNaN(fps) && fps > 0 ? fps : 30;

  // Canvas helpers
  const getPlotArea = useCallback(() => {
    if (!canvasRef.current) return { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: PADDING.left,
      y: PADDING.top,
      width: canvasRef.current.width - PADDING.left - PADDING.right,
      height: canvasRef.current.height - PADDING.top - PADDING.bottom,
    };
  }, []);

  const timeToX = useCallback(
    (time) => {
      const area = getPlotArea();
      return area.x + (time / validDuration) * area.width;
    },
    [validDuration, getPlotArea],
  );

  const rewardToY = useCallback(
    (reward) => {
      const area = getPlotArea();
      return area.y + area.height - (reward / numStages) * area.height;
    },
    [numStages, getPlotArea],
  );

  const xToTime = useCallback(
    (x) => {
      const area = getPlotArea();
      return clamp(((x - area.x) / area.width) * validDuration, 0, validDuration);
    },
    [validDuration, getPlotArea],
  );

  const yToReward = useCallback(
    (y) => {
      const area = getPlotArea();
      return clamp(((area.y + area.height - y) / area.height) * numStages, 0, numStages);
    },
    [numStages, getPlotArea],
  );

  // Sync with video time
  useEffect(() => {
    if (!videoObject?.ref?.current) return;
    
    const videoEl = videoObject.ref.current;
    
    // Check if it's a valid DOM element
    if (!videoEl || typeof videoEl.addEventListener !== 'function') {
      console.warn('[RewardAnnotationEditor] Video element not ready');
      return;
    }
    
    const handleTimeUpdate = () => {
      setCurrentTime(videoEl.currentTime || 0);
    };

    videoEl.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      if (videoEl && typeof videoEl.removeEventListener === 'function') {
        videoEl.removeEventListener("timeupdate", handleTimeUpdate);
      }
    };
  }, [videoObject]);

  // Fit curve
  useEffect(() => {
    if (controlPoints.length < 2 || !autoFit) {
      setDenseRewards([]);
      return;
    }

    const sorted = [...controlPoints].sort((a, b) => a.time - b.time);
    const fitted = fitCurve(sorted, validDuration, validFps, fitMethod);
    setDenseRewards(fitted);
  }, [controlPoints, validDuration, validFps, fitMethod, autoFit]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const area = getPlotArea();

    // Clear
    ctx.fillStyle = "#0a0a15";
    ctx.fillRect(0, 0, rect.width, rect.height);

    // Draw stage backgrounds
    for (let i = 0; i < numStages; i++) {
      const y1 = rewardToY(i + 1);
      const y2 = rewardToY(i);
      ctx.fillStyle = STAGE_COLORS[i % STAGE_COLORS.length];
      ctx.fillRect(area.x, y1, area.width, y2 - y1);
    }

    // Draw grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;

    // Vertical grid lines (time)
    const timeSteps = 10;
    for (let i = 0; i <= timeSteps; i++) {
      const t = (validDuration * i) / timeSteps;
      const x = timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.height);
      ctx.stroke();
    }

    // Horizontal grid lines (reward)
    for (let i = 0; i <= numStages; i++) {
      const y = rewardToY(i);
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.width, y);
      ctx.stroke();
    }

    // Draw axes
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(area.x, area.y, area.width, area.height);

    // Draw labels
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";

    // X-axis labels (time)
    for (let i = 0; i <= timeSteps; i++) {
      const t = (validDuration * i) / timeSteps;
      const x = timeToX(t);
      ctx.fillText(`${t.toFixed(1)}s`, x, area.y + area.height + 25);
    }

    // Y-axis labels (reward/stage)
    ctx.textAlign = "right";
    for (let i = 0; i <= numStages; i++) {
      const y = rewardToY(i);
      ctx.fillText(i.toFixed(1), area.x - 10, y + 4);
    }

    // Draw fitted curve
    if (denseRewards.length > 0) {
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      denseRewards.forEach((r, i) => {
        const t = (i / validFps);
        const x = timeToX(t);
        const y = rewardToY(r);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Draw control points
    controlPoints.forEach((pt, idx) => {
      const x = timeToX(pt.time);
      const y = rewardToY(pt.reward);

      // Point
      ctx.fillStyle = idx === selectedPointIndex ? "#fbbf24" : "#e94560";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Draw current time indicator
    const currentX = timeToX(currentTime);
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(currentX, area.y);
    ctx.lineTo(currentX, area.y + area.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [controlPoints, denseRewards, selectedPointIndex, currentTime, validDuration, validFps, numStages, timeToX, rewardToY, getPlotArea]);

  // Handle canvas click
  const handleCanvasClick = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const time = xToTime(x);
    const reward = yToReward(y);

    // Check if clicking near existing point
    const clickThreshold = 10;
    const clickedPointIndex = controlPoints.findIndex((pt) => {
      const ptX = timeToX(pt.time);
      const ptY = rewardToY(pt.reward);
      const dist = Math.sqrt((ptX - x) ** 2 + (ptY - y) ** 2);
      return dist < clickThreshold;
    });

    if (clickedPointIndex >= 0) {
      // Edit existing point
      setSelectedPointIndex(clickedPointIndex);
      setEditingPoint({
        index: clickedPointIndex,
        time: controlPoints[clickedPointIndex].time,
        reward: controlPoints[clickedPointIndex].reward,
        type: controlPoints[clickedPointIndex].type || "normal",
      });
      setIsEditModalOpen(true);
    } else {
      // Add new point with edit dialog
      setEditingPoint({
        index: -1, // New point
        time,
        reward,
        type: "normal",
      });
      setIsEditModalOpen(true);
    }
  };

  // Apply edit from modal
  const applyEdit = () => {
    if (!editingPoint) return;

    if (editingPoint.index >= 0) {
      // Update existing point
      const newPoints = [...controlPoints];
      newPoints[editingPoint.index] = {
        time: editingPoint.time,
        reward: editingPoint.reward,
        type: editingPoint.type,
      };
      setControlPoints(newPoints);
    } else {
      // Add new point
      const newPoint = {
        time: editingPoint.time,
        reward: editingPoint.reward,
        type: editingPoint.type,
      };
      setControlPoints([...controlPoints, newPoint]);
      setSelectedPointIndex(controlPoints.length);
    }

    setIsEditModalOpen(false);
    setEditingPoint(null);
  };

  // Cancel edit
  const cancelEdit = () => {
    setIsEditModalOpen(false);
    setEditingPoint(null);
  };

  // Delete selected point
  const deleteSelectedPoint = () => {
    if (selectedPointIndex < 0) return;
    const newPoints = controlPoints.filter((_, i) => i !== selectedPointIndex);
    setControlPoints(newPoints);
    setSelectedPointIndex(-1);
  };

  // Clear all
  const clearAll = () => {
    if (window.confirm("Clear all control points?")) {
      setControlPoints([]);
      setSelectedPointIndex(-1);
    }
  };

  // Save annotation
  const saveAnnotation = () => {
    const annotation = item?.annotation;
    if (!annotation) return;

    const result = {
      from_name: item.name,
      to_name: item.toname,
      type: "videorewardannotation",
      value: {
        controlPoints,
        denseRewards,
        fitMethod,
        numStages,
        duration: validDuration,
      },
    };

    annotation.addResult(result);
    alert("Annotation saved!");
  };

  return (
    <div className="reward-editor">
      <div className="reward-editor__header">
        <h3>Reward Curve Annotation</h3>
        <div className="reward-editor__info">
          <span>Duration: {validDuration.toFixed(1)}s</span>
          <span>|</span>
          <span>Stages: {numStages}</span>
          <span>|</span>
          <span>Current: {currentTime.toFixed(2)}s</span>
        </div>
      </div>

      <div className="reward-editor__content">
        <div className="reward-editor__canvas-section">
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{ width: "100%", height: "400px", cursor: "crosshair" }}
          />
          <div className="reward-editor__legend">
            <span>Click to add points • Click point to select • Delete key to remove</span>
          </div>
        </div>

        <div className="reward-editor__controls">
          <div className="reward-editor__toolbar">
            <button type="button" onClick={saveAnnotation} className="reward-editor__btn reward-editor__btn--primary">
              Save Annotation
            </button>
            <button type="button" onClick={deleteSelectedPoint} disabled={selectedPointIndex < 0} className="reward-editor__btn">
              Delete Point
            </button>
            <button type="button" onClick={clearAll} className="reward-editor__btn reward-editor__btn--danger">
              Clear All
            </button>
            <button type="button" onClick={() => setShowRubric(!showRubric)} className="reward-editor__btn">
              {showRubric ? "Hide" : "Show"} Rubric
            </button>
          </div>

          <div className="reward-editor__settings">
            <label>
              Fit Method:
              <select value={fitMethod} onChange={(e) => setFitMethod(e.target.value)} className="reward-editor__select">
                <option value="pchip">PCHIP</option>
                <option value="linear">Linear</option>
              </select>
            </label>
            <label>
              <input type="checkbox" checked={autoFit} onChange={(e) => setAutoFit(e.target.checked)} />
              Auto-fit curve
            </label>
          </div>

          {showRubric && rubric && rubric.length > 0 && (
            <div className="reward-editor__rubric">
              <h4>Rubric</h4>
              {rubric.map((stage, idx) => (
                <div key={idx} className="reward-editor__rubric-stage">
                  <strong>{stage.title || `Stage ${stage.stage}`}</strong>
                  {stage.criteria?.map((c, i) => (
                    <div key={i} className="reward-editor__rubric-item">
                      <span className="score">{c.score.toFixed(2)}</span>
                      <span>{c.description}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Edit Point Modal */}
      {isEditModalOpen && editingPoint && (
        <div className="reward-editor__edit-overlay" onClick={cancelEdit}>
          <div className="reward-editor__edit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingPoint.index >= 0 ? "Edit Control Point" : "Add Control Point"}</h3>
            
            <div className="reward-editor__form-group">
              <label>Time (seconds)</label>
              <input
                type="number"
                min="0"
                max={validDuration}
                step="0.1"
                value={editingPoint.time}
                onChange={(e) => setEditingPoint({ ...editingPoint, time: Number.parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="reward-editor__form-group">
              <label>Reward Score</label>
              <input
                type="number"
                min="0"
                max={numStages}
                step="0.01"
                value={editingPoint.reward}
                onChange={(e) => setEditingPoint({ ...editingPoint, reward: Number.parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="reward-editor__form-group">
              <label>
                <input
                  type="checkbox"
                  checked={editingPoint.type === "step"}
                  onChange={(e) => setEditingPoint({ ...editingPoint, type: e.target.checked ? "step" : "normal" })}
                />
                Step transition (instant jump)
              </label>
            </div>

            {showRubric && rubric && rubric.length > 0 && (
              <div className="reward-editor__edit-rubric">
                <h4>Scoring Reference</h4>
                {rubric.map((stage, idx) => (
                  <div key={idx} className="reward-editor__rubric-stage">
                    <strong>{stage.title || `Stage ${stage.stage}`}</strong>
                    {stage.criteria?.map((c, i) => (
                      <div key={i} className="reward-editor__rubric-item">
                        <span className="score">{c.score.toFixed(2)}</span>
                        <span>{c.description}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div className="reward-editor__edit-actions">
              <button type="button" onClick={applyEdit} className="reward-editor__btn reward-editor__btn--primary">
                {editingPoint.index >= 0 ? "Update" : "Add"} Point
              </button>
              <button type="button" onClick={cancelEdit} className="reward-editor__btn">
                Cancel
              </button>
              {editingPoint.index >= 0 && (
                <button
                  type="button"
                  onClick={() => {
                    deleteSelectedPoint();
                    cancelEdit();
                  }}
                  className="reward-editor__btn reward-editor__btn--danger"
                >
                  Delete Point
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default RewardAnnotationEditor;
