// The admin page's line diff (shown before saving a project) must be exact:
// removing "+" lines must give the old text and removing "-" lines the new one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "index.html"), "utf8");
const start = html.indexOf("    function diffLines(");
const end = html.indexOf("    function renderDiff(");
assert.ok(start > 0 && end > start, "diffLines not found in index.html");
const context = {};
vm.runInNewContext(`${html.slice(start, end)}; this.diffLines = diffLines;`, context);
const { diffLines } = context;

const check = (a, b) => {
  const ops = Array.from(diffLines(a, b)); // arrays from the vm realm
  assert.deepEqual([...ops.filter((o) => o.t !== "+").map((o) => o.line)], a);
  assert.deepEqual([...ops.filter((o) => o.t !== "-").map((o) => o.line)], b);
  return ops.filter((o) => o.t !== " ").length;
};

test("diff reproduces both sides for random inputs", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const gen = () => Array.from({ length: Math.floor(rnd() * 14) }, () => "abcde"[Math.floor(rnd() * 5)]);
  for (let i = 0; i < 2000; i += 1) check(gen(), gen());
});

test("diff is minimal for small edits in large documents", () => {
  const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  const edited = big.slice();
  edited[100] = "changed";
  edited.splice(5000, 3);
  assert.equal(check(big, edited), 5);
  assert.equal(check([], []), 0);
  assert.equal(check(["a"], []), 1);
});
