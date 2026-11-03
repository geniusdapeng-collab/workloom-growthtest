# 用原话启动 GrowthTest 正式视频制作

在当前 GitHub 默认分支的干净检出中打开工作台。仓库身份为 `geniusdapeng-collab/workloom-growthtest`。按 [Agent 接入指引](AGENT-CLIENTS.md) 准备依赖、数据库、供应商和授权成员会话。客户端首先核对 `/health` 的产品、实例和源码提交，再用 `access.me` 核对成员与工作区。这个入口面向有可核实源码版本的服务；没有相同 `sourceCommit` 的运行实例需要由部署方按同一源码版本启动。

## 从用户原话取得正式前期

把原话放在 `intent`。仅在已知时附上 `durationSec`、`platform` 或 `product`。指定的人物、商品、情节和平台来自本次任务。镜头划分、逐镜时长、提示词和生成资格由系统产生。选择营销片时走商品情报和 G1；叙事片走同一工作台的叙事流程。解释片使用专用工位。

下面用本机独立源码服务的 [成员会话桥接](AGENT-CLIENTS.md) 示范。将作业文件放在仓外的私有目录，保留至交付结束。已授权的远程源码实例可直接用 `node scripts/workloom-video.mjs`，运行环境须提供已核对的 `WORKLOOM_BASE_URL`、`WORKLOOM_DESKTOP_INSTANCE_ID` 和成员令牌。

```bash
mkdir -p "$job_root"
printf '%s' '{"intent":"做一条20秒的雨后山间民宿短片，只拍空景，用于抖音","durationSec":20,"platform":"douyin"}' \
  | node scripts/workloom-source-session.mjs video -- start --input-file - --job-file "$job_root/job.json"
node scripts/workloom-source-session.mjs video -- status --job-file "$job_root/job.json"
```

- `clarify`：按返回的缺项补齐业务资料。
- `awaiting_approval`：经同一实例的正式审批工位处理返回的门和审批 ID。
- `preproduction_ready`：返回当前项目、运行、前期 attempt、镜头原文摘要、时长与管线。开工前核对人物、商品、平台及已知预算、使用权和供应商接收条件。
- `start_unknown`：保留工作单和原实例。先查立项记录；重复启动可能创建第二个项目。单独的导演预览或已有镜头稿入口各有其合同。

## 从同一作业渲染并交付

选取运行实例目录里可用的模型，在同一项目使用经核对的 [标准后期设置](video-standard-post.md)。设置声明封面、字幕、调色与可选既有音乐，以及字体和输入摘要。封面平台须与同一正式工作单记录的平台一致。制作工作台复用已登记设置；缺授权或缺必要素材时保留当前回执。设置文件须在首次渲染前就绪。以下金额来自本次批准，由执行环境传入。

```bash
node scripts/workloom-source-session.mjs video-deliver -- \
  --job-file "$job_root/job.json" --work-dir "$job_root/production" \
  --model "$render_model" --max-estimated-cny "$approved_cny" \
  --post-settings "$approved_post_settings" --out "$job_root/delivery"
```

已授权远程源码会话可在仓库根运行 `pnpm exec tsx scripts/tools/deliver-studio-video.mts`，沿用同样参数。仅核对并采用已有原片时省略金额上限。收到已有任务 ID、生成已受理或回执未知时保留同一工作单和 `.render-start.json`。仍在等待供应商完成或入库时，去掉金额参数，增加 `--poll-existing` 继续原项目的已登记任务。受理后的补记账及未知任务按 [渲染恢复指引](video-render-task-recovery.md) 核对原请求。

自动首轮提交只用于档案已证明 G5 无人物或商品参考的叙事项目。需要人物或商品参考时，正式工位须先把授权素材与每镜供应商请求绑定，不能降成纯文字生成。标准后期可从同一运行的已绑定、已完成、已入库原片继续。

出片入口通过同一前期签发资格和提交请求，保存原任务回执。它通过同一工作区的签名媒体地址取得原片，并核对入库字节、完成事件、资格签名、脚本版本和当前前期。标准后期使用原镜顺序、完整画面及可用的原生音轨，保留实测时长。当前发布前复查服务回执与本地成片、封面、字幕和导出摘要。只有 `delivery_verified` 且交付目录可回读时才交付文件。发布到平台走另外的正式授权入口。
