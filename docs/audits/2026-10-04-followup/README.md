# 剩余框架跟进：FastEndpoints、Rocket

沿用 ../2026-10-04-remaining/projects.json 固定的 GitHub 提交及独立契约基线。本轮未修改基线、未执行后端项目、未调用 AI；扫描代码及转换 OAS 后进行字段断言。静态核验不等于真实服务集成测试。

## 本轮修复

- FastEndpoints：读取唯一匹配 Validator<T> 构造函数中的直接 RuleFor 链，映射 NotEmpty/NotNull、整数范围约束。跳过条件链、条件代码块和 DontAutoValidate。保留初始化字段的可省略语义。请求 schema 单独克隆，不修改响应共享 DTO。
- C#：针对旧 WASM grammar 将分号类声明后续 DTO 吞入类体的问题，只修复 AST 确认的 class ERROR 分号边界，再解析。固定真实示例 CodeGenRequest 可以恢复；不对注释或字符串全文替换。修复循环有次数及节点数限制。
- Rocket：从实际返回位置的 json! 提取静态字段和标量类型，忽略无关局部 json!；对动态表达式保留未知 schema。按 register 前缀和 catcher 名称补充已有状态的响应，较具体前缀优先。

## 同一独立基线结果

| 框架 | 路由 | 检查项 | 上轮差异 | 本轮差异 |
|---|---:|---:|---:|---:|
| FastEndpoints | 10 | 336 | 92 | 29 |
| Rocket | 6 | 112 | 31 | 5 |

结果保存在 fastendpoints-result.json、rocket-result.json。差异数量不是独立 bug 数，也不应换算为产品整体准确率。Fiber 本轮未改，其上轮 51 项差异仍未解决。

## 未完成事项

- FastEndpoints：请求缺省值与响应始终序列化字段需分别建模；EmptyResponse 等外部框架类型未完整展开。尚不支持全部 FluentValidation 规则、全局禁用校验配置、复杂条件、自定义绑定和序列化。NotEmpty 的 minLength 不能完整表达禁止纯空白字符串的语义。
- Rocket：剩余 5 项涉及 Option 字段 null、响应字段 required，以及动态 json! id 表达式的整数类型/format。跨模块 catcher、动态/嵌套宏值、自定义 Serialize/Responder 等仍需覆盖。
- C# grammar 兼容修复是有界恢复，不代表支持所有新语言语法。其他解析错误继续报告 unresolved。
- 比较器只检查基线声明的字段/约束，不完整检测额外字段、所有 schema 关键字、运行时分支或等价 anyOf 表达。

## 验证

- npm run check -- --maxWorkers=2：102 个测试文件、298 项通过。
- 随后新增默认值/条件块/自动校验关闭回归，定向测试 8 项通过；包含数值边界保护后的类型检查与构建通过。
- npm run build：ESM、CJS、声明文件构建通过。
- node test/smoke-dist.mjs：PHP/Rust/Java/C# 产物及 worker-thread smoke 通过。
- git diff --check：通过。未发布 npm 包。

## 复现

先按上轮 projects.json 检出固定提交，然后执行：

```sh
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-fastendpoints/Benchmark/FastEndpointsBench /tmp/fe-followup.json
node --import tsx examples/scan-audit-project.ts /tmp/realproj2-rocket/examples/serialization /tmp/rocket-followup.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-remaining/fastendpoints-baseline.json /tmp/fe-followup.json /tmp/fe-result.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-remaining/rocket-baseline.json /tmp/rocket-followup.json /tmp/rocket-result.json
```

校验语义参考：[FluentValidation 条件](https://docs.fluentvalidation.net/en/latest/conditions.html)、[内置校验规则](https://docs.fluentvalidation.net/en/latest/built-in-validators.html)。真实样本提交信息和前轮证据保留在 ../2026-10-04-remaining，不覆盖历史结果。
