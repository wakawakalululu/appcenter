"""给所有 .ps1 补 UTF-8 BOM：PowerShell 5.1 读无 BOM 文件时按本地 ANSI(CP936) 解码，
中文注释的尾字节会吞掉后面的 ASCII 字符，把代码解析坏。"""
import glob
import os

targets = glob.glob("packages/**/*.ps1", recursive=True) + glob.glob("scripts/*.ps1")
changed = []
for path in targets:
    with open(path, "rb") as handle:
        data = handle.read()
    if data.startswith(b"\xef\xbb\xbf"):
        continue
    with open(path, "wb") as handle:
        handle.write(b"\xef\xbb\xbf" + data)
    changed.append(path)

print("bom added:", len(changed))
for path in changed:
    print("  " + path)
