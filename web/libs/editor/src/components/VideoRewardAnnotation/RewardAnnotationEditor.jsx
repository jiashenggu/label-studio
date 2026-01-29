import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
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
  console.log("[RewardAnnotationEditor] Rendering inline with props:", {
    item,
    videoObject,
    numStages,
    stageNames,
    rubric,
  });

  // Get or create the region
  const region = item?.result?.area;

  // Ensure region exists
  useEffect(() => {
    if (!item || !videoObject) return;

    // Create initial result if it doesn't exist
    if (!item.result) {
      console.log("[RewardAnnotationEditor] Creating initial result");
      item.createResult?.({
        controlPoints: [],
        denseRewards: [],
        fitMethod: "pchip",
        numStages,
        duration: videoObject?.ref?.current?.duration || 60,
      });
    }
  }, [item, videoObject, numStages]);

  // UI State only (not data state)
  const [selectedPointIndex, setSelectedPointIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [hoverTime, setHoverTime] = useState(0);
  const [isPaused, setIsPaused] = useState(true);
  const [autoFit, setAutoFit] = useState(true);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState(null);
  const [autoStartPoint, setAutoStartPoint] = useState(false);
  const [autoEndPoint, setAutoEndPoint] = useState(false);

  // Refs
  const canvasRef = useRef(null);
  const scrollPositionRef = useRef(0);
  const isHoveringRef = useRef(false);

  // Get data directly from region
  const controlPoints = region?.controlPoints || [];
  const denseRewards = region?.denseRewards || [];
  const fitMethod = region?.fitMethod || "pchip";

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

  // Initialize auto-boundary checkboxes based on existing control points (run once on mount)
  useEffect(() => {
    if (!region || controlPoints.length === 0) return;

    // Check if start point exists (t=0, reward=0)
    const hasStartPoint = controlPoints.some(
      (p) => Math.abs(p.time) < 0.01 && Math.abs(p.reward) < 0.01 && p.isAutoBoundary,
    );

    // Check if end point exists (t=duration, reward=numStages-0.01)
    const hasEndPoint = controlPoints.some(
      (p) =>
        Math.abs(p.time - validDuration) < 0.01 && Math.abs(p.reward - (numStages - 0.01)) < 0.1 && p.isAutoBoundary,
    );

    if (hasStartPoint) {
      setAutoStartPoint(true);
    }
    if (hasEndPoint) {
      setAutoEndPoint(true);
    }
  }, [region]); // Only run once when region is first available

  // Apply auto-boundary points when checkboxes are toggled or video duration changes
  useEffect(() => {
    if (!region || !validDuration || validDuration <= 0) return;

    // Get current control points without auto-boundaries
    const manualPoints = controlPoints.filter((p) => !p.isAutoBoundary);
    const newPoints = [...manualPoints];

    // Add start point if checked
    if (autoStartPoint) {
      const startExists = manualPoints.some((p) => Math.abs(p.time) < 0.01);
      if (!startExists) {
        newPoints.push({ time: 0, reward: 0, type: "normal", isAutoBoundary: true });
      }
    }

    // Add end point if checked
    if (autoEndPoint) {
      const endExists = manualPoints.some((p) => Math.abs(p.time - validDuration) < 0.01);
      if (!endExists) {
        newPoints.push({
          time: validDuration,
          reward: numStages - 0.01,
          type: "normal",
          isAutoBoundary: true,
        });
      }
    }

    // Only update if points changed
    if (JSON.stringify(newPoints.sort((a, b) => a.time - b.time)) !== JSON.stringify(controlPoints)) {
      region.setControlPoints(newPoints);
    }
  }, [autoStartPoint, autoEndPoint, validDuration, numStages, region]);

  // Sync with video time
  useEffect(() => {
    if (!videoObject?.ref?.current) return;

    const videoEl = videoObject.ref.current;

    // Check if it's a valid DOM element or ref object with addEventListener
    if (!videoEl || typeof videoEl.addEventListener !== "function") {
      console.warn("[RewardAnnotationEditor] Video element not ready or missing addEventListener");
      return;
    }

    const handleTimeUpdate = () => {
      const newTime = videoEl.currentTime || 0;
      const paused = videoEl.paused;
      console.log(
        "[VideoRewardAnnotation] timeupdate event:",
        newTime,
        "paused:",
        paused,
        "isHovering:",
        isHoveringRef.current,
      );
      setCurrentTime(newTime);
      setIsPaused(paused);

      // Always update hover time when not actively hovering on RewardAnnotation canvas
      // This ensures the indicator updates when hovering on VideoRectangle timeline
      if (!isHoveringRef.current) {
        console.log("[VideoRewardAnnotation] Updating hoverTime to:", newTime);
        setHoverTime(newTime);
      }
    };

    const handleSeeking = () => {
      // Fired when seeking starts
      const newTime = videoEl.currentTime || 0;
      const paused = videoEl.paused;
      console.log(
        "[VideoRewardAnnotation] seeking event:",
        newTime,
        "paused:",
        paused,
        "isHovering:",
        isHoveringRef.current,
      );
      setCurrentTime(newTime);
      setIsPaused(paused);

      // Always update hover time when not actively hovering on RewardAnnotation canvas
      // This ensures the indicator updates when hovering on VideoRectangle timeline
      if (!isHoveringRef.current) {
        console.log("[VideoRewardAnnotation] Updating hoverTime from seeking to:", newTime);
        setHoverTime(newTime);
      }
    };

    const handleSeeked = () => {
      // Fired immediately after a seek operation completes
      const newTime = videoEl.currentTime || 0;
      const paused = videoEl.paused;
      console.log(
        "[VideoRewardAnnotation] seeked event:",
        newTime,
        "paused:",
        paused,
        "isHovering:",
        isHoveringRef.current,
      );
      setCurrentTime(newTime);
      setIsPaused(paused);

      // Always update hover time when not actively hovering on RewardAnnotation canvas
      // This ensures the indicator updates when hovering on VideoRectangle timeline
      if (!isHoveringRef.current) {
        console.log("[VideoRewardAnnotation] Updating hoverTime from seeked to:", newTime);
        setHoverTime(newTime);
      }
    };

    const handlePlay = () => {
      console.log("[VideoRewardAnnotation] play event");
      setIsPaused(false);
    };

    const handlePause = () => {
      console.log("[VideoRewardAnnotation] pause event");
      setIsPaused(true);
      // When paused, sync hoverTime with currentTime if not actively hovering
      if (!isHoveringRef.current) {
        setHoverTime(videoEl.currentTime || 0);
      }
    };

    videoEl.addEventListener("timeupdate", handleTimeUpdate);
    videoEl.addEventListener("seeking", handleSeeking);
    videoEl.addEventListener("seeked", handleSeeked);
    videoEl.addEventListener("play", handlePlay);
    videoEl.addEventListener("pause", handlePause);

    // Initial sync
    setCurrentTime(videoEl.currentTime || 0);
    setIsPaused(videoEl.paused);
    if (!isHoveringRef.current) {
      setHoverTime(videoEl.currentTime || 0);
    }

    return () => {
      if (videoEl && typeof videoEl.removeEventListener === "function") {
        videoEl.removeEventListener("timeupdate", handleTimeUpdate);
        videoEl.removeEventListener("seeking", handleSeeking);
        videoEl.removeEventListener("seeked", handleSeeked);
        videoEl.removeEventListener("play", handlePlay);
        videoEl.removeEventListener("pause", handlePause);
      }
    };
  }, [videoObject]);

  // Fit curve - directly update region
  useEffect(() => {
    if (!region || !autoFit) return;
    if (controlPoints.length < 2) {
      if (region.denseRewards?.length > 0) {
        region.setDenseRewards([]);
      }
      return;
    }

    const sorted = [...controlPoints].sort((a, b) => a.time - b.time);
    const fitted = fitCurve(sorted, validDuration, validFps, fitMethod);

    // Only update if different
    const isSame = JSON.stringify(region.denseRewards) === JSON.stringify(fitted);
    if (!isSame) {
      region.setDenseRewards(fitted);
    }
  }, [controlPoints, validDuration, validFps, fitMethod, autoFit, region]);

  // Prevent scroll when modal is open
  useEffect(() => {
    if (isEditModalOpen) {
      // Save current scroll position
      scrollPositionRef.current = window.scrollY;
      // Prevent body scroll
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollPositionRef.current}px`;
      document.body.style.width = "100%";
    } else {
      // Restore body scroll
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      // Restore scroll position
      window.scrollTo(0, scrollPositionRef.current);
    }

    return () => {
      // Cleanup on unmount
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
    };
  }, [isEditModalOpen]);

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
        const t = i / validFps;
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

      if (pt.type === "step") {
        // Draw lightning bolt for step transitions
        ctx.save();
        ctx.translate(x, y);

        // Background circle
        ctx.fillStyle = idx === selectedPointIndex ? "#fbbf24" : "#fbbf24";
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.fill();

        // White border
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw lightning bolt icon
        ctx.strokeStyle = "#1a1a2e";
        ctx.fillStyle = "#1a1a2e";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // Lightning bolt path (scaled down)
        ctx.moveTo(1, -5);
        ctx.lineTo(-2, 0);
        ctx.lineTo(1, 0);
        ctx.lineTo(-1, 5);
        ctx.lineTo(2, 0);
        ctx.lineTo(-1, 0);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      } else {
        // Normal point - circle
        ctx.fillStyle = idx === selectedPointIndex ? "#4ade80" : "#e94560";
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    // Draw current time indicator (green dashed line)
    const currentX = timeToX(currentTime);
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(currentX, area.y);
    ctx.lineTo(currentX, area.y + area.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw hover time indicator (orange solid line)
    // Show when video is paused to indicate the current seek position
    // This works for both hovering on RewardAnnotation canvas AND VideoRectangle timeline
    console.log(
      "[VideoRewardAnnotation] Drawing canvas. isPaused:",
      isPaused,
      "hoverTime:",
      hoverTime,
      "currentTime:",
      currentTime,
    );

    if (isPaused) {
      // When paused, show orange indicator at the hover/seek position
      const hoverX = timeToX(hoverTime);
      console.log("[VideoRewardAnnotation] Drawing orange indicator at x:", hoverX, "for time:", hoverTime);
      ctx.strokeStyle = "rgba(251, 191, 36, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hoverX, area.y);
      ctx.lineTo(hoverX, area.y + area.height);
      ctx.stroke();

      // Draw time label at top
      ctx.fillStyle = "rgba(251, 191, 36, 1)";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${hoverTime.toFixed(2)}s`, hoverX, area.y - 10);
    }
  }, [
    controlPoints,
    denseRewards,
    selectedPointIndex,
    currentTime,
    hoverTime,
    isPaused,
    validDuration,
    validFps,
    numStages,
    timeToX,
    rewardToY,
    getPlotArea,
  ]);

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

  // Handle canvas mouse move - update hover indicator and seek video
  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const area = getPlotArea();

    // Only update if mouse is within plot area
    if (x >= area.x && x <= area.x + area.width) {
      const time = xToTime(x);
      isHoveringRef.current = true;
      setHoverTime(time);

      // Seek video to this time
      if (videoObject?.ref?.current && typeof videoObject.ref.current.currentTime !== "undefined") {
        const videoEl = videoObject.ref.current;
        // Only seek if video is paused or if time difference is significant
        if (videoEl.paused || Math.abs(videoEl.currentTime - time) > 0.5) {
          videoEl.currentTime = time;
        }
      }
    }
  };

  // Handle canvas mouse leave - reset hover indicator
  const handleCanvasMouseLeave = () => {
    isHoveringRef.current = false;
    setHoverTime(currentTime);
  };

  // Apply edit from modal - directly update region
  const applyEdit = (e) => {
    // Prevent event bubbling that might interfere with modal closing
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!editingPoint || !region) return;

    if (editingPoint.index >= 0) {
      // Update existing point
      const oldPoint = controlPoints[editingPoint.index];
      const newPoint = {
        time: editingPoint.time,
        reward: editingPoint.reward,
        type: editingPoint.type,
      };

      // If editing an auto-boundary point and changing its values,
      // remove the isAutoBoundary flag and uncheck the corresponding checkbox
      if (oldPoint?.isAutoBoundary) {
        const timeChanged = Math.abs(oldPoint.time - newPoint.time) > 0.01;
        const rewardChanged = Math.abs(oldPoint.reward - newPoint.reward) > 0.01;

        if (timeChanged || rewardChanged) {
          // User manually edited the auto-boundary point, so it's no longer auto
          if (Math.abs(oldPoint.time) < 0.01) {
            setAutoStartPoint(false);
          } else if (Math.abs(oldPoint.time - validDuration) < 0.01) {
            setAutoEndPoint(false);
          }
        } else {
          // Keep isAutoBoundary flag if values didn't change
          newPoint.isAutoBoundary = true;
        }
      }

      const newPoints = [...controlPoints];
      newPoints[editingPoint.index] = newPoint;
      region.setControlPoints(newPoints);
    } else {
      // Add new point
      const newPoint = {
        time: editingPoint.time,
        reward: editingPoint.reward,
        type: editingPoint.type,
      };
      region.setControlPoints([...controlPoints, newPoint]);
      setSelectedPointIndex(controlPoints.length);
    }

    // Close modal immediately
    setIsEditModalOpen(false);
    setEditingPoint(null);
  };

  // Cancel edit
  const cancelEdit = () => {
    setIsEditModalOpen(false);
    setEditingPoint(null);
  };

  // Delete selected point - directly update region
  const deleteSelectedPoint = () => {
    if (selectedPointIndex < 0 || !region) return;

    const pointToDelete = controlPoints[selectedPointIndex];

    // If deleting an auto-boundary point, uncheck the corresponding checkbox
    if (pointToDelete?.isAutoBoundary) {
      if (Math.abs(pointToDelete.time) < 0.01) {
        setAutoStartPoint(false);
      } else if (Math.abs(pointToDelete.time - validDuration) < 0.01) {
        setAutoEndPoint(false);
      }
    }

    const newPoints = controlPoints.filter((_, i) => i !== selectedPointIndex);
    region.setControlPoints(newPoints);
    setSelectedPointIndex(-1);
  };

  // Clear all - directly update region
  const clearAll = () => {
    if (!region) return;
    if (window.confirm("Clear all control points?")) {
      region.clearAnnotation();
      setSelectedPointIndex(-1);
      // Reset auto-boundary checkboxes when clearing all
      setAutoStartPoint(false);
      setAutoEndPoint(false);
    }
  };

  return (
    <>
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
            {/* Auto-boundary checkboxes */}
            <div
              className="reward-editor__auto-boundaries"
              style={{
                display: "flex",
                gap: "20px",
                marginBottom: "15px",
                padding: "12px",
                background: "rgba(0,0,0,0.2)",
                borderRadius: "6px",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                  color: "#a0a0a0",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoStartPoint}
                  onChange={(e) => setAutoStartPoint(e.target.checked)}
                  style={{
                    width: "16px",
                    height: "16px",
                    cursor: "pointer",
                    accentColor: "#4ade80",
                  }}
                />
                <span>Auto-add start point (t=0, reward=0)</span>
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                  color: "#a0a0a0",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoEndPoint}
                  onChange={(e) => setAutoEndPoint(e.target.checked)}
                  style={{
                    width: "16px",
                    height: "16px",
                    cursor: "pointer",
                    accentColor: "#4ade80",
                  }}
                />
                <span>Auto-add end point (t=duration, reward={numStages - 0.01})</span>
              </label>
            </div>

            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              onMouseMove={handleCanvasMouseMove}
              onMouseLeave={handleCanvasMouseLeave}
              style={{ width: "100%", height: "400px", cursor: "crosshair" }}
            />
            <div className="reward-editor__legend">
              <span>
                🔴 Click to add points • ⚡ Yellow = Step transition • 🟢 Green = Selected • Auto-boundary points can be
                edited
              </span>
            </div>
          </div>

          <div className="reward-editor__controls">
            <div className="reward-editor__toolbar">
              <button
                type="button"
                onClick={deleteSelectedPoint}
                disabled={selectedPointIndex < 0}
                className="reward-editor__btn"
                style={{
                  padding: "14px 32px",
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  minWidth: "160px",
                  background: selectedPointIndex < 0 ? "#2d3748" : "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
                  border: `2px solid ${selectedPointIndex < 0 ? "#4a5568" : "#d97706"}`,
                  color: "white",
                  cursor: selectedPointIndex < 0 ? "not-allowed" : "pointer",
                  transition: "all 0.2s ease",
                  boxShadow: selectedPointIndex < 0 ? "none" : "0 4px 12px rgba(245, 158, 11, 0.3)",
                  opacity: selectedPointIndex < 0 ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (selectedPointIndex >= 0) {
                    e.target.style.transform = "translateY(-2px)";
                    e.target.style.boxShadow = "0 6px 20px rgba(245, 158, 11, 0.4)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedPointIndex >= 0) {
                    e.target.style.transform = "translateY(0)";
                    e.target.style.boxShadow = "0 4px 12px rgba(245, 158, 11, 0.3)";
                  }
                }}
              >
                Delete Point
              </button>
              <span
                className="reward-editor__separator"
                style={{ margin: "0 15px", fontSize: "1.5rem", color: "#666" }}
              >
                •
              </span>
              <button
                type="button"
                onClick={clearAll}
                className="reward-editor__btn reward-editor__btn--danger"
                style={{
                  padding: "14px 32px",
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  minWidth: "140px",
                  background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
                  border: "2px solid #dc2626",
                  color: "white",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  boxShadow: "0 4px 12px rgba(239, 68, 68, 0.3)",
                }}
                onMouseEnter={(e) => {
                  e.target.style.transform = "translateY(-2px)";
                  e.target.style.boxShadow = "0 6px 20px rgba(239, 68, 68, 0.4)";
                }}
                onMouseLeave={(e) => {
                  e.target.style.transform = "translateY(0)";
                  e.target.style.boxShadow = "0 4px 12px rgba(239, 68, 68, 0.3)";
                }}
              >
                Clear All
              </button>
            </div>

            <div className="reward-editor__settings">
              <label>
                Fit Method:
                <select
                  value={fitMethod}
                  onChange={(e) => region?.setFitMethod(e.target.value)}
                  className="reward-editor__select"
                >
                  <option value="pchip">PCHIP</option>
                  <option value="linear">Linear</option>
                </select>
              </label>
              <label>
                <input type="checkbox" checked={autoFit} onChange={(e) => setAutoFit(e.target.checked)} />
                Auto-fit curve
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Point Modal - Rendered as Portal */}
      {isEditModalOpen &&
        editingPoint &&
        createPortal(
          <div
            className="reward-editor__edit-overlay"
            onClick={cancelEdit}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.7)",
              zIndex: 99999,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            <div
              className="reward-editor__edit-modal"
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "#16213e",
                borderRadius: "12px",
                padding: "30px",
                minWidth: "450px",
                maxWidth: "600px",
                maxHeight: "80vh",
                overflowY: "auto",
                border: "1px solid #0f3460",
                boxShadow: "0 20px 50px rgba(0, 0, 0, 0.5)",
                color: "#eaeaea",
              }}
            >
              <h3 style={{ margin: "0 0 25px 0", fontSize: "1.3rem", color: "#eaeaea" }}>
                {editingPoint.index >= 0 ? "Edit Control Point" : "Add Control Point"}
              </h3>

              <div className="reward-editor__form-group">
                <label
                  style={{
                    display: "block",
                    marginBottom: "8px",
                    color: "#a0a0a0",
                    fontSize: "0.95rem",
                    fontWeight: 500,
                  }}
                >
                  Time (seconds)
                </label>
                <input
                  type="number"
                  min="0"
                  max={validDuration}
                  step="0.1"
                  value={editingPoint.time}
                  onChange={(e) => setEditingPoint({ ...editingPoint, time: Number.parseFloat(e.target.value) || 0 })}
                  style={{
                    width: "100%",
                    padding: "12px",
                    background: "#1a1a2e",
                    border: "1px solid #0f3460",
                    borderRadius: "6px",
                    color: "#ffffff",
                    fontSize: "1.1rem",
                    fontWeight: 500,
                  }}
                />
              </div>

              <div className="reward-editor__form-group">
                <label
                  style={{
                    display: "block",
                    marginBottom: "8px",
                    color: "#a0a0a0",
                    fontSize: "0.95rem",
                    fontWeight: 500,
                  }}
                >
                  Reward Score
                </label>
                <input
                  type="number"
                  min="0"
                  max={numStages}
                  step="0.01"
                  value={editingPoint.reward}
                  onChange={(e) => setEditingPoint({ ...editingPoint, reward: Number.parseFloat(e.target.value) || 0 })}
                  autoFocus
                  style={{
                    width: "100%",
                    padding: "12px",
                    background: "#1a1a2e",
                    border: "1px solid #0f3460",
                    borderRadius: "6px",
                    color: "#ffffff",
                    fontSize: "1.1rem",
                    fontWeight: 500,
                  }}
                />
              </div>

              <div className="reward-editor__form-group">
                <label>
                  <input
                    type="checkbox"
                    checked={editingPoint.type === "step"}
                    onChange={(e) => setEditingPoint({ ...editingPoint, type: e.target.checked ? "step" : "normal" })}
                    style={{
                      marginRight: "10px",
                      width: "18px",
                      height: "18px",
                      cursor: "pointer",
                      accentColor: "#e94560",
                    }}
                  />
                  <span style={{ color: "#eaeaea" }}>Step transition (instant jump)</span>
                </label>
              </div>

              {rubric && (
                <div
                  style={{
                    marginTop: "20px",
                    paddingTop: "15px",
                    borderTop: "1px solid #0f3460",
                    maxHeight: "300px",
                    overflowY: "auto",
                  }}
                >
                  <h4 style={{ margin: "0 0 10px 0", fontSize: "0.95rem", color: "#a0a0a0" }}>Scoring Reference</h4>
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: "0.9rem",
                      lineHeight: "1.6",
                      color: "#eaeaea",
                      fontFamily: "monospace",
                      background: "#0a0a15",
                      padding: "12px",
                      borderRadius: "6px",
                      border: "1px solid #0f3460",
                    }}
                  >
                    {typeof rubric === "string" ? rubric : JSON.stringify(rubric, null, 2)}
                  </div>
                </div>
              )}

              <div className="reward-editor__edit-actions">
                <button
                  type="button"
                  onClick={applyEdit}
                  className="reward-editor__btn reward-editor__btn--primary"
                  style={{
                    padding: "16px 40px",
                    fontSize: "1.1rem",
                    fontWeight: 600,
                    minWidth: "180px",
                    background: "linear-gradient(135deg, #4ade80 0%, #22c55e 100%)",
                    border: "2px solid #22c55e",
                    color: "white",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                    boxShadow: "0 4px 12px rgba(74, 222, 128, 0.3)",
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.transform = "translateY(-2px)";
                    e.target.style.boxShadow = "0 6px 20px rgba(74, 222, 128, 0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.transform = "translateY(0)";
                    e.target.style.boxShadow = "0 4px 12px rgba(74, 222, 128, 0.3)";
                  }}
                >
                  {editingPoint.index >= 0 ? "Update" : "Add"} Point
                </button>
                <span
                  className="reward-editor__separator"
                  style={{ margin: "0 15px", fontSize: "1.5rem", color: "#666" }}
                >
                  •
                </span>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="reward-editor__btn"
                  style={{
                    padding: "16px 40px",
                    fontSize: "1.1rem",
                    fontWeight: 600,
                    minWidth: "140px",
                    background: "#374151",
                    border: "2px solid #4b5563",
                    color: "white",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.background = "#4b5563";
                    e.target.style.transform = "translateY(-2px)";
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = "#374151";
                    e.target.style.transform = "translateY(0)";
                  }}
                >
                  Cancel
                </button>
                {editingPoint.index >= 0 && (
                  <>
                    <span
                      className="reward-editor__separator"
                      style={{ margin: "0 15px", fontSize: "1.5rem", color: "#666" }}
                    >
                      •
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        deleteSelectedPoint();
                        cancelEdit();
                      }}
                      className="reward-editor__btn reward-editor__btn--danger"
                      style={{
                        padding: "16px 40px",
                        fontSize: "1.1rem",
                        fontWeight: 600,
                        minWidth: "160px",
                        background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)",
                        border: "2px solid #dc2626",
                        color: "white",
                        cursor: "pointer",
                        transition: "all 0.2s ease",
                        boxShadow: "0 4px 12px rgba(239, 68, 68, 0.3)",
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.transform = "translateY(-2px)";
                        e.target.style.boxShadow = "0 6px 20px rgba(239, 68, 68, 0.4)";
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.transform = "translateY(0)";
                        e.target.style.boxShadow = "0 4px 12px rgba(239, 68, 68, 0.3)";
                      }}
                    >
                      Delete Point
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});

export default RewardAnnotationEditor;
