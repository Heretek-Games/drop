use serde_with::SerializeDisplay;
use std::fmt::Display;

#[derive(Debug, SerializeDisplay, Clone, PartialEq, Eq)]
pub enum BackupError {
    InvalidSystem,
    NotFound,
    ParseError,
    ToolNotFound(String),
    ExecutionError(String),
    SerializationError(String),
    ChecksumMismatch { expected: String, actual: String },
    IoError(String),
}

impl Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::InvalidSystem => {
                write!(f, "Attempted to generate path for invalid system")
            }
            BackupError::NotFound => write!(f, "Could not generate or find path"),
            BackupError::ParseError => write!(f, "Failed to parse path"),
            BackupError::ToolNotFound(msg) => write!(f, "Tool not found: {}", msg),
            BackupError::ExecutionError(msg) => write!(f, "Execution error: {}", msg),
            BackupError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
            BackupError::ChecksumMismatch { expected, actual } => {
                write!(
                    f,
                    "Checksum mismatch: expected {}, got {}",
                    expected, actual
                )
            }
            BackupError::IoError(msg) => write!(f, "IO error: {}", msg),
        }
    }
}

impl From<std::io::Error> for BackupError {
    fn from(err: std::io::Error) -> Self {
        BackupError::IoError(err.to_string())
    }
}

impl From<serde_json::Error> for BackupError {
    fn from(err: serde_json::Error) -> Self {
        BackupError::SerializationError(err.to_string())
    }
}
