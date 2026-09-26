# dsh-relay-direct

[English](README.md) | 简体中文

当 VPN 客户端劫持了你的代理环境时，让你的 LLM 中转站依然保持直连可达。

一个 [DSH](https://github.com/deepseek-ai) 配置档（profile）bundle。它只提供一个 cordis 入口：把你的中转站主机名合并进 `NO_PROXY`，并以此重新下发出口代理策略。

## 要解决的问题

VPN 客户端会把 `HTTP_PROXY` / `HTTPS_PROXY` 导出到它的整个进程树里。DSH 启动器会在**任何插件挂载之前**读取这些变量，并把它们安装成 undici 的全局 dispatcher —— 于是*每一次*模型请求都会钻进隧道。

对于一个根本不需要隧道的 LLM 中转站来说，这是错的。VPN 开着，你白白绕一大圈；**VPN 一关，代理端口就是死的，每一次模型调用都会失败。**

启动器安装的那份策略没有可变接口，所以本 bundle 用同一份环境变量把策略重新安装一遍，只是额外把中转站主机名并入了 `NO_PROXY`。其余一切照旧走代理，行为完全不变。

## 哪些主机名会被加进去

**来自你自己的配置，不是写死的。** 入口模块用与启动器完全相同的方式组合你的配置档（复用启动器自己的 `loadProfileDirectory` + `composeEntries`，跑在一个空的 root 之上），并收集它找到的每一个 `baseURL` 的 `hostname` —— 所以你把 DSH 换成另一个中转站时，这里一个字都不用改。

它会读取全部三层：bundle 层、配置档层（`profiles/<name>/cordis.patch.yml`）和 home 层（`$DSH_HOME/cordis.patch.yml`）。内置列表仅在上述查找彻底失败时才会生效。

## 安装

按 tag 固定版本，与其他 DSH bundle 的形态一致：

```powershell
cd $DSH_HOME\profiles\desktop
pnpm add "https://github.com/ccccqiang/dsh-relay-direct/archive/refs/tags/v0.1.1.tar.gz"
```

然后把它写进配置档清单 —— **两处都要写**，位置在 `profiles/desktop/package.json`：

```json
"dependencies": { "dsh-relay-direct": "https://github.com/.../v0.1.1.tar.gz" },
"dsh": { "profile": { "bundles": [ "...", "dsh-relay-direct" ] } }
```

装好依赖后，**把 DSH Desktop 彻底退出（托盘图标也要退）再重新打开。** 配置档的 patch 只在启动时读一次。

之后它就会出现在 **主页 → 插件** 里，并带一个可用的开/关开关。关掉它会往本包自己的 `cordis.patch.yml` 写入 `disabled: true`。

## 验证

启动时入口模块会往 stderr 写一行：

```
relay-direct: pinned to a direct connection: www.example-relay.ai, example-relay.ai
```

在 DSH Desktop 的 GUI 下，这一行未必会落到日志文件里。想在不重启的前提下证明路由走向，可以用一个假的 VPN 环境装回启动期的策略，跑一次 `apply()`，再重新读路由：

```js
const env = new Map(Object.entries(process.env).map(([k, v]) => [k, { value: v }]));
await proxy.installProxyFromEnvironment(env, () => {});
const route = (u) => proxy.proxyRouteFor(new URL(u)).proxied ? "PROXY" : "DIRECT";

await (await import(entryPath)).apply({ on() {} });
console.log(route("https://www.example-relay.ai/v1"));  // DIRECT
console.log(route("https://example.com/x"));            // PROXY
```

**`proxyRouteFor()` 收的是 `URL`，不是字符串。** 字符串没有 `.protocol`，它会永远报直连，看起来就像这个 bundle 没生效。

## 设计取舍

**重新安装策略，绝不手搓 Agent。** `proxyForUrl()` 与 dispatcher 必须永远不给出一致性之外的答案；手搓一个 `Agent` 会悄悄打破这份一致性，进而弄坏 `dsh-web-fetch-http`。`installProxyFromEnvironment` 是可重复调用的 —— 每次调用都会存下前一个 dispatcher，并返回一个 disposer。

**对热重载安全。** 重建的 fiber 会在上一个 dispose 之前创建，所以用一个代际计数器保证只有最新的一次安装才有权拆掉 dispatcher。

**故意不声明 `peerDependencies`。** 当清单里一个 peer 都没声明时，`evaluatePluginCompatibility` 返回 `undefined`，直接跳过整个版本预检。要是声明了 `@deepseek-ai/dsh` 这类 peer，DSH 每次升级都会导致这个 bundle 被拒绝加载。

**`lib/relay-direct.mjs` 就是入口**，同时声明为 `main` 和 `exports`，这样本 bundle 的 patch 行可以写包名，而不是写路径。

**相对模块名是相对于 patch 文件自身所在目录解析的**，并在加载时被改写为绝对的 `file:///` URL —— 所以入口模块必须留在这个包内部。

## 卸载

在 `profiles/desktop/package.json` 里把 `dsh-relay-direct` 从 `dependencies` 和 `dsh.profile.bundles` 两处都删掉，然后执行 `pnpm install`。配置档之外的东西一概不动。

## 许可证

MIT
