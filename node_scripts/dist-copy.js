// node_scripts/dist-copy.js
const fs = require("fs");
const path = require("path");

const SRC_ROOT = path.resolve("src");
const DIST_ROOT = path.resolve("dist");

const FRONTEND_DIR = "frontend";
const FRONTEND_FILES = ["index.html", "styles.css"];
const FRONTEND_MUST_HAVE = ["index.html"];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function assertExists(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`[dist-copy] missing ${label}: ${p}`);
  }
}

function copyFileOrWarn(from, to, label) {
  if (!fs.existsSync(from)) {
    console.warn(`[dist-copy] WARN: missing ${label}: ${from}`);
    return false;
  }
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  return true;
}

function copyFrontendStatics() {
  const src = path.join(SRC_ROOT, FRONTEND_DIR);
  const dst = path.join(DIST_ROOT, FRONTEND_DIR);

  assertExists(src, "frontend dir");
  ensureDir(dst);

  for (const f of FRONTEND_MUST_HAVE) {
    assertExists(path.join(src, f), `frontend file (${f})`);
  }

  for (const file of FRONTEND_FILES) {
    copyFileOrWarn(
      path.join(src, file),
      path.join(dst, file),
      `frontend file (${file})`
    );
  }
}

// ---- run ----

assertExists(SRC_ROOT, "src root");
ensureDir(DIST_ROOT);

copyFrontendStatics();
