# dsh-relay-direct

English | [简体中文](README.zh-CN.md)

Keep your LLM relay (中转站) reachable when a VPN client has hijacked your proxy environment.

A [DSH](https://github.com/deepseek-ai) profile bundle. Ships one cordis entry that re-installs the outbound proxy policy with your relay hosts in `NO_PROXY`.

## The problem

VPN clients export `HTTP_PROXY` / `HTTPS_PROXY` into their process tree. DSH's launcher reads those variables **before any plugin mounts** and installs them as undici's global dispatcher - so *every* model request goes through the tunnel.

That is wrong for a relay that does not need a tunnel. With the VPN on you take a pointless detour; **with the VPN off the proxy port is dead and every model call fails.**

The launcher's policy has no mutable interface, so this bundle re-installs it from the same environment with your relay hosts merged into `NO_PROXY`. Everything else keeps using the proxy exactly as before.

## Which hosts

**Read from your own configuration, not hardcoded.** The entry composes your profile the same way the launcher does (the launcher's own `loadProfileDirectory` + `composeEntries`, over an empty root) and collects the `hostname` of every `baseURL` it finds - so pointing DSH at a different relay needs no edit here.

It reads all three layers: bundle, profile (`profiles/<name>/cordis.patch.yml`) and home (`$DSH_HOME/cordis.patch.yml`). A built-in list applies only if that lookup fails outright.

## Install

Pinned to a tag, the same shape as other DSH bundles:

```powershell
cd $DSH_HOME\profiles\desktop
pnpm add "https://github.com/ccccqiang/dsh-relay-direct/archive/refs/tags/v0.1.1.tar.gz"
```

Then add it to the profile manifest - **both** places, in `profiles/desktop/package.json`:

```json
"dependencies": { "dsh-relay-direct": "https://github.com/.../v0.1.1.tar.gz" },
"dsh": { "profile": { "bundles": [ "...", "dsh-relay-direct" ] } }
```

Install the dependency, then **fully quit DSH Desktop (tray too) and reopen it.** The profile patch is read once at startup.

It then appears under **主页 → 插件** with a working on/off toggle. Toggling off writes `disabled: true` into this package's own `cordis.patch.yml`.

## Verify

On startup the entry writes one line to stderr:

```
relay-direct: pinned to a direct connection: www.example-relay.ai, example-relay.ai
```

Under the DSH Desktop GUI that line may not reach a log file. To prove routing without restarting, install the launcher-time policy from a fake VPN environment, run `apply()`, and re-read the routes:

```js
const env = new Map(Object.entries(process.env).map(([k, v]) => [k, { value: v }]));
await proxy.installProxyFromEnvironment(env, () => {});
const route = (u) => proxy.proxyRouteFor(new URL(u)).proxied ? "PROXY" : "DIRECT";

await (await import(entryPath)).apply({ on() {} });
console.log(route("https://www.example-relay.ai/v1"));  // DIRECT
console.log(route("https://example.com/x"));            // PROXY
```

**`proxyRouteFor()` takes a `URL`, not a string.** A string has no `.protocol`, so it always reports a direct route and looks like the bundle failed.

## Design notes

**Re-install, never hand-build an Agent.** `proxyForUrl()` and the dispatcher must never disagree; a hand-built `Agent` silently breaks that agreement for `dsh-web-fetch-http`. `installProxyFromEnvironment` is re-callable - each call stores the previous dispatcher and returns a disposer.

**Live-reload safe.** A rebuilt fiber is created before the previous one disposes, so a generation counter makes only the newest installation responsible for tearing the dispatcher down.

**No `peerDependencies` on purpose.** `evaluatePluginCompatibility` returns `undefined` when a manifest declares none, which skips the version pre-flight entirely. Declaring `@deepseek-ai/dsh` peers would deny the bundle after every DSH upgrade.

**`lib/relay-direct.mjs` is the entry, declared as both `main` and `exports`, so the bundle's patch row can name the package instead of a path.

**Relative module names resolve against the patch file's own directory** and are rewritten to absolute `file:///` URLs on load, so the entry module must stay inside the package.

## Uninstall

Remove `dsh-relay-direct` from both `dependencies` and `dsh.profile.bundles` in `profiles/desktop/package.json`, then run `pnpm install`. Nothing outside the profile is touched.

## License

MIT
