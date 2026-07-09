import http from "node:http";
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 7860;

http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Genesis Infinity real-model test container is running. See container logs for output.\n");
  })
  .listen(PORT, () => {
    console.log(`Status server listening on port ${PORT}`);
  });

const turns = [
  "Kestrel looks around the helipad and checks what's nearby.",
  "Kestrel uses a grapnel swing to reach the executive floor.",
  "Kestrel injects an adrenaline shot.",
];

const child = spawn(
  "npm",
  [
    "run",
    "play",
    "--",
    "--experience",
    "examples/blackline-action",
    "--model",
    "models/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    "--character",
    "kestrel",
    "--debug",
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function feedTurns() {
  for (const turn of turns) {
    child.stdin.write(turn + "\n");
    await sleep(180000);
  }
  child.stdin.write("exit\n");
  child.stdin.end();
}

feedTurns();

child.on("exit", (code) => {
  console.log(`CLI test process exited with code ${code}`);
});
