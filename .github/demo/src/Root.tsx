import React from "react";
import { Composition } from "remotion";
import { Demo, DEMO_FPS, demoDurationInFrames } from "./Demo";

/**
 * One composition: the README demo. 1440x900 is the capture size of the raw
 * frames (public/raw/*.png, taken with Playwright against a real gateway); the
 * GIF step scales it down.
 */
export const Root: React.FC = () => (
  <Composition
    id="Demo"
    component={Demo}
    width={1440}
    height={900}
    fps={DEMO_FPS}
    durationInFrames={demoDurationInFrames()}
  />
);
