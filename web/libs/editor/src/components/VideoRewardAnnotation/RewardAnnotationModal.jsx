import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
import { fitCurve, clamp } from "./curveFitting";
import "./RewardAnnotationModal.scss";

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

const RewardAnnotationModal = observer(({ item, videoObject, numStages, stageNames, rubric, onClose }) => {
  console.log('[RewardAnnotationModal] Rendering with props:', { item, videoObject, numStages, stageNames, rubric });
  
  // State
  const [controlPoints, setControlPoints] = useState([]);
  const [denseRewards, setDenseRewards] = useState([]);
  const [selectedPointIndex, setSelectedPointIndex] = useState(-1);
  const [fitMethod, setFitMethod] = useState("pchip");
  const [currentTime, setCurrentTime] = useState(0);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState(null);
  const [isAddingNewPoint, setIsAddingNewPoint] = useState(false);
  const [showRubricPanel, setShowRubricPanel] = useState(false);
  const [autoFit, setAutoFit] = useState(true);
  const [draggingPoint, setDraggingPoint] = useState(false);

  // Undo/Redo stacks
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  // Refs
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Video info
  const duration = videoObject?.ref?.current?.duration || 60;
  const fps = videoObject?.framerate || 30;

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
      return area.x + (time / duration) * area.width;
    },
    [duration, getPlotArea],
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
      return clamp(((x - area.x) / area.width) * duration, 0, duration);
    },
    [duration, getPlotArea],
  );

  const yToReward = useCallback(
    (y) => {
      const area = getPlotArea();
      return clamp((1 - (y - area.y) / area.height) * numStages, 0, numStages);
    },
    [numStages, getPlotArea],
  );

  // Save state for undo
  const saveStateForUndo = useCallback(() => {
    setUndoStack((prev) => [...prev.slice(-49), { controlPoints: [...controlPoints], selectedPointIndex }]);
    setRedoStack([]);
  }, [controlPoints, selectedPointIndex]);

  // Undo
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prevState = undoStack[undoStack.length - 1];
    setRedoStack((prev) => [...prev, { controlPoints: [...controlPoints], selectedPointIndex }]);
    setControlPoints(prevState.controlPoints);
    setSelectedPointIndex(prevState.selectedPointIndex);
    setUndoStack((prev) => prev.slice(0, -1));
    setDenseRewards([]);
  }, [undoStack, controlPoints, selectedPointIndex]);

  // Redo
  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const nextState = redoStack[redoStack.length - 1];
    setUndoStack((prev) => [...prev, { controlPoints: [...controlPoints], selectedPointIndex }]);
    setControlPoints(nextState.controlPoints);
    setSelectedPointIndex(nextState.selectedPointIndex);
    setRedoStack((prev) => prev.slice(0, -1));
    setDenseRewards([]);
  }, [redoStack, controlPoints, selectedPointIndex]);

  // Fit curve
  const doFitCurve = useCallback(() => {
    if (controlPoints.length < 2) return;
    const rewards = fitCurve(controlPoints, duration, fps, fitMethod);
    setDenseRewards(rewards);
  }, [controlPoints, duration, fps, fitMethod]);

  // Auto-fit when points change
  useEffect(() => {
    if (autoFit && controlPoints.length >= 2) {
      doFitCurve();
    }
  }, [autoFit, controlPoints, doFitCurve]);

  // Draw canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const area = getPlotArea();

    // Clear
    ctx.fillStyle = "#0a0a15";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw stage backgrounds
    for (let i = 0; i < numStages; i++) {
      const y1 = rewardToY(i + 1);
      const y2 = rewardToY(i);
      ctx.fillStyle = STAGE_COLORS[i % STAGE_COLORS.length];
      ctx.fillRect(area.x, y1, area.width, y2 - y1);
    }

    // Draw grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    for (let i = 1; i < numStages; i++) {
      const y = rewardToY(i);
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Y-axis labels
    ctx.fillStyle = "#a0a0a0";
    ctx.font = "12px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= numStages; i++) {
      const y = rewardToY(i);
      ctx.fillText(i.toString(), area.x - 10, y);
    }

    // Stage names
    ctx.font = "10px system-ui";
    ctx.fillStyle = "#666";
    for (let i = 0; i < numStages; i++) {
      const y = rewardToY(i + 0.5);
      const name = stageNames[i] || `Stage ${i}`;
      const shortName = name.length > 20 ? `${name.substring(0, 18)}...` : name;
      ctx.save();
      ctx.translate(15, y);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(shortName, 0, 0);
      ctx.restore();
    }

    // X-axis labels
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#a0a0a0";
    ctx.font = "12px system-ui";
    const numTicks = 10;
    for (let i = 0; i <= numTicks; i++) {
      const time = (i / numTicks) * duration;
      const x = timeToX(time);
      ctx.fillText(`${time.toFixed(1)}s`, x, area.y + area.height + 10);
    }

    // Axis labels
    ctx.font = "13px system-ui";
    ctx.fillStyle = "#888";
    ctx.textAlign = "center";
    ctx.fillText("Time (s)", area.x + area.width / 2, canvas.height - 10);

    ctx.save();
    ctx.translate(12, area.y + area.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Reward", 0, 0);
    ctx.restore();

    // Draw fitted curve
    if (denseRewards.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 2.5;

      for (let i = 0; i < denseRewards.length; i++) {
        const time = i / fps;
        const x = timeToX(time);
        const y = rewardToY(denseRewards[i]);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Draw time indicator
    const timeX = timeToX(currentTime);
    ctx.strokeStyle = "rgba(255, 107, 107, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(timeX, area.y);
    ctx.lineTo(timeX, area.y + area.height);
    ctx.stroke();

    // Draw control points
    controlPoints.forEach((point, index) => {
      const x = timeToX(point.time);
      const y = rewardToY(point.reward);
      const isStep = point.type === "step";

      // Point shadow
      ctx.beginPath();
      if (isStep) {
        ctx.moveTo(x, y - 12);
        ctx.lineTo(x + 10, y);
        ctx.lineTo(x, y + 12);
        ctx.lineTo(x - 10, y);
        ctx.closePath();
      } else {
        ctx.arc(x, y, 10, 0, Math.PI * 2);
      }
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fill();

      // Point
      ctx.beginPath();
      if (isStep) {
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x + 8, y);
        ctx.lineTo(x, y + 10);
        ctx.lineTo(x - 8, y);
        ctx.closePath();
      } else {
        ctx.arc(x, y, 8, 0, Math.PI * 2);
      }
      ctx.fillStyle = index === selectedPointIndex ? "#4ade80" : isStep ? "#fbbf24" : "#e94560";
      ctx.fill();

      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Point label
      ctx.fillStyle = isStep ? "#1a1a2e" : "white";
      ctx.font = "bold 10px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(isStep ? "S" : (index + 1).toString(), x, y);

      // Step indicator line
      if (isStep && index > 0) {
        const prevPoint = controlPoints[index - 1];
        const prevY = rewardToY(prevPoint.reward);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, prevY);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  }, [
    controlPoints,
    denseRewards,
    selectedPointIndex,
    currentTime,
    numStages,
    stageNames,
    duration,
    fps,
    getPlotArea,
    timeToX,
    rewardToY,
  ]);

  // Resize canvas
  useEffect(() => {
    const resizeCanvas = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      canvas.width = container.clientWidth;
      canvas.height = 400;
      drawCanvas();
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [drawCanvas]);

  // Redraw when state changes
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // Find point at position
  const findPointAt = useCallback(
    (x, y, threshold = 15) => {
      for (let i = controlPoints.length - 1; i >= 0; i--) {
        const px = timeToX(controlPoints[i].time);
        const py = rewardToY(controlPoints[i].reward);
        const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
        if (dist < threshold) {
          return i;
        }
      }
      return -1;
    },
    [controlPoints, timeToX, rewardToY],
  );

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const area = getPlotArea();

      if (x < area.x || x > area.x + area.width || y < area.y || y > area.y + area.height) {
        return;
      }

      const pointIndex = findPointAt(x, y);

      if (pointIndex >= 0) {
        saveStateForUndo();
        setSelectedPointIndex(pointIndex);
        setDraggingPoint(true);
      } else {
        // Open modal to add new point
        const clickedTime = xToTime(x);
        const clickedReward = yToReward(y);
        openAddPointModal(clickedTime, clickedReward);
      }
    },
    [findPointAt, getPlotArea, saveStateForUndo, xToTime, yToReward],
  );

  const handleMouseMove = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const area = getPlotArea();

      // Update current time
      if (x >= area.x && x <= area.x + area.width) {
        setCurrentTime(xToTime(x));
      }

      // Handle dragging
      if (draggingPoint && selectedPointIndex >= 0) {
        const y = e.clientY - rect.top;
        const newPoints = [...controlPoints];
        newPoints[selectedPointIndex] = {
          ...newPoints[selectedPointIndex],
          time: xToTime(x),
          reward: yToReward(y),
        };
        newPoints.sort((a, b) => a.time - b.time);
        setControlPoints(newPoints);
        setDenseRewards([]);
      }
    },
    [controlPoints, draggingPoint, selectedPointIndex, getPlotArea, xToTime, yToReward],
  );

  const handleMouseUp = useCallback(() => {
    setDraggingPoint(false);
  }, []);

  const handleDoubleClick = useCallback(
    (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const pointIndex = findPointAt(x, y);
      if (pointIndex >= 0) {
        saveStateForUndo();
        const newPoints = [...controlPoints];
        newPoints.splice(pointIndex, 1);
        setControlPoints(newPoints);
        setSelectedPointIndex(-1);
        setDenseRewards([]);
      }
    },
    [controlPoints, findPointAt, saveStateForUndo],
  );

  // Open add point modal
  const openAddPointModal = useCallback((time, reward) => {
    setEditingPoint({ time, reward, type: "normal" });
    setIsAddingNewPoint(true);
    setIsEditModalOpen(true);
  }, []);

  // Open edit point modal
  const openEditModal = useCallback(
    (index) => {
      if (index < 0 || index >= controlPoints.length) return;
      setEditingPoint({ ...controlPoints[index] });
      setSelectedPointIndex(index);
      setIsAddingNewPoint(false);
      setIsEditModalOpen(true);
    },
    [controlPoints],
  );

  // Apply edit
  const applyEdit = useCallback(() => {
    if (!editingPoint) return;

    saveStateForUndo();
    const clampedTime = clamp(editingPoint.time, 0, duration);
    const clampedReward = clamp(editingPoint.reward, 0, numStages);

    const newPoints = [...controlPoints];

    if (isAddingNewPoint) {
      newPoints.push({ time: clampedTime, reward: clampedReward, type: editingPoint.type || "normal" });
    } else if (selectedPointIndex >= 0) {
      newPoints[selectedPointIndex] = {
        time: clampedTime,
        reward: clampedReward,
        type: editingPoint.type || "normal",
      };
    }

    newPoints.sort((a, b) => a.time - b.time);
    setControlPoints(newPoints);
    setDenseRewards([]);
    setIsEditModalOpen(false);
    setEditingPoint(null);
    setIsAddingNewPoint(false);
  }, [controlPoints, duration, editingPoint, isAddingNewPoint, numStages, saveStateForUndo, selectedPointIndex]);

  // Delete selected point
  const deleteSelectedPoint = useCallback(() => {
    if (selectedPointIndex < 0) return;
    saveStateForUndo();
    const newPoints = [...controlPoints];
    newPoints.splice(selectedPointIndex, 1);
    setControlPoints(newPoints);
    setSelectedPointIndex(-1);
    setDenseRewards([]);
    setIsEditModalOpen(false);
  }, [controlPoints, saveStateForUndo, selectedPointIndex]);

  // Toggle step type
  const toggleStepType = useCallback(() => {
    if (selectedPointIndex < 0) return;
    saveStateForUndo();
    const newPoints = [...controlPoints];
    newPoints[selectedPointIndex] = {
      ...newPoints[selectedPointIndex],
      type: newPoints[selectedPointIndex].type === "step" ? "normal" : "step",
    };
    setControlPoints(newPoints);
    setDenseRewards([]);
  }, [controlPoints, saveStateForUndo, selectedPointIndex]);

  // Clear all
  const clearAll = useCallback(() => {
    if (window.confirm("Clear all control points?")) {
      saveStateForUndo();
      setControlPoints([]);
      setDenseRewards([]);
      setSelectedPointIndex(-1);
    }
  }, [saveStateForUndo]);

  // Save annotation
  const saveAnnotation = useCallback(() => {
    // Get or create region
    const annotation = item?.annotation;
    if (!annotation) return;

    // Create result value
    const result = {
      from_name: item.name,
      to_name: item.toname,
      type: "videorewardannotation",
      value: {
        controlPoints,
        denseRewards,
        fitMethod,
        numStages,
        duration,
      },
    };

    // Add to annotation
    annotation.addResult(result);
  }, [item, controlPoints, denseRewards, fitMethod, numStages, duration]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't handle if input is focused
      if (document.activeElement?.tagName === "INPUT") {
        if (e.key === "Escape" && isEditModalOpen) {
          setIsEditModalOpen(false);
        }
        if (e.key === "Enter" && isEditModalOpen) {
          e.preventDefault();
          applyEdit();
        }
        return;
      }

      // Cmd/Ctrl + S to save
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveAnnotation();
        return;
      }

      // Cmd/Ctrl + Z to undo
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Cmd/Ctrl + Shift + Z to redo
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }

      // S to toggle step type
      if (e.key === "s" && selectedPointIndex >= 0) {
        e.preventDefault();
        toggleStepType();
        return;
      }

      // R to toggle rubric
      if (e.key === "r") {
        e.preventDefault();
        setShowRubricPanel((prev) => !prev);
        return;
      }

      // Delete to remove selected point
      if ((e.key === "Delete" || e.key === "Backspace") && selectedPointIndex >= 0) {
        e.preventDefault();
        deleteSelectedPoint();
        return;
      }

      // Escape to close modal or deselect
      if (e.key === "Escape") {
        if (showRubricPanel) {
          setShowRubricPanel(false);
        } else if (isEditModalOpen) {
          setIsEditModalOpen(false);
        } else if (selectedPointIndex >= 0) {
          setSelectedPointIndex(-1);
        } else {
          onClose();
        }
        return;
      }

      // Enter to add point at current time
      if (e.key === "Enter" && !isEditModalOpen) {
        e.preventDefault();
        let defaultReward = 0;
        if (denseRewards.length > 0) {
          const frameIdx = Math.min(Math.floor(currentTime * fps), denseRewards.length - 1);
          defaultReward = denseRewards[frameIdx];
        }
        openAddPointModal(currentTime, defaultReward);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    applyEdit,
    currentTime,
    deleteSelectedPoint,
    denseRewards,
    fps,
    isEditModalOpen,
    onClose,
    openAddPointModal,
    redo,
    saveAnnotation,
    selectedPointIndex,
    showRubricPanel,
    toggleStepType,
    undo,
  ]);

  // Render rubric
  const renderRubric = () => {
    if (!rubric || rubric.length === 0) {
      return <p className="reward-modal__rubric-empty">No rubric available for this task.</p>;
    }

    return rubric.map((stage, idx) => (
      <div key={idx} className="reward-modal__rubric-stage">
        <h4>{stage.title || `Stage ${stage.stage}`}</h4>
        {stage.note && <div className="reward-modal__rubric-note">{stage.note}</div>}
        <table className="reward-modal__rubric-table">
          <thead>
            <tr>
              <th>Score</th>
              <th>Criteria</th>
            </tr>
          </thead>
          <tbody>
            {stage.criteria?.map((c, i) => (
              <tr key={i}>
                <td className="reward-modal__rubric-score">{c.score.toFixed(2)}</td>
                <td>{c.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ));
  };

  // Modal content
  const modalContent = (
    <div 
      className="reward-modal__overlay" 
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        zIndex: 10000,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px'
      }}
    >
      <div className="reward-modal" style={{ zIndex: 10001 }}>
        <div className="reward-modal__header">
          <h2>Reward Curve Annotation</h2>
          <div className="reward-modal__header-info">
            <span>Duration: {duration.toFixed(1)}s</span>
            <span>|</span>
            <span>Stages: {numStages}</span>
            <span>|</span>
            <span>Current: {currentTime.toFixed(2)}s</span>
            <button type="button" className="reward-modal__btn reward-modal__btn--rubric" onClick={() => setShowRubricPanel(true)}>
              Rubric
            </button>
            <button type="button" className="reward-modal__btn reward-modal__btn--close" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="reward-modal__content">
          <div className="reward-modal__canvas-section">
            <div className="reward-modal__canvas-container" ref={containerRef}>
              <canvas
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onDoubleClick={handleDoubleClick}
              />
            </div>
            <div className="reward-modal__legend">
              <div className="reward-modal__legend-item">
                <span className="reward-modal__legend-dot" />
                <span>Normal Point</span>
              </div>
              <div className="reward-modal__legend-item">
                <span className="reward-modal__legend-dot reward-modal__legend-dot--step" />
                <span>Step Point</span>
              </div>
              <div className="reward-modal__legend-item">
                <span className="reward-modal__legend-line" />
                <span>Fitted Curve</span>
              </div>
              <div className="reward-modal__legend-item">
                <span>Double-click to delete | S to toggle step</span>
              </div>
            </div>
          </div>

          <div className="reward-modal__controls">
            <div className="reward-modal__card">
              <h3>Curve Fitting</h3>
              <select
                value={fitMethod}
                onChange={(e) => setFitMethod(e.target.value)}
                className="reward-modal__select"
              >
                <option value="pchip">PCHIP (Recommended)</option>
                <option value="linear">Linear</option>
                <option value="cubic">Cubic Spline</option>
              </select>
              <label className="reward-modal__checkbox-label">
                <input type="checkbox" checked={autoFit} onChange={(e) => setAutoFit(e.target.checked)} />
                <span>Auto-fit on change</span>
              </label>
              <div className="reward-modal__toolbar">
                <button type="button" className="reward-modal__btn reward-modal__btn--primary" onClick={doFitCurve}>
                  Fit Curve
                </button>
                <button type="button" className="reward-modal__btn reward-modal__btn--secondary" onClick={clearAll}>
                  Clear All
                </button>
              </div>
            </div>

            <div className="reward-modal__card">
              <h3>Save / Load</h3>
              <div className="reward-modal__toolbar">
                <button type="button" className="reward-modal__btn reward-modal__btn--success" onClick={saveAnnotation}>
                  Save
                </button>
                <button type="button" className="reward-modal__btn reward-modal__btn--secondary" onClick={undo}>
                  Undo
                </button>
                <button type="button" className="reward-modal__btn reward-modal__btn--secondary" onClick={redo}>
                  Redo
                </button>
              </div>
            </div>

            <div className="reward-modal__card">
              <h3>Control Points ({controlPoints.length})</h3>
              <div className="reward-modal__points-table">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Time</th>
                      <th>Reward</th>
                      <th>Type</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {controlPoints.map((point, index) => (
                      <tr
                        key={index}
                        className={index === selectedPointIndex ? "selected" : ""}
                        onClick={() => setSelectedPointIndex(index)}
                      >
                        <td>{index + 1}</td>
                        <td>{point.time.toFixed(2)}</td>
                        <td>{point.reward.toFixed(2)}</td>
                        <td>{point.type === "step" ? "STEP" : "Normal"}</td>
                        <td>
                          <button
                            type="button"
                            className="reward-modal__btn reward-modal__btn--sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(index);
                            }}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="reward-modal__shortcuts">
              <kbd>Ctrl+S</kbd> Save <kbd>Ctrl+Z</kbd> Undo <kbd>S</kbd> Toggle Step <kbd>R</kbd> Rubric <kbd>Enter</kbd>{" "}
              Add Point <kbd>Del</kbd> Delete <kbd>Esc</kbd> Close
            </div>
          </div>
        </div>

        {/* Edit Point Modal */}
        {isEditModalOpen && (
          <div className="reward-modal__edit-overlay" onClick={(e) => e.target === e.currentTarget && setIsEditModalOpen(false)}>
            <div className="reward-modal__edit-modal">
              <div className="reward-modal__edit-content">
                <div className="reward-modal__edit-form">
                  <h3>{isAddingNewPoint ? "Add Control Point" : "Edit Control Point"}</h3>
                  <div className="reward-modal__form-group">
                    <label>Reward</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={numStages}
                      value={editingPoint?.reward ?? 0}
                      onChange={(e) =>
                        setEditingPoint((prev) => (prev ? { ...prev, reward: Number.parseFloat(e.target.value) || 0 } : null))
                      }
                      autoFocus
                    />
                  </div>
                  <div className="reward-modal__form-group">
                    <label>Time (seconds)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={duration}
                      value={editingPoint?.time ?? 0}
                      onChange={(e) =>
                        setEditingPoint((prev) => (prev ? { ...prev, time: Number.parseFloat(e.target.value) || 0 } : null))
                      }
                    />
                  </div>
                  <div className="reward-modal__form-group">
                    <label className="reward-modal__checkbox-label">
                      <input
                        type="checkbox"
                        checked={editingPoint?.type === "step"}
                        onChange={(e) =>
                          setEditingPoint((prev) => (prev ? { ...prev, type: e.target.checked ? "step" : "normal" } : null))
                        }
                      />
                      <span>Step Transition</span>
                    </label>
                  </div>
                  <div className="reward-modal__edit-actions">
                    <button type="button" className="reward-modal__btn reward-modal__btn--primary" onClick={applyEdit}>
                      Apply
                    </button>
                    <button
                      type="button"
                      className="reward-modal__btn reward-modal__btn--secondary"
                      onClick={() => setIsEditModalOpen(false)}
                    >
                      Cancel
                    </button>
                    {!isAddingNewPoint && (
                      <button type="button" className="reward-modal__btn reward-modal__btn--danger" onClick={deleteSelectedPoint}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                <div className="reward-modal__edit-rubric">
                  <h3>Scoring Rubric</h3>
                  {renderRubric()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Rubric Panel */}
        {showRubricPanel && (
          <div
            className="reward-modal__rubric-overlay"
            onClick={(e) => e.target === e.currentTarget && setShowRubricPanel(false)}
          >
            <div className="reward-modal__rubric-panel">
              <div className="reward-modal__rubric-header">
                <h2>Scoring Rubric</h2>
                <button type="button" className="reward-modal__rubric-close" onClick={() => setShowRubricPanel(false)}>
                  X
                </button>
              </div>
              <div className="reward-modal__rubric-content">{renderRubric()}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
});

export default RewardAnnotationModal;
