//! Launch-scoped compatibility for Gemini's native temporary-artifact reads
//! and for unsupported-model fallback loops.
//!
//! Gemini validates `read_file` before ACP fs calls and BeforeTool hooks. A
//! Node loader wraps that validator in memory, stages rejected OS-temp files
//! into Storage's own project temp directory, then runs the original validator.
//! The same loader bounds `retryWithBackoff`: a ModelNotFound / 404 may switch
//! models once, and the next unsupported-model failure is thrown instead of
//! resetting the attempt counter with no delay. Quota and 5xx retries stay.
//! No workspace permission, installed CLI file or global setting is changed.

use std::path::Path;

use sha2::{Digest, Sha256};

const SOURCES: [(&str, &str); 4] = [
    ("register.mjs", include_str!("gemini_compat/register.mjs")),
    ("loader.mjs", include_str!("gemini_compat/loader.mjs")),
    ("artifacts.mjs", include_str!("gemini_compat/artifacts.mjs")),
    ("retry.mjs", include_str!("gemini_compat/retry.mjs")),
];

pub const TEMP_CONTRACT: &str =
    "Use the Gemini project temporary directory shown in session_context for generated images, \
PDF renders and other intermediate artifacts. The same directory is published as \
CODEG_GEMINI_PROJECT_TEMP in the Gemini process environment. Use an absolute output path \
there instead of hard-coding /tmp or /private/tmp. Codeg stages existing regular files \
from OS temp directories into that project temp directory before native read_file \
validation; a staged path is a copy, so edits to it do not update the original.";

/// The loader runs in every Node child but changes only modules owned by the
/// official Gemini packages. `--import` works on Gemini's Node >=20 baseline
/// (module.register was added in 20.6), unlike synchronous registerHooks.
/// Immutable content-addressed files avoid races between concurrent launches.
pub fn prepare_launch(
    env: &mut Vec<(String, String)>,
    scratch: Option<&Path>,
) -> std::io::Result<()> {
    let fallback = crate::paths::codeg_home_dir()
        .join("runtime")
        .join("gemini");
    prepare_launch_in(env, scratch.unwrap_or(&fallback))
}

fn prepare_launch_in(env: &mut Vec<(String, String)>, root: &Path) -> std::io::Result<()> {
    let mut hash = Sha256::new();
    for (name, source) in SOURCES {
        hash.update(name.as_bytes());
        hash.update(source.as_bytes());
    }
    let directory = root.join(format!("gemini-compat-{:x}", hash.finalize()));
    crate::acp::scratch_dir::create_root(&directory)?;
    for (name, source) in SOURCES {
        let path = directory.join(name);
        // Atomic replacement so two connections cannot load a partially
        // written module, including when temp isolation was disabled.
        if std::fs::read(&path).ok().as_deref() != Some(source.as_bytes()) {
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
            std::io::Write::write_all(&mut temporary, source.as_bytes())?;
            temporary.persist(&path).map_err(|error| error.error)?;
        }
    }
    let register = std::fs::canonicalize(directory.join("register.mjs"))?;
    let url = url::Url::from_file_path(register).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid Gemini compatibility module path",
        )
    })?;
    let matches = |key: &str| {
        if cfg!(windows) {
            key.eq_ignore_ascii_case("NODE_OPTIONS")
        } else {
            key == "NODE_OPTIONS"
        }
    };
    let inherited = env
        .iter()
        .rev()
        .find(|(key, _)| matches(key))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("NODE_OPTIONS").ok())
        .unwrap_or_default();
    env.retain(|(key, _)| !matches(key));
    env.push((
        "NODE_OPTIONS".to_string(),
        format!("{inherited} --import={url}").trim().to_string(),
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn launch_preserves_options_and_handles_paths_with_spaces() {
        let root = tempfile::tempdir().unwrap();
        let mut env = vec![("NODE_OPTIONS".into(), "--stack-trace-limit=42".into())];
        prepare_launch_in(&mut env, &root.path().join("a space ' quote")).unwrap();
        let options = &env.iter().find(|(key, _)| key == "NODE_OPTIONS").unwrap().1;
        assert!(options.starts_with("--stack-trace-limit=42 --import=file:"));
        let output = Command::new("node")
            .envs(env)
            .args(["--input-type=module", "-e", "console.log('loaded')"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "loaded");
    }

    #[test]
    fn native_artifact_regressions() {
        let compat = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/acp/gemini_compat");
        let output = Command::new("node")
            .arg("--test")
            .arg(compat.join("artifacts.test.mjs"))
            .arg(compat.join("retry-fallback.test.mjs"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
