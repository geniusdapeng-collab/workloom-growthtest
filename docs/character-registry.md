# 角色库与默认模特 v1（2026-09-24）

## 一、命名

- **1 号模特：陈卓（`chen-zhuo`）** — 系统默认模特。档案：`bundles/ai-video/library/characters/model-01-chen-zhuo/`
- 档案正文含：外貌特征（照片提取）、服装基线、气质、授权信息、定妆照集（v3，8 角度，图生图 + 抠像友好背景硬闸）。
- **原始照片不进仓库**（仅本地保留）；仓库内只放 AI 生成的定妆照与档案正文。

## 二、选角规则（管线自动执行）

`bundles/ai-video/library/characters/registry.json` 是唯一事实源：

1. 项目/镜头卡**显式指定**模特 → 用指定的；
2. 镜头卡出现姓名或别名（`陈卓` / `卓卓`）→ 解析到该档案；
3. **都没指定 → 自动使用 `defaultModel`（陈卓）**；
4. 仍无 → 用库里第一个，并如实记录（不静默）。

多角色项目：指定姓名的角色按姓名解析，其余未指定角色才回落到默认模特。

## 三、怎么加新模特

1. 目录：`bundles/ai-video/library/characters/model-02-<pinyin>/`（`profile.json` + `portraits/vN/`）；
2. 在 `registry.json#models` 追加一条（`ordinal` 递增、`aliases` 写中文名与常用称呼）；
3. 需要改默认模特时，把 `defaultModel` 指向新 id（一次只有一个默认）。
