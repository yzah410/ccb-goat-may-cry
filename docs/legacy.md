# 经典工作台和自动点击

这两个功能来自出题器的早期版本，现在留作纪念。它们还能用，但不再是重点：圈题库用[工作台](guide.md#各个页面)，想自己练猜角色用单人猜猜呗。

## 经典工作台

经典工作台用一块块组块圈题库：从上到下依次把角色纳入或排除，再预览人数、抽一题、分页看候选，也能导出导图。它的方案存在 `data/plans/`，和工作台的方案分开。

经典工作台读的是单独的**经典工作台数据**（约 8MB），不读出题器数据库。没装这份数据时，导航里不出现经典工作台和经典候选池，其他功能不受影响。

**安装**

1. 在本仓库的 Releases 页面下载 `ccb-goat-may-cry-classic-data-<日期>.zip`。
2. 解压到仓库根目录的 `data/` 文件夹，会得到 `data/classic/`。
3. 重启后端。导航里会出现经典工作台。

想放在别处：在 `backend/config.json` 里写 `"classic": {"data_dir": "<文件夹>"}`，相对路径按仓库根目录算。

**更新**：下载新的 zip，解压覆盖 `data/classic/`，再重启后端。你保存的经典方案在 `data/plans/`，不受影响。

**数据包里有什么**：只含动画、不含 R18 的作品，字段只有经典工作台用到的：角色表、作品表、主角 / 配角的出演记录、作品的有效标签、角色的原作来源。数据来自 [Bangumi 番组计划](https://bgm.tv)；角色表里的角色标签来自猜猜呗（CC BY-NC 4.0，见 [NOTICE.md](../NOTICE.md)）。包里的 `SHA256SUMS` 可以用来校验文件。

**样例方案**：`examples/classic-plans/` 里有 253 个经典工作台的样例方案。装好经典工作台数据后，在「方案库」的「经典方案」标签页点「载入样例方案」，会把它们放进 `data/plans/`；已有同名方案的不会被覆盖。

## 自动点击

自动点击把抽到的角色点进猜猜呗多人房间的出题弹窗（房主出题），也可以开自动循环。

1. 用带调试端口的 Chrome 打开猜猜呗的多人房间：
   - Windows：`scripts\launch-guessr-chrome.bat https://anime-character-guessr.netlify.app/multiplayer/<房间号>`
   - macOS / Linux：`bash scripts/launch-guessr-chrome.sh https://anime-character-guessr.netlify.app/multiplayer/<房间号>`

   脚本用一个单独的 Chrome 用户目录（Chrome 136 起不允许在默认用户目录开调试端口），所以第一次打开的是全新的 Chrome，不带你平时的登录和设置。脚本找不到 Chrome 时，自己用 `--remote-debugging-port=9223 --user-data-dir=<一个新的空文件夹>` 启动 Chrome，再打开房间页。
2. 在这个 Chrome 里手动进房（输名字，创建或加入房间）。
3. 在出题器的「自动点击」页发送当前题目，或开启自动模式。顶栏布局下，「自动点击」在导航的「经典」下拉里。

调试端口不是 9223 时，改 `backend/config.json` 的 `autoclick.cdp_port`。装了经典工作台数据时，自动点击也可以用经典方案出题。原理和全部配置见 [backend/clicker/README.md](../backend/clicker/README.md)。
