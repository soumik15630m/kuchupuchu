/** Copies MediaPipe's wasm into `public/vision/wasm` before a dev or prod build.
 *
 * Background blur needs a segmenter, and the library it comes from defaults to
 * fetching that segmenter from jsDelivr and storage.googleapis.com at the
 * moment a call starts. Two third parties learning that a private call just
 * began is the one thing this app should not leak, so both halves are served
 * from here instead.
 *
 * The wasm is copied rather than committed: it arrives with
 * @mediapipe/tasks-vision, and a second copy in git would silently drift from
 * the installed version the first time the dependency moves.
 *
 * The model (`selfie_segmenter.tflite`) *is* committed, because it has no npm
 * source — downloading it during a build would mean a build that needs the
 * network and fails when Google is unreachable, which is exactly the
 * circumstance the self-hosting exists for.
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "node_modules", "@mediapipe", "tasks-vision", "wasm");
const destination = join(here, "..", "public", "vision", "wasm");

try {
  await access(source);
} catch {
  // The dependency is optional in the sense that everything except blur works
  // without it. A missing wasm directory must not fail the build.
  console.warn("[vision] @mediapipe/tasks-vision not installed; background blur will be off");
  process.exit(0);
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`[vision] wasm copied to public/vision/wasm`);
