#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
};
use tauri::{Emitter, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseRequest {
    url: String,
    exam_id: String,
    lang: String,
    model: String,
    profile: String,
    level: String,
    answers: String,
    cookies: String,
    server: String,
    builder_root: String,
    work_dir: String,
    overwrite: bool,
    python: String,
}

/// 已解析听力的本地记录（SQLite 一行）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterialRecord {
    exam_id: String,
    title: Option<String>,
    lang: String,
    level: Option<String>,
    source_url: Option<String>,
    status: String,
    stage: Option<String>,
    stage_message: Option<String>,
    server_job_id: Option<String>,
    zip_path: Option<String>,
    question_count: Option<i64>,
    file_count: Option<i64>,
    size_bytes: Option<i64>,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS listening_materials (
    exam_id        TEXT PRIMARY KEY,
    title          TEXT,
    lang           TEXT NOT NULL DEFAULT '',
    level          TEXT,
    source_url     TEXT,
    status         TEXT NOT NULL,
    stage          TEXT,
    stage_message  TEXT,
    server_job_id  TEXT,
    zip_path       TEXT,
    question_count INTEGER,
    file_count     INTEGER,
    size_bytes     INTEGER,
    error          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
"#;

/// 打开应用数据目录下的 SQLite；每次调用独立连接，避免跨线程共享锁。
fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法定位应用数据目录：{err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建应用数据目录失败：{err}"))?;
    let conn = Connection::open(dir.join("materials.sqlite3"))
        .map_err(|err| format!("打开本地数据库失败：{err}"))?;
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");
    conn.execute_batch(SCHEMA)
        .map_err(|err| format!("初始化本地数据库失败：{err}"))?;
    Ok(conn)
}

/// 提交解析时写入/重置记录；同一 exam_id 重新解析会覆盖旧状态。
fn record_start(app: &tauri::AppHandle, req: &ParseRequest) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO listening_materials
             (exam_id, lang, level, source_url, status, stage, stage_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'parsing', 'start', '已提交解析',
                 datetime('now','localtime'), datetime('now','localtime'))
         ON CONFLICT(exam_id) DO UPDATE SET
             lang = excluded.lang,
             level = excluded.level,
             source_url = excluded.source_url,
             status = 'parsing',
             stage = 'start',
             stage_message = '已提交解析',
             error = NULL,
             updated_at = datetime('now','localtime')",
        params![&req.exam_id, &req.lang, &req.level, &req.url],
    )
    .map_err(|err| format!("写入本地任务记录失败：{err}"))?;
    Ok(())
}

/// builder 的 STAGE 标记（downloading / parsing / packaging / uploading …）。
fn record_stage(app: &tauri::AppHandle, exam_id: &str, stage: &str, message: &str) {
    if let Ok(conn) = open_db(app) {
        let _ = conn.execute(
            "UPDATE listening_materials
                SET status = 'parsing', stage = ?2, stage_message = ?3,
                    updated_at = datetime('now','localtime')
              WHERE exam_id = ?1",
            params![exam_id, stage, message],
        );
    }
}

fn record_success(app: &tauri::AppHandle, exam_id: &str, payload: &Value) {
    let empty = Value::Null;
    let response = payload.get("response").unwrap_or(&empty);
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_i64);

    let job_id = text(response, "job_id");
    let files = number(response, "files");
    let bytes = number(response, "bytes");
    let zip_path = text(payload, "zip_path");
    let title = text(payload, "title");
    let question_count = number(payload, "question_count");

    if let Ok(conn) = open_db(app) {
        let _ = conn.execute(
            "UPDATE listening_materials SET
                 status = 'uploaded',
                 stage = 'done',
                 stage_message = '已上传',
                 server_job_id = COALESCE(?2, server_job_id),
                 zip_path = COALESCE(?3, zip_path),
                 title = COALESCE(?4, title),
                 question_count = COALESCE(?5, question_count),
                 file_count = COALESCE(?6, file_count),
                 size_bytes = COALESCE(?7, size_bytes),
                 error = NULL,
                 updated_at = datetime('now','localtime')
             WHERE exam_id = ?1",
            params![exam_id, job_id, zip_path, title, question_count, files, bytes],
        );
    }
}

fn record_failure(app: &tauri::AppHandle, exam_id: &str, error: &str) {
    if let Ok(conn) = open_db(app) {
        let _ = conn.execute(
            "UPDATE listening_materials SET
                 status = 'failed',
                 stage = 'failed',
                 stage_message = ?2,
                 error = ?2,
                 updated_at = datetime('now','localtime')
             WHERE exam_id = ?1",
            params![exam_id, error],
        );
    }
}

/// 列表页数据源：本机 SQLite 中已解析过的听力。
#[tauri::command]
fn list_materials(app: tauri::AppHandle) -> Result<Vec<MaterialRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT exam_id, title, lang, level, source_url, status, stage, stage_message,
                    server_job_id, zip_path, question_count, file_count, size_bytes, error,
                    created_at, updated_at
               FROM listening_materials
              ORDER BY updated_at DESC, exam_id ASC",
        )
        .map_err(|err| format!("查询本地记录失败：{err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MaterialRecord {
                exam_id: row.get(0)?,
                title: row.get(1)?,
                lang: row.get(2)?,
                level: row.get(3)?,
                source_url: row.get(4)?,
                status: row.get(5)?,
                stage: row.get(6)?,
                stage_message: row.get(7)?,
                server_job_id: row.get(8)?,
                zip_path: row.get(9)?,
                question_count: row.get(10)?,
                file_count: row.get(11)?,
                size_bytes: row.get(12)?,
                error: row.get(13)?,
                created_at: row.get(14)?,
                updated_at: row.get(15)?,
            })
        })
        .map_err(|err| format!("查询本地记录失败：{err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取本地记录失败：{err}"))
}

/// 开发环境默认 builder 路径：<workspace>/language_learner_backend/builder
#[tauri::command]
fn default_builder_root() -> String {
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("language_learner_backend")
        .join("builder");
    candidate
        .canonicalize()
        .unwrap_or(candidate)
        .to_string_lossy()
        .to_string()
}

fn sidecar_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("LL_DESKTOP_SIDECAR") {
        return PathBuf::from(path);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("sidecar").join("parse_and_upload.py");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("parse_and_upload.py")
}

/// 解析产物 zip 的落盘目录：系统下载目录（macOS 为 ~/Downloads）。
fn downloads_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().download_dir() {
        return dir;
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join("Downloads"))
        .unwrap_or_else(|_| std::env::temp_dir())
}

#[tauri::command]
fn start_parse(app: tauri::AppHandle, req: ParseRequest) -> Result<(), String> {
    if req.url.trim().is_empty() {
        return Err("请填写视频/音频地址".into());
    }
    if req.exam_id.trim().is_empty() {
        return Err("请填写 exam_id".into());
    }
    let sidecar = sidecar_path(&app);
    if !sidecar.is_file() {
        return Err(format!("sidecar 不存在：{}", sidecar.display()));
    }

    // 先落一条本地记录，列表页立刻能看到“解析中”。
    record_start(&app, &req)?;

    let download_dir = downloads_dir(&app);
    let _ = std::fs::create_dir_all(&download_dir);

    let exam_id = req.exam_id.clone();
    thread::spawn(move || {
        let python = if req.python.trim().is_empty() {
            "python3".to_string()
        } else {
            req.python.trim().to_string()
        };

        let mut command = Command::new(&python);
        command
            .arg(&sidecar)
            .arg("--url")
            .arg(&req.url)
            .arg("--exam-id")
            .arg(&req.exam_id)
            .arg("--lang")
            .arg(&req.lang)
            .arg("--model")
            .arg(&req.model)
            .arg("--profile")
            .arg(&req.profile)
            .arg("--level")
            .arg(&req.level)
            .arg("--server")
            .arg(&req.server)
            .arg("--builder-root")
            .arg(&req.builder_root)
            .arg("--python")
            .arg(&python)
            .arg("--download-dir")
            .arg(&download_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !req.answers.trim().is_empty() {
            command.arg("--answers").arg(req.answers.trim());
        }
        if !req.cookies.trim().is_empty() {
            command.arg("--cookies").arg(req.cookies.trim());
        }
        if !req.work_dir.trim().is_empty() {
            command.arg("--work-dir").arg(req.work_dir.trim());
        }
        if req.overwrite {
            command.arg("--overwrite");
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let message = format!("启动 Python 失败：{err}");
                record_failure(&app, &exam_id, &message);
                let _ = app.emit(
                    "parse-done",
                    serde_json::json!({ "code": -1, "error": message }),
                );
                return;
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let stderr_app = app.clone();
        let stderr_thread = thread::spawn(move || {
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = stderr_app.emit("parse-log", line);
                }
            }
        });

        let mut result_seen = false;
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // builder/侧车用 `STAGE {json}` 推送阶段，等价于服务端 SSE 的进度事件。
                if let Some(raw) = line.strip_prefix("STAGE ") {
                    if let Ok(value) = serde_json::from_str::<Value>(raw) {
                        let stage = value
                            .get("stage")
                            .and_then(Value::as_str)
                            .unwrap_or("parsing");
                        let message = value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        record_stage(&app, &exam_id, stage, message);
                        let _ = app.emit("parse-stage", value);
                    }
                } else if let Some(raw) = line.strip_prefix("RESULT ") {
                    if let Ok(value) = serde_json::from_str::<Value>(raw) {
                        result_seen = true;
                        let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        if ok {
                            record_success(&app, &exam_id, &value);
                        } else {
                            let message = value
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("上传失败");
                            record_failure(&app, &exam_id, message);
                        }
                    }
                }
                let _ = app.emit("parse-log", line);
            }
        }
        let _ = stderr_thread.join();

        let status = child.wait();
        let code = status
            .as_ref()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        if !result_seen {
            let message = if code != 0 {
                format!("解析进程退出码 {code}")
            } else {
                "解析结束但没有返回上传结果".to_string()
            };
            record_failure(&app, &exam_id, &message);
        }
        match status {
            Ok(_) => {
                let _ = app.emit(
                    "parse-done",
                    serde_json::json!({ "code": code }),
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "parse-done",
                    serde_json::json!({ "code": -1, "error": err.to_string() }),
                );
            }
        }
    });

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_parse,
            default_builder_root,
            list_materials
        ])
        .run(tauri::generate_context!())
        .expect("error while running language learner desktop");
}
