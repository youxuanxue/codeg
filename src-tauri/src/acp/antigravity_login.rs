//! Native Antigravity account operations. OAuth is completed by `agy acp
//! --login` on the Codeg host; the retired Python server's redirect/token-file
//! contract does not apply to the native CLI. Existing redirect endpoints are
//! retained as explicit errors for older frontends, never aimed at the old store.
use crate::acp::error::AcpError;
use serde::Serialize;
use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginStart {
    pub already_signed_in: bool,
    pub handle: Option<String>,
    pub auth_url: Option<String>,
    pub redirect_uri: Option<String>,
    pub method_id: String,
    pub expires_in_secs: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginOutcome {
    pub signed_in: bool,
    pub message: Option<String>,
    pub retryable: bool,
    pub credential_path: Option<String>,
}
fn native_login_required() -> AcpError {
    AcpError::protocol("Native Antigravity uses the agy account store. Run `agy acp --login` in a terminal on the Codeg host (with the same --gemini-dir for a custom GEMINI_HOME), then reopen the session; or select Gemini API key in Agent Settings.")
}
pub async fn start(
    _: &BTreeMap<String, String>,
    _: &str,
) -> Result<AntigravityLoginStart, AcpError> {
    Err(native_login_required())
}
pub async fn finish(_: &str, _: &str) -> Result<AntigravityLoginOutcome, AcpError> {
    Err(native_login_required())
}
pub async fn cancel(_: &str) -> Result<(), AcpError> {
    // Native login is not started by these endpoints; an older UI's cancel
    // has no process to end and must not affect a terminal login.
    Ok(())
}

/// The command and environment are identical to a real session. Keys never
/// appear in arguments or in errors. The caller quiesces live connections.
pub async fn sign_out(runtime_env: &BTreeMap<String, String>) -> Result<(), AcpError> {
    let binary = crate::commands::acp::resolve_system_agent_binary_for(
        crate::models::agent::AgentType::Antigravity,
        "agy",
    )
    .ok_or_else(|| {
        AcpError::SdkNotInstalled(
            "Google Antigravity is not installed. Please install agy in Agent Settings.".into(),
        )
    })?;
    let mut command = crate::process::tokio_command(&binary);
    command
        .arg("acp")
        .args(crate::acp::connection::antigravity_native_args(
            runtime_env,
        )?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in crate::acp::connection::antigravity_launch_env(runtime_env, None) {
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|_| AcpError::SpawnFailed("Could not start agy for sign-out".into()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AcpError::protocol("agy stdin unavailable"))?;
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| AcpError::protocol("agy stdout unavailable"))?,
    )
    .lines();
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        send(&mut stdin, 1, "initialize", serde_json::json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"codeg","version":env!("CARGO_PKG_VERSION")}})).await?;
        let response = receive(&mut lines, 1).await?;
        if response.pointer("/result/agentCapabilities/auth/logout").is_none_or(|v| v.is_null()) {
            return Err(AcpError::protocol("Installed agy does not support logout. Update agy or run /logout in its terminal interface."));
        }
        send(&mut stdin, 2, "logout", serde_json::json!({})).await?;
        receive(&mut lines, 2).await?;
        Ok(())
    }).await.unwrap_or_else(|_| Err(AcpError::protocol("Antigravity sign-out timed out")));
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        if let Some(pid) = child.id() {
            let config = kill_tree::Config {
                signal: "SIGKILL".into(),
                ..Default::default()
            };
            if let Err(err) = kill_tree::tokio::kill_tree_with_config(pid, &config).await {
                tracing::warn!("[ACP][Antigravity] sign-out process cleanup failed: {err}");
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
    result
}
async fn send(
    stdin: &mut tokio::process::ChildStdin,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> Result<(), AcpError> {
    let frame = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    stdin
        .write_all(format!("{frame}\n").as_bytes())
        .await
        .map_err(|_| AcpError::protocol("Could not send Antigravity account request"))
}
async fn receive<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    id: i64,
) -> Result<serde_json::Value, AcpError> {
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|_| AcpError::protocol("Could not read Antigravity account response"))?
    {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if frame.get("id").and_then(|v| v.as_i64()) != Some(id) {
            continue;
        }
        if frame.get("error").is_some() {
            // The upstream message can include credentials; report only the operation.
            return Err(AcpError::protocol("Antigravity refused the account request. Complete native agy login or update the CLI."));
        }
        if frame.get("result").is_some() {
            return Ok(frame);
        }
        return Err(AcpError::protocol("Invalid Antigravity account response"));
    }
    Err(AcpError::protocol(
        "Antigravity exited before answering the account request",
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn retired_redirect_endpoints_never_start_or_contact_the_legacy_server() {
        let error = start(&BTreeMap::new(), "oauth-personal")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("agy acp --login"));
        assert!(finish("old-handle", "http://attacker.invalid/")
            .await
            .is_err());
        assert!(cancel("old-handle").await.is_ok());
    }
    #[tokio::test]
    async fn account_response_skips_notifications_and_does_not_expose_upstream_errors() {
        let input = b"noise\n{\"method\":\"notification\"}\n{\"id\":2,\"result\":{}}\n";
        assert_eq!(
            receive(&mut BufReader::new(&input[..]).lines(), 2)
                .await
                .unwrap()["result"],
            serde_json::json!({})
        );
        let input = b"{\"id\":2,\"error\":{\"message\":\"secret-key\"}}\n";
        let error = receive(&mut BufReader::new(&input[..]).lines(), 2)
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret-key"));
        assert!(error.contains("refused"));
    }
}
