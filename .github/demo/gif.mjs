// Render the Demo composition to a PNG sequence, then pack it into the README GIF
// with ffmpeg (two-pass palette, Bayer dither), re-encoding smaller until it is
// under the size cap. Usage: node gif.mjs [--max-mb 9.5] [--width 900] [--fps 12]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length));
const maxBytes = Math.round(parseFloat(args["max-mb"] ?? "9.5") * 1024 * 1024);
let width = parseInt(args.width ?? "900", 10);
let fps = parseInt(args.fps ?? "12", 10);
const ffmpeg = process.env.FFMPEG ?? "/opt/ffmpeg/bin/ffmpeg";
const framesDir = join(here, "out", "frames");
const target = resolve(here, args.out ?? "../shots/kirocrew-ide-demo.gif");

if (!args["skip-render"]) {
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  execFileSync("npx", ["remotion", "render", "src/index.ts", "Demo", framesDir, "--sequence", "--image-format", "png", "--gl", "swangle", "--log", "error"], { cwd: here, stdio: "inherit" });
}
const frames = readdirSync(framesDir).filter((f) => f.endsWith(".png")).length;
if (!frames) throw new Error("no frames rendered");

const pack = (w, r) => {
  const palette = join(here, "out", "palette.png");
  const vf = `fps=${r},scale=${w}:-1:flags=lanczos`;
  execFileSync(ffmpeg, ["-y", "-v", "error", "-framerate", String(fps), "-i", join(framesDir, "element-%03d.png"), "-vf", `${vf},palettegen=max_colors=192:stats_mode=diff`, palette], { stdio: "inherit" });
  execFileSync(ffmpeg, ["-y", "-v", "error", "-framerate", String(fps), "-i", join(framesDir, "element-%03d.png"), "-i", palette, "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", target], { stdio: "inherit" });
  return statSync(target).size;
};

let size = pack(width, fps);
const steps = [[880, 12], [860, 10], [820, 10], [780, 10], [720, 9]];
for (const [w, r] of steps) {
  if (size <= maxBytes) break;
  console.log(`gif is ${(size / 1048576).toFixed(2)} MB, over the cap; retrying at ${w}px ${r}fps`);
  size = pack(w, r);
  width = w; fps = r;
}
console.log(`${target}: ${(size / 1048576).toFixed(2)} MB, ${width}px, ${fps} fps, ${frames} source frames${size > maxBytes ? " — STILL OVER THE CAP" : ""}`);
if (!existsSync(target)) process.exit(1);
