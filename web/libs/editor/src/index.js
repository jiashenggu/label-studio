import "./core/feature-flags";
import "./assets/styles/global.scss";
import { LabelStudio } from "./LabelStudio";

// Suppress ResizeObserver loop errors - this is a known benign browser issue
// that occurs when resize callbacks trigger layout changes.
// See: https://github.com/WICG/resize-observer/issues/38
// This error doesn't affect functionality but clutters the console/error overlay.
if (typeof window !== "undefined") {
  const originalError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    if (typeof message === "string" && message.includes("ResizeObserver loop")) {
      return true; // Suppress the error
    }
    if (originalError) {
      return originalError(message, source, lineno, colno, error);
    }
    return false;
  };

  // Also handle unhandledrejection for Promise-based errors
  window.addEventListener("error", (event) => {
    if (event.message?.includes?.("ResizeObserver loop")) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  });
}

window.LabelStudio = LabelStudio;

export default LabelStudio;

export { LabelStudio };
