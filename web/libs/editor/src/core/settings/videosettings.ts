import type { SettingsProperties } from "./types";

export default {
  videoDrawOutside: {
    description: "Allow drawing outside of video boundaries",
    defaultValue: false,
    type: "boolean",
  },
  videoHopSize: {
    description: "Video hop size",
    defaultValue: 1,
    type: "number",
  },
} as SettingsProperties;
