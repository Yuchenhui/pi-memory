import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = process.platform === "win32" ? "windows" : /microsoft/i.test(os.release()) ? "wsl" : process.platform;
process.env.PI_MEMORY_DIR = request.store;
process.env.PI_MEMORY_QMD_UPDATE = "off";
process.env.PI_MEMORY_EXIT_SUMMARY = "off";
process.env.PI_MEMORY_NO_SEARCH = "1";
process.env.PI_MEMORY_CLASSIFIER = "off";
process.env.PI_MEMORY_SNAPSHOT = "stable";
delete process.env.TYPESAFE_API_KEY;
delete process.env.PI_MEMORY_PROJECT_ID;
if (request.projectId) process.env.PI_MEMORY_PROJECT_ID = request.projectId;
globalThis.fetch = async () => { throw new Error("native acceptance forbids network"); };
const report = { source, platform: process.platform, release: os.release(), node: process.version, hash: createHash("sha256").update(fs.readFileSync(request.extension)).digest("hex"), results: [], errors: [] };
try {
 const version = fs.readFileSync(path.join(request.agent, "install/current-version"), "utf8").trim();
 report.piVersion = version;
 const loader = path.join(request.agent, "install/releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
 const { loadExtensions } = await import(pathToFileURL(loader).href);
 const loaded = await loadExtensions([request.extension], request.cwd);
 if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
 const extension = loaded.extensions[0];
 const ctx = { cwd: request.cwd, sessionManager: { getSessionId: () => `native-${source}` }, hasUI: false, ui: { notify() {} } };
 const call = async (name, params, cwd) => {
  const tool = extension.tools.get(name)?.definition;
  if (!tool) throw new Error(`missing tool ${name}`);
  const result = await tool.execute("acceptance", params, undefined, undefined, { ...ctx, cwd: cwd || ctx.cwd });
  return result;
 };
 if (request.startAt) await new Promise(r => setTimeout(r, Math.max(0, request.startAt - Date.now())));
 if (request.reader) {
  report.completeReads = 0; report.sharingErrors = []; report.corruptions = [];
  const end = Date.now() + request.reader;
  while (Date.now() < end) {
   const directory = path.join(request.store, "daily");
   try {
    for (const file of fs.existsSync(directory) ? fs.readdirSync(directory).filter(f => f.endsWith(".md")) : []) {
     const bytes = fs.readFileSync(path.join(directory, file));
     let offset = 0;
     while (offset < bytes.length) {
      const tail = bytes.subarray(offset).toString("utf8");
      const match = /<!-- pi-memory-record:v1:([A-Za-z0-9_-]+):(\d+) -->\r?\n/.exec(tail);
      if (!match) {
       if (tail.includes("<!-- pi-memory-record:")) throw new Error("malformed trailing frame");
       break;
      }
      const prefix = tail.slice(0, match.index);
      if (prefix.includes("<!-- pi-memory-record:")) throw new Error("malformed intervening frame");
      JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      offset += Buffer.byteLength(prefix + match[0]) + Number(match[2]);
      if (offset > bytes.length) throw new Error("torn frame");
     }
     report.completeReads++;
    }
   } catch (e) {
    if (["EACCES", "EPERM", "EBUSY", "ENOENT"].includes(e.code)) report.sharingErrors.push(e.code);
    else report.corruptions.push(String(e));
   }
   await new Promise(r => setTimeout(r, 10));
  }
  if (report.corruptions.length) throw new Error(JSON.stringify(report.corruptions));
 } else if (request.writer) {
  report.attempted = request.count; report.ok = 0;
  for (let i = 0; i < request.count; i++) {
   const result = await call("memory_write", { target: "daily", scope: "shared", content: `ACCEPT-${request.writer}-${i}` });
   if (result.isError) throw new Error(JSON.stringify(result));
   if (result.details.source !== source) throw new Error("tool provenance mismatch");
   report.ok++;
  }
 } else {
  for (const op of request.operations || []) {
   let result;
   if (op.hook) {
    result = await Promise.all((extension.handlers.get("before_agent_start") || []).map(fn => fn({ systemPrompt: "BASE", prompt: "hello" }, { ...ctx, cwd: op.cwd || ctx.cwd })));
   } else if (op.replaceExternal) {
    const p = path.join(request.store, "MEMORY.md");
    const child = spawnSync(process.execPath, ["-e", `const f=require('fs'),p=process.argv[1],s=f.statSync(p);let b=f.readFileSync(p,'utf8');if(!b.includes('hook-one'))process.exit(2);f.writeFileSync(p,b.replace('hook-one','hook-two'));f.utimesSync(p,s.atime,s.mtime);`, p], { encoding: "utf8" });
    if (child.status !== 0) throw new Error(`external replacement failed ${child.stderr}`);
    result = { externalReplacement: true };
   } else {
    const params = { ...op.params };
    if (params.recoveryId === "$last") params.recoveryId = report.results.findLast(r => r.result?.details?.recoveryId)?.result.details.recoveryId;
    result = await call(op.tool, params, op.cwd);
    if (Boolean(result.isError) !== Boolean(op.expectError)) throw new Error(`${op.tool}: unexpected isError ${JSON.stringify(result)}`);
   }
   const rendered = JSON.stringify(result);
   for (const value of op.contains || []) if (!rendered.includes(value)) throw new Error(`missing expected ${value} in ${rendered}`);
   for (const value of op.excludes || []) if (rendered.includes(value)) throw new Error(`hidden value leaked: ${value}`);
   report.results.push({ operation: op, result });
  }
 }
} catch (e) { report.errors.push(String(e.stack || e)); }
fs.writeFileSync(request.output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ source, node: report.node, hash: report.hash, ok: report.ok, operations: report.results.length, errors: report.errors }));
process.exit(report.errors.length ? 1 : 0);
