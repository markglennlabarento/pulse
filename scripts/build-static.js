"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const output = path.join(root, "dist");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "_headers"]) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
