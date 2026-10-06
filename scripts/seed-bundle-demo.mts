/**
 * 给演示环境准备一个真的能装完的装机套装：
 * 写两个安装包 → 用正确 sha256 上架两个应用 → 发布套装（含一个不存在的 id，验证整包统计）。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const api = process.env.APPCENTER_API ?? "http://127.0.0.1:7991";
const token = "admin";

async function post(pathname: string, payload: unknown): Promise<unknown> {
  const response = await fetch(api + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(pathname + " -> " + String(response.status) + " " + text);
  return JSON.parse(text || "{}");
}

await mkdir("smoke-packages", { recursive: true });
const specs = [
  { id: "kit-player", name: "影音播放器", file: "kit-player.exe" },
  { id: "kit-im", name: "即时通讯", file: "kit-im.exe" },
];

for (const spec of specs) {
  const payload = Buffer.from("installer-payload-" + spec.id);
  await writeFile("smoke-packages/" + spec.file, payload);
  await post("/api/admin/apps", {
    detail: {
      id: spec.id,
      name: spec.name,
      searchKeys: [spec.id, spec.name],
      publisher: "演示",
      categoryId: "entertainment",
      iconUrl: "",
      latestVersion: "1.0.0",
      downloadCount: 10,
      badge: "normal",
      tags: ["套装"],
      requiresApproval: false,
      sizeBytes: payload.length,
      description: "用于验证捆绑安装的演示应用",
      screenshots: [],
      versions: [],
    },
    versions: [
      {
        version: "1.0.0",
        releasedAt: "2026-10-01",
        sizeBytes: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
        downloadUrl: api + "/dl/" + spec.file,
        releaseNotes: "首个版本",
        silent: { kind: "nsis", installArgs: ["/S", "/D={target}"], uninstallArgs: ["/S"], requiresAdmin: false },
      },
    ],
  });
  console.log("published app " + spec.id);
}

const bundle = await post("/api/admin/bundles", {
  id: "media-kit",
  title: "影音办公套装",
  subtitle: "播放器 + 即时通讯，一次装齐",
  appIds: ["kit-player", "kit-im", "kit-gone"],
  sortOrder: 1,
});
console.log("published bundle " + JSON.stringify(bundle));
