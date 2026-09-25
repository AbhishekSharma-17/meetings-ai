// Adapted from modern-frontend-design: a stray comment terminator can break every route.
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "src/app/styles.css";
const source = readFileSync(file, "utf8");
let inComment = false, line = 1;
const problems = [];
for (let index = 0; index < source.length; index++) {
  if (source[index] === "\n") line++;
  if (!inComment && source.startsWith("/*", index)) { inComment = true; index++; continue; }
  if (inComment && source.startsWith("*/", index)) { inComment = false; index++; continue; }
  if (!inComment && source.startsWith("*/", index)) problems.push(`${file}:${line}: stray terminator`);
}
if (inComment) problems.push(`${file}: unterminated comment`);
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
else console.log(`${file}: comments balanced`);
