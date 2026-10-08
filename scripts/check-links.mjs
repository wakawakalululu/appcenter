// 公开文档里的本地引用必须能在「发布出来的树」里落地。
// 治的是这一类：链接指向被 gitignore 的文件、或指向一个从来没存在过的文件 —— 本机预览一切正常，
// 推上去就是死链（#54 那批悬空引用之后又复发过一次，所以从人工审计升级成门禁）。
//
// 两条作用域规则（不是随手加的，各自对应一个真实发布面）：
//  · 仓库文档（*.md / docs/**）：相对路径按所在目录解析，目标必须在可发布集合里。
//  · 应用自己的 UI（packages/app/web/**）：`/x` 是相对 web 根由本地服务提供的，按 web 根解析。
//    其中 ROUTE_SERVED 里的路径由 bridge.ts 的显式路由生成（不是磁盘文件），列进来而不是整类放行。
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROUTE_SERVED = ["/favicon.svg"]; // bridge.ts:153 用 faviconSvg() 现场生成

const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: top,
  encoding: "utf8",
});
const files = listed.split("\0").filter(Boolean);
const publishable = new Set(files);

const REF = /(?:src|href)\s*=\s*["']([^"']+)["']|\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;|\s+"[^"]*")?\s*\)/g;
const docs = files.filter((f) => /\.(md|html)$/.test(f) && !/^wiki\//.test(f));
// wiki 是**另一个仓库**（推送到 <repo>.wiki.git），所以它的链接不能按本仓库文件树判，
// 但也不能整类放行：页名对不上、或引用了本仓库图片（wiki 里没有这个附件）都是上线即 404。
const wikiPages = new Set(
  files
    .filter((f) => f.startsWith("wiki/") && f.endsWith(".md"))
    .map((f) => path.basename(f).replace(/\.md$/, "")),
);
const wikiDocs = files.filter((f) => f.startsWith("wiki/") && f.endsWith(".md"));
const WIKI_PROBLEMS = [];
let wikiChecked = 0;
for (const doc of wikiDocs) {
  for (const m of readFileSync(path.join(top, doc), "utf8").matchAll(REF)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw || /^(https?:|mailto:|data:|#)/i.test(raw)) continue;
    const clean = raw.split("#")[0].split("?")[0];
    if (!clean) continue;
    wikiChecked++;
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(clean)) {
      WIKI_PROBLEMS.push("wiki 是独立仓库，引用本仓库的附件会 404：" + doc + "  ->  " + raw);
      continue;
    }
    const page = path.basename(clean).replace(/\.md$/, "");
    if (!wikiPages.has(page)) {
      WIKI_PROBLEMS.push("wiki 页内链指向不存在的页面：" + doc + "  ->  " + raw);
    }
  }
}

const problems = [];
let checked = 0;
for (const doc of docs) {
  const text = readFileSync(path.join(top, doc), "utf8");
  const webRoot = doc.startsWith("packages/app/web/") ? "packages/app/web" : null;
  for (const m of text.matchAll(REF)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw || /^(https?:|mailto:|data:|#)/i.test(raw)) continue;
    const clean = raw.split("#")[0].split("?")[0];
    if (!clean) continue;
    let target;
    if (clean.startsWith("/")) {
      if (webRoot === null) {
        // 站点文档里写根绝对路径，等于赌"站点根就是仓库根"；本项目 docs 部署成站点根，
        // 这种引用推上去必然 404，所以直接算问题而不是放行。
        problems.push("站点文档用了根绝对路径（Pages 站点根＝docs，推上去会 404）：" + doc + "  ->  " + raw);
        checked++;
        continue;
      }
      if (ROUTE_SERVED.includes(clean)) continue;
      target = path.join(webRoot, clean).split(path.sep).join("/");
    } else {
      target = path.normalize(path.join(path.dirname(doc), clean)).split(path.sep).join("/");
    }
    checked++;
    if (publishable.has(target)) continue;
    const onDisk = existsSync(path.join(top, target));
    problems.push(
      (onDisk ? "目标只在本机存在、不在可发布集合（被 ignore 或未 add）⇒ 上线即 404：" : "目标根本不存在：") +
        doc +
        "  ->  " +
        raw,
    );
  }
}

const all = problems.concat(WIKI_PROBLEMS);
console.log(
  "文档引用检查：" + docs.length + " 个仓库文档、" + String(checked) + " 条本地引用；" +
    wikiDocs.length + " 个 wiki 页、" + String(wikiChecked) + " 条页内链接（按 wiki 页名判）",
);
if (all.length > 0) {
  console.error("发现 " + all.length + " 条落不了地的引用：\n" + all.join("\n"));
  process.exit(1);
}
console.log("全部本地引用都能在各自发布出来的面上落地。");
