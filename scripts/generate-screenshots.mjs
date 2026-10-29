/**
 * Screenshot generator + pass/fail verifier for the background gallery.
 *
 * The previous version could not tell a finished scene from a black one: it
 * waited a fixed 3s, swallowed every error, and wrote a PNG regardless. With
 * 50 scenes that turns into a grid full of invisible failures, so this version
 * measures each frame and refuses to emit a thumbnail it cannot justify.
 *
 * Usage:
 *   bun run dev                 # or a built server, see --base-url
 *   bun run screenshots         # every background missing a thumbnail
 *   bun run screenshots --force # re-shoot everything
 *   bun run screenshots -- --ids=a,b --force
 *   bun run screenshots -- --from=1 --to=10
 *
 * Only already-installed deps are used (playwright). Pixel statistics are
 * computed inside the browser with OffscreenCanvas because there is no image
 * library available and no new dependency is allowed.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, access, rm, writeFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);

const readFlag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const hasFlag = (name) => argv.includes(`--${name}`);

const BASE_URL = readFlag(
  "base-url",
  process.env.BASE_URL || "http://localhost:3000",
);
const OUT_DIR = resolve(__dirname, readFlag("out", "../public/screenshots"));
const REPORT_PATH = resolve(
  __dirname,
  readFlag("report", "../.screenshots-report.json"),
);

// Captured at thumbnail size on purpose: these scenes are resolution
// independent, and rasterising 1280x800 through SwiftShader costs ~7s per
// frame, which is untenable across 50 scenes.
const VIEWPORT = { width: 640, height: 400 };
const JPEG_QUALITY = Number(readFlag("quality", "82"));

const WARM_MS = Number(readFlag("warm", "3500"));
// Software GL is slow enough that a screenshot can take the better part of a
// minute; the default 30s is not enough and fails scenes that are fine.
const CAPTURE_TIMEOUT = Number(readFlag("capture-timeout", "120000"));

// A scene that never schedules another frame is dead even if its first frame
// looked good, so liveness is measured by frame count, not by pixel diffing.
const MIN_FRAMES = Number(readFlag("min-frames", "3"));
const LOW_FPS = Number(readFlag("low-fps", "5"));

// A scene must be rich in colour: the preview page paints its own dark
// gradient, so pixel variance plus colour count is what proves the WebGL scene
// actually came up rather than leaving a blank canvas behind.
//
// Only a frame that is flat AND near-colourless counts as blank. Legitimately
// minimal scenes (a firefly meadow, a single lit ribbon) sit low on one axis
// and healthy on the other, and failing those buries real breakage in noise.
const MIN_VARIANCE = Number(readFlag("min-variance", "8"));
const MIN_DISTINCT = Number(readFlag("min-distinct", "16"));

// Anything below these is still rendered and usable, but worth a human look.
const THIN_VARIANCE = Number(readFlag("thin-variance", "25"));
const THIN_DISTINCT = Number(readFlag("thin-distinct", "14"));

const FORCE = hasFlag("force");

const parseList = (value) =>
  value
    ? value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : null;

const idFilter = parseList(readFlag("ids", ""));

/**
 * Downsample + measure inside the page. Returns a coarse 32x20 luma signature
 * so the caller can detect motion between two polls without shipping pixels
 * back and forth.
 */
async function measure(page, jpegBuffer) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/jpeg" }),
    );

    const W = 32;
    const H = 20;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;

    const fine = new OffscreenCanvas(96, 60);
    const fctx = fine.getContext("2d");
    fctx.drawImage(bitmap, 0, 0, 96, 60);
    const fd = fctx.getImageData(0, 0, 96, 60).data;

    let n = 0;
    let sum = 0;
    let sumSq = 0;
    const buckets = new Set();
    const sig = new Array(W * H);

    for (let i = 0; i < data.length; i += 4) {
      const luma =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      sumSq += luma * luma;
      sig[n] = Math.round(luma / 2);
      n += 1;
    }

    for (let i = 0; i < fd.length; i += 4) {
      buckets.add(
        ((fd[i] >> 4) << 8) | ((fd[i + 1] >> 4) << 4) | (fd[i + 2] >> 4),
      );
    }

    bitmap.close();

    return {
      mean: sum / n,
      varLuma: sumSq / n - (sum / n) ** 2,
      distinct: buckets.size,
      signature: sig.join(","),
    };
  }, jpegBuffer.toString("base64"));
}

/** Captured at thumbnail size already, so this is just a write. */
async function writeThumb(_page, jpegBuffer, file) {
  await writeFile(file, jpegBuffer);
  return jpegBuffer.length;
}

async function waitForServer(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { backgrounds } = await import(
    resolve(__dirname, "../app/config/backgrounds.js")
  );

  let targets = backgrounds.filter((bg) => bg.id && bg.component);

  if (idFilter) targets = targets.filter((bg) => idFilter.includes(bg.id));

  const from = Number(readFlag("from", "1"));
  const to = Number(readFlag("to", String(targets.length)));
  targets = targets.slice(from - 1, to);

  if (!targets.length) {
    console.error("No backgrounds matched the selection.");
    process.exitCode = 1;
    return;
  }

  if (!(await waitForServer(BASE_URL))) {
    console.error(
      `No server at ${BASE_URL}.\n` +
        `  dev:   bun run dev\n` +
        `  prod:  bun run build && node .output/server/index.mjs\n` +
        `  other: bun run screenshots -- --base-url=http://localhost:4000`,
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    // Headless Chromium >= 137 blocks SwiftShader unless it is explicitly
    // allowed, which would show up as 50 black scenes rather than one
    // environment problem.
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      // Containers get a small /dev/shm, and a saturated one kills renderers
      // mid-run with "Failed to find browser context", which reads as 50
      // broken scenes instead of one crashed browser.
      "--disable-dev-shm-usage",
      "--disable-gpu-sandbox",
      "--no-sandbox",
    ],
  });

  // Distinguish "this scene is broken" from "this machine has no WebGL".
  {
    const probe = await browser.newPage();
    const renderer = await probe.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      if (!gl) return null;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "webgl";
    });
    await probe.close();

    if (!renderer) {
      console.error(
        "WebGL is unavailable in this browser. Aborting: every scene would be\n" +
          "recorded as a failure and none of those failures would be real.",
      );
      await browser.close();
      process.exitCode = 1;
      return;
    }
    console.log(`WebGL renderer: ${renderer}`);
  }

  console.log(`Shooting ${targets.length} background(s) from ${BASE_URL}\n`);

  const results = [];

  for (const bg of targets) {
    const file = join(OUT_DIR, `${bg.id}.jpg`);
    const started = Date.now();

    if (!FORCE && (await fileExists(file))) {
      console.log(`  skip   ${bg.id} (exists; use --force)`);
      results.push({ id: bg.id, verdict: "SKIP" });
      continue;
    }

    // A context per scene keeps WebGL state isolated and makes sure contexts
    // are actually reclaimed instead of accumulating toward the browser cap.
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });

    // Count animation frames in the page rather than inferring motion from
    // repeated screenshots. Screenshotting a saturated SwiftShader page costs
    // tens of seconds; this costs nothing and is a far better liveness signal.
    await context.addInitScript(() => {
      window.__frames = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          window.__frames += 1;
          return callback(time);
        });
    });

    const page = await context.newPage();

    const errors = [];
    // A blocked optional asset is a different problem from a scene that cannot
    // run. Cosmic Anomaly, for instance, fetches an HDR environment map from a
    // third-party host that fails CORS while the scene itself renders fine, so
    // lumping the two together would hide real breakage behind network noise.
    const assetIssues = [];
    const ASSET_RE =
      /CORS|Access to fetch|Access to XMLHttpRequest|Failed to load resource|ERR_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED|404 \(Not Found\)/i;

    page.on("pageerror", (e) => {
      if (ASSET_RE.test(e.message)) assetIssues.push(`pageerror: ${e.message}`);
      else errors.push(`pageerror: ${e.message}`);
    });
    page.on("console", (msg) => {
      const text = msg.text();
      const sceneFault =
        /Shader compile|Program link|CONTEXT_LOST|WebGL not supported|too many active Web contexts|GL_INVALID|is not defined|Cannot read|of undefined|of null/i.test(
          text,
        );

      if (msg.type() !== "error" && !sceneFault) return;

      if (ASSET_RE.test(text)) assetIssues.push(`console: ${text.slice(0, 200)}`);
      else errors.push(`console: ${text.slice(0, 300)}`);
    });

    let verdict;
    let stats = null;
    let frames = 0;
    let fps = 0;
    let settleMs = 0;
    let bytes = 0;

    try {
      await page.goto(`${BASE_URL}/preview/${bg.id}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector("canvas", { timeout: 30000 });

      await page.waitForTimeout(WARM_MS);

      frames = await page.evaluate(() => window.__frames || 0);
      fps = frames / (WARM_MS / 1000);
      settleMs = Date.now() - started;

      // One screenshot does double duty as the measurement source and the
      // thumbnail, because screenshotting is the expensive part under GL.
      const shot = await page.screenshot({
        type: "jpeg",
        quality: JPEG_QUALITY,
        timeout: CAPTURE_TIMEOUT,
      });
      stats = await measure(page, shot);

      const blank =
        stats.varLuma <= MIN_VARIANCE && stats.distinct <= MIN_DISTINCT;
      const thin =
        stats.varLuma <= THIN_VARIANCE || stats.distinct <= THIN_DISTINCT;

      if (errors.length) {
        verdict = "FAIL_ERRORS";
      } else if (blank) {
        verdict = "FAIL_BLANK";
      } else if (frames < MIN_FRAMES) {
        verdict = "FAIL_FROZEN";
      } else if (thin) {
        verdict = "PASS_THIN";
      } else if (fps < LOW_FPS) {
        verdict = "PASS_SLOW";
      } else {
        verdict = "PASS";
      }

      if (verdict.startsWith("PASS")) {
        bytes = await writeThumb(page, shot, file);
      } else if (await fileExists(file)) {
        // Never leave a stale or blank thumbnail that looks like finished work.
        await rm(file, { force: true });
      }
    } catch (error) {
      verdict = "FAIL_NAVIGATE";
      errors.push(`error: ${error.message}`);
      if (await fileExists(file)) await rm(file, { force: true });
    }

    await context.close();

    const row = {
      id: bg.id,
      component: bg.component,
      verdict,
      settleMs,
      fps: Number(fps.toFixed(1)),
      frames,
      mean: stats ? Number(stats.mean.toFixed(1)) : null,
      varLuma: stats ? Number(stats.varLuma.toFixed(1)) : null,
      distinct: stats ? stats.distinct : null,
      bytes,
      errors: errors.slice(0, 4),
      assetIssues: assetIssues.slice(0, 3),
    };
    results.push(row);

    const flag = verdict.startsWith("PASS") || verdict === "SKIP" ? "✓" : "✗";
    console.log(
      `  ${flag} ${verdict.padEnd(14)} ${bg.id.padEnd(22)} ` +
        `t=${String(settleMs).padStart(6)}ms ` +
        `var=${String(row.varLuma ?? "-").padStart(6)} ` +
        `colors=${String(row.distinct ?? "-").padStart(4)} ` +
        `fps=${String(row.fps).padStart(5)}` +
        (bytes ? ` ${Math.round(bytes / 1024)}kb` : ""),
    );
    for (const line of row.errors.slice(0, 2)) {
      console.log(`      ${line}`);
    }
  }

  await browser.close();

  await writeFile(REPORT_PATH, JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.verdict.startsWith("FAIL"));
  const slow = results.filter((r) => r.verdict === "PASS_SLOW");
  const passed = results.filter((r) => r.verdict.startsWith("PASS"));

  console.log(
    `\n${passed.length} passed (${slow.length} slow under software GL), ` +
      `${failed.length} failed, ` +
      `${results.filter((r) => r.verdict === "SKIP").length} skipped`,
  );
  if (slow.length) {
    console.log(
      `  slow: ${slow.map((r) => `${r.id}(${r.fps}fps)`).join(", ")}`,
    );
  }
  const blocked = results.filter((r) => r.assetIssues?.length);
  if (blocked.length) {
    console.log(
      `  ${blocked.length} scene(s) rendered but had a blocked/failed asset fetch ` +
        `(see report): ${blocked.map((r) => r.id).join(", ")}`,
    );
  }
  const thin = results.filter((r) => r.verdict === "PASS_THIN");
  if (thin.length) {
    console.log(
      `  thin (worth an eye, still usable): ${thin
        .map((r) => `${r.id}(var=${r.varLuma},colors=${r.distinct})`)
        .join(", ")}`,
    );
  }
  if (failed.length) {
    console.log(
      `  rerun just those: bun run screenshots -- --force --ids=${failed
        .map((r) => r.id)
        .join(",")}`,
    );
  }
  console.log(`  report: ${REPORT_PATH}`);
  console.log(`  thumbs: ${OUT_DIR}`);

  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
