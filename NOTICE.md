# 第三方代码与许可

本仓库自己写的代码用 MIT 许可（见 `LICENSE`）。下面列出的文件和数据**不适用 MIT**，沿用上游项目的许可。

## 猜猜呗游戏的反馈算法

- 文件：`backend/v2/solo/feedback.py`
- 来源：[kennylimz/anime-character-guessr](https://github.com/kennylimz/anime-character-guessr) 的 `client/src/utils/bangumi.js`
  第 622–777 行 `generateFeedback`（main 分支提交 `9443b4c`）。
- 许可：[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)（署名—非商业性使用）。
  这个文件只能用于非商业用途，转载或再分发时要保留原作者署名和这份说明。
- 改动：从 JavaScript 改写成 Python，算法和返回字段与上游一致；
  另外加了给界面画表用的 `display` 字段和猜对时的 `correct` 标记，
  并补上了上游取不到名字的「第一部共同作品是特殊游戏」的情况（只写进 `display`，不改上游的字段）。

## 数据包里的上游数据

Releases 页面的数据包不在仓库里，也不适用 MIT。

- 作品、角色、人物、声优、出演记录和作品标签：来自 [Bangumi 番组计划](https://bgm.tv)。
- 角色标签：来自 [kennylimz/anime-character-guessr](https://github.com/kennylimz/anime-character-guessr)，
  许可是 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)（署名—非商业性使用），
  只能用于非商业用途，再分发时要保留原作者署名和这份说明。具体是：
  - 数据库 `outsetter_v2.sqlite` 的 `char_tag` 表：来自上游 `client/src/data/id_tags.js`。
  - 同一个库的 `char_ext_tag` 表：来自上游 `client/public/data/extra_tags/` 下 22 个游戏的 JSON 文件。
  - 经典工作台数据包 `characters_db.ndjson` 的 `character_tags` 字段：来自上游 `client/src/data/id_tags.js`。
- 用的上游提交记在 `outsetter_v2.sqlite` 的 `meta` 表 `upstream_commit` 里。
- 改动：解析成数据库表或 JSON 字段；`char_tag` 加了 `ord` 列（上游里的原顺序），
  `char_ext_tag` 加了 `subject_id` 列（来自哪个游戏）。标签内容没有改。
- 数据包里也带着这份说明：主数据包是 `NOTICE.txt`，经典工作台数据包写在 `README.txt` 里。

## 其他依赖

前端、后端的第三方库按各自的许可使用，见 `web/package.json` 和 `backend/requirements.txt`。
