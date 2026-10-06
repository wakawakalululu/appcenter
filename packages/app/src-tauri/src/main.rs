// Tauri 只做壳：真正的界面与业务由 Node 引擎的本地桥提供（packages/app/src/bridge.ts）。
// 这里以 sidecar 方式拉起引擎，再把 Webview 指到它的回环地址。
//
// 注意：本仓库未包含编译产物，构建需要 Rust 工具链：
//   cd packages/app && npm run tauri build

use std::process::Command;

fn engine_url() -> String {
    std::env::var("APPCENTER_UI_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string())
}

fn spawn_engine() {
    let Ok(engine) = std::env::var("APPCENTER_ENGINE") else {
        return;
    };
    let data = std::env::var("APPCENTER_DATA").unwrap_or_default();
    let mut cmd = Command::new(engine);
    cmd.arg("--experimental-transform-types");
    cmd.arg("packages/app/src/main.ts");
    cmd.env("UI_PORT", "8080");
    if !data.is_empty() {
        cmd.env("APPCENTER_DATA", data);
    }
    let _ = cmd.spawn();
}

fn main() {
    spawn_engine();
    tauri::Builder::default()
        .setup(|_app| {
            // 引擎冷启动需要一点时间，先让窗口打开，页面自身会重试连接。
            std::thread::sleep(std::time::Duration::from_millis(500));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[allow(dead_code)]
fn url_for_window() -> tauri::Url {
    tauri::Url::parse(&engine_url()).expect("APPCENTER_UI_URL must be a valid http url")
}
