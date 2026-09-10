import { openAsBlob } from "node:fs";
import { extname } from "node:path";
import { createAgentClient } from "./client.mjs";

const commands = new Set([
  "createAgentSession",
  "requestOtp",
  "verifyOtp",
  "refreshSession",
  "getProfile",
  "saveProfile",
  "getToday",
  "getLatestIncomplete",
  "listHistory",
  "listFriendFeed",
  "createGoal",
  "createGoalV2",
  "carryGoalV2",
  "listCompletionFeed",
  "correctGoal",
  "carryGoal",
  "completeGoal",
  "removeGoal",
  "setCheered",
  "searchUsername",
  "listFriendships",
  "sendFriendRequest",
  "acceptFriendRequest",
  "removeFriend",
  "blockUser",
  "uploadProof",
  "signedProofUrl",
]);

try {
  const command = process.argv[2];
  if (command === "--help") {
    process.stdout.write(
      `Usage: node agents/cli.mjs COMMAND < arguments.json\nArguments are a JSON array. Commands: ${[...commands].join(", ")}\nCredentials: ONE_THING_URL, ONE_THING_PUBLISHABLE_KEY, ONE_THING_ACCESS_TOKEN\nAuth commands return secrets; capture their output securely.\n`,
    );
  } else {
    if (!commands.has(command)) throw new Error("Unknown command; use --help");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 64 * 1024) throw new Error("Arguments exceed 64 KiB");
    }
    const args = JSON.parse(input.trim() || "[]");
    if (!Array.isArray(args)) throw new Error("Arguments must be a JSON array");
    const client = createAgentClient({
      url: process.env.ONE_THING_URL,
      publishableKey: process.env.ONE_THING_PUBLISHABLE_KEY,
      accessToken: process.env.ONE_THING_ACCESS_TOKEN,
    });
    if (command === "uploadProof") {
      const mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".heic": "image/heic",
        ".heif": "image/heif",
      }[extname(args[0] ?? "").toLowerCase()];
      if (!mime) throw new Error("Proof file must be JPEG, PNG, HEIC or HEIF");
      args[0] = await openAsBlob(args[0], { type: mime });
    }
    process.stdout.write(`${JSON.stringify(await client[command](...args))}\n`);
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ error: error.message, code: error.code, status: error.status })}\n`,
  );
  process.exitCode = 1;
}
