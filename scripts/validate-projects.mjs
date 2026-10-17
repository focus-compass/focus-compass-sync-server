#!/usr/bin/env node
/**
 * Read-only audit: fetch every project from a running sync server (GET only)
 * and validate it with THIS checkout's schema.
 *
 *   FC_URL=https://sync.example.com FC_TOKEN=<master token> node scripts/validate-projects.mjs [doc ...]
 *
 * Reports, per project:
 *   - "open" errors: what the admin editor shows when the project is opened
 *     (stored project as its own baseline). Must be zero.
 *   - strict issues (no baseline), grouped by path pattern, so new real-world
 *     fields can be added to src/yjs/projectSchema.js.
 * Exit code 1 if any project has "open" errors. Never writes anything.
 */
import { validateProject } from "../src/yjs/projectSchema.js";

const base = (process.env.FC_URL || "").replace(/\/+$/, "");
const token = process.env.FC_TOKEN || "";
if (!base || !token) {
  console.error("Set FC_URL and FC_TOKEN (master token). Optional args: document names.");
  process.exit(2);
}

const get = async (path) => {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
};

const docs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await get("/api/admin/db-info")).documents.map((d) => d.name);

const pattern = (path) => path.replace(/\[\d+\]/g, "[i]");
const strict = new Map(); // "pattern: message" -> count
let total = 0;
let failing = 0;

for (const doc of docs) {
  let list;
  try {
    list = (await get(`/api/admin/documents/${encodeURIComponent(doc)}/projects`)).projects;
  } catch (err) {
    console.log(`${doc}: ${err.message}`);
    continue;
  }
  for (const { id } of list) {
    total += 1;
    const { project } = await get(`/api/admin/documents/${encodeURIComponent(doc)}/projects/${encodeURIComponent(id)}`);
    const open = validateProject(project, { expectedId: id, stored: project });
    if (!open.ok) {
      failing += 1;
      console.log(`FAIL ${doc}/${id}`);
      for (const e of open.errors) console.log(`   ${e.path}: ${e.message}`);
    }
    for (const e of validateProject(project, { expectedId: id }).errors) {
      const key = `${pattern(e.path)}: ${e.message}`;
      strict.set(key, (strict.get(key) || 0) + 1);
    }
  }
}

console.log(`\n${total} projects in ${docs.length} documents; ${failing} fail to open cleanly.`);
if (strict.size) {
  console.log("\nStrict issues (no baseline), by path:");
  for (const [key, count] of [...strict].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${key}`);
}
process.exit(failing ? 1 : 0);
