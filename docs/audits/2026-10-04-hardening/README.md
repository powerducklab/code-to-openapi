# 精准度与健壮性加固：2026-10-04

**结论：本轮修复已验证，但尚不能认证全产品达到 9.5/10。** 已完成 28 个固定 GitHub 项目的静态扫描复验、扩展独立字段核验和健壮性回归。语法合法、路由数量和测试通过率都不等于完整准确率。

## 实现变更

- Rust：Option 的显式 null 与输入可省略分开处理；泛型替换、包装类型及递归泛型展开增加边界，避免栈溢出。递归泛型超出可推断范围仍产生未知 schema，不能视为完整模型。
- Rocket：独立生成序列化组件，支持基本 Serde default/skip/skip_serializing/skip_deserializing/skip_serializing_if 的存在性差异；解析已证明类型的 Mutex/Vec 别名链和 len 返回值，不把任意自定义 len 方法当作整数。仅无其他显式 return 的直接尾部构造可收窄 Some 标量字段，共享组件不被修改。
- FastEndpoints：请求/响应模型分离；默认序列化存在性、JsonIgnore 条件、全局忽略默认值策略与输入验证分开处理。路径绑定字段不要求 JSON 再提供一份。补充框架 EmptyResponse，保留本地同名类型优先。组件重命名与递归引用统一处理，避免同名覆盖。
- Fiber：输入缺省字段不再依据输出字段规则标为必填；503 等状态正确识别，未知状态不再伪装成 200，同状态多个响应不再互相覆盖。
- Go 外部嵌入：缺少 gorm.Model 源码时不伪造 Model JSON 属性，明确记录 x-code-to-openapi-unresolved-embedded；Fiber 继续保留 schema gap。
- Go HTTP：根据本地函数实际 WriteHeader/JSON Encode 实现识别响应封装，验证调用者传入 ResponseWriter；支持接收器方法，拒绝修改状态/载荷参数的封装。抽取共用的本地跨包 DTO 解析，要求 import 路径与源码目录匹配，避免按短名称猜类型。
- 独立核验新增 --strict：差异、基线问题或空核验返回非零退出码，可作为 CI 阻断条件。

## 独立核验结果

| 样本/基线 | 检查项 | 差异 |
|---|---:|---:|
| fastify | 626 | 0 |
| actix | 84 | 0 |
| fastendpoints | 336 | 0 |
| rocket | 112 | 0 |
| fiber-source | 170 | 0 |
| petclinic | 5523 | 1 |
| fiber | 171 | 56 |
| gin | 264 | 93 |
| echo | 1096 | 492 |
| nethttp | 435 | 240 |

这些检查项不能直接相加换算全产品准确率：样本覆盖深度不同，差异可能来自源码、上游文档、静态推断局限或比较器的表示限制。

FastEndpoints 从上一轮 29 项差异降到 0；Rocket 从 5 降到 0，两者未修改独立基线。Go HTTP 原先 23 项缺失响应已消除；响应进入比较后，断言数从 131 增加至 435，字段缺口也被暴露，因此不能用新旧差异总数直接判断退化。

### 基线修正与未完成项

- Fiber 上游 Swagger 的 body required=true 在旧归一化文件中丢失。新增 swagger2-audit-baseline.py 从固定上游文件生成版本，保留 required、formData 和媒体类型，历史文件不改。
- Fiber 上游把单书对象写成数组、把实际 Data:nil 写成 object，且没声明实际总会输出字段的 required。原始 56 项差异完整保留；另外人工阅读相同提交 handlers/book.go/models/book.go，独立编写了 source-known oracle，170 项通过。它**不覆盖外部 gorm.Model 字段、DB 行为、nil slice 分支**，不是为了消除原始核验失败而替换基线。
- Spring `/api/oops` 只有上游契约，没有对应实现，不生成虚假路由。
- Gin、Echo、Go HTTP 的新独立核验仍有明显差异，含嵌套 DTO、服务接口返回值、分页辅助函数、错误分支和上游声明不符。不能宣称这些框架已完成。
- 28 框架中其余项目尚未全部建立全字段独立 oracle；本报告未把结构扫描当作字段认证。
- Serde 高级 rename/flatten/custom serializer、所有 C# 序列化器/全局配置、复杂校验逻辑、跨模块复杂注册等不在本轮完整认证范围内。

## 验证证据

- 28 个固定 GitHub 提交项目：544 个操作，全部转换为结构有效文档；见 scan-results.json。每次扫描限制 90 秒和 1536 MB Node 堆。
- npm run check -- --maxWorkers=2：105 个测试文件、309 项通过（最后一轮 50.86 秒）。
- npm run build：类型检查、ESM、CJS、声明文件通过。
- node test/smoke-dist.mjs：PHP/Rust/Java/C# 发布产物和 worker-thread 通过。
- git diff --check：通过。未发布 npm 包。
- 实际运行 Go 标准库 JSON 验证 go-json-runtime-check.go：{} 输入成功，输出 title/author/publisher 三个空字符串字段，支持输入/输出存在性分离。没有启动 GitHub 后端服务。当前环境无 rustc/cargo/dotnet，Rust/C# 的证据为 AST/契约回归，不是编译执行认证。

## 复现

先按 ../2026-10-04-contracts/projects.json 检出固定提交并准备其中记录的生成源码：

```sh
python3 examples/audit-github.py docs/audits/2026-10-04-contracts/projects.json /tmp/audit
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-remaining/fastendpoints-baseline.json /tmp/audit/fastendpoints.json /tmp/fe-result.json --strict
node --import tsx examples/audit-contracts.ts docs/audits/2026-10-04-remaining/rocket-baseline.json /tmp/audit/rocket.json /tmp/rocket-result.json --strict
python3 examples/swagger2-audit-baseline.py /tmp/realproj2-fiber-recipes/swagger/docs/swagger.json /tmp/fiber-baseline.json
node --import tsx examples/audit-contracts.ts /tmp/fiber-baseline.json /tmp/audit/fiber.json /tmp/fiber-result.json /api --strict
```

最后一条当前应失败，不能绕过。Gin/Echo 基线来自项目 docs/swagger.json，nethttp 基线来自 api/openapi.yaml；来源与固定 SHA 在 scan-results.json。新增 source oracle 的限制写在文件内，不纳入全产品分数。

实现语义核对：[Serde 字段属性](https://serde.rs/field-attrs.html)、[Go net/http 状态常量](https://go.dev/src/net/http/status.go)。
