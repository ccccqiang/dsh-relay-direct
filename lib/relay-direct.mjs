/**
 * Cordis patch entry: pin this profile's LLM relay endpoints to a direct
 * connection.
 *
 * Why an entry instead of a boot patch: this ships as the dsh-relay-direct
 * profile bundle, which lives outside the dsh installation, so a DSH Desktop
 * upgrade cannot overwrite it and nothing has to watch for one. The bundle's
 * cordis.patch.yml mounts this module; the plugin manager lists and toggles it
 * like any other installed plugin.
 *
 * The launcher installs the outbound proxy policy from the launch environment
 * before any plugin mounts - dsh-http-proxy resolves that policy once per
 * process. By the time this entry runs, an inherited HTTP(S)_PROXY is already
 * undici's global dispatcher. A VPN client exports exactly that, routing relay
 * requests into a tunnel they do not need, and into a dead port once the
 * tunnel is off.
 *
 * WHICH HOSTS: read from the profile's own composed configuration rather than
 * hardcoded. The relay the user points DSH at is declared in the llm-pi-ai
 * provider config (its baseURL), so this bundle works unchanged for any relay
 * without the user editing it. DEFAULT_HOSTS is only a last resort for when
 * that lookup fails outright.
 *
 * The installed policy has no mutable interface, so this re-installs it from
 * the same environment with the relay hosts merged into NO_PROXY. Re-installing
 * keeps one implementation deciding routes, which matters: proxyForUrl() and
 * the dispatcher must never disagree, and a hand-built Agent would silently
 * break that agreement for dsh-web-fetch-http.
 *
 * LIVE RELOAD: this profile runs patchReload "live", so a rebuilt fiber is
 * created before the previous one disposes. A generation counter makes only
 * the newest installation responsible for tearing the dispatcher down.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Last-resort list, empty by default on purpose.
 *
 * The live list is read from the profile configuration, so a user pointing DSH
 * at some relay needs no edit here - and shipping one deployment's hostnames
 * would leak which relay that deployment talks to, which is nobody else's
 * business. Configure $DEFAULT_HOSTS in a fork if you want a fallback.
 *
 * Empty means "no hosts pinned" when the lookup fails, which degrades to the
 * launcher's untouched policy rather than to something surprising. The failure
 * is reported, so it cannot pass silently.
 */
const DEFAULT_HOSTS = [];

const NO_PROXY_NAMES = ["no_proxy", "NO_PROXY"];
const LOG_PREFIX = "relay-direct: ";
/** This package's own name, used to recognize the profile that installed it. */
const SELF_PACKAGE = "dsh-relay-direct";
/** Home-relative directory holding every profile. */
const PROFILES_DIR = "profiles";

let generation = 0;

function report(message) {
  process.stderr.write(LOG_PREFIX + message + "\n");
}

/** The dsh application directory next to the running executable, when it is DSH Desktop. */
function appDir() {
  const exe = process.execPath;
  if (typeof exe !== "string" || !/DSH Desktop\.exe$/i.test(exe)) return undefined;
  return join(dirname(exe), "resources", "app");
}

/**
 * Resolve an installation package: the bare specifier inside DSH, where the
 * profile's resolver maps these names, and the app's own tree otherwise - so
 * the same module also runs under a plain-Electron probe.
 */
async function loadInstallationModule(name, subpath) {
  const candidates = [name];
  const app = appDir();
  if (app !== undefined) candidates.push(pathToFileURL(join(app, "node_modules", name, "lib", subpath)).href);
  let last;
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch (error) {
      last = error;
    }
  }
  report("could not load " + name + " (" + String(last && last.message) + ")");
  return undefined;
}

/**
 * This profile's directory, derived from where this module sits:
 * <profile>/node_modules/<package>/lib/relay-direct.mjs.
 *
 * Preferred over reading DSH_HOME because it needs no profile name and stays
 * correct when the profile is not the default one. Under a hoisted nodeLinker
 * pnpm copies the package here, so the walk sees a real directory.
 */
function profileDirFromModule() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    if (basename(dir) === "node_modules") return parent;
    dir = parent;
  }
}

/**
 * The profile that lists this package in dsh.profile.bundles, found under the
 * Harness home. Used when the module path was resolved through a link.
 *
 * DSH_HOME is bootstrap-only - no .env may set it - so reading it from the
 * process environment is sound.
 */
function profileDirFromHome() {
  const home = process.env.DSH_HOME;
  if (typeof home !== "string" || !home) return undefined;
  const base = join(home, PROFILES_DIR);
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const bundles = manifest?.dsh?.profile?.bundles;
      if (Array.isArray(bundles) && bundles.includes(SELF_PACKAGE)) return dir;
    } catch { }
  }
  return undefined;
}

/** The dsh installation's package.json: the launcher's first bundle-resolution anchor. */
function installAnchor(profileDir) {
  const app = appDir();
  if (app !== undefined) return join(app, "node_modules", "@deepseek-ai", "dsh", "package.json");
  return join(profileDir, "package.json");
}

/**
 * Every host named by a baseURL anywhere in a row's configuration.
 *
 * Recursive rather than provider-shaped on purpose: the relay is declared under
 * providers.<id>.baseURL today, and any other plugin that names an endpoint
 * would be missed by a narrower read.
 */
function hostsFromConfig(config, hosts, seen) {
  const visited = new Set();
  const add = (host) => {
    const key = host.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hosts.push(host);
  };
  const walk = (node) => {
    if (node === null || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "baseURL" && typeof value === "string") {
        let hostname;
        try {
          hostname = new URL(value).hostname;
        } catch {
          report("ignoring an unparseable baseURL: " + value);
          continue;
        }
        // Loopback and single-label names are already unroutable through a
        // proxy, so adding them would only add noise.
        if (!hostname || hostname === "localhost" || hostname.includes(":") || !hostname.includes(".")) continue;
        add(hostname);
        // NO_PROXY accepts a bare suffix, so the registrable domain covers the
        // apex and its subdomains; the exact host is added too, for matchers
        // that only compare literally.
        const labels = hostname.split(".");
        if (labels.length > 2) add(labels.slice(1).join("."));
        continue;
      }
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(config);
}

/**
 * Read the relay hosts out of the profile's composed configuration.
 *
 * The launcher's own composer is reused rather than the live Loader tree. It
 * applies every patch layer over an empty root - pure YAML plus object merging
 * - so it yields the final config no matter whether this entry happens to run
 * before or after llm-pi-ai mounts. The Loader tree is not reliable here: the
 * profile's own layer is folded into the root include entry's config, so its
 * rows are not addressable as early as this one runs.
 *
 * An empty result is normal and makes the caller fall back.
 */
async function discoverRelayHosts() {
  const profileDir = profileDirFromModule() ?? profileDirFromHome();
  if (profileDir === undefined) {
    report("could not locate the profile directory, falling back");
    return [];
  }
  const boot = await loadInstallationModule("@deepseek-ai/dsh-app-boot", "index.js");
  if (boot === undefined) return [];
  try {
    const profile = boot.loadProfileDirectory("dsh", profileDir, installAnchor(profileDir), { userLayer: true });
    // The home layer lives at <harness home>/cordis.patch.yml and is applied
    // after every profile layer, so a row it defines outranks the profile's.
    // The relay providers live there on purpose: dsh-config-editor rewrites a
    // profile row's config wholesale when the Settings UI saves, which is how
    // they get dropped, and it never touches the home layer.
    const homePatchFile = join(dirname(dirname(profileDir)), "cordis.patch.yml");
    const layers = [
      ...profile.layers.flatMap((layer) => layer.patches),
      ...(profile.patches ?? []),
      ...(boot.loadOptionalPatches("dsh", homePatchFile) ?? []),
    ];
    // A silent sink: composing over an empty root reports every id-targeted
    // override whose base row lives in a lower include. That is expected here
    // and not worth a line of output.
    const composed = boot.composeEntries(layers);
    const hosts = [];
    const seen = new Set();
    for (const row of composed) hostsFromConfig(row.config, hosts, seen);
    return hosts;
  } catch (error) {
    report("could not compose the profile configuration, falling back (" + String(error && error.message) + ")");
    return [];
  }
}

/** The launch environment in the Map shape installProxyFromEnvironment reads. */
function environmentSnapshot() {
  const env = new Map();
  for (const [name, value] of Object.entries(process.env)) env.set(name, { value });
  return env;
}

/** Every NO_PROXY spelling, with the relay hosts present and the caller's entries intact. */
async function withRelayHosts() {
  let hosts = await discoverRelayHosts();
  if (hosts.length === 0) {
    hosts = DEFAULT_HOSTS;
    report(hosts.length > 0
      ? "no relay host in the profile configuration, falling back to the built-in list"
      : "no relay host in the profile configuration and no built-in list, leaving the launch-time policy in place");
  }
  const parts = [];
  const seen = new Set();
  for (const name of NO_PROXY_NAMES) {
    const raw = process.env[name];
    if (typeof raw !== "string") continue;
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
      parts.push(trimmed);
      seen.add(trimmed.toLowerCase());
    }
  }
  for (const host of hosts) {
    if (seen.has(host.toLowerCase())) continue;
    parts.push(host);
    seen.add(host.toLowerCase());
  }
  const env = environmentSnapshot();
  for (const name of NO_PROXY_NAMES) env.set(name, { value: parts.join(",") });
  return { env, hosts };
}

export async function apply(ctx) {
  const proxy = await loadInstallationModule("@deepseek-ai/dsh-http-proxy", "index.js");
  if (proxy === undefined) {
    report("leaving the launch-time policy alone");
    return;
  }

  const mine = ++generation;
  const { env, hosts } = await withRelayHosts();
  let dispose;
  try {
    dispose = await proxy.installProxyFromEnvironment(env, report);
  } catch (error) {
    report("installing the corrected policy failed, leaving the launch-time policy in place (" + String(error && error.message) + ")");
    return;
  }
  report("pinned to a direct connection: " + hosts.join(", "));

  if (ctx && typeof ctx.on === "function") {
    ctx.on("dispose", async () => {
      // A live reload builds the replacement first, so only the newest
      // installation is allowed to take the dispatcher down.
      if (mine !== generation) return;
      generation = 0;
      try {
        await dispose();
      } catch { }
    });
  }
}
