const nonce = process.argv[2];

if (!process.send || !/^procproof-[a-f0-9-]+$/.test(nonce ?? "")) {
  process.exit(2);
}

let sigtermCount = 0;

process.on("message", (message) => {
  if (
    message?.type === "identity_challenge" &&
    message?.nonce === nonce &&
    typeof message.challengeId === "string"
  ) {
    process.send?.({
      type: "identity_response",
      challengeId: message.challengeId,
      nonce,
      pid: process.pid,
      ppid: process.ppid,
      sigtermCount,
    });
  }
});

process.on("SIGTERM", () => {
  sigtermCount += 1;
  process.send?.({
    type: "sigterm_observed",
    nonce,
    pid: process.pid,
    ppid: process.ppid,
    sigtermCount,
  });
  // Deliberately remain alive so the parent's bounded escalation branch runs.
});

process.on("disconnect", () => {
  process.exit(97);
});

setInterval(() => {}, 1_000);
setTimeout(() => process.exit(98), 5_000);

process.send({
  type: "ready",
  nonce,
  pid: process.pid,
  ppid: process.ppid,
});
