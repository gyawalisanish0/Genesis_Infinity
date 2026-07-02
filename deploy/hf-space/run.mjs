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
  "Goku looks around and asks what is nearby.",
  "Goku attempts to use his Kamehameha technique on Venom.",
  "Goku drinks a health potion.",
];

const child = spawn(
  "npm",
  [
    "run",
    "play",
    "--",
    "--experience",
    "examples/goku-vs-venom",
    "--model",
    "models/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    "--character",
    "goku",
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
