const esbuild = require("esbuild");

const args = process.argv.slice(2);
const isWatch = args.includes("--watch");

const baseConfig = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
};

const builds = [
  {
    ...baseConfig,
    entryPoints: ["./src/cli.ts"],
    outfile: "./dist/cli.js",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    ...baseConfig,
    entryPoints: ["./src/extension.ts"],
    outfile: "./dist/extension.js",
    external: ["vscode"],
  },
  {
    ...baseConfig,
    // Parses engine files on worker threads during `engine sync`; loaded from next to cli.js
    entryPoints: ["./src/engine/parseWorker.ts"],
    outfile: "./dist/parseWorker.js",
  },
  {
    ...baseConfig,
    entryPoints: ["./scripts/agent-smoke.ts"],
    outfile: "./dist/agent-smoke.js",
  },
];

async function main() {
  if (isWatch) {
    for (const config of builds) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    console.log("watching...");
  } else {
    await Promise.all(builds.map(config => esbuild.build(config)));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
