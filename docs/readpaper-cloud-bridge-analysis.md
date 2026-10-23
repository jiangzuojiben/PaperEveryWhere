# 0.5 真实写回补充（2026-10-23）

专用文献的真实批注/笔记/进度写回、PDF上传及去重，以及临时收录公开论文的原生版本选择、匹配新版本上传和独立会话字节校验均已通过。笔记接口的pdfUrl可能仍为旧文件，须使用getPdfStatusInfo/v2解析所选版本；文献索引PDF也不一定即时变化。原生服务可能复用noteId和批注，已提示坐标核对。原生手写新增仍未验证。详见 [联机验证](readpaper-live-write-20261023.md) 及 [REA补充证据](../research/readpaper-version-resolution-summary.json)。以下保留此前研究时点的判断。

# ReadPaper 云服务桥接分析

研究日期：2026-10-22（Asia/Hong_Kong）。本轮仅做 REA 静态研究及有限的只读 HTTPS 请求，未操作桌面、提交 AI/全文翻译任务、上传 PDF、刷新登录令牌或改变账号权限。PaperDesk 产品代码与现有迁移包未因本轮研究改变。

## 结论

已找到 ReadPaper 的实际云服务协议，具备开发专用桥接适配器的技术基础。它不是可直接填入 PaperDesk 当前 OpenAI 兼容设置的服务地址：登录方式、请求参数、任务轮询和流式事件均不同。

本轮成功验证账号权限、翻译渠道、AI 豆余额、系统问题列表及全文翻译额度等读取接口；尚未验证任何 AI 生成或全文翻译作业成功。公开报告省略实际账号的会员状态、余额、配额及能力值，功能可用性应按当前账号的服务端响应判断。不能将接口可达、菜单可见、或静态代码中的会员配置当作功能已可用。

## 证据与边界

- 工具固定 `rea-agents@6.7.0`，从已有 npm 缓存运行。没有安装其他 REA 版本或修改 MCP 配置。
- 阅读器完整 bundle 选择性分析在 90000ms 超时；部分 Evidence 为 `ev_5bbd282023b8249abc4053c7cf65a1426dcd6abe3c1ec261397c1df9dc8a4b86`，不作为完整分析通过。
- 使用 Babel 仅解析原模块的惰性语法，定位 32 个相关声明，保留原 SHA256、UTF-16 与字节范围及切片哈希。提取的 8588 字节 REA 样本明确省略依赖和初始化，不冒充原始完整应用。
- 聚焦 REA 分析成功，Evidence `ev_f5f46351d3a4267368eb22b4c886a0388450a5b3a66bc94e664de19a279ee95d`。语义图保留 1459 节点、1324 关系、158 未知项，覆盖仍为 partial；未知项上限产生截断。
- 另以 `pdfId` 属性执行 REA forward-influence 追踪，Evidence `ev_d68f2d4254ecca23c9f33388a05323bfdd7075a44b0ccd9bb160b9de2300a7df`。结果为 ambiguous，只保留1个种子且未建立完整关系，不能据此声称已自动证明端到端请求链；参数契约来自有来源范围的补充语法核对。
- 补充静态解析追踪常量和模块导入/导出，找到 157 个请求候选；这些是补充语法观察，不能当成 REA 联机执行结果或全部云服务清单。另下载当前公开首页引用的 Nuxt 脚本核对学术服务路径。
- 8 项只读联机检查结果与样本哈希见 [研究摘要](../research/readpaper-cloud-summary.json)。原脚本、完整 Evidence、进度和原程序样本只保留在 `.data/readpaper-cloud-research-20261022/`，不作为产品代码分发。

## 云能力与协议

共同前缀为 `https://readpaper.com/api`，以下路径大小写按客户端保留。

| 能力 | 入口与流程 | 已确认内容 |
|---|---|---|
| 有效会员权限 | `GET /microService-app-aiKnowledge/vip/profile` | 实际读取成功。客户端选择 `vipRoles[0].vipPrivilege`；顶层 `vipPrivilege` 不能用作当前有效角色 |
| AI 豆 | `GET /readpaper-pay/pay/bean/count` | 实际读取成功，包含余额及不同场景成本；匿名对照为 HTTP401 / code50008 |
| 论文问答 | `POST /microService-app-aiKnowledge/aiAssistReadingQa/askQuestion` | 静态确认请求对象和结果轮询，未创建问答 |
| 段落解读 | 同服务 `/selectTextQuestion` | 除问题外传选中文字、页号、矩形、viewport；源客户端最多截取8000字符 |
| 图表解读 | 同服务 `/imageQuestion` | 传云端图像地址及页号；本地图像须先上传。未上传或提交任务 |
| 问答结果 | 同服务 `/getAiAnswerById/v2`、`/getList` | 基于 answerId 轮询，使用 `answerInfo.answerStatus`；历史查询以 noteId 分页。未读取私人问答正文 |
| 再答与重试 | 同服务 `/retryByAnswerId`、`GET /answer/change` | 可能创建新答案并产生成本；GET 不能据此视为只读，诊断未调用 |
| 标准问题 | `GET /microservice-ai-reading/systemQuestion/list` | 实际返回10项。此结果不代表问答生成权限 |
| 普通划词翻译 | `POST /microService-translate/ts/zh-cn`；旧有道路径 `/microService-app-aiKnowledge/ts/v1/youdao/zh-cn` | 静态确认；主参数为 content、channel、pdfId、useGlossary。未消耗翻译次数验证正文 |
| 翻译渠道 | `GET /microService-app-aiKnowledge/aiKnowledge/ts/getTranslateTabList` | 实际返回 youdao、baidu、idea、ai；渠道存在不表示有效角色允许使用 |
| AI 翻译 | `POST /microService-translate/ts/eureka/completions` | fetch POST + `text/event-stream`；包含 content、text、pdfId、useGlossary；解析 sseData/targetContent/targetResp 和错误状态 |
| 全文翻译 | `/microService-app-aiKnowledge/fullTextTranslate/getRightInfo` → `/translate` → `/getTranslateStatus` | 先查额度，提交后按 PDF 查询进度并取得翻译 PDF。只调用 getRightInfo，未创建作业 |
| OCR | `/microService-translate/ts/ocr/remainCount`、`/ts/ocr/zh-cn` | 静态路径确认；未发图像请求，使用前须检查当前角色权限与额度 |
| 图表与参考文献解析 | `/microService-app-aiKnowledge/pdfApi/parser/getReferenceMarkers`、`getFiguresAndTables`、`getReference`、`getCitation` | 静态确认 pdfId、分页、needFetch 等等待逻辑；未触发云端解析 |
| 学术发现 | 公开 Nuxt 包中的 `/microService-app-aiKnowledge/aiKnowledge/paper/search`、`getById`、`getReferenceList`、`getCitationList`、`getRelatedPapers` | 路径与来源哈希已记录；getById 对已知来源 paperId 的一次请求返回HTTP404，未确认可用检索与关系通路；不能将旧包路径直接发布为可用接口 |
| scim 命名服务 | `/microservice-ai-reading/scim/getConfig` | 实际读取到 canUse、remainingTimes 字段；公开报告省略账号值，未推断其未验证产品语义，未调用 start |

参考论文问答请求字段：

```json
{
  "noteId": "当前账号云端笔记标识",
  "pdfId": "ReadPaper 云端 PDF 标识",
  "text": "用户问题",
  "pdfUrl": "当前有效的云端文件地址",
  "lang": "用户配置的语言枚举",
  "firstAskQuestion": false,
  "isDeepThinking": false
}
```

段落模式额外使用 `question/pageNum/boundingBox/viewport`；图像模式使用 `imageUrl/pageNumber`。不能将只有 PaperDesk 本地哈希的 PDF 当作 ReadPaper 已存在的云文献。此前88份迁移保留了源 pdfId/docId/noteId，可用作映射起点，但签名文件地址应按需重新获取，不能依赖脱敏迁移包里的历史 URL。

## 账号权限解析与隐私

本轮只读取当前 ReadPaper 登录态的必要 Cookie，留在进程内，未输出或保存。权限来自客户端真实使用的角色字段；公开研究摘要仅保留响应结构与字段名，不包含实际账号的会员状态、余额、配额或能力值。

| 项目 | 需读取的字段或对象 |
|---|---|
| 有效角色 | `vipRoles[0].vipPrivilege` |
| AI 辅读、翻译及润色权限 | `readingEnable`、`aiTranslateEnable`、`polishEnable` |
| AI 豆余额 | `aiBeanCount` |
| 问答成本配置 | `aiBeanCountCostEveryQuesion`；配置不代表实际扣费 |
| 全文翻译剩余次数 | `remainCount` |
| 划词翻译限制配置 | `wordSelectionTranslateCountLimit`；限制配置不是剩余次数 |
| OCR 限制配置 | `ocrTranslateCountLimit` |

顶层权限对象与 `vipRoles[0].vipPrivilege` 可能存在差异；桥接实现必须采用客户端实际使用的角色选择逻辑，并以服务端当前响应为准。费用字段不能覆盖功能启用字段，不能单凭 `aiTranslateConsumeBeanCount` 推断 `aiTranslateEnable` 或免费使用权限。

## 登录与实现边界

客户端请求包含共享应用 Basic 头、ReadPaper 用户会话、appId/orgId 等上下文。共享应用头不是用户授权凭据，单独设置它不能获得当前用户或云服务权限。现有 Axios 包装包含 Cookie 请求、过期错误处理及 refreshToken 流程；这些仅是原客户端自己的登录实现，未发现可直接供 PaperDesk 使用的开放第三方授权契约。本轮没有执行刷新、申请授权码或复用第三方应用身份。

部分 Google、腾讯、阿里、DeepL 翻译分支调用桌面 native bridge，并使用用户自己配置的供应商凭据。它们与 ReadPaper 云端提供的翻译渠道不是同一条请求链，不能以“原客户端支持该渠道”推断 ReadPaper 为 PaperDesk 免费代理这些服务。

## 已确认的产品方案：ReadPaper 在线文献库＋自有 AI

用户最新选择覆盖此前的本地优先方案：ReadPaper 是文献、附件、分类、阅读进度、笔记和批注的唯一持久化来源；阅读和批注默认通过 ReadPaper 服务读取及保存。PaperDesk 提供阅读交互和服务适配，AI 问答、总结、解读、翻译和 OCR 使用自有或自行配置的服务。

PaperDesk 客户端后续不持久保存业务数据。文献清单、PDF、页面图像、正文、搜索索引、笔记、批注、进度、AI 问答历史及登录会话默认仅在内存中存在。切换账号、退出登录及会话结束时释放这些内容；凭据和签名 URL 不写入日志。不能继续沿用 SQLite 文献库、磁盘 PDF 缓存、持久 outbox、浏览器本地存储或文献镜像作为默认路径。用户自行选择上传的源文件与此前独立导出的迁移备份，不属于新运行模式自动创建的缓存，本次不执行删除。

该模式需要联网，不提供离线阅读和离线编辑承诺。新增或修改只有收到 ReadPaper 确认才显示已保存；写入失败显示未保存并暂留内存，不能通过自动本地落盘来隐藏失败。程序退出后无法恢复尚未提交的内存草稿。

实施边界：

1. 增加 ReadPaper 文献服务适配器，正确处理原账号登录、失效、文献列表、按需 PDF、批注和进度读取。源标识在会话内映射，不重新导入持久本地库。
2. 验证 ReadPaper 批注、笔记、进度、分类与文献操作的写入协议；按其可表达类型实现读写。不可表达类型必须明确显示能力限制，不能生成只存在本机且重启丢失的“已保存”批注。
3. PDF 阅读优先使用内存字节或可控在线读取；避免渲染引擎、WebView、缩略图和下载组件隐式写入业务缓存。若某组件必须落盘，需先更换或改造存储路径并验证会话清理，不能把“默认缓存”作为例外。
4. 自有 AI 从当前文献会话取得所需文字或图像，以源 pdfId/页码关联结果；不调用 ReadPaper 的 AI、AI豆或全文翻译作业。上传材料在自有处理服务按临时任务处理，客户端不保存副本；AI结果默认留在当前会话，用户选择保存为笔记时写回 ReadPaper。
5. 原有 PaperDesk `/jobs` 会固定保存文件、正文和任务历史，不能原样接到此模式；需为自有 AI 明确临时输入与结果保留策略，避免在同机后端形成另一份持久文献库。
6. 验收需覆盖：新增批注在原 ReadPaper 可读、重新进入会话从云端恢复、写入失败不误报成功、账号隔离、进度恢复，以及退出/重启后应用目录不存在业务内容及待同步队列。此前迁移与渲染测试不代替这些新要求。

2026-10-23已新增0.4默认在线入口、内存网关及自有AI路径，详情见 [在线模式实现与验收](online-mode.md)。原SQLite实现保留为历史源码，默认入口不再调用；真实云端写回及移动端端到端验收仍待完成。前文对ReadPaper AI接口及账号权限的研究保留为证据，不再是本方案的AI依赖。

## 复现

`scripts/research_readpaper_cloud.mjs` 接受原阅读器样本目录、全新输出目录与已安装 Babel parser 路径；它只进行语法解析与带来源的声明切片。对生成的 focused-sample 使用摘要里记录的 REA 参数运行，不执行原程序模块。

```powershell
python scripts/probe_readpaper_cloud.py --use-current-session --output .data/新的云服务诊断.json
```

诊断默认仅6个固定配置/权限接口，加1个匿名对照。可选 `--paper-id` 为已知论文加一项只读详情检查；当前样本返回404，报告保留失败。工具不会自动恢复登录或尝试其他账号。输出文件已存在时拒绝覆盖。

ReadPaper 官方功能说明：[云端阅读、翻译与 AI 功能](https://readpaper.com/features)、[AI 辅读](https://readpaper.com/doc/en/reading.html)、[全文翻译](https://readpaper.com/doc/fullTextTranslation.html)。官方产品功能页不能代替第三方 API 契约或本次账号可用性验证。
