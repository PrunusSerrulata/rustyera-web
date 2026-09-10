// Parse only build-tool arguments: npm's forwarding separator is consumed once,
// while Cargo/Tauri's remaining `--` starts opaque application arguments.
export function cargoCommandIdentity(
  args,
  environment = {},
  executable = environment.RUSTYERA_CARGO || "cargo",
) {
  let options = args;
  if (/^(?:.*[/\\])?cargo-local\.mjs$/.test(options[0] || "")) options = options.slice(1);
  if (/^(?:.*[/\\])?(?:npm(?:\.cmd)?|npm-cli\.js)$/.test(options[0] || ""))
    options = options.slice(1);
  if (options[0] === "run" && options[1] === "tauri" && options[2] === "--")
    options = options.slice(3);
  const separator = options.indexOf("--");
  if (separator >= 0) options = options.slice(0, separator);

  const features = [];
  const packages = [];
  const manifestPaths = [];
  let command;
  let target;
  let allFeatures = false;
  let noDefaultFeatures = false;
  for (let index = 0; index < options.length; index++) {
    const value = options[index];
    const match = value.match(/^(--features|--target|--package|--manifest-path)(?:=(.*))?$/);
    const short = value.match(/^(-F|-p)(.*)$/);
    if (match || short) {
      const flag = (match || short)[1];
      const inline = match ? match[2] : short[2].replace(/^=/, "") || undefined;
      const selected = inline ?? options[++index];
      if (!selected) continue;
      if (flag === "--features" || flag === "-F")
        features.push(...selected.split(/[\s,]+/).filter(Boolean));
      else if (flag === "--target") target = selected;
      else if (flag === "--manifest-path") manifestPaths.push(selected);
      else packages.push(selected);
    } else if (value === "--all-features") allFeatures = true;
    else if (value === "--no-default-features") noDefaultFeatures = true;
    else if (value.startsWith("-")) {
      // Consume values of unrelated options so they cannot become command or
      // package identities. Valueless flags must leave the command observable.
      if (
        !value.includes("=") &&
        !/^(--(?:release|workspace|all|lib|bins|examples|tests|benches|all-targets|locked|offline|frozen|quiet|verbose|help|version|no-deps|no-bundle|debug)|-[qvhV]+)$/.test(
          value,
        ) &&
        options[index + 1] &&
        !options[index + 1].startsWith("-")
      )
        index++;
    } else if (!command && !value.startsWith("+")) command = value;
  }
  const featureIdentity = {
    features: [...new Set(features)].sort(),
    allFeatures,
    noDefaultFeatures,
  };
  const effectiveTarget = target || environment.CARGO_BUILD_TARGET || "";
  return {
    command,
    target,
    packages,
    manifestPaths,
    featureIdentity,
    buildsNative: ["build", "check", "clippy", "test", "run", "bench", "rustc"].includes(command),
    wasmBuild:
      /wasm-pack(?:\.exe)?$/.test(executable) ||
      /^wasm/.test(effectiveTarget) ||
      packages.includes("era-web-wasm") ||
      manifestPaths.some((name) => /(?:^|[/\\])era-web-wasm[/\\]Cargo\.toml$/.test(name)),
  };
}

export function cargoFeatureIdentity(args) {
  return cargoCommandIdentity(args).featureIdentity;
}

export function nativeSqlFeatureEnabled(identity) {
  return (
    identity.allFeatures ||
    identity.features.some((name) => name === "native-sql" || name === "era-web-tauri/native-sql")
  );
}
