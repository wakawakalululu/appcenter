/**
 * 公开面禁用标识的唯一定义处。
 *
 * 两条判据共用这一把尺子：
 * - ci.yml 里那步扫的是**文件内容**（git grep ... HEAD），它的 shell 字面量与本表由
 *   commit-msg-gate.test.ts 的一条用例钉成等价（本表当正则去跑同一批阳性/阴性样本）。
 * - scripts/check-commit-msg.mjs 扫的是**提交信息**——提交信息不是文件，文件级门禁结构上查不到它。
 *
 * 中文词一律字面量（逐字节相等，任何正则/grep 引擎都不串味；实测过某些 git 构建的 -E 会把字符类按字节处理）。
 * ASCII 保留字符类写法（pc[a]s 这类）：正则照样命中真实内容，但**本文件自身不含这些词**，否则门禁会匹配到自己。
 */
const ASCII_PIECES = ["pc", "[a]s", "|clean[- ]?room", "|reference[ ]product", "|decomp", "[i]l",
  "|reverse[- ]?engineer", "|Venus", "[Gg]roup"];
export const ASCII = ASCII_PIECES.join("");

// 用「字符 + 字符」拼接写出来，避免本文件被自己的正则命中（这些词在文档里是禁止出现的）。
export const CJK_WORDS = ["逆" + "向", "反" + "编译", "复" + "刻", "参考" + "件"];
export const CJK = CJK_WORDS.join("|");

export const PATTERNS = [
  ["ASCII 标识", new RegExp(ASCII, "i")],
  ["中文词", new RegExp(CJK)],
];

/** 返回第一个命中的 [标签, 命中片段]；没有命中返回 null。 */
export function firstHit(text) {
  for (const [label, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) return [label, m[0]];
  }
  return null;
}
