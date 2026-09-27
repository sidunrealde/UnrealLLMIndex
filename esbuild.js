const esbuild = require("esbuild");

const args = process.argv.slice(2);
const isWatch = args.includes("--watch");

const baseConfig = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
  loader: { ".md": "text" },
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
