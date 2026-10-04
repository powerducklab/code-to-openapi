# 剩余框架深度迭代：Fiber、Rocket、FastEndpoints / ASP.NET

本轮沿用上轮固定的 GitHub 提交，实际扫描 Fiber recipes/swagger、Rocket examples/serialization、FastEndpoints Benchmark/FastEndpointsBench。没有运行这些后端项目、数据库或用户代码，也没有将源码发送给 AI。仓库、提交和子目录在 `projects.json`。

## 修复

### Fiber

- 解析 `new(models.Book)` 与 `[]models.Book`：先核对当前文件的 import 与本地目录，再要求类型唯一；不按短名称随意选择其他包的同名 DTO。
- 根据 `Envelope{Data: book}`、`Envelope{Data: books}`、`Data: nil` 区分 interface 字段的对象、数组、null 返回结构。专门化结果不修改共享 Envelope 组件，避免一条路由污染另一条路由。
- 导入或嵌入类型仍存在不明字段时保留 schema gap，降低置信度，不因识别到外层 `$ref` 就宣称完整。

### Rocket / Rust

- 按 `data` 属性名读取请求体绑定，不再错误地读取第二个字符串（第二个字符串可能是 `format="json"`）。
- 挂载按模块路径和函数名匹配；同名函数不会串用其他模块的前缀，同时支持主模块中的 `routes![api::get]`。
- 同文件类型优先，冲突类型使用不同组件名；没有本地证据的跨模块歧义不再采用 first-wins。
- 支持本地类型别名、`&str`、带生命周期的 `Cow<'a, str>`；过滤生命周期参数，避免把生命周期当作 schema 类型。
- 补充 MsgPack 请求/响应媒体类型、Option responder 的 404 分支、Result responder 的分支类型。类型归属表按 analysis 缓存，避免对每个文件重复遍历整个项目。

### FastEndpoints / C# / ASP.NET

- 支持新版 `Send.OkAsync()` 等调用，保留多状态分支，并提取匿名对象、显式 new DTO 的返回 schema。
- 复杂 `[FromQuery]` 使用递归点号字段名，不再把整个 query DTO 误写成 JSON 请求体；混合 DTO 保留其余 body 字段。
- path 参数优先使用请求 DTO 中匹配字段的类型。
- 补充 struct DTO 的公开属性，修复可空类型 `int?`、`Guid?`、`T?`、`Nullable<T>` 的 null 信息丢失。可选与可空是不同概念，未删除原有 required 断言。
- C# 解析错误增加显式 unresolved；缺少请求 DTO 时保留 body schema gap。

## 独立核验结果（仍有未通过项）

| 框架 | 路由数 | 检查项 | 未匹配项 |
|---|---:|---:|---:|
| Fiber | 4 | 138 | 51（上轮同一基线为 73） |
| Rocket | 6 | 112 | 31 |
| FastEndpoints | 10 | 336 | 92 |

三份结果均成功转换为结构合法的 OAS；这不代表字段正确率 100%。未匹配项不是独立 bug 数，单个未知 DTO 会影响多项断言。

Rocket 和 FastEndpoints 的基线本轮才建立，不能与上轮扫描路由数直接换算准确率。C# 可空修复在本轮相同基线上将 FastEndpoints 差异由 134 降至 92；其余差异保留，不通过缩小基线或放宽断言消除。

### 尚未解决 / 不能认证的部分

- **Fiber**：上游 Swagger 将 GetBookByID 的对象写成数组；未声明的 required 与 Go 实际序列化规则有差异。外部 `gorm.Model` 源码不在所扫子项目内，其嵌入字段尚未展开；输出的外部嵌入类型仍不能视作精确。跨包同名类型、别名链和复杂构造调用未全覆盖。
- **Rocket**：动态 `json!` 返回体和注册的 catcher 响应字段尚未完整推断；Option 的 null、字段序列化时是否出现、特定返回构造的 required 仍需区分。宏注册、内联 module、路由别名、compact MsgPack、自定义 Serialize/Responder 不在本次通过范围内。
- **FastEndpoints**：FluentValidation 的 NotEmpty/GreaterThan 等约束尚未全部映射；输入必填与响应始终输出字段需要独立建模。框架自身的 EmptyResponse 未随子项目扫描。CodeGenEndpoint 使用 `public partial class SerializerCtx : JsonSerializerContext;`，当前 WASM C# grammar 将该声明与后续 DTO 错误恢复解析，已明确报告 unresolved，未伪造缺失 DTO。自定义 binder、过滤器、序列化器、复杂集合 query 的索引键仍需独立覆盖。
- 其他框架的全字段独立核验尚未全部完成。本次没有修改前轮已归档结果来掩盖这一点。

## 基线与复现

`examples/audit-remaining-baselines.py` 是人工阅读上述固定源码后编写的独立契约生成脚本，不读取 scanner 输出。Rocket 基线依据 json.rs、msgpack.rs、uuid.rs；FastEndpoints 基线依据 10 个 endpoint、DTO、validator 和库内 EmptyResponse 定义。Fiber 继续使用前轮上游 Swagger 转换基线。基线包含可空类型和已知校验约束，记录的是需要实现的契约，不是为当前提取结果量身生成的快照。

```sh
python3 examples/audit-remaining-baselines.py
python3 examples/audit-github.py docs/audits/2026-10-04-remaining/projects.json /tmp/remaining-audit
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-remaining/rocket-baseline.json /tmp/remaining-audit/rocket.json /tmp/rocket-result.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-remaining/fastendpoints-baseline.json /tmp/remaining-audit/fastendpoints.json /tmp/fastendpoints-result.json
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-contracts/fiber-baseline.json /tmp/remaining-audit/fiber.json /tmp/fiber-result.json /api
```

比较器检查声明字段、约束、参数、媒体类型与状态，不检测所有额外字段/额外 body、所有 JSON Schema 关键字或运行时行为。不同 anyOf 表达的语义等价未归一化。报告不能当成生产完备性认证。

回归新增跨文件 Rocket 挂载/同名 DTO、format/data 顺序、MsgPack、FastEndpoints query/struct/现代 Send、多响应状态，以及 Fiber 导入 DTO/interface payload；旧 ASP.NET nullable 断言在核对真实 fixture 类型后改为明确接受 null，未改为宽松匹配。

实现依据：[Rocket responder](https://rocket.rs/guide/master/responses/)、[Rocket MsgPack](https://api.rocket.rs/v0.5/rocket/serde/msgpack/struct.MsgPack)、[FastEndpoints model binding](https://fast-endpoints.com/docs/model-binding)、[FastEndpoints Send helpers](https://fast-endpoints.com/docs/misc-conveniences)。本地固定 Rocket 源码的 MsgPack 默认 COMPACT=false，调用 to_vec_named；不能将此假设扩展到所有旧版 Rocket 或显式 compact 类型。

## 最终验证

- `npm run check -- --maxWorkers=2`：102 个测试文件，295 项全部通过。
- `npm run build`：类型检查、ESM/CJS、声明文件构建通过。
- `node test/smoke-dist.mjs`：PHP/Rust/Java/C# 发布产物及 worker-thread smoke 通过。
- `git diff --check`：通过。未发布 npm 包。
