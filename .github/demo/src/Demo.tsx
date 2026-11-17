import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

/** Frames per second of the composition; the GIF keeps this rate. */
export const DEMO_FPS = 12;

/** How long two neighbouring scenes overlap in a crossfade, in seconds. */
const FADE_SECONDS = 0.35;

/** Where a scene's slow zoom heads: a point (0..1 of width/height) and the end scale. */
type Zoom = { x: number; y: number; scale: number };

type Scene = {
  kind: "card" | "shot";
  /** public/raw/<src> for a shot. */
  src?: string;
  title: string;
  sub?: string;
  /** A shell line typed on a card. */
  command?: string;
  zoom?: Zoom;
  seconds: number;
};

/**
 * The storyboard. Every shot is a real frame of the mod on a real gateway
 * (capture notes in README.md of this directory); the captions are the README's
 * own phrases so the GIF and the text say the same thing.
 */
export const SCENES: Scene[] = [
  {
    kind: "card",
    title: "KiroCrew IDE",
    sub: "A full VS Code workbench inside your KiroCrew dashboard",
    command: "floofy install kirocrew-ide",
    seconds: 3.2,
  },
  {
    kind: "shot",
    src: "01-app-idle.png",
    title: "Apps → KiroCrew IDE",
    sub: "Pick a folder, press Start. One port: the dashboard's own.",
    zoom: { x: 0.82, y: 0.07, scale: 1.08 },
    seconds: 2.8,
  },
  {
    kind: "shot",
    src: "02-workbench-editor.png",
    title: "VS Code, docked in the dashboard",
    sub: "openvscode-server served same-origin at /kirocrew-ide — nothing extra to tunnel",
    zoom: { x: 0.5, y: 0.45, scale: 1.04 },
    seconds: 3.0,
  },
  {
    kind: "shot",
    src: "09-chat-reply.png",
    title: "KiroCrew chat in the editor",
    sub: "Any crew agent, steering receipt, tool calls, paths as links. Sessions run in the gateway.",
    zoom: { x: 0.9, y: 0.45, scale: 1.12 },
    seconds: 3.4,
  },
  {
    kind: "shot",
    src: "04-specs-tasks.png",
    title: "Spec coding like Kiro",
    sub: "Requirements → design → tasks, rendered with Start task on every open row",
    zoom: { x: 0.55, y: 0.5, scale: 1.08 },
    seconds: 3.0,
  },
  {
    kind: "shot",
    src: "10-task-running.png",
    title: "Start task",
    sub: "The Spec agent runs it in the gateway, Autopilot on; the lens turns to In progress",
    zoom: { x: 0.75, y: 0.55, scale: 1.1 },
    seconds: 3.0,
  },
  {
    kind: "shot",
    src: "11-task-done.png",
    title: "Done, written back to tasks.md",
    sub: "[x] on the row, the workspace moves from 53 % to 59 %, follow-ups offered",
    zoom: { x: 0.5, y: 0.08, scale: 1.12 },
    seconds: 3.2,
  },
  {
    kind: "shot",
    src: "03-donut-breakdown.png",
    title: "Task progress per workspace",
    sub: "Every box in .kiro/specs/*/tasks.md, one donut, a breakdown per spec",
    zoom: { x: 0.82, y: 0.22, scale: 1.3 },
    seconds: 3.0,
  },
  {
    kind: "shot",
    src: "05-folder-picker.png",
    title: "Open another folder",
    sub: "The dashboard's own Recent / Browse picker, without leaving the IDE",
    zoom: { x: 0.6, y: 0.25, scale: 1.12 },
    seconds: 2.6,
  },
  {
    kind: "shot",
    src: "06-two-workspaces.png",
    title: "Several workspaces, one engine",
    sub: "A tab row like a browser's, each tab with its own progress; idle workspaces sleep",
    zoom: { x: 0.3, y: 0.1, scale: 1.18 },
    seconds: 3.0,
  },
  {
    kind: "shot",
    src: "08-workspace-menu.png",
    title: "Fullscreen, still one window",
    sub: "◁ back to KiroCrew, the host switcher, the workspace manager",
    zoom: { x: 0.35, y: 0.1, scale: 1.14 },
    seconds: 3.0,
  },
  {
    kind: "card",
    title: "github.com/floofycrew/kirocrew-ide",
    sub: "A FloofyCrew mod · MIT · unofficial, not affiliated with Kiro or KiroCrew",
    command: "floofy install kirocrew-ide",
    seconds: 3.0,
  },
];

const fadeFrames = () => Math.round(FADE_SECONDS * DEMO_FPS);

/** Total length: the scenes back to back, minus the overlaps. */
export const demoDurationInFrames = () => {
  const total = SCENES.reduce((n, s) => n + Math.round(s.seconds * DEMO_FPS), 0);
  return total - fadeFrames() * (SCENES.length - 1);
};

const FONT = "'Inter', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif";
const MONO = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";
const INK = "#2d2d34";
const CORAL = "#ff6b4a";

const Caption: React.FC<{ title: string; sub?: string; frame: number; fps: number }> = ({ title, sub, frame, fps }) => {
  const t = interpolate(frame, [0, 0.45 * fps], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <div
      style={{
        position: "absolute",
        left: 48,
        bottom: 44,
        maxWidth: 820,
        padding: "18px 24px 20px",
        background: "rgba(45, 45, 52, 0.92)",
        color: "#fff",
        borderRadius: 6,
        fontFamily: FONT,
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
        opacity: t,
        transform: `translateY(${(1 - t) * 18}px)`,
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.3, lineHeight: 1.15 }}>{title}</div>
      {sub ? <div style={{ fontSize: 21, marginTop: 8, color: "#e8e8ec", lineHeight: 1.3 }}>{sub}</div> : null}
    </div>
  );
};

const Shot: React.FC<{ scene: Scene; durationInFrames: number }> = ({ scene, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = scene.zoom ?? { x: 0.5, y: 0.5, scale: 1 };
  // The zoom settles within the first 0.7 s and then HOLDS: a GIF stores only the
  // pixels that change between frames, so a scene that keeps drifting costs a
  // full frame per tick while a held scene costs nothing after the caption lands.
  const scale = interpolate(frame, [0, 0.7 * fps], [1, z.scale], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  void durationInFrames;
  return (
    <AbsoluteFill style={{ background: "#f6f6f8", overflow: "hidden" }}>
      <Img
        src={staticFile(`raw/${scene.src}`)}
        style={{
          width: "100%",
          height: "100%",
          transform: `scale(${scale})`,
          transformOrigin: `${z.x * 100}% ${z.y * 100}%`,
        }}
      />
      <Caption title={scene.title} sub={scene.sub} frame={frame} fps={fps} />
    </AbsoluteFill>
  );
};

const Typed: React.FC<{ text: string; frame: number; fps: number; start: number }> = ({ text, frame, fps, start }) => {
  const perChar = 0.045 * fps;
  const shown = Math.max(0, Math.min(text.length, Math.floor((frame - start) / perChar)));
  const caret = Math.floor(frame / (fps / 2)) % 2 === 0;
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 34,
        color: "#f4f4f6",
        background: "#1c1c21",
        border: "1px solid #44444c",
        borderRadius: 6,
        padding: "18px 28px",
        minWidth: 700,
        textAlign: "left",
      }}
    >
      <span style={{ color: CORAL }}>$ </span>
      {text.slice(0, shown)}
      <span style={{ opacity: caret ? 1 : 0 }}>▍</span>
    </div>
  );
};

const Card: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.4)) });
  const rise = interpolate(frame, [0.2 * fps, 0.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 35%, #3a3a44 0%, ${INK} 60%, #1e1e24 100%)`,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
        color: "#fff",
      }}
    >
      <Img src={staticFile("icon.svg")} style={{ width: 190, height: 190, transform: `scale(${pop})`, filter: "drop-shadow(0 18px 40px rgba(0,0,0,0.45))" }} />
      <div style={{ fontSize: 66, fontWeight: 800, marginTop: 26, letterSpacing: -1, opacity: rise, transform: `translateY(${(1 - rise) * 20}px)` }}>{scene.title}</div>
      {scene.sub ? (
        <div style={{ fontSize: 27, color: "#d9d9df", marginTop: 12, opacity: rise, transform: `translateY(${(1 - rise) * 20}px)`, maxWidth: 1100, textAlign: "center", lineHeight: 1.35 }}>{scene.sub}</div>
      ) : null}
      {scene.command ? (
        <div style={{ marginTop: 44, opacity: rise }}>
          <Typed text={scene.command} frame={frame} fps={fps} start={Math.round(0.9 * fps)} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** One scene with its crossfade: fades in over the previous scene's tail. */
const Fade: React.FC<{ durationInFrames: number; first: boolean; children: React.ReactNode }> = ({ durationInFrames, first, children }) => {
  const frame = useCurrentFrame();
  const f = fadeFrames();
  const opacity = first ? 1 : interpolate(frame, [0, f], [0, 1], { extrapolateRight: "clamp" });
  void durationInFrames;
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

export const Demo: React.FC = () => {
  let at = 0;
  const f = fadeFrames();
  return (
    <AbsoluteFill style={{ background: INK }}>
      {SCENES.map((scene, i) => {
        const len = Math.round(scene.seconds * DEMO_FPS);
        const from = at;
        at += len - f;
        return (
          <Sequence key={i} from={from} durationInFrames={len} layout="none">
            <Fade durationInFrames={len} first={i === 0}>
              {scene.kind === "card" ? <Card scene={scene} /> : <Shot scene={scene} durationInFrames={len} />}
            </Fade>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
