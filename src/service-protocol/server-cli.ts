#!/usr/bin/env node

import { StudioServer } from "./server.js";

const server = new StudioServer({
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  onExitCode: (code) => {
    process.exitCode = code;
    process.stdin.pause();
  },
});

server.start();
