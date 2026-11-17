# 开放日直播资料查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、原件接收、凭据列表与摘要回读，以及按选中 Representation 的直播持续归档（初始化资料与媒体原字节留存，不做转码）；资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料、选择机位并完成一轮归档核对，最后核对保存后的原件；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验预览、资料控制、原件持久化、时间线展开与持续归档（含窗口裁剪、Period 空档、机位隔离、暂停恢复与同地址换内容）；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR`、`ARCHIVE_INTERVAL_MS` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

## 持续归档接口

选择机位后可手动核对或按间隔自动领取，状态持久化在 `DATA_DIR/archive/archive-state.json`，暂停后重开同一目录即可恢复：

- `POST /archive/select`，请求体 `{"representations": ["<PeriodID>\u0000<RepresentationID>"]}`，选择要归档的机位。
- `POST /archive/start` / `POST /archive/pause`，启动或暂停按 `ARCHIVE_INTERVAL_MS`（默认 1000ms）的自动核对。
- `POST /archive/tick`，立即执行一轮清单刷新与片段核对。
- `GET /archive/status`，返回收妥/待领/过期时段、Period 空档、初始化资料、各机位错误与最近采用的清单身份。

归档只保存原字节并做摘要校验，不转码；404 表示尚未发布（保留待领），410 表示已离开可用窗口（登记过期），不会把空档补成零长度片段，也不会为 `r="-1"` 时间线排出无限多的未来请求。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料；`src/timeline.mjs` 处理 SegmentTimeline 展开、可用窗口裁剪、Period 空档与片段地址；`src/archive.mjs` 负责持续领取、状态持久化与片段身份绑定；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t dash-live-retrieval .
docker run --rm --network none dash-live-retrieval
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
