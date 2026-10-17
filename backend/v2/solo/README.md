# backend/v2/solo：单人版「猜猜呗」的后端

单人模式的后端，分两层：

1. 反馈和搜索：给一个猜的角色和一个答案角色，算出和猜猜呗游戏逐字段一致的反馈（`feedback.py` + `router.py`），再加容错搜索（`search.py` + `fuzzy.py`）。
2. 对局：会话、出题调度、一局的规则和评级、进度存储、Bangumi 在线搜索（`scheduler.py` + `session.py` + `session_router.py`）。

## 接口一览

前缀都是 `/v2/solo`，共 12 个。`router.py` 里 5 个（只读），`session_router.py` 里 7 个。

| 接口 | 作用 | 在哪一节 |
|---|---|---|
| `GET /search` | 容错搜索角色 / 作品 | 「容错搜索」 |
| `POST /pool` | 方案 → 题库全部角色 id | 「辅助接口」 |
| `POST /feedback` | 猜 + 答案 → 猜猜呗游戏的反馈 | 「辅助接口」 |
| `GET /work_characters/{subject_id}` | 一部作品下的全部角色 | 「辅助接口」 |
| `POST /card` | 角色 id → 角色卡片数据 | 「辅助接口」 |
| `POST /session` | 建会话（求值方案、建题库） | 「对局接口」 |
| `POST /round/start` | 开一局 | 「对局接口」 |
| `POST /round/guess` | 提交一次猜测 | 「对局接口」 |
| `POST /round/timeout` | 提交一次超时 | 「对局接口」 |
| `POST /round/surrender` | 投降 | 「对局接口」 |
| `POST /round/regrade` | 改最近一局的评级 | 「对局接口」 |
| `GET /bgm_search` | Bangumi 在线搜索 | 「对局接口」 |

## 文件

| 文件 | 作用 |
|---|---|
| `feedback.py` | 逐字移植上游 `generateFeedback`（上游 `client/src/utils/bangumi.js`） |
| `router.py` | 5 个只读接口（搜索、题库、反馈、作品角色、卡片），已在 `backend/app.py` 里 include |
| `scheduler.py` | 出题调度（间隔重复）。只用标准库、不碰库不碰磁盘 |
| `session.py` | 对局逻辑：会话、一局、评级、宽免、落盘、日志。不依赖 FastAPI |
| `session_router.py` | 对局的 HTTP 接口（6 个 POST + 1 个 GET），已在 `backend/app.py` 里 include |
| `fuzzy.py` | 容错搜索的算法本身（纯函数 + 索引类，不碰库）：归一化、同音字、近似子串、分档排序 |
| `search.py` | 容错搜索的服务：读库 + 别名旁路文件建索引（后台线程）、没建好时退回严格规则，`GET /v2/solo/search` 用它 |

测试在 `backend/v2/tests/`：`test_solo_feedback.py`（反馈规则）、`test_solo_router.py`（辅助接口）、`test_solo_scheduler.py`（调度器）、`test_solo_session.py`（对局规则和接口）、`test_solo_search.py`（容错搜索）。它们用 `synth.py` 里的合成库，不需要下载数据库。

## 反馈怎么算

和上游一样，输入是（猜的 id、答案 id、模式、作品标签数 n、角色标签数）。返回上游 `generateFeedback` 的全部字段，再多一块 `display`（猜的角色自己的显示值，前端照着画猜猜呗游戏里的那张反馈表）。

- `gender` 性别：`guess` 是 `male` / `female` / `?`，`feedback` 是 `yes` / `no`。
- `popularity` 人气 = 收藏数 + 吐槽数：`feedback` 是 `=` `+` `-` `++` `--`，阈值是答案人气的 5% 和 20%。
- `rating` 评分：阈值 0.3 和 1；任一方没有评分时是 `?`。
- `shared_appearances`：`first`（按名字比出的第一部共同作品）、`firstOriginal`、`firstCn`（按 id 比出的第一部共同作品的原名和中文名）、`count`。
- `appearancesCount` 登场作品数、`latestAppearance` 最晚登场年份、`earliestAppearance` 最早登场年份：差 0 是 `=`，差不超过 2 是 `+`/`-`，更大是 `++`/`--`；任一方没有年份是 `?`，两方都没有是 `=`。
- `metaTags`：`guess` 是猜的角色要显示的全部标签（作品标签、角色标签、声优，重名只留一个），`shared` 是其中和答案相同的。
- `display`：猜的角色自己的性别符号、人气、评分、登场数、最早/最晚年份；作品标签、角色标签、声优，每项带 `shared` 标记；第一部共同作品名（`shared_work.name` 中文名优先、`name_original` 原名）和共同作品数。
- 外层另有 `guess_id` `answer_id` `mode` `subject_tag_num` `character_tag_num`，以及 `correct`（猜的 id 等于答案 id）。上游没有「猜对」的特殊标记，猜对时各项自然全是 `yes` / `=`，`correct` 是这里多给的。

几处要知道的取值：

- 「无」在内存里是 `None`，库里是 `-1`，上游返回 `-1` 或 `'?'`。本模块对外统一用 `None`，反馈符号照上游。
- `shared_appearances.firstOriginal` / `firstCn`：没有共同作品时是 `''`；共同作品里最靠前的一部是追加的特殊游戏时是 `None`（上游是 `undefined`，因为特殊游戏不在登场名单里，没有名字）。这两个字段和上游一致。
- `display.shared_work`：第一部共同作品是特殊游戏时，上游取不到名字，猜猜呗游戏的界面里这一格是空的绿块。和猜猜呗游戏不同，这里补上：查 `subject` 表，中文名优先，没有中文名用原名，两个字段 `name` / `name_original` 都有值。只补 `display`，不动上面的上游字段。库里查不到这部游戏时仍是 `None`（前端自己兜底）。
- 作品标签显示数 = `max(cut, n)`；`cut = -1` 时只看 n。猜的角色的这些标签参与比较，反馈格子里最多显示 n 个。

## 额外读的三样数据

快照里没有，按需读一次、挂在快照上复用（快照被替换时一起丢掉），不复制整库：

1. 吐槽数：`character.comments` 里非零的人。人气 = `heat + comments`，快照里只有 `heat`。
2. 特殊游戏：`profile_app.extra = 1` 的登场。共同出演要算它们，登场作品数不算，所以 `ModeProfile.apps` 里没有。
3. 作品名：只查用到的 subject，按 id 缓存（也包括共同出演里的特殊游戏，给 `display.shared_work` 用）。

对局另外按需读角色的原名和中文名（`character.name` / `name_cn`，`char_names()`，每次猜测和结算各查一个 id，缓存在快照上），给「名字两行」用。

第一次请求某个模式时，后端会先载入该模式的画像（要几秒）；之后很快。

## 辅助接口

`router.py` 的 5 个接口全部只读，不写库、不写 `data/`（`GET /search` 见后面「容错搜索」一节，下面是另外 4 个）。错误是 `{ok:false, error, message}`，`message` 是中文。

- `POST /v2/solo/pool`：入参同 `/v2/evaluate`（SpecV2，或 `{spec}`）。返回 `{total, ids, empty_grid_ids, mode, tag_count, errors, warnings}`。`ids` 是升序的全部题库角色 id；`empty_grid_ids` 是其中登场数为 0 的人；方案里有没生效的部分时 `errors` 非空，这时题库不完整，由调用方决定要不要拦（接口仍返回 200）。
- `POST /v2/solo/feedback`：`{guess_id, answer_id, mode?, subject_tag_num?, character_tag_num?}`，缺省 `anime` / 6 / 4。角色不在库里 404 `not_found`；mode 或标签数不对、id 不是整数 422。
- `GET /v2/solo/work_characters/{subject_id}?mode=`：一部作品下全部角色（库里角色范围内）。主角在前，其余在后，各自按热度降序，热度相同按 id 升序。每项有 `id name relation relation_code heat gender n_app`，`n_app` 是该角色在 `mode` 下的登场数（0 表示游戏里这个格子是空的）。作品不存在 404。
- `POST /v2/solo/card`：`{spec, char_id}`，返回 `CandidateV2`（和 `/v2/candidates` 的每一项同结构，含 `has_anime`）。角色不在题库里也能返回，此时 `ranges` 是空数组。角色不存在 404。

## 与上游的一致性

`feedback.py` 的每个字段、每个阈值都对应上游 `generateFeedback`。

数据来自本地库，不是线上 Bangumi 接口：比较规则和上游一样，但同一个角色的人气、评分等数值，可能和线上游戏里看到的不同。

## 对局接口

前缀 `/v2/solo`。错误统一 `{ok:false, error, message}`，`message` 是中文。

### 几个名词

- **会话**：前端打开练习页时建一个，存内存，最多 8 个，超出丢最久没用的（用一次就算“刚用过”）。后端重启后会话没了，所有对局接口返回 404 `session_not_found`，前端重新建会话就行。
- **一局**：开局时调度器选出答案。之后每次猜测或超时都是一「行」，从 1 开始编号。猜中或投降时结束。
- **进度**：按「模式 + 练法（work / char）」各存一份，所有方案共用，存在 `<data 目录>/solo_v2/`（默认 `data/solo_v2/`，测试时由 `OUTSETTER_V2_DATA_DIR` 指到临时目录）。
- 同一个「模式 + 练法」只有一个调度器，所有会话共用。在会话 B 里开局或建会话，会让会话 A 正在进行的那一局作废（A 再猜返回 409 `round_not_active`）。

### 接口

| 接口 | 请求 | 响应 | 错误 |
|---|---|---|---|
| `POST /session` | `{spec, plan_name?, practice?: "work"\|"char"（不传或 null = work；传了别的值，包括 `""` `0` `false`，一律 422）, new_every?: 0–20}` | `{session_id, mode, practice, plan_name, pool_total, pool_ids, default_subject_tag_num, new_every, errors, warnings, progress}` | 422 `empty_pool` `bad_spec` `bad_practice` `bad_new_every` `bad_field` |
| `POST /round/start` | `{session_id, subject_tag_num?（默认跟随方案）, character_tag_num?（默认 0）, good_sec?（1–120，默认 10）, time_limit_sec?（null 或 1–60）, work_bonus_sec?（0–10，默认 2）}` | `{round_id, round_no, subject_tag_num, character_tag_num, good_sec, work_bonus_sec, time_limit_sec, status, progress}` | 404 `session_not_found`；422 `bad_tag_num` `bad_good_sec` `bad_time_limit` `bad_work_bonus_sec` |
| `POST /round/guess` | `{session_id, round_id, guess_id, via?: "name"\|"work"\|null}` | `{row, status, end}`（`end` 只在猜中那一次不是 null） | 404 `session_not_found` `not_found`；409 `round_not_active`；422 `bad_via` |
| `POST /round/timeout` | `{session_id, round_id}` | `{row, status, end: null}` | 409 `round_not_active` `no_time_limit` `too_early` |
| `POST /round/surrender` | `{session_id, round_id}` | `{end}` | 409 `round_not_active` |
| `POST /round/regrade` | `{session_id, round_id, grade: easy\|good\|hard\|again}` | `{round_id, grade, grade_auto, next_gap, progress}` | 422 `bad_grade`；409 `not_last_round` `char_reappeared` |
| `GET /bgm_search?kind=character\|subject&q=&mode=anime&limit=10` | — | 数组，每项 `{id, name, name_cn, in_library, label}` | 502 `bgm_unavailable`；422 `bad_kind` `bad_mode` |

要点：

- `status = {rows, misses, forgiven, counted, again_locked, limit}`，`counted = misses − forgiven`，`limit = 3 + forgiven`。
- `row`（猜测行）= `{seq, kind:"guess", t_offset, guess_id, name, name_original, name_cn, feedback, hit, exact, forgiven, via}`；超时行 = `{seq, kind:"timeout", t_offset, hit:false, forgiven:false, via:null}`。`t_offset` 是距开局的秒数。`via` 是 `"name"`（按名字搜的）或 `"work"`（搜作品后从作品的角色列表里点的），只影响评级的分界线（见下面「一局的规则」第 4 条）。
- 名字两行（上行日文原名，下行中文名，和猜猜呗游戏的名字格一样）：`name_original` = `character.name`，`name_cn` = `character.name_cn`（库里没有中文名时是 `null`）；`name` 是显示名（`display_name`）。结算块里答案的名字同样有这三个（`answer_name` / `name_original` / `name_cn`）。
- **答案在结束前不会出现在任何响应里**：`feedback` 已去掉 `answer_id` 和 `correct`；开局响应只有 `round_id`，没有答案；建会话只返回题库 `pool_ids`。
- `end`（结算块）：`round_id answer_id answer_name name_original name_cn card grade_auto grade ended_by again_locked hit_seq rows misses forgiven timing why why_label gap_rounds gap_sec prev_grade next_gap progress`。`card` 是 `CandidateV2`（含 `has_anime`，用答案的作品当“绑定作品”）；`ended_by` 是 `exact`（猜中答案本人）/ `work`（猜中答案的作品里的别的角色）/ `surrender`；`timing = {intervals:[{from,to,sec,via,bonus_sec}], avg_sec, good_sec, work_bonus_sec, threshold_sec}`（`via` 是这个间隔结束行的来源，超时行 `null`；`bonus_sec` 是这个间隔得到的加时；`threshold_sec` 是实际用的分界线）。
- `progress = {total, segments, parts, events, saturated, session_delta}`：`parts` 是每段对总进度的贡献百分比（进度条分段上色用）；`session_delta` 是本会话开始以来 `total` 涨了多少（“本次 +x%”）；`events` 是这一局带来的事件（给动画用）。**建会话、开局、改评级没变化时 `events` 是空数组**，免得重放上一局的事件。
- 错误信息不带角色 id（猜的角色或答案不在库里：404 `not_found`，message 是「这个角色不在角色库里」），因为那个 id 可能就是这一局的答案。意料之外的异常：500 `internal`，message 只有异常类型（「后端出错：KeyError（详情见后端日志）」），详细信息只打在后端日志里，不像其它接口那样把异常内容发出去。
- `bgm_search`：用 `backend/clicker/bgm.py` 的客户端，8 秒超时；`subject` 的类型按 `mode` 定（anime→[2]，book→[1]，game→[4]，real→[6]，all→[1,2,4,6]）；`in_library` 看本地库里有没有这个 id；空 `q` 直接返回 `[]` 不发请求。离线、超时、Bangumi 报错一律 502 `bgm_unavailable`，message「Bangumi 连不上，可以关掉在线搜索用本地搜索」。

### 一局的规则（每条都有测试）

1. **猜中**：`practice=work`（默认）时，猜的角色就是答案，或者在「答案的作品」（方案通过哪部作品把答案选进题库，`ev.best_bound_work`）里登场过。联动作品不算；答案是通过续作选进来、猜的配角只在前作出现，也不算（已知的少见漏判）。`practice=char`（“练定位角色”）时只有答案本人才算。
2. **没猜中（miss）**：猜错，或超时。超时行也占行号。
3. **计入次数 = miss 数 − 宽免数**，达到 3 → 本局记 Again（`again_locked`）。Again 之后这一局继续，猜中仍是 Again。
4. **自动评级**（猜中时，永远不给 easy）：
   - Again 已锁定 → `again`；
   - 第 1、2 行猜中 → `good`（还没开始计时）；
   - 第 k（≥ 3）行猜中 → 取第 2→3、3→4、…、(k−1)→k 行之间的时间差，求平均。平均 ≤ **分界线** → `good`（等于也算），否则 `hard`。超时行也是计时点。
   - **作品加时**：分界线 = `good_sec + work_bonus_sec × （结束行 via 是 "work" 的间隔数）÷（间隔总数）`，等价于每个间隔先减掉自己的加时再取平均。k = 3 时就是「第 3 步是搜作品点出来的 → 分界线多加 `work_bonus_sec`（默认 2 秒）」。超时行没有 via，不加时。不传 `via` / `work_bonus_sec` 时分界线就是 `good_sec`。
   - 投降 → `again`。
5. **宽免**（只对猜测行，六条同时满足；最后一条最贵所以最后判）：
   1. 是猜测行（超时不宽免）；
   2. 猜的角色在本会话题库里（搜索是全库，题库外的角色可以猜，但不宽免）；
   3. 这一行之前至少有 1 个猜测行（第一次猜测什么信息都没亮，谁都“区分不了”，所以不宽免；超时行不算猜测，`[超时, 第一次猜测]` 里的这次猜测仍是第一次）；
   4. 本局已宽免次数 < 2；
   5. 本局还没被判 Again；
   6. **区分不了**：假设猜的这个角色是答案，把这一行之前的每次猜测重算一遍反馈表，每一格都和真实的表一样。
6. **可以重复猜**：同一个角色可以重复猜，就是一次普通猜测——加一行、占行号和计时点、miss 照记、计入次数照算（同一个错角色连猜 3 次就是 3 次计入，本局记 Again），宽免条件相同。重复猜的人，在自己那一行上的反馈全是「对」，和答案的反馈不全一样，所以过不了上面宽免的第 6 条（区分不了），不会被宽免。已知的极端边界：如果某个猜错的角色，自己对自己的反馈表恰好和它对答案的反馈表每一格都一样（两个几乎完全相同的角色），重复猜它会按条件被宽免；没有为它加特例。
7. **超时**：本局设了 `time_limit_sec` 才能超时（否则 409 `no_time_limit`）。距上一行（没有行就是开局）不到 `time_limit_sec − 1.5` 秒返回 409 `too_early`（防前端计时略快导致误触发）。超时成功后倒计时从这一行重新算。
8. **没打完的一局**（开下一局时上一局没结束）：作废，不记评级、不计局数，日志写一条 `kind:"void"`。
9. **改评级**：只能改**最近结束的那一局**，下一局已经开始了也可以改（自动模式就是这样用的），不影响进行中的那一局。改后的调度器状态和“一开始就评这个等级”完全一致（只重算一次，改几次都不会重复累计 Again 次数）。新评级和旧的一样时什么也不做（不写日志、`events` 为空）。那个角色之后又出现过 → 409 `char_reappeared`。

### 调度器

`scheduler.py` 是间隔重复调度器。`progress()` 除了总进度，还返回 `parts`（每段对总进度的贡献百分比）。`Params.leech_fails` 默认是 **0（不停放：难记的角色照常出现）**；传 `leech_fails=3`，连续 3 次 Again 后会先把这个角色停放。`new_every`（新角色保底，默认每 4 局至少 1 个新角色）可以在建会话时用 `new_every` 覆盖（0 = 不保底），会存进进度文件，之后不传就沿用。

### 存储和日志

- `solo_v2/sched_<mode>_<practice>.json`：`{version:1, mode, practice, seed, scheduler:{…}}`。`seed` 第一次建时随机生成并存下来，同一个题库里新角色的出场顺序因此固定。每次建会话、开局、结束、改评级后写盘：先写 `.tmp` 再 `os.replace`（Windows 上被占用时重试 5 次）；写一半失败时删掉 `.tmp`，原文件不动。
- 进度文件读不出来（不是合法 JSON、缺字段）：改名为 `*.bad-<时间戳>` 留着（不删），从头开始，并在建会话响应的 `warnings` 里提示一次。
- `solo_v2/log_<mode>_<practice>.jsonl`，每行一个 JSON：
  - `kind:"round"`：`ts round_id plan mode practice char_id name why vt gap_rounds gap_sec prev_grade grade_auto grade ended_by again_locked rows misses forgiven timeouts hit_seq intervals avg_sec good_sec work_bonus_sec threshold_sec vias duration_sec subject_tag_num character_tag_num time_limit_sec next_gap`（`vias` 每一行一项，超时行 `null`）；
  - `kind:"regrade"`：`ts char_id round_id old_grade grade next_gap`；
  - `kind:"void"`：`ts char_id round_id rows`（上次后端退出时留下的未结束局，这次不知道它猜了几行，`rows` 是 `null`）。
- 状态文件含完整题库（`pool` `groups` `new_queue`），大小随题库线性增长；题库越大，每局结束的写盘和算进度越慢。

### 几处细节

- `why` 是调度器的原值 `new_floor` / `due` / `new` / `early` / `fallback`；`why_label` 是中文。
- 建会话响应多一个 `new_every`（当前生效值）；`progress` 多 `session_delta`；超时行多带 `hit:false, forgiven:false`，方便前端统一处理。
- `round_not_active` 还有一种情况：这一局在调度器里已经被别的会话作废（见上面“名词”最后一条）。
- 调度器选不出题（所有角色都被停放）时，`start` 返回 `round_id: null` 和 `reason: "all_parked"`；停放默认关闭，所以正常使用中不会出现。
- “第一次猜测不宽免”按“第一个猜测行”算，超时行不算猜测（`[超时, 猜测]` 里的这次猜测仍是第一次）。
- 建会话时顺手预热第一次猜测要用的几张懒加载表（吐槽数、特殊游戏、角色标签、声优），所以建会话比只算题库多花一点时间，换来第一次猜测不用再等。

## 容错搜索（`GET /v2/solo/search`）

对局输入框用；其他页面的搜索用 `/v2/suggest`。

### 数据

- **角色** = 库里全部角色；**作品** = 全部「搜索可见」的作品（`S_VISIBLE`，和 `/v2/suggest?kind=work` 同一批）。
- 每个对象的名字 = 库里的 `display_name / name / name_cn`（“正式名字”）+ 别名。别名来自旁路文件 `search_aliases.sqlite`（和出题器数据库同目录，随数据库一起在 Release 里下载，见根目录 README）。里面只有两张表：`char_alias(id, alias)`、`subject_alias(id, alias)`，外加 `meta`。
- 别名里「甲、乙、丙」「A / B」这样连着写的，整串和拆开的各收一份（每个别名最多拆 8 段）。
- 文件不存在或读不了：只用库里的名字，其余照常（`fuzzy` 仍是 `true`）。别名文件只增加可搜的名字，不改库。
- 同音字用 `pypinyin`（`backend/requirements.txt` 里有）。没装时退化成没有同音字容错，别的照常。

### 排序

`exact`（整个名字相同）和 `prefix` **合并成一档**，档内按对象热度降序、id 升序；然后是 `contains`（含「几个词任意顺序」），最后 `fuzzy`。所以热门对象的前缀命中会排在冷门对象的完全相同命中前面（搜「露西」：「露西·哈特菲利亚」在前，冷门的同名「露西」第二）。合并档的三条例外：

1. 只命中了别名开头的 `prefix`（别名前缀）排在这一档其余命中之后（搜 `Roc` 会撞上 Rock Lee 这类别名）。别名是**完全相同**的（雷姆 -> 蕾姆）不降。
2. 几个 `exact` 之间，名字原文（NFKC、忽略大小写和空白，不去标点）和查询一模一样的在前，再按热度。
3. 最热的那个 `exact` 对象保底排进前 3 位（`EXACT_FLOOR = 3`）；本来就在前 3 位就不动。其余的 `exact` 仍按热度排。

`contains` 档：正式名字的命中在别名的命中前面，再按热度。`fuzzy` 档先按「代价每 1.0 一档」再按相似度分档，最后同样按热度。纯拼音输入（`tanzhilang`）排在所有容错命中之后。`exact` 不保证排在 `prefix` 前面，前端按 `items` 顺序显示即可。

两个防慢的上限：拼音切分（`segment_pinyin`）规范化后超过 64 个字符不切，递归超过 5000 个节点就放弃（`xianxianxian…` 这类歧义串）；多词任意顺序的匹配每个词最多收 `MULTI_CAP = 10000` 个对象。

### 容错做什么

同音字（诗/施）；少 / 多 / 错一个字；相邻两字颠倒；空格、间隔符、全半角、大小写、片假名 / 平假名不计较；英文名拼错一个字母。汉字或假名：1 个字不容错、2 个字只认同音字、3–4 个字最多错 1 处、5–9 个字 1.5、10 个字以上 2（同音字替换只算 0.25）。英文：不到 4 个字母不容错、4–7 个字母错 1 处、8 个以上错 2 处。

### 索引

- 进程启动时 `app.py` 调 `search.install()`，在后台线程建索引（一份角色、一份作品）。库快照切换后（`DataHub.snapshot_hooks`）先丢掉旧索引再建新的，同一时间只留一份。
- 没建好时，`/v2/solo/search` 用 `/v2/suggest` 的严格规则回答（前缀 > 包含，`backend.v2.router._rank_matches`），响应里 `fuzzy:false`、`matched` 全是 `null`。建失败了（异常打在后端日志里）60 秒内不重试，之后下一次请求再试。
- 建索引要几秒到十几秒、额外占一份内存（题库越大越多）；建好之后查询是毫秒级。查询超过 4 个词时，完全相同 / 前缀 / 包含 / 容错用整个查询（最多 60 个字符）；只有「词序任意」的多词匹配只看前 4 个词。
- 别名文件坏了（不是 sqlite 文件、是 sqlite 但没有那几张表、被截断）：后端照常起来，`fuzzy:true`，搜索照常出结果，只是没有别名（搜「雷姆」搜不到「蕾姆」）。别名文件只按库所在目录找（`alias_path_for`），没有单独的环境变量或配置项可指。
- 只读：不写任何文件。

### 单独起一个后端（调试前端用）

在仓库根运行，用你装依赖的那个 Python。进度和日志落在临时目录，不碰真实的 `data/`：

```
set OUTSETTER_V2_DATA_DIR=%TEMP%\solo_test_data
python -m uvicorn backend.app:app --host 127.0.0.1 --port <端口>
```

上面是 Windows cmd 的写法；PowerShell 里第一行换成 `$env:OUTSETTER_V2_DATA_DIR = "$env:TEMP\solo_test_data"`；macOS / Linux 里第一行换成 `export OUTSETTER_V2_DATA_DIR=/tmp/solo_test_data`。库用 `backend/config.json` 里配的库（只读打开）。方案、清单也读这个临时目录，所以里面没有已存的方案；前端联调时直接把 spec 传给 `POST /session` 即可。

跨域规则：后端只接受本机页面（`Origin` 是 `127.0.0.1` 或 `localhost`，端口不限），`Host` 头也只认这两个本机名字。从别的机器或域名访问会被拒绝。

想把进度清零：**先停后端再删** 临时目录里的 `solo_v2` 文件夹，或者删完再重启后端。后端运行时只删文件没用——每个「模式 + 练法」的进度在内存里还有一份，下一次存盘会把它写回去。
