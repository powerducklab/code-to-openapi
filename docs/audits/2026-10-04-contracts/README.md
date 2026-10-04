# 深度核验：Fastify 自动加载、Spring 生成接口与真实项目字段

本目录记录一轮增量审查，不代表所有框架已达到无缺失、无误差。扫描结果通过 OAS 校验，不能替代字段完整性核验。

## 已修复

- Fastify：autoload 的 `routeParams` 默认行为、`encapsulate: false`、挂载前缀中的路径参数；嵌套/跨文件 fluent schema 引用；对象 `.prop(...).required()` 与对象自身必填标记的区别。自定义过滤器、动态目录前缀等未静态解析的选项明确报告 unresolved。
- Spring：控制器继承 API 接口的方法映射与参数注解；生成接口的限定路径常量；声明的成功/错误响应 DTO；DTO backing field/getter 注解合并；URI、带 `@Valid` 的泛型元素、校验约束、只读/只写和 required。修复注解描述含 `static` 时误丢弃 getter。
- 显式 `additionalSourceRoots`：可纳入被 Git 忽略的生成 Java 源码，不执行生成器。限制为项目内子目录，保留显式 ignore 与 `.powerduckignore`，去重并规范化真实路径。
- Actix：`web::resource(...).app_data(...).route(...)` 链不再丢失路由；补充 Json extractor 回传和显式 serde 反序列化类型的推断，i32 保留 int32 格式。
- Fiber：识别 v3 `c.Bind().Body(...)`，避免把数据库 `Get` 误认为请求头。无法解析的请求体保留缺口标记，不再把空 schema 标为高置信度。

## 独立字段核验结果

| 样本 | 独立依据 | 检查项 | 差异 |
|---|---|---:|---:|
| Fastify realworld | 原 schema 模块由官方 fluent-json-schema 3.1.0 求值 | 626 | 0 |
| Spring Petclinic | 上游 `src/main/resources/openapi.yml` | 5523 | 1 |
| Actix examples/json/json | 独立逐行阅读 4 个处理函数建立契约 | 84 | 0 |
| Fiber recipes/swagger | 上游 Swagger 2 转换为对照契约 | 138 | 73，未通过 |

检查项含操作、参数位置和必填、请求体必填与媒体类型、响应状态和媒体类型，以及递归字段、类型、格式、约束和必填/可选。它不是“字段数”。本轮加强了可选项检查和 allOf required 合并；没有以宽松断言掩盖差异。

### 必须保留的限制

- Fastify 只对 20 条路由中有有效 schema 引用的 18 条进行上述字段对照。源项目 comments 使用不存在的 `insert` 导出，tags 使用不存在的 `getTags` 导出；另有动态前缀未解析。基线比较的是路径后缀，不证明运行时挂载前缀正确。上游还为一个 204 声明响应体，记录为 baseline issue，不能照抄到 OAS。
- Petclinic `/api/oops` 在上游契约存在，但没有对应控制器实现；不根据文档伪造扫描结果。37 条扫描操作含契约外根重定向。生成源码使用该项目配置的 OpenAPI Generator 7.25.0；没有启动后端应用。
- Fiber 73 项差异包括跨包 `models.Book`、`interface{}` 响应包裹字段，以及上游 GetBookByID 注释把对象写成数组、id 声明与实际读取方式不一致。不能据此把全部差异归责于扫描器，也不能称该样本已通过。
- FastEndpoints 和 Rocket 改为独立可运行示例子目录扫描，避免整个示例集合重名类型/路由污染；本轮未完成它们的全部请求/响应字段独立核验。
- 其余框架仍是静态提取和 OAS 结构回归，尚无全部字段的独立验收。泛型接口类型替换、Spring 多路径映射、动态路由配置、运行时序列化配置和业务分支仍有覆盖边界。
- 比较器不验证额外字段/额外路由、运行时业务行为或所有 JSON Schema 关键字；循环引用停止展开。不能用于宣称任意项目 100% 完整。

## 可复现材料

`projects.json` 固定 28 个 GitHub 项目的提交及扫描子目录，`scan-results.json` 保存本轮结果：544 条操作，28 个样本均通过结构校验。样本路径使用本机临时目录，其他机器需先按固定提交 checkout 并修改路径。

`*-baseline.json` 来自上游契约或独立源码阅读，不由扫描输出生成。Petclinic 基线仅将 YAML 无损转为 JSON；Fiber 将 Swagger definitions/body/response schema 机械转为 OAS content；Actix 手工契约对应该独立小应用。Fastify/Actix 的请求体按框架 JSON body 验证/提取行为标记 required。

```sh
python3 examples/audit-github.py docs/audits/2026-10-04-contracts/projects.json /tmp/deep-audit
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-contracts/petclinic-baseline.json /tmp/deep-audit/spring.json /tmp/petclinic-result.json /api
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-contracts/fastify-baseline.json /tmp/deep-audit/fastify.json /tmp/fastify-result.json
```

Petclinic 需先按项目 pom 的 7.25.0 生成接口和 DTO 到 `target/generated-sources/openapi/src/main/java`。扫描器不会代为运行 Maven 或生成器。生成配置：spring、interfaceOnly、useTags、useSpringBoot3、useJakartaEe、openApiNullable=false、serializationLibrary=jackson、documentationProvider=springdoc，API/model 包与 pom 一致，modelNameSuffix=Dto。

`examples/audit-fastify-oracle.cjs` 可重新求值已审阅的固定 Fastify 示例 schema：参数依次为 checkout 根目录、官方 fluent-json-schema 模块绝对路径、输出 JSON 文件。仅适用于此固定样本；Node VM 不是不可信代码安全沙箱。没有运行数据库、服务实现或后端应用。输出记录按 body/querystring/params/response 映射到对应基线，两个不存在的导出保留为 sourceError。

## 验证

- `npm run check -- --maxWorkers=2`：101 个测试文件、291 项测试通过。
- `npm run build`：类型检查、ESM/CJS 和类型声明构建通过。
- `node test/smoke-dist.mjs`：PHP/Rust/Java/C# 发布产物及 worker-thread 加载通过。
- 最后调整的 Spring 类级路径常量和显式忽略规则另跑定向回归。

实现语义参考：[Fastify autoload](https://github.com/fastify/fastify-autoload)、[Spring request mapping](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html)。实际样本的仓库链接与固定提交见 projects.json。
