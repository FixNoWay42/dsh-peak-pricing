# 安装 @deepseek-ai/dsh-peak-pricing

`@deepseek-ai/dsh-peak-pricing`（v0.1.0-rc.6）是一个 Cordis 函数插件：在配置的高峰计价时段内，将 agent 的模型请求路由到预设的廉价模型，避免价格高峰命中昂贵的会话选型。

## 前置要求（Prerequisites）

- **Node.js**：`^22.19` 或 `>=24`（deepseek-harness monorepo 的 engines 范围）。
- **pnpm**：用于安装依赖与运行测试套件。
- **Cordis 宿主**：deepseek-harness（dsh）部署，或任何挂载了 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis` 的 Cordis 应用；插件注入 `agents` 服务（`inject: ['agents']`）并监听 `agent/request` waterfall，运行时三者缺一不可。

Peer dependencies（对等依赖）由宿主提供，本包不会安装它们：`@deepseek-ai/cordis`（^4.0.1）、`@deepseek-ai/dsh-agent`（^0.1.0-rc.6）、`@deepseek-ai/dsh-invariants`（^0.1.0-rc.6）、`@deepseek-ai/dsh-llm`（^0.1.0-rc.6）。

## 方式 A：在 deepseek-harness monorepo 中挂载

`@deepseek-ai/dsh-peak-pricing` 是 deepseek-harness monorepo 的 workspace 成员（packages/llm/peak-pricing），因此无需单独 `npm install` —— pnpm 会从 workspace 直接解析该包。

在 `cordis.yml` 中添加一条目即可：

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
```

该条目以内置默认值挂载（时区 `Asia/Shanghai`，时段 09:00-12:00 与 14:00-18:00）；只有预设选型（preset）是必填的：

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    peak:
      provider: deepseek
      model: deepseek-chat
```

`peak.provider` 与 `peak.model` 必填并在加载时校验；未知时区、非法或空时段、无法解析的 `effectiveFrom`、缺失预设字段都会在插件挂载时立刻报错。

## 方式 B：作为独立包安装

在任何宿主已提供 peer dependencies 的 Cordis 应用中：

```bash
pnpm add @deepseek-ai/dsh-peak-pricing
```

peer dependencies —— `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-llm`（^0.1.0-rc.6）与 `@deepseek-ai/cordis`（^4.0.1）—— 必须与宿主挂载的版本匹配；版本不匹配时 pnpm 会报告。

然后在你自己的 `cordis.yml` 中挂载插件：

```yaml
- name: '@deepseek-ai/dsh-peak-pricing'
  config:
    timezone: Asia/Shanghai
    peakWindows:
      - start: '09:00'
        end: '12:00'
      - start: '14:00'
        end: '18:00'
    effectiveFrom: '2026-08-17T00:00:00+08:00'
    peak:
      provider: deepseek
      model: deepseek-chat
```

## 方式 C：从源码安装

```bash
git clone http://liuyuesong.asia:8360/open/dsh-peak-pricing.git
cd dsh-peak-pricing
pnpm install
pnpm run build
```

`pnpm run build` 执行 `tsc -p tsconfig.json && tsdown`；产物输出到 `lib/` —— `lib/index.js`、`lib/invariant.js` 以及 `lib/types/` 下的类型声明。按方式 B 的写法在你的 `cordis.yml` 中挂载构建产物。

## 验证安装

在仓库中运行测试套件：

```bash
pnpm run test
```

17 个测试全部通过，分布在三个 spec（`peak-pricing`、`invariant`、`loader-composition`）中，其中包含一个真实的 Loader 组合测试：它通过真正的 Cordis Loader 连同宿主插件（dsh-llm、dsh-session、dsh-system-prompt、dsh-tools、dsh-agent、dsh-agent-loop）一起启动本插件，并逐个请求断言实际服务的模型。

然后启动宿主并观察日志：插件挂载后，高峰时段内的 agent 模型请求携带预设的 `provider`/`model` 组合而非会话选中的模型；时段外的请求保持会话选型。

## 版本兼容性

peerDependencies 与本版本构建所对应的 npm 发布版本一致：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-llm` 为 `^0.1.0-rc.6`，`@deepseek-ai/cordis` 为 `^4.0.1`。
