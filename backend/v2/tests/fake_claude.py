# -*- coding: utf-8 -*-
"""假的 `claude -p --input-format stream-json --output-format stream-json`，给预热池的测试用（不调真 AI）。

行为由 --system-prompt-file 里的文字决定（WarmProc 会把系统提示词写进这个文件）：
- 默认：等 stdin 的一行用户消息 → 输出 system/init、几段 text_delta、assistant、result → 等 stdin 关掉再退出（和真 claude 一样）
- MODE=die：一启动就退出（退出码 3）
- MODE=die_after_read：读到用户消息后什么都不输出就退出（退出码 4）
- MODE=stall：读到用户消息后一直不输出
- MODE=slow：每段文字之间停 0.3 秒（测取消）
- MODE=grandchild：先开一个孙子进程（sleep 60），把它的 pid 写到 stderr「GRANDCHILD <pid>」
- MODE=thinking：先输出几段 thinking_delta 再写文字
- MODE=slowread：启动后先等 2 秒才开始读 stdin（测：消息比管道缓冲大时，写 stdin 不会卡住取消 / 超时）
- MODE=think_then_die：读到消息、输出一段 thinking 之后退出（退出码 5）
"""
import json
import subprocess
import sys
import time


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    system = ""
    if "--system-prompt-file" in argv:
        with open(argv[argv.index("--system-prompt-file") + 1], encoding="utf-8") as f:
            system = f.read()
    mode = "normal"
    for m in ("die_after_read", "die", "stall", "slowread", "slow", "grandchild", "think_then_die", "thinking"):
        if f"MODE={m}" in system:
            mode = m
            break
    if mode == "die":
        sys.exit(3)
    if mode == "grandchild":
        g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        sys.stderr.write(f"GRANDCHILD {g.pid}\n")
        sys.stderr.flush()
    if mode == "slowread":
        time.sleep(2)
    line = sys.stdin.readline()
    if not line:
        return
    msg = json.loads(line)
    content = msg["message"]["content"]
    if mode == "die_after_read":
        sys.exit(4)
    if mode == "think_then_die":
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "thinking_delta", "thinking": "嗯"}}})
        sys.exit(5)
    if mode == "stall":
        time.sleep(120)
        return
    out({"type": "system", "subtype": "init", "model": "fake", "effort": ("--effort" in argv and argv[argv.index("--effort") + 1]) or None})
    if mode == "thinking":
        for _ in range(3):
            out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                    "delta": {"type": "thinking_delta", "thinking": "嗯"}}})
    reply = "好的：" + content[-12:]
    chunks = [reply[i:i + 4] for i in range(0, len(reply), 4)]
    for ch in chunks:
        if mode == "slow":
            time.sleep(0.3)
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                                                "delta": {"type": "text_delta", "text": ch}}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}})
    out({"type": "result", "subtype": "success", "is_error": False, "result": reply,
         "usage": {"output_tokens": len(chunks)}, "duration_api_ms": 5})
    # 和真 claude 一样：答完不退出，等 stdin 关掉
    while sys.stdin.readline():
        pass


if __name__ == "__main__":
    main()
