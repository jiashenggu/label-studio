/**
 * Curve fitting utilities for reward annotation.
 * Implements various interpolation methods for creating smooth reward curves
 * from sparse control points.
 */

/**
 * Linear interpolation between two values
 * @param {number} x0 - Start x
 * @param {number} y0 - Start y
 * @param {number} x1 - End x
 * @param {number} y1 - End y
 * @param {number} x - Target x
 * @returns {number} Interpolated y value
 */
function lerp(x0, y0, x1, y1, x) {
  if (x1 === x0) return y0;
  const t = (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/**
 * Linear interpolation for the entire curve
 * @param {Array} controlPoints - Array of {time, reward, type} objects
 * @param {number} duration - Total duration in seconds
 * @param {number} fps - Frames per second
 * @returns {Array} Dense reward values for each frame
 */
export function linearInterpolation(controlPoints, duration, fps = 30) {
  if (!controlPoints || controlPoints.length === 0) {
    return [];
  }

  const numFrames = Math.ceil(duration * fps);
  const denseRewards = new Array(numFrames).fill(0);
  const sortedPoints = [...controlPoints].sort((a, b) => a.time - b.time);

  for (let i = 0; i < numFrames; i++) {
    const time = i / fps;
    denseRewards[i] = interpolateAt(sortedPoints, time);
  }

  return denseRewards;
}

/**
 * Interpolate reward value at a specific time
 * @param {Array} sortedPoints - Sorted control points
 * @param {number} time - Time in seconds
 * @returns {number} Interpolated reward value
 */
function interpolateAt(sortedPoints, time) {
  if (sortedPoints.length === 0) return 0;
  if (sortedPoints.length === 1) return sortedPoints[0].reward;

  // Find surrounding points
  let prevPoint = null;
  let nextPoint = null;

  for (let i = 0; i < sortedPoints.length; i++) {
    const point = sortedPoints[i];
    if (point.time <= time) {
      prevPoint = point;
    }
    if (point.time >= time && nextPoint === null) {
      nextPoint = point;
    }
  }

  // Handle edge cases
  if (!prevPoint) return nextPoint.reward;
  if (!nextPoint) return prevPoint.reward;
  if (prevPoint === nextPoint) return prevPoint.reward;

  // Handle step transitions
  // If prevPoint is a step, we've already reached the transition - return its value
  if (prevPoint.type === "step") {
    return prevPoint.reward;
  }
  
  // If nextPoint is a step, hold the previous value until we reach the step point
  if (nextPoint.type === "step") {
    return prevPoint.reward;
  }

  // Linear interpolation for normal points
  return lerp(prevPoint.time, prevPoint.reward, nextPoint.time, nextPoint.reward, time);
}

/**
 * PCHIP (Piecewise Cubic Hermite Interpolating Polynomial) interpolation.
 * This method preserves monotonicity and prevents overshooting.
 * @param {Array} controlPoints - Array of {time, reward, type} objects
 * @param {number} duration - Total duration in seconds
 * @param {number} fps - Frames per second
 * @returns {Array} Dense reward values for each frame
 */
export function pchipInterpolation(controlPoints, duration, fps = 30) {
  if (!controlPoints || controlPoints.length === 0) {
    return [];
  }

  const numFrames = Math.ceil(duration * fps);
  const sortedPoints = [...controlPoints].sort((a, b) => a.time - b.time);

  if (sortedPoints.length === 1) {
    return new Array(numFrames).fill(sortedPoints[0].reward);
  }

  // Separate step and normal points for proper handling
  const segments = buildSegments(sortedPoints);
  const denseRewards = new Array(numFrames).fill(0);

  for (let i = 0; i < numFrames; i++) {
    const time = i / fps;
    denseRewards[i] = pchipInterpolateAt(segments, sortedPoints, time);
  }

  return denseRewards;
}

/**
 * Build segments for PCHIP interpolation, handling step transitions
 * @param {Array} sortedPoints - Sorted control points
 * @returns {Array} Array of segment data
 */
function buildSegments(sortedPoints) {
  const segments = [];
  let currentSegment = [];

  for (let i = 0; i < sortedPoints.length; i++) {
    const point = sortedPoints[i];

    if (point.type === "step" && currentSegment.length > 0) {
      // End current segment before step point
      segments.push({
        points: [...currentSegment],
        derivatives: computeDerivatives(currentSegment),
      });
      currentSegment = [point];
    } else {
      currentSegment.push(point);
    }
  }

  if (currentSegment.length > 0) {
    segments.push({
      points: currentSegment,
      derivatives: computeDerivatives(currentSegment),
    });
  }

  return segments;
}

/**
 * Compute PCHIP derivatives for a set of points
 * @param {Array} points - Control points
 * @returns {Array} Derivatives at each point
 */
function computeDerivatives(points) {
  if (points.length < 2) return [0];

  const n = points.length;
  const h = [];
  const delta = [];

  // Compute intervals and slopes
  for (let i = 0; i < n - 1; i++) {
    h.push(points[i + 1].time - points[i].time);
    delta.push((points[i + 1].reward - points[i].reward) / (h[i] || 1));
  }

  const derivatives = new Array(n).fill(0);

  // End point derivatives
  derivatives[0] = delta[0];
  derivatives[n - 1] = delta[n - 2];

  // Interior derivatives using PCHIP formula
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      // Different signs or zero - set derivative to 0
      derivatives[i] = 0;
    } else {
      // Weighted harmonic mean
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      derivatives[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  return derivatives;
}

/**
 * Interpolate at a specific time using PCHIP with segments
 * @param {Array} segments - Array of segment data
 * @param {Array} sortedPoints - Original sorted points for step handling
 * @param {number} time - Time in seconds
 * @returns {number} Interpolated reward value
 */
function pchipInterpolateAt(segments, sortedPoints, time) {
  // Find the appropriate segment
  let segmentIndex = -1;
  let pointInSegment = -1;

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s];
    const segStartTime = segment.points[0].time;
    let segEndTime;
    
    if (s < segments.length - 1) {
      // Segment ends at the start of next segment (exclusive)
      segEndTime = segments[s + 1].points[0].time;
    } else {
      // Last segment extends to infinity
      segEndTime = Number.POSITIVE_INFINITY;
    }

    // Check if time falls within this segment's range
    if (time >= segStartTime && (s === segments.length - 1 ? time >= segStartTime : time < segEndTime)) {
      segmentIndex = s;
      // Find the interval within the segment
      for (let i = 0; i < segment.points.length - 1; i++) {
        if (time >= segment.points[i].time && time <= segment.points[i + 1].time) {
          pointInSegment = i;
          break;
        }
      }
      break;
    }
  }

  // Before first segment
  if (segmentIndex === -1 && time < segments[0].points[0].time) {
    return segments[0].points[0].reward;
  }

  // After last segment
  if (segmentIndex === -1) {
    const lastSegment = segments[segments.length - 1];
    return lastSegment.points[lastSegment.points.length - 1].reward;
  }

  const segment = segments[segmentIndex];

  // Handle step transitions between segments
  if (segmentIndex > 0) {
    const prevSegment = segments[segmentIndex - 1];
    const prevLastTime = prevSegment.points[prevSegment.points.length - 1].time;
    const currFirstTime = segment.points[0].time;

    // Check if we're in the gap before a step
    if (time > prevLastTime && time < currFirstTime) {
      return prevSegment.points[prevSegment.points.length - 1].reward;
    }
  }

  if (pointInSegment === -1) {
    // At segment boundary
    if (time <= segment.points[0].time) {
      return segment.points[0].reward;
    }
    return segment.points[segment.points.length - 1].reward;
  }

  // Cubic Hermite interpolation
  const p0 = segment.points[pointInSegment];
  const p1 = segment.points[pointInSegment + 1];
  const d0 = segment.derivatives[pointInSegment];
  const d1 = segment.derivatives[pointInSegment + 1];

  const h = p1.time - p0.time;
  if (h === 0) return p0.reward;

  const t = (time - p0.time) / h;
  const t2 = t * t;
  const t3 = t2 * t;

  // Hermite basis functions
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * p0.reward + h10 * h * d0 + h01 * p1.reward + h11 * h * d1;
}

/**
 * Cubic spline interpolation
 * @param {Array} controlPoints - Array of {time, reward, type} objects
 * @param {number} duration - Total duration in seconds
 * @param {number} fps - Frames per second
 * @returns {Array} Dense reward values for each frame
 */
export function cubicInterpolation(controlPoints, duration, fps = 30) {
  if (!controlPoints || controlPoints.length === 0) {
    return [];
  }

  const numFrames = Math.ceil(duration * fps);
  const sortedPoints = [...controlPoints].sort((a, b) => a.time - b.time);

  if (sortedPoints.length === 1) {
    return new Array(numFrames).fill(sortedPoints[0].reward);
  }

  if (sortedPoints.length === 2) {
    return linearInterpolation(controlPoints, duration, fps);
  }

  // Build natural cubic spline
  const spline = buildNaturalCubicSpline(sortedPoints);
  const denseRewards = new Array(numFrames).fill(0);

  for (let i = 0; i < numFrames; i++) {
    const time = i / fps;
    denseRewards[i] = evaluateCubicSpline(spline, sortedPoints, time);
  }

  return denseRewards;
}

/**
 * Build natural cubic spline coefficients
 * @param {Array} points - Sorted control points
 * @returns {Object} Spline coefficients
 */
function buildNaturalCubicSpline(points) {
  const n = points.length - 1;
  const h = [];
  const alpha = [];

  for (let i = 0; i < n; i++) {
    h.push(points[i + 1].time - points[i].time);
  }

  for (let i = 1; i < n; i++) {
    alpha.push(
      (3 / h[i]) * (points[i + 1].reward - points[i].reward) - (3 / h[i - 1]) * (points[i].reward - points[i - 1].reward),
    );
  }

  // Solve tridiagonal system
  const l = [1];
  const mu = [0];
  const z = [0];

  for (let i = 1; i < n; i++) {
    l.push(2 * (points[i + 1].time - points[i - 1].time) - h[i - 1] * mu[i - 1]);
    mu.push(h[i] / l[i]);
    z.push((alpha[i - 1] - h[i - 1] * z[i - 1]) / l[i]);
  }

  const c = new Array(n + 1).fill(0);
  const b = new Array(n).fill(0);
  const d = new Array(n).fill(0);

  for (let j = n - 1; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (points[j + 1].reward - points[j].reward) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }

  return { b, c, d };
}

/**
 * Evaluate cubic spline at a specific time
 * @param {Object} spline - Spline coefficients
 * @param {Array} points - Sorted control points
 * @param {number} time - Time in seconds
 * @returns {number} Interpolated value
 */
function evaluateCubicSpline(spline, points, time) {
  const n = points.length - 1;

  // Handle step transitions
  for (let i = 1; i <= n; i++) {
    // If current point is a step point
    if (points[i].type === "step") {
      // Before the step: hold previous value
      if (time >= points[i - 1].time && time < points[i].time) {
        return points[i - 1].reward;
      }
      // At or after the step: use step value
      if (time >= points[i].time && (i === n || time < points[i + 1].time)) {
        return points[i].reward;
      }
    }
  }

  // Find interval
  let i = 0;
  for (i = 0; i < n; i++) {
    if (time >= points[i].time && time <= points[i + 1].time) {
      break;
    }
  }

  if (i >= n) return points[n].reward;

  const dx = time - points[i].time;
  return points[i].reward + spline.b[i] * dx + spline.c[i] * dx * dx + spline.d[i] * dx * dx * dx;
}

/**
 * Main curve fitting function that dispatches to the appropriate method
 * @param {Array} controlPoints - Array of {time, reward, type} objects
 * @param {number} duration - Total duration in seconds
 * @param {number} fps - Frames per second
 * @param {string} method - 'linear', 'pchip', 'cubic', or 'akima'
 * @returns {Array} Dense reward values for each frame
 */
export function fitCurve(controlPoints, duration, fps = 30, method = "pchip") {
  if (!controlPoints || controlPoints.length === 0) {
    return [];
  }

  // Sort points by time
  const sortedPoints = [...controlPoints].sort((a, b) => a.time - b.time);

  switch (method) {
    case "linear":
      return linearInterpolation(sortedPoints, duration, fps);
    case "pchip":
      return pchipInterpolation(sortedPoints, duration, fps);
    case "cubic":
      return cubicInterpolation(sortedPoints, duration, fps);
    case "akima":
      // Akima uses a similar approach to PCHIP but with different derivative calculation
      // For simplicity, we'll use PCHIP as a fallback
      return pchipInterpolation(sortedPoints, duration, fps);
    default:
      return pchipInterpolation(sortedPoints, duration, fps);
  }
}

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
