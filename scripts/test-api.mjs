// Each test file gets an isolated workerd. On a long run, the Workers Vitest
// pool can close the shared socket when the first group of isolates shuts down.
// Start a fresh pool per batch and preserve Vitest's own file discovery.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function vitest(args) {
  const run = spawnSync("vp", ["test", ...args], {stdio:"inherit"});
  if (run.error) throw run.error;
  return run.status ?? 1;
}

const args = process.argv.slice(2);
if (args.length) {
  process.exitCode = vitest(args);
} else {
  const directory = mkdtempSync(join(tmpdir(),"2do-worker-tests-"));
  try {
    const list = join(directory,"files.json");
    const status = vitest(["list","--filesOnly","--json",list]);
    if (status !== 0) throw new Error("Worker test discovery failed.");
    const files = JSON.parse(readFileSync(list,"utf8")).map(entry => entry.file);
    if (!files.length) throw new Error("No Worker test files found.");
    const workers = 3;
    for (let offset=0; offset<files.length; offset+=workers) {
      const status=vitest(["run",...files.slice(offset,offset+workers),"--maxWorkers",String(workers)]);
      if (status !== 0) process.exitCode=status;
    }
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
}
